/**
 * Normalization of official OpenCode session/message data into the shared
 * catalog DTOs (backend-internal; the UI never parses database records).
 *
 * Shapes come from the installed 2.2.5 probe evidence, not old docs:
 * - Session.Info carries id/title/parentID/time{created,updated,archived,busy,
 *   idle}/location.directory (work/opencode-probe/export-P.json).
 * - Messages are a discriminated union: user/synthetic = {id,time,text,...};
 *   assistant = {id,time,content:[reasoning|text|tool|...],...}. Tool parts
 *   carry name + state{status,input,content,metadata} (probe5 fidelity set).
 *
 * Unknown message/part types are validated once at the boundary: they are
 * rendered as explicit system entries with their raw JSON and counted in the
 * page warning — never silently dropped and never allowed to fail the page.
 */
import { existsSync } from "node:fs";
import type { LogEntry, LogRole, RichContent } from "../shared/types";
import type { CatalogRow } from "../shared/sessionCatalog";
import type { SessionInfo } from "./opencodeApi";

/** CatalogRow plus the activity/legacy fields proposed by the probes (DTO need). */
export interface CatalogRowLive extends CatalogRow {
  /** Last recorded execution window (epoch ms), from persisted session time. */
  last_busy_at?: string | null;
  last_idle_at?: string | null;
  /** Where any activity claim on this row comes from; absent = unknown. */
  activity_source?: "service-live" | "db-inferred";
  /** Row-level schema marker: legacy v1-only rows only (v2 rows omit it). */
  schema?: "v2" | "legacy-v1";
  /** Row-level archive mode: 'local' only for legacy rows archived privately. */
  archive_mode?: "native" | "local";
  /** Legacy provenance and conversion capability (legacy rows only). */
  legacy?: { writer_version: string; recovery_supported: boolean; warning?: string };
}

