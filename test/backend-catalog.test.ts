/**
 * Backend integration tests against the real installed native engine
 * (backend-exclusive). Everything runs in the fully isolated synthetic home
 * from test/backend/sandbox.ts: private database/config/state, official
 * `service start`, synthetic data seeded through the official REST API
 * (imports of fixture envelopes — no model calls anywhere), and the sandbox's
 * own service stopped in teardown. Nothing touches the user's real data,
 * auth, services or terminals.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CatalogService, DeleteRefusedError } from "../src/backend/catalogService";
import type { LogEntry } from "../src/shared/types";
import { databaseFile } from "../src/backend/paths";
import { DIR_A, DIR_B, DIR_C, ENGINE, freshSandbox, unwrap, type Sandbox } from "./backend/sandbox";

const FIXTURE = JSON.parse(readFileSync(join(__dirname, "..", "..", "test", "fixtures", "backend", "parts-session.json"), "utf8"));

let sandbox: Sandbox;
let service: CatalogService;

interface Seeded {
  P: string; C1: string; G: string; C2: string; F: string; U: string; V: string; R: string; big: string; parts: string; X: string; Y: string;
  multi: string[]; multiArchived: string; multiChild: string; multiChildParent: string;
}

const seeded = {} as Seeded;

/** Small synthetic session seeded via official import (no model involvement). */
async function seedSession(id: string, title: string, directory: string, parentID: string | null, texts: string[], archived = false): Promise<string> {
  const now = Date.now();
  const envelope = {
    info: {
      id,
      projectID: "global",
      title,
      ...(parentID !== null ? { parentID } : {}),
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now - 60000, updated: now - 30000, ...(archived ? { archived: now - 10000 } : {}) },
      location: { directory },
    },
    messages: texts.map((text, index) => ({
      id: `msg_${id}_${index}`,
      type: "user",
      time: { created: now - 50000 + index * 100 },
      text,
    })),
    location: { directory },
  };
  const { status, text } = await sandbox.rest("POST", "/api/experimental/session/import", envelope);
  assert.equal(status, 200, `seed import ${id} failed: ${text.slice(0, 300)}`);
  return id;
}

before(async () => {
  sandbox = await freshSandbox("catalog");
  service = new CatalogService({ storagePath: sandbox.storagePath, enginePath: ENGINE, env: sandbox.env });

  const parts = await sandbox.rest("POST", "/api/experimental/session/import", FIXTURE);
  assert.equal(parts.status, 200, `parts fixture import failed: ${parts.text.slice(0, 300)}`);
  seeded.parts = FIXTURE.info.id as string;

  // Topology P -> C1 -> G, P -> C2, plus independent controls F/U/V (P family
  // in DIR_B, F/U in DIR_A, V in DIR_C) — the grandchild/sibling/independent
  // matrix the contract requires beyond the inventory probe's P/C pair.
  seeded.P = await seedSession("ses_be_P_root", "backend-P", DIR_B, null, ["P turn 1", "P turn 2"]);
  seeded.C1 = await seedSession("ses_be_C1_child", "backend-C1", DIR_B, seeded.P, ["C1 turn 1"]);
  seeded.G = await seedSession("ses_be_G_grand", "backend-G", DIR_B, seeded.C1, ["G turn 1", "G turn 2"]);
  seeded.C2 = await seedSession("ses_be_C2_child", "backend-C2", DIR_B, seeded.P, ["C2 turn 1"], true);
  seeded.F = await seedSession("ses_be_F_fork", "backend-F", DIR_A, null, ["F turn 1"]);
  seeded.U = await seedSession("ses_be_U_ctrl", "backend-U", DIR_A, null, ["U turn 1"]);
  seeded.V = await seedSession("ses_be_V_ctrl", "backend-V", DIR_C, null, ["V turn 1"]);
  seeded.R = await seedSession("ses_be_R_refuse", "backend-R", DIR_A, null, ["R turn 1", "R turn 2"]);

  // 55 sessions in DIR_C: strictly more than the API's default page of 50.
  for (let index = 0; index < 55; index += 1) {
    const { status, text } = await sandbox.rest("POST", "/api/session", { title: `paging-${String(index).padStart(2, "0")}`, location: { directory: DIR_C } });
    assert.equal(status, 200, `paging seed ${index} failed: ${text.slice(0, 200)}`);
  }

  // One long transcript for full-history paging (120 messages > one page).
  seeded.big = await seedSession("ses_be_big_page", "backend-big", DIR_A, null,
    Array.from({ length: 120 }, (_, index) => `big message ${index}`));

  // 120 more sessions in DIR_B (revision item F): the TOTAL inventory now
  // far exceeds the backend's own enumeration page limit (100), so global
  // enumeration must follow the cursor across multiple pages. One is
  // archived and one is a child of another, giving per-id archive/parent
  // assertions that can only hold if later pages were really read.
  seeded.multi = [];
  for (let index = 0; index < 120; index += 1) {
    const created = await sandbox.rest("POST", "/api/session", { title: `multi-${String(index).padStart(3, "0")}`, location: { directory: DIR_B } });
    assert.equal(created.status, 200, `multi seed ${index} failed: ${created.text.slice(0, 200)}`);
    seeded.multi.push(unwrap<{ id: string }>(created.value).id);
  }
  seeded.multiArchived = seeded.multi[7]!;
  const archived = await sandbox.rest("PATCH", `/api/session/${seeded.multiArchived}`, { archived: true });
  assert.equal(archived.status, 204, `multi archive failed: ${archived.text.slice(0, 200)}`);
  seeded.multiChildParent = seeded.multi[9]!;
  const child = await sandbox.rest("POST", "/api/session", { title: "multi-child", parentID: seeded.multiChildParent, location: { directory: DIR_B } });
  assert.equal(child.status, 200, `multi child failed: ${child.text.slice(0, 200)}`);
  seeded.multiChild = unwrap<{ id: string }>(child.value).id;
});

