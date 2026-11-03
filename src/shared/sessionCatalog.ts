/**
 * Pure selection logic for the OpenCode session catalog (structure reused
 * from Muse Desktop, MIT; DTOs re-authored for the OpenCode contract).
 *
 * The backend serves one flat inventory of every OpenCode session found on
 * the machine. This module folds that list into the shape the panel renders —
 * workspace groups, sub-sessions nested under their parent to any depth,
 * archive filtering and name/path search — plus the preview's paging state
 * machine and page merge, without touching the backend, so every rule here
 * is unit-testable on the plain node:test runner. The UI never parses
 * database records; archive state comes from the backend DTO (`row.archived`).
 */
import { displayPath, pathKey } from "./paths";
import type { LogEntry } from "./types";

/** One session row of the machine-wide inventory (backend contract). */
export interface CatalogRow {
  session_id: string;
  workspace: string;
  /** UI display-only provenance from a verified owned receipt; never authorizes terminal creation. */
  workspace_source?: "own-terminal";
  title: string;
  kind: string;
  parent_session_id?: string | null;
  /** Official archive state from the backend DTO (Session.Info time.archived != null). */
  archived: boolean;
  created_at?: string | null;
  updated_at?: string | null;
  workspace_exists: boolean;
  /** Present only when the backend can actually determine activity; never inferred by the UI. */
  running?: boolean;
  /**
   * Provenance of activity information (live-probe DTO recommendation):
   * 'service-live' = verified from the shared service's live event stream;
   * 'db-inferred' = derived from persisted DB timestamps, which record the
   * last execution lifecycle and are NOT a heartbeat. The UI never labels a
   * db-inferred state as currently running.
   */
  activity_source?: "service-live" | "db-inferred";
  /** Last recorded execution lifecycle timestamps (ISO), when the backend has them. */
  last_busy_at?: string | null;
  last_idle_at?: string | null;
  /**
   * Which store the row was read from (contract "Confirmed legacy record
   * integration"): "legacy-v1" marks a V1-only record written by an old
   * client after migration — invisible to the current 2.2.5 API. Omitted
   * means a normal V2 row; the two populations are never summed into one
   * "normal" count.
   */
  schema?: "v2" | "legacy-v1";
  /**
   * Per-row archive mode. Legacy rows archive locally ("local"); a V2 row
   * normally follows the inventory-wide mode. Omitted = inventory default.
   */
  archive_mode?: "native" | "local";
  /** Present only on legacy rows: provenance and recovery capability. */
  legacy?: {
    writer_version: string;
    recovery_supported: boolean;
    warning?: string;
  };
}

/** True for a V1-only legacy row (readonly preview; import before managing). */
export function isLegacyRow(row: CatalogRow): boolean {
  return row.schema === "legacy-v1";
}

/**
 * Honest session counts for the status line: normal V2 sessions and legacy
 * records are counted (and displayed) separately — never merged into one
 * "N 条正常 V2" total.
 */
export function describeCatalogCounts(rows: readonly CatalogRow[]): string {
  const legacy = rows.filter(isLegacyRow).length;
  const v2 = rows.length - legacy;
  const sessions = `${v2} session${v2 === 1 ? "" : "s"}`;
  return legacy > 0 ? `${sessions} · ${legacy} legacy record${legacy === 1 ? "" : "s"}` : sessions;
}

/** One inventory scan result (backend contract). */
export interface CatalogInventory {
  sessions: CatalogRow[];
  engine_path: string;
  data_root: string;
  warnings: string[];
  archive_mode: "native" | "local";
}

/** One page of a session transcript, already normalized to LogEntry (backend contract, read-only). */
export interface CatalogHistoryPage {
  entries: LogEntry[];
  next_cursor: string | null;
  warning?: string | null;
}

/** Result of the recoverable delete routed through the backend (backend contract). */
export interface CatalogDeleteResult {
  status: "deleted" | "partial";
  message: string;
  backup_id: string;
  deleted_session_ids: string[];
}

