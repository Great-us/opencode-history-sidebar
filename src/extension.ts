import * as vscode from 'vscode';
import { readFile, mkdir, writeFile, rename as renameFile } from 'node:fs/promises';
import { join, isAbsolute, resolve, relative } from 'node:path';
import { CatalogService } from './backend/catalogService';
import { HistoryTree, type HistoryNode } from './ui/tree';
import { SessionTerminals } from './ui/terminals';
import { HistoryPreview } from './ui/preview';
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
  let refreshedAt: number | undefined;
  let lastErrorMessage = '';
  const report = (error: unknown) => { void vscode.window.showErrorMessage(`OpenCode History: ${error instanceof Error ? error.message : String(error)}`); };
  /**
   * Static sidebar (user decision 2026-11-05): history is read ONLY when the
   * user presses Refresh or runs an action that changes sessions (archive,
   * delete, restore, legacy import). No event stream, polling timer, focus,
   * visibility or terminal-close refresh. When no OpenCode background service
   * is running, each read uses a private temporary server that the backend
   * stops as soon as the read finished. The last result is saved as a small
   * JSON snapshot so a new window shows it without starting any process.
   */
  const snapshotFile = join(context.globalStorageUri.fsPath, 'last-inventory.v1.json');
  const updateDescription = () => {
    const filterLabel = tree.filter === 'active' ? 'Unarchived' : tree.filter === 'archived' ? 'Archived' : 'All';
    const when = refreshedAt ? `Refreshed ${new Date(refreshedAt).toLocaleString()}` : '';
    view.description = [filterLabel, tree.query, refreshing ? 'Refreshing…' : when].filter(Boolean).join(' · ');
    // Normal V2 sessions and legacy records are counted separately — the two
    // populations are never summed into one "normal" total.
    const count = inventory ? `${describeCatalogCounts(inventory.sessions)} · ${tree.groups.length} groups${when ? ` · ${when}` : ''}` : '';
    if (!inventory) view.message = refreshing ? 'Reading local OpenCode history…' : 'Press Refresh to read local OpenCode history.';
    else if (lastErrorMessage) view.message = `${lastErrorMessage}\n(Showing the data from the last successful read: ${count})`;
    else if (!tree.groups.length) view.message = `No matching history records (${count}). Try searching, switching the archive filter, or refreshing.`;
    else view.message = [count, ...inventory.warnings].join('\n');
  };
  const applyRows = (rows: CatalogRow[]) => { tree.update(rows); updateDescription(); };
  const saveSnapshot = async (result: CatalogInventory, at: number) => {
    const temporary = `${snapshotFile}.tmp`;
    await writeFile(temporary, JSON.stringify({ at, inventory: result }));
    await renameFile(temporary, snapshotFile);
  };
  /** Shows the last refresh without starting any process; false when there is none. */
  const loadSnapshot = async (): Promise<boolean> => {
    try {
      const saved = JSON.parse(await readFile(snapshotFile, 'utf8')) as { at?: unknown; inventory?: CatalogInventory };
      if (typeof saved.at !== 'number' || !saved.inventory || !Array.isArray(saved.inventory.sessions)) return false;
      inventory = saved.inventory;
      refreshedAt = saved.at;
      tree.archiveMode = saved.inventory.archive_mode;
      applyRows(saved.inventory.sessions);
      return true;
    } catch { return false; }
  };
  const refresh = (): Promise<CatalogInventory> => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      updateDescription();
      const result = await catalog.refresh();
      inventory = result;
      lastErrorMessage = '';
      refreshedAt = Date.now();
      await terminals.reconnect(result.sessions);
      tree.archiveMode = result.archive_mode;
      applyRows(await terminals.withOwnedWorkspaces(result.sessions));
      // Open previews learn about the user-requested refresh (tail hint only; no automatic reads).
      for (const [id, preview] of previews) preview.onCatalogChanged(result.sessions.find(row => row.session_id === id), { contentSignal: true });
      void saveSnapshot(result, refreshedAt).catch(() => undefined);
      return result;
    })().catch(error => {
      lastErrorMessage = `Read failed: ${error instanceof Error ? error.message : String(error)}. Check the engine path and refresh.`;
      throw error;
    }).finally(() => { refreshing = undefined; updateDescription(); });
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
    preview.panel.onDidDispose(() => { previews.delete(row.session_id); });
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
  context.subscriptions.push(tree, view, terminals,
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('opencodeHistory.enginePath') && !test) {
        const path = vscode.workspace.getConfiguration('opencodeHistory').get<string>('enginePath');
        if (path) void catalog.setEnginePath(path).then(() => refresh()).catch(report);
      }
    }));
  updateDescription();
  // Activation starts nothing: the last refresh is shown from its snapshot.
  // Only a first-ever start (no snapshot) reads once, when the view is shown.
  let ready: Promise<CatalogInventory | undefined>;
  if (test) { ready = refresh(); void ready.catch(report); }
  else {
    ready = loadSnapshot().then(async found => {
      if (found) return inventory;
      if (!view.visible) {
        await new Promise<void>(resolve => {
          const subscription = view.onDidChangeVisibility(event => { if (event.visible) { subscription.dispose(); resolve(); } });
          context.subscriptions.push(subscription);
        });
      }
      return refresh();
    });
    void ready.catch(report);
  }
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
  return test ? { ready, tree, view, terminals, catalog, refresh, setArchived, recoverLegacy, deleteSession, previews, globalState: context.globalState, storagePath: join(context.globalStorageUri.fsPath, '..') } : { ready };
}

export async function deactivate(): Promise<void> { await service?.dispose(); service = undefined; }
