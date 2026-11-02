/**
 * Minimal readonly V1 legacy reader + private local decisions
 * (backend-internal; contract "Confirmed legacy record integration").
 *
 * Scope is deliberately tiny — no dual-version framework, no old JSON
 * crawler, no v1 writes ever. It exists because the legacy probe and the
 * supervisor confirmed one real V1-only record written by opencode 1.19.5
 * AFTER the v1→v2 migration completed; the 2.2.5 API can never see such rows
 * (service + source evidence, work/opencode-legacy-report.md §1/§3.1).
 *
 * Discovery rule (legacy report §5, supervisor-adopted): a row is a legacy
 * candidate iff the v1 `session` table has it, `session_v2` does not, its
 * time_created is later than the kv `migration.v1-v2` flag time, and the
 * extension's local tombstones do not list it (deleting a recovered session
 * leaves the v1 rows fully behind — §3.3 — so without the tombstone the row
 * would resurrect as a candidate).
 *
 * Reads open the shared database with node:sqlite `readOnly:true` only.
 * Any reader failure surfaces as an explicit warning, never as a silently
 * complete list. All writes still go exclusively through official APIs;
 * the only things this module persists are the extension's own local
 * archive flags, tombstones and raw legacy backups.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { databaseFile } from "./paths";
import { toCatalogRow, type CatalogRowLive } from "./normalize";
import type { SessionInfo } from "./opencodeApi";

/** Capability probe result for node:sqlite in the current runtime. */
type SqliteModule = { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase };
interface SqliteDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  exec(sql: string): void;
  close(): void;
}

let sqliteModule: SqliteModule | null | undefined;

function loadSqlite(): SqliteModule | null {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sqliteModule = require("node:sqlite") as SqliteModule;
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

/** A V1 session/message/part row as stored (ids/times from columns, payload JSON in `data`). */
interface V1SessionRow {
  id: string;
  parent_id: string | null;
  directory: string;
  title: string;
  version: string;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
}

interface V1Message {
  id: string;
  time_created: number;
  data: Record<string, unknown>;
  /** Non-null when the stored `data` JSON could not be parsed (data stays {}). */
  dataError: string | null;
  /** The original stored text of `data` when dataError is set (for raw preview). */
  rawData: string | null;
  parts: V1Part[];
}

/** One v1 part row; `error` is non-null when its stored JSON was unreadable. */
interface V1Part {
  data: Record<string, unknown>;
  error: string | null;
  raw: string | null;
}

export interface LegacyCandidate {
  row: CatalogRowLive;
  writerVersion: string;
  /** True when every message maps into the losslessly-verified conversion shape. */
  recoverySupported: boolean;
  warnings: string[];
  raw: V1SessionRow;
}

export interface LegacyReadResult {
  candidates: LegacyCandidate[];
  /** v1 ids present at all (superset of candidates) — used for tombstone decisions. */
  v1Ids: Set<string>;
  warnings: string[];
}

interface LocalState {
  archived: Record<string, number>;
  tombstones: Record<string, number>;
}

/** Private per-extension decisions for legacy rows (archive flags + tombstones). */
export class LegacyLocalState {
  private constructor(private readonly filePath: string, private state: LocalState) {}

  /**
   * Only a missing file (ENOENT) legitimately means "fresh, empty state".
   * Anything else — unreadable file (permissions/IO) or corrupt/invalid JSON —
   * throws: silently resetting would lose archived flags and delete
   * tombstones (deleted legacy rows would resurrect), and the next persist
   * would overwrite the damaged state. Callers keep the old UI and never
   * mask the failure into an empty success.
   */
  static async load(storagePath: string): Promise<LegacyLocalState> {
    const filePath = join(storagePath, "legacy-state.json");
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return new LegacyLocalState(filePath, { archived: {}, tombstones: {} });
      throw new Error(`旧版本地状态文件无法读取（${filePath}）：${error instanceof Error ? error.message : String(error)}。为避免丢失本地归档/墓碑记录，已停止处理；请检查该文件的访问权限。`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`旧版本地状态文件已损坏（${filePath}）：${error instanceof Error ? error.message : String(error)}。为避免覆盖损坏状态、丢失本地归档/墓碑记录，已停止处理；请人工检查该文件。`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`旧版本地状态文件格式无效（${filePath}）：顶层不是 JSON 对象。为避免覆盖坏状态，已停止处理。`);
    }
    const record = parsed as Record<string, unknown>;
    const sub = (key: keyof LocalState): Record<string, number> => {
      const value = record[key];
      if (value === undefined) return {}; // absent key = legitimate older format
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`旧版本地状态文件格式无效（${filePath}）：${key} 不是对象。为避免覆盖坏状态，已停止处理。`);
      }
      return value as Record<string, number>;
    };
    return new LegacyLocalState(filePath, { archived: sub("archived"), tombstones: sub("tombstones") });
  }

  isArchived(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.state.archived, id);
  }

  archivedIds(): Set<string> {
    return new Set(Object.keys(this.state.archived));
  }

  tombstoneIds(): Set<string> {
    return new Set(Object.keys(this.state.tombstones));
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    if (archived) this.state.archived[id] = Date.now();
    else delete this.state.archived[id];
    await this.persist();
  }

  isTombstoned(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.state.tombstones, id);
  }

  async tombstone(ids: readonly string[]): Promise<void> {
    const at = Date.now();
    for (const id of ids) this.state.tombstones[id] = at;
    await this.persist();
  }

  async clearArchive(id: string): Promise<void> {
    delete this.state.archived[id];
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }
}

