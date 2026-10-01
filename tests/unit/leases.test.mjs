// Tab leases (bridge/leases.js): which session holds which tab as its target, and for how long a
// silent holder keeps it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLeases } from "../../bridge/leases.js";

function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("a free tab is claimed; its holder is then reported", () => {
  const c = clock();
  const l = createLeases({ ttlMs: 90, now: c.now });
  assert.deepEqual(l.claim("A", "mcp", "chrome-1", 5), { ok: true });
  assert.deepEqual(l.holderOf("chrome-1", 5), { session: "A", source: "mcp", lastSeen: 1000 });
  assert.equal(l.holderOf("chrome-1", 6), null);
  assert.equal(l.holderOf("edge-1", 5), null, "a tab id is only held in its own browser");
});

test("a tab another live session holds is refused, naming the holder", () => {
  const l = createLeases({ ttlMs: 90, now: clock().now });
  l.claim("A", "mcp", "chrome-1", 5);
  const r = l.claim("B", "cli", "chrome-1", 5);
  assert.equal(r.ok, false);
  assert.equal(r.holder.session, "A");
  assert.equal(l.holderOf("chrome-1", 5).session, "A", "the refusal changed nothing");
});

test("a session holds one tab: claiming another releases the first", () => {
  const l = createLeases({ ttlMs: 90, now: clock().now });
  l.claim("A", "mcp", "chrome-1", 5);
  l.claim("A", "mcp", "edge-1", 7);
  assert.equal(l.holderOf("chrome-1", 5), null);
  assert.equal(l.holderOf("edge-1", 7).session, "A");
});

test("re-claiming its own tab keeps the lease and renews it", () => {
  const c = clock();
  const l = createLeases({ ttlMs: 90, now: c.now });
  l.claim("A", "mcp", "chrome-1", 5);
  c.advance(60);
  assert.deepEqual(l.claim("A", "mcp", "chrome-1", 5), { ok: true });
  c.advance(60);
  assert.equal(l.holderOf("chrome-1", 5).session, "A");
});

test("a holder that goes silent past the ttl loses the tab; touch keeps it", () => {
  const c = clock();
  const l = createLeases({ ttlMs: 90, now: c.now });
  l.claim("A", "mcp", "chrome-1", 5);
  l.claim("B", "mcp", "chrome-1", 6);
  c.advance(60);
  l.touch("A");
  c.advance(60);
  assert.equal(l.holderOf("chrome-1", 5).session, "A", "touched 60 ms ago");
  assert.equal(l.holderOf("chrome-1", 6), null, "silent for 120 ms");
  assert.deepEqual(l.claim("C", "cli", "chrome-1", 6), { ok: true });
});

test("touch on a session with no lease does nothing", () => {
  const l = createLeases({ ttlMs: 90, now: clock().now });
  l.touch("nobody");
  assert.equal(l.holderOf("chrome-1", 5), null);
});

test("release frees the session's tab; releaseTab frees a tab whoever holds it", () => {
  const l = createLeases({ ttlMs: 90, now: clock().now });
  l.claim("A", "mcp", "chrome-1", 5);
  l.claim("B", "mcp", "chrome-1", 6);
  l.release("A");
  assert.equal(l.holderOf("chrome-1", 5), null);
  l.releaseTab("chrome-1", 6);
  assert.equal(l.holderOf("chrome-1", 6), null);
});

test("a lease claimed with keep never lapses; it ends only when moved or released", () => {
  const c = clock();
  const l = createLeases({ ttlMs: 90, now: c.now });
  l.claim("cli", "cli", "chrome-1", 5, { keep: true });
  c.advance(10_000);
  assert.equal(l.holderOf("chrome-1", 5).session, "cli");
  l.release("cli");
  assert.equal(l.holderOf("chrome-1", 5), null);
});

test("leaseOf and restore put a session's previous lease back after a failed move", () => {
  const l = createLeases({ ttlMs: 90, now: clock().now });
  l.claim("A", "mcp", "chrome-1", 5);
  const before = l.leaseOf("A");
  l.claim("A", "mcp", "chrome-1", 6);
  l.restore("A", before);
  assert.equal(l.holderOf("chrome-1", 5).session, "A");
  assert.equal(l.holderOf("chrome-1", 6), null);
  l.restore("B", null);
  assert.equal(l.leaseOf("B"), null);
});

