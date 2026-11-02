import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { CatalogRow, CatalogHistoryPage } from '../shared/sessionCatalog';
import { catalogRowTime, followOffersTail, followWindowComplete, isLegacyRow, mergeCatalogEntries, rebuildLoadedWindow } from '../shared/sessionCatalog';
import type { LogEntry } from '../shared/types';
import { escapeHtml, renderEntries } from './render';

/**
 * Read-only transcript preview. Entries render directly with cursor paging
 * and no cap or truncation. The page's CSP keeps every remote URL inert.
 *
 * Live follow (always-current status, revision fix): when the extension
 * reconciles a new inventory snapshot it calls onCatalogChanged(row). A
 * visible panel re-reads the WHOLE loaded window — walking the freshly
 * returned cursor chain page by page (never a stale saved cursor, so deletes
 * inside the loaded range cannot overlap or skip pages) — and replaces it
 * wholesale, so modified or deleted messages inside the loaded range never
 * leave wrong old data on screen. A follow that arrives while a read is in
 * flight is marked dirty (including catalog notifications: onCatalogChanged
 * always routes through follow, which marks dirty under load) and redone when
 * that read completes, so a change during loading is never lost. When pages
 * remain beyond the window, the panel visibly offers the tail — definitively
 * when the row's own time advanced, and as an honest "may have updates" hint
 * when a real change signal arrived but the row time did not move (review 2:
 * updated_at is not guaranteed to change). One explicit user step ("加载到最新")
 * then walks the remaining cursor chain to the end; the background never
 * pulls the full history unconditionally. A hidden panel is marked stale and
 * follows on re-show. Scroll position is preserved by the webview script.
 */
