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
  const report = (error: unknown) => { void vscode.window.showErrorMessage(`OpenCode History: ${error instanceof Error ? error.message : String(error)}`); };
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
    const filterLabel = tree.filter === 'active' ? 'Unarchived' : tree.filter === 'archived' ? 'Archived' : 'All';
    view.description = [filterLabel, tree.query, liveStatusLabel(status, Date.now())].filter(Boolean).join(' · ');
    // Normal V2 sessions and legacy records are counted separately — the two
    // populations are never summed into one "normal" total.
    const count = inventory ? `${describeCatalogCounts(inventory.sessions)} · ${tree.groups.length} groups · ${liveStatusLabel(status, Date.now())}${!status.fresh && status.lastRefreshAt !== null ? ` · last successful update at ${new Date(status.lastRefreshAt).toLocaleTimeString()}` : ''}` : '';
    const channel = catalog.liveStatus();
    const channelWarning = channel.state === 'degraded' ? `Live event stream interrupted, reconnecting automatically; showing the data from the last successful read (${count})${channel.warnings.length ? `\n${channel.warnings.join('\n')}` : ''}`
      : channel.state === 'stopped' ? `Live event stream not connected (data refreshes on actions or window focus; currently showing ${count})`
      : '';
    if (!inventory) view.message = 'Reading local OpenCode history…';
    else if (lastErrorMessage) view.message = `${lastErrorMessage}\n(Showing the data from the last successful read: ${count})`;
    else if (status.link === 'reconnecting') view.message = channelWarning || `Live updates interrupted, recovering… (currently showing ${count})`;
    else if (channelWarning && channel.state === 'degraded') view.message = channelWarning;
    else if (!tree.groups.length) view.message = `No matching history records (${count}). Try searching, switching the archive filter, or refreshing.`;
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
      lastErrorMessage = `Read failed: ${error instanceof Error ? error.message : String(error)}. Check the engine path and refresh.`;
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
    const query = await vscode.window.showInputBox({ title: 'Search OpenCode History', prompt: 'Enter a title or folder path; clear to show everything. Parents stay visible when a child matches.', value: tree.query });
    if (query !== undefined) { tree.query = query.trim(); tree.update(); updateDescription(); }
  });
  register('filter', async () => {
    const choice = await vscode.window.showQuickPick([{ label: 'Unarchived', value: 'active' as const }, { label: 'Archived (including required parents)', value: 'archived' as const }, { label: 'All', value: 'all' as const }], { title: 'OpenCode History · Archive Filter' });
    if (choice) { tree.filter = choice.value; tree.update(); updateDescription(); }
  });
  register('chooseEngine', async () => {
    const choice = await vscode.window.showOpenDialog({ title: 'Select the native OpenCode engine on this machine', canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { 'Windows native engine': ['exe'] } });
    if (choice?.[0]) {
      await catalog.setEnginePath(choice[0].fsPath);
      await vscode.workspace.getConfiguration('opencodeHistory').update('enginePath', choice[0].fsPath, vscode.ConfigurationTarget.Global);
      await refresh();
    }
  });
  register('restore', async () => {
    const backups = await catalog.listBackups();
    if (!backups.length) { void vscode.window.showInformationMessage('OpenCode History: no recoverable backups yet.'); return undefined; }
    const choice = await vscode.window.showQuickPick(backups.map(backup => ({
      label: backup.title || backup.backup_id,
      description: backup.backup_id,
      detail: `${new Date(backup.created_at).toLocaleString()} · ${backup.session_ids.length} sessions · ${backup.status === 'available' ? 'restorable' : backup.status === 'partial' ? 'partial backup' : 'already restored'}`,
    })), { title: 'OpenCode History · Restore Backup', placeHolder: 'Select a private local backup to restore' });
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
    if (!isLegacyRow(row)) throw new Error('Only "legacy (read-only)" records can be imported into the new version; normal sessions need no import.');
    const recover = legacyRecoveryOf(catalog);
    if (!recover) throw new Error('The current backend does not provide the legacy import interface; read-only preview and local archiving are unaffected, but importing is unavailable for now.');
    if (row.legacy?.recovery_supported === false) throw new Error(`This legacy record cannot be imported right now: ${row.legacy.warning ?? 'it contains conversion shapes that were not verified in isolation, so the conversion is refused by contract.'}`);
    const choice = confirmed ? 'Import as new-version session' : await vscode.window.showWarningMessage(`Import the legacy record "${row.title || row.session_id}" as a new-version session?`, { modal: true, detail: `Source note: this record was written by an older OpenCode (writer ${row.legacy?.writer_version ?? 'unknown version'}) after the migration completed, so the current new-version service cannot see it.\n· The import creates a new-version session with the same ID, the same message content, and the same original directory as the record; the original legacy row is fully preserved, never modified or deleted.\n· After a successful import, the "updated" time becomes the import moment.\n· No model requests are made.\n· Importing the same record again is refused; data is never overwritten.\n${row.legacy?.warning ? `\nSource uncertainty: ${row.legacy.warning}\n` : ''}\nBefore importing, stop tasks in other windows that are still using this directory.` }, 'Import as new-version session');
    if (choice !== 'Import as new-version session') return undefined;
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
    if (isLegacyRow(row)) throw new Error('Legacy records have no official delete route and cannot be deleted directly. Run "Import Legacy Record into New Version" first; after a successful import you can delete normally.');
    const descendants = tree.forest.treeById.get(row.session_id)?.descendants ?? [];
    const scope: CatalogRow[] = [row, ...descendants];
    const inUse = terminals.inUseIds();
    if (scope.some(item => inUse.has(item.session_id))) throw new Error('The OpenCode terminal for this session or one of its child records is still open. Close the corresponding terminal first.');
    if (!confirmed) {
      const choice = await vscode.window.showWarningMessage(`Delete (recoverable) "${row.title || row.session_id}" and its ${descendants.length} child records?`, { modal: true, detail: `Delete scope (by parent/child relation, not by directory):\n${scope.map(item => `${item.title || item.session_id} (${item.session_id})`).join('\n')}\n\nBefore deleting, a private local recovery backup is created (kept only in this extension's private directory, never purged automatically); it covers the verified conversation bodies and key metadata and can be restored at any time from "Restore Backup".\nStop tasks in other windows or terminals that are still using these sessions first, and do not keep writing while the deletion runs.\nIf you are unsure whether a session is still in use, archive or cancel it now and delete later.\nOther programs may still write concurrently during the deletion; the extension re-checks before deleting and refuses a delete with unfinished content, but cross-process atomic losslessness cannot be promised.` }, 'Delete (Recoverable)');
      if (choice !== 'Delete (Recoverable)') return undefined;
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
