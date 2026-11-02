/**
 * OpenCode history backend — the real implementation behind the contract in
 * work/opencode-extension-contract.md (replaces the declaration-only stub).
 *
 * Everything runs on the installed version's verified official surface
 * (inventory probe work/opencode-inventory-report.md, evidence in
 * work/opencode-probe/**): the one shared background service, HTTP Basic
 * auth held in memory, global session enumeration with cursor paging, native
 * archive via PATCH, cascade delete via DELETE, and recoverable delete as
 * export → verify → delete → verify, restore as parent-first import with the
 * explicit original location. No direct writes to the shared SQLite file, no
 * whole-DB recycle, no invented fallbacks: failures raise; emptiness is only
 * ever an honest `data: []`.
 *
 * Delete integrity goes beyond id bookkeeping (interim review + contract +
 * supervisor late-child reproduction + review-4): the STORED backup files are
 * re-imported and read back inside a dedicated isolated verification host
 * before anything is deleted; per member the live transcript is re-checked
 * semantically (order, text, parts), a non-empty pending inbox refuses, and
 * confirmed-active sessions refuse; the complete transitive closure is then
 * rebuilt from a fresh enumeration and must exactly equal the verified backup
 * (membership + parent links) immediately before the single official DELETE.
 * Afterwards only conclusively-absent ids count as deleted — anything else
 * reports partial with the backup retained and no fallback re-DELETE. Restore
 * verification compares the projected transcript semantically too, reporting
 * partial on any difference.
 *
 * Live status (mandatory always-current requirement) follows live probe
 * work/opencode-live-status-report.md §4 plus the supervisor LIVE PROBE
 * UPDATE: `subscribeChanges`/`liveStatus` provide one SSE subscription to
 * the shared service (all client-path writes), a caller-driven db/WAL stat
 * comparison on the UI's single visible 2-second cadence, structural directory
 * watching, and reconcile batches on recovery — a reconnect is a full
 * reconcile, never just a badge.
 *
 * Legacy V1-only rows (contract "Confirmed legacy record integration",
 * work/opencode-legacy-report.md): discovered read-only under the
 * supervisor-adopted rule (v1 present ∧ v2 absent ∧ created after the
 * completed migration flag ∧ not locally tombstoned), previewable in full,
 * archived locally, never auto-imported; `recoverLegacySession` performs the
 * user-confirmed single-session conversion through the official import with
 * dual explicit locations, after a private raw backup and a verified-shape
 * check that refuses anything not proven lossless.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import type {
  BackupSummary,
  CatalogDeleteResult,
  CatalogHistoryPage,
  CatalogInventory,
  CatalogRestoreResult,
} from "../shared/sessionCatalog";
import { databaseFile, dataRoot, effectiveEnv } from "./paths";
import { discoverEngine, loadEngineChoice, saveEngineChoice } from "./engine";
import {
  OpenCodeApiError,
  OpenCodeServiceConnection,
  exportSession,
  importSession,
  pageAll,
  unwrapData,
  type Paged,
  type SessionExport,
  type SessionInfo,
} from "./opencodeApi";
import { toCatalogRow, toLogEntries, type CatalogRowLive } from "./normalize";
import { BackupStore, type BackupManifest } from "./backup";
import {
  ExecutionTracker,
  LiveChannel,
  type CatalogChangeBatch,
  type LiveChannelStatus,
} from "./liveChannel";
import {
  LegacyLocalState,
  analyzeForRecovery,
  legacyBackupName,
  readLegacyCandidates,
  readLegacyMessages,
  toV2ImportPayload,
  type LegacyImportPayload,
} from "./legacyStore";
import { startVerifyHost, verifyCall } from "./verifyServer";

export interface CatalogServiceOptions {
  storagePath: string;
  enginePath?: string;
  env?: NodeJS.ProcessEnv;
}

/** Refusal raised before any deletion when a backup cannot be proven complete. */
export class DeleteRefusedError extends Error {
  constructor(message: string, readonly backupId: string | null) {
    super(message);
    this.name = "DeleteRefusedError";
  }
}

const SESSION_PAGE_LIMIT = 100; // > the default 50; paging verified beyond it
const MESSAGE_PAGE_LIMIT = 50;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Deterministic JSON form for semantic comparisons (key order irrelevant). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Semantic transcript comparison (ids, order, types, text, part/tool content)
 * shared by the isolated-backup verification, the pre-delete drift re-check
 * and the restore readback. Returns a human-readable mismatch or null.
 */
function messageMismatch(expected: readonly unknown[], actual: readonly unknown[], label: string): string | null {
  if (expected.length !== actual.length) {
    return `${label}消息数量不一致（期望 ${expected.length}，实际 ${actual.length}）`;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index] as Record<string, unknown> | null;
    const got = actual[index] as Record<string, unknown> | null;
    if (want?.id !== got?.id) return `${label}第 ${index + 1} 条消息 ID 不一致`;
    if (want?.type !== got?.type) return `${label}第 ${index + 1} 条消息类型不一致`;
    const wantText = typeof want?.text === "string" ? want.text : textFromContent(want?.content);
    const gotText = typeof got?.text === "string" ? got.text : textFromContent(got?.content);
    if (wantText !== gotText) return `${label}第 ${index + 1} 条消息正文不一致`;
    if (canonicalJson(want?.content) !== canonicalJson(got?.content)) {
      return `${label}第 ${index + 1} 条消息部件/工具内容不一致`;
    }
    if (canonicalJson(want) !== canonicalJson(got)) {
      return `${label}第 ${index + 1} 条消息结构/元数据不一致`;
    }
  }
  return null;
}

/** Import updates time.updated; busy/idle are execution records, not retained transcript state. */
function retainedSessionMetadata(info: SessionInfo): unknown {
  const { updated: _updated, busy: _busy, idle: _idle, ...time } = info.time ?? {};
  return { ...info, time };
}

export class CatalogService {
  private readonly storagePath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly connection: OpenCodeServiceConnection;
  private readonly backups: BackupStore;
  private readonly execution = new ExecutionTracker();
  private readonly channel: LiveChannel;
  private readonly channelListeners = new Set<(batch: CatalogChangeBatch) => void>();
  private enginePath: string | null | undefined;
  private disposed = false;

