/**
 * Isolated verification host for concrete backup roundtrips (backend-internal).
 *
 * Before any deletion, the stored export files must actually survive an
 * official import + read in a dedicated synthetic environment (contract:
 * "confirm the actual stored export can be re-imported/read in isolation,
 * not only that a generic fixture once worked"). This module starts the real
 * native engine as `opencode serve` with every home/database/config/env root
 * inside a private throwaway directory under the extension's own storage:
 * the process cannot see user auth, user plugins or the shared database
 * because none of its environment points at them, and imports are pure data
 * operations (no model request).
 *
 * Network scope, stated truthfully (revision item F): the server binds to
 * 127.0.0.1 on an OS-assigned free port — a listen address, NOT a network
 * egress isolation. No firewall, sandbox or permission framework is applied
 * here; nothing about the process's outbound network access is restricted.
 * The directory is removed when verification ends.
 */
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

export interface VerifyHost {
  url: string;
  password: string;
  stop: () => Promise<void>;
}

const START_TIMEOUT_MS = 45000;

function childEnv(root: string, password: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    XDG_DATA_HOME: join(root, "xdg", "data"),
    XDG_CONFIG_HOME: join(root, "xdg", "config"),
    XDG_CACHE_HOME: join(root, "xdg", "cache"),
    XDG_STATE_HOME: join(root, "xdg", "state"),
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    OPENCODE_DB: join(root, "xdg", "data", "opencode", "opencode.db"),
    OPENCODE_CONFIG: join(root, "xdg", "config", "opencode", "opencode.json"),
    OPENCODE_SERVER_PASSWORD: password,
    NO_COLOR: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Recursive deletes only ever target paths inside the verify-hosts root. */
function assertInsideVerifyRoot(root: string, hostsRoot: string): void {
  const resolvedRoot = resolve(root);
  const resolvedHosts = resolve(hostsRoot);
  if (resolvedRoot !== resolvedHosts && !resolvedRoot.startsWith(resolvedHosts + sep)) {
    throw new Error(`Refusing to delete a path outside the isolated verification root: ${resolvedRoot}`);
  }
}

/** Ask the OS for a currently free TCP port (listened, then released). */
function ephemeralPort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const listener = createServer();
    listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Cannot obtain an ephemeral port."));
        return;
      }
      const port = address.port;
      listener.close(() => resolvePromise(port));
    });
  });
}

/**
 * Start the isolated verification host. `enginePath` must already be a
 * verified native exe; failures throw with the captured startup output.
 */
export async function startVerifyHost(enginePath: string, storagePath: string): Promise<VerifyHost> {
  const id = randomUUID().slice(0, 8);
  const hostsRoot = join(storagePath, "verify-hosts");
  const root = join(hostsRoot, `vh-${id}`);
  await mkdir(root, { recursive: true });
  const password = `verify-${id}`;
  const port = await ephemeralPort();
  const env = childEnv(root, password);
  const child = spawn(enginePath, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    env,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  const url = `http://127.0.0.1:${port}`;
  const auth = "Basic " + Buffer.from("opencode:" + password).toString("base64");
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const exited = child.exitCode !== null;
    try {
      const probe = await fetch(url + "/api/info", { headers: { authorization: auth }, signal: AbortSignal.timeout(2000) });
      if (probe.ok) break;
    } catch {
      // not ready yet
    }
    if (exited) {
      assertInsideVerifyRoot(root, hostsRoot);
      await rm(root, { recursive: true, force: true });
      throw new Error(`The isolated verification service failed to start (exit code ${child.exitCode}).`);
    }
    if (Date.now() > deadline) {
      child.kill();
      assertInsideVerifyRoot(root, hostsRoot);
      await rm(root, { recursive: true, force: true });
      throw new Error("The isolated verification service did not become ready within the expected time.");
    }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return {
    url,
    password,
    stop: async () => {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 5000);
        child.once("close", () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
      assertInsideVerifyRoot(root, hostsRoot);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** Authenticated JSON call against a VerifyHost. */
export async function verifyCall(
  host: VerifyHost,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; value: unknown }> {
  const auth = "Basic " + Buffer.from("opencode:" + host.password).toString("base64");
  const response = await fetch(host.url + path, {
    method,
    headers: { authorization: auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  return { status: response.status, value };
}
