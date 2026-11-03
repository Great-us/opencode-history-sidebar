/**
 * Live change-channel integration tests against the real installed engine
 * (backend-exclusive, fully isolated synthetic home). Proves the always-current
 * machinery with the topology the dependency probes established:
 *
 * - one shared background service: every client-path write of that service
 *   arrives on the backend's SSE subscription as a coalesced batch;
 * - a second server process writing the same database is INVISIBLE to that
 *   SSE stream (0 events, live probe) but moves the db/wal stat fingerprint —
 *   the reconcile trigger detects it and emits a reconcile batch;
 * - stopping the sandbox's own service breaks the stream (degraded) and the
 *   product's authorized restart path recovers with a full reconcile batch.
 *
 * Only services started inside this sandbox are stopped here; the user's real
 * shared service is never touched.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { CatalogService } from "../src/backend/catalogService";
import type { CatalogChangeBatch } from "../src/backend/liveChannel";
import { DIR_A, DIR_B, ENGINE, freePort, freshSandbox, restForUrl, sleep, startSecondServer, type Sandbox } from "./backend/sandbox";
import { spawn } from "node:child_process";

let sandbox: Sandbox;
let service: CatalogService;
const batches: CatalogChangeBatch[] = [];

const SECOND_PASSWORD = "backend-live-second-pw";

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`等待超时：${label}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

before(async () => {
  sandbox = await freshSandbox("live");
  service = new CatalogService({ storagePath: sandbox.storagePath, enginePath: ENGINE, env: sandbox.env });
  service.subscribeChanges(batch => batches.push(batch));
  // Subscribe before the first snapshot: no vacuum window at startup.
  await waitFor(() => service.liveStatus().state === "live", 15000, "SSE 订阅建立");
});

after(async () => {
  await service?.dispose();
  await sandbox?.teardown();
});

describe("live channel", () => {
  test("client-path writes on the shared service arrive as coalesced batches", async () => {
    batches.length = 0;
    const created = await sandbox.rest("POST", "/api/session", { title: "live-sse-P", location: { directory: DIR_A } });
    assert.equal(created.status, 200);
    const id = (created.value as { data?: { id?: string } }).data?.id ?? (created.value as { id?: string }).id;
    assert.ok(id, "created session id");
    await sandbox.rest("PATCH", `/api/session/${id}`, { archived: true });
    await waitFor(() => batches.some(batch => batch.origin === "sse" && batch.hints.some(hint => hint.kind === "session.metadata" && hint.sessionIds?.includes(id!))), 10000, "SSE 元数据批次");
    const merged = batches.filter(batch => batch.origin === "sse").flatMap(batch => batch.hints);
    assert.ok(merged.some(hint => hint.sessionIds?.includes(id!)), "created session hinted");
    // Archive/restore events for the same session coalesce into one window.
    await sandbox.rest("PATCH", `/api/session/${id}`, { archived: false });
    await waitFor(() => {
      const latest = batches[batches.length - 1];
      return latest !== undefined && latest.origin === "sse";
    }, 10000, "解归档批次");
    assert.ok(service.liveStatus().lastEventAt !== undefined, "lastEventAt tracked");
  });

  test("deleting through the service emits a session.removed hint", async () => {
    batches.length = 0;
    const created = await sandbox.rest("POST", "/api/session", { title: "live-sse-del", location: { directory: DIR_B } });
    const id = (created.value as { data?: { id?: string } }).data?.id ?? (created.value as { id?: string }).id;
    await sandbox.rest("DELETE", `/api/session/${id}`);
    await waitFor(() => batches.some(batch => batch.hints.some(hint => hint.kind === "session.removed" && hint.sessionIds?.includes(id!))), 10000, "删除提示");
  });

  test("external second-process writes are invisible to SSE but detected by caller-driven pollStatChange", async () => {
    batches.length = 0;
    // Revision item E: the second isolated server also binds a DYNAMIC free
    // port — no fixed port is ever claimed (an unknown process may hold it).
    const secondPort = await freePort();
    const second = await startSecondServer(sandbox.env, secondPort, SECOND_PASSWORD);
    try {
      const external = restForUrl(second.url, SECOND_PASSWORD);
      const created = await external("POST", "/api/session", { title: "live-external-B", location: { directory: DIR_A } });
      assert.equal(created.status, 200);
      const id = (created.value as { data?: { id?: string } }).data?.id ?? (created.value as { id?: string }).id;
      // Give any (wrong) SSE delivery ample time to prove it does not arrive.
      await sleep(2500);
      const sseForExternal = batches.filter(batch => batch.origin === "sse").flatMap(batch => batch.hints)
        .filter(hint => hint.sessionIds?.includes(id!));
      assert.equal(sseForExternal.length, 0, "cross-process writes must not claim SSE delivery (probe-verified gap)");
      // Revision item D: the backend has NO self-timer any more — the UI owns
      // the only 2-second cadence and drives pollStatChange() as the real
      // caller. Emulate exactly that caller contract here (a fast test-local
      // cadence against the REAL external commit; the write itself is never
      // simulated).
      const deadline = Date.now() + 8000;
      let detected = false;
      while (Date.now() < deadline) {
        service.pollStatChange();
        await sleep(200);
        if (batches.some(batch => batch.origin === "reconcile")) { detected = true; break; }
      }
      assert.ok(detected, "外部提交被 stat 对账信号检出（真实调用方按自身节奏驱动 pollStatChange）");
      assert.ok(service.liveStatus().state === "live" || service.liveStatus().state === "degraded");
      const inventory = await service.refresh();
      assert.ok(inventory.sessions.some(row => row.session_id === id), "external row visible after reconcile refresh");
    } finally {
      await second.stop();
    }
  });

  test("service outage degrades the channel; the authorized restart recovers with a full reconcile", async () => {
    // Stop ONLY this sandbox's own service (never a user service).
    const stop = await new Promise<{ code: number | null; output: string }>(resolve => {
      const child = spawn(ENGINE, ["service", "stop"], { env: sandbox.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let output = "";
      child.stdout?.on("data", chunk => { output += String(chunk); });
      child.stderr?.on("data", chunk => { output += String(chunk); });
      child.on("close", code => resolve({ code, output }));
    });
    assert.equal(stop.code, 0, `sandbox service stop failed: ${stop.output.slice(0, 200)}`);
    await waitFor(() => service.liveStatus().state === "degraded", 20000, "断流进入 degraded");

    // Product-authorized recovery with no manual help: the backend itself
    // restarts the official local service for its data root and reconciles
    // before going live again (exactly one restarter — no racing spawns).
    batches.length = 0;
    await waitFor(() => service.liveStatus().state === "live", 60000, "后端自动重启服务并恢复 live");
    await waitFor(() => batches.some(batch => batch.origin === "reconcile"), 10000, "恢复后的全量对账批次");
    // Resume-card handoff item: the recovered stream must not keep the stale
    // disconnect warning behind — a live channel clears what got recovered.
    assert.ok(
      !service.liveStatus().warnings.some(warning => warning.includes("Event stream interrupted")),
      "重连恢复 live 后，对应的断线警告必须被清除",
    );
    const inventory = await service.refresh();
    assert.ok(Array.isArray(inventory.sessions), "refresh works again after recovery");
  });
});

describe("activity semantics (positive evidence only)", () => {
  test("first open with no new SSE start marks running from the positive /api/session/active snapshot; absence stays unknown", async () => {
    // Baseline against the REAL endpoint (probe-verified: the active set is
    // process-scoped and REST-driven synthetic work never enters it): no
    // positive evidence means NO running claim — absence is never idle.
    let inventory = await service.refresh();
    assert.ok(inventory.sessions.length > 0, "sandbox rows present");
    for (const row of inventory.sessions) {
      assert.equal(row.running, undefined, `no positive evidence: ${row.session_id} must not claim running`);
      assert.equal(row.activity_source, undefined, "no evidence source without evidence");
      if (row.last_busy_at != null) {
        assert.notEqual(row.running, true, "a stale persisted busy timestamp is not a heartbeat");
      }
    }
    // Positive snapshot (a session the service itself reports active — e.g. a
    // first open with a live session and no new SSE execution.start seen by
    // this subscriber): simulated with a scoped fetch hook because the probe
    // proved REST-only synthetic work can never enter the real active set.
    const target = inventory.sessions[0]!;
    const serviceUrl = sandbox.serviceUrl();
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith(serviceUrl) && url.includes("/api/session/active")) {
          return new Response(JSON.stringify({ data: { [target.session_id]: {} } }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return originalFetch(input, init);
      }) as typeof fetch;
      inventory = await service.refresh();
      const running = inventory.sessions.find(row => row.session_id === target.session_id)!;
      assert.equal(running.running, true, "positive active evidence marks the row running");
      assert.equal(running.activity_source, "service-live");
      for (const row of inventory.sessions) {
        if (row.session_id === target.session_id) continue;
        assert.equal(row.running, undefined, "absence of evidence stays unknown for every other row");
      }
      // A positively-active session must also REFUSE deletion (revision item
      // B), before any backup is taken.
      await assert.rejects(() => service.deleteSession(target.session_id), (error: unknown) => {
        assert.ok(String((error as Error).message).includes("are running"), `unexpected refusal message: ${(error as Error).message}`);
        return true;
      });
      const after = await service.refresh();
      assert.ok(after.sessions.some(row => row.session_id === target.session_id), "active session untouched by the refusal");
    } finally {
      globalThis.fetch = originalFetch;
    }
    // Back on the real (empty) active set the claim disappears again.
    inventory = await service.refresh();
    assert.equal(inventory.sessions.find(row => row.session_id === target.session_id)?.running, undefined);
  });
});
