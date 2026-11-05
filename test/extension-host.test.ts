import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionTerminals } from '../src/ui/terminals';
import { HistoryTree } from '../src/ui/tree';
import { HistoryPreview } from '../src/ui/preview';
import * as terminalProcessModule from '../src/ui/terminalProcess';
import { terminalProcessIdentity } from '../src/ui/terminalProcess';
import { describeCatalogCounts, isLegacyRow, type CatalogRow } from '../src/shared/sessionCatalog';
import type { LogEntry } from '../src/shared/types';

/**
 * Real extension-host integration (final revision task). No mock backend, no
 * skip path: the compiled real CatalogService must exist, activation must read
 * the fully isolated synthetic home, and every check below runs against the
 * real installed engine through official APIs only — synthetic sessions are
 * seeded exclusively via import/create (never a prompt, never a model call).
 *
 * Covered here (final task card):
 * 1. A REAL same-window reload (workbench.action.reloadWindow): the native
 *    terminal process stays alive across the host restart, is re-adopted by
 *    exact PID/birth/exe/commandLine, open() returns THAT terminal (never a
 *    duplicate), any mismatched identity field refuses adoption, and other
 *    synthetic sentinel terminals stay untouched. Host PIDs before/after are
 *    recorded — not just receipt counts.
 * 2. The REAL legacy chain in the host: synthetic v1 tables + completed
 *    migration flag + post-flag rows are discovered with split counts, local
 *    archive and readonly preview; recoverLegacySession (the production
 *    backend handler reached through the confirmed Test/Development hook)
 *    produces a native V2 row; unsupported shapes refuse conversion but stay
 *    previewable; delete-with-backup and restore complete end-to-end; the
 *    original v1 row is preserved and the pre-migration remnant never shows.
 * 3. The preview dirty-follow: a catalog notification during an in-flight
 *    read is caught up automatically (controlled slow read).
 * 4. The follow rebuild walks the FRESH cursor chain (first-segment deletion
 *    + tail edit leave no stale/deleted rows), with the honest maybe-tail
 *    hint when updated_at did not move.
 * Plus the revision-task coverage: refresh lifecycle, 2-second stat signal
 * for independent native commits, preview tail, A/B terminals, archive
 * persistence across hosts, and disconnect/recovery.
 */
const POLL_STEP_MS = 200;
const SECOND_PASSWORD = 'eh-second-server-isolated';

interface RestResult { status: number; text: string; value: unknown }
type Rest = (method: string, path: string, body?: unknown) => Promise<RestResult>;

function restFor(url: string, password: string): Rest {
  const auth = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
  return async (method, path, body) => {
    const response = await fetch(url + path, {
      method,
      headers: { authorization: auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let value: unknown = null;
    try { value = JSON.parse(text); } catch { value = null; }
    return { status: response.status, text, value };
  };
}

interface ServiceFile { url?: string; pid?: number; password?: string }
function readMainService(): ServiceFile | null {
  try { return JSON.parse(readFileSync(join(process.env.XDG_STATE_HOME!, 'opencode', 'service.json'), 'utf8')) as ServiceFile; } catch { return null; }
}

/** An OS-assigned free port for this run's synthetic services (never the 28894 default, never a fixed port). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Synthetic session envelope, official import shape (backend test evidence). */
function envelope(id: string, title: string, directory: string, texts: string[], parentID: string | null): Record<string, unknown> {
  const now = Date.now();
  return {
    info: {
      id, projectID: 'global', title,
      ...(parentID !== null ? { parentID } : {}),
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now - 60000, updated: now - 30000 },
      location: { directory },
    },
    messages: texts.map((text, index) => ({ id: `msg_${id}_${index}`, type: 'user', time: { created: now - 50000 + index * 100 }, text })),
    location: { directory },
  };
}

async function importSession(rest: Rest, payload: Record<string, unknown>, label: string): Promise<void> {
  const { status, text } = await rest('POST', '/api/experimental/session/import', payload);
  assert.equal(status, 200, `seed import ${label} failed: ${text.slice(0, 300)}`);
}

function texts(prefix: string, count: number, modify?: (index: number) => string | undefined): string[] {
  return Array.from({ length: count }, (_, index) => modify?.(index) ?? `${prefix} ${index}`);
}

async function pollUntil(what: string, timeoutMs: number, predicate: () => boolean): Promise<number> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return Date.now() - start;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时（${timeoutMs}ms）：${what}`);
    await new Promise(resolve => setTimeout(resolve, POLL_STEP_MS));
  }
}

async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时（${timeoutMs}ms）：${what}`);
    await new Promise(resolve => setTimeout(resolve, POLL_STEP_MS));
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`等待超时（${timeoutMs}ms）：${what}`)), timeoutMs)),
  ]);
}

function event<T>(subscribe: vscode.Event<T>, predicate: (value: T) => boolean, timeoutMs = 40000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { disposable.dispose(); reject(new Error('VS Code event timed out')); }, timeoutMs);
    const disposable = subscribe(value => { if (predicate(value)) { clearTimeout(timer); disposable.dispose(); resolve(value); } });
  });
}

/** Minimal in-memory Memento for receipt-logic checks; no disk, no backend. */
class MemoryMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();
  constructor(private readonly fallback?: vscode.Memento) {}
  keys(): string[] { return [...this.values.keys()]; }
  get<T>(key: string, fallbackValue?: T): T {
    if (this.values.has(key)) return this.values.get(key) as T;
    if (!this.fallback) return fallbackValue as T;
    return (fallbackValue === undefined ? this.fallback.get<T>(key) : this.fallback.get<T>(key, fallbackValue)) as T;
  }
  async update(key: string, value: unknown): Promise<void> { if (value === undefined) this.values.delete(key); else this.values.set(key, value); }
}

/** Memento that serves receipts with ONE field corrupted (identity refusal checks). */
function corruptingMemento(base: vscode.Memento, sessionId: string, field: string): vscode.Memento {
  return {
    keys: () => base.keys(),
    get: <T>(key: string, fallbackValue?: T) => {
      const value = fallbackValue === undefined ? base.get<T>(key) : base.get<T>(key, fallbackValue);
      if (key !== 'terminalReceipts.v1' || !Array.isArray(value)) return value;
      return value.map((receipt: Record<string, unknown>) => receipt.sessionId === sessionId
        ? { ...receipt, [field]: `wrong-${String(receipt[field])}` }
        : receipt) as unknown as T;
    },
    update: async () => undefined,
  };
}

function previewRow(id: string, extra: Partial<CatalogRow> = {}): CatalogRow {
  return { session_id: id, title: id, workspace: 'C:/w', kind: 'root', archived: false, workspace_exists: true, parent_session_id: null, ...extra };
}

function entry(id: string, ts: number, text = id): LogEntry {
  return { id, ts, role: 'user', text };
}

