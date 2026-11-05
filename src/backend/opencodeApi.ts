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
 * Resource rule (user decision 2026-11-05, static sidebar): an existing live
 * background service is reused untouched and never stopped. When none is
 * running, the extension does NOT start the resident background service any
 * more; it starts a private, temporary `<engine> serve` bound to 127.0.0.1
 * (OpenCode's documented standalone mode, same data), and `release()` stops
 * it as soon as the user-triggered operation finished.
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
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
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
    throw new OpenCodeApiError(`Cannot connect to the OpenCode background service (${method} ${path}): ${error instanceof Error ? error.message : String(error)}`);
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
    throw new OpenCodeApiError(`OpenCode service request failed (HTTP ${response.status}, ${method} ${path}): ${detail}`, response.status, path);
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

/** Ask the OS for a currently free loopback TCP port (listened, then released). */
function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (address === null || typeof address === "string") { reject(new Error("Cannot obtain an ephemeral port.")); return; }
      const port = address.port;
      listener.close(() => resolve(port));
    });
  });
}

export class OpenCodeServiceConnection {
  private handle: ServiceHandle | null = null;
  private starting: Promise<ServiceHandle> | null = null;
  /** The private temporary server this connection started, if any. */
  private privateServer: { child: ChildProcess; handle: ServiceHandle } | null = null;
  private usedPrivate = false;
  /** True when the last connection used a private temporary server (reported honestly). */
  public readonly startedByExtension = (): boolean => this.usedPrivate;

  /**
   * The engine callback may resolve lazily and asynchronously (persisted
   * choice / npm global / PATH discovery), so a Promise result is allowed.
   */
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly enginePath: () => string | null | Promise<string | null>,
  ) {}

  /** Current server handle: the running background service, else a private temporary server. */
  connect(): Promise<ServiceHandle> {
    if (this.starting !== null) return this.starting;
    const attempt = this.connectOnce();
    this.starting = attempt;
    attempt.catch(() => undefined).finally(() => { if (this.starting === attempt) this.starting = null; });
    return attempt;
  }

  private async connectOnce(): Promise<ServiceHandle> {
    if (this.handle !== null) {
      if (await this.ping(this.handle)) return this.handle;
      this.handle = null; // stale: no longer answers
    }
    const existing = await readServiceFile(serviceFile(this.env));
    if (existing !== null && (await this.ping(existing))) {
      this.handle = existing;
      this.usedPrivate = false;
      return existing;
    }
    return this.startPrivateServer();
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

  private async startPrivateServer(): Promise<ServiceHandle> {
    const engine = await this.enginePath();
    if (engine === null) {
      throw new OpenCodeApiError("No OpenCode background service is running, and no native OpenCode engine was found on this machine to read the history. Select the engine path in the settings.");
    }
    const password = randomBytes(18).toString("base64url");
    const port = await ephemeralPort();
    const child = spawn(engine, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      env: { ...this.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_AUTOUPDATE: "1" },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", chunk => { if (stderr.length < 2000) stderr += String(chunk); });
    const exited = new Promise<void>(resolve => { child.once("close", () => resolve()); child.once("error", () => resolve()); });
    const handle: ServiceHandle = { url: `http://127.0.0.1:${port}`, password };
    this.privateServer = { child, handle };
    const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;
    let delay = 150;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      if (await this.ping(handle)) {
        this.handle = handle;
        this.usedPrivate = true;
        return handle;
      }
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, delay))]);
      delay = Math.min(1000, delay * 2);
    }
    await this.release();
    throw new OpenCodeApiError(`The temporary OpenCode server did not become ready${child.exitCode !== null ? ` (exit code ${child.exitCode})` : " within the expected time"}${stderr ? ": " + stderr.slice(0, 300) : ""}.`);
  }

  /** Stops the private temporary server (if this connection started one). A shared service is never touched. */
  async release(): Promise<void> {
    const own = this.privateServer;
    this.privateServer = null;
    if (own === null) return;
    if (this.handle === own.handle) this.handle = null;
    const { child } = own;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 5000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      // The server may own helper processes (e.g. configured MCP servers):
      // end the whole tree on Windows so nothing is orphaned.
      if (process.platform === "win32" && child.pid !== undefined) {
        const systemRoot = this.env.SystemRoot ?? this.env.SYSTEMROOT ?? process.env.SystemRoot ?? "C:\\Windows";
        const killer = spawn(join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.once("error", () => child.kill());
      } else child.kill();
    });
  }

  get privateServerRunning(): boolean {
    const child = this.privateServer?.child;
    return Boolean(child && child.exitCode === null && child.signalCode === null);
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
      throw new OpenCodeApiError("The service returned a list in an unexpected shape (missing data array).");
    }
    rows.push(...page.data);
    const next = page.cursor?.next;
    if (typeof next !== "string" || next === "") break;
    if (seenCursors.has(next)) {
      throw new OpenCodeApiError(`A paging cursor repeated (${next.slice(0, 48)}), which suggests a server-side paging anomaly; aborted instead of returning an incomplete result.`);
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
      throw new OpenCodeApiError(`Subscribing to the OpenCode event stream failed (HTTP ${response.status}).`, response.status, "/api/event");
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
        onDown("The event stream ended.");
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
    throw new OpenCodeApiError(`The export for session ${sessionId} is incomplete (missing info or messages).`);
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
