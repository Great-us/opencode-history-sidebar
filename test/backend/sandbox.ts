/**
 * Isolated synthetic OpenCode home for backend tests (backend-exclusive).
 *
 * Every home/environment root points inside work/opencode-backend-validation/
 * sandbox (same layout the two probes used): the real installed native engine
 * runs against a private database/config/state, nothing touches the user's
 * ~/.local/share/opencode, auth.json, global config or running services. The
 * shared background service started here belongs to this test home only and is
 * stopped in teardown; the user's real service (if any) is never contacted.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:net";

// out/test/backend -> up four = work/ (the task's writable validation area).
const WORK_DIR = resolve(__dirname, "..", "..", "..", "..");
export const VALIDATION_ROOT = join(WORK_DIR, "opencode-backend-validation");
export const SANDBOX_ROOT = join(VALIDATION_ROOT, "sandbox");
export const ENGINE = process.env.OPENCODE_BACKEND_TEST_ENGINE
  ?? join(process.env.APPDATA ?? "", "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe");
export const DIR_A = join(SANDBOX_ROOT, "projects", "demo-a");
export const DIR_B = join(SANDBOX_ROOT, "projects", "demo-b");
export const DIR_C = join(SANDBOX_ROOT, "projects", "demo-c");

/**
 * Revision item E: every synthetic service this sandbox starts binds a
 * DYNAMIC, currently-free port chosen at setup time (`service set port`
 * before `service start`, exactly like the supervisor's reproduction
 * script). Nothing here ever touches a service on the default port — an
 * unknown/user process holding it is left strictly alone.
 */
export function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const listener = createServer();
    listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (address === null || typeof address === "string") {
        reject(new Error("无法获取临时端口号。"));
        return;
      }
      const port = address.port;
      listener.close(() => resolvePromise(port));
    });
  });
}

/**
 * Recursive deletes are gated on the resolved absolute target: only paths
 * strictly inside work/opencode-backend-validation/** may ever be removed.
 */
function assertInsideValidation(target: string): void {
  const resolved = resolve(target);
  const root = resolve(VALIDATION_ROOT);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`拒绝删除验证目录之外的路径：${resolved}（合法根：${root}）`);
  }
}

export interface Sandbox {
  env: NodeJS.ProcessEnv;
  storagePath: string;
  rest: (method: string, path: string, body?: unknown, query?: Record<string, string>) => Promise<{ status: number; value: unknown; text: string }>;
  serviceUrl: () => string;
  teardown: () => Promise<void>;
}