export class HistoryPreview {
  readonly panel: vscode.WebviewPanel;
  entries: LogEntry[] = [];
  cursor: string | null = null;
  private loading = false;
  private dirty = false;
  private warning = '';
  private error = '';
  private stale = false;
  /** True when the row moved while unloaded pages remain: the tail offer is on screen. */
  tailOffered = false;
  /** Why the tail offer shows: 'new' = the row's own time advanced; 'maybe' = only an honest change hint. */
  tailReason: 'new' | 'maybe' | null = null;
  /** A real change signal arrived that a follow has not consumed yet (honest hint). */
  private hinted = false;
  /** Cursors that fetched pages 2..N of the loaded window (chain-aligned). */
  private fetchLog: string[] = [];
  private lastUpdateAt: number | null = null;
  /** catalogRowTime of the row when its transcript was last confirmed loaded. */
  private seenRowTime = 0;
  private disposed = false;
  private readonly nonce = randomBytes(18).toString('base64');
  constructor(private row: CatalogRow, private readonly extensionUri: vscode.Uri, private readonly read: (id: string, cursor?: string) => Promise<CatalogHistoryPage>) {
    this.panel = vscode.window.createWebviewPanel('opencodeHistory.preview', `预览 · ${row.title || row.session_id}`, vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')], retainContextWhenHidden: true });
    this.panel.webview.onDidReceiveMessage(message => {
      if (message?.type === 'more' && (this.cursor || this.error) && !this.loading) void this.load(this.cursor ?? undefined);
      if (message?.type === 'latest' && !this.loading) void this.loadLatest();
    });
    this.panel.onDidChangeViewState(event => {
      if (event.webviewPanel.visible && this.stale && !this.loading) void this.follow();
    });
    this.panel.onDidDispose(() => { this.disposed = true; });
    this.render();
  }
  get legacy(): boolean { return isLegacyRow(this.row); }
  async load(cursor?: string): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = '';
    this.render();
    try {
      const page = await this.read(this.row.session_id, cursor);
      this.entries = mergeCatalogEntries(this.entries, page.entries);
      if (cursor !== undefined) this.fetchLog.push(cursor);
      this.cursor = page.next_cursor ?? null;
      this.warning = page.warning ?? this.warning;
      this.lastUpdateAt = Date.now();
      this.seenRowTime = Math.max(this.seenRowTime, catalogRowTime(this.row));
      this.stale = false;
    } catch (error) { this.error = String(error instanceof Error ? error.message : error); }
    finally { this.loading = false; this.redoIfDirty(); this.render(); }
  }
  /**
   * Live follow: re-read the loaded window and replace it wholesale. The walk
   * follows the FRESHLY returned cursor of each page (never a stale saved
   * cursor), bounded by the number of pages the window already holds — so
   * deletions inside the loaded range can neither leave stale rows behind nor
   * make the walk skip/overlap pages, and the background still never pulls
   * beyond the window. Growth beyond the window raises the visible tail offer
   * (definitive when the row time advanced, an honest hint when only a change
   * signal arrived) instead of a dishonest "fresh".
   */
  async follow(row?: CatalogRow): Promise<void> {
    if (row) this.row = row;
    if (this.disposed) return;
    if (this.loading) { this.dirty = true; return; }
    this.loading = true;
    this.error = '';
    this.render();
    try {
      const previousCount = this.entries.length;
      const maxPages = this.fetchLog.length + 1; // pages currently in the loaded window
      const hinted = this.hinted;
      this.hinted = false;
      const rowTimeAdvanced = catalogRowTime(this.row) > this.seenRowTime;
      const pages: LogEntry[][] = [];
      const newLog: string[] = [];
      let cursor: string | undefined = undefined;
      let frontier: string | null = null;
      let fetched = 0;
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const page = await this.read(this.row.session_id, cursor);
        pages.push(page.entries);
        fetched += page.entries.length;
        frontier = page.next_cursor ?? null;
        if (followWindowComplete(fetched, previousCount, frontier)) break;
        // Next page follows the NEW chain: the frontier this read just returned.
        cursor = frontier!;
        newLog.push(cursor);
      }
      this.entries = rebuildLoadedWindow(pages);
      this.fetchLog = newLog;
      this.cursor = frontier;
      const mayHaveNew = previousCount > 0 && (rowTimeAdvanced || hinted);
      this.tailOffered = followOffersTail(this.cursor, mayHaveNew);
      this.tailReason = this.tailOffered ? (rowTimeAdvanced ? 'new' : 'maybe') : null;
      this.lastUpdateAt = Date.now();
      this.seenRowTime = Math.max(this.seenRowTime, catalogRowTime(this.row));
      this.stale = false;
    } catch (error) { this.error = String(error instanceof Error ? error.message : error); }
    finally { this.loading = false; this.redoIfDirty(); this.render(); }
  }
  /**
   * The one explicit user step from the tail offer: walk the remaining cursor
   * chain to the very end (an empty page ends the chain per the backend
   * contract), merging every new page. The bounded loop only guards against a
   * pathological never-ending cursor chain; if it ever trips, the cursor and
   * the tail offer both STAY so the same one-step button continues from the
   * current position — full history always stays reachable, never silently
   * capped. No background path calls this.
   */
  async loadLatest(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = '';
    this.render();
    try {
      let guard = 0;
      for (;;) {
        const cursor = this.cursor ?? undefined;
        if (cursor === undefined || guard++ >= 2000) break;
        const page = await this.read(this.row.session_id, cursor);
        this.entries = mergeCatalogEntries(this.entries, page.entries);
        this.fetchLog.push(cursor);
        this.cursor = page.next_cursor ?? null;
        if (this.cursor === null || page.entries.length === 0) break;
      }
      if (guard >= 2000) {
        this.warning = '已连续加载大量分页仍未到末尾；可再次点击“加载到最新”从当前位置继续。';
        this.tailOffered = true; // keep the continuation: cursor is intact, the button stays.
        this.tailReason = 'maybe';
      } else this.tailOffered = false;
      this.lastUpdateAt = Date.now();
      this.seenRowTime = Math.max(this.seenRowTime, catalogRowTime(this.row));
    } catch (error) { this.error = String(error instanceof Error ? error.message : error); }
    finally { this.loading = false; this.redoIfDirty(); this.render(); }
  }
  /**
   * Called by the extension after every reconciled snapshot, with the
   * refreshed row. A real change signal (SSE batch / stat-change reconcile /
   * manual refresh) additionally sets the honest hint so a tail beyond the
   * window is offered even when the row's updated_at did not move. Always
   * routes through follow() while visible — follow itself marks the change
   * dirty when a read is in flight, so a catalog notification during loading
   * is caught up right after that read completes.
   */
  onCatalogChanged(row?: CatalogRow, hint?: { contentSignal?: boolean }): void {
    if (this.disposed) return;
    if (row && row.session_id === this.row.session_id) this.row = row;
    if (hint?.contentSignal) this.hinted = true;
    if (this.panel.visible) void this.follow();
    else this.stale = true;
    this.render();
  }
  /** A change that arrived during an in-flight read is redone, never dropped. */
  private redoIfDirty(): void {
    if (!this.dirty || this.disposed) return;
    this.dirty = false;
    void this.follow();
  }
  html(): string {
    const webview = this.panel.webview;
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'preview.css'));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'preview.js'));
    const freshness = this.stale
      ? '内容可能过期，切换到本页后自动刷新'
      : this.lastUpdateAt === null ? '' : `更新于 ${new Date(this.lastUpdateAt).toLocaleTimeString()}`;
    const tailNotice = this.tailOffered
      ? this.tailReason === 'new'
        ? `<p class="notice" role="status">本会话有新内容位于已加载范围之外。<button id="latest">加载到最新</button></p>`
        : `<p class="notice" role="status">本机会话数据有变化；本会话可能还有未加载的新内容。<button id="latest">加载到最新</button></p>`
      : '';
    const legacyNotice = this.legacy
      ? `<p class="notice">旧版记录（只读预览）。打开终端或删除前需先执行“将旧版记录导入新版”。</p>`
      : '';
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${this.nonce}'; img-src 'none'; font-src 'none';"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head><body><h1>${escapeHtml(this.row.title || this.row.session_id)}</h1><p class="muted">只读预览 · ${escapeHtml(this.row.workspace)}<br>${escapeHtml(this.row.session_id)}</p>${legacyNotice}${this.warning ? `<p class="notice">${escapeHtml(this.warning)}</p>` : ''}${tailNotice}${freshness ? `<p class="muted">${escapeHtml(freshness)}</p>` : ''}${renderEntries(this.entries)}${this.error ? `<p role="alert">${escapeHtml(this.error)}</p>` : ''}<footer><p>已加载 ${this.entries.length} 条记录${this.cursor ? '，还有更多' : this.loading ? '' : ' · 已到末尾'}</p>${this.loading ? '<p>正在读取…</p>' : ''}${!this.loading && (this.cursor || this.error) ? '<button id="more">加载更多 / 重试</button>' : ''}</footer><script nonce="${this.nonce}" src="${script}"></script></body></html>`;
  }
  private render(): void { if (!this.disposed) this.panel.webview.html = this.html(); }
}