/** UI-pure checks that need the VS Code API but never the backend. */
async function uiShakedown(evidence: Record<string, unknown>): Promise<void> {
  // 1. Receipt identity refuses to adopt terminals on any mismatched field.
  const state = new MemoryMemento();
  const terminals = new SessionTerminals('synthetic-owner', () => Promise.resolve('C:\\synthetic\\opencode.exe'), state);
  const syntheticRow = previewRow('ses_e64d402ecffeKOwM16Ewfp7yo5');
  assert.equal((await terminals.withOwnedWorkspaces([syntheticRow]))[0].workspace_source, undefined, 'no receipt must mean no inferred folder');
  await assert.rejects(terminals.open(syntheticRow), /original working directory does not exist/);
  await assert.rejects(terminals.open({ ...syntheticRow, session_id: '11111111-1111-4111-8111-111111111111', workspace: 'C:\\Windows' } as CatalogRow), /Not a valid OpenCode session ID/);
  await assert.rejects(terminals.open({ ...syntheticRow, schema: 'legacy-v1', legacy: { writer_version: '1.19.5', recovery_supported: true } }), /Legacy records are read-only/, 'legacy rows never open a native terminal directly');
  terminals.dispose();
  // 2. Preview: cursor paging with no truncation plus live follow merge.
  const extensionUri = vscode.extensions.getExtension('AlexWonton.opencode-history-sidebar')!.extensionUri;
  const readCalls: string[] = [];
  const paged = new HistoryPreview(syntheticRow, extensionUri, async (_id, cursor) => {
    readCalls.push(cursor ?? 'first');
    return { entries: Array.from({ length: 1205 }, (_, i) => ({ id: `history:${cursor ?? 'first'}-${i}`, ts: i + (cursor ? 1205 : 0), role: 'user' as const, text: `Paged ${cursor ?? 'first'} ${i}` })), next_cursor: cursor ? null : 'second' };
  });
  await paged.load();
  assert.equal(paged.cursor, 'second');
  await paged.load(paged.cursor!);
  assert.equal(paged.entries.length, 2410);
  await paged.follow();
  assert.equal(paged.entries.length >= 2410, true, 'a live follow re-reads the loaded window and replaces it');
  assert.match(paged.html(), /Read-only preview/);
  assert.match(paged.html(), /Updated at/);
  paged.panel.dispose();
  evidence.uiPreviewPagingAndFollow = { readCursors: readCalls, entries: paged.entries.length };
  // 3. Dirty-follow (final task card): a catalog notification that lands while
  // a read is in flight is caught up automatically — the notification routes
  // through follow(), which marks the change dirty; the completing read then
  // performs the make-up follow. No call after onCatalogChanged is needed.
  {
    let serverText = 'before external update';
    let readMillis = 450;
    let followReads = 0;
    const dirty = new HistoryPreview(previewRow('ses_eh_dirty_follow'), extensionUri, async (_id, cursor) => {
      // Snapshot taken at CALL time, BEFORE the controlled slow read: the load
      // that is in flight when the external write lands must return the OLD
      // text, so only the make-up follow can ever surface the new one.
      const snapshot = serverText;
      await new Promise(resolve => setTimeout(resolve, readMillis));
      followReads += 1;
      return { entries: [entry('m1', 1, snapshot)], next_cursor: null };
    });
    const loading = dirty.load();
    await new Promise(resolve => setTimeout(resolve, 120)); // the load read is in flight
    serverText = 'after external update';                    // the external write lands NOW
    dirty.onCatalogChanged(previewRow('ses_eh_dirty_follow'), { contentSignal: true }); // notification during loading
    await loading;
    await withTimeout(waitFor('dirty follow catches up the external update', 15000, async () =>
      dirty.html().includes('after external update') ? dirty : undefined), 20000, 'dirty follow');
    assert.equal(dirty.html().includes('before external update'), false, 'the pre-update text is gone');
    assert.ok(followReads >= 2, `the make-up follow really re-read (reads=${followReads})`);
    readMillis = 1;
    dirty.panel.dispose();
    evidence.uiDirtyFollow = { followReads, autoCatchUp: true };
  }
  // 4. Follow rebuild walks the FRESH cursor chain: first-segment deletions
  // and tail edits inside the loaded window leave nothing stale behind.
  {
    // 110 messages; the loader holds a 2-page window (100), 10 beyond it.
    // Cursor semantics are MESSAGE IDs (the official API's opaque-token shape):
    // a cursor names the last id of the previous page and the next page serves
    // strictly what follows that id. After the external deletion the whole
    // chain SHIFTS, so a stale saved cursor provably serves the wrong slice —
    // numeric offsets could not distinguish fresh from stale chains.
    let live = Array.from({ length: 110 }, (_, index) => entry(`m${index}`, index + 1));
    const pageSize = 50;
    const served: string[] = [];
    const chained = new HistoryPreview(previewRow('ses_eh_chain_rebuild'), extensionUri, async (_id, cursor) => {
      served.push(cursor ?? 'first');
      const start = cursor === undefined ? 0 : live.findIndex(item => item.id === cursor) + 1;
      if (cursor !== undefined && start === 0) throw new Error(`cursor ${cursor} no longer resolves`);
      const page = live.slice(start, start + pageSize);
      const next = start + pageSize < live.length ? page[page.length - 1]!.id : null;
      return { entries: page, next_cursor: next };
    });
    await chained.load();
    await chained.load(chained.cursor!);
    assert.equal(chained.entries.length, 100, 'window holds exactly the first two pages');
    const loadedReads = served.length; // the two load() calls ('first' + page-2 cursor m49)
    // External rewrite: the first 30 messages are deleted, message 99 is
    // edited, 5 new messages are appended beyond the loaded window.
    live = live.slice(30).map(item => item.id === 'm99' ? { ...item, text: 'tail edited by external writer' } : item);
    live.push(...Array.from({ length: 5 }, (_, index) => entry(`new${index}`, 111 + index)));
    await chained.follow();
    assert.equal(chained.entries.some(item => item.id.startsWith('m') && Number(item.id.slice(1)) < 30), false, 'deleted first-segment messages do not linger');
    assert.equal(chained.entries.find(item => item.id === 'm99')?.text, 'tail edited by external writer', 'the edited tail shows the fresh revision');
    // Deletions shrank the history: two fresh pages now cover everything
    // (80 old + 5 new), so no tail offer remains and nothing is duplicated.
    assert.equal(chained.entries.length, 85, `window rebuilt exactly along the fresh chain (got ${chained.entries.length})`);
    assert.equal(new Set(chained.entries.map(item => item.id)).size, chained.entries.length, 'no duplicates after the rebuild');
    assert.equal(chained.tailOffered, false);
    // The follow provably walked the FRESH frontier: its own reads start at
    // 'first' and page 2 follows the fresh boundary m79 — never the stale m49
    // that load #2 used before the deletion shifted the whole chain.
    assert.deepEqual(served.slice(loadedReads), ['first', 'm79'], `the follow walked fresh cursors (served ${JSON.stringify(served)})`);
    chained.panel.dispose();
    evidence.uiFollowFreshChain = { servedCursors: served, entries: chained.entries.length };
  }
  // 5. The honest maybe-tail: a real change signal offers the tail even when
  // the row's updated_at did NOT move (review 2); no signal, no offer.
  {
    let live = Array.from({ length: 120 }, (_, index) => entry(`k${index}`, index + 1));
    const hinted = new HistoryPreview(previewRow('ses_eh_hint_tail'), extensionUri, async (_id, cursor) => {
      const start = cursor === undefined ? 0 : Number(cursor);
      const page = live.slice(start, start + 50);
      return { entries: page, next_cursor: start + 50 < live.length ? String(start + 50) : null };
    });
    await hinted.load(); // 50 loaded, 70 remain beyond the window
    live.push(entry('k-late', 999, 'late message'));
    await hinted.follow(previewRow('ses_eh_hint_tail')); // row time unchanged, no signal
    assert.equal(hinted.tailOffered, false, 'no signal and no row-time change: no offer, no noise');
    hinted.onCatalogChanged(previewRow('ses_eh_hint_tail'), { contentSignal: true }); // real change signal
    await withTimeout(waitFor('hint-driven follow lands', 15000, async () => hinted.tailOffered ? hinted : undefined), 20000, 'hint follow');
    assert.equal(hinted.tailOffered, true, 'a real change signal offers the unloaded tail honestly');
    assert.equal(hinted.tailReason, 'maybe');
    assert.match(hinted.html(), /may have unloaded new content/);
    await hinted.loadLatest();
    assert.equal(hinted.entries.length, 121, 'the one-step button still reaches the very end');
    hinted.panel.dispose();
    evidence.uiHonestMaybeTail = { offered: true, oneStepEntries: 121 };
  }
}