function winPath(path: string): string {
  return path.replace(/\//g, "\\");
}

async function ensureDirectories(): Promise<void> {
  for (const directory of [
    join(SANDBOX_ROOT, "home"),
    join(SANDBOX_ROOT, "xdg", "data"),
    join(SANDBOX_ROOT, "xdg", "config"),
    join(SANDBOX_ROOT, "xdg", "cache"),
    join(SANDBOX_ROOT, "xdg", "state"),
    join(SANDBOX_ROOT, "appdata"),
    join(SANDBOX_ROOT, "localappdata"),
    join(VALIDATION_ROOT, "extension-storage"),
    DIR_A,
    DIR_B,
    DIR_C,
  ]) {
    await mkdir(directory, { recursive: true });
  }
}

function buildEnv(): NodeJS.ProcessEnv {
  const sandbox = winPath(SANDBOX_ROOT);
  return {
    ...process.env,
    HOME: join(sandbox, "home"),
    USERPROFILE: join(sandbox, "home"),
    XDG_DATA_HOME: join(sandbox, "xdg", "data"),
    XDG_CONFIG_HOME: join(sandbox, "xdg", "config"),
    XDG_CACHE_HOME: join(sandbox, "xdg", "cache"),
    XDG_STATE_HOME: join(sandbox, "xdg", "state"),
    APPDATA: join(sandbox, "appdata"),
    LOCALAPPDATA: join(sandbox, "localappdata"),
    OPENCODE_DB: join(sandbox, "xdg", "data", "opencode", "opencode.db"),
    OPENCODE_CONFIG: join(sandbox, "xdg", "config", "opencode", "opencode.json"),
    NO_COLOR: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function runEngine(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise(resolvePromise => {
    const child = spawn(ENGINE, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout?.on("data", chunk => { output += String(chunk); });
    child.stderr?.on("data", chunk => { output += String(chunk); });
    child.on("error", error => resolvePromise({ code: -1, output: error.message }));
    child.on("close", code => resolvePromise({ code, output }));
  });
}

interface ServiceFile { url?: string; password?: string }

async function readService(env: NodeJS.ProcessEnv): Promise<ServiceFile | null> {
  try {
    return JSON.parse(await readFile(join(env.XDG_STATE_HOME!, "opencode", "service.json"), "utf8")) as ServiceFile;
  } catch {
    return null;
  }
}

async function restFor(env: NodeJS.ProcessEnv): Promise<Sandbox["rest"]> {
  const service = await readService(env);
  if (service === null || typeof service.url !== "string" || typeof service.password !== "string") {
    throw new Error("测试沙箱的后台服务未就绪（缺少 service.json）。");
  }
  const auth = "Basic " + Buffer.from("opencode:" + service.password).toString("base64");
  return async (method, path, body, query) => {
    const url = new URL(service.url! + path);
    if (query !== undefined) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method,
      headers: { authorization: auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let value: unknown = null;
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
    return { status: response.status, value, text };
  };
}

/**
 * Fresh sandbox: wipes the previous synthetic home, starts the shared
 * background service through the official CLI exactly like the product does
 * (on a DYNAMIC dedicated port — never the default port, which an unknown or
 * user process may hold), and hands out an authenticated REST helper for
 * seeding synthetic data.
 */
export async function freshSandbox(label: string): Promise<Sandbox> {
  if (!existsSync(ENGINE)) throw new Error(`本机未找到 OpenCode 原生引擎，后端真实测试无法运行：${ENGINE}`);
  // Best-effort stop of a leftover service from a previous sandbox run, so a
  // half-dead process can never hold its port across the wipe. This targets
  // ONLY this sandbox's own discovery file/environment; nothing on the
  // default port or any other home is ever contacted or stopped.
  if (existsSync(join(SANDBOX_ROOT, "xdg", "state", "opencode", "service.json"))) {
    await runEngine(["service", "stop"], buildEnv()).catch(() => undefined);
  }
  assertInsideValidation(SANDBOX_ROOT);
  await rm(SANDBOX_ROOT, { recursive: true, force: true });
  await ensureDirectories();
  const env = buildEnv();
  await writeFile(join(DIR_A, "keep.txt"), "synthetic workspace\n", "utf8");
  await writeFile(join(DIR_B, "keep.txt"), "synthetic workspace\n", "utf8");
  await writeFile(join(DIR_C, "keep.txt"), "synthetic workspace\n", "utf8");
  // Revision item E: dedicated dynamic port, chosen free right now via the
  // official `service set port` before `service start` — the exact sequence
  // the supervisor's reproduction script validated. Unknown/user services on
  // the default port are never touched.
  const port = await freePort();
  const setPort = await runEngine(["service", "set", "port", String(port)], env);
  if (setPort.code !== 0) throw new Error(`设置沙箱动态端口失败（退出码 ${setPort.code}）：${setPort.output.slice(0, 400)}`);
  const start = await runEngine(["service", "start"], env);
  if (start.code !== 0) throw new Error(`启动沙箱后台服务失败（退出码 ${start.code}）：${start.output.slice(0, 400)}`);
  const deadline = Date.now() + 45000;
  for (;;) {
    const service = await readService(env);
    if (service !== null && typeof service.url === "string") {
      try {
        const probe = await fetch(service.url + "/api/info", {
          headers: { authorization: "Basic " + Buffer.from("opencode:" + (service.password ?? "")).toString("base64") },
          signal: AbortSignal.timeout(3000),
        });
        if (probe.ok && new URL(service.url).port === String(port)) break;
      } catch {
        // not ready yet
      }
    }
    if (Date.now() > deadline) throw new Error("沙箱后台服务未在预期时间内就绪。");
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  const storagePath = join(VALIDATION_ROOT, "extension-storage", label);
  // The extension's private state (engine choice, legacy tombstones/archive
  // flags, backups) must start virgin too — a tombstone from an earlier run
  // would legitimately suppress a freshly injected legacy row.
  assertInsideValidation(storagePath);
  await rm(storagePath, { recursive: true, force: true });
  await mkdir(storagePath, { recursive: true });
  return {
    env,
    storagePath,
    rest: await restFor(env),
    serviceUrl: () => {
      const url = readServiceSync(env);
      return url ?? "";
    },
    teardown: async () => {
      const stop = await runEngine(["service", "stop"], env);
      if (stop.code !== 0) throw new Error(`停止沙箱后台服务失败（退出码 ${stop.code}）：${stop.output.slice(0, 400)}`);
    },
  };
}

function readServiceSync(env: NodeJS.ProcessEnv): string | null {
  try {
    const service = JSON.parse(readFileSync(join(env.XDG_STATE_HOME!, "opencode", "service.json"), "utf8")) as ServiceFile;
    return typeof service.url === "string" ? service.url : null;
  } catch {
    return null;
  }
}

/** Start an isolated second server (own process/own event bus) on the same DB. */
export async function startSecondServer(env: NodeJS.ProcessEnv, port: number, password: string): Promise<{ stop: () => Promise<void>; url: string }> {
  const child = spawn(ENGINE, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...env, OPENCODE_SERVER_PASSWORD: password },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45000;
  for (;;) {
    try {
      const probe = await fetch(url + "/api/info", {
        headers: { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") },
        signal: AbortSignal.timeout(2000),
      });
      if (probe.ok) break;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error("第二个隔离服务未在预期时间内就绪。");
    await new Promise(resolvePromise => setTimeout(resolvePromise, 400));
  }
  return {
    url,
    stop: () => new Promise<void>(resolvePromise => {
      child.on("close", () => resolvePromise());
      child.kill();
      setTimeout(resolvePromise, 5000);
    }),
  };
}

/** Authenticated REST helper for a fixed server (second process). */
export function restForUrl(url: string, password: string): Sandbox["rest"] {
  const auth = "Basic " + Buffer.from("opencode:" + password).toString("base64");
  return async (method, path, body, query) => {
    const target = new URL(url + path);
    if (query !== undefined) for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
    const response = await fetch(target, {
      method,
      headers: { authorization: auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let value: unknown = null;
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
    return { status: response.status, value, text };
  };
}

export function unwrap<T>(value: unknown): T {
  if (value !== null && typeof value === "object" && "data" in value && !Array.isArray(value)) {
    return (value as { data: T }).data;
  }
  return value as T;
}

export const sleep = (ms: number): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
