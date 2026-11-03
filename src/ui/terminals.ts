import * as vscode from 'vscode';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildCatalogForest, isOpenCodeSessionId, isLegacyRow, sessionArgv, type CatalogRow } from '../shared/sessionCatalog';
import { terminalProcessIdentity, type ProcessIdentity } from './terminalProcess';

const MARKER = 'OPENCODE_HISTORY_TERMINAL_OWNER';
const SESSION = 'OPENCODE_HISTORY_TERMINAL_SESSION';

export interface TerminalTestOptions { env: NodeJS.ProcessEnv; extraArgs: string[] }
interface TerminalReceipt extends ProcessIdentity { sessionId: string; pid: number; engine: string; cwd: string; argv: string[] }

/**
 * Own only terminals this extension created, identified by the persisted
 * private creation marker and the exact observed native process identity
 * (exe path, full command line, creation birth time, PID). Never adopt a
 * terminal by its display name, and never let a stale or inferred display
 * cwd authorize creating a new terminal.
 *
 * The resume argv is the official `native exe --session <exactID>` form in
 * the session's historical cwd (inventory probe of the installed version);
 * there is no Muse-era `resume` subcommand.
 */
export class SessionTerminals implements vscode.Disposable {
  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly opening = new Map<string, Promise<vscode.Terminal>>();
  private readonly receipts: Map<string, TerminalReceipt>;
  private readonly reconnectFailures = new Map<string, string>();
  private readonly verifiedReceipts = new Set<string>();
  private readonly ownedClosed = new vscode.EventEmitter<string>();
  readonly onDidCloseOwnedTerminal = this.ownedClosed.event;
  private readonly closed: vscode.Disposable;
  constructor(private readonly owner: string, private readonly engine: () => Promise<string>, private readonly state: vscode.Memento, private readonly test?: TerminalTestOptions) {
    this.receipts = new Map(state.get<TerminalReceipt[]>('terminalReceipts.v1', []).map(receipt => [receipt.sessionId, receipt]));
    this.closed = vscode.window.onDidCloseTerminal(terminal => {
      for (const [id, owned] of this.terminals) if (owned === terminal) {
        this.terminals.delete(id);
        this.receipts.delete(id);
        this.verifiedReceipts.delete(id);
        void this.state.update('terminalReceipts.v1', [...this.receipts.values()]);
        this.ownedClosed.fire(id);
      }
    });
  }
  static async owner(state: vscode.Memento): Promise<string> {
    const saved = state.get<string>('terminalOwner');
    if (saved) return saved;
    const owner = randomUUID();
    await state.update('terminalOwner', owner);
    return owner;
  }
  inUseIds(): ReadonlySet<string> {
    for (const [id, terminal] of this.terminals) if (terminal.exitStatus !== undefined) this.terminals.delete(id);
    return new Set([...this.terminals.keys(), ...this.opening.keys()]);
  }
  async withOwnedWorkspaces(rows: readonly CatalogRow[]): Promise<CatalogRow[]> {
    const workspaces = new Map<string, string>();
    const forest = buildCatalogForest(rows);
    for (const root of forest.trees) {
      const row = root.row;
      if (row.kind !== 'root' || row.parent_session_id || row.workspace.trim()) continue;
      const terminal = this.terminals.get(row.session_id);
      const receipt = this.receipts.get(row.session_id);
      // These receipts were created only from an official, existing cwd plus exact native launch proof.
      if (!terminal || terminal.exitStatus !== undefined || !receipt || await terminal.processId !== receipt.pid) continue;
      if (!this.verifiedReceipts.has(row.session_id)) {
        try {
          const identity = await terminalProcessIdentity(receipt.pid);
          if (identity.executablePath !== receipt.executablePath || identity.commandLine !== receipt.commandLine || identity.creationDate !== receipt.creationDate) continue;
          this.verifiedReceipts.add(row.session_id);
        } catch { continue; } // Ownership is unknown; keep the directory explicitly unknown.
      }
      workspaces.set(row.session_id, receipt.cwd);
      for (const child of root.descendants) if (!child.workspace.trim()) workspaces.set(child.session_id, receipt.cwd);
    }
    return rows.map(row => workspaces.has(row.session_id) ? { ...row, workspace: workspaces.get(row.session_id)!, workspace_source: 'own-terminal' as const } : row);
  }
  async reconnect(rows: readonly CatalogRow[]): Promise<void> {
    if (this.terminals.size && rows.every(row => this.terminals.has(row.session_id))) return;
    const engine = await this.engine();
    for (const row of rows) {
      const known = this.terminals.get(row.session_id);
      if (known && known.exitStatus === undefined) continue;
      this.reconnectFailures.delete(row.session_id);
      // A receipt always carries the launch cwd; a row without one can never match.
      if (!row.workspace) continue;
      const args = sessionArgv(row.session_id, row.workspace, this.test?.extraArgs ?? []);
      // VS Code 1.144 usually loses env/argv/cwd in creationOptions on an
      // actual reload. When they DO survive, the private marker alone must
      // never outrank the persisted receipt: with a receipt present, the
      // candidate must still pass the exact native identity check below, so
      // any mismatched field (exe/command/birth/pid) refuses adoption.
      const marked = vscode.window.terminals.find(candidate => {
        const options = candidate.creationOptions as vscode.TerminalOptions;
        return candidate.exitStatus === undefined && options.env?.[MARKER] === this.owner &&
          options.env?.[SESSION] === row.session_id && options.shellPath === engine &&
          options.cwd === row.workspace && Array.isArray(options.shellArgs) &&
          options.shellArgs.length === args.length && options.shellArgs.every((arg, index) => arg === args[index]);
      });
      if (marked && !this.receipts.has(row.session_id)) { this.terminals.set(row.session_id, marked); continue; }
      const receipt = this.receipts.get(row.session_id);
      if (!receipt || receipt.engine !== engine || (row.workspace && receipt.cwd !== row.workspace) || receipt.argv.length !== args.length || receipt.argv.some((arg, index) => arg !== args[index])) continue;
      // Our own launch receipt plus exact native process identity closes the
      // reload API gap: the terminal found by marker or by PID is adopted only
      // when exe path, full command line and process birth all match.
      const candidate = marked ?? (await Promise.all(vscode.window.terminals.map(async item => ({ terminal: item, pid: await item.processId })))).find(item => item.pid === receipt.pid)?.terminal;
      if (!candidate || candidate.exitStatus !== undefined) continue;
      try {
        const identity = await terminalProcessIdentity(receipt.pid);
        if (identity.executablePath === receipt.executablePath && identity.commandLine === receipt.commandLine && identity.creationDate === receipt.creationDate) {
          this.terminals.set(row.session_id, candidate);
          this.verifiedReceipts.add(row.session_id);
        } else this.reconnectFailures.set(row.session_id, 'Process identity does not match the launch receipt.');
      } catch (error) { this.reconnectFailures.set(row.session_id, error instanceof Error ? error.message : String(error)); }
    }
  }
  async open(row: CatalogRow): Promise<vscode.Terminal> {
    if (isLegacyRow(row)) throw new Error('Legacy records are read-only and cannot open a native terminal directly. Run "Import Legacy Record into New Version" first, then open it after a successful import.');
    if (!isOpenCodeSessionId(row.session_id)) throw new Error(`The history record's session ID is not a valid OpenCode session ID (it should start with "ses"): ${row.session_id}`);
    if (row.kind !== 'root' || row.parent_session_id) throw new Error('Internal child records support preview only. Use "Open Parent Main Session Terminal".');
    if (vscode.env.remoteName) throw new Error('This is local OpenCode history; open the session terminal in a local VS Code window.');
    if (!vscode.workspace.isTrusted) throw new Error('Opening an OpenCode terminal requires a trusted workspace. Manage workspace trust in VS Code first.');
    const existing = this.terminals.get(row.session_id);
    if (existing && existing.exitStatus === undefined) { existing.show(); return existing; }
    await this.reconnect([row]);
    const restored = this.terminals.get(row.session_id);
    if (restored && restored.exitStatus === undefined) { restored.show(); return restored; }
    const unresolved = this.reconnectFailures.get(row.session_id);
    if (unresolved) throw new Error(`Cannot confirm the ownership of the existing OpenCode terminal after reload, so it was kept. Use the original terminal directly, or close it and retry. ${unresolved}`);
    const pending = this.opening.get(row.session_id);
    if (pending) { const terminal = await pending; terminal.show(); return terminal; }
    const create = this.create(row);
    this.opening.set(row.session_id, create);
    try { return await create; } finally { this.opening.delete(row.session_id); }
  }
  private async create(row: CatalogRow): Promise<vscode.Terminal> {
    if (row.workspace_source === 'own-terminal') throw new Error('This directory comes from this extension\'s terminal launch receipt and can only switch back to the verified live terminal. Refresh the history before opening a new terminal.');
    if (!row.workspace || !(await stat(row.workspace).catch(() => undefined))?.isDirectory()) {
      throw new Error(`The original working directory does not exist, so a terminal cannot be opened safely: ${row.workspace || '(the record has no directory)'}`);
    }
    const shellPath = await this.engine();
    const argv = sessionArgv(row.session_id, row.workspace, this.test?.extraArgs ?? []);
    const terminal = vscode.window.createTerminal({
      name: `OpenCode ${row.session_id.slice(-12)} · ${row.title.slice(0, 40)}`,
      shellPath,
      shellArgs: argv,
      cwd: row.workspace,
      env: { ...this.test?.env, [MARKER]: this.owner, [SESSION]: row.session_id },
      iconPath: new vscode.ThemeIcon('history'),
      isTransient: false,
    });
    this.terminals.set(row.session_id, terminal);
    terminal.show();
    try {
      const pid = await terminal.processId;
      if (pid !== undefined && terminal.exitStatus === undefined) {
        const identity = await terminalProcessIdentity(pid);
        if (resolve(identity.executablePath).toLowerCase() !== resolve(shellPath).toLowerCase()) throw new Error('The terminal process does not match the selected OpenCode engine.');
        if (terminal.exitStatus === undefined && vscode.window.terminals.includes(terminal)) {
          this.receipts.set(row.session_id, { sessionId: row.session_id, pid, engine: shellPath, cwd: row.workspace, argv, ...identity });
          this.verifiedReceipts.add(row.session_id);
          await this.state.update('terminalReceipts.v1', [...this.receipts.values()]);
        }
      }
    } catch (error) { void vscode.window.showWarningMessage(`The OpenCode terminal opened, but the post-reload switching receipt could not be saved: ${error instanceof Error ? error.message : String(error)}`); }
    vscode.window.setStatusBarMessage('OpenCode terminal opened. If the session is occupied by another window, follow the CLI prompts.', 6000);
    return terminal;
  }
  dispose(): void {
    this.closed.dispose();
    this.ownedClosed.dispose();
    // VS Code owns live terminal persistence. Deactivation must not interrupt work.
    this.terminals.clear();
  }
}
