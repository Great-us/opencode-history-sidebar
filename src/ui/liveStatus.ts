import { liveReduce, liveStatusInitial, liveWantsRefresh, type LiveEvent, type LiveStatus } from '../shared/liveStatus';

/**
 * UI side of the mandatory always-current status (live-probe §4 DTO + the
 * confirmed-gap fixes of the revision task).
 *
 * The backend channel owns detection: the shared service's SSE stream
 * (subscribe-before-snapshot), its own reconnection with a forced reconcile
 * batch, structural DB watchers, and the db/db-wal stat comparison exposed as
 * `pollStatChange()` (Windows fs.watch is silent for steady-state WAL commits
 * on Windows — probed). The UI keeps exactly one 2-second tick (owned by
 * src/extension.ts) that merges the channel state and runs the stat compare
 * while the sidebar OR a preview is visible, a 60-second unconditional full
 * API reconciliation, and immediate focus/re-show reconciliation. This
 * controller itself never duplicates watchers, timers or storage access.
 */
export interface LiveChannelLike {
  subscribeChanges(listener: (batch: { origin: 'sse' | 'reconcile' }) => void): { dispose(): void };
  liveStatus(): { state: 'stopped' | 'live' | 'degraded'; source: string; lastEventAt?: number; lastReconcileAt?: number; warnings: string[] };
  pollStatChange(): boolean;
}

export interface LiveHistoryOptions {
  channel: LiveChannelLike;
  /** Called once per coalesced change; run one metadata refresh here. */
  onSignal: () => void;
  /** Called whenever the displayed status changes. */
  onStatus?: (status: LiveStatus) => void;
}

export class LiveHistoryController {
  private status: LiveStatus = liveStatusInitial();
  private subscription: { dispose(): void } | undefined;
  private started = false;
  constructor(private readonly options: LiveHistoryOptions) {}

  get current(): LiveStatus { return this.status; }

  /**
   * Apply a refresh lifecycle event. When an unconsumed change signal exists
   * and no refresh is in flight, the signal is delivered immediately
   * (coalesced: one immediate refresh plus at most one trailing refresh per
   * completed cycle).
   */
  dispatch(event: LiveEvent): LiveStatus {
    this.status = liveReduce(this.status, event);
    this.options.onStatus?.(this.status);
    if (liveWantsRefresh(this.status)) this.options.onSignal();
    return this.status;
  }

  /**
   * Subscribe to the backend channel. Call BEFORE the activation snapshot:
   * subscribing first closes the vacuum window between snapshot and stream
   * (live-probe §4.1). Idempotent.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.subscription = this.options.channel.subscribeChanges(() => {
      // Any batch (sse or reconcile origin) means data may have changed; the
      // reducer coalesces bursts into a single refresh. Channel state is also
      // merged here so a batch arriving around a disconnect never leaves a
      // stale "live" badge on screen.
      this.observeChannel();
      this.dispatch({ type: 'change-signal' });
    });
    this.dispatch({ type: 'link-open' });
  }

  /**
   * Stat-compare trigger point (the 2-second visible tick): the backend
   * compares db/db-wal stat and, when something changed, delivers a reconcile
   * batch through the subscription — so a detected change surfaces exactly
   * once and an unchanged stat costs two stat() calls, nothing more.
   */
  reconcile(): boolean {
    return this.options.channel.pollStatChange();
  }

  /**
   * Merge the channel's own state into the display status. Called at every
   * display update point and on every tick/batch — a degraded stream
   * invalidates freshness immediately (stale display, last update kept), and
   * a recovered stream NEVER marks data fresh by itself: the controller
   * demands a new full snapshot first (socket open is not "synced"), which
   * the reducer only turns fresh on its refresh-ok.
   */
  observeChannel(): void {
    const channel = this.options.channel.liveStatus();
    if (channel.state === 'degraded' && this.status.link !== 'reconnecting') {
      this.dispatch({ type: 'link-lost', error: channel.warnings[0] ?? 'Event stream interrupted' });
    } else if (channel.state !== 'degraded' && this.status.link === 'reconnecting') {
      this.dispatch({ type: 'link-restored' });
      // Recovery reconciliation: a brand-new snapshot must land before the
      // status may claim freshness again. The backend also re-emits a
      // reconcile batch on reconnect; the single-flight refresh coalesces the
      // two demands into one read.
      this.options.onSignal();
    }
  }

  dispose(): void {
    this.subscription?.dispose();
    this.subscription = undefined;
  }
}
