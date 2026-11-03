/**
 * Live change subscription (backend-internal; live-probe §4 DTO).
 *
 * The channel the always-current status runs on, built strictly from what the
 * two dependency probes measured on the installed 2.2.5:
 *
 * - Main path: one SSE connection to the user's shared background service.
 *   It carries every client-path write of that service (live probe S2,
 *   create→event ≈46ms) and nothing from other server processes (cross
 *   probe: 0 events). `server.connected` marks the subscription live; the
 *   stream is volatile by contract — events missed while down are gone, so
 *   recovery re-emits a full reconcile batch instead of pretending a socket
 *   badge makes data fresh.
 * - Fallback signal for external/standalone writers: on Windows fs.watch is
 *   silent for opencode's steady-state WAL commits (live probe G1) while the
 *   WAL mtime changes on every commit — so content changes are detected by
 *   stat comparison (`pollStatChange`) at reconcile trigger points, and the
 *   directory watcher is kept only for structural events (db replaced,
 *   service.json appearing/disappearing), which it does deliver reliably.
 *
 * Interface contract (supervisor decision, revision item D): the CALLER — the
 * UI — owns the one and only 2-second timer while the sidebar/preview is
 * visible and calls `pollStatChange()` on that cadence (plus focus/re-show
 * and the 60s full reconcile). This channel never self-ticks: there is no
 * periodic stat timer here, so no duplicate polling can run while hidden.
 *
 * Batches are coalesced in a short window; consumers run one refresh at a
 * time and treat `origin:"reconcile"` as "re-read everything".
 */
