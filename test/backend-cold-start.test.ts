/**
 * Cold-start regression (backend-exclusive, real isolated engine).
 *
 * Reproduces the supervisor's actual first-use failure: no background service
 * running, no explicit enginePath configured and no persisted engine choice —
 * only PATH discovery can find the native engine. Everything runs in the
 * fully isolated synthetic home from the same sandbox layout
 * (opencode-backend-validation): private HOME/APPDATA/LOCALAPPDATA/XDG roots,
 * private DB/config/state, a DYNAMIC dedicated port (asserted != the default
 * 28894), and the real installed engine binary reused read-only. The user's
 * real home, auth, history and services (including anything on the default
 * port) are never contacted, read or written; no model requests are made.
 *
 * Sequence: seed one synthetic session while a service is up, stop ONLY that
 * sandbox-owned service, then cold-start a CatalogService with NO enginePath
 * option: subscribe BEFORE refresh, auto-discovery must find the engine on
 * PATH, start this sandbox's own service, and the inventory must be readable.
 * CatalogService.dispose() must NOT stop the (shared-by-handle) service; the
 * test stops only the service it started, explicitly, at the end.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { CatalogService } from "../src/backend/catalogService";
import { ENGINE, DIR_A, freshSandbox, unwrap, type Sandbox } from "./backend/sandbox";

const DEFAULT_PORT = "28894";

let sandbox: Sandbox;
let service: CatalogService;
let seededId: string;

function runEngineStop(env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise(resolvePromise => {
    const child = spawn(ENGINE, ["service", "stop"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout?.on("data", chunk => { output += String(chunk); });
    child.stderr?.on("data", chunk => { output += String(chunk); });
    child.on("error", error => resolvePromise({ code: -1, output: error.message }));
    child.on("close", code => resolvePromise({ code, output }));
  });
}

function serviceUrl(env: NodeJS.ProcessEnv): { url: string; port: string } {
  const service = JSON.parse(readFileSync(join(env.XDG_STATE_HOME!, "opencode", "service.json"), "utf8")) as { url?: string };
  assert.equal(typeof service.url, "string", "sandbox service.json missing url");
  const parsed = new URL(service.url!);
  return { url: service.url!, port: parsed.port };
}

async function infoAlive(url: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    // `service stop` removes the discovery file — that is "not alive".
    const service = JSON.parse(readFileSync(join(env.XDG_STATE_HOME!, "opencode", "service.json"), "utf8")) as { password?: string; url?: string };
    const aliveUrl = typeof service.url === "string" ? service.url : url;
    const probe = await fetch(aliveUrl + "/api/info", {
      headers: { authorization: "Basic " + Buffer.from("opencode:" + (service.password ?? "")).toString("base64") },
      signal: AbortSignal.timeout(3000),
    });
    return probe.ok;
  } catch {
    return false;
  }
}

before(async () => {
  sandbox = await freshSandbox("cold-start");

  // Seed one synthetic session via the official REST API (no model calls).
  const now = Date.now();
  const envelope = {
    info: {
      id: "ses_cold_start_probe",
      projectID: "global",
      title: "cold-start-regression",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now - 60000, updated: now - 30000 },
      location: { directory: DIR_A },
    },
    messages: [{ id: "msg_cold_0", type: "user", time: { created: now - 50000 }, text: "cold start probe turn" }],
    location: { directory: DIR_A },
  };
  const seeded = await sandbox.rest("POST", "/api/experimental/session/import", envelope);
  assert.equal(seeded.status, 200, `cold-start seed failed: ${seeded.text.slice(0, 300)}`);
  seededId = unwrap<{ id: string }>(seeded.value).id;

  // Cold condition: stop ONLY this sandbox's own service (sandbox env targets
  // this synthetic home exclusively; the default port / user services are
  // never touched).
  const stop = await runEngineStop(sandbox.env);
  assert.equal(stop.code, 0, `sandbox service stop failed: ${stop.output.slice(0, 300)}`);
  assert.equal(await infoAlive("", sandbox.env), false, "sandbox service still alive before cold start");
});

after(async () => {
  await service?.dispose().catch(() => undefined);
  // Explicit cleanup of exactly the service this test started (sandbox env).
  await runEngineStop(sandbox.env).catch(() => undefined);
});

describe("cold start (static sidebar: no resident processes)", () => {
  test("with no service running, a refresh uses a temporary private server, then stops it", async () => {
    // No enginePath option, no persisted engine choice (fresh storagePath),
    // PATH is the ONLY discovery source: the real engine directory prepended.
    const env: NodeJS.ProcessEnv = {
      ...sandbox.env,
      PATH: dirname(ENGINE) + ";" + (sandbox.env.PATH ?? ""),
    };
    service = new CatalogService({ storagePath: sandbox.storagePath, env });

    const inventory = await service.refresh();
    const warning = inventory.warnings.find(w => w.includes("temporary private OpenCode server"));
    assert.ok(warning, `expected temporary-server note, got: ${JSON.stringify(inventory.warnings)}`);
    assert.ok(inventory.sessions.some(row => row.session_id === seededId), "seeded session missing from cold-start inventory");
    assert.equal(inventory.archive_mode, "native");
    assert.equal(service.privateServerRunning, false, "the temporary server is stopped right after the read");
    assert.equal(await infoAlive("", sandbox.env), false, "the resident background service was NOT started");

    // A preview read follows the same lifetime.
    const page = await service.readHistory(seededId);
    assert.ok(page.entries.length > 0, "history readable through the temporary server");
    assert.equal(service.privateServerRunning, false);

    // Discovery result is exposed correctly.
    assert.equal(await service.getEnginePath(), ENGINE);
  });

  test("dispose leaves nothing running", async () => {
    await service.dispose();
    assert.equal(service.privateServerRunning, false);
    assert.equal(await infoAlive("", sandbox.env), false);
  });
});
