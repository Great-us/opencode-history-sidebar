import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeCatalogCounts,
  followOffersTail,
  followWindowComplete,
  isLegacyRow,
  rebuildLoadedWindow,
  type CatalogRow,
} from "../src/shared/sessionCatalog";
import type { LogEntry } from "../src/shared/types";

function entry(id: string, ts: number, text = id): LogEntry {
  return { id, ts, role: "user", text };
}

test("follow window: the walk stops when the loaded window is covered or the chain ends", () => {
  // Chain ended: nothing more to read.
  assert.equal(followWindowComplete(120, 120, null), true);
  // Window covered exactly.
  assert.equal(followWindowComplete(120, 100, "cursor-3"), true);
  // Window not yet covered and pages remain: keep walking.
  assert.equal(followWindowComplete(80, 100, "cursor-2"), false);
  // Nothing loaded yet: the first page always satisfies the window.
  assert.equal(followWindowComplete(0, 0, "cursor-1"), true);
});

test("follow window: the tail offer appears only when the row moved beyond the loaded range", () => {
  assert.equal(followOffersTail("cursor-2", true), true, "row advanced with pages remaining -> offer the tail");
  assert.equal(followOffersTail(null, true), false, "everything loaded -> new content is already displayed");
  assert.equal(followOffersTail("cursor-2", false), false, "row did not move -> no offer, no noise");
});

test("rebuildLoadedWindow replaces stale content and drops deletions inside the loaded range", () => {
  const page1 = [entry("m1", 1), entry("m2", 2, "m2 original")];
  const page2 = [entry("m3", 3)];
  // Re-read after m2 was edited and m3 was deleted server-side.
  const fresh1 = [entry("m1", 1), entry("m2", 2, "m2 updated")];
  const rebuilt = rebuildLoadedWindow([fresh1]);
  assert.deepEqual(rebuilt.map(item => item.id), ["m1", "m2"], "the deleted m3 does not linger");
  assert.equal(rebuilt.find(item => item.id === "m2")?.text, "m2 updated", "the fresh revision wins over stale text");
  // A re-sent id across re-read pages dedupes to the fresh revision, ordered by time.
  const overlap = rebuildLoadedWindow([page1, page2, [entry("m2", 2, "m2 newest"), entry("m4", 4)]]);
  assert.deepEqual(overlap.map(item => item.id), ["m1", "m2", "m3", "m4"]);
  assert.equal(overlap.find(item => item.id === "m2")?.text, "m2 newest");
});

function row(id: string, extra: Partial<CatalogRow> = {}): CatalogRow {
  return { session_id: id, title: id, workspace: "C:/w", kind: "root", archived: false, workspace_exists: true, parent_session_id: null, ...extra };
}

test("legacy rows are identified separately and never summed into the normal V2 count", () => {
  const v2a = row("ses_v2_a");
  const v2b = row("ses_v2_b");
  const legacy = row("ses_legacy_one", { schema: "legacy-v1", archive_mode: "local", legacy: { writer_version: "1.19.5", recovery_supported: true } });
  assert.equal(isLegacyRow(v2a), false);
  assert.equal(isLegacyRow(legacy), true);
  // 58 V2 + 1 legacy is described as two populations, never "59 sessions".
  assert.equal(describeCatalogCounts([v2a, v2b, legacy]), "2 条会话 · 1 条旧版记录");
  assert.equal(describeCatalogCounts([v2a, v2b]), "2 条会话");
  assert.equal(legacy.archive_mode, "local", "legacy archive is a local mark on the row");
});