/** One private local recovery backup kept by the backend (backend contract). */
export interface BackupSummary {
  backup_id: string;
  created_at: string;
  session_ids: string[];
  title: string;
  status: "available" | "partial" | "restored";
}

/** Result of restoring a backup through the backend (backend contract). */
export interface CatalogRestoreResult {
  status: "restored" | "partial";
  message: string;
  restored_session_ids: string[];
}

/** Which roots the main list shows. */
export type CatalogArchiveFilter = "all" | "active" | "archived";

/**
 * A session with its sub-sessions nested to any depth. `descendants` carries
 * the whole subtree flattened, so rendering, search, counts and the delete
 * scope never stop at the first level. Scope follows parent relations, never
 * directory containment.
 */
export interface CatalogTree {
  row: CatalogRow;
  /** Direct sub-sessions, newest first (each may carry its own children). */
  children: CatalogTree[];
  /** Every sub-session below this node at any depth, the subtree flattened. */
  descendants: CatalogRow[];
  /** The parent id is set but absent from the catalog; the row stays reachable. */
  orphan: boolean;
  /**
   * Effective archive state of this row for the view that produced the tree:
   * archived itself or nested under an archived ancestor (archiving a session
   * covers its whole family). Forest trees carry `false`; buildCatalogGroups
   * annotates the real value.
   */
  archived: boolean;
  /**
   * Shown in the archived view only to place archived descendants; such a row
   * is NOT archived itself and must never be badged as one.
   */
  contextOnly: boolean;
}

/** The folded inventory: full trees plus children by parent id. */
export interface CatalogForest {
  trees: CatalogTree[];
  /** Direct children keyed by parent id — a parent may itself be a child. */
  childrenByParent: Map<string, CatalogRow[]>;
  /** The full (unpruned) tree node per session id, for descendant lookups. */
  treeById: Map<string, CatalogTree>;
}

/** One workspace group of the main list. */
export interface CatalogGroup {
  /** pathKey of the workspace; "" is the uncategorized group. */
  key: string;
  /** Folder name for the header, "未分类" for the uncategorized group. */
  label: string;
  /** Cleaned full workspace path, null for the uncategorized group. */
  path: string | null;
  trees: CatalogTree[];
  /** Newest activity of any row shown in the group, 0 when no row has a timestamp. */
  latestAt: number;
}

/** Newest known activity of a row: updated_at, else created_at, else 0. */
export function catalogRowTime(row: CatalogRow): number {
  if (typeof row.updated_at === "string") {
    const updated = Date.parse(row.updated_at);
    if (Number.isFinite(updated)) return updated;
  }
  if (typeof row.created_at === "string") {
    const created = Date.parse(row.created_at);
    if (Number.isFinite(created)) return created;
  }
  return 0;
}

/**
 * The archive ids that drive the reusable pure archive helpers, derived from
 * the backend DTO — never from a UI-side globalState archive store.
 */
export function archivedRowIds(rows: readonly CatalogRow[]): string[] {
  return rows.filter(row => row.archived).map(row => row.session_id);
}

/** OpenCode session ids start with "ses" (official schema pattern ^ses); they are not UUIDs. */
export function isOpenCodeSessionId(id: string): boolean {
  return /^ses[A-Za-z0-9_-]+$/.test(id);
}

/**
 * The argv that resumes one exact OpenCode session in its historical cwd:
 * `<native exe> <sessionDirectory> --session <exactID>` — the form confirmed
 * by the inventory probe of the installed version (official CLI: positional
 * directory + `--session, -s`). No Muse-era `resume` subcommand, no UUID
 * assumption.
 */
export function sessionArgv(sessionId: string, directory: string, extraArgs: readonly string[] = []): string[] {
  if (!isOpenCodeSessionId(sessionId)) throw new Error(`Not a valid OpenCode session ID: ${sessionId}`);
  if (!directory || directory.trim() === "") throw new Error("Resuming a session requires the original working directory.");
  return [...extraArgs, directory, "--session", sessionId];
}

function byNewest(a: CatalogRow, b: CatalogRow): number {
  return catalogRowTime(b) - catalogRowTime(a);
}