after(async () => {
  await service?.dispose();
  await sandbox?.teardown();
});

describe("inventory", () => {
  test("refresh enumerates every project and pages past the default limit", async () => {
    const inventory = await service.refresh();
    assert.equal(inventory.archive_mode, "native");
    assert.equal(inventory.engine_path, ENGINE);
    assert.ok(inventory.data_root.replace(/\\/g, "/").endsWith("opencode-backend-validation/sandbox/xdg/data/opencode"),
      `unexpected data root ${inventory.data_root}`);
    const ids = new Set(inventory.sessions.map(row => row.session_id));
    for (const id of Object.values(seeded)) {
      if (typeof id !== "string") continue;
      assert.ok(ids.has(id), `missing seeded session ${id}`);
    }
    // Revision item F: with 120 extra rows the total (186+) exceeds the
    // backend's own 100-row page limit, so EVERY multi id being present (and
    // no duplicates anywhere) proves the global cursor chain was followed to
    // the end across pages.
    assert.ok(inventory.sessions.length > 100, `expected the total inventory to exceed the 100-row page limit, got ${inventory.sessions.length}`);
    for (const id of seeded.multi) assert.ok(ids.has(id), `missing multi-paging session ${id} (later page not enumerated)`);
    assert.equal(inventory.sessions.length, ids.size, "no duplicate rows across enumeration pages");
    const pagingCount = inventory.sessions.filter(row => row.workspace === DIR_C).length;
    assert.ok(pagingCount >= 56, `expected >=56 rows in DIR_C (55 paging + V), got ${pagingCount}`);
    const archivedIds = inventory.sessions.filter(row => row.archived).map(row => row.session_id).sort();
    assert.deepEqual(archivedIds, [seeded.C2, seeded.multiArchived].sort());
    const gRow = inventory.sessions.find(row => row.session_id === seeded.G);
    assert.equal(gRow?.parent_session_id, seeded.C1);
    assert.equal(gRow?.kind, "child");
    assert.equal(gRow?.workspace_exists, true);
    // Parent/archive assertions that can only hold if later pages were read.
    const multiChildRow = inventory.sessions.find(row => row.session_id === seeded.multiChild);
    assert.equal(multiChildRow?.parent_session_id, seeded.multiChildParent);
    assert.equal(multiChildRow?.kind, "child");
    assert.equal(inventory.sessions.find(row => row.session_id === seeded.multiArchived)?.archived, true);
  });
});

