/**
 * Pure normalization unit tests (backend-exclusive, no server required).
 * Fixture shapes come from the installed 2.2.5 probe evidence
 * (work/opencode-probe/import-fixture-parts.json vs export-parts.json).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { toCatalogRow, toLogEntries } from "../src/backend/normalize";
import type { SessionInfo } from "../src/backend/opencodeApi";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const FIXTURE = JSON.parse(readFileSync(join(__dirname, "..", "..", "test", "fixtures", "backend", "parts-session.json"), "utf8"));

test("Session.Info maps to a snake_case catalog row with archive state and directory", () => {
  const info: SessionInfo = {
    id: "ses_row_0001",
    title: "示例会话",
    parentID: null,
    time: { created: 1793605087922, updated: 1793605087978, archived: 1793605087978, busy: 100, idle: 200 },
    location: { directory: process.cwd() },
  };
  const row = toCatalogRow(info);
  assert.equal(row.session_id, "ses_row_0001");
  assert.equal(row.kind, "root");
  assert.equal(row.archived, true);
  assert.equal(row.parent_session_id, null);
  assert.equal(row.workspace, process.cwd());
  assert.equal(row.workspace_exists, true);
  assert.equal(row.created_at, new Date(1793605087922).toISOString());
  assert.equal(row.last_busy_at, new Date(100).toISOString());
  assert.equal(row.activity_source, undefined);
});

test("a child session row carries its parent id and kind", () => {
  const row = toCatalogRow({ id: "ses_row_0002", parentID: "ses_row_0001", time: { created: 1 }, location: { directory: process.cwd() } });
  assert.equal(row.kind, "child");
  assert.equal(row.parent_session_id, "ses_row_0001");
  assert.equal(row.title, "<未命名会话>");
});

test("messages normalize in order with role/text/tool fidelity and no truncation", () => {
  const page = toLogEntries(FIXTURE.messages);
  const roles = page.entries.map(entry => entry.role);
  assert.deepEqual(roles, ["user", "thinking", "assistant", "tool", "system"]);
  assert.equal(page.entries[0].text, "fixture user question");
  assert.equal(page.entries[0].ts, 1793605202312);
  assert.equal(page.entries[1].text, "fixture reasoning block");
  assert.equal(page.entries[2].text, "fixture assistant answer");
  const tool = page.entries[3];
  assert.match(tool.text, /read（completed）/);
  assert.match(tool.text, /\/x\/y\.txt/);
  assert.match(tool.text, /file content here/);
  assert.equal(page.entries[4].text, "fixture compaction summary");
  assert.equal(page.unknown, 0);
  // Part-qualified ids stay stable for merge dedupe across pages and re-reads.
  assert.deepEqual(page.entries.map(entry => entry.id), [
    "msg_be_user_0001",
    "msg_be_asst_0001#0",
    "msg_be_asst_0001#1",
    "msg_be_asst_0001#2",
    "msg_be_comp_0001",
  ]);
});

test("unknown message and part shapes are kept as raw system entries and counted, never dropped", () => {
  const page = toLogEntries([
    { id: "msg_x_1", type: "mystery", time: { created: 5 }, payload: { a: 1 } },
    { id: "msg_x_2", type: "assistant", time: { created: 6 }, content: [{ type: "quantum", blob: true }] },
    { id: 42 },
  ]);
  assert.equal(page.unknown, 3);
  assert.equal(page.entries.length, 2);
  assert.equal(page.entries[0].role, "system");
  assert.match(page.entries[0].text, /mystery/);
  assert.match(page.entries[0].text, /"a": 1/);
  assert.match(page.entries[1].text, /quantum/);
});

test("synthetic messages map to user role", () => {
  const page = toLogEntries([{ id: "msg_s_1", type: "synthetic", time: { created: 1 }, text: "hello" }]);
  assert.equal(page.entries[0].role, "user");
  assert.equal(page.entries[0].text, "hello");
});