/**
 * Fold the flat inventory: any row whose parent_session_id names another
 * catalog row becomes that row's child, recursively to any depth — a child of
 * a child is never a root, and grandchildren stay reachable under their
 * chain. A row whose parent id is set but absent stays top-level and marked
 * `orphan` so it cannot disappear from the list.
 */
export function buildCatalogForest(sessions: readonly CatalogRow[]): CatalogForest {
  const byId = new Map<string, CatalogRow>();
  for (const row of sessions) byId.set(row.session_id, row);
  const childrenByParent = new Map<string, CatalogRow[]>();
  const roots: CatalogRow[] = [];
  const orphanIds = new Set<string>();
  for (const row of sessions) {
    const parent = typeof row.parent_session_id === "string" &&
        row.parent_session_id !== "" && row.parent_session_id !== row.session_id
      ? row.parent_session_id
      : null;
    if (parent !== null && byId.has(parent)) {
      const list = childrenByParent.get(parent);
      if (list === undefined) childrenByParent.set(parent, [row]);
      else list.push(row);
    } else {
      roots.push(row);
      if (parent !== null) orphanIds.add(row.session_id);
    }
  }
  for (const list of childrenByParent.values()) list.sort(byNewest);
  roots.sort(byNewest);

  const treeById = new Map<string, CatalogTree>();
  // Built strictly top-down from the roots: every row has exactly one parent
  // id, so a parent-pointer loop can never hang off a legal tree — it simply
  // has no root and is never visited. No cycle machinery is needed for the
  // legal parent/child trees the backend serves.
  const build = (row: CatalogRow): CatalogTree => {
    const children = (childrenByParent.get(row.session_id) ?? []).map(build);
    const descendants: CatalogRow[] = [];
    for (const child of children) {
      descendants.push(child.row);
      for (const descendant of child.descendants) descendants.push(descendant);
    }
    const tree: CatalogTree = {
      row,
      children,
      descendants,
      orphan: orphanIds.has(row.session_id),
      archived: false,
      contextOnly: false,
    };
    treeById.set(row.session_id, tree);
    return tree;
  };
  return {
    trees: roots.map(build),
    childrenByParent,
    treeById,
  };
}

/** The rows of a pruned subtree: every kept child and everything below it. */
function subtreeRows(children: readonly CatalogTree[]): CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const child of children) {
    rows.push(child.row);
    for (const descendant of child.descendants) rows.push(descendant);
  }
  return rows;
}

/**
 * A row is effectively archived when it — or any ancestor up its parent
 * chain — is archived. `archivedIds` comes from archivedRowIds(rows). The
 * `seen` guard only stops a malformed parent loop in hostile data; the
 * backend's legal trees never reach it.
 */
export function isCatalogRowArchived(
  row: CatalogRow,
  rowsById: ReadonlyMap<string, CatalogRow>,
  archivedIds: ReadonlySet<string>,
): boolean {
  const seen = new Set<string>();
  let current: CatalogRow | undefined = row;
  while (current !== undefined && !seen.has(current.session_id)) {
    seen.add(current.session_id);
    if (archivedIds.has(current.session_id)) return true;
    const parentId: string | null = typeof current.parent_session_id === "string" &&
        current.parent_session_id !== "" && current.parent_session_id !== current.session_id
      ? current.parent_session_id
      : null;
    current = parentId === null ? undefined : rowsById.get(parentId);
  }
  return false;
}

function rowMatchesQuery(row: CatalogRow, needle: string): boolean {
  return (
    row.title.toLowerCase().includes(needle) ||
    displayPath(row.workspace).toLowerCase().includes(needle) ||
    row.workspace.toLowerCase().includes(needle)
  );
}

function directoryName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments.pop() ?? path;
}