describe("history", () => {
  test("readHistory pages the full transcript in order without truncation", async () => {
    let cursor: string | undefined;
    const entries: LogEntry[] = [];
    let pages = 0;
    let lastPageSize = -1;
    for (;;) {
      const page = await service.readHistory(seeded.big, cursor);
      pages += 1;
      lastPageSize = page.entries.length;
      entries.push(...page.entries);
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
      assert.ok(pages < 10, "paging did not terminate");
    }
    // Actual server protocol (probe + this run): the last non-empty page still
    // carries a trailing cursor, and the page after it is empty with none.
    assert.equal(pages, 4, `120 messages at 50/page = 3 content pages + 1 empty terminator, took ${pages}`);
    assert.equal(lastPageSize, 0, "final terminator page is empty");
    assert.equal(entries.length, 120);
    assert.deepEqual(entries.slice(0, 2).map(entry => entry.text), ["big message 0", "big message 1"]);
    assert.equal(entries[119].text, "big message 119");
    assert.equal(new Set(entries.map(entry => entry.id)).size, 120, "no duplicates across pages");
  });

  test("readHistory preserves body/tool/order fidelity from the probe-verified fixture", async () => {
    const page = await service.readHistory(seeded.parts);
    assert.deepEqual(page.entries.map(entry => entry.role), ["user", "thinking", "assistant", "tool", "system"]);
    assert.equal(page.entries[3].text.includes("/x/y.txt"), true);
    assert.equal(page.entries[3].text.includes("file content here"), true);
    // Trailing cursor past the last row is the server's honest protocol shape.
    assert.equal(typeof page.next_cursor, "string");
    assert.equal(page.warning, null);
  });
});

describe("archive", () => {
  test("setArchived round-trips through the native API with read-after-write", async () => {
    await service.setArchived(seeded.F, true);
    let inventory = await service.refresh();
    assert.equal(inventory.sessions.find(row => row.session_id === seeded.F)?.archived, true);
    await service.setArchived(seeded.F, false);
    inventory = await service.refresh();
    assert.equal(inventory.sessions.find(row => row.session_id === seeded.F)?.archived, false);
    // Archived child rows stay enumerable and individually flagged.
    assert.equal(inventory.sessions.find(row => row.session_id === seeded.C2)?.archived, true);
  });
});

