/** Minimal, browser-independent transcript types (shape adapted from Muse Desktop, MIT). */
export type LogRole = "user" | "assistant" | "thinking" | "subagent" | "system" | "tool";

export interface RichContent {
  type: string;
  mediaType: string;
  path: string;
  sourceToolName: string;
  width?: number;
  height?: number;
}

/**
 * One normalized transcript entry. The backend converts official OpenCode
 * message/part data into this shape; the UI never parses database records.
 */
export interface LogEntry {
  id: string;
  ts: number;
  role: LogRole;
  text: string;
  agentId?: string;
  itemId?: string;
  turnId?: string;
  itemRevision?: number;
  outputRef?: string;
  richContent?: RichContent[];
  open?: boolean;
  childSessionId?: string;
  objective?: string;
  subagentRole?: string;
  depth?: number;
  clientMessageId?: string;
  failed?: boolean;
}