interface RestoreResult { status: string; message: string; restored_session_ids: string[] }
interface DeleteResult { status: string; message: string; backup_id: string; deleted_session_ids: string[] }

interface ExtensionApi {
  ready: Promise<{ sessions: CatalogRow[]; data_root: string; archive_mode: string; warnings: string[] }>;
  tree: HistoryTree;
  view: vscode.TreeView<unknown>;
  terminals: SessionTerminals;
  catalog: {
    privateServerRunning: boolean;
    getEnginePath(): Promise<string>;
    readHistory(id: string, cursor?: string): Promise<{ entries: Array<{ id: string; text: string }>; next_cursor: string | null }>;
    recoverLegacySession(sessionId: string): Promise<RestoreResult>;
    restoreBackup(backupId: string): Promise<RestoreResult>;
  };
  refresh(reason?: string): Promise<unknown>;
  setArchived(value: unknown, archived: boolean): Promise<void>;
  recoverLegacy(value: unknown, confirmed?: boolean): Promise<RestoreResult>;
  deleteSession(value: unknown, confirmed?: boolean): Promise<DeleteResult>;
  previews: Map<string, HistoryPreview>;
  globalState: vscode.Memento;
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('AlexWonton.opencode-history-sidebar')!;
  const box = process.env.OPENCODE_HISTORY_TEST_BOX!;
  const phase = process.env.OPENCODE_HISTORY_TEST_PHASE!;
  const evidence: Record<string, unknown> = { phase, version: vscode.version, startedAt: new Date().toISOString() };
  assert.equal(existsSync(join(extension.extensionPath, 'out', 'src', 'backend', 'catalogService.js')), true,
    '真实后端未编译（out/src/backend/catalogService.js 缺失）——集成阶段不得以 skip 通过');
  const config = JSON.parse(await readFile(process.env.OPENCODE_HISTORY_TEST_CONFIG!, 'utf8')) as { enginePath: string; env: Record<string, string>; extraArgs: string[] };
  const api = await withTimeout(Promise.resolve(extension.activate()), 90000, 'extension activation') as unknown as ExtensionApi;
  const first = await withTimeout(api.ready, 120000, 'activation snapshot (service start included)') as { sessions: CatalogRow[]; data_root: string; archive_mode: string; warnings: string[] };
  assert.ok(first.data_root.replace(/\\/g, '/').startsWith(box.replace(/\\/g, '/')), `inventory must come from the isolated synthetic home (got ${first.data_root})`);
  await vscode.commands.executeCommand('opencodeHistory.sessions.focus');
  evidence.isolatedDataRoot = first.data_root;
  evidence.engine = config.enginePath;

  const DIR_A = join(box, 'workspace', 'dir-a');
  const DIR_B = join(box, 'workspace', 'dir-b');
  const DIR_C = join(box, 'workspace', 'dir-c');
  const A = 'ses_eh_A_root', B = 'ses_eh_B_tail', CHILD = 'ses_eh_A_child', C = 'ses_eh_C_ctrl', D = 'ses_eh_D_second';
  for (const directory of [DIR_A, DIR_B, DIR_C]) await mkdir(directory, { recursive: true });

  // The main shared service the extension is attached to (started by the
  // extension itself through the official CLI in the isolated home, on the
  // dynamically assigned port the runner configured via `service set port`).
  const service = await (async () => {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const file = readMainService();
      if (file?.url && file.password) return file;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('隔离沙箱的后台服务未就绪（service.json 缺失）。');
  })();
  const mainRest = restFor(service.url!, service.password!);
  const servicePort = Number(new URL(service.url!).port);
  assert.notEqual(servicePort, 28894, 'the isolated sandbox service must never run on the default 28894 port');
  evidence.sandboxService = { url: service.url, port: servicePort, pid: service.pid };

  let secondServer: { kill(): Promise<void> } | undefined;
  try {
    if (phase === 'primary') {
      await runPrimary(api, evidence, { box, mainRest, enginePath: config.enginePath, dirs: { a: DIR_A, b: DIR_B, c: DIR_C }, ids: { A, B, CHILD, C, D }, startSecond: async () => { secondServer = await startSecondServer(config.enginePath); return secondServer; } });
    } else if (phase === 'legacy') {
      await runLegacyPhase(api, evidence, { box, config, ids: { A, B, CHILD, C, D } });
    } else if (phase === 'reload') {
      await runReloadPhase(api, evidence, { box, config, ids: { A, C } });
    } else {
      await runPersistencePhase(api, evidence, phase, { A, C });
    }
    await uiShakedown(evidence);
  } catch (error) {
    // Evidence is written even on failure: the box is the acceptance record.
    evidence.failure = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    await writeFile(join(box, `${phase}-evidence.json`), JSON.stringify(evidence, null, 2));
    throw error;
  } finally {
    await secondServer?.kill().catch(() => undefined);
  }
  await writeFile(join(box, `${phase}-evidence.json`), JSON.stringify(evidence, null, 2));
  console.log(`OpenCode history extension-host ${phase} passed`);
}

interface PhaseContext {
  box: string;
  mainRest: Rest;
  enginePath: string;
  dirs: { a: string; b: string; c: string };
  ids: { A: string; B: string; CHILD: string; C: string; D: string };
  startSecond(): Promise<{ kill(): Promise<void> }>;
}

/**
 * An independent native OpenCode process on the same isolated DB (own event
 * bus). Its port is OS-assigned per spawn (freePort) — never the 28894
 * default and never a fixed test port another run could collide on.
 */