describe("recoverable delete and restore", () => {
  test("deleting C1 removes exactly C1+G, keeps P/C2 and independent F/U/V", async () => {
    const result = await service.deleteSession(seeded.C1);
    assert.equal(result.status, "deleted");
    assert.deepEqual([...result.deleted_session_ids].sort(), [seeded.C1, seeded.G].sort());
    const inventory = await service.refresh();
    const ids = new Set(inventory.sessions.map(row => row.session_id));
    assert.equal(ids.has(seeded.C1), false);
    assert.equal(ids.has(seeded.G), false);
    for (const kept of [seeded.P, seeded.C2, seeded.F, seeded.U, seeded.V]) assert.equal(ids.has(kept), true, `${kept} must survive`);
    const backups = await service.listBackups();
    const backup = backups.find(item => item.session_ids.includes(seeded.C1));
    assert.ok(backup, "backup listed after delete");
    assert.equal(backup!.status, "available");
  });

  test("restore returns ids, parent links, archive state, directory and messages", async () => {
    const backups = await service.listBackups();
    const backup = backups.find(item => item.session_ids.includes(seeded.C1))!;
    const result = await service.restoreBackup(backup.backup_id);
    assert.equal(result.status, "restored", result.message);
    assert.deepEqual([...result.restored_session_ids].sort(), [seeded.C1, seeded.G].sort());
    const inventory = await service.refresh();
    const c1 = inventory.sessions.find(row => row.session_id === seeded.C1);
    const g = inventory.sessions.find(row => row.session_id === seeded.G);
    assert.ok(c1 && g, "restored rows present");
    assert.equal(c1!.parent_session_id, seeded.P);
    assert.equal(c1!.workspace, DIR_B, "original directory restored (explicit location import)");
    assert.equal(g!.parent_session_id, seeded.C1);
    const history = await service.readHistory(seeded.G);
    assert.deepEqual(history.entries.map(entry => entry.text), ["G turn 1", "G turn 2"]);
    const after = await service.listBackups();
    assert.equal(after.find(item => item.backup_id === backup.backup_id)?.status, "restored");
  });

  test("deleting P removes the whole P/C1/G/C2 family and restore brings it back intact", async () => {
    const result = await service.deleteSession(seeded.P);
    assert.equal(result.status, "deleted");
    assert.deepEqual([...result.deleted_session_ids].sort(), [seeded.P, seeded.C1, seeded.C2, seeded.G].sort());
    let inventory = await service.refresh();
    let ids = new Set(inventory.sessions.map(row => row.session_id));
    for (const gone of [seeded.P, seeded.C1, seeded.C2, seeded.G]) assert.equal(ids.has(gone), false);
    for (const kept of [seeded.F, seeded.U, seeded.V]) assert.equal(ids.has(kept), true);

    const backups = await service.listBackups();
    const backup = backups.find(item => item.session_ids.includes(seeded.P))!;
    const restored = await service.restoreBackup(backup.backup_id);
    assert.equal(restored.status, "restored", restored.message);
    assert.deepEqual([...restored.restored_session_ids].sort(), [seeded.P, seeded.C1, seeded.C2, seeded.G].sort());
    inventory = await service.refresh();
    ids = new Set(inventory.sessions.map(row => row.session_id));
    for (const back of [seeded.P, seeded.C1, seeded.C2, seeded.G]) assert.equal(ids.has(back), true);
    const c2 = inventory.sessions.find(row => row.session_id === seeded.C2);
    assert.equal(c2!.archived, true, "archive state restored with the family");
    const c1 = inventory.sessions.find(row => row.session_id === seeded.C1);
    assert.equal(c1!.parent_session_id, seeded.P);
    const history = await service.readHistory(seeded.P);
    assert.deepEqual(history.entries.map(entry => entry.text), ["P turn 1", "P turn 2"]);
  });

  test("restoring over existing sessions reports conflicts instead of overwriting", async () => {
    const backups = await service.listBackups();
    const backup = backups.find(item => item.session_ids.includes(seeded.P))!;
    const result = await service.restoreBackup(backup.backup_id);
    assert.equal(result.status, "partial");
    assert.deepEqual(result.restored_session_ids, []);
    assert.match(result.message, /已存在/);
    const inventory = await service.refresh();
    assert.ok(inventory.sessions.some(row => row.session_id === seeded.P), "existing session untouched");
    assert.deepEqual((await service.readHistory(seeded.P)).entries.map(entry => entry.text), ["P turn 1", "P turn 2"]);
  });
});

