/**
 * Legacy V1-only record integration tests (backend-exclusive, isolated).
 *
 * Reproduces the confirmed real-store shape synthetically exactly the way the
 * legacy probe did (work/opencode-legacy-probe/sb1-insert-legacy.cjs): a
 * v1 `session`/`message`/`part` triple written by a "1.19.5" writer AFTER a
 * completed `migration.v1-v2` kv flag, which the running 2.2.5 service can
 * never see. Then proves the whole contract flow: candidate discovery,
 * readonly preview, local archive, verified-shape recovery through official
 * import with dual explicit locations, tombstoning after the recovered
 * session's delete, and refusal of unsupported conversion shapes.
 *
 * No real database, auth or user data is touched; the v1 rows are injected
 * into the test sandbox's own database only.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CatalogService, DeleteRefusedError } from "../src/backend/catalogService";
import { DIR_A, ENGINE, SANDBOX_ROOT, freshSandbox, unwrap, type Sandbox } from "./backend/sandbox";
import { databaseFile } from "../src/backend/paths";

let sandbox: Sandbox;
let service: CatalogService;
let v2Baseline: string;

const LEGACY = "ses_be_legacy_0001";
const UNSUPPORTED = "ses_be_legacy_0002";
const PRE_MIGRATION = "ses_be_legacy_0003";
const FILEPART = "ses_be_legacy_0004";
const CORRUPT = "ses_be_legacy_0005";

interface Seed {
  id: string;
  title: string;
  created: number;
  assistantWithTextPart: boolean;
  /** Add an unsupported file part to the user message (raw-preview path). */
  userFilePart?: boolean;
  /** Store invalid JSON as one user part's data (corrupt-raw path). */
  corruptUserPart?: boolean;
}