async function startSecondServer(enginePath: string): Promise<{ __url: string; kill(): Promise<void> }> {
  const port = await freePort();
  assert.ok(port > 0 && port !== 28894, 'dynamic port allocation failed');
  const child = spawn(enginePath, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: SECOND_PASSWORD },
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45000;
  for (;;) {
    try {
      const probe = await fetch(url + '/api/info', { headers: { authorization: 'Basic ' + Buffer.from(`opencode:${SECOND_PASSWORD}`).toString('base64') }, signal: AbortSignal.timeout(2000) });
      if (probe.ok) break;
    } catch { /* not ready yet */ }
    if (Date.now() > deadline) throw new Error('第二个隔离服务未在预期时间内就绪。');
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return {
    __url: url,
    kill: () => new Promise<void>(resolve => {
      child.on('close', () => resolve());
      child.kill();
      setTimeout(resolve, 5000);
    }),
  };
}

async function runPrimary(api: ExtensionApi, evidence: Record<string, unknown>, context: PhaseContext): Promise<void> {
  const { mainRest, dirs, ids } = context;

  // --- 1. seed through the MAIN service (SSE path also proves subscribe works) ---
  await importSession(mainRest, envelope(ids.A, 'eh-A', dirs.a, texts('A message', 55), null), ids.A);
  await importSession(mainRest, envelope(ids.B, 'eh-B', dirs.b, texts('B message', 60), null), ids.B);
  await importSession(mainRest, envelope(ids.CHILD, 'eh-A-child', dirs.a, ['child turn 1', 'child turn 2'], ids.A), ids.CHILD);
  // Static sidebar: seeding through the service changes nothing on screen
  // until the user presses Refresh (no event stream, no polling).
  await new Promise(resolve => setTimeout(resolve, 5000));
  assert.equal(api.tree.forest.treeById.has(ids.A), false, 'nothing appears without a manual refresh');
  await vscode.commands.executeCommand('opencodeHistory.refresh');
  assert.ok(api.tree.forest.treeById.has(ids.A) && api.tree.forest.treeById.has(ids.B) && api.tree.forest.treeById.has(ids.CHILD), 'Refresh brings in all seeded sessions');
  evidence.staticRefreshSeed = true;
  const childRow = api.tree.row(ids.CHILD);
  assert.equal(childRow.parent_session_id, ids.A, 'parent relation preserved in the tree');

  // --- 2. independent native process commit -> ~3s automatic reflection (2s stat) ---
  const second = await context.startSecond();
  evidence.secondServerStarted = true;
  const rest2 = secondRestFor(second, evidence);
  await importSession(rest2, envelope(ids.C, 'eh-C', dirs.c, ['C turn 1'], null), ids.C);
  await new Promise(resolve => setTimeout(resolve, 5000));
  assert.equal(api.tree.forest.treeById.has(ids.C), false, 'an independent-process commit is not picked up automatically');
  await vscode.commands.executeCommand('opencodeHistory.refresh');
  assert.ok(api.tree.forest.treeById.has(ids.C), 'Refresh shows the independent-process commit');
  await importSession(rest2, envelope(ids.D, 'eh-D-second-change', dirs.c, ['D turn 1'], null), `${ids.D} second external change`);
  await vscode.commands.executeCommand('opencodeHistory.refresh');
  assert.ok(api.tree.forest.treeById.has(ids.D), 'a second external change also appears on the next refresh');
  evidence.staticRefreshExternal = true;

  // --- 3. preview: full paging beyond the default page, then the live tail ---
  const previewA = await vscode.commands.executeCommand('opencodeHistory.preview', ids.A) as HistoryPreview;
  assert.ok(previewA, 'preview command returned a panel');
  await pollUntil('preview first page loaded', 20000, () => previewA.entries.length > 0);
  assert.equal(previewA.entries.length, 50, `default first page is 50 messages (got ${previewA.entries.length})`);
  for (let guard = 0; previewA.cursor !== null && guard < 8; guard += 1) await previewA.load(previewA.cursor!);
  assert.equal(previewA.entries.length, 55, 'full paging loads all 55 with no truncation');
  evidence.previewPaging = { entries: previewA.entries.length };
  previewA.panel.dispose();

  const previewB = await vscode.commands.executeCommand('opencodeHistory.preview', ids.B) as HistoryPreview;
  assert.ok(previewB, 'preview command returned a panel');
  await pollUntil('preview B first page loaded', 20000, () => previewB.entries.length > 0);
  for (let guard = 0; previewB.cursor !== null && guard < 8; guard += 1) await previewB.load(previewB.cursor!);
  assert.equal(previewB.entries.length, 60, 'B fully loaded before the external tail change');
  // External writer rewrites B: same id, message 58 edited, five new messages.
  await rest2('DELETE', `/api/session/${ids.B}`);
  await importSession(rest2, envelope(ids.B, 'eh-B', dirs.b,
    texts('B message', 65, index => index === 58 ? 'tail updated by external writer' : undefined), null), `${ids.B} reimport`);
  const tailLatency = await pollUntil('modified tail visible AND tail offer shown without manual refresh', 25000,
    () => previewB.html().includes('tail updated by external writer') && previewB.html().includes('Load to Latest'));
  evidence.previewTailOfferLatencyMs = tailLatency;
  assert.equal(previewB.tailOffered, true, 'the unloaded tail is explicitly offered, never silently "fresh"');
  // One explicit user step reaches the very end.
  await previewB.loadLatest();
  assert.equal(previewB.entries.length, 65, `loadLatest reaches all messages (got ${previewB.entries.length})`);
  assert.equal(previewB.cursor, null);
  assert.ok(previewB.html().includes('B message 64'), 'the newest tail message is on screen');
  evidence.previewTail = { entries: previewB.entries.length, oneStep: 'loadLatest' };
  // Real-API paged-deletion regression (resume task card): an external
  // rewrite that DELETES messages inside the loaded window must leave neither
  // stale nor duplicate rows after the automatic follow — on the real official
  // API history path, not a fake reader. 65 -> 40 messages, message 38 edited.
  await rest2('DELETE', `/api/session/${ids.B}`);
  await importSession(rest2, envelope(ids.B, 'eh-B', dirs.b,
    texts('B message', 40, index => index === 38 ? 'tail edited again by external writer' : undefined), null), `${ids.B} shrinking reimport`);
  const shrinkLatency = await pollUntil('shrunk history reflected without manual refresh (2s stat -> follow)', 25000,
    () => previewB.html().includes('tail edited again by external writer') && !previewB.html().includes('B message 55'));
  assert.equal(previewB.entries.length, 40, `the follow rebuilt the window to the shrunk history (got ${previewB.entries.length})`);
  assert.equal(new Set(previewB.entries.map(item => item.id)).size, previewB.entries.length, 'no duplicate messages after the real-API deletion');
  evidence.previewPagedDeletion = { latencyMs: shrinkLatency, entries: previewB.entries.length };
  previewB.panel.dispose();

  // --- 4. A/B terminals in the exact original directories with exact ids ---
  const engine = await api.catalog.getEnginePath();
  const ta = await withTimeout(api.terminals.open(api.tree.row(ids.A)), 60000, 'terminal A open');
  const optionsA = ta.creationOptions as vscode.TerminalOptions;
  assert.deepEqual(optionsA.shellArgs, [dirs.a, '--session', ids.A], 'argv = <original directory> --session <exact id>');
  assert.equal(optionsA.cwd, dirs.a, 'terminal cwd is the original directory');
  assert.equal(optionsA.shellPath, engine);
  const tc = await withTimeout(api.terminals.open(api.tree.row(ids.C)), 60000, 'terminal C open');
  assert.deepEqual((tc.creationOptions as vscode.TerminalOptions).shellArgs, [dirs.c, '--session', ids.C]);
  // No duplicate switching: opening A again returns the SAME terminal.
  const taAgain = await withTimeout(api.terminals.open(api.tree.row(ids.A)), 60000, 'terminal A reopen');
  assert.equal(taAgain, ta, 'reopening an owned session focuses the existing terminal, never a duplicate');
  const receipts = api.globalState.get<Array<{ sessionId: string; pid: number; engine: string; cwd: string; argv: string[] }>>('terminalReceipts.v1', []);
  const receiptA = receipts.find(receipt => receipt.sessionId === ids.A);
  assert.ok(receiptA, 'a receipt with the exact exe/command/birth/PID was persisted');
  assert.deepEqual(receiptA!.argv, [dirs.a, '--session', ids.A]);
  assert.equal(receiptA!.cwd, dirs.a);
  evidence.terminals = { argvA: receiptA!.argv, noDuplicate: true, receipts: receipts.length };
  // Close/reopen: the closed terminal is released and a new one opens.
  ta.dispose();
  await event(api.terminals.onDidCloseOwnedTerminal, id => id === ids.A, 30000);
  const taReopened = await withTimeout(api.terminals.open(api.tree.row(ids.A)), 60000, 'terminal A reopen after close');
  assert.notEqual(taReopened, ta, 'a fresh terminal opens after the owned terminal really closed');
  evidence.closeReopen = true;
  taReopened.dispose();
  // C's terminal must not leak into the later windows: all phases share one
  // workspace folder, so a terminal left alive here is auto-revived in the
  // persistence/reload hosts through the shared persistent-session state.
  tc.dispose();

  // --- 5. archive persistence (native PATCH via the backend) ---
  await api.setArchived(ids.C, true);
  await pollUntil('archived state visible in the DTO-driven tree', 20000,
    () => api.tree.forest.treeById.get(ids.C)?.row.archived === true);
  evidence.archiveSetInPrimary = true;

  // --- 6. no background service: Refresh uses a temporary private server and stops it ---
  const serviceFile = readMainService();
  assert.ok(serviceFile?.pid, 'sandbox service pid known');
  process.kill(serviceFile!.pid!);
  await new Promise(resolve => setTimeout(resolve, 1500));
  await vscode.commands.executeCommand('opencodeHistory.refresh');
  for (const id of [ids.A, ids.B, ids.CHILD, ids.C, ids.D]) {
    assert.ok(api.tree.forest.treeById.has(id), `session ${id} read through the temporary private server`);
  }
  assert.equal(api.catalog.privateServerRunning, false, 'the temporary private server is stopped right after the read');
  const after = readMainService();
  assert.ok(!after?.pid || after.pid === serviceFile!.pid, 'the extension did not start a new background service');
  evidence.privateServerReadAndStopped = true;
}

/** Rest handle for the second server: the spawn helper returns its own url. */
function secondRestFor(second: { kill(): Promise<void> }, evidence: Record<string, unknown>): Rest {
  // The URL is stashed on the handle by startSecondServer through evidence;
  // recovered here to keep the helper's contract simple.
  const url = (second as unknown as { __url?: string }).__url ?? String(evidence.__secondUrl ?? '');
  return restFor(url, SECOND_PASSWORD);
}

async function runPersistencePhase(api: ExtensionApi, evidence: Record<string, unknown>, phase: string, ids: { A: string; C: string }): Promise<void> {
  // The activation snapshot of this fresh host must already show the archive
  // persisted through the service DTO (no UI-side archive store exists).
  await pollUntil('activation snapshot of the restarted host', 30000,
    () => api.tree.forest.treeById.size > 0);
  assert.equal(api.tree.forest.treeById.get(ids.C)?.row.archived, true, 'archive persisted across the host restart (native, DTO-driven)');
  evidence.archivedPersistedAcrossHosts = true;
  // Receipts live on real disk globalState: a terminal opened in this phase
  // is backed by a persisted receipt the next host verifies (reload phase).
  const opened = await withTimeout(api.terminals.open(api.tree.row(ids.A)), 60000, 'terminal open in persistence phase');
  const receipts = api.globalState.get<Array<{ sessionId: string; argv: string[]; cwd: string }>>('terminalReceipts.v1', []);
  const receipt = receipts.find(item => item.sessionId === ids.A);
  assert.ok(receipt, 'receipt persisted on real disk globalState');
  assert.ok(receipt!.argv.includes('--session') && receipt!.argv[receipt!.argv.length - 1] === ids.A, 'receipt keeps the exact --session id');
  evidence.persistencePhase = { phase, receipts: receipts.length, opened: true };
  opened.dispose();
}

interface ReloadCheckpoint {
  aSessionId: string;
  aPid: number;
  aIdentity: { executablePath: string; commandLine: string; creationDate: string };
  aArgv: string[];
  sentinelPid: number;
  corruptReceiptFor: string;
  hostPid: number;
  at: string;
}

/**
 * REAL same-window reload (final task card item 1). Round 1 opens the native
 * terminal, records PID/birth/exe/commandLine, seeds the corrupt receipt and
 * the sentinel, then executes workbench.action.reloadWindow — the extension
 * host really restarts inside the SAME window. Round 2 (the reactivated host
 * reads the same checkpoint) proves the same LIVE process was re-adopted,
 * mismatched identity refuses adoption, and the sentinel stayed untouched.
 */
async function runReloadPhase(api: ExtensionApi, evidence: Record<string, unknown>, context: { box: string; config: { enginePath: string; env: Record<string, string>; extraArgs: string[] }; ids: { A: string; C: string } }): Promise<void> {
  const { box, config, ids } = context;
  const checkpointPath = join(box, 'reload-checkpoint.json');
  await pollUntil('activation snapshot of the reload host', 30000, () => api.tree.forest.treeById.size > 0);
  const rowA = api.tree.row(ids.A);
  if (!existsSync(checkpointPath)) {
    // ---------------- round 1: prepare, then REALLY reload the window ----------------
    const terminal = await withTimeout(api.terminals.open(rowA), 60000, 'round 1: native terminal A open');
    const aPid = await withTimeout(waitFor('round 1: terminal pid + receipt persisted', 30000, async () => {
      const pid = await terminal.processId;
      const receipts = api.globalState.get<Array<{ sessionId: string }>>('terminalReceipts.v1', []);
      return pid !== undefined && receipts.some(receipt => receipt.sessionId === ids.A) ? pid : undefined;
    }), 40000, 'round 1 receipt');
    assert.equal(terminal.exitStatus, undefined, 'the native terminal process is alive before the reload');
    const identity = await terminalProcessIdentity(aPid);
    const receiptA = api.globalState.get<Array<{ sessionId: string; argv: string[] }>>('terminalReceipts.v1', []).find(item => item.sessionId === ids.A)!;
    // A synthetic sentinel terminal owned by nobody in this window: it must
    // survive the reload untouched and never be adopted. Shown once so it
    // enters the persisted terminal layout — VS Code 1.144 does NOT restore a
    // terminal that was never displayed (ptyhost leaves it in the reconnect
    // grace and shuts the process down; observed in a real reload run).
    const sentinel = vscode.window.createTerminal({ name: 'unrelated sentinel', shellPath: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', shellArgs: ['/d', '/k', 'echo UNRELATED_SENTINEL'] });
    const sentinelPid = await sentinel.processId;
    sentinel.show();
    terminal.show(); // keep the owned terminal the active tab
    // Corrupt receipt for session C pointing at A's live PID: ONLY the birth
    // mismatches — production state that must be refused after the reload.
    const rowC = api.tree.row(ids.C);
    const receipts = api.globalState.get<Array<Record<string, unknown>>>('terminalReceipts.v1', []);
    receipts.push({ sessionId: ids.C, pid: aPid, engine: config.enginePath, cwd: rowC.workspace, argv: [rowC.workspace, '--session', ids.C], executablePath: identity.executablePath, commandLine: identity.commandLine, creationDate: 'wrong-creation-date' });
    await api.globalState.update('terminalReceipts.v1', receipts);
    const checkpoint: ReloadCheckpoint = { aSessionId: ids.A, aPid, aIdentity: identity, aArgv: receiptA.argv, sentinelPid: sentinelPid!, corruptReceiptFor: ids.C, hostPid: process.pid, at: new Date().toISOString() };
    await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));
    assert.equal(vscode.window.terminals.includes(sentinel), true, 'the sentinel is a live terminal tab of this window right before the reload');
    // Give the workbench time to flush the terminal-tab state: a tab created
    // immediately before the reload is not reliably part of the persisted
    // layout (observed: its pty sits out the reconnect grace and is shut
    // down, while terminals that existed a few seconds DO restore).
    await new Promise(resolve => setTimeout(resolve, 6000));
    evidence.reloadRound1 = { aPid, sentinelPid, hostPid: process.pid, identity, at: checkpoint.at };
    // The REAL reload: same window, extension host restarts. This promise
    // never resolves — the host is torn down by the reload itself.
    void vscode.commands.executeCommand('workbench.action.reloadWindow');
    await new Promise(() => undefined);
    return;
  }
  // ---------------- round 2: the SAME window after the real reload ----------------
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as ReloadCheckpoint;
  assert.notEqual(process.pid, checkpoint.hostPid, 'the extension host really restarted (reload window), not a third host launch');
  evidence.reloadHostPids = { before: checkpoint.hostPid, after: process.pid };
  // The persistent terminal revived with the SAME native process.
  const restored = await withTimeout(waitFor('the pre-reload native terminal is alive again (same pid)', 60000, async () => {
    const found = await Promise.all(vscode.window.terminals.map(async terminal => ({ terminal, pid: await terminal.processId })));
    return found.find(item => item.pid === checkpoint.aPid && item.terminal.exitStatus === undefined)?.terminal;
  }), 70000, 'restored terminal');
  assert.ok(restored, 'the native terminal process survived the actual window reload');
  // Exact identity: PID, birth, exe and command line all match the checkpoint.
  const identityAfter = await terminalProcessIdentity(checkpoint.aPid);
  assert.equal(identityAfter.executablePath, checkpoint.aIdentity.executablePath, 'executablePath unchanged across the reload');
  assert.equal(identityAfter.commandLine, checkpoint.aIdentity.commandLine, 'commandLine unchanged across the reload');
  assert.equal(identityAfter.creationDate, checkpoint.aIdentity.creationDate, 'process birth unchanged across the reload');
  // The sentinel survived untouched. Terminal revival after the real reload
  // is per-terminal and asynchronous — poll for the sentinel just like for
  // the restored terminal instead of racing a single immediate scan.
  const sentinelAfter = await withTimeout(waitFor('the unrelated sentinel terminal is revived (same pid)', 60000, async () => {
    const found = await Promise.all(vscode.window.terminals.map(async terminal => ({ terminal, pid: await terminal.processId })));
    const sentinel = found.find(item => item.pid === checkpoint.sentinelPid);
    return sentinel && sentinel.terminal.exitStatus === undefined ? sentinel.terminal : undefined;
  }), 70000, 'sentinel terminal');
  assert.ok(sentinelAfter, 'the unrelated sentinel terminal survived the reload untouched');
  const terminalsBeforeOpen = vscode.window.terminals.length;
  // open(A) returns THAT SAME terminal — never a new one.
  const selected = await withTimeout(api.terminals.open(api.tree.row(checkpoint.aSessionId)), 60000, 'round 2: open A re-adopts');
  assert.equal(await selected.processId, checkpoint.aPid, 'open() returned the pre-reload terminal (same pid)');
  assert.equal(vscode.window.terminals.length, terminalsBeforeOpen, 'adoption created no duplicate terminal');
  const receiptAfter = api.globalState.get<Array<{ sessionId: string; argv: string[]; pid: number }>>('terminalReceipts.v1', []).find(item => item.sessionId === checkpoint.aSessionId);
  assert.ok(receiptAfter, 'the receipt survived on real disk globalState');
  assert.deepEqual(receiptAfter!.argv, checkpoint.aArgv, 'argv is byte-identical across the reload');
  // The unrelated sentinel was never adopted: no receipt may claim its pid.
  const allReceipts = api.globalState.get<Array<{ pid: number }>>('terminalReceipts.v1', []);
  assert.equal(allReceipts.some(receipt => receipt.pid === checkpoint.sentinelPid), false, 'no receipt ever claimed the unrelated sentinel terminal');
  // The corrupt receipt (birth mismatch on a live pid) is REFUSED.
  await assert.rejects(api.terminals.open(api.tree.row(checkpoint.corruptReceiptFor)), /Cannot confirm the ownership of the existing OpenCode terminal/, 'a mismatched identity field must refuse adoption');
  assert.equal(vscode.window.terminals.length, terminalsBeforeOpen, 'the refusal created no duplicate terminal either');
  // Per-field refusal on in-memory corrupted receipts (executablePath,
  // commandLine, creationDate): each mismatch alone blocks adoption.
  for (const field of ['creationDate', 'commandLine', 'executablePath']) {
    const wrong = new SessionTerminals(api.globalState.get<string>('terminalOwner')!, () => Promise.resolve(config.enginePath), corruptingMemento(api.globalState, checkpoint.aSessionId, field), { env: config.env, extraArgs: config.extraArgs });
    try {
      await wrong.reconnect([api.tree.row(checkpoint.aSessionId)]);
      assert.equal(wrong.inUseIds().has(checkpoint.aSessionId), false, `mismatched ${field} must not adopt the restored terminal`);
      const blanked = await wrong.withOwnedWorkspaces([{ ...api.tree.row(checkpoint.aSessionId), workspace: '', workspace_source: undefined }]);
      assert.equal(blanked[0].workspace_source, undefined, `mismatched ${field} must not infer a folder`);
    } finally { wrong.dispose(); }
  }
  // Unknown native identity also blocks instead of duplicating.
  const realIdentity = terminalProcessModule.terminalProcessIdentity;
  const unknown = new SessionTerminals(api.globalState.get<string>('terminalOwner')!, () => Promise.resolve(config.enginePath), new MemoryMemento(api.globalState), { env: config.env, extraArgs: config.extraArgs });
  try {
    (terminalProcessModule as unknown as { terminalProcessIdentity: unknown }).terminalProcessIdentity = async () => { throw new Error('Synthetic CIM unavailable'); };
    await assert.rejects(unknown.open(api.tree.row(checkpoint.aSessionId)), /Cannot confirm the ownership of the existing OpenCode terminal/, 'unknown identity must refuse rather than duplicate');
    assert.equal(vscode.window.terminals.length, terminalsBeforeOpen, 'unknown identity created no duplicate');
  } finally {
    (terminalProcessModule as unknown as { terminalProcessIdentity: unknown }).terminalProcessIdentity = realIdentity;
    unknown.dispose();
  }
  // The tree of this reloaded host still holds every synthetic session and
  // the archive persisted from the primary host.
  assert.ok(api.tree.forest.treeById.has(checkpoint.aSessionId));
  assert.equal(api.tree.forest.treeById.get(ids.C)?.row.archived, true, 'archive persisted across the real reload');
  evidence.actualWindowReload = {
    nativePidBefore: checkpoint.aPid,
    nativePidAfter: await selected.processId,
    birthExeCommandEqual: true,
    argvSame: true,
    mismatchedRefused: ['creationDate', 'commandLine', 'executablePath', 'corrupt receipt (live globalState)'],
    sentinelUntouched: true,
    noDuplicate: true,
    hostRestarted: true,
  };
  selected.dispose();
}

/**
 * REAL legacy chain in the extension host (final task card item 2). Synthetic
 * v1 tables + a completed migration flag + post-flag rows are injected into
 * THIS run's isolated database only; the production backend (running in this
 * host) discovers, previews, archives, recovers, deletes and restores them
 * through the official API. recoverLegacySession is the production handler
 * reached via the confirmed Test/Development hook (activate's test surface).
 */
async function runLegacyPhase(api: ExtensionApi, evidence: Record<string, unknown>, context: { box: string; config: { enginePath: string; env: Record<string, string> }; ids: { A: string; B: string; CHILD: string; C: string; D: string } }): Promise<void> {
  const { box, ids } = context;
  const dbPath = process.env.OPENCODE_DB!;
  assert.ok(dbPath.replace(/\\/g, '/').startsWith(box.replace(/\\/g, '/')), `the injected database must belong to this run's box (got ${dbPath})`);
  const LEGACY_OK = 'ses_eh_legacy_ok';
  const LEGACY_BAD = 'ses_eh_legacy_bad';
  const LEGACY_PRE = 'ses_eh_legacy_pre';
  const DIR_L = join(box, 'workspace', 'dir-legacy');
  await mkdir(DIR_L, { recursive: true });

  // --- inject the synthetic v1 triple exactly the way the legacy probe did ---
  const flagTime = Date.now() - 200000;
  const db = new DatabaseSync(dbPath, { timeout: 10000 });
  try {
    db.exec('BEGIN');
    db.exec(`CREATE TABLE IF NOT EXISTS \`session\` (
      \`id\` text PRIMARY KEY, \`project_id\` text NOT NULL, \`workspace_id\` text, \`parent_id\` text,
      \`slug\` text NOT NULL, \`directory\` text NOT NULL, \`path\` text, \`title\` text NOT NULL,
      \`version\` text NOT NULL, \`share_url\` text, \`summary_additions\` integer, \`summary_deletions\` integer,
      \`summary_files\` integer, \`summary_diffs\` text, \`metadata\` text, \`cost\` real DEFAULT 0 NOT NULL,
      \`tokens_input\` integer DEFAULT 0 NOT NULL, \`tokens_output\` integer DEFAULT 0 NOT NULL,
      \`tokens_reasoning\` integer DEFAULT 0 NOT NULL, \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
      \`tokens_cache_write\` integer DEFAULT 0 NOT NULL, \`revert\` text, \`permission\` text,
      \`agent\` text, \`model\` text, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL,
      \`time_compacting\` integer, \`time_archived\` integer)`);
    db.exec(`CREATE TABLE IF NOT EXISTS \`message\` (
      \`id\` text PRIMARY KEY, \`session_id\` text NOT NULL, \`time_created\` integer NOT NULL,
      \`time_updated\` integer NOT NULL, \`data\` text NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS \`part\` (
      \`id\` text PRIMARY KEY, \`message_id\` text NOT NULL, \`session_id\` text NOT NULL,
      \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, \`data\` text NOT NULL)`);
    db.prepare(`INSERT INTO kv (key, value, time_created, time_updated) VALUES ('migration.v1-v2', ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, time_updated=excluded.time_updated`)
      .run(JSON.stringify({ phase: 'completed' }), flagTime, flagTime);
    const seedV1 = (id: string, created: number, assistantTextPart: boolean): void => {
      db.prepare(`INSERT INTO \`session\` (id, project_id, workspace_id, parent_id, slug, directory, path, title, version,
          share_url, summary_additions, summary_deletions, summary_files, summary_diffs, metadata, cost,
          tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          revert, permission, agent, model, time_created, time_updated, time_compacting, time_archived)
        VALUES (?, 'global', NULL, NULL, 'eh-legacy-slug', ?, 'projects/demo-legacy', ?, '1.19.5',
          NULL, 0, 0, 0, NULL, NULL, 0.0125, 11, 22, 33, 44, 55, NULL, NULL, 'build', NULL, ?, ?, NULL, NULL)`)
        .run(id, DIR_L, `EH legacy ${id}`, created, created + 11000);
      const userTime = created + 100;
      db.prepare('INSERT INTO `message` (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
        .run(`msg_${id}_u`, id, userTime, userTime + 50, JSON.stringify({ role: 'user', time: { created: userTime }, agent: 'build' }));
      db.prepare('INSERT INTO `part` (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`prt_${id}_p`, `msg_${id}_u`, id, userTime + 10, userTime + 10, JSON.stringify({ type: 'text', text: `legacy user body ${id}` }));
      const assistantTime = created + 200;
      db.prepare('INSERT INTO `message` (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
        .run(`msg_${id}_a`, id, assistantTime, assistantTime + 10500, JSON.stringify({
          parentID: `msg_${id}_u`, role: 'assistant', mode: 'primary', agent: 'build', cost: 0.0125,
          tokens: { input: 11, output: 22, reasoning: 33, cache: { read: 44, write: 55 } },
          modelID: 'eh-model', providerID: 'eh-provider',
          time: { created: assistantTime, completed: assistantTime + 10500 }, finish: 'stop',
        }));
      if (assistantTextPart) {
        db.prepare('INSERT INTO `part` (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
          .run(`prt_${id}_ap`, `msg_${id}_a`, id, assistantTime + 10, assistantTime + 10, JSON.stringify({ type: 'text', text: `legacy assistant body ${id}` }));
      }
    };
    seedV1(LEGACY_OK, Date.now() - 100000, false);      // verified shape, post-flag
    seedV1(LEGACY_BAD, Date.now() - 90000, true);       // unsupported shape, post-flag
    seedV1(LEGACY_PRE, flagTime - 500000, false);       // pre-migration remnant: never a candidate
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  evidence.legacyInjected = { dbPath, flagTime, ok: LEGACY_OK, bad: LEGACY_BAD, pre: LEGACY_PRE };

  // --- discovery: split counts, badges, readonly preview ---
  await api.refresh();
  await pollUntil('legacy candidates discovered by the production backend', 30000,
    () => api.tree.forest.treeById.has(LEGACY_OK) && api.tree.forest.treeById.has(LEGACY_BAD));
  const inventory = await api.refresh() as { sessions: CatalogRow[] };
  const legacyRows = inventory.sessions.filter(isLegacyRow);
  assert.equal(legacyRows.length, 2, 'exactly the two post-flag v1-only rows are legacy candidates');
  assert.equal(inventory.sessions.some(row => row.session_id === LEGACY_PRE), false, 'the pre-migration remnant never surfaces');
  const expectedV2 = [ids.A, ids.B, ids.CHILD, ids.C, ids.D].every(id => inventory.sessions.some(row => row.session_id === id));
  assert.ok(expectedV2, 'the v2 sessions from the earlier phases are still there');
  const countsLabel = describeCatalogCounts(inventory.sessions);
  assert.equal(countsLabel, `${inventory.sessions.length - 2} sessions · 2 legacy records`, 'counts stay split, never merged');
  const okRow = api.tree.row(LEGACY_OK) as CatalogRow;
  assert.equal(okRow.schema, 'legacy-v1');
  assert.equal(okRow.legacy?.recovery_supported, true);
  assert.equal(okRow.archive_mode, 'local');
  const badRow = api.tree.row(LEGACY_BAD) as CatalogRow;
  assert.equal(badRow.legacy?.recovery_supported, false, 'the unknown-part row is marked non-convertible');
  const tree = api.tree;
  const okItem = tree.getTreeItem({ type: 'session', tree: tree.forest.treeById.get(LEGACY_OK)! });
  assert.match(String(okItem.description), /Legacy \(read-only\)/, 'the tree badges legacy rows');
  const badItem = tree.getTreeItem({ type: 'session', tree: tree.forest.treeById.get(LEGACY_BAD)! });
  assert.match(String(badItem.description), /import unavailable for now/, 'the unsupported shape says so in the badge');
  evidence.legacyDiscovery = { countsLabel, legacyIds: legacyRows.map(row => row.session_id) };

  // --- readonly preview through the production readHistory (404 -> legacy) ---
  const preview = await vscode.commands.executeCommand('opencodeHistory.preview', LEGACY_OK) as HistoryPreview;
  assert.ok(preview, 'legacy preview opened');
  await pollUntil('legacy preview loaded', 20000, () => preview.entries.length > 0);
  assert.equal(preview.cursor, null, 'a legacy transcript has no paging cursor');
  assert.match(preview.html(), /Legacy record \(read-only preview\)/, 'the preview states its readonly nature');
  assert.ok(preview.html().includes(`legacy user body ${LEGACY_OK}`), 'the legacy body renders');
  preview.panel.dispose();
  const badPreview = await vscode.commands.executeCommand('opencodeHistory.preview', LEGACY_BAD) as HistoryPreview;
  await pollUntil('unsupported-shape preview loaded (previewable, just not convertible)', 20000, () => badPreview.entries.length > 0);
  assert.ok(badPreview.html().includes(`legacy user body ${LEGACY_BAD}`), 'the unknown-part row stays fully previewable');
  badPreview.panel.dispose();

  // --- local archive is a private flag on the legacy row ---
  await api.setArchived(LEGACY_OK, true);
  await pollUntil('legacy local archive visible', 20000, () => api.tree.forest.treeById.get(LEGACY_OK)?.row.archived === true);
  // The rendered badge comes from the ANNOTATED group node (forest nodes
  // carry archived:false by design), and the default 未归档 filter prunes an
  // archived row — read the badge the way the user sees it, under 全部.
  const previousFilter = tree.filter;
  tree.filter = 'all';
  tree.update();
  try {
    const annotated = tree.groups.flatMap(group => group.trees).find(node => node.row.session_id === LEGACY_OK);
    assert.ok(annotated, 'the archived legacy row stays reachable under the 全部 filter');
    const archivedItem = tree.getTreeItem({ type: 'session', tree: annotated });
    assert.match(String(archivedItem.description), /Archived \(local\)/, 'the badge says the archive is local');
  } finally {
    tree.filter = previousFilter;
    tree.update();
  }
  evidence.legacyLocalArchive = true;

  // --- production guards: delete/recover on legacy rows refuse with the route ---
  await assert.rejects(api.deleteSession(LEGACY_BAD, true), /Import Legacy Record into New Version/, 'deleting an unrecovered legacy row refuses');
  const recoverBad = await api.catalog.recoverLegacySession(LEGACY_BAD).then(() => 'restored', error => String(error instanceof Error ? error.message : error));
  assert.match(recoverBad, /were not verified/, 'the unsupported shape refuses conversion with a reason');

  // --- recoverLegacy -> native V2 row (production handler, Test/Development hook) ---
  const result = await withTimeout(api.recoverLegacy(LEGACY_OK, true), 120000, 'recoverLegacySession');
  assert.equal(result.status, 'restored', result.message);
  assert.deepEqual(result.restored_session_ids, [LEGACY_OK]);
  await api.refresh();
  await pollUntil('recovered row back as a normal v2 row', 30000, () => api.tree.forest.treeById.has(LEGACY_OK) && api.tree.forest.treeById.get(LEGACY_OK)?.row.schema !== 'legacy-v1');
  const recoveredRow = api.tree.row(LEGACY_OK) as CatalogRow;
  assert.notEqual(recoveredRow.schema, 'legacy-v1', 'after recovery the row presents as a normal v2 session');
  assert.equal(recoveredRow.archived, false, 'the local legacy archive marker no longer applies');
  const afterRecovery = await api.refresh() as { sessions: CatalogRow[] };
  assert.equal(describeCatalogCounts(afterRecovery.sessions), `${afterRecovery.sessions.length - 1} sessions · 1 legacy record`);
  // The ORIGINAL v1 row is still in the shared (isolated) database, untouched.
  const dbCheck = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stillThere = dbCheck.prepare('SELECT title, version FROM `session` WHERE id = ?').get(LEGACY_OK) as { title?: string } | undefined;
    assert.ok(stillThere, 'the original v1 row was preserved by the conversion');
    assert.equal(stillThere!.title, `EH legacy ${LEGACY_OK}`);
  } finally { dbCheck.close(); }
  evidence.legacyRecovered = { status: result.status, v2Row: true, originalV1Preserved: true };

  // --- native archive on the recovered v2 row (official PATCH) ---
  await api.setArchived(LEGACY_OK, true);
  await pollUntil('native archive visible on the recovered row', 20000, () => api.tree.forest.treeById.get(LEGACY_OK)?.row.archived === true);
  assert.equal(api.tree.forest.treeById.get(LEGACY_OK)?.row.schema, undefined);
  evidence.legacyRecoveredNativeArchive = true;

  // --- delete with backup -> tombstone -> restore (production handlers) ---
  const deleted = await withTimeout(api.deleteSession(LEGACY_OK, true), 300000, 'deleteSession (isolated verification host included)');
  assert.equal(deleted.status, 'deleted', deleted.message);
  assert.ok(deleted.backup_id, 'a private local recovery backup was created');
  await api.refresh();
  await pollUntil('deleted row gone from the inventory', 30000, () => !api.tree.forest.treeById.has(LEGACY_OK));
  const dbCheck2 = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const v1Still = dbCheck2.prepare('SELECT id FROM `session` WHERE id = ?').get(LEGACY_OK) as { id?: string } | undefined;
    assert.ok(v1Still, 'the original v1 row is still preserved after the v2 delete');
  } finally { dbCheck2.close(); }
  evidence.legacyDeleted = { backupId: deleted.backup_id, v1PreservedAfterDelete: true };
  const restored = await withTimeout(api.catalog.restoreBackup(deleted.backup_id), 180000, 'restoreBackup');
  assert.equal(restored.status, 'restored', restored.message);
  await api.refresh();
  await pollUntil('restored row back exactly once', 30000, () => api.tree.forest.treeById.has(LEGACY_OK));
  const rowsAfterRestore = (await api.refresh() as { sessions: CatalogRow[] }).sessions.filter(row => row.session_id === LEGACY_OK);
  assert.equal(rowsAfterRestore.length, 1, 'no duplicate legacy row resurfaced (tombstone held)');
  assert.notEqual(rowsAfterRestore[0]!.schema, 'legacy-v1');
  evidence.legacyRestored = { status: restored.status, singleRow: true };
}