  constructor(options: CatalogServiceOptions) {
    if (typeof options.storagePath !== "string" || options.storagePath === "") {
      throw new Error("后端需要扩展私有存储目录（storagePath）。");
    }
    this.storagePath = options.storagePath;
    this.env = effectiveEnv(options.env);
    this.enginePath = options.enginePath;
    // Cold-start fix: engine resolution must run real discovery (persisted
    // choice, npm global, PATH) whenever the connection needs to start its
    // own service. The previous synchronous `this.enginePath ?? null` never
    // discovered anything, so first use failed even with an installed engine.
    this.connection = new OpenCodeServiceConnection(this.env, () => this.resolveEngine(false));
    this.backups = new BackupStore(this.storagePath);
    this.channel = new LiveChannel({
      connection: this.connection,
      env: this.env,
      execution: this.execution,
      onBatch: batch => this.emitBatch(batch),
      onStatusChange: () => this.emitBatch({ receivedAt: Date.now(), origin: "reconcile", hints: [] }),
    });
  }

  private emitBatch(batch: CatalogChangeBatch): void {
    for (const listener of [...this.channelListeners]) {
      try {
        listener(batch);
      } catch {
        // A listener failure must not take down the subscription machinery.
      }
    }
  }

  // ---------------------------------------------------------------- reads ---

  async refresh(): Promise<CatalogInventory> {
    this.assertLive();
    // Baseline BEFORE the reads: an external write landing mid-refresh stays
    // detectable by the next stat check (interim review item).
    const statBaseline = this.channel.captureStatBaseline();
    const sessions = await pageAll<SessionInfo>(
      query => this.connection.call<unknown>("GET", "/api/session", undefined, query),
      SESSION_PAGE_LIMIT,
    );
    const rows: CatalogRowLive[] = sessions.map(info => toCatalogRow(info));
    await this.annotateActivity(rows);

    // Legacy V1-only candidates: readonly discovery, clearly marked rows. A
    // damaged local state file never blanks the sidebar or resets decisions:
    // the v2 inventory stays, legacy handling is suspended with an explicit
    // warning, and nothing is written so the bad state is never overwritten.
    let legacy: ReturnType<typeof readLegacyCandidates>;
    try {
      const local = await LegacyLocalState.load(this.storagePath);
      legacy = readLegacyCandidates(this.env, local.tombstoneIds(), local.archivedIds());
      rows.push(...legacy.candidates.map(candidate => candidate.row));
    } catch (error) {
      legacy = { candidates: [], v1Ids: new Set<string>(), warnings: [`旧版（V1）记录处理已暂停（本地状态不可用，未做任何写入）：${errorMessage(error)}`] };
    }

    const engine = await this.resolveEngine(false);
    const warnings: string[] = [];
    if (this.connection.startedByExtension()) {
      warnings.push("OpenCode 后台服务此前未运行，已由本扩展用官方命令启动；现有用户服务未被改动。");
    }
    const status = this.channel.current();
    if (status.state === "degraded") {
      warnings.push("实时事件流当前中断（正在自动重连）；数据以最近一次成功读取为准。");
    }
    warnings.push(...status.warnings);
    warnings.push(...legacy.warnings);
    if (legacy.candidates.length > 0) {
      warnings.push(`发现 ${legacy.candidates.length} 条旧版记录，可预览或归档。继续会话或删除前，请先右键选择“将旧版记录导入新版”。`);
    }
    this.channel.noteReconciled(Date.now(), statBaseline);
    const inventory: CatalogInventory & { sessions: CatalogRowLive[] } = {
      sessions: rows,
      engine_path: engine ?? "",
      data_root: dataRoot(this.env),
      warnings,
      archive_mode: "native",
    };
    return inventory;
  }

  async readHistory(sessionId: string, cursor?: string): Promise<CatalogHistoryPage> {
    this.assertLive();
    // The opaque cursor carries its own direction: combining it with `order`
    // is rejected by the server (probe evidence: page 2 uses cursor alone).
    const query: Record<string, string> = { limit: String(MESSAGE_PAGE_LIMIT) };
    if (cursor !== undefined && cursor !== "") query.cursor = cursor;
    else query.order = "asc";
    let value: unknown;
    try {
      ({ value } = await this.connection.call<unknown>(
        "GET",
        `/api/session/${encodeURIComponent(sessionId)}/message`,
        undefined,
        query,
      ));
    } catch (error) {
      if (error instanceof OpenCodeApiError && error.status === 404) {
        const legacyPage = await this.readLegacyHistory(sessionId);
        if (legacyPage !== null) return legacyPage;
      }
      throw error;
    }
    const page = value as Paged<unknown> | null;
    if (page === null || typeof page !== "object" || !Array.isArray(page.data)) {
      throw new OpenCodeApiError(`会话 ${sessionId} 的历史返回格式不符合预期（缺少 data 数组）。`);
    }
    const normalized = toLogEntries(page.data);
    // The server keeps offering a trailing cursor past the last row; an empty
    // page ends the chain instead of promising more.
    const hasNext = page.data.length > 0 && typeof page.cursor?.next === "string" && page.cursor.next !== "";
    return {
      entries: normalized.entries,
      next_cursor: hasNext ? page.cursor!.next! : null,
      warning: normalized.unknown > 0 ? `${normalized.unknown} 条消息/部件使用了未知格式，已按原始 JSON 显示。` : null,
    };
  }

  /** Readonly full preview of one legacy candidate; null when it is not one. */
  private async readLegacyHistory(sessionId: string): Promise<CatalogHistoryPage | null> {
    const local = await LegacyLocalState.load(this.storagePath);
    const legacy = readLegacyCandidates(this.env, local.tombstoneIds(), local.archivedIds());
    if (!legacy.candidates.some(candidate => candidate.row.session_id === sessionId)) return null;
    const { messages, error } = readLegacyMessages(this.env, sessionId);
    if (error !== null) throw new OpenCodeApiError(error);
    const shaped = messages.map(message => {
      // Unsupported or corrupt shapes must stay FULLY readable as their
      // original JSON — never reduced to a text sentinel that silently drops
      // unknown parts (revision item C). The normalizer renders these as
      // explicit unknown entries carrying the raw record.
      const corrupt = message.dataError !== null || message.parts.some(part => part.error !== null);
      const userOutsideShape = message.data.role === "user"
        && message.parts.some(part => part.data.type !== "text" || typeof part.data.text !== "string");
      if (corrupt || userOutsideShape) {
        return {
          id: message.id,
          type: "legacy-raw",
          time: { created: message.time_created },
          legacy_raw: {
            role: message.data.role ?? null,
            data: message.data,
            ...(message.dataError !== null ? { data_error: message.dataError, raw_data: message.rawData } : {}),
            parts: message.parts.map(part => (part.error !== null
              ? { parse_error: part.error, raw: part.raw }
              : part.data)),
          },
        };
      }
      if (message.data.role === "user") {
        const text = message.parts
          .filter(part => part.data.type === "text" && typeof part.data.text === "string")
          .map(part => String(part.data.text))
          .join("\n\n");
        return { id: message.id, type: "user", time: { created: message.time_created }, text };
      }
      return {
        id: message.id,
        type: "assistant",
        time: { created: message.time_created },
        content: message.parts.map(part => (part.data.type === "text" && typeof part.data.text === "string"
          ? { type: "text", text: part.data.text }
          : part.data)),
      };
    });
    const normalized = toLogEntries(shaped);
    return {
      entries: normalized.entries,
      next_cursor: null,
      warning: normalized.unknown > 0 ? `${normalized.unknown} 条旧版消息/部件未在已验证形状内或已损坏，已按原始 JSON 显示（可预览，不可转换）。` : null,
    };
  }

