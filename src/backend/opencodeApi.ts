/**
 * Official OpenCode 2.2.5 REST/SSE adapter (backend-internal).
 *
 * Everything goes through the user's one shared background service, exactly
 * like the installed CLI/TUI clients (inventory probe §3, live probe §0):
 * the discovery file `~/.local/state/opencode/service.json` carries
 * {id, version, url, pid, password}; every request authenticates with HTTP
 * Basic `opencode:<password>`. The password lives only in memory inside this
 * class — it is never logged, serialized, persisted or shipped with a result.
 *
 * Per the supervisor integration decision (contract 2026-11-02): an absent or
 * stale service must not make the sidebar silently empty, and starting the
 * official local service (`<engine> service start`) to provide the functioning
 * UI is part of this task. An existing live service is reused untouched; we
 * never call `service stop` against a shared user service from here (only
 * test code stops services it started itself, via its own CLI call).
 *
 * Only probe-verified endpoints are used (work/opencode-probe, §4):
 *   GET    /api/session?limit&cursor&order&parentID&archived&directory...
 *   GET    /api/session/{id}            PATCH /api/session/{id} {archived|title}
 *   GET    /api/session/{id}/message?limit&cursor&order
 *   GET    /api/session/active
 *   GET    /api/experimental/session/{id}/export
 *   POST   /api/experimental/session/import {info, messages, location}
 *   DELETE /api/session/{id}            (cascades to the child subtree)
 *   GET    /api/event                   (SSE; process-local scope, live probe)
 * HTTP status codes are authoritative — never a CLI exit code.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serviceFile } from "./paths";

/** Paged API envelope: `{data, cursor}` (some endpoints return the bare object). */
export interface Paged<T> {
  data: T[];
  cursor?: { previous?: string | null; next?: string | null };
}

/** The subset of Session.Info the backend relies on (probed shapes). */
export interface SessionInfo {
  id: string;
  title?: string | null;
  parentID?: string | null;
  projectID?: string;
  time?: { created?: number; updated?: number; archived?: number | null; busy?: number | null; idle?: number | null };
  location?: { directory?: string };
}

/** Export envelope from `GET /api/experimental/session/{id}/export`. */
export interface SessionExport {
  info: SessionInfo;
  messages: unknown[];
}

/** One SSE event off `/api/event` (parsed; heartbeat comments dropped). */
export interface ServiceEvent {
  id?: string;
  type: string;
  created?: number;
  data?: { sessionID?: string };
}

export interface ServiceHandle {
  url: string;
  password: string;
}

interface ServiceFileShape {
  url?: unknown;
  password?: unknown;
  pid?: unknown;
  version?: unknown;
}

const REQUEST_TIMEOUT_MS = 30000;
const SERVICE_START_TIMEOUT_MS = 45000;

export class OpenCodeApiError extends Error {
  constructor(message: string, readonly status?: number, readonly url?: string) {
    super(message);
    this.name = "OpenCodeApiError";
  }
}

async function readServiceFile(path: string): Promise<ServiceHandle | null> {
  let value: ServiceFileShape;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as ServiceFileShape;
  } catch {
    return null;
  }
  if (typeof value.url === "string" && typeof value.password === "string" && /^https?:\/\//i.test(value.url)) {
    return { url: value.url.replace(/\/+$/, ""), password: value.password };
  }
  return null;
}