test("retainIn keeps only the holds on tabs a browser still has; busyIn names a busy holder", () => {
  const c = clock();
  const l = createLeases({ ttlMs: 1000, busyMs: 30, now: c.now });
  l.claim("A", "mcp", "chrome-1", 5);
  l.claim("B", "cli", "chrome-1", 6);
  l.claim("C", "mcp", "edge-1", 5);
  assert.equal(l.busyIn("chrome-1", "A").holder.session, "B");
  assert.equal(l.busyIn("chrome-1", "A").retryInMs, 30);
  c.advance(40);
  assert.equal(l.busyIn("chrome-1", "A"), null, "idle holders do not count");
  l.retainIn("chrome-1", new Set([6]));
  assert.equal(l.holderOf("chrome-1", 5), null);
  assert.equal(l.holderOf("chrome-1", 6).session, "B");
  assert.equal(l.holderOf("edge-1", 5).session, "C");
});

// Taking a held tab: never while its holder is busy, with confirmation (force) while it is idle,
// and freely once the holder yields. The holder is told on its next command.
function takeSetup() {
  const c = clock();
  const l = createLeases({ ttlMs: 1000, busyMs: 30, now: c.now });
  l.claim("A", "mcp", "chrome-1", 5);
  return { c, l };
}

test("a plain claim of a held tab is refused as owned, however idle the holder is", () => {
  const { c, l } = takeSetup();
  c.advance(500);
  const r = l.claim("B", "mcp", "chrome-1", 5);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "owned");
});

test("a take while the holder has a command in flight, or finished one under busyMs ago, is busy", () => {
  const { c, l } = takeSetup();
  c.advance(100);
  l.begin("A");
  c.advance(500);
  let r = l.claim("B", "mcp", "chrome-1", 5, { take: true, force: true });
  assert.equal(r.reason, "busy", "in flight, even with force");
  l.end("A");
  c.advance(10);
  r = l.claim("B", "mcp", "chrome-1", 5, { take: true, force: true });
  assert.equal(r.reason, "busy");
  assert.equal(r.retryInMs, 20);
});

test("a take of an idle tab asks for confirmation; force takes it and leaves the holder a notice", () => {
  const { c, l } = takeSetup();
  c.advance(100);
  const ask = l.claim("B", "mcp", "chrome-1", 5, { take: true });
  assert.equal(ask.ok, false);
  assert.equal(ask.reason, "confirm");
  assert.equal(ask.idleMs, 100);
  const took = l.claim("B", "mcp", "chrome-1", 5, { take: true, force: true });
  assert.equal(took.ok, true);
  assert.equal(took.took.session, "A");
  assert.equal(took.forced, true);
  assert.equal(l.holderOf("chrome-1", 5).session, "B");
  const notice = l.takeNotice("A", "chrome-1", 5);
  assert.equal(notice.by, "B");
  assert.equal(l.takeNotice("A", "chrome-1", 5), null, "a notice is given once");
});

test("a yielding holder's tab is taken without confirmation, but still not while busy", () => {
  const { c, l } = takeSetup();
  l.yieldTab("A");
  l.begin("A");
  assert.equal(l.claim("B", "mcp", "chrome-1", 5, { take: true }).reason, "busy");
  l.end("A");
  c.advance(100);
  const r = l.claim("B", "mcp", "chrome-1", 5, { take: true });
  assert.equal(r.ok, true);
  assert.equal(r.forced, false);
  assert.equal(l.takeNotice("A", "chrome-1", 5).by, "B");
});

test("a holder whose process is gone frees its tab at once", () => {
  const c = clock();
  const alive = new Set([111]);
  const l = createLeases({ ttlMs: 1000, busyMs: 30, now: c.now, isAlive: (pid) => alive.has(pid) });
  l.claim("A", "mcp", "chrome-1", 5, { pid: 111 });
  assert.equal(l.claim("B", "mcp", "chrome-1", 5).reason, "owned");
  alive.delete(111);
  assert.equal(l.claim("B", "mcp", "chrome-1", 5).ok, true);
});

test("a holder with a command in flight stays live past the ttl, and re-claiming keeps the count", () => {
  const c = clock();
  const l = createLeases({ ttlMs: 50, busyMs: 30, now: c.now });
  l.claim("A", "mcp", "chrome-1", 5);
  l.begin("A");
  l.claim("A", "mcp", "chrome-1", 5);
  c.advance(500);
  assert.equal(l.holderOf("chrome-1", 5).session, "A");
  assert.equal(l.claim("B", "mcp", "chrome-1", 5, { take: true, force: true }).reason, "busy");
});