/**
 * Apply the archive filter and the name/path search to the forest, then group
 * the surviving families by workspace path key.
 *
 * Archive semantics (one rule at every depth): archiving a row archives its
 * whole subtree — an ancestor's archive state covers its family.
 * - 全部: every row shows, each badged with its effective archive state.
 * - 未归档: effectively archived rows (and their subtrees) are pruned; an
 *   independently archived child leaves its parent visible without it.
 * - 已归档: effectively archived rows show wherever they sit, kept under the
 *   ancestors needed to place them. Those ancestors are context only and are
 *   never marked archived themselves, so an independently archived child is
 *   always findable here and restorable in place.
 *
 * A family passes the search when the root or any descendant the current view
 * still shows matches, so a hit inside a folded sub-session — grandchild
 * included — still reveals the family.
 */
export function buildCatalogGroups(
  forest: CatalogForest,
  archivedIds: readonly string[],
  filter: CatalogArchiveFilter,
  query: string,
): CatalogGroup[] {
  const archived = new Set(archivedIds);
  const needle = query.trim().toLowerCase();

  // Annotate every row with its effective archive state and prune to what the
  // filter shows. Returns null when nothing of this subtree belongs to the view.
  const annotate = (tree: CatalogTree, ancestorArchived: boolean): CatalogTree | null => {
    const rowArchived = ancestorArchived || archived.has(tree.row.session_id);
    const children: CatalogTree[] = [];
    for (const child of tree.children) {
      const annotated = annotate(child, rowArchived);
      if (annotated !== null) children.push(annotated);
    }
    if (filter === "active" && rowArchived) return null;
    if (filter === "archived" && !rowArchived && children.length === 0) return null;
    return {
      row: tree.row,
      children,
      descendants: subtreeRows(children),
      orphan: tree.orphan,
      archived: rowArchived,
      contextOnly: filter === "archived" && !rowArchived,
    };
  };

  const groups = new Map<string, CatalogGroup>();
  for (const root of forest.trees) {
    const tree = annotate(root, false);
    if (tree === null) continue;
    if (
      needle !== "" &&
      !rowMatchesQuery(tree.row, needle) &&
      !tree.descendants.some((row) => rowMatchesQuery(row, needle))
    ) {
      continue;
    }
    const workspace = tree.row.workspace.trim();
    const key = workspace === "" ? "" : pathKey(workspace);
    let group = groups.get(key);
    if (group === undefined) {
      const path = workspace === "" ? null : displayPath(workspace);
      group = {
        key,
        label: path === null ? "Uncategorized" : directoryName(path),
        path,
        trees: [],
        latestAt: 0,
      };
      groups.set(key, group);
    }
    group.trees.push(tree);
    group.latestAt = Math.max(
      group.latestAt,
      catalogRowTime(tree.row),
      ...tree.descendants.map(catalogRowTime),
    );
  }
  return [...groups.values()].sort((a, b) => b.latestAt - a.latestAt);
}

/**
 * Merge one more page into the loaded transcript of the catalog preview.
 *
 * Keep every loaded page, dedupe by the stable entry id and order by time,
 * with no cap and no truncation — the catalog stays fully browsable. A
 * re-sent id (cursor drift between pages, or a live follow re-reading the
 * first page) resolves to the freshly fetched revision. Entries with the
 * same timestamp keep the server's received order (its contract is
 * time_created ASC, id ASC): the sort is stable, so equal-time entries are
 * never reshuffled.
 */
export function mergeCatalogEntries(
  existing: readonly LogEntry[],
  incoming: readonly LogEntry[],
): LogEntry[] {
  const byId = new Map<string, LogEntry>();
  for (const entry of existing) byId.set(entry.id, entry);
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.ts - b.ts);
}

/** The transcript pages loaded for one selection, merged across "load more". */
export interface CatalogPreview {
  sessionId: string;
  entries: LogEntry[];
  nextCursor: string | null;
  warning: string | null;
}

/**
 * Paging state of the preview column. The transitions are pure: the panel
 * wires them to its own state and keeps a sequence guard for answers that
 * arrive after another read started — such late answers are dropped before
 * they ever reach these functions.
 */
