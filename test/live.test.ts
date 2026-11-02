import assert from "node:assert/strict";
import { test } from "node:test";
import { liveStatusInitial, liveReduce, liveWantsRefresh, liveStatusLabel } from "../src/shared/liveStatus";

test("activation: snapshot lands, link becomes live and fresh", () => {
  let status = liveStatusInitial();
  assert.equal(status.link, "starting");
  assert.equal(status.fresh, false);
  assert.equal(liveStatusLabel(status, Date.now()), "正在读取…");
  status = liveReduce(status, { type: "snapshot-start" });
  assert.equal(status.refreshing, true);
  status = liveReduce(status, { type: "refresh-ok", at: 1000 });
  assert.equal(status.link, "live");
  assert.equal(status.fresh, true);
  assert.equal(status.lastRefreshAt, 1000);
  assert.match(liveStatusLabel(status, 1500), /实时 · 更新于/);
});

test("change signals coalesce: bursts during a refresh keep exactly one trailing refresh", () => {
  let status = liveStatusInitial();
  status = liveReduce(status, { type: "refresh-ok", at: 1000 });
  status = liveReduce(status, { type: "change-signal" });
  status = liveReduce(status, { type: "change-signal" });
  status = liveReduce(status, { type: "change-signal" });
  assert.equal(status.pendingSignal, true);
  assert.equal(liveWantsRefresh(status), true);
  status = liveReduce(status, { type: "refresh-start" });
  assert.equal(liveWantsRefresh(status), false, "in-flight refresh consumes the signal");
  // Two more signals race with the completing refresh: they must not be lost…
  status = liveReduce(status, { type: "change-signal" });
  status = liveReduce(status, { type: "refresh-ok", at: 2000 });
  assert.equal(status.fresh, true);
  // …and they collapse into one more refresh, not several.
  assert.equal(status.pendingSignal, true);
  assert.equal(liveWantsRefresh(status), true);
  status = liveReduce(status, { type: "refresh-start" });
  status = liveReduce(status, { type: "refresh-ok", at: 3000 });
  assert.equal(status.pendingSignal, false);
  assert.equal(liveWantsRefresh(status), false);
});

test("link loss invalidates freshness, keeps the last update, and recovery requires a new snapshot", () => {
  let status = liveStatusInitial();
  status = liveReduce(status, { type: "refresh-ok", at: 1000 });
  status = liveReduce(status, { type: "link-lost", error: "synthetic watcher error" });
  assert.equal(status.link, "reconnecting");
  assert.equal(status.fresh, false, "disconnect invalidates freshness");
  assert.equal(status.lastRefreshAt, 1000, "last successful update stays visible");
  assert.equal(status.lastError, "synthetic watcher error");
  assert.match(liveStatusLabel(status, 4000), /连接中断/);
  // A restored link alone must NOT mark the data current again.
  status = liveReduce(status, { type: "link-restored" });
  assert.equal(status.link, "live");
  assert.equal(status.fresh, false);
  assert.match(liveStatusLabel(status, 4000), /数据可能过期/);
  status = liveReduce(status, { type: "refresh-ok", at: 5000 });
  assert.equal(status.fresh, true);
  assert.equal(status.lastRefreshAt, 5000);
});

test("a failed refresh surfaces its error and stays retryable, without declaring the link lost", () => {
  let status = liveStatusInitial();
  status = liveReduce(status, { type: "refresh-ok", at: 1000 });
  status = liveReduce(status, { type: "refresh-start" });
  status = liveReduce(status, { type: "refresh-fail", error: "synthetic read failure" });
  assert.equal(status.link, "live");
  assert.equal(status.fresh, false);
  assert.equal(status.lastError, "synthetic read failure");
  status = liveReduce(status, { type: "change-signal" });
  assert.equal(liveWantsRefresh(status), true, "the next signal retries");
});
