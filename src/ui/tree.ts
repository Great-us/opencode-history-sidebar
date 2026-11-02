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
      item.tooltip = (node.group.path ?? '记录未提供工作目录') + (node.group.trees.some(tree => tree.row.workspace_source === 'own-terminal') ? '\n部分目录来自本扩展终端启动记录' : '');
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
      ? !this.activityTrusted ? '活动（中断后未证实）'
        : row.activity_source === 'db-inferred' ? '活动（推断）' : '运行中'
      : '';
    const activityNote = (row.running === true ? '' : '\n当前运行状态：未知（未取得实时运行证据）') +
      (row.last_busy_at
        ? `\n最近执行：${row.last_busy_at}${row.last_idle_at ? ` · 最近空闲：${row.last_idle_at}` : ''}（历史记录）`
        : '');
    const archiveLocal = (row.archive_mode ?? this.archiveMode) === 'local';
    const archiveLabel = archived ? (archiveLocal ? '已归档（本地）' : '已归档') : '';
    const legacyLabel = legacy ? `旧版（只读${row.legacy?.recovery_supported === false ? '，暂不可导入' : ''}）` : '';
    const item = new vscode.TreeItem(row.title || row.session_id, children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = row.session_id;
    item.description = [row.session_id.slice(-12), legacyLabel, child ? '子记录 · 预览' : '', archiveLabel, contextOnly ? '包含归档子记录' : '', activityBadge, row.workspace_source === 'own-terminal' ? '目录来自启动记录' : ''].filter(Boolean).join(' · ');
    item.tooltip = `${row.title}\n${row.workspace || '目录未知'}\n${row.session_id}${legacy ? `\n旧版记录：由旧版 OpenCode（写入者 ${row.legacy?.writer_version ?? '未知版本'}）在迁移完成后写入，当前服务端不可见。只读预览与本地归档可用；打开终端或删除前请先执行“将旧版记录导入新版”。${row.legacy?.warning ? `\n${row.legacy.warning}` : ''}` : ''}${activityNote}${row.workspace_source === 'own-terminal' ? '\n目录来自本扩展终端启动记录' : ''}${legacy ? '' : child ? '\n内部子记录不能单独恢复；可从菜单打开父主会话终端。' : row.workspace_source === 'own-terminal' ? '\n点击切回已验证的原终端；此目录不能用来另开会话。' : '\n点击在原工作目录打开或聚焦本会话终端。'}`;
    item.contextValue = `session-${child ? 'child' : 'root'}${row.archived ? '-selfArchived' : ''}${legacy ? '-legacy' : ''}`;
    item.iconPath = new vscode.ThemeIcon(legacy ? 'clock' : child ? 'references' : archived ? 'archive' : 'comment-discussion');
    item.command = legacy || child ? { command: 'opencodeHistory.preview', title: '只读预览', arguments: [node] } : { command: 'opencodeHistory.open', title: '打开会话终端', arguments: [node] };
    return item;
  }
  getChildren(node?: HistoryNode): HistoryNode[] {
    if (!node) return this.groups.map(group => ({ type: 'folder', group }));
    return (node.type === 'folder' ? node.group.trees : node.tree.children).map(tree => ({ type: 'session', tree }));
  }
  row(value: HistoryNode | string): CatalogRow {
    const row = typeof value === 'string' ? this.forest.treeById.get(value)?.row : value?.type === 'session' ? value.tree.row : undefined;
    if (!row) throw new Error('请从 OpenCode 历史记录中选择会话。');
    return row;
  }
  parentRoot(row: CatalogRow): CatalogRow {
    let current = row;
    while (current.parent_session_id) {
      const parent = this.forest.treeById.get(current.parent_session_id)?.row;
      if (!parent) throw new Error('找不到此内部记录的父主会话。');
      current = parent;
    }
    if (current.kind !== 'root') throw new Error('此内部记录没有可恢复的父主会话。');
    return current;
  }
  dispose(): void { this.changed.dispose(); }
}