export interface CatalogPaging {
  /** Pages loaded so far; null until the first page of a selection lands. */
  preview: CatalogPreview | null;
  /** The first page of the current selection is in flight. */
  opening: boolean;
  /** A "load more" request is in flight. */
  loadingMore: boolean;
  /** Last read failure; every successful page and every new selection clears it. */
  error: string | null;
}

/** No selection, nothing loaded, nothing in flight. */
export function catalogPagingIdle(): CatalogPaging {
  return { preview: null, opening: false, loadingMore: false, error: null };
}

/**
 * Selecting (or re-opening) a row starts from a blank preview. Everything from
 * the previous selection resets — including a "load more" still in flight,
 * whose late answer the caller's sequence guard will drop — so the new
 * selection can always page further instead of inheriting a stuck flag.
 */
export function catalogPagingOnSelect(): CatalogPaging {
  return { preview: null, opening: true, loadingMore: false, error: null };
}

/** A "load more" request started for the loaded preview. */
export function catalogPagingLoadMoreStarted(state: CatalogPaging): CatalogPaging {
  return { ...state, loadingMore: true };
}

/**
 * A page arrived for the current selection: the opening page becomes the
 * preview, a later page merges into the pages already loaded. Any error from
 * a previous failed attempt clears — the retry succeeded.
 */
export function catalogPagingPageLoaded(
  state: CatalogPaging,
  sessionId: string,
  entries: LogEntry[],
  nextCursor: string | null,
  warning: string | null,
): CatalogPaging {
  if (state.opening) {
    return {
      preview: { sessionId, entries, nextCursor, warning },
      opening: false,
      loadingMore: false,
      error: null,
    };
  }
  const preview = state.preview;
  if (preview === null || preview.sessionId !== sessionId) return state;
  return {
    preview: {
      sessionId,
      entries: mergeCatalogEntries(preview.entries, entries),
      nextCursor,
      warning: warning ?? preview.warning,
    },
    opening: false,
    loadingMore: false,
    error: null,
  };
}

/**
 * A read failed. An opening failure leaves no preview at all; a paging
 * failure keeps every page already on screen — only the attempt failed, and
 * retrying stays possible.
 */
export function catalogPagingFailed(state: CatalogPaging, message: string): CatalogPaging {
  return { ...state, opening: false, loadingMore: false, error: message };
}

/** "Load more" may start only with a loaded preview, a remaining cursor and no read in flight. */
export function catalogCanLoadMore(paging: CatalogPaging): boolean {
  return (
    paging.preview !== null &&
    paging.preview.nextCursor !== null &&
    !paging.opening &&
    !paging.loadingMore
  );
}

/**
 * Live-follow window rules (preview tail fix). A follow re-reads the pages the
 * panel already shows — the loaded window — instead of only the first page, so
 * updates and deletions inside the loaded range replace stale content instead
 * of merging over it. The walk stops when the window is covered or the chain
 * ends; both rules are pure for unit testing.
 */
export function followWindowComplete(fetched: number, previousCount: number, frontier: string | null): boolean {
  return frontier === null || fetched >= previousCount;
}

/**
 * After a follow, the panel must visibly offer the unloaded tail when new
 * content may exist beyond the loaded window — either because the row's own
 * time advanced, or because a real change signal (message/reconcile batch)
 * arrived while updated_at did not move (review 2: updated_at is not
 * guaranteed to change). The notice wording stays honest about which case it
 * is; never a silent "fresh" that hides new content. One explicit user step
 * (load latest) then walks the remaining pages.
 */
export function followOffersTail(frontier: string | null, mayHaveNew: boolean): boolean {
  return frontier !== null && mayHaveNew;
}

/**
 * Rebuild the loaded window from freshly re-read pages: wholesale replace
 * (re-sent ids dedupe to the fresh revision, order by time) so a modified or
 * deleted message never leaves wrong old data on screen.
 */
export function rebuildLoadedWindow(pages: readonly (readonly LogEntry[])[]): LogEntry[] {
  let merged: LogEntry[] = [];
  for (const page of pages) merged = mergeCatalogEntries(merged, page);
  return merged;
}
