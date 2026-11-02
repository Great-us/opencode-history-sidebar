/**
 * Pure state machine for the mandatory always-current status
 * (contract USER STEERING 2026-11-02).
 *
 * The panel shows one live status: an activation snapshot followed by a live
 * change subscription. The subscription transport itself (official SSE/event
 * endpoint when the installed version proves one, or the scoped filesystem
 * change signal of the shared SQLite files when it does not) is wired by the
 * UI controller; this module only decides what each observed event means, so
 * every rule here is unit-testable on the plain node:test runner.
 *
 * Rules encoded here:
 * - A change signal while a refresh is already in flight is coalesced into
 *   one trailing refresh, never dropped and never duplicated.
 * - A lost change link invalidates freshness immediately (stale display),
 *   keeps the last successful update time, and a restored link does NOT
 *   mark data fresh again by itself: recovery reconciles a new full snapshot
 *   first, then the subscription resumes. Intervening changes are therefore
 *   never silently missed.
 * - A failed refresh shows its error and marks data not fresh, but does not
 *   by itself declare the link lost — the change signal keeps flowing and
 *   the next signal retries.
 */

/** Transport of the change subscription. */
export type LiveLinkState =
  /** No snapshot has landed yet (activation). */
  | "starting"
  /** Subscription established; data refreshed within the current link. */
  | "live"
  /** The change signal is gone (watch error, data root replaced); retrying. */
  | "reconnecting";

export interface LiveStatus {
  link: LiveLinkState;
  /** False whenever the displayed data may be outdated; recovery requires a new snapshot. */
  fresh: boolean;
  /** Epoch ms of the last successful refresh; kept across link loss for the stale display. */
  lastRefreshAt: number | null;
  lastError: string | null;
  /** A change signal arrived that has not been consumed by a refresh yet. */
  pendingSignal: boolean;
  refreshing: boolean;
}

export type LiveEvent =
  | { type: "snapshot-start" }
  | { type: "refresh-start" }
  | { type: "refresh-ok"; at: number }
  | { type: "refresh-fail"; error: string }
  | { type: "change-signal" }
  /** The change subscription attached; freshness is still up to the snapshot. */
  | { type: "link-open" }
  | { type: "link-lost"; error: string }
  | { type: "link-restored" };

export function liveStatusInitial(): LiveStatus {
  return { link: "starting", fresh: false, lastRefreshAt: null, lastError: null, pendingSignal: false, refreshing: false };
}

export function liveReduce(state: LiveStatus, event: LiveEvent): LiveStatus {
  switch (event.type) {
    case "snapshot-start":
    case "refresh-start":
      return { ...state, refreshing: true, pendingSignal: false };
    case "refresh-ok":
      return {
        link: "live",
        fresh: true,
        lastRefreshAt: event.at,
        lastError: null,
        // A signal that raced with the completing refresh stays pending so the
        // trailing refresh still happens — intervening writes are never lost.
        pendingSignal: state.pendingSignal,
        refreshing: false,
      };
    case "refresh-fail":
      return { ...state, fresh: false, lastError: event.error, refreshing: false };
    case "change-signal":
      return { ...state, pendingSignal: true };
    case "link-open":
      // Activation: the subscription exists, but the data is not current
      // until the first snapshot lands (fresh stays false).
      return state.link === "starting" ? { ...state, link: "live" } : state;
    case "link-lost":
      return { ...state, link: "reconnecting", fresh: false, lastError: event.error };
    case "link-restored":
      // Freshness stays false until the recovery reconcile snapshot lands;
      // the controller pairs this event with an immediate snapshot request.
      return { ...state, link: "live", lastError: null };
  }
}

/**
 * Coalescing decision: a refresh should start when an unconsumed change
 * signal exists and none is in flight. The controller applies this after
 * every event; bursts collapse into one immediate refresh plus at most one
 * trailing refresh per completed cycle.
 */
export function liveWantsRefresh(status: LiveStatus): boolean {
  return status.pendingSignal && !status.refreshing;
}

/**
 * Human-facing freshness label. A non-fresh state never masquerades as
 * current; "运行中/最新" wording is reserved for verified fresh data. The
 * label shows the REAL absolute update time once it is older than a minute —
 * a relative-only label would read "刚刚" forever if nothing redrew it; the
 * panel still refreshes the label on its existing 2-second visible tick (no
 * extra timer).
 */
export function liveStatusLabel(status: LiveStatus, now: number): string {
  if (status.refreshing) return "正在刷新…";
  if (status.link === "reconnecting") return "连接中断，正在恢复…";
  if (!status.fresh) return status.link === "starting" ? "正在读取…" : "数据可能过期";
  if (status.lastRefreshAt === null) return "已更新";
  const seconds = Math.max(0, Math.round((now - status.lastRefreshAt) / 1000));
  if (seconds < 5) return "实时 · 更新于 刚刚";
  if (seconds < 90) return `实时 · 更新于 ${seconds} 秒前`;
  return `实时 · 更新于 ${new Date(status.lastRefreshAt).toLocaleTimeString()}`;
}