/** Low-level HTTP call with Basic auth; non-2xx raises with the server's message. */
export async function serviceCall<T>(
  service: ServiceHandle,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
): Promise<{ status: number; value: T | null; text: string }> {
  const url = new URL(service.url + path);
  if (query !== undefined) for (const [key, value2] of Object.entries(query)) url.searchParams.set(key, value2);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: "Basic " + Buffer.from("opencode:" + service.password).toString("base64"),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OpenCodeApiError(`无法连接 OpenCode 后台服务（${method} ${path}）：${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let value: T | null = null;
  if (text !== "") {
    try {
      value = JSON.parse(text) as T;
    } catch {
      value = null;
    }
  }
  if (!response.ok) {
    const detail = extractError(value) ?? text.slice(0, 200);
    throw new OpenCodeApiError(`OpenCode 服务请求失败（HTTP ${response.status}，${method} ${path}）：${detail}`, response.status, path);
  }
  return { status: response.status, value, text };
}

function extractError(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "detail"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return null;
}

/** Unwrap `{data:...}` envelopes some endpoints wrap and others do not (probe evidence). */
export function unwrapData<T>(value: unknown): T {
  if (value !== null && typeof value === "object" && "data" in value && !Array.isArray(value)) {
    return (value as { data: T }).data;
  }
  return value as T;
}

export class OpenCodeServiceConnection {
  private handle: ServiceHandle | null = null;
  private started = false;
  private starting: Promise<ServiceHandle> | null = null;
  /** Set when this connection itself launched the service (reported honestly). */
  public readonly startedByExtension = (): boolean => this.started;

  /**
   * Cold-start fix: the engine callback may resolve lazily and asynchronously
   * (real discovery over persisted choice / npm global / PATH when no explicit
   * enginePath is configured), so a Promise result is allowed and awaited
   * before any `service start` is attempted.
   */
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly enginePath: () => string | null | Promise<string | null>,
  ) {}

  /** Current service handle, connecting (and if allowed, starting) on demand. */
  connect(): Promise<ServiceHandle> {
    // One restarter at a time: a live-channel reconnect racing a user refresh
    // must never spawn two `service start` processes for the same data root.
    if (this.starting !== null) return this.starting;
    const attempt = this.connectOnce();
    this.starting = attempt;
    attempt.catch(() => undefined).finally(() => { if (this.starting === attempt) this.starting = null; });
    return attempt;
  }

  private async connectOnce(): Promise<ServiceHandle> {
    if (this.handle !== null) {
      if (await this.ping(this.handle)) return this.handle;
      this.handle = null; // stale discovery file: url no longer answers
    }
    const existing = await readServiceFile(serviceFile(this.env));
    if (existing !== null && (await this.ping(existing))) {
      this.handle = existing;
      return existing;
    }
    return this.startServiceAndConnect();
  }

  private async ping(service: ServiceHandle): Promise<boolean> {
    try {
      const { value } = await serviceCall<unknown>(service, "GET", "/api/info");
      const info = unwrapData<{ version?: unknown; pid?: unknown } | null>(value);
      return typeof (info ?? {}) === "object" && info !== null;
    } catch {
      return false;
    }
  }

  private async startServiceAndConnect(): Promise<ServiceHandle> {
    const engine = await this.enginePath();
    if (engine === null) {
      throw new OpenCodeApiError("没有可用的 OpenCode 后台服务，且找不到本机 OpenCode 原生引擎来自行启动。请在设置中选择引擎路径。");
    }
    const exit = await new Promise<{ code: number | null; stderr: string }>(resolve => {
      const child = spawn(engine, ["service", "start"], {
        env: this.env,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr?.on("data", chunk => { stderr += String(chunk); });
      child.on("error", error => resolve({ code: -1, stderr: error.message }));
      child.on("close", code => resolve({ code, stderr }));
    });
    if (exit.code !== 0) {
      throw new OpenCodeApiError(`启动 OpenCode 后台服务失败（退出码 ${exit.code ?? "未知"}）${exit.stderr ? "：" + exit.stderr.slice(0, 300) : ""}`);
    }
    const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;
    let delay = 250;
    while (Date.now() < deadline) {
      const handle = await readServiceFile(serviceFile(this.env));
      if (handle !== null && (await this.ping(handle))) {
        this.handle = handle;
        this.started = true;
        return handle;
      }
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(2000, delay * 2);
    }
    throw new OpenCodeApiError("OpenCode 后台服务已在启动，但未在预期时间内就绪。请稍后刷新。");
  }

  async call<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<{ status: number; value: T | null; text: string }> {
    const service = await this.connect();
    return serviceCall<T>(service, method, path, body, query);
  }

  currentUrl(): string | null {
    return this.handle?.url ?? null;
  }
}

/**
 * Page through a list endpoint until the opaque cursor chain ends.
 *
 * Paging anomalies are never silently truncated into a "successful" partial
 * list: a cursor that repeats (a server-side paging loop) raises explicitly.
 * There is no arbitrary row-count limit. The only honest
 * terminations are a missing/empty next cursor or an empty page.
 */
export async function pageAll<T>(
  call: (query: Record<string, string>) => Promise<{ value: unknown }>,
  limit: number,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (;;) {
    const query: Record<string, string> = { limit: String(limit) };
    if (cursor !== undefined) query.cursor = cursor;
    const { value } = await call(query);
    const page = value as Paged<T> | null;
    if (page === null || typeof page !== "object" || !Array.isArray(page.data)) {
      throw new OpenCodeApiError("服务返回的列表格式不符合预期（缺少 data 数组）。");
    }
    rows.push(...page.data);
    const next = page.cursor?.next;
    if (typeof next !== "string" || next === "") break;
    if (seenCursors.has(next)) {
      throw new OpenCodeApiError(`分页游标出现重复（${next.slice(0, 48)}），疑似服务端分页异常；已中止而不是返回不完整结果。`);
    }
    seenCursors.add(next);
    cursor = next;
  }
  return rows;
}

/**
 * Subscribe to `/api/event`. The stream is process-local (live probe): it
 * carries every client-path write of the shared service this sidebar is
 * attached to, and nothing from other servers. `server.connected` marks the
 * subscription established; heartbeat comments keep it alive. Events missed
 * during a disconnect are gone — recovery is a full reconcile, not a replay.
 */
export async function subscribeServiceEvents(
  service: ServiceHandle,
  types: readonly string[] | undefined,
  onEvent: (event: ServiceEvent) => void,
  onDown: (error: string) => void,
  onConnected: () => void,
): Promise<AbortController> {
  const controller = new AbortController();
  const url = new URL(service.url + "/api/event");
  if (types !== undefined && types.length > 0) {
    // Repeated query parameters — the schema rejects comma-joined values (probe3).
    url.search = types.map(type => `types=${encodeURIComponent(type)}`).join("&");
  }
  let settled = false;
  try {
    const response = await fetch(url, {
      headers: { authorization: "Basic " + Buffer.from("opencode:" + service.password).toString("base64") },
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      throw new OpenCodeApiError(`订阅 OpenCode 事件流失败（HTTP ${response.status}）。`, response.status, "/api/event");
    }
    settled = true;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    void (async (buffer: string) => {
      try {
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          buffer += decoder.decode(chunk, { stream: true });
          let index: number;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try {
                const event = JSON.parse(line.slice(5).trim()) as ServiceEvent;
                if (event.type === undefined) continue;
                if (event.type === "server.connected") onConnected();
                else onEvent(event);
              } catch {
                // A partial/keepalive frame — the next frame completes it.
              }
            }
          }
        }
        onDown("事件流已结束。");
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) onDown(error instanceof Error ? error.message : String(error));
      }
    })("");
  } catch (error) {
    if (!settled || !(error instanceof Error && error.name === "AbortError")) {
      onDown(error instanceof Error ? error.message : String(error));
    }
  }
  return controller;
}

/** Session export envelope, unwrapped from either response shape. */
export async function exportSession(connection: OpenCodeServiceConnection, sessionId: string): Promise<SessionExport> {
  const { value } = await connection.call<unknown>("GET", `/api/experimental/session/${encodeURIComponent(sessionId)}/export`);
  const envelope = unwrapData<SessionExport>(value);
  if (envelope === null || typeof envelope !== "object" || !envelope.info || !Array.isArray(envelope.messages)) {
    throw new OpenCodeApiError(`会话 ${sessionId} 的导出结果不完整（缺少 info 或 messages）。`);
  }
  return envelope;
}

/** Import with the explicit original location (supervisor decision: mandatory). */
export async function importSession(
  connection: OpenCodeServiceConnection,
  envelope: SessionExport,
): Promise<void> {
  await connection.call<unknown>("POST", "/api/experimental/session/import", {
    info: envelope.info,
    messages: envelope.messages,
    location: envelope.info.location ?? undefined,
  });
}