function iso(epoch: number | null | undefined): string | null {
  return typeof epoch === "number" && Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function directoryExists(directory: string): boolean {
  try {
    // Synchronous existence probe only — never opens or locks the database.
    return existsSync(directory);
  } catch {
    return false;
  }
}

export function toCatalogRow(info: SessionInfo): CatalogRowLive {
  const directory = info.location?.directory ?? "";
  const row: CatalogRowLive = {
    session_id: info.id,
    title: info.title && info.title.trim() !== "" ? info.title : "<未命名会话>",
    workspace: directory,
    parent_session_id: info.parentID ?? null,
    kind: info.parentID ? "child" : "root",
    archived: typeof info.time?.archived === "number",
    created_at: iso(info.time?.created),
    updated_at: iso(info.time?.updated ?? info.time?.created),
    workspace_exists: directory !== "" && directoryExists(directory),
    last_busy_at: iso(info.time?.busy),
    last_idle_at: iso(info.time?.idle),
    // Persisted timestamps are lifecycle records, not a heartbeat (live probe
    // §4.4): without a live execution observation the row claims nothing.
    activity_source: undefined,
  };
  return row;
}

interface NormalizedMessage {
  id: string;
  time?: { created?: number };
  type?: string;
  text?: string;
  /** Compaction/system variants carry summary/description instead of text. */
  summary?: string;
  description?: string;
  content?: unknown[];
}

export interface NormalizedPage {
  entries: LogEntry[];
  /** Count of message/part shapes the normalizer did not recognize. */
  unknown: number;
}

function textOf(message: NormalizedMessage): string {
  if (typeof message.text === "string") return message.text;
  if (typeof message.summary === "string") return message.summary;
  if (typeof message.description === "string") return message.description;
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toolSummary(part: Record<string, unknown>): string {
  const name = typeof part.name === "string" ? part.name : "未知工具";
  const state = asRecord(part.state);
  const status = state !== null && typeof state.status === "string" ? state.status : "unknown";
  const lines = [`工具调用 ${name}（${status}）`];
  if (state !== null && state.input !== undefined) {
    lines.push("输入：", "```json", safeJson(state.input), "```");
  }
  const output = state?.content;
  if (Array.isArray(output)) {
    const text = output
      .map(item => {
        const record = asRecord(item);
        if (record === null) return safeJson(item);
        if (typeof record.text === "string") return record.text;
        return safeJson(record);
      })
      .join("\n");
    if (text !== "") lines.push("输出：", "```json", text, "```");
  }
  return lines.join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function roleFor(type: string): LogRole | null {
  switch (type) {
    case "user":
    case "synthetic":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
    case "compaction":
    case "idle":
      return "system";
    default:
      return null;
  }
}

/**
 * Convert one page of official messages. Order is preserved exactly as the
 * server returns it (order=asc): one source message may expand to several
 * entries (reasoning/text/tool parts), each with a stable part-qualified id
 * so paging merges and live re-reads dedupe correctly.
 */
export function toLogEntries(messages: readonly unknown[]): NormalizedPage {
  const entries: LogEntry[] = [];
  let unknown = 0;
  for (const raw of messages) {
    const message = asRecord(raw);
    if (message === null || typeof message.id !== "string" || typeof message.type !== "string") {
      unknown += 1;
      continue;
    }
    const id: string = message.id;
    const type: string = message.type;
    const normalized = message as unknown as NormalizedMessage;
    const ts = typeof normalized.time?.created === "number" ? normalized.time.created : 0;
    const role = roleFor(type);
    if (role === null) {
      unknown += 1;
      entries.push({
        id: `${id}#unknown`,
        ts,
        role: "system",
        text: `未识别的消息类型 ${type}（已原样保留）：\n\`\`\`json\n${safeJson(message)}\n\`\`\``,
      });
      continue;
    }
    if (!Array.isArray(normalized.content)) {
      entries.push({ id, ts, role, text: textOf(normalized) });
      continue;
    }
    const rich: RichContent[] = [];
    let partIndex = 0;
    let produced = 0;
    for (const rawPart of normalized.content) {
      const part = asRecord(rawPart);
      const partId = `${id}#${partIndex}`;
      if (part === null || typeof part.type !== "string") {
        unknown += 1;
        entries.push({ id: `${partId}?`, ts, role: "system", text: `未识别的消息部件（已原样保留）：\n\`\`\`json\n${safeJson(rawPart)}\n\`\`\`` });
        produced += 1;
      } else if (part.type === "text" && typeof part.text === "string") {
        entries.push({ id: partId, ts, role: "assistant", text: part.text });
        produced += 1;
      } else if (part.type === "reasoning" && typeof part.text === "string") {
        entries.push({ id: partId, ts, role: "thinking", text: part.text });
        produced += 1;
      } else if (part.type === "tool") {
        entries.push({ id: partId, ts, role: "tool", text: toolSummary(part) });
        produced += 1;
      } else if (part.type === "file") {
        rich.push({
          type: "file",
          mediaType: typeof part.mimeType === "string" ? part.mimeType : "application/octet-stream",
          path: typeof part.url === "string" ? part.url : "",
          sourceToolName: typeof part.name === "string" ? part.name : "",
        });
        produced += 1;
      } else {
        unknown += 1;
        entries.push({ id: `${partId}?`, ts, role: "system", text: `未识别的部件类型 ${part.type}（已原样保留）：\n\`\`\`json\n${safeJson(part)}\n\`\`\`` });
        produced += 1;
      }
      partIndex += 1;
    }
    if (produced === 0 && rich.length === 0) {
      // An assistant message whose parts carried nothing renderable: keep the
      // message itself visible rather than dropping it from the transcript.
      entries.push({ id, ts, role, text: textOf(normalized) });
    }
    if (rich.length > 0) {
      const anchor = entries.find(entry => entry.id === id) ?? entries[entries.length - 1];
      if (anchor !== undefined) anchor.richContent = rich;
    }
  }
  return { entries, unknown };
}
