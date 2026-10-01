// Which tab each session holds as its target. A session holds at most one tab, and keeps it
// while it keeps calling or sending heartbeats: a lease lapses `ttlMs` after its holder was last
// seen, and at once when the holder's process is gone (`isAlive(pid)` says so). A lease claimed
// with `keep` never lapses by time — for a session with no process to send heartbeats (the CLI) —
// and ends when its session moves or releases it, or its tab closes.
//
// Another session takes a held tab only on purpose (`take`), never while the holder is busy — a
// command in flight, or one finished under `busyMs` ago — and, unless the holder yielded the
// tab, only with `force` after being asked to confirm. The holder is told on its next command.
export function createLeases({
  ttlMs = 15_000,
  busyMs = 30_000,
  now = () => Date.now(),
  isAlive = () => true,
} = {}) {
  // session -> {browser, tabId, source, lastSeen, lastActionAt, inflight, keep, yielding, pid}
  const bySession = new Map();
  // session -> {browser, tabId, by, bySource, forced, at}: the tab another session took from it
  const notices = new Map();

  // A command in flight proves its holder alive, however long the command runs
  const live = (lease) =>
    (lease.pid == null || isAlive(lease.pid)) &&
    (lease.keep || lease.inflight > 0 || now() - lease.lastSeen <= ttlMs);

  function holderOf(browser, tabId) {
    for (const [session, lease] of bySession) {
      if (lease.browser !== browser || lease.tabId !== tabId) continue;
      if (live(lease)) return { session, source: lease.source, lastSeen: lease.lastSeen };
      bySession.delete(session);
    }
    return null;
  }

  function dropWhere(match) {
    for (const [session, lease] of bySession) if (match(lease)) bySession.delete(session);
  }

  function busyFor(lease) {
    if (lease.inflight > 0) return busyMs;
    return Math.max(0, busyMs - (now() - lease.lastActionAt));
  }

  return {
    holderOf,
    // Takes the tab for `session`, moving its lease off whatever tab it held before. A tab
    // another live session holds is refused as "owned", or with `take` as "busy" (retryInMs),
    // "confirm" (idleMs: send again with force), or taken ({took, forced}).
    claim(
      session,
      source,
      browser,
      tabId,
      { keep = false, pid = null, take = false, force = false } = {}
    ) {
      const holder = holderOf(browser, tabId);
      let took = null;
      let forced = false;
      if (holder && holder.session !== session) {
        const lease = bySession.get(holder.session);
        if (!take) return { ok: false, reason: "owned", holder };
        const wait = busyFor(lease);
        if (wait > 0) return { ok: false, reason: "busy", holder, retryInMs: wait };
        if (!lease.yielding && !force) {
          return { ok: false, reason: "confirm", holder, idleMs: now() - lease.lastActionAt };
        }
        took = holder;
        forced = !lease.yielding;
        bySession.delete(holder.session);
        notices.set(holder.session, {
          browser,
          tabId,
          by: session,
          bySource: source,
          forced,
          at: now(),
        });
      }
      const t = now();
      // Re-claiming its own tab keeps the session's commands in flight counted
      const same = bySession.get(session);
      const kept = same && same.browser === browser && same.tabId === tabId ? same : null;
      bySession.set(session, {
        browser,
        tabId,
        source,
        lastSeen: t,
        lastActionAt: kept ? kept.lastActionAt : t,
        inflight: kept ? kept.inflight : 0,
        keep,
        yielding: kept ? kept.yielding : false,
        pid,
      });
      notices.delete(session);
      return took ? { ok: true, took, forced } : { ok: true };
    },
    // A command of the session starts or ends: the holder is busy until busyMs after the last end
    begin(session) {
      const lease = bySession.get(session);
      if (lease) lease.inflight++;
    },
    end(session) {
      const lease = bySession.get(session);
      if (!lease) return;
      lease.inflight = Math.max(0, lease.inflight - 1);
      lease.lastActionAt = now();
    },
    // The holder keeps working in its tab but lets any session take it without confirmation
    yieldTab(session) {
      const lease = bySession.get(session);
      if (lease) lease.yielding = true;
      return !!lease;
    },
    // Once: the notice that another session took `session`'s tab
    takeNotice(session, browser, tabId) {
      const n = notices.get(session);
      if (!n || n.browser !== browser || n.tabId !== tabId) return null;
      notices.delete(session);
      return n;
    },
    // The session's lease as it stands, for `restore` to put back
    leaseOf(session) {
      const lease = bySession.get(session);
      return lease ? { ...lease } : null;
    },
    restore(session, lease) {
      if (lease) bySession.set(session, { ...lease });
      else bySession.delete(session);
    },
    // The live holder in one browser, other than `except`, that is busy the longest, and for how
    // long; null when none is busy
    busyIn(browser, except) {
      let found = null;
      for (const [session, lease] of bySession) {
        if (lease.browser !== browser || session === except || !live(lease)) continue;
        const retryInMs = busyFor(lease);
        if (retryInMs > 0 && (!found || retryInMs > found.retryInMs)) {
          found = {
            holder: { session, source: lease.source, lastSeen: lease.lastSeen },
            retryInMs,
          };
        }
      }
      return found;
    },
    touch(session) {
      const lease = bySession.get(session);
      if (lease) lease.lastSeen = now();
    },
    release(session) {
      bySession.delete(session);
      notices.delete(session);
    },
    releaseTab(browser, tabId) {
      dropWhere((lease) => lease.browser === browser && lease.tabId === tabId);
    },
    // A browser reconnected with these tabs open: holds on any other tab of it are gone
    retainIn(browser, tabIds) {
      dropWhere((lease) => lease.browser === browser && !tabIds.has(lease.tabId));
    },
  };
}
