import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCatalogForest, buildCatalogGroups, isCatalogRowArchived, archivedRowIds,
  mergeCatalogEntries, isOpenCodeSessionId, sessionArgv, catalogPagingIdle,
  catalogPagingOnSelect, catalogPagingLoadMoreStarted, catalogPagingPageLoaded,
  catalogPagingFailed, catalogCanLoadMore, type CatalogRow,
} from "../src/shared/sessionCatalog";
import type { LogEntry } from "../src/shared/types";

function row(overrides: Partial<CatalogRow> & { session_id: string }): CatalogRow {
  return { workspace: "C:\\synthetic", title: overrides.session_id, kind: "root", archived: false, workspace_exists: true, parent_session_id: null, ...overrides };
}

test("forest nests children by parent id to any depth and keeps orphans reachable", () => {
  const rows = [
    row({ session_id: "ses_root_0001", updated_at: "2026-11-02T02:00:00Z" }),
    row({ session_id: "ses_child_0002", parent_session_id: "ses_root_0001", kind: "subagent" }),
    row({ session_id: "ses_grand_0003", parent_session_id: "ses_child_0002", kind: "subagent" }),
    row({ session_id: "ses_orphan_0004", parent_session_id: "ses_missing", kind: "subagent" }),
  ];
  const forest = buildCatalogForest(rows);
  assert.equal(forest.trees.length, 2);
  const root = forest.treeById.get("ses_root_0001")!;
  assert.equal(root.children.length, 1);
  assert.deepEqual(root.descendants.map(r => r.session_id), ["ses_child_0002", "ses_grand_0003"]);
  assert.equal(forest.treeById.get("ses_orphan_0004")!.orphan, true);
});

test("archive state comes from the backend DTO (row.archived), not a UI store", () => {
  const rows = [
    row({ session_id: "ses_root_0001" }),
    row({ session_id: "ses_child_0002", parent_session_id: "ses_root_0001", kind: "subagent" }),
    row({ session_id: "ses_independent_0003" }),
  ];
  rows[0].archived = true;
  const ids = archivedRowIds(rows);
  assert.deepEqual(ids, ["ses_root_0001"]);
  const byId = new Map(rows.map(r => [r.session_id, r]));
  // Effective archive: an archived ancestor covers its whole family.
  assert.ok(isCatalogRowArchived(rows[1], byId, new Set(ids)));
  assert.equal(isCatalogRowArchived(rows[2], byId, new Set(ids)), false);
});

test("archive inheritance preserves independently archived grandchildren and search reaches them", () => {
  const rows = [
    row({ session_id: "ses_root_0001" }),
    row({ session_id: "ses_child_0002", parent_session_id: "ses_root_0001", kind: "subagent" }),
    row({ session_id: "ses_grandneedle_0003", parent_session_id: "ses_child_0002", kind: "subagent" }),
  ];
  rows[0].archived = true;
  rows[2].archived = true;
  const forest = buildCatalogForest(rows);
  assert.equal(forest.trees[0].descendants.length, 2);
  assert.equal(buildCatalogGroups(forest, archivedRowIds(rows), "all", "needle").length, 1);
  const restoredParent = buildCatalogGroups(forest, ["ses_child_0002", "ses_grandneedle_0003"], "archived", "");
  assert.ok(restoredParent[0].trees[0].contextOnly);
  assert.ok(restoredParent[0].trees[0].children[0].archived);
  assert.equal(buildCatalogGroups(forest, archivedRowIds(rows), "active", "").length, 0);
});

test("OpenCode session ids are ses-prefixed, not UUIDs; argv resumes one exact session in its directory", () => {
  assert.ok(isOpenCodeSessionId("ses_e64d402ecffeKOwM16Ewfp7yo5"));
  assert.ok(isOpenCodeSessionId("ses_probe_A_0001"));
  assert.ok(!isOpenCodeSessionId("11111111-1111-4111-8111-111111111111"));
  assert.ok(!isOpenCodeSessionId("--help"));
  assert.ok(!isOpenCodeSessionId("se"));
  assert.deepEqual(sessionArgv("ses_e64d402ecffeKOwM16Ewfp7yo5", "C:\\synthetic\\demo-a"), ["C:\\synthetic\\demo-a", "--session", "ses_e64d402ecffeKOwM16Ewfp7yo5"]);
  assert.deepEqual(sessionArgv("ses_probe_A_0001", "C:\\synthetic\\demo-a", ["--server", "http://127.0.0.1:1"]), ["--server", "http://127.0.0.1:1", "C:\\synthetic\\demo-a", "--session", "ses_probe_A_0001"]);
  assert.throws(() => sessionArgv("resume", "C:\\synthetic"), /Not a valid OpenCode session ID/);
  assert.throws(() => sessionArgv("ses_probe_A_0001", "  "), /original working directory/);
});

test("preview merges beyond 2000 entries with no cap and folds later revisions", () => {
  const entry = (id: string, ts: number, text = `line ${id}`): LogEntry => ({ id: `history:${id}`, ts, role: "assistant", text });
  const entries = Array.from({ length: 2501 }, (_, index) => entry(String(index), index));
  assert.equal(mergeCatalogEntries([], entries).length, 2501);
  const revised = entry("x", 5, "new");
  assert.equal(mergeCatalogEntries([...entries, { ...revised, text: "old" }], [revised]).find(e => e.itemId === undefined && e.id === "history:x")!.text, "new");
  // A live follow that re-reads the first page keeps every already loaded page.
  const followed = mergeCatalogEntries(entries, [entry("0", 0, "revised line 0"), entry("2501", 2501)]);
  assert.equal(followed.length, 2502);
  assert.equal(followed.find(e => e.id === "history:0")!.text, "revised line 0");
});

test("paging state machine resets per selection and keeps loaded pages on failure", () => {
  let paging = catalogPagingIdle();
  assert.equal(catalogCanLoadMore(paging), false);
  paging = catalogPagingOnSelect();
  assert.equal(paging.opening, true);
  paging = catalogPagingPageLoaded(paging, "ses_a", [entry0()], "cursor-2", null);
  assert.equal(catalogCanLoadMore(paging), true);
  paging = catalogPagingLoadMoreStarted(paging);
  assert.equal(catalogCanLoadMore(paging), false);
  paging = catalogPagingFailed(paging, "synthetic read failure");
  assert.equal(paging.error, "synthetic read failure");
  assert.equal(paging.preview!.entries.length, 1, "loaded pages survive a failed load-more");
  assert.equal(catalogCanLoadMore(paging), true, "retry stays possible");
  // A late answer for another session is ignored.
  assert.deepEqual(catalogPagingPageLoaded(paging, "ses_other", [entry0()], null, null), paging);
  function entry0() { return { id: "history:m0", ts: 0, role: "user" as const, text: "q" }; }
});
