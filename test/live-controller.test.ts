import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveHistoryController, type LiveChannelLike } from "../src/ui/liveStatus";

/** Deterministic fake of the backend live channel (live-probe §4 DTO). */
class FakeChannel implements LiveChannelLike {
  state: "stopped" | "live" | "degraded" = "stopped";
  warnings: string[] = [];
  pollCalls = 0;
  pollResult = false;
  disposed = false;
  private listener?: (batch: { origin: "sse" | "reconcile" }) => void;
  subscribeChanges(listener: (batch: { origin: "sse" | "reconcile" }) => void): { dispose(): void } {
    if (this.listener) throw new Error("FakeChannel supports one subscription");
    this.listener = listener;
    return { dispose: () => { this.disposed = true; this.listener = undefined; } };
  }
  liveStatus() {
    return { state: this.state, source: this.state === "live" ? "service-sse" : "trigger-reconcile", lastEventAt: undefined, lastReconcileAt: undefined, warnings: this.warnings };
  }
  pollStatChange(): boolean { this.pollCalls += 1; return this.pollResult; }
  emit(origin: "sse" | "reconcile"): void { this.listener?.({ origin, hints: [] } as never); }
}

test("start subscribes once before the snapshot; batches raise coalesced refreshes", () => {
  const channel = new FakeChannel();
  let refreshes = 0;
  let completing: (() => void) | undefined;
  const live = new LiveHistoryController({ channel, onSignal: () => {
    refreshes += 1;
    live.dispatch({ type: "refresh-start" });
    completing = () => live.dispatch({ type: "refresh-ok", at: Date.now() });
  } });
  live.start();
  assert.equal(live.current.link, "live", "subscription marks the link live");
  assert.equal(live.current.fresh, false, "data is not current before the snapshot");
  // Activation snapshot.
  live.dispatch({ type: "snapshot-start" });
  live.dispatch({ type: "refresh-ok", at: 1000 });
  assert.equal(live.current.fresh, true);
  // SSE events arrive as batches; a burst while a refresh is in flight
  // coalesces into exactly one trailing refresh.
  channel.emit("sse");
  assert.equal(refreshes, 1);
  channel.emit("sse");
  channel.emit("sse");
  live.start(); // idempotent: no second subscription, no fake signal
  assert.equal(refreshes, 1, "signals during an in-flight refresh wait");
  completing!(); // the in-flight refresh completes -> the coalesced signal fires once
  assert.equal(refreshes, 2);
  completing!();
  assert.equal(live.current.pendingSignal, false);
  assert.equal(live.current.fresh, true);
  live.dispose();
  assert.equal(channel.disposed, true, "disposal releases the channel");
});

test("reconcile delegates to the backend stat comparison", () => {
  const channel = new FakeChannel();
  const live = new LiveHistoryController({ channel, onSignal: () => {} });
  live.start();
  channel.pollResult = true;
  assert.equal(live.reconcile(), true, "a detected change is reported (the batch arrives via the subscription)");
  channel.pollResult = false;
  assert.equal(live.reconcile(), false, "an unchanged stat raises nothing");
  assert.equal(channel.pollCalls, 2);
  live.dispose();
});

test("channel degradation invalidates freshness; recovery needs a fresh snapshot", async () => {
  const channel = new FakeChannel();
  let refreshes = 0;
  const live = new LiveHistoryController({ channel, onSignal: () => { refreshes += 1; } });
  live.start();
  live.dispatch({ type: "refresh-ok", at: 1000 });
  channel.state = "live";
  // The stream drops.
  channel.state = "degraded";
  channel.warnings = ["事件流中断：synthetic"];
  live.observeChannel();
  assert.equal(live.current.link, "reconnecting");
  assert.equal(live.current.fresh, false);
  assert.equal(live.current.lastRefreshAt, 1000, "the last successful update stays visible");
  assert.equal(live.current.lastError, "事件流中断：synthetic");
  live.observeChannel(); // idempotent while degraded
  assert.equal(live.current.link, "reconnecting");
  // The channel reconnects: the socket opening is NOT "synced" — the
  // controller demands a recovery snapshot immediately (one onSignal), on top
  // of the reconcile batch the backend re-emits on reconnect.
  channel.state = "live";
  channel.warnings = [];
  live.observeChannel();
  assert.equal(live.current.link, "live");
  assert.equal(live.current.fresh, false, "recovery alone never marks stale data current");
  assert.equal(refreshes, 1, "a restored link demands exactly one new snapshot");
  live.dispatch({ type: "refresh-start" });
  live.dispatch({ type: "refresh-ok", at: 5000 });
  assert.equal(live.current.fresh, true);
  live.dispose();
});

test("a batch arriving around a disconnect merges the channel state before signaling", () => {
  const channel = new FakeChannel();
  const live = new LiveHistoryController({ channel, onSignal: () => {} });
  live.start();
  live.dispatch({ type: "refresh-ok", at: 1000 });
  // The stream is down when a reconcile batch lands: the badge must not stay
  // "live" on screen just because a batch arrived.
  channel.state = "degraded";
  channel.warnings = ["事件流中断：synthetic"];
  channel.emit("reconcile");
  assert.equal(live.current.link, "reconnecting", "batch handling merges the degraded channel state");
  assert.equal(live.current.fresh, false);
  live.dispose();
});