  /** `running` is claimed only from service-live evidence; never from DB timestamps. */
  private async annotateActivity(rows: CatalogRowLive[]): Promise<void> {
    // An execution may have started before subscription/reconnect. Merge the
    // current positive active snapshot with current-stream observations.
    const ids = await this.activeEvidenceIds();
    for (const row of rows) {
      if (ids.has(row.session_id)) {
        row.running = true;
        row.activity_source = "service-live";
      }
    }
  }

  // ------------------------------------------------------------- mutations ---

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    this.assertLive();
    try {
      const { status } = await this.connection.call<unknown>(
        "PATCH",
        `/api/session/${encodeURIComponent(sessionId)}`,
        { archived },
      );
      if (status !== 204 && status !== 200) {
        throw new OpenCodeApiError(`归档设置未确认（HTTP ${status}）。`, status);
      }
      // Read-after-write: the state must actually be on the server.
      const { value } = await this.connection.call<unknown>("GET", `/api/session/${encodeURIComponent(sessionId)}`);
      const info = unwrapData<SessionInfo | null>(value);
      const onServer = typeof info?.time?.archived === "number";
      if (onServer !== archived) {
        throw new OpenCodeApiError(`归档设置后服务器状态与请求不一致（期望 ${archived ? "已归档" : "未归档"}）。`);
      }
      return;
    } catch (error) {
      if (error instanceof OpenCodeApiError && error.status === 404) {
        const local = await LegacyLocalState.load(this.storagePath);
        const legacy = readLegacyCandidates(this.env, local.tombstoneIds(), local.archivedIds());
        if (legacy.candidates.some(candidate => candidate.row.session_id === sessionId)) {
          // Legacy rows archive locally by contract; native API never sees them.
          await local.setArchived(sessionId, archived);
          if (local.isArchived(sessionId) !== archived) {
            throw new OpenCodeApiError("旧版记录的本地归档状态写入后校验失败。");
          }
          return;
        }
      }
      throw error;
    }
  }

  /**
   * Recoverable delete (revision items A/B/G ordering): build the actual
   * parentID subtree (archived children included; independent forks
   * untouched), back up every member with the official export, prove the
   * STORED backup complete and re-importable in an isolated verification
   * host, then re-check per member — full message semantics, pending inbox,
   * confirmed-active — and finally rebuild the complete transitive closure
   * from a fresh enumeration and require exact equality (membership + parent
   * links) with the verified backup immediately before the one and only
   * official cascade DELETE. Post-delete, only conclusively-absent ids count
   * as deleted; anything else reports partial with the backup retained and
   * NO fallback re-DELETE (a retry re-enters the full fresh path). Deleted
   * ids are tombstoned against v1 remnants.
   */
  async deleteSession(sessionId: string, inUseIds?: ReadonlySet<string>): Promise<CatalogDeleteResult> {
    this.assertLive();
    const all = await pageAll<SessionInfo>(
      query => this.connection.call<unknown>("GET", "/api/session", undefined, query),
      SESSION_PAGE_LIMIT,
    );
    const byId = new Map(all.map(info => [info.id, info]));
    const root = byId.get(sessionId);
    if (root === undefined) {
      const local = await LegacyLocalState.load(this.storagePath);
      const legacy = readLegacyCandidates(this.env, local.tombstoneIds(), local.archivedIds());
      if (legacy.candidates.some(candidate => candidate.row.session_id === sessionId)) {
        throw new DeleteRefusedError(
          "旧版（V1）记录没有官方删除通路，直写旧表被禁止。请先执行“将旧版记录导入新版”，再对转换后的新版会话做可恢复删除。原始旧版行会保留在私有原始备份中。",
          null,
        );
      }
      throw new OpenCodeApiError(`要删除的会话不存在：${sessionId}`);
    }
    const scope: SessionInfo[] = [];
    const collect = (id: string): void => {
      const info = byId.get(id);
      if (info === undefined) return;
      scope.push(info);
      for (const candidate of all) if (candidate.parentID === id) collect(candidate.id);
    };
    collect(sessionId);
    if (inUseIds !== undefined) {
      const blocked = scope.map(info => info.id).filter(id => inUseIds.has(id));
      if (blocked.length > 0) {
        throw new DeleteRefusedError(`以下会话的 OpenCode 终端仍在本扩展中打开，请先关闭后再删除：${blocked.join("、")}`, null);
      }
    }
    // Confirmed-active sessions refuse the deletion up front (positive
    // service-live evidence only — absence of evidence is never read as a
    // global idle claim; external runners simply stay unknown).
    const activeEarly = await this.activeEvidenceIds();
    const activeBlockedEarly = scope.map(info => info.id).filter(id => activeEarly.has(id));
    if (activeBlockedEarly.length > 0) {
      throw new DeleteRefusedError(`以下会话正在运行（服务端实时证据），请等待其完成后再删除：${activeBlockedEarly.join("、")}`, null);
    }

    // Backup, parent first, with a live completeness baseline per member.
    const baselines = new Map<string, string[]>();
    const ordered = this.parentsFirst(scope);
    const envelopes: SessionExport[] = [];
    for (const member of ordered) {
      baselines.set(member.id, await this.messageIds(member.id));
      envelopes.push(await exportSession(this.connection, member.id));
    }
    const backup = await this.backups.create(root.title ?? root.id, envelopes, baselines);

    // Completeness proof against the live baseline.
    const incomplete: string[] = [];
    for (const envelope of envelopes) {
      const live = baselines.get(envelope.info.id) ?? [];
      const exported = new Set(envelope.messages.map(message => {
        const record = message as { id?: unknown };
        return typeof record?.id === "string" ? record.id : "";
      }));
      const missing = live.filter(id => !exported.has(id));
      if (missing.length > 0 || envelope.info.location?.directory === undefined) {
        incomplete.push(envelope.info.id);
      }
    }
    if (incomplete.length > 0) {
      await this.backups.write({
        ...backup,
        status: "partial",
        message: `导出不完整（会话 ${incomplete.join("、")} 存在导出未包含的消息或缺原目录），已拒绝删除。备份保留，未执行任何删除。`,
      });
      throw new DeleteRefusedError(
        `无法证明备份完整（会话 ${incomplete.join("、")} 的导出缺少未完成消息或缺原目录），已拒绝删除；没有任何数据被删除。恢复备份 ${backup.backup_id} 已保留。`,
        backup.backup_id,
      );
    }

    // Concrete backup verification: the stored files must re-import and read
    // back identically inside a dedicated isolated host before any deletion.
    const verification = await this.verifyBackupInIsolation(backup);
    if (!verification.ok) {
      await this.backups.write({
        ...backup,
        status: "partial",
        message: `隔离恢复验证未通过（${verification.error}），已拒绝删除。备份保留，未执行任何删除。`,
      });
      throw new DeleteRefusedError(
        `备份在隔离验证环境中恢复失败（${verification.error}），已拒绝删除；没有任何数据被删除。恢复备份 ${backup.backup_id} 已保留。`,
        backup.backup_id,
      );
    }

    // Per-member drift re-checks, pending inbox, confirmed-active and the
    // final closure comparison run as one phase: ANY unexpected failure there
    // (unreadable inbox, list read error, damaged backup file) must leave an
    // honest partial manifest and refuse the deletion — never propagate a raw
    // error while the manifest still claims a clean "available" backup and
    // never silently continue (revision items B+G).
    try {
      await this.preflightBeforeDelete(sessionId, backup, envelopes, scope);
    } catch (error) {
      if (error instanceof DeleteRefusedError) throw error;
      await this.backups.write({
        ...backup,
        status: "partial",
        message: `删除前复检无法完成，已拒绝删除：${errorMessage(error)}。备份保留，未执行任何删除。`,
      });
      throw new DeleteRefusedError(
        `删除前复检无法完成（${errorMessage(error)}），已拒绝删除；没有任何数据被删除。恢复备份 ${backup.backup_id} 已保留，可重试（重试将从完整新备份开始）。`,
        backup.backup_id,
      );
    }

    // The one and only official cascade delete of the root (revision item G:
    // no fallback cascading DELETEs later — mutations are never retried
    // against an unverified evolving tree).
    try {
      await this.connection.call<unknown>("DELETE", `/api/session/${encodeURIComponent(sessionId)}`);
    } catch (error) {
      // The request outcome is unknown (it may or may not have executed):
      // keep the backup, record the uncertainty on the manifest and surface
      // the failure — never swallow it into a fake success.
      await this.backups.write({
        ...backup,
        status: "partial",
        message: `删除请求失败，执行结果无法确认：${errorMessage(error)}。恢复备份 ${backup.backup_id} 已保留。`,
      });
      return { status: "partial", message: `删除请求结果无法确认：${errorMessage(error)}。备份 ${backup.backup_id} 已保留，未执行自动补删。`, backup_id: backup.backup_id, deleted_session_ids: [] };
    }

    // Post-delete verification: only conclusively-absent ids count as
    // deleted. Anything still present or unverifiable stays a reported
    // partial with the backup retained — no automatic re-DELETE (a manual
    // retry re-enters the complete fresh preparation path).
    const survivors: string[] = [];
    for (const member of scope) {
      if (!(await this.sessionGoneTolerant(member.id))) survivors.push(member.id);
    }
    if (survivors.length > 0) {
      await this.backups.write({
        ...backup,
        status: "partial",
        message: `部分会话删除后仍存在或无法核验：${survivors.join("、")}。恢复备份 ${backup.backup_id} 已保留；未执行自动补删，重试将从完整新备份开始。`,
      });
      await this.tombstoneV1Counterparts(scope.map(info => info.id).filter(id => !survivors.includes(id)));
      return {
        status: "partial",
        message: `删除未完全生效或无法核验：${survivors.join("、")} 仍在服务器上或无法确认。备份 ${backup.backup_id} 已保留；未执行自动补删，重试将从完整新备份开始。`,
        backup_id: backup.backup_id,
        deleted_session_ids: scope.map(info => info.id).filter(id => !survivors.includes(id)),
      };
    }
    const deleted = scope.map(info => info.id);
    await this.tombstoneV1Counterparts(deleted);
    await this.backups.write({ ...backup, status: "available", message: "删除已完成，备份可用于恢复。" });
    return {
      status: "deleted",
      message: `已删除 ${deleted.length} 个会话（含子会话）。私有本地备份 ${backup.backup_id} 可从“恢复备份”还原。`,
      backup_id: backup.backup_id,
      deleted_session_ids: deleted,
    };
  }

  /**
   * The full pre-DELETE recheck phase (revision items A/B/G), extracted so the
   * caller can convert ANY unexpected failure into an honest partial backup +
   * refusal. Order: per-member full semantic transcript comparison, pending
   * inbox, confirmed-active, then the FINAL complete closure comparison
   * (membership + parent links + retained metadata) immediately before the
   * single official DELETE. A new/removed/re-parented member or any drift in
   * directory/archive/other retained metadata refuses the deletion outright —
   * a new child is not in the verified backup, so the native cascade would
   * destroy it unrecoverably. This is a single recheck, not a loop: the
   * residual check-to-write gap is fundamental (no conditional/atomic
   * cross-process delete exists in 2.2.5) and is stated honestly instead of
   * being polled away.
   */
  private async preflightBeforeDelete(
    sessionId: string,
    backup: BackupManifest,
    envelopes: readonly SessionExport[],
    scope: readonly SessionInfo[],
  ): Promise<void> {
    for (const member of backup.members) {
      const envelope = envelopes.find(item => item.info.id === member.session_id);
      if (envelope === undefined) {
        await this.backups.write({ ...backup, status: "partial", message: `备份缺少会话 ${member.session_id} 的导出信封，已拒绝删除。备份保留。` });
        throw new DeleteRefusedError(`备份不完整：缺少会话 ${member.session_id} 的导出信封，已拒绝删除；没有任何数据被删除。`, backup.backup_id);
      }
      const liveNow = await this.readAllMessages(member.session_id);
      const mismatch = messageMismatch(envelope.messages, liveNow, `会话 ${member.session_id}：`);
      if (mismatch !== null) {
        await this.backups.write({ ...backup, status: "partial", message: `备份期间会话内容发生变化（${mismatch}），已拒绝删除。备份保留。` });
        throw new DeleteRefusedError(`备份期间会话内容发生变化（${mismatch}），已拒绝删除；没有任何数据被删除。可刷新后重试。`, backup.backup_id);
      }
    }
    // Pending inbox (revision item G): the plain export does not carry pending
    // admitted work, so a non-empty native inbox refuses the deletion. An
    // unreadable inbox also refuses — absence of proof is never proof.
    const inboxPending = await this.pendingInboxIds(backup);
    if (inboxPending.length > 0) {
      await this.backups.write({ ...backup, status: "partial", message: `以下会话仍有待处理输入（inbox 非空），已拒绝删除。备份保留。` });
      throw new DeleteRefusedError(`以下会话仍有待处理输入（inbox 非空，普通导出不包含这些内容），请等待其处理完成后再删除：${inboxPending.join("、")}`, backup.backup_id);
    }
    // Confirmed-active sessions refuse the delete at the last moment too.
    const activeNow = await this.activeEvidenceIds();
    const activeBlockedNow = scope.map(info => info.id).filter(id => activeNow.has(id));
    if (activeBlockedNow.length > 0) {
      await this.backups.write({ ...backup, status: "partial", message: `备份期间以下会话开始运行：${activeBlockedNow.join("、")}，已拒绝删除。备份保留。` });
      throw new DeleteRefusedError(`备份期间以下会话开始运行（服务端实时证据），请等待其完成后再删除：${activeBlockedNow.join("、")}`, backup.backup_id);
    }

    const allNow = await pageAll<SessionInfo>(
      query => this.connection.call<unknown>("GET", "/api/session", undefined, query),
      SESSION_PAGE_LIMIT,
    );
    const byIdNow = new Map(allNow.map(info => [info.id, info]));
    const backupMembers = new Map(backup.members.map(member => [member.session_id, member]));
    if (!byIdNow.has(sessionId)) {
      await this.backups.write({ ...backup, status: "partial", message: "备份期间要删除的会话已消失，已拒绝删除。备份保留。" });
      throw new DeleteRefusedError(`备份期间会话 ${sessionId} 已不存在，已拒绝删除；没有任何数据被删除。可刷新后重试。`, backup.backup_id);
    }
    const scopeNow: SessionInfo[] = [];
    const collectNow = (id: string): void => {
      const info = byIdNow.get(id);
      if (info === undefined) return;
      scopeNow.push(info);
      for (const candidate of allNow) if (candidate.parentID === id) collectNow(candidate.id);
    };
    collectNow(sessionId);
    const addedIds = scopeNow.map(info => info.id).filter(id => !backupMembers.has(id));
    const scopeIdsNow = new Set(scopeNow.map(info => info.id));
    const missingIds = backup.members.map(member => member.session_id).filter(id => !scopeIdsNow.has(id));
    if (addedIds.length > 0 || missingIds.length > 0) {
      await this.backups.write({
        ...backup,
        status: "partial",
        message: `备份期间删除范围发生变化（新增 ${addedIds.join("、") || "无"}；消失 ${missingIds.join("、") || "无"}），已拒绝删除。备份保留。`,
      });
      throw new DeleteRefusedError(
        `备份期间删除范围已变化：新增会话 ${addedIds.join("、") || "无"}不在已验证备份内（级联删除将无法恢复它们），已消失会话 ${missingIds.join("、") || "无"}。已拒绝本次删除；没有任何数据被删除。可刷新后重试（重试将从完整新备份开始）。`,
        backup.backup_id,
      );
    }
    for (const member of scopeNow) {
      const recorded = backupMembers.get(member.id)!;
      if ((member.parentID ?? null) !== recorded.parent_session_id) {
        await this.backups.write({ ...backup, status: "partial", message: `备份期间会话 ${member.id} 的父子关系发生变化，已拒绝删除。备份保留。` });
        throw new DeleteRefusedError(`备份期间会话 ${member.id} 的父子关系发生变化（备份记录父 ${recorded.parent_session_id ?? "无"}，当前 ${member.parentID ?? "无"}），已拒绝删除；没有任何数据被删除。可刷新后重试。`, backup.backup_id);
      }
      const envelope = await this.backups.envelope(backup.backup_id, recorded);
      if (canonicalJson(retainedSessionMetadata(member)) !== canonicalJson(retainedSessionMetadata(envelope.info))) {
        await this.backups.write({ ...backup, status: "partial", message: `备份期间会话 ${member.id} 的目录、归档或其他保留元数据发生变化，已拒绝删除。备份保留。` });
        throw new DeleteRefusedError(`备份期间会话 ${member.id} 的目录、归档或其他保留元数据发生变化，已拒绝删除；没有任何数据被删除。`, backup.backup_id);
      }
    }
  }

  /** Deleted v2 rows with v1 counterparts must not resurface as legacy candidates. */
  private async tombstoneV1Counterparts(deletedIds: readonly string[]): Promise<void> {
    if (deletedIds.length === 0) return;
    const local = await LegacyLocalState.load(this.storagePath);
    const legacy = readLegacyCandidates(this.env, new Set<string>(), local.archivedIds());
    const toTombstone = deletedIds.filter(id => legacy.v1Ids.has(id));
    if (toTombstone.length > 0) await local.tombstone(toTombstone);
  }

  /**
   * Concrete backup verification: re-import every STORED member file into a
   * dedicated isolated host (own database/config/home under extension
   * storage; no user auth, no plugins, no model requests) and compare the
   * readback semantically with what the backup claims to contain.
   */
  private async verifyBackupInIsolation(backup: BackupManifest): Promise<{ ok: true } | { ok: false; error: string }> {
    const engine = await this.resolveEngine(true);
    let host: Awaited<ReturnType<typeof startVerifyHost>> | null = null;
    try {
      host = await startVerifyHost(engine as string, this.storagePath);
      // Official import requires an existing parent. A scope member whose
      // parent stays outside the deleted scope (deleting a child keeps its
      // parent) gets a synthetic parent stub under the REAL parent id inside
      // this throwaway host only, so the stored child envelope imports
      // verbatim and its parent link is still verified against the real id.
      const memberIds = new Set(backup.members.map(member => member.session_id));
      const stubParents = new Set(
        backup.members
          .map(member => member.parent_session_id)
          .filter((id): id is string => id !== null && !memberIds.has(id)),
      );
      for (const parent of stubParents) {
        const now = Date.now();
        const stubbed = await verifyCall(host, "POST", "/api/experimental/session/import", {
          info: {
            id: parent,
            projectID: "global",
            title: "(isolated verification parent stub)",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: now, updated: now },
            location: { directory: this.env.APPDATA ?? process.env.APPDATA ?? process.cwd() },
          },
          messages: [],
          location: { directory: this.env.APPDATA ?? process.env.APPDATA ?? process.cwd() },
        });
        if (stubbed.status !== 200) {
          return { ok: false, error: `范围外父级 ${parent} 在隔离环境无法预置（HTTP ${stubbed.status}）` };
        }
      }
      for (const member of backup.members) {
        const envelope = await this.backups.envelope(backup.backup_id, member);
        const imported = await verifyCall(host, "POST", "/api/experimental/session/import", {
          info: envelope.info,
          messages: envelope.messages,
          location: envelope.info.location ?? undefined,
        });
        if (imported.status !== 200) {
          return { ok: false, error: `会话 ${member.session_id} 在隔离环境导入失败（HTTP ${imported.status}）` };
        }
        const read = await verifyCall(host, "GET", `/api/session/${encodeURIComponent(member.session_id)}`);
        const info = unwrapData<SessionInfo | null>(read.value);
        if (info === null || info.id !== member.session_id) {
          return { ok: false, error: `会话 ${member.session_id} 在隔离环境读回失败` };
        }
        if ((info.parentID ?? null) !== member.parent_session_id) {
          return { ok: false, error: `会话 ${member.session_id} 的父子关系在隔离环境不一致` };
        }
        if ((typeof info.time?.archived === "number") !== member.archived) {
          return { ok: false, error: `会话 ${member.session_id} 的归档状态在隔离环境不一致` };
        }
        if ((info.location?.directory ?? "") !== member.directory) {
          return { ok: false, error: `会话 ${member.session_id} 的原目录在隔离环境不一致` };
        }
        // Resume-card fix: the readback used to be a single `limit=100` request,
        // so a session with more than 100 messages could never verify (and a
        // longer transcript was silently compared only in part). Follow the
        // server's cursor protocol for the COMPLETE roundtrip comparison.
        let page: unknown[];
        try {
          page = await this.verifyHostAllMessages(host, member.session_id);
        } catch (error) {
          return { ok: false, error: `会话 ${member.session_id} 在隔离环境消息读回失败：${errorMessage(error)}` };
        }
        const mismatch = messageMismatch(envelope.messages, page, `会话 ${member.session_id} 在隔离环境：`);
        if (mismatch !== null) return { ok: false, error: mismatch };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      if (host !== null) await host.stop().catch(() => undefined);
    }
  }

  async listBackups(): Promise<BackupSummary[]> {
    const manifests = await this.backups.list();
    return manifests.map(manifest => ({
      backup_id: manifest.backup_id,
      created_at: manifest.created_at,
      session_ids: manifest.session_ids,
      title: manifest.title,
      status: manifest.status,
    }));
  }

  /** Restore parent-first; existing sessions are reported, never overwritten. */
  async restoreBackup(backupId: string): Promise<CatalogRestoreResult> {
    this.assertLive();
    const manifest = await this.backups.read(backupId);
    const members = this.parentsFirstManifest(manifest);
    const restored: string[] = [];
    const conflicts: string[] = [];
    const failures: Array<{ id: string; error: string }> = [];
    for (const member of members) {
      try {
        if (!(await this.sessionGone(member.session_id))) {
          conflicts.push(member.session_id);
          continue;
        }
        const envelope = await this.backups.envelope(backupId, member);
        await importSession(this.connection, envelope);
        const verified = await this.verifyRestored(member, envelope);
        if (!verified.ok) {
          failures.push({ id: member.session_id, error: verified.error });
          continue;
        }
        restored.push(member.session_id);
      } catch (error) {
        failures.push({ id: member.session_id, error: errorMessage(error) });
      }
    }
    const problems = [
      ...conflicts.map(id => `会话 ${id} 已存在，未覆盖`),
      ...failures.map(failure => `会话 ${failure.id} 恢复失败：${failure.error}`),
    ];
    const status = problems.length === 0 ? "restored" : "partial";
    const message = problems.length === 0
      ? `已恢复 ${restored.length} 个会话（含子会话关系、归档状态与消息）。`
      : `恢复了 ${restored.length} 个会话；${problems.join("；")}。`;
    if (status === "restored") {
      await this.backups.write({ ...manifest, status: "restored", message });
    } else if (restored.length > 0 || conflicts.length > 0) {
      await this.backups.write({ ...manifest, status: "partial", message });
    }
    return { status, message, restored_session_ids: restored };
  }

  /** Semantic readback verification: relations, archive, directory, and the full projected transcript. */
  private async verifyRestored(member: BackupManifest["members"][number], envelope: SessionExport): Promise<{ ok: true } | { ok: false; error: string }> {
    const { value } = await this.connection.call<unknown>("GET", `/api/session/${encodeURIComponent(member.session_id)}`);
    const info = unwrapData<SessionInfo | null>(value);
    if (info === null || info.id !== member.session_id) return { ok: false, error: "恢复后读取不到相同 ID 的会话" };
    if ((info.parentID ?? null) !== member.parent_session_id) {
      return { ok: false, error: `父子关系不符（期望父 ${member.parent_session_id ?? "无"}，实际 ${info.parentID ?? "无"}）` };
    }
    if ((typeof info.time?.archived === "number") !== member.archived) {
      return { ok: false, error: "归档状态未按备份恢复" };
    }
    const restoredDirectory = info.location?.directory ?? "";
    if (restoredDirectory !== member.directory) {
      return { ok: false, error: `原目录未恢复（期望 ${member.directory || "（无）"}，实际 ${restoredDirectory || "（无）"}）` };
    }
    const page = await this.readAllMessages(member.session_id);
    const mismatch = messageMismatch(envelope.messages, page, "");
    if (mismatch !== null) return { ok: false, error: mismatch };
    return { ok: true };
  }

  // ------------------------------------------------------------- legacy recovery ---

  /**
   * User-confirmed single-session legacy recovery (contract "Confirmed
   * legacy record integration"): private raw backup of the untouched v1
   * rows, verified-shape conversion following the official transformSession
   * semantics, official import with BOTH info.location and the top-level
   * original location, and a semantic readback. The original v1 rows stay
   * untouched; no migration flag is ever touched; conflicts are reported,
   * never overwritten (server-side 409 semantics).
   */
  async recoverLegacySession(sessionId: string): Promise<CatalogRestoreResult> {
    this.assertLive();
    const local = await LegacyLocalState.load(this.storagePath);
    const legacy = readLegacyCandidates(this.env, local.tombstoneIds(), local.archivedIds());
    const candidate = legacy.candidates.find(item => item.row.session_id === sessionId);
    if (candidate === undefined) {
      throw new OpenCodeApiError(`没有可导入的旧版记录：${sessionId}（可能已被导入、隐藏，或不是迁移后旧版写入）。`);
    }
    const { messages, error } = readLegacyMessages(this.env, sessionId);
    if (error !== null) throw new OpenCodeApiError(error);
    const analysis = analyzeForRecovery(messages);
    if (!analysis.supported) {
      throw new OpenCodeApiError(
        `旧版记录 ${sessionId} 含未验证的转换形状，拒绝导入以避免内容损失：${analysis.warnings.join("；")}。该记录仍可只读预览。`,
      );
    }
    // Conflict check: an existing v2 row with the same id is never overwritten.
    if (!(await this.sessionGone(sessionId))) {
      return {
        status: "partial",
        message: `会话 ${sessionId} 已存在于新版，未覆盖（官方导入对同 ID 返回 409）。`,
        restored_session_ids: [],
      };
    }
    // Private raw backup of the untouched v1 rows.
    const rawBackupPath = join(this.storagePath, "legacy-backups", legacyBackupName(sessionId));
    await mkdir(join(rawBackupPath, ".."), { recursive: true });
    await writeFile(rawBackupPath, JSON.stringify({ session: candidate.raw, messages }, null, 2), "utf8");

    const payload = toV2ImportPayload(candidate.raw, messages);
    // Contract "Confirmed legacy record integration": prove the conversion
    // lossless in an ISOLATED official host BEFORE the production import —
    // the raw v1 rows and the raw backup stay untouched when this fails.
    const isolation = await this.verifyLegacyConversionInIsolation(payload);
    if (!isolation.ok) {
      throw new OpenCodeApiError(
        `旧版记录 ${sessionId} 的转换在隔离验证环境未通过（${isolation.error}），已拒绝导入以避免内容损失。原始行与原始备份（${rawBackupPath}）保留；该记录仍可只读预览。`,
      );
    }
    await this.connection.call<unknown>("POST", "/api/experimental/session/import", {
      info: payload.info,
      messages: payload.messages,
      location: payload.location,
    });
    // Semantic readback (time.updated legitimately becomes the import moment).
    const { value } = await this.connection.call<unknown>("GET", `/api/session/${encodeURIComponent(sessionId)}`);
    const info = unwrapData<SessionInfo | null>(value);
    if (info === null || info.id !== sessionId) {
      return { status: "partial", message: `旧版记录 ${sessionId} 导入后无法读回。原始行与原始备份（${rawBackupPath}）保留。`, restored_session_ids: [] };
    }
    if ((info.location?.directory ?? "") !== candidate.raw.directory) {
      return { status: "partial", message: `旧版记录 ${sessionId} 导入后目录不符（期望 ${candidate.raw.directory}，实际 ${info.location?.directory ?? "（无）"}）。原始行保留。`, restored_session_ids: [] };
    }
    const readback = await this.readAllMessages(sessionId);
    const expected = payload.messages as Array<Record<string, unknown>>;
    if (readback.length !== expected.length) {
      return { status: "partial", message: `旧版记录 ${sessionId} 导入后消息数量不符（期望 ${expected.length}，实际 ${readback.length}）。原始行保留。`, restored_session_ids: [] };
    }
    for (let index = 0; index < expected.length; index += 1) {
      const want = expected[index];
      const got = readback[index] as Record<string, unknown>;
      if (want.id !== got.id || want.type !== got.type) {
        return { status: "partial", message: `旧版记录 ${sessionId} 导入后第 ${index + 1} 条消息 ID/类型不符。原始行保留。`, restored_session_ids: [] };
      }
      const wantText = typeof want.text === "string" ? want.text : textFromContent(want.content);
      const gotText = typeof got.text === "string" ? String(got.text) : textFromContent(got.content);
      if (wantText !== gotText) {
        return { status: "partial", message: `旧版记录 ${sessionId} 导入后第 ${index + 1} 条消息正文不符。原始行保留。`, restored_session_ids: [] };
      }
    }
    // The row is now a normal v2 session; the local archive marker no longer applies.
    await local.clearArchive(sessionId);
    return {
      status: "restored",
      message: `旧版记录 ${sessionId} 已按官方转换语义导入新版（原目录、ID、消息保真；time.updated 变为导入时刻属预期）。原 V1 行未改动；原始行备份保存在扩展私有目录。`,
      restored_session_ids: [sessionId],
    };
  }

  /**
   * Isolated pre-proof of a legacy conversion (contract: "prove isolated
   * official import/read/export fidelity, then official production import").
   * Imports the converted payload into a throwaway official host and reads it
   * back semantically (ids, types, order, text, original directory) — the
   * fidelity level the legacy probe actually verified for these shapes.
   */
  private async verifyLegacyConversionInIsolation(payload: LegacyImportPayload): Promise<{ ok: true } | { ok: false; error: string }> {
    const engine = await this.resolveEngine(true);
    let host: Awaited<ReturnType<typeof startVerifyHost>> | null = null;
    try {
      host = await startVerifyHost(engine as string, this.storagePath);
      const imported = await verifyCall(host, "POST", "/api/experimental/session/import", {
        info: payload.info,
        messages: payload.messages,
        location: payload.location,
      });
      if (imported.status !== 200) {
        return { ok: false, error: `隔离环境官方导入失败（HTTP ${imported.status}）` };
      }
      const read = await verifyCall(host, "GET", `/api/session/${encodeURIComponent(payload.info.id)}`);
      const info = unwrapData<SessionInfo | null>(read.value);
      if (info === null || info.id !== payload.info.id) {
        return { ok: false, error: "隔离环境导入后无法读回相同 ID 的会话" };
      }
      if ((info.location?.directory ?? "") !== payload.location.directory) {
        return { ok: false, error: `隔离环境目录不符（期望 ${payload.location.directory}，实际 ${info.location?.directory ?? "（无）"}）` };
      }
      const readback = await this.verifyHostAllMessages(host, payload.info.id);
      const expected = payload.messages as Array<Record<string, unknown>>;
      if (readback.length !== expected.length) {
        return { ok: false, error: `隔离环境消息数量不符（期望 ${expected.length}，实际 ${readback.length}）` };
      }
      for (let index = 0; index < expected.length; index += 1) {
        const want = expected[index];
        const got = readback[index] as Record<string, unknown>;
        if (want.id !== got.id || want.type !== got.type) {
          return { ok: false, error: `隔离环境第 ${index + 1} 条消息 ID/类型不符` };
        }
        const wantText = typeof want.text === "string" ? want.text : textFromContent(want.content);
        const gotText = typeof got.text === "string" ? String(got.text) : textFromContent(got.content);
        if (wantText !== gotText) {
          return { ok: false, error: `隔离环境第 ${index + 1} 条消息正文不符` };
        }
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      if (host !== null) await host.stop().catch(() => undefined);
    }
  }

  // ----------------------------------------------------------------- engine ---

  async getEnginePath(): Promise<string> {
    return this.resolveEngine(true) as Promise<string>;
  }

  async setEnginePath(path: string): Promise<void> {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || !info.isFile()) throw new Error(`所选引擎路径不存在或不是文件：${path}`);
    this.enginePath = path;
    await saveEngineChoice(this.storagePath, path);
  }

  private async resolveEngine(throwOnMissing: boolean): Promise<string | null> {
    if (this.enginePath === undefined) {
      const choice = await loadEngineChoice(this.storagePath).catch(() => null);
      this.enginePath = choice !== null && choice !== "" ? choice : await discoverEngine(this.env);
    }
    if ((this.enginePath === null || this.enginePath === "") && throwOnMissing) {
      throw new Error("找不到本机 OpenCode 原生引擎。请在“选择引擎”中指定 opencode.exe 的绝对路径。");
    }
    return this.enginePath ?? null;
  }

  // ------------------------------------------------------------------- live ---

  /** Live-probe §4 subscription DTO. First listener starts the machinery. */
  subscribeChanges(listener: (batch: CatalogChangeBatch) => void): { dispose(): void } {
    this.channelListeners.add(listener);
    this.channel.acquire();
    return {
      dispose: () => {
        this.channelListeners.delete(listener);
        this.channel.release();
      },
    };
  }

  liveStatus(): LiveChannelStatus {
    return this.channel.current();
  }

  /** Reconcile trigger hook for callers (focus/re-show/visible cadence). */
  pollStatChange(): boolean {
    return this.channel.pollStatChange();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.channel.dispose();
    // The shared user service is deliberately NOT stopped here (supervisor
    // decision); only test code stops services it started itself.
  }

  // ------------------------------------------------------------------ utils ---

  private assertLive(): void {
    if (this.disposed) throw new Error("后端已释放。");
  }

  private async messageIds(sessionId: string): Promise<string[]> {
    const messages = await this.readAllMessages(sessionId);
    return messages.map(message => (typeof (message as { id?: unknown }).id === "string" ? (message as { id: string }).id : "")).filter(id => id !== "");
  }

  /**
   * Sessions whose native pending inbox (`GET /api/session/{id}/inbox`) is
   * non-empty. The plain export does not include pending admitted work
   * (revision item G), so a non-empty inbox must refuse a deletion. An
   * inbox that cannot be read also refuses via the thrown error — absence
   * of proof is never treated as proof of emptiness.
   */
  private async pendingInboxIds(backup: BackupManifest): Promise<string[]> {
    const pending: string[] = [];
    for (const member of backup.members) {
      const { value } = await this.connection.call<unknown>(
        "GET",
        `/api/session/${encodeURIComponent(member.session_id)}/inbox`,
      );
      const inbox = unwrapData<unknown>(value);
      const nonEmpty = Array.isArray(inbox)
        ? inbox.length > 0
        : inbox !== null && inbox !== undefined && typeof inbox === "object" && Object.keys(inbox as object).length > 0;
      if (nonEmpty) pending.push(member.session_id);
    }
    return pending;
  }

  /**
   * Positive service-live activity evidence only (execution observations from
   * the current SSE stream plus the service's own active set). Absence of
   * evidence is NEVER read as a global idle claim — external runners stay
   * unknown; only membership here refuses a deletion.
   */
  private async activeEvidenceIds(): Promise<Set<string>> {
    const ids = this.execution.ids();
    try {
      const { value } = await this.connection.call<unknown>("GET", "/api/session/active");
      const active = unwrapData<Record<string, unknown>>(value);
      if (active !== null && typeof active === "object") {
        for (const key of Object.keys(active)) ids.add(key);
      }
    } catch {
      // Active-set unavailability is not evidence of idleness either way.
    }
    return ids;
  }

  /** Full message list (ascending), following the server's cursor protocol. */
  private async readAllMessages(sessionId: string): Promise<unknown[]> {
    let first = true;
    return pageAll<unknown>(
      query => {
        const effective: Record<string, string> = { ...query };
        if (first) { effective.order = "asc"; first = false; }
        return this.connection.call<unknown>("GET", `/api/session/${encodeURIComponent(sessionId)}/message`, undefined, effective);
      },
      MESSAGE_PAGE_LIMIT,
    );
  }

  /**
   * Full message list (ascending) from an ISOLATED verification host, following
   * the same cursor protocol (first page order=asc, then cursor-only): the
   * isolated readback must be complete, never a truncated single request.
   */
  private async verifyHostAllMessages(host: Awaited<ReturnType<typeof startVerifyHost>>, sessionId: string): Promise<unknown[]> {
    let first = true;
    return pageAll<unknown>(
      query => {
        const effective: Record<string, string> = { ...query };
        if (first) { effective.order = "asc"; first = false; }
        const search = new URLSearchParams(effective).toString();
        return verifyCall(host, "GET", `/api/session/${encodeURIComponent(sessionId)}/message?${search}`);
      },
      MESSAGE_PAGE_LIMIT,
    );
  }

  private async sessionGone(sessionId: string): Promise<boolean> {
    try {
      await this.connection.call<unknown>("GET", `/api/session/${encodeURIComponent(sessionId)}`);
      return false;
    } catch (error) {
      if (error instanceof OpenCodeApiError && error.status === 404) return true;
      throw error;
    }
  }

  /** Verification must classify transient errors as "cannot confirm", not crash a finished delete. */
  private async sessionGoneTolerant(sessionId: string): Promise<boolean> {
    try {
      return await this.sessionGone(sessionId);
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
      try {
        return await this.sessionGone(sessionId);
      } catch {
        return false;
      }
    }
  }

  private parentsFirst(scope: readonly SessionInfo[]): SessionInfo[] {
    const byId = new Map(scope.map(info => [info.id, info]));
    const done = new Set<string>();
    const ordered: SessionInfo[] = [];
    const visit = (info: SessionInfo): void => {
      if (done.has(info.id)) return;
      done.add(info.id);
      const parent = info.parentID !== undefined && info.parentID !== null ? byId.get(info.parentID) : undefined;
      if (parent !== undefined) visit(parent);
      ordered.push(info);
    };
    for (const info of scope) visit(info);
    return ordered;
  }

  private parentsFirstManifest(manifest: BackupManifest): BackupManifest["members"] {
    const byId = new Map(manifest.members.map(member => [member.session_id, member]));
    const done = new Set<string>();
    const ordered: BackupManifest["members"] = [];
    const visit = (member: BackupManifest["members"][number]): void => {
      if (done.has(member.session_id)) return;
      done.add(member.session_id);
      const parent = member.parent_session_id !== null ? byId.get(member.parent_session_id) : undefined;
      if (parent !== undefined) visit(parent);
      ordered.push(member);
    };
    for (const member of manifest.members) visit(member);
    return ordered;
  }
}

/** Concatenated text of an assistant content array (semantic compare helper). */
function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map(part => {
      const record = part as { type?: unknown; text?: unknown };
      if (record !== null && typeof record === "object" && record.type === "text" && typeof record.text === "string") return record.text;
      return "";
    })
    .filter(text => text !== "")
    .join("\n\n");
}

/** Absolute path of the shared database file this backend reads through the API. */
export function sharedDatabaseFile(env?: NodeJS.ProcessEnv): string {
  return databaseFile(effectiveEnv(env));
}