/** Inject the v1 triple + completed migration flag into the sandbox DB. */
function injectV1(seeds: readonly Seed[], flagTime: number): void {
  const db = new DatabaseSync(databaseFile(sandbox.env), { timeout: 10000 });
  try {
    db.exec("BEGIN");
    db.exec(`CREATE TABLE IF NOT EXISTS \`session\` (
      \`id\` text PRIMARY KEY, \`project_id\` text NOT NULL, \`workspace_id\` text, \`parent_id\` text,
      \`slug\` text NOT NULL, \`directory\` text NOT NULL, \`path\` text, \`title\` text NOT NULL,
      \`version\` text NOT NULL, \`share_url\` text, \`summary_additions\` integer, \`summary_deletions\` integer,
      \`summary_files\` integer, \`summary_diffs\` text, \`metadata\` text, \`cost\` real DEFAULT 0 NOT NULL,
      \`tokens_input\` integer DEFAULT 0 NOT NULL, \`tokens_output\` integer DEFAULT 0 NOT NULL,
      \`tokens_reasoning\` integer DEFAULT 0 NOT NULL, \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
      \`tokens_cache_write\` integer DEFAULT 0 NOT NULL, \`revert\` text, \`permission\` text,
      \`agent\` text, \`model\` text, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL,
      \`time_compacting\` integer, \`time_archived\` integer)`);
    db.exec(`CREATE TABLE IF NOT EXISTS \`message\` (
      \`id\` text PRIMARY KEY, \`session_id\` text NOT NULL, \`time_created\` integer NOT NULL,
      \`time_updated\` integer NOT NULL, \`data\` text NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS \`part\` (
      \`id\` text PRIMARY KEY, \`message_id\` text NOT NULL, \`session_id\` text NOT NULL,
      \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, \`data\` text NOT NULL)`);
    db.prepare(`INSERT INTO kv (key, value, time_created, time_updated) VALUES ('migration.v1-v2', ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, time_updated=excluded.time_updated`)
      .run(JSON.stringify({ phase: "completed" }), flagTime, flagTime);
    for (const seed of seeds) {
      db.prepare(`INSERT INTO \`session\` (id, project_id, workspace_id, parent_id, slug, directory, path, title, version,
          share_url, summary_additions, summary_deletions, summary_files, summary_diffs, metadata, cost,
          tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          revert, permission, agent, model, time_created, time_updated, time_compacting, time_archived)
        VALUES (?, 'global', NULL, NULL, 'be-legacy-slug', ?, 'projects/demo-a', ?, '1.19.5',
          NULL, 0, 0, 0, NULL, NULL, 0.0125, 11, 22, 33, 44, 55, NULL, NULL, 'build', NULL, ?, ?, NULL, NULL)`)
        .run(seed.id, DIR_A, seed.title, seed.created, seed.created + 11000);
      const userTime = seed.created + 100;
      db.prepare("INSERT INTO `message` (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
        .run(`msg_${seed.id}_u`, seed.id, userTime, userTime + 50, JSON.stringify({
          role: "user",
          time: { created: userTime },
          agent: "build",
        }));
      db.prepare("INSERT INTO `part` (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
        .run(`prt_${seed.id}_p`, `msg_${seed.id}_u`, seed.id, userTime + 10, userTime + 10, JSON.stringify({
          type: "text",
          text: `legacy user body ${seed.id}`,
        }));
      if (seed.userFilePart) {
        // Shape outside the verified conversion set: a file part on the user
        // message. It must stay FULLY readable as raw JSON, never silently
        // dropped or reduced to a text sentinel (revision item C).
        db.prepare("INSERT INTO `part` (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
          .run(`prt_${seed.id}_fp`, `msg_${seed.id}_u`, seed.id, userTime + 20, userTime + 20, JSON.stringify({
            type: "file",
            url: "file:///x/legacy-evidence.png",
            mimeType: "image/png",
            name: "legacy-evidence.png",
          }));
      }
      if (seed.corruptUserPart) {
        // Corrupt stored JSON: the original text must survive verbatim into
        // the preview and refuse any conversion (revision item C).
        db.prepare("INSERT INTO `part` (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
          .run(`prt_${seed.id}_cp`, `msg_${seed.id}_u`, seed.id, userTime + 30, userTime + 30, "{ this is not valid json");
      }
      const assistantTime = seed.created + 200;
      db.prepare("INSERT INTO `message` (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
        .run(`msg_${seed.id}_a`, seed.id, assistantTime, assistantTime + 10500, JSON.stringify({
          parentID: `msg_${seed.id}_u`,
          role: "assistant",
          mode: "primary",
          agent: "build",
          cost: 0.0125,
          tokens: { input: 11, output: 22, reasoning: 33, cache: { read: 44, write: 55 } },
          modelID: "be-model",
          providerID: "be-provider",
          time: { created: assistantTime, completed: assistantTime + 10500 },
          finish: "stop",
        }));
      if (seed.assistantWithTextPart) {
        // Shape NOT verified losslessly by the probe: refuses conversion.
        db.prepare("INSERT INTO `part` (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
          .run(`prt_${seed.id}_ap`, `msg_${seed.id}_a`, seed.id, assistantTime + 10, assistantTime + 10, JSON.stringify({
            type: "text",
            text: `legacy assistant body ${seed.id}`,
          }));
      }
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

before(async () => {
  sandbox = await freshSandbox("legacy");
  service = new CatalogService({ storagePath: sandbox.storagePath, enginePath: ENGINE, env: sandbox.env });
  // One normal v2 session so the inventory is not legacy-only.
  const created = await sandbox.rest("POST", "/api/session", { title: "legacy-v2-baseline", location: { directory: DIR_A } });
  assert.equal(created.status, 200);
  v2Baseline = unwrap<{ id: string }>(created.value).id;
  const flagTime = Date.now() - 200000;
  injectV1([
    { id: LEGACY, title: "BE legacy verified shape", created: Date.now() - 100000, assistantWithTextPart: false },
    { id: UNSUPPORTED, title: "BE legacy unsupported shape", created: Date.now() - 90000, assistantWithTextPart: true },
    { id: PRE_MIGRATION, title: "BE legacy pre-migration remnant", created: flagTime - 500000, assistantWithTextPart: false },
    { id: FILEPART, title: "BE legacy user file part", created: Date.now() - 80000, assistantWithTextPart: false, userFilePart: true },
    { id: CORRUPT, title: "BE legacy corrupt part json", created: Date.now() - 70000, assistantWithTextPart: false, corruptUserPart: true },
  ], flagTime);
});

after(async () => {
  await service?.dispose();
  await sandbox?.teardown();
});

describe("legacy discovery and preview", () => {
  test("refresh surfaces exactly the post-migration v1-only candidates, marked and never as v2", async () => {
    const inventory = await service.refresh();
    const legacyRow = inventory.sessions.find(row => row.session_id === LEGACY);
    assert.ok(legacyRow, "post-migration v1-only row discovered");
    assert.equal(legacyRow!.schema, "legacy-v1");
    assert.equal(legacyRow!.archive_mode, "local");
    assert.equal(legacyRow!.legacy?.writer_version, "1.19.5");
    assert.equal(legacyRow!.legacy?.recovery_supported, true);
    assert.equal(legacyRow!.workspace, DIR_A);
    const unsupportedRow = inventory.sessions.find(row => row.session_id === UNSUPPORTED);
    assert.ok(unsupportedRow, "unsupported-shape row still discovered");
    assert.equal(unsupportedRow!.legacy?.recovery_supported, false);
    assert.ok(unsupportedRow!.legacy?.warning !== undefined, "unsupported shape explains itself");
    assert.equal(inventory.sessions.some(row => row.session_id === PRE_MIGRATION), false,
      "pre-migration remnant is not a candidate (supervisor rule)");
    assert.equal(inventory.sessions.some(row => row.session_id === LEGACY && row.schema === undefined), false);
    assert.ok(inventory.warnings.some(warning => warning.includes("旧版记录")),
      "inventory states the legacy-scope limitation");
  });

  test("readHistory previews the legacy transcript readonly with full fidelity", async () => {
    const page = await service.readHistory(LEGACY);
    assert.equal(page.next_cursor, null);
    assert.deepEqual(page.entries.map(entry => entry.role), ["user", "assistant"]);
    assert.equal(page.entries[0].text, `legacy user body ${LEGACY}`);
    // The verified empty-assistant shape stays visible, never dropped.
    assert.ok(page.entries[1].id.includes("assistant") || page.entries[1].role === "assistant");
  });
});

describe("legacy local archive", () => {
  test("setArchived on a legacy row is a private local flag, verified after write", async () => {
    await service.setArchived(LEGACY, true);
    let inventory = await service.refresh();
    assert.equal(inventory.sessions.find(row => row.session_id === LEGACY)?.archived, true);
    await service.setArchived(LEGACY, false);
    inventory = await service.refresh();
    assert.equal(inventory.sessions.find(row => row.session_id === LEGACY)?.archived, false);
  });
});

describe("legacy recovery", () => {
  test("recoverLegacySession imports through the official API with the original directory and reads back", async () => {
    const result = await service.recoverLegacySession(LEGACY);
    assert.equal(result.status, "restored", result.message);
    assert.deepEqual(result.restored_session_ids, [LEGACY]);
    // The v2 API now owns the row: same id, original directory, messages readable.
    const read = await sandbox.rest("GET", `/api/session/${LEGACY}`);
    assert.equal(read.status, 200);
    const info = (read.value as { data?: { location?: { directory?: string } } }).data ?? read.value as { location?: { directory?: string } };
    assert.equal(info.location?.directory, DIR_A, "original directory preserved (dual explicit location import)");
    const messages = await sandbox.rest("GET", `/api/session/${LEGACY}/message?order=asc&limit=100`);
    const data = (messages.value as { data?: Array<{ type?: string; text?: string }> }).data ?? [];
    assert.equal(data.length, 2);
    assert.equal(data[0].type, "user");
    assert.equal(data[0].text, `legacy user body ${LEGACY}`);
    assert.equal(data[1].type, "assistant");
    // The row now presents as a normal v2 row (schema marker gone).
    const inventory = await service.refresh();
    const row = inventory.sessions.find(item => item.session_id === LEGACY);
    assert.ok(row, "recovered row in inventory");
    assert.notEqual(row!.schema, "legacy-v1");
  });

  test("recovering an already-recovered id is an explicit no-op, never an overwrite", async () => {
    await assert.rejects(() => service.recoverLegacySession(LEGACY), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match((error as Error).message, /已被导入|没有可导入的旧版记录/);
      return true;
    });
    const read = await sandbox.rest("GET", `/api/session/${LEGACY}`);
    assert.equal(read.status, 200, "recovered row untouched by the repeat attempt");
    const messages = await sandbox.rest("GET", `/api/session/${LEGACY}/message?order=asc&limit=100`);
    const data = (messages.value as { data?: unknown[] }).data ?? [];
    assert.equal(data.length, 2, "no duplicate import happened (server 409 semantics, client-side guard)");
  });

  test("unsupported shapes refuse conversion with a useful explanation but stay previewable", async () => {
    await assert.rejects(() => service.recoverLegacySession(UNSUPPORTED), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match((error as Error).message, /未验证的转换形状/);
      return true;
    });
    const page = await service.readHistory(UNSUPPORTED);
    assert.ok(page.entries.length >= 2, "unsupported row remains fully previewable");
  });

  test("deleting the recovered v2 session tombstones the v1 remnant so it cannot resurface", async () => {
    const result = await service.deleteSession(LEGACY);
    assert.equal(result.status, "deleted", result.message);
    let inventory = await service.refresh();
    assert.equal(inventory.sessions.some(row => row.session_id === LEGACY), false,
      "deleted recovered row must not reappear as a legacy candidate (tombstone)");
    // Restoring the backup brings the v2 row back; no duplicate legacy row appears.
    const restored = await service.restoreBackup(result.backup_id);
    assert.equal(restored.status, "restored", restored.message);
    inventory = await service.refresh();
    const rows = inventory.sessions.filter(row => row.session_id === LEGACY);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]!.schema, "legacy-v1");
  });

  test("deleting a legacy row that was never recovered refuses with the recovery route", async () => {
    await assert.rejects(() => service.deleteSession(UNSUPPORTED), (error: unknown) => {
      assert.ok(error instanceof DeleteRefusedError);
      assert.match((error as DeleteRefusedError).message, /先执行“将旧版记录导入新版”/);
      return true;
    });
  });
});

describe("legacy unsupported-shape raw preview (revision item C)", () => {
  test("an unknown user part stays fully readable as raw JSON, never a text sentinel", async () => {
    const page = await service.readHistory(FILEPART);
    const raw = page.entries.map(entry => entry.text).join("\n");
    assert.ok(raw.includes("legacy-evidence.png"), "the raw file part's real content is preserved verbatim");
    assert.ok(raw.includes("file"), "the file part type is visible in the raw record");
    assert.ok(raw.includes(`legacy user body ${FILEPART}`), "the known user text is preserved inside the raw record");
    assert.ok(page.entries.length >= 2, "the whole transcript stays visible");
    const inventory = await service.refresh();
    const row = inventory.sessions.find(item => item.session_id === FILEPART)!;
    assert.equal(row.legacy?.recovery_supported, false, "unknown part shape is not conversion-supported");
    await assert.rejects(() => service.recoverLegacySession(FILEPART), (error: unknown) => {
      assert.match((error as Error).message, /未验证的转换形状/);
      return true;
    });
  });

  test("a corrupt stored part shows its original raw text and refuses conversion", async () => {
    const page = await service.readHistory(CORRUPT);
    const raw = page.entries.map(entry => entry.text).join("\n");
    assert.ok(raw.includes("{ this is not valid json"), "the original corrupt text is shown verbatim, never masked as empty");
    await assert.rejects(() => service.recoverLegacySession(CORRUPT), (error: unknown) => {
      assert.match((error as Error).message, /未验证的转换形状/);
      return true;
    });
  });
});

describe("corrupt local legacy state (revision item C)", () => {
  test("a damaged state file suspends legacy handling with an explicit warning, keeps v2 rows and is never overwritten", async () => {
    // Runs last: the recovery tests above have legitimately written the state
    // file (local archive flag + delete tombstone).
    const statePath = join(sandbox.storagePath, "legacy-state.json");
    const original = readFileSync(statePath, "utf8");
    const damaged = "{ this is not valid json";
    try {
      writeFileSync(statePath, damaged, "utf8");
      const inventory = await service.refresh();
      assert.ok(inventory.sessions.some(row => row.session_id === v2Baseline), "v2 rows stay fully readable");
      assert.ok(!inventory.sessions.some(row => row.schema === "legacy-v1"),
        "legacy rows are suspended, not silently listed as if the state were empty");
      assert.ok(inventory.warnings.some(warning => warning.includes("旧版（V1）记录处理已暂停")),
        "the suspension carries an explicit warning (no silent fake completeness)");
      assert.equal(readFileSync(statePath, "utf8"), damaged, "the damaged state is never overwritten by a read path");
      // A legacy write attempt fails loudly instead of resetting the state.
      await assert.rejects(() => service.setArchived(FILEPART, true));
      assert.equal(readFileSync(statePath, "utf8"), damaged, "still untouched after the refused write");
    } finally {
      writeFileSync(statePath, original, "utf8");
    }
    // With the real state restored, legacy candidates are back.
    const inventory = await service.refresh();
    assert.ok(inventory.sessions.some(row => row.session_id === FILEPART), "legacy rows return after the state file is restored");
  });
});
