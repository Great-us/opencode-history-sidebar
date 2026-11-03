import * as vscode from 'vscode';
import { buildCatalogForest, buildCatalogGroups, archivedRowIds, isLegacyRow, type CatalogForest, type CatalogGroup, type CatalogTree, type CatalogRow, type CatalogArchiveFilter } from '../shared/sessionCatalog';

export type HistoryNode = { type: 'folder'; group: CatalogGroup } | { type: 'session'; tree: CatalogTree };

/**
 * Native Activity Bar tree: workspace groups, root/child hierarchy, archive
 * badges derived from the backend DTO. Stable node ids (`folder:<pathKey>`,
 * `<session_id>`) keep selection and expansion across live updates.
 * `running` is badged only when the backend could actually determine it AND
 * the live link is currently trusted — after a stream disconnect the old
 * value is revoked from the "运行中" wording instead of being shown as
 * current. Legacy V1-only rows are badged 旧版（只读）: preview and local
 * archive only, native terminal/delete offered after import.
 */
export class HistoryTree implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<HistoryNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  forest: CatalogForest = buildCatalogForest([]);
  query = '';
  filter: CatalogArchiveFilter = 'active';
  groups: CatalogGroup[] = [];
  /** From the inventory DTO; when 'local' the archive badge is labelled as a local mark. */
  archiveMode: 'native' | 'local' = 'native';
  /** False while the change link is untrusted (disconnect): running badges lose their claim. */
  activityTrusted = true;
  constructor(private readonly currentRows: () => readonly CatalogRow[]) {}
  update(rows?: CatalogRow[]): void {
    if (rows) this.forest = buildCatalogForest(rows);
    this.groups = buildCatalogGroups(this.forest, archivedRowIds(this.currentRows()), this.filter, this.query);
    this.changed.fire(undefined);
  }
  getTreeItem(node: HistoryNode): vscode.TreeItem {
    if (node.type === 'folder') {
      const item = new vscode.TreeItem(node.group.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `folder:${node.group.key}`;
      item.description = `${node.group.trees.length}`;
      item.tooltip = (node.group.path ?? 'The record has no working directory') + (node.group.trees.some(tree => tree.row.workspace_source === 'own-terminal') ? '\nSome directories come from this extension\'s terminal launch receipts' : '');
      item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }
    const { row, children, archived, contextOnly } = node.tree;
    const legacy = isLegacyRow(row);
    const child = row.kind !== 'root' || Boolean(row.parent_session_id);
    // Activity is badged only from verified live sources while the link is
    // trusted; a db-inferred value is labelled as inferred, and a value held
    // across a disconnect is explicitly marked unverified — never claimed as
    // currently running.
    const activityBadge = row.running === true
      ? !this.activityTrusted ? 'Active (unverified after disconnect)'
        : row.activity_source === 'db-inferred' ? 'Active (inferred)' : 'Running'
      : '';
    const activityNote = (row.running === true ? '' : '\nCurrent running state: unknown (no live running evidence)') +
      (row.last_busy_at
        ? `\nLast busy: ${row.last_busy_at}${row.last_idle_at ? ` · Last idle: ${row.last_idle_at}` : ''} (history record)`
        : '');
    const archiveLocal = (row.archive_mode ?? this.archiveMode) === 'local';
    const archiveLabel = archived ? (archiveLocal ? 'Archived (local)' : 'Archived') : '';
    const legacyLabel = legacy ? `Legacy (read-only${row.legacy?.recovery_supported === false ? ', import unavailable for now' : ''})` : '';
    const item = new vscode.TreeItem(row.title || row.session_id, children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = row.session_id;
    item.description = [row.session_id.slice(-12), legacyLabel, child ? 'Child · preview' : '', archiveLabel, contextOnly ? 'Has archived children' : '', activityBadge, row.workspace_source === 'own-terminal' ? 'Directory from launch receipt' : ''].filter(Boolean).join(' · ');
    item.tooltip = `${row.title}\n${row.workspace || 'Unknown directory'}\n${row.session_id}${legacy ? `\nLegacy record: written by an older OpenCode (writer ${row.legacy?.writer_version ?? 'unknown version'}) after the migration completed; not visible to the current service. Read-only preview and local archiving are available; run "Import Legacy Record into New Version" before opening a terminal or deleting.${row.legacy?.warning ? `\n${row.legacy.warning}` : ''}` : ''}${activityNote}${row.workspace_source === 'own-terminal' ? '\nDirectory comes from this extension\'s terminal launch receipt' : ''}${legacy ? '' : child ? '\nInternal child records cannot be resumed on their own; use the menu to open the parent main session terminal.' : row.workspace_source === 'own-terminal' ? '\nClick to switch back to the verified original terminal; this directory cannot be used to start another session.' : '\nClick to open or focus this session\'s terminal in the original working directory.'}`;
    item.contextValue = `session-${child ? 'child' : 'root'}${row.archived ? '-selfArchived' : ''}${legacy ? '-legacy' : ''}`;
    item.iconPath = new vscode.ThemeIcon(legacy ? 'clock' : child ? 'references' : archived ? 'archive' : 'comment-discussion');
    item.command = legacy || child ? { command: 'opencodeHistory.preview', title: 'Read-only Preview', arguments: [node] } : { command: 'opencodeHistory.open', title: 'Open Session Terminal', arguments: [node] };
    return item;
  }
  getChildren(node?: HistoryNode): HistoryNode[] {
    if (!node) return this.groups.map(group => ({ type: 'folder', group }));
    return (node.type === 'folder' ? node.group.trees : node.tree.children).map(tree => ({ type: 'session', tree }));
  }
  row(value: HistoryNode | string): CatalogRow {
    const row = typeof value === 'string' ? this.forest.treeById.get(value)?.row : value?.type === 'session' ? value.tree.row : undefined;
    if (!row) throw new Error('Select a session from the OpenCode history list.');
    return row;
  }
  parentRoot(row: CatalogRow): CatalogRow {
    let current = row;
    while (current.parent_session_id) {
      const parent = this.forest.treeById.get(current.parent_session_id)?.row;
      if (!parent) throw new Error('Cannot find the parent main session of this internal record.');
      current = parent;
    }
    if (current.kind !== 'root') throw new Error('This internal record has no resumable parent main session.');
    return current;
  }
  dispose(): void { this.changed.dispose(); }
}
