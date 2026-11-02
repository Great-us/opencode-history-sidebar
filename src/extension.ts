import * as vscode from 'vscode';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, isAbsolute, resolve, relative } from 'node:path';
import { CatalogService } from './backend/catalogService';
import { HistoryTree, type HistoryNode } from './ui/tree';
import { SessionTerminals } from './ui/terminals';
import { HistoryPreview } from './ui/preview';
import { LiveHistoryController } from './ui/liveStatus';
import { liveStatusLabel } from './shared/liveStatus';
import { describeCatalogCounts, isLegacyRow, type CatalogInventory, type CatalogRestoreResult, type CatalogRow } from './shared/sessionCatalog';

interface PrivateTestConfig { env: NodeJS.ProcessEnv; enginePath: string; extraArgs: string[] }
let service: CatalogService | undefined;

/**
 * Capability view of the legacy-recovery surface (contract "Confirmed legacy
 * record integration": recoverLegacySession(sessionId)). Structural probing
 * keeps the UI honest while the backend executor lands the method: when it is
 * absent the command explains the wait-point instead of faking success.
 */
interface LegacyRecoverySurface { recoverLegacySession(sessionId: string): Promise<CatalogRestoreResult> }
function legacyRecoveryOf(catalog: CatalogService): LegacyRecoverySurface | undefined {
  const candidate = catalog as unknown as Partial<LegacyRecoverySurface>;
  return typeof candidate.recoverLegacySession === 'function' ? candidate as LegacyRecoverySurface : undefined;
}

/**
 * Test configuration is accepted ONLY in ExtensionMode.Test/Development and
 * only with a fully isolated synthetic home: every home path absolute
 * (including the service-discovery roots XDG_STATE_HOME/XDG_CACHE_HOME) AND
 * explicit private OPENCODE_DB / OPENCODE_CONFIG paths that live under this
 * run's own isolated roots — a config pointing back at the real machine's
 * database is rejected, so a test host can never read or write real data and
 * can never discover the user's real shared service. There is no production
 * bypass flag: production always reads the real machine through the
 * backend's own discovery.
 */