import { watch, statSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { dataRoot, serviceFile, stateRoot } from "./paths";
import { subscribeServiceEvents, type OpenCodeServiceConnection, type ServiceEvent } from "./opencodeApi";

/** One coalesced change notification (live probe §4 DTO). */
export interface CatalogChangeHint {
  kind: "session.metadata" | "session.messages" | "session.activity" | "session.removed" | "project";
  sessionIds?: string[];
  /** Raw event types folded into this hint (diagnostic; extra to the report DTO). */
  eventTypes?: string[];
}

export interface CatalogChangeBatch {
  receivedAt: number;
  origin: "sse" | "reconcile";
  hints: CatalogChangeHint[];
}

export type LiveChannelState = "stopped" | "live" | "degraded";

export interface LiveChannelStatus {
  state: LiveChannelState;
  source: "service-sse" | "trigger-reconcile";
  serviceUrl?: string;
  lastEventAt?: number;
  lastReconcileAt?: number;
  warnings: string[];
}

const COALESCE_MS = 200;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10000;

function hintKind(eventType: string): CatalogChangeHint["kind"] | null {
  if (eventType === "session.deleted") return "session.removed";
  if (eventType === "project.updated" || eventType.startsWith("project.")) return "project";
  if (
    eventType.startsWith("session.inbox.") ||
    eventType === "session.synthetic" ||
    eventType.startsWith("session.step.") ||
    eventType.startsWith("session.text.") ||
    eventType.startsWith("session.tool.") ||
    eventType.startsWith("session.compaction.")
  ) {
    return "session.messages";
  }
  if (
    eventType.startsWith("session.execution.") ||
    eventType === "session.status" ||
    eventType === "session.idle"
  ) {
    return "session.activity";
  }
  if (eventType.startsWith("session.")) return "session.metadata";
  return null;
}

/** In-memory execution observations for `running` (service-live scope only). */
export class ExecutionTracker {
  private readonly active = new Map<string, number>();

  observe(eventType: string, sessionId: string | undefined, at: number): void {
    if (sessionId === undefined) return;
    if (eventType === "session.execution.started") this.active.set(sessionId, at);
    else if (
      eventType === "session.execution.succeeded" ||
      eventType === "session.execution.failed" ||
      eventType === "session.execution.interrupted"
    ) {
      this.active.delete(sessionId);
    }
  }

  /**
   * Drop every observation: after a stream gap nothing previously seen may
   * reappear as trusted Running — activity is only claimed from evidence
   * observed within the current live stream (interim review item).
   */
  clear(): void {
    this.active.clear();
  }

  /** True only for executions this service itself reported as started. */
  isLiveActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  ids(): Set<string> {
    return new Set(this.active.keys());
  }
}

export interface LiveChannelOptions {
  connection: OpenCodeServiceConnection;
  env: NodeJS.ProcessEnv;
  onBatch: (batch: CatalogChangeBatch) => void;
  onStatusChange?: (status: LiveChannelStatus) => void;
  execution: ExecutionTracker;
}

export class LiveChannel {
  private status: LiveChannelStatus = { state: "stopped", source: "trigger-reconcile", warnings: [] };
  private listeners = 0;
  private abort: AbortController | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private coalesceTimer: NodeJS.Timeout | null = null;
  private pendingHints: CatalogChangeHint[] = [];
  private pendingOrigin: "sse" | "reconcile" = "sse";
  private watchers: FSWatcher[] = [];
  private statBaseline = "";
  private disposed = false;

  constructor(private readonly options: LiveChannelOptions) {}

  current(): LiveChannelStatus {
    return { ...this.status, serviceUrl: this.status.serviceUrl };
  }

  /** Attach a listener; the first attach starts the subscription machinery. */
  acquire(): void {
    this.listeners += 1;
    if (this.listeners === 1 && !this.disposed) void this.start();
  }

  release(): void {
    this.listeners = Math.max(0, this.listeners - 1);
    if (this.listeners === 0) this.stopMachinery();
  }

  private setStatus(patch: Partial<LiveChannelStatus>): void {
    this.status = { ...this.status, ...patch };
    this.options.onStatusChange?.(this.current());
  }

  private async start(): Promise<void> {
    this.startStructuralWatchers();
    this.statBaseline = this.statFingerprint();
    await this.connectStream();
  }

  private stopMachinery(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.coalesceTimer !== null) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    this.abort?.abort();
    this.abort = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.setStatus({ state: "stopped", warnings: [] });
  }

  private async connectStream(): Promise<void> {
    if (this.disposed || this.listeners === 0) return;
    try {
      const service = await this.options.connection.connect();
      const controller = await subscribeServiceEvents(
        service,
        undefined,
        event => this.onServiceEvent(event),
        error => this.onStreamDown(error),
        () => this.onStreamConnected(),
      );
      if (this.disposed || this.listeners === 0) {
        controller.abort();
        return;
      }
      this.abort = controller;
      this.reconnectAttempts = 0;
      this.setStatus({ state: "live", source: "service-sse", serviceUrl: service.url });
    } catch (error) {
      this.onStreamDown(error instanceof Error ? error.message : String(error));
    }
  }

  private onServiceEvent(event: ServiceEvent): void {
    this.options.execution.observe(event.type, event.data?.sessionID, Date.now());
    const kind = hintKind(event.type);
    if (kind === null) return;
    this.buffer({ kind, sessionIds: event.data?.sessionID ? [event.data.sessionID] : undefined, eventTypes: [event.type] }, "sse");
    this.status.lastEventAt = Date.now();
  }

  private onStreamConnected(): void {
    // A (re)established stream proves nothing about the gap that just closed:
    // demand a full reconcile before anything is called fresh again. The
    // disconnect warning set by onStreamDown is now RECOVERED — leaving it
    // behind would show a stale "interrupted" warning on a live channel
    // (resume-card handoff item). Unrelated warnings (e.g. watcher errors)
    // stay.
    this.setStatus({
      state: "live",
      source: "service-sse",
      warnings: this.status.warnings.filter(warning => !warning.startsWith("Event stream interrupted")),
    });
    this.buffer({ kind: "session.metadata", eventTypes: ["reconcile.after.reconnect"] }, "reconcile");
  }

  private onStreamDown(error: string): void {
    if (this.disposed || this.listeners === 0) return;
    this.abort = null;
    // Nothing observed before the gap may survive as trusted Running state.
    this.options.execution.clear();
    this.setStatus({ state: "degraded", warnings: [`Event stream interrupted: ${error}`] });
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectAttempts += 1;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectStream();
    }, delay);
  }

  private buffer(hint: CatalogChangeHint, origin: "sse" | "reconcile"): void {
    if (this.pendingOrigin !== origin && this.pendingHints.length > 0) {
      this.flush();
    }
    this.pendingOrigin = origin;
    this.pendingHints.push(hint);
    if (this.coalesceTimer !== null) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      this.flush();
    }, COALESCE_MS);
  }

  private flush(): void {
    if (this.pendingHints.length === 0) return;
    const batch: CatalogChangeBatch = {
      receivedAt: Date.now(),
      origin: this.pendingOrigin,
      hints: this.pendingHints,
    };
    this.pendingHints = [];
    try {
      this.options.onBatch(batch);
    } finally {
      if (this.pendingOrigin === "reconcile") this.status.lastReconcileAt = batch.receivedAt;
    }
  }

  /**
   * Structural watchers only: db file replacement (restore) and the service
   * discovery file appearing/disappearing. fs.watch stays silent for WAL
   * commits on Windows (live probe) — content changes go through stat polling.
   */
  private startStructuralWatchers(): void {
    const roots: Array<{ directory: string; label: string }> = [
      { directory: dataRoot(this.options.env), label: "data-root" },
      { directory: stateRoot(this.options.env), label: "state-root" },
    ];
    for (const root of roots) {
      try {
        const watcher = watch(root.directory, { recursive: false }, (_event, filename) => {
          if (typeof filename !== "string") return;
          const name = filename.replace(/\\/g, "/").toLowerCase();
          if (root.label === "data-root" && !/^opencode\.db(-wal|-shm)?$/i.test(name)) return;
          if (root.label === "state-root" && name !== "service.json") return;
          if (root.label === "state-root") {
            // The shared service lifecycle changed — re-attach the stream.
            void this.connectStream();
            return;
          }
          this.buffer({ kind: "session.metadata", eventTypes: ["reconcile.db.structure"] }, "reconcile");
        });
        watcher.on("error", () => this.setStatus({ warnings: [...this.status.warnings, "Database directory watching was interrupted; the realtime fallback signal is unavailable."] }));
        this.watchers.push(watcher);
      } catch {
        this.setStatus({ warnings: [...this.status.warnings, `Cannot watch the directory ${root.directory} (the realtime fallback signal is unavailable).`] });
      }
    }
  }

  /** db/db-wal mtime+size fingerprint; changes on every external commit. */
  statFingerprint(): string {
    const root = dataRoot(this.options.env);
    const parts: string[] = [];
    for (const name of ["opencode.db", "opencode.db-wal"]) {
      try {
        const info = statSync(join(root, name));
        parts.push(`${name}:${info.mtimeMs}:${info.size}`);
      } catch {
        parts.push(`${name}:-`);
      }
    }
    return parts.join("|");
  }

  /**
   * Snapshot the fingerprint BEFORE a multi-page read begins. The refresh
   * then commits exactly this baseline on success: an external write landing
   * mid-refresh leaves the post-state different, so the next stat check
   * still fires a trailing reconcile instead of swallowing it (interim
   * review item).
   */
  captureStatBaseline(): string {
    return this.statFingerprint();
  }

  /**
   * Reconcile trigger point — the ONLY stat polling entry, always called by
   * the host on its own cadence (the UI's single 2-second visible timer,
   * focus/re-show, 60s full reconcile, manual refresh, own terminal close):
   * compare the stat fingerprint against the baseline the last successful
   * refresh left. True means something may have changed — emit one reconcile
   * batch and move the baseline. This channel schedules no timers itself.
   */
  pollStatChange(): boolean {
    if (this.disposed) return false;
    const current = this.statFingerprint();
    if (current === this.statBaseline) return false;
    this.statBaseline = current;
    this.buffer({ kind: "session.metadata", eventTypes: ["reconcile.stat.change"] }, "reconcile");
    return true;
  }

  /** Called after every successful full refresh to re-arm the stat baseline. */
  noteReconciled(at: number, baseline?: string): void {
    this.statBaseline = baseline ?? this.statFingerprint();
    this.status.lastReconcileAt = at;
  }

  dispose(): void {
    this.disposed = true;
    this.stopMachinery();
  }
}

/** Convenience: the shared service discovery file path for diagnostics. */
export function serviceFilePath(env: NodeJS.ProcessEnv): string {
  return serviceFile(env);
}
