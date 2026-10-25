import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLeases } from "./leases.js";

describe("bridge/leases.js (Colocated Unit Spec)", () => {
  it("claim: acquires lease on free tab successfully", () => {
    let clock = 1000;
    const leases = createLeases({ now: () => clock });

    const res = leases.claim("session-1", "mcp", "chrome-1", 10);
    assert.deepEqual(res, { ok: true });

    const holder = leases.holderOf("chrome-1", 10);
    assert.equal(holder.session, "session-1");
    assert.equal(holder.source, "mcp");
    assert.equal(holder.lastSeen, 1000);
  });

  it("claim: re-claiming same tab by same session is idempotent", () => {
    let clock = 1000;
    const leases = createLeases({ now: () => clock });

    leases.claim("session-1", "mcp", "chrome-1", 10);
    clock = 2000;
    const res = leases.claim("session-1", "mcp", "chrome-1", 10);

    assert.deepEqual(res, { ok: true });
    assert.equal(leases.holderOf("chrome-1", 10).lastSeen, 2000);
  });

  it("claim conflict: refuses another session when tab is owned", () => {
    const leases = createLeases();
    leases.claim("session-1", "mcp", "chrome-1", 10);

    const res = leases.claim("session-2", "cli", "chrome-1", 10);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "owned");
    assert.equal(res.holder.session, "session-1");
  });

  it("claim take: refuses when current holder is actively busy (in flight)", () => {
    const leases = createLeases({ busyMs: 5000 });
    leases.claim("session-1", "mcp", "chrome-1", 10);
    leases.begin("session-1"); // 1 command in flight

    const res = leases.claim("session-2", "cli", "chrome-1", 10, { take: true });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "busy");
    assert.equal(res.retryInMs, 5000);
  });

  it("claim take: requires confirmation when holder is idle but not yielding", () => {
    let clock = 10_000;
    const leases = createLeases({ now: () => clock, busyMs: 5000 });
    leases.claim("session-1", "mcp", "chrome-1", 10);

    // Advance clock past busyMs
    clock = 20_000;

    // Take without force must return confirm with idle duration
    const res = leases.claim("session-2", "cli", "chrome-1", 10, { take: true, force: false });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "confirm");
    assert.equal(res.idleMs, 10_000);

    // Take with force succeeds
    const forceRes = leases.claim("session-2", "cli", "chrome-1", 10, { take: true, force: true });
    assert.equal(forceRes.ok, true);
    assert.equal(forceRes.forced, true);
    assert.equal(forceRes.took.session, "session-1");

    // Check that previous holder receives takeNotice
    const notice = leases.takeNotice("session-1", "chrome-1", 10);
    assert.ok(notice);
    assert.equal(notice.by, "session-2");
    assert.equal(notice.forced, true);

    // takeNotice has read-once semantics
    assert.equal(leases.takeNotice("session-1", "chrome-1", 10), null);
  });

  it("claim take: succeeds without force if holder has yielded tab", () => {
    let clock = 10_000;
    const leases = createLeases({ now: () => clock, busyMs: 5000 });
    leases.claim("session-1", "mcp", "chrome-1", 10);
    leases.yieldTab("session-1");

    clock = 20_000;
    const res = leases.claim("session-2", "cli", "chrome-1", 10, { take: true, force: false });

    assert.equal(res.ok, true);
    assert.equal(res.forced, false);
    assert.equal(res.took.session, "session-1");
  });

  it("ttl & expiration: lease lapses after ttlMs of inactivity", () => {
    let clock = 1000;
    const leases = createLeases({ now: () => clock, ttlMs: 15_000 });
    leases.claim("session-1", "mcp", "chrome-1", 10);

    assert.ok(leases.holderOf("chrome-1", 10));

    // Fast-forward past TTL
    clock = 17_000;
    assert.equal(leases.holderOf("chrome-1", 10), null);
  });

  it("touch: refreshes lease lastSeen timestamp preventing expiration", () => {
    let clock = 1000;
    const leases = createLeases({ now: () => clock, ttlMs: 15_000 });
    leases.claim("session-1", "mcp", "chrome-1", 10);

    clock = 10_000;
    leases.touch("session-1");

    clock = 20_000; // 19s from start, but 10s from last touch (< 15s TTL)
    assert.ok(leases.holderOf("chrome-1", 10));
  });

  it("keep flag: lease with keep: true never lapses by time", () => {
    let clock = 1000;
    const leases = createLeases({ now: () => clock, ttlMs: 15_000 });
    leases.claim("session-cli", "cli", "chrome-1", 10, { keep: true });

    clock = 1_000_000; // Far in the future
    assert.ok(leases.holderOf("chrome-1", 10));
  });

  it("pid liveness: lease lapses immediately when holder process dies", () => {
    const aliveMap = new Map([[12345, true]]);
    const leases = createLeases({ isAlive: (pid) => aliveMap.get(pid) === true });

    leases.claim("session-1", "mcp", "chrome-1", 10, { pid: 12345 });
    assert.ok(leases.holderOf("chrome-1", 10));

    // Simulate process death
    aliveMap.set(12345, false);
    assert.equal(leases.holderOf("chrome-1", 10), null);
  });

  it("release & releaseTab: drops active leases properly", () => {
    const leases = createLeases();
    leases.claim("session-a", "mcp", "chrome-1", 10);
    leases.claim("session-b", "mcp", "chrome-1", 20);

    leases.release("session-a");
    assert.equal(leases.holderOf("chrome-1", 10), null);
    assert.ok(leases.holderOf("chrome-1", 20));

    leases.releaseTab("chrome-1", 20);
    assert.equal(leases.holderOf("chrome-1", 20), null);
  });

  it("retainIn: retains only tabs present in active reconnect set", () => {
    const leases = createLeases();
    leases.claim("session-1", "mcp", "chrome-1", 10);
    leases.claim("session-2", "mcp", "chrome-1", 20);
    leases.claim("session-3", "mcp", "chrome-2", 30); // Different browser

    // Browser chrome-1 reconnects with only tab 10
    leases.retainIn("chrome-1", new Set([10]));

    assert.ok(leases.holderOf("chrome-1", 10));
    assert.equal(leases.holderOf("chrome-1", 20), null);
    assert.ok(leases.holderOf("chrome-2", 30)); // Untouched
  });
});