describe("refusals and partial outcomes", () => {
  test("an export that would lose live messages refuses the whole deletion and keeps the backup", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(`/api/experimental/session/${seeded.R}/export`)) {
          const response = await originalFetch(input, init);
          const body = (await response.json()) as { data?: { messages?: unknown[] }; messages?: unknown[] };
          const envelope = body.data ?? body; // the endpoint wraps the envelope in {data}
          envelope.messages = (envelope.messages ?? []).slice(0, 1); // simulate the documented unsettled-message export filter losing one
          return new Response(JSON.stringify(body.data !== undefined ? { data: envelope } : envelope), { status: 200, headers: { "content-type": "application/json" } });
        }
        return originalFetch(input, init);
      }) as typeof fetch;
      await assert.rejects(() => service.deleteSession(seeded.R), (error: unknown) => {
        assert.ok(error instanceof DeleteRefusedError, `expected DeleteRefusedError, got ${String(error)}`);
        assert.match((error as DeleteRefusedError).message, /拒绝删除/);
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    // Nothing was deleted; the failed backup stays listed as partial.
    const inventory = await service.refresh();
    assert.ok(inventory.sessions.some(row => row.session_id === seeded.R), "R must still exist after refusal");
    const history = await service.readHistory(seeded.R);
    assert.equal(history.entries.length, 2, "both live messages still present");
    const backups = await service.listBackups();
    const backup = backups.find(item => item.session_ids.includes(seeded.R));
    assert.ok(backup, "refusal backup retained");
    assert.equal(backup!.status, "partial");
  });

  test("a delete whose cascade outcome cannot be verified reports partial, keeps the backup and never re-DELETEs", async () => {
    seeded.X = await seedSession("ses_be_X_partial", "backend-X", DIR_A, null, ["X turn 1"]);
    seeded.Y = await seedSession("ses_be_Y_partial", "backend-Y", DIR_A, seeded.X, ["Y turn 1"]);
    const serviceUrl = sandbox.serviceUrl();
    const originalFetch = globalThis.fetch;
    let deletesForX = 0;
    let deletesForY = 0;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? "GET";
        if (method === "DELETE" && url.startsWith(serviceUrl)) {
          if (url.includes(`/api/session/${seeded.X}`)) deletesForX += 1;
          if (url.includes(`/api/session/${seeded.Y}`)) deletesForY += 1;
        }
        // Scoped to the sandbox service only: the isolated verification host
        // and the preflight inbox/message reads keep working so the partial
        // path stays realistic (the outage hits only post-delete
        // verification of Y).
        if (url.startsWith(serviceUrl) && url.includes(`/api/session/${seeded.Y}`) && !url.includes("/message") && !url.includes("/export") && !url.includes("/inbox") && !url.includes("/active")) {
          if (method === "GET" || method === "DELETE") {
            return new Response(JSON.stringify({ message: "injected verification outage" }), { status: 500 });
          }
        }
        return originalFetch(input, init);
      }) as typeof fetch;
      const result = await service.deleteSession(seeded.X);
      assert.equal(result.status, "partial");
      assert.match(result.message, /未完全生效|无法核验/);
      assert.deepEqual(result.deleted_session_ids, [seeded.X]);
      assert.ok(result.backup_id, "partial outcome carries a backup id");
      // Revision item G: exactly one root DELETE; no fallback descendant
      // DELETE against the unverified evolving tree.
      assert.equal(deletesForX, 1, "exactly one official root DELETE");
      assert.equal(deletesForY, 0, "no automatic fallback DELETE of the unverifiable descendant");
    } finally {
      globalThis.fetch = originalFetch;
    }
    const backups = await service.listBackups();
    assert.equal(backups.find(item => item.session_ids.includes(seeded.X))?.status, "partial");
  });

  test("in-use sessions are refused before any deletion", async () => {
    await assert.rejects(() => service.deleteSession(seeded.P, new Set([seeded.P])), (error: unknown) => {
      assert.ok(error instanceof DeleteRefusedError);
      assert.match((error as DeleteRefusedError).message, /终端仍在本扩展中打开/);
      return true;
    });
    const inventory = await service.refresh();
    assert.ok(inventory.sessions.some(row => row.session_id === seeded.P), "P untouched by in-use refusal");
  });
});

describe("engine", () => {
  test("setEnginePath validates and persists; getEnginePath resolves it", async () => {
    await assert.rejects(() => service.setEnginePath("C:\\does\\not\\exist.exe"));
    await service.setEnginePath(ENGINE);
    assert.equal(await service.getEnginePath(), ENGINE);
  });
});

/**
 * Delete-preflight boundary regressions (revision items A/B/G + review-4).
 *
 * Timing injection follows the suite's established technique (scoped fetch
 * hooks / temporary instance-method wraps around the REAL sandbox service):
 * the injected moments reproduce external writers changing state between the
 * verified backup and the pre-DELETE checks; every mutation the assertions
 * observe afterwards is the real server state.
 */