function asRow(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Parse one stored v1 JSON column. Corrupt input is never swallowed into an
 * empty success: the original text is kept alongside an explicit error so
 * previews can show the real raw content and recovery analysis refuses.
 */
function parseV1Json(text: unknown): V1Part {
  if (typeof text !== "string") {
    return { data: {}, error: "存储值不是 JSON 文本", raw: text === undefined || text === null ? "" : String(text) };
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return { data: value as Record<string, unknown>, error: null, raw: null };
    }
    return { data: {}, error: "存储 JSON 不是对象", raw: text };
  } catch (error) {
    return { data: {}, error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`, raw: text };
  }
}

/**
 * Read legacy candidates from the shared database, readonly. Missing v1
 * tables (a fresh 2.2.5 store) simply yields none; structural or permission
 * failures yield warnings so the inventory never claims false completeness.
 */
export function readLegacyCandidates(env: NodeJS.ProcessEnv, tombstones: ReadonlySet<string>, localArchive: ReadonlySet<string>): LegacyReadResult {
  const warnings: string[] = [];
  const sqlite = loadSqlite();
  if (sqlite === null) {
    return { candidates: [], v1Ids: new Set(), warnings: ["当前扩展宿主无 node:sqlite 能力，旧版（V1）记录清单不可用；这不影响新版会话的读取。"] };
  }
  let db: SqliteDatabase;
  try {
    db = new sqlite.DatabaseSync(databaseFile(env), { readOnly: true });
  } catch (error) {
    return { candidates: [], v1Ids: new Set(), warnings: [`无法只读打开共享数据库以发现旧版记录：${error instanceof Error ? error.message : String(error)}`] };
  }
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map(row => String((row as { name?: unknown }).name));
    if (!tables.includes("session") || !tables.includes("message") || !tables.includes("part")) {
      return { candidates: [], v1Ids: new Set(), warnings: [] };
    }
    const v1Ids = new Set<string>(
      db.prepare("SELECT id FROM `session`").all().map(row => String((row as { id?: unknown }).id)),
    );
    const v2Ids = tables.includes("session_v2")
      ? new Set<string>(db.prepare("SELECT id FROM session_v2").all().map(row => String((row as { id?: unknown }).id)))
      : new Set<string>();
    let flagTime = -Infinity;
    const kvRow = tables.includes("kv") ? db.prepare("SELECT value, time_updated FROM kv WHERE key = 'migration.v1-v2'").get() : undefined;
    const kv = asRow(kvRow);
    if (kv !== null && typeof kv.time_updated === "number") flagTime = kv.time_updated;
    if (kv === null || parseV1Json(kv.value).data.phase !== "completed") {
      // No completed flag: v1 rows are either pre-migration or an unfinished
      // migration — surfacing them as "legacy" would be a guess. Stay out.
      return { candidates: [], v1Ids, warnings: [] };
    }
    const candidates: LegacyCandidate[] = [];
    const sessionStmt = db.prepare("SELECT * FROM `session` WHERE id = ?");
    const messageStmt = db.prepare("SELECT id, time_created, time_updated, data FROM `message` WHERE session_id = ? ORDER BY time_created ASC, id ASC");
    const partStmt = db.prepare("SELECT id, time_created, time_updated, data FROM `part` WHERE message_id = ? ORDER BY time_created ASC, id ASC");
    for (const id of v1Ids) {
      if (v2Ids.has(id) || tombstones.has(id)) continue;
      const rawRow = asRow(sessionStmt.get(id));
      if (rawRow === null) continue;
      const raw: V1SessionRow = {
        id: String(rawRow.id),
        parent_id: rawRow.parent_id === null || rawRow.parent_id === undefined ? null : String(rawRow.parent_id),
        directory: String(rawRow.directory ?? ""),
        title: String(rawRow.title ?? ""),
        version: String(rawRow.version ?? ""),
        time_created: Number(rawRow.time_created),
        time_updated: Number(rawRow.time_updated),
        time_archived: rawRow.time_archived === null || rawRow.time_archived === undefined ? null : Number(rawRow.time_archived),
      };
      if (!(raw.time_created > flagTime)) continue; // pre-migration remnant, not a post-migration write
      const messages = readV1Messages(messageStmt, partStmt, id);
      const analysis = analyzeForRecovery(messages);
      const info: SessionInfo = {
        id: raw.id,
        title: raw.title,
        parentID: raw.parent_id,
        time: {
          created: raw.time_created,
          updated: raw.time_updated,
          archived: raw.time_archived ?? undefined,
        },
        location: { directory: raw.directory },
      };
      const row = toCatalogRow(info);
      row.schema = "legacy-v1";
      row.archive_mode = "local";
      row.archived = localArchive.has(raw.id) || row.archived;
      row.legacy = {
        writer_version: raw.version,
        recovery_supported: analysis.supported,
        ...(analysis.warnings.length > 0 ? { warning: analysis.warnings.join("；") } : {}),
      };
      candidates.push({ row, writerVersion: raw.version, recoverySupported: analysis.supported, warnings: analysis.warnings, raw });
    }
    return { candidates, v1Ids, warnings };
  } catch (error) {
    return { candidates: [], v1Ids: new Set(), warnings: [`读取旧版（V1）记录失败：${error instanceof Error ? error.message : String(error)}`] };
  } finally {
    try {
      db.close();
    } catch {
      // close-of-readonly-handle failure needs no masking story
    }
  }
}

/** Full message payload of one v1 session (readonly), parts attached in order. */
export function readLegacyMessages(env: NodeJS.ProcessEnv, sessionId: string): { messages: V1Message[]; error: string | null } {
  const sqlite = loadSqlite();
  if (sqlite === null) return { messages: [], error: "当前扩展宿主无 node:sqlite 能力，无法读取旧版记录正文。" };
  try {
    const db = new sqlite.DatabaseSync(databaseFile(env), { readOnly: true });
    try {
      const messageStmt = db.prepare("SELECT id, time_created, time_updated, data FROM `message` WHERE session_id = ? ORDER BY time_created ASC, id ASC");
      const partStmt = db.prepare("SELECT id, time_created, time_updated, data FROM `part` WHERE message_id = ? ORDER BY time_created ASC, id ASC");
      return { messages: readV1Messages(messageStmt, partStmt, sessionId), error: null };
    } finally {
      db.close();
    }
  } catch (error) {
    return { messages: [], error: `读取旧版记录正文失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

type MessageStmt = { all(...params: unknown[]): unknown[] };

function readV1Messages(messageStmt: MessageStmt, partStmt: MessageStmt, sessionId: string): V1Message[] {
  const messages: V1Message[] = [];
  for (const rawMessage of messageStmt.all(sessionId)) {
    const record = asRow(rawMessage);
    if (record === null) continue;
    const parsedData = parseV1Json(record.data);
    const parts: V1Part[] = [];
    for (const rawPart of partStmt.all(String(record.id))) {
      const partRecord = asRow(rawPart);
      if (partRecord === null) continue;
      parts.push(parseV1Json(partRecord.data));
    }
    messages.push({
      id: String(record.id),
      time_created: Number(record.time_created),
      data: parsedData.data,
      dataError: parsedData.error,
      rawData: parsedData.raw,
      parts,
    });
  }
  return messages;
}

/**
 * Recovery-shape analysis. Only the shapes the legacy probe verified
 * losslessly through official import convert (user with text parts;
 * completed assistant with no parts). Anything else stays fully previewable
 * but refuses conversion with a concrete reason.
 */
export function analyzeForRecovery(messages: readonly V1Message[]): { supported: boolean; warnings: string[] } {
  const warnings: string[] = [];
  for (const message of messages) {
    if (message.dataError !== null) {
      warnings.push(`消息 ${message.id} 的存储 JSON 已损坏（${message.dataError}），无法验证转换`);
      continue;
    }
    const partError = message.parts.find(part => part.error !== null);
    if (partError !== undefined) {
      warnings.push(`消息 ${message.id} 含无法解析的部件（${partError.error}），无法验证转换`);
      continue;
    }
    const role = message.data.role;
    if (role === "user") {
      const bad = message.parts.find(part => part.data.type !== "text" || typeof part.data.text !== "string");
      if (bad !== undefined) warnings.push(`消息 ${message.id}（user）含未验证的部件类型 ${String(bad.data.type)}`);
      if (message.parts.length === 0) warnings.push(`消息 ${message.id}（user）没有文本部件`);
    } else if (role === "assistant") {
      const time = asRow(message.data.time);
      if (message.parts.length > 0) warnings.push(`消息 ${message.id}（assistant）带 ${message.parts.length} 个部件，超出已验证的转换形状（完成的空回复）`);
      if (time === null || time.completed === undefined) warnings.push(`消息 ${message.id}（assistant）未完成，转换可能丢失未定内容`);
    } else {
      warnings.push(`消息 ${message.id} 角色为 ${String(role)}，不在已验证的转换形状内`);
    }
  }
  return { supported: warnings.length === 0, warnings };
}

/**
 * Map v1 rows to the official v2 import payload using exactly the
 * transformSession semantics the probe verified for these shapes
 * (work/opencode-legacy-probe/sb1-import.out.json). Session.Info requires
 * cost/tokens beyond the read-side subset, hence the extended info shape.
 */
export interface LegacyImportPayload {
  info: SessionInfo & { cost: number; tokens: unknown };
  messages: unknown[];
  location: { directory: string };
}

export function toV2ImportPayload(session: V1SessionRow, messages: readonly V1Message[]): LegacyImportPayload {
  const directory = session.directory;
  const info: LegacyImportPayload["info"] = {
    id: session.id,
    projectID: "global",
    title: session.title,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: session.time_created, updated: session.time_updated },
    location: { directory },
  };
  const mapped = messages.map(message => {
    const time = asRow(message.data.time);
    if (message.data.role === "user") {
      const text = message.parts
        .filter(part => part.data.type === "text" && typeof part.data.text === "string")
        .map(part => String(part.data.text))
        .join("\n\n");
      return {
        id: message.id,
        type: "user",
        time: { created: message.time_created },
        text,
      };
    }
    const model = asRow(message.data.model);
    const tokens = asRow(message.data.tokens);
    const cache = asRow(tokens?.cache);
    return {
      id: message.id,
      type: "assistant",
      agent: typeof message.data.agent === "string" ? message.data.agent : undefined,
      model: {
        providerID: typeof message.data.providerID === "string" ? message.data.providerID : "unknown",
        id: typeof message.data.modelID === "string" ? message.data.modelID : (typeof model?.id === "string" ? String(model.id) : "unknown"),
        ...(typeof message.data.variant === "string" ? { variant: message.data.variant } : {}),
      },
      content: [],
      finish: typeof message.data.finish === "string" ? message.data.finish : "stop",
      cost: typeof message.data.cost === "number" ? message.data.cost : 0,
      tokens: {
        input: typeof tokens?.input === "number" ? tokens.input : 0,
        output: typeof tokens?.output === "number" ? tokens.output : 0,
        reasoning: typeof tokens?.reasoning === "number" ? tokens.reasoning : 0,
        cache: {
          read: typeof cache?.read === "number" ? cache.read : 0,
          write: typeof cache?.write === "number" ? cache.write : 0,
        },
      },
      time: {
        created: message.time_created,
        ...(time !== null && time.completed !== undefined ? { completed: Number(time.completed) } : {}),
      },
    };
  });
  return { info, messages: mapped, location: { directory } };
}

/** Persist the untouched v1 rows before any conversion (private raw backup). */
export function legacyBackupName(sessionId: string): string {
  return `legacy-${sessionId}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`;
}