async function testConfiguration(context: vscode.ExtensionContext): Promise<PrivateTestConfig | undefined> {
  if (context.extensionMode === vscode.ExtensionMode.Production || !process.env.OPENCODE_HISTORY_TEST_CONFIG) return undefined;
  const value: unknown = JSON.parse(await readFile(process.env.OPENCODE_HISTORY_TEST_CONFIG, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error('Invalid isolated test configuration');
  const config = value as Record<string, unknown>;
  const env = config.env as Record<string, unknown> | undefined;
  const keys = ['HOME', 'USERPROFILE', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA'];
  const isolationError = 'Test configuration requires all isolated home paths (including XDG_STATE_HOME/XDG_CACHE_HOME service-discovery roots) and the native OpenCode engine';
  if (!env || !keys.every(key => typeof env[key] === 'string' && isAbsolute(env[key] as string)) ||
      typeof config.enginePath !== 'string' || !isAbsolute(config.enginePath) ||
      !Array.isArray(config.extraArgs) || !config.extraArgs.every(arg => typeof arg === 'string')) throw new Error(isolationError);
  // Entry-point enforcement (package audit): the private database and config
  // file must be EXPLICIT and must belong to this isolated home — never an
  // inherited value that could point at the real machine.
  const box = process.env.OPENCODE_HISTORY_TEST_BOX;
  const contains = (parent: string, child: string): boolean => {
    const delta = relative(resolve(parent), resolve(child));
    return delta !== '' && delta !== '..' && !delta.startsWith('..\\') && !delta.startsWith('../') && !isAbsolute(delta);
  };
  if (!box || !isAbsolute(box) || !contains(box, process.env.OPENCODE_HISTORY_TEST_CONFIG) ||
      !keys.every(key => contains(box, env[key] as string))) {
    throw new Error('Every test home and the test configuration must belong to this run’s exclusive test box.');
  }
  const db = env.OPENCODE_DB, configFile = env.OPENCODE_CONFIG;
  if (typeof db !== 'string' || !isAbsolute(db) || !contains(env.XDG_DATA_HOME as string, db) ||
      typeof configFile !== 'string' || !isAbsolute(configFile) || !contains(env.XDG_CONFIG_HOME as string, configFile)) {
    throw new Error('Test configuration requires explicit private OPENCODE_DB and OPENCODE_CONFIG under this run’s isolated data/config roots.');
  }
  return { env: { ...process.env, ...(env as NodeJS.ProcessEnv) }, enginePath: config.enginePath, extraArgs: config.extraArgs as string[] };
}

export async function activate(context: vscode.ExtensionContext) {
  const test = await testConfiguration(context);
  await mkdir(context.globalStorageUri.fsPath, { recursive: true });
  service = new CatalogService({ storagePath: context.globalStorageUri.fsPath, enginePath: test?.enginePath || vscode.workspace.getConfiguration('opencodeHistory').get<string>('enginePath') || undefined, env: test?.env });
  const catalog = service;
  const tree = new HistoryTree(() => inventory?.sessions ?? []);
  const view = vscode.window.createTreeView('opencodeHistory.sessions', { treeDataProvider: tree, showCollapseAll: true });
  const terminals = new SessionTerminals(await SessionTerminals.owner(context.globalState), () => catalog.getEnginePath(), context.globalState, test ? { env: test.env, extraArgs: test.extraArgs } : undefined);
  const previews = new Map<string, HistoryPreview>();
  let inventory: CatalogInventory | undefined;
  let refreshing: Promise<CatalogInventory> | undefined;
  let snapshotTaken = false;
  let lastErrorMessage = '';
  const report = (error: unknown) => { void vscode.window.showErrorMessage(`OpenCode 历史：${error instanceof Error ? error.message : String(error)}`); };
  // Always-current status: subscribe to the backend live channel (service SSE
  // + reconcile batches), then take the activation snapshot — subscribe-before-
  // snapshot closes the vacuum window. One single timer drives the visible
  // cadence (src/ui/liveStatus.ts + supervisor decision on the probed Windows
  // fs.watch silence for WAL commits): a 2-second db/WAL stat compare while
  // the sidebar OR a preview is visible, a 60-second unconditional full API
  // reconciliation, and immediate focus/re-show reconciliation.
  const live = new LiveHistoryController({
    channel: catalog,
    onSignal: () => { void refresh('signal').catch(report); },
    onStatus: () => updateDescription(),
  });
  const updateDescription = () => {
    live.observeChannel();
    const status = live.current;
    // Old `running` values lose their claim while the link is untrusted or
    // the data is not fresh; badges re-render through the DTO of the next
    // verified snapshot.
    const trusted = status.link === 'live' && status.fresh;
    if (tree.activityTrusted !== trusted) { tree.activityTrusted = trusted; tree.update(); }
    const filterLabel = tree.filter === 'active' ? '未归档' : tree.filter === 'archived' ? '已归档' : '全部';
    view.description = [filterLabel, tree.query, liveStatusLabel(status, Date.now())].filter(Boolean).join(' · ');
    // Normal V2 sessions and legacy records are counted separately — the two
    // populations are never summed into one "normal" total.
    const count = inventory ? `${describeCatalogCounts(inventory.sessions)} · ${tree.groups.length} 个分组 · ${liveStatusLabel(status, Date.now())}${!status.fresh && status.lastRefreshAt !== null ? ` · 上次成功更新于 ${new Date(status.lastRefreshAt).toLocaleTimeString()}` : ''}` : '';
    const channel = catalog.liveStatus();
    const channelWarning = channel.state === 'degraded' ? `实时事件流中断，正在自动重连；当前显示最近一次成功读取的数据（${count}）${channel.warnings.length ? `\n${channel.warnings.join('\n')}` : ''}`
      : channel.state === 'stopped' ? `实时事件流未连接（数据在操作或窗口聚焦时刷新；当前显示 ${count}）`
      : '';
    if (!inventory) view.message = '正在读取本机 OpenCode 历史…';
    else if (lastErrorMessage) view.message = `${lastErrorMessage}\n（显示的是上次成功读取的数据：${count}）`;
    else if (status.link === 'reconnecting') view.message = channelWarning || `实时更新中断，正在恢复…（当前显示 ${count}）`;
    else if (channelWarning && channel.state === 'degraded') view.message = channelWarning;
    else if (!tree.groups.length) view.message = `没有匹配的历史记录（${count}）。可搜索、切换归档筛选或刷新。`;
    else view.message = [count, ...inventory.warnings].join('\n');
  };
  const refresh = (reason: 'manual' | 'signal' | 'timer' | 'reconnect' = 'manual'): Promise<CatalogInventory> => {
    if (refreshing) return refreshing;
    live.dispatch({ type: snapshotTaken ? 'refresh-start' : 'snapshot-start' });
    // A real change signal (or a manual/recovery refresh) also arms the
    // previews' honest tail hint: content may exist beyond a loaded window
    // even when the row's updated_at did not move (review 2). A purely
    // time-based reconciliation ('timer') must not nag with that hint.
    const contentSignal = reason === 'signal' || reason === 'manual' || reason === 'reconnect';
    let outcome!: { ok: true; at: number } | { ok: false; error: string };
    refreshing = catalog.refresh().then(async result => {
      inventory = result;
      lastErrorMessage = '';
      snapshotTaken = true;
      await terminals.reconnect(result.sessions);
      tree.archiveMode = result.archive_mode;
      tree.update(await terminals.withOwnedWorkspaces(result.sessions));
      updateDescription();
      for (const [id, preview] of previews) preview.onCatalogChanged(result.sessions.find(row => row.session_id === id), { contentSignal });
      outcome = { ok: true, at: Date.now() };
      return result;
    }).catch(error => {
      lastErrorMessage = `读取失败：${error instanceof Error ? error.message : String(error)}。请检查引擎路径后刷新。`;
      outcome = { ok: false, error: lastErrorMessage };
      throw error;
    }).finally(() => {
      // Release the in-flight slot FIRST, then dispatch the outcome: a change
      // signal that raced with this refresh (pendingSignal) must start a real
      // trailing refresh here — returning the old promise would swallow it.
      refreshing = undefined;
      live.dispatch(outcome.ok ? { type: 'refresh-ok', at: outcome.at } : { type: 'refresh-fail', error: outcome.error });
      updateDescription();
    });
    return refreshing;
  };
  const register = (name: string, handler: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(`opencodeHistory.${name}`, async (...args) => { try { return await handler(...args); } catch (error) { report(error); return undefined; } }));
  const setArchived = async (value: HistoryNode | string, archived: boolean) => {
    const row = tree.row(value);
    await catalog.setArchived(row.session_id, archived);
    await refresh();
  };
  register('refresh', () => refresh());
  register('search', async () => {
    const query = await vscode.window.showInputBox({ title: '搜索 OpenCode 历史', prompt: '输入标题或文件夹路径；清空显示全部。匹配子记录时保留父级。', value: tree.query });
    if (query !== undefined) { tree.query = query.trim(); tree.update(); updateDescription(); }
  });
  register('filter', async () => {
    const choice = await vscode.window.showQuickPick([{ label: '未归档', value: 'active' as const }, { label: '已归档（包含必要父级）', value: 'archived' as const }, { label: '全部', value: 'all' as const }], { title: 'OpenCode 历史 · 归档筛选' });
    if (choice) { tree.filter = choice.value; tree.update(); updateDescription(); }
  });
  register('chooseEngine', async () => {
    const choice = await vscode.window.showOpenDialog({ title: '选择本机 OpenCode 原生引擎', canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { 'Windows 原生引擎': ['exe'] } });
    if (choice?.[0]) {
      await catalog.setEnginePath(choice[0].fsPath);
      await vscode.workspace.getConfiguration('opencodeHistory').update('enginePath', choice[0].fsPath, vscode.ConfigurationTarget.Global);
      await refresh();
    }
  });
  register('restore', async () => {
    const backups = await catalog.listBackups();
    if (!backups.length) { void vscode.window.showInformationMessage('OpenCode 历史：暂无可恢复的备份。'); return undefined; }
    const choice = await vscode.window.showQuickPick(backups.map(backup => ({
      label: backup.title || backup.backup_id,
      description: backup.backup_id,
      detail: `${new Date(backup.created_at).toLocaleString()} · ${backup.session_ids.length} 个会话 · ${backup.status === 'available' ? '可恢复' : backup.status === 'partial' ? '部分备份' : '已恢复过'}`,
    })), { title: 'OpenCode 历史 · 恢复备份', placeHolder: '选择要还原的私有本地备份' });
    if (!choice) return undefined;
    const result = await catalog.restoreBackup(choice.description);
    if (result.status === 'restored') { await refresh(); void vscode.window.showInformationMessage(result.message); }
    else void vscode.window.showWarningMessage(result.message);
    return result;
  });
  register('open', (value: HistoryNode | string) => terminals.open(tree.row(value)));
  register('openParent', (value: HistoryNode | string) => terminals.open(tree.parentRoot(tree.row(value))));
  register('preview', async (value: HistoryNode | string) => {
    const row = tree.row(value);
    const existing = previews.get(row.session_id);
    if (existing) { existing.panel.reveal(); return existing; }
    const preview = new HistoryPreview(row, context.extensionUri, (id, cursor) => catalog.readHistory(id, cursor));
    previews.set(row.session_id, preview);
    // Preview visibility keeps the live timer running even with the sidebar
    // hidden: the tree being hidden must not stop preview updates.
    context.subscriptions.push(preview.panel.onDidChangeViewState(() => { syncLiveTimer(); }));
    preview.panel.onDidDispose(() => { previews.delete(row.session_id); syncLiveTimer(); });
    syncLiveTimer();
    await preview.load();
    return preview;
  });
  register('archive', (value: HistoryNode | string) => setArchived(value, true));
  register('unarchive', (value: HistoryNode | string) => setArchived(value, false));
  // Legacy V1-only rows: explicit, user-selected import to V2 through the
  // backend's official-通路 recoverLegacySession. Never automatic, never on
  // install/acceptance; the original V1 rows are preserved by the backend.
  const recoverLegacy = async (value: HistoryNode | string, confirmed = false) => {
    const row = tree.row(value);
    if (!isLegacyRow(row)) throw new Error('仅“旧版（只读）”记录支持导入新版；普通会话无需导入。');
    const recover = legacyRecoveryOf(catalog);
    if (!recover) throw new Error('当前后端未提供旧版导入接口；只读预览与本地归档不受影响，导入暂不可用。');
    if (row.legacy?.recovery_supported === false) throw new Error(`此旧版记录当前不支持导入：${row.legacy.warning ?? '包含未经隔离验证的转换形状，已按合同拒绝转换。'}`);
    const choice = confirmed ? '导入为新版会话' : await vscode.window.showWarningMessage(`将旧版记录“${row.title || row.session_id}”导入为新版会话？`, { modal: true, detail: `来源说明：该记录由旧版 OpenCode（写入者 ${row.legacy?.writer_version ?? '未知版本'}）在迁移完成后写入，当前新版服务端看不到它。\n· 导入后生成一条与原记录同 ID、同消息内容、同原目录的新版会话；原旧版记录行会完整保留，不会被修改或删除。\n· 导入成功后“更新时间”将变为导入时刻。\n· 不会发起任何模型请求。\n· 重复导入同一记录会被拒绝，不会覆盖数据。\n${row.legacy?.warning ? `\n来源不确定性：${row.legacy.warning}\n` : ''}\n导入前请先停止其他窗口中仍在使用该目录的任务。` }, '导入为新版会话');
    if (choice !== '导入为新版会话') return undefined;
    const result = await recover.recoverLegacySession(row.session_id);
    // A partial outcome refreshes the real state but is never reported as
    // full success and never clears unverified states.
    await refresh().catch(report);
    if (result.status === 'restored') void vscode.window.showInformationMessage(result.message);
    else void vscode.window.showWarningMessage(result.message);
    return result;
  };
  register('recoverLegacy', (value: HistoryNode | string) => recoverLegacy(value));
  const deleteSession = async (value: HistoryNode | string, confirmed = false) => {
    const row = tree.row(value);
    if (isLegacyRow(row)) throw new Error('旧版记录没有官方删除通路，不能直接删除。请先执行“将旧版记录导入新版”，导入成功后即可正常删除。');
    const descendants = tree.forest.treeById.get(row.session_id)?.descendants ?? [];
    const scope: CatalogRow[] = [row, ...descendants];
    const inUse = terminals.inUseIds();
    if (scope.some(item => inUse.has(item.session_id))) throw new Error('此会话或其子记录的 OpenCode 终端仍打开。请先关闭对应终端。');
    if (!confirmed) {
      const choice = await vscode.window.showWarningMessage(`删除（可恢复）“${row.title || row.session_id}”及其 ${descendants.length} 条子记录？`, { modal: true, detail: `删除范围（按父子关系，不按目录）：\n${scope.map(item => `${item.title || item.session_id}（${item.session_id}）`).join('\n')}\n\n删除前会生成私有本地恢复备份（仅存于本扩展私有目录，不自动清除），覆盖已验证完成的对话与关键元数据，可随时从“恢复备份”还原。\n请先停止其他窗口或终端中仍在使用这些会话的任务，删除期间不要继续写入。\n若不确定会话是否仍在使用，可先归档或取消，稍后再删除。\n删除期间其他程序仍可能同时写入；扩展会在删除前再次核对并拒绝有未完成内容的删除，但不承诺跨进程的原子无损。` }, '删除（可恢复）');
      if (choice !== '删除（可恢复）') return undefined;
    }
    const result = await catalog.deleteSession(row.session_id, inUse);
    if (result.status === 'deleted') {
      await refresh();
      void vscode.window.showInformationMessage(result.message);
    } else {
      // Partial outcome: keep the current state on screen and surface the failure.
      void vscode.window.showWarningMessage(result.message);
    }
    return result;
  };
  register('delete', (value: HistoryNode | string) => deleteSession(value));
  // One single timer for the whole visible cadence (no duplicate timers, no
  // polling framework): while the sidebar OR any preview is visible, a
  // 2-second lightweight db+WAL stat compare via the backend's
  // pollStatChange() and, every 60 ticks, one unconditional full API
  // reconciliation ('timer' — no preview tail hint). Focus/re-show reconcile
  // immediately. A hidden tree with a visible preview keeps updating. The
  // same tick also redraws the status line so the relative "x 秒前" label
  // keeps advancing — no extra timer exists for that.
  const STAT_TICK_MS = 2000;
  const FULL_RECONCILE_TICKS = 30;
  let tick = 0;
  let liveTimer: NodeJS.Timeout | undefined;
  const anySurfaceVisible = () => view.visible || [...previews.values()].some(preview => preview.panel.visible);
  const liveTick = () => {
    live.observeChannel();
    tick += 1;
    if (tick % FULL_RECONCILE_TICKS === 0) { void refresh('timer').catch(report); return; }
    live.reconcile();
    updateDescription();
  };
  const syncLiveTimer = () => {
    if (anySurfaceVisible()) {
      if (liveTimer === undefined) { tick = 0; liveTimer = setInterval(liveTick, STAT_TICK_MS); }
    } else if (liveTimer !== undefined) { clearInterval(liveTimer); liveTimer = undefined; }
  };
  const reconcileNow = (reason: 'timer' | 'reconnect' = 'timer') => { live.observeChannel(); void refresh(reason).catch(report); };
  if (view.visible) syncLiveTimer();
  context.subscriptions.push(tree, view, terminals, live,
    { dispose: () => { if (liveTimer !== undefined) { clearInterval(liveTimer); liveTimer = undefined; } } },
    terminals.onDidCloseOwnedTerminal(() => { if (anySurfaceVisible()) void refresh().catch(report); }),
    view.onDidChangeVisibility(event => { if (event.visible) { syncLiveTimer(); reconcileNow(); } else syncLiveTimer(); }),
    vscode.window.onDidChangeWindowState(state => { if (state.focused && anySurfaceVisible()) reconcileNow(); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('opencodeHistory.enginePath') && !test) {
        const path = vscode.workspace.getConfiguration('opencodeHistory').get<string>('enginePath');
        if (path) void catalog.setEnginePath(path).then(() => refresh()).catch(report);
      }
    }));
  updateDescription();
  // Subscribe BEFORE the activation snapshot (live-probe §4.1): the stream
  // then already covers writes that land while the snapshot is in flight.
  live.start();
  const ready = refresh();
  void ready.catch(report);
  if (test && context.extensionMode === vscode.ExtensionMode.Development && process.env.OPENCODE_HISTORY_TEST_BOOTSTRAP === '1') {
    // The ordinary --extensionTestsPath host deliberately uses in-memory globalState.
    // An isolated development host is necessary to verify real disk persistence and reload.
    setImmediate(async () => {
      let result: { passed: boolean; error?: string };
      try { await require(join(context.extensionPath, 'out/test/extension-host.test.js')).run(); result = { passed: true }; }
      catch (error) { result = { passed: false, error: error instanceof Error ? error.stack : String(error) }; console.error(error); }
      await writeFile(join(process.env.OPENCODE_HISTORY_TEST_BOX!, `${process.env.OPENCODE_HISTORY_TEST_PHASE}-result.json`), JSON.stringify(result, null, 2));
      await vscode.commands.executeCommand('workbench.action.quit');
    });
  }
  // Only the isolated development/test host receives direct validation hooks.
  return test ? { ready, tree, view, terminals, catalog, live, refresh, setArchived, recoverLegacy, deleteSession, previews, globalState: context.globalState, storagePath: join(context.globalStorageUri.fsPath, '..') } : { ready };
}

export async function deactivate(): Promise<void> { await service?.dispose(); service = undefined; }