describe("delete preflight boundary regressions", () => {
  /** Wrap the (runtime-public) private readAllMessages; returns a restore fn. */
  function wrapReadAllMessages(hook: (sessionId: string, perSessionCall: number) => Promise<void>): () => void {
    const internal = service as unknown as { readAllMessages(sessionId: string): Promise<unknown[]> };
    const original = internal.readAllMessages.bind(service);
    const counts = new Map<string, number>();
    internal.readAllMessages = async (sessionId: string) => {
      const call = (counts.get(sessionId) ?? 0) + 1;
      counts.set(sessionId, call);
      await hook(sessionId, call);
      return original(sessionId);
    };
    return () => {
      delete (internal as { readAllMessages?: unknown }).readAllMessages;
    };
  }

  function fetchUrl(input: RequestInfo | URL): string {
    return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  }

  test("a child created during the per-message recheck refuses the deletion (late-child regression)", async () => {
    const parent = await seedSession("ses_be_LC_parent", "backend-LC", DIR_A, null, ["LC turn 1"]);
    let created = false;
    const restore = wrapReadAllMessages(async (sessionId, call) => {
      // Baseline read was call 1; the SECOND read of the parent is the
      // post-verification recheck — the exact window the supervisor's
      // reproduction injected a new child into.
      if (sessionId === parent && call === 2 && !created) {
        created = true;
        const child = await sandbox.rest("POST", "/api/session", { title: "late-child-during-recheck", parentID: parent, location: { directory: DIR_A } });
        assert.equal(child.status, 200, `late child creation failed: ${child.text.slice(0, 200)}`);
      }
    });
    try {
      await assert.rejects(() => service.deleteSession(parent), (error: unknown) => {
        assert.ok(error instanceof DeleteRefusedError, `expected DeleteRefusedError, got ${String(error)}`);
        assert.match((error as DeleteRefusedError).message, /范围已变化/);
        return true;
      });
    } finally {
      restore();
    }
    // Neither the parent nor the never-backed-up late child was deleted.
    const inventory = await service.refresh();
    const ids = new Set(inventory.sessions.map(row => row.session_id));
    assert.ok(ids.has(parent), "parent survives the refused deletion");
    assert.equal(inventory.sessions.filter(row => row.parent_session_id === parent).length, 1,
      "the late child survives: it was never in the verified backup");
    const backups = await service.listBackups();
    assert.equal(backups.find(item => item.session_ids.includes(parent))?.status, "partial");
  });

  test("a member archived during the recheck refuses the deletion (retained-metadata drift)", async () => {
    const parent = await seedSession("ses_be_MD_parent", "backend-MD", DIR_A, null, ["MD turn 1"]);
    const child = await seedSession("ses_be_MD_child", "backend-MD-child", DIR_A, parent, ["MD child turn 1"]);
    const restore = wrapReadAllMessages(async (sessionId, call) => {
      if (sessionId === parent && call === 2) {
        // Real official mutation of a scope member between backup and the
        // final retained-metadata comparison.
        const patched = await sandbox.rest("PATCH", `/api/session/${child}`, { archived: true });
        assert.equal(patched.status, 204, `archive drift failed: ${patched.text.slice(0, 200)}`);
      }
    });
    try {
      await assert.rejects(() => service.deleteSession(parent), (error: unknown) => {
        assert.ok(error instanceof DeleteRefusedError, `expected DeleteRefusedError, got ${String(error)}`);
        assert.match((error as DeleteRefusedError).message, /归档或其他保留元数据发生变化/);
        return true;
      });
    } finally {
      restore();
    }
    const inventory = await service.refresh();
    assert.ok(inventory.sessions.some(row => row.session_id === parent), "parent survives");
    assert.equal(inventory.sessions.find(row => row.session_id === child)?.archived, true,
      "the external archive change persisted (observed, not deleted)");
  });

  test("a member re-parented out of the closure (but still existing) refuses the deletion", async () => {
    const parent = await seedSession("ses_be_RP_parent", "backend-RP", DIR_A, null, ["RP turn 1"]);
    const child = await seedSession("ses_be_RP_child", "backend-RP-child", DIR_A, parent, ["RP child turn 1"]);
    const serviceUrl = sandbox.serviceUrl();
    const originalFetch = globalThis.fetch;
    let exportSeen = false;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = fetchUrl(input);
        const method = init?.method ?? "GET";
        if (url.startsWith(serviceUrl) && url.includes(`/api/experimental/session/${child}/export`)) exportSeen = true;
        // Only the GLOBAL session-list enumeration is rewritten, and only
        // after the backup export: the initial scope enumeration is honest,
        // the final closure enumeration observes the external re-parent.
        if (exportSeen && url.startsWith(serviceUrl) && method === "GET" && /\/api\/session\?/.test(url)) {
          const response = await originalFetch(input, init);
          const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
          for (const row of body.data ?? []) {
            if (row.id === child) row.parentID = "ses_be_RP_elsewhere";
          }
          return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
        }
        return originalFetch(input, init);
      }) as typeof fetch;
      await assert.rejects(() => service.deleteSession(parent), (error: unknown) => {
        assert.ok(error instanceof DeleteRefusedError, `expected DeleteRefusedError, got ${String(error)}`);
        assert.match((error as DeleteRefusedError).message, /已消失会话 ses_be_RP_child/);
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const inventory = await service.refresh();
    const ids = new Set(inventory.sessions.map(row => row.session_id));
    assert.ok(ids.has(parent) && ids.has(child), "both survive: the member left the closure but the real tree never changed");
  });

  test("a same-ID message body rewrite during the recheck refuses the deletion", async () => {
    const target = await seedSession("ses_be_SB_target", "backend-SB", DIR_A, null, ["SB original turn"]);
    const serviceUrl = sandbox.serviceUrl();
    const originalFetch = globalThis.fetch;
    let exportSeen = false;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = fetchUrl(input);
        if (url.startsWith(serviceUrl) && url.includes(`/api/experimental/session/${target}/export`)) exportSeen = true;
        if (exportSeen && url.startsWith(serviceUrl) && url.includes(`/api/session/${target}/message`)) {
          const response = await originalFetch(input, init);
          const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
          for (const message of body.data ?? []) {
            if (message.id === "msg_ses_be_SB_target_0") message.text = "SB externally rewritten body";
          }
          return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
        }
        return originalFetch(input, init);
      }) as typeof fetch;
      await assert.rejects(() => service.deleteSession(target), (error: unknown) => {
        assert.ok(error instanceof DeleteRefusedError, `expected DeleteRefusedError, got ${String(error)}`);
        assert.match((error as DeleteRefusedError).message, /正文不一致/);
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const history = await service.readHistory(target);
    assert.deepEqual(history.entries.map(entry => entry.text), ["SB original turn"],
      "the live transcript itself is untouched (the hook simulated an external writer)");
  });

  test("a non-empty pending inbox (invisible to the plain export) refuses the deletion", async () => {
    const target = await seedSession("ses_be_IN_target", "backend-IN", DIR_A, null, ["IN turn 1"]);
    // Probe-verified pending-inbox fixture (inbox-shape-probe4.cjs evidence):
    // a synthetic/queue session_inbox row with a msg_-shaped id surfaces
    // through the native GET inbox; REST-only synthetic work can never enter
    // the inbox organically. Pure SQL insert into the sandbox DB + native GET
    // confirmation — no model request anywhere.
    const inboxRowId = "msg_ses_be_IN_pending_1";
    const db = new DatabaseSync(databaseFile(sandbox.env), { timeout: 10000 });
    try {
      db.prepare("INSERT INTO session_inbox (id, session_id, type, payload, delivery, enqueued_seq, time_created) VALUES (?, ?, 'synthetic', ?, 'queue', 1, ?)")
        .run(inboxRowId, target, JSON.stringify({ text: "pending queue input" }), Date.now());
    } finally {
      db.close();
    }
    try {
      const inbox = await sandbox.rest("GET", `/api/session/${target}/inbox`);
      assert.equal(inbox.status, 200);
      const rows = (inbox.value as { data?: unknown[] }).data ?? inbox.value;
      assert.ok(Array.isArray(rows) && rows.length > 0, "native GET confirms the pending inbox is non-empty");
      await assert.rejects(() => service.deleteSession(target), (error: unknown) => {
        assert.ok(error instanceof DeleteRefusedError, `expected DeleteRefusedError, got ${String(error)}`);
        assert.match((error as DeleteRefusedError).message, /待处理输入/);
        return true;
      });
      const inventory = await service.refresh();
      assert.ok(inventory.sessions.some(row => row.session_id === target), "session with pending work survives");
      const backups = await service.listBackups();
      assert.equal(backups.find(item => item.session_ids.includes(target))?.status, "partial");
    } finally {
      const cleanup = new DatabaseSync(databaseFile(sandbox.env), { timeout: 10000 });
      try {
        cleanup.prepare("DELETE FROM session_inbox WHERE id = ?").run(inboxRowId);
      } finally {
        cleanup.close();
      }
    }
  });

  test("a failing DELETE request reports partial with the backup retained and never auto re-deletes", async () => {
    const target = await seedSession("ses_be_DF_target", "backend-DF", DIR_A, null, ["DF turn 1"]);
    const serviceUrl = sandbox.serviceUrl();
    const originalFetch = globalThis.fetch;
    let deletes = 0;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = fetchUrl(input);
        const method = init?.method ?? "GET";
        if (method === "DELETE" && url.startsWith(serviceUrl) && url.includes(`/api/session/${target}`)) {
          deletes += 1;
          return new Response(JSON.stringify({ message: "injected delete outage" }), { status: 500 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;
      const result = await service.deleteSession(target);
      assert.equal(result.status, "partial");
      assert.match(result.message, /无法确认/);
      assert.deepEqual(result.deleted_session_ids, []);
      assert.equal(deletes, 1, "exactly one official DELETE attempt; no fallback re-delete");
      assert.ok(result.backup_id, "partial outcome carries the backup id");
    } finally {
      globalThis.fetch = originalFetch;
    }
    const inventory = await service.refresh();
    assert.ok(inventory.sessions.some(row => row.session_id === target), "the outage never confirmed any deletion");
    const backups = await service.listBackups();
    assert.equal(backups.find(item => item.session_ids.includes(target))?.status, "partial");
  });
});

describe("complete backup/restore fidelity", () => {
  test("a >100-message session verifies, deletes and restores completely (paged isolation readback)", async () => {
    // seeded.big carries 120 messages: more than the old unpaged limit=100
    // isolation readback and more than one 50/page message page. The previous
    // single-request readback could never verify this session; the paged
    // roundtrip must.
    const result = await service.deleteSession(seeded.big);
    assert.equal(result.status, "deleted", result.message);
    const backups = await service.listBackups();
    const backup = backups.find(item => item.session_ids.includes(seeded.big))!;
    assert.ok(backup, "backup listed for the long session");
    const restored = await service.restoreBackup(backup.backup_id);
    assert.equal(restored.status, "restored", restored.message);
    const entries: LogEntry[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await service.readHistory(seeded.big, cursor);
      entries.push(...page.entries);
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    assert.equal(entries.length, 120, `expected all 120 messages back, got ${entries.length}`);
    assert.equal(entries[0]!.text, "big message 0");
    assert.equal(entries[119]!.text, "big message 119");
  });

  test("the rich tool-content session deletes and restores with full part fidelity", async () => {
    const before = await service.readHistory(seeded.parts);
    assert.deepEqual(before.entries.map(entry => entry.role), ["user", "thinking", "assistant", "tool", "system"]);
    const result = await service.deleteSession(seeded.parts);
    assert.equal(result.status, "deleted", result.message);
    const backups = await service.listBackups();
    const backup = backups.find(item => item.session_ids.includes(seeded.parts))!;
    assert.ok(backup, "backup listed for the parts session");
    const restored = await service.restoreBackup(backup.backup_id);
    assert.equal(restored.status, "restored", restored.message);
    const after = await service.readHistory(seeded.parts);
    assert.deepEqual(after.entries.map(entry => entry.role), before.entries.map(entry => entry.role));
    assert.deepEqual(after.entries.map(entry => entry.text), before.entries.map(entry => entry.text),
      "every part's text (incl. tool input/output) identical after the roundtrip");
  });

  test("restore verification catches a tampered backup member (same ID, diverging readback) as partial", async () => {
    const target = await seedSession("ses_be_TP_target", "backend-TP", DIR_A, null, ["TP original body", "TP second body"]);
    const deleted = await service.deleteSession(target);
    assert.equal(deleted.status, "deleted", deleted.message);
    const backupDir = join(sandbox.storagePath, "backups", deleted.backup_id);
    const manifest = JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8")) as { members: Array<{ file: string }> };
    const memberPath = join(backupDir, manifest.members[0]!.file);
    const envelope = JSON.parse(readFileSync(memberPath, "utf8")) as { messages: Array<Record<string, unknown>> };
    // Probe-verified divergence (zcode-probe-import-shape.cjs): the official
    // import DROPS unknown message fields, so the file now claims strictly
    // more than what a restore can read back — same ids, same text, diverging
    // structure. The semantic readback comparison must report it as partial.
    envelope.messages[0]!.tpExtraMarker = "claim-the-import-will-drop";
    writeFileSync(memberPath, JSON.stringify(envelope, null, 2), "utf8");
    const result = await service.restoreBackup(deleted.backup_id);
    assert.equal(result.status, "partial");
    assert.match(result.message, /恢复失败/);
    assert.deepEqual(result.restored_session_ids, []);
  });
});
