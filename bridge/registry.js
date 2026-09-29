import fs from "node:fs";
import { randomUUID } from "node:crypto";

// Which browser each connection is. Aliases are kept in a file so a profile keeps its name
// across bridge restarts; the file is a naming map, not liveness, so a stale entry is harmless.
export function createRegistry({ aliasFile }) {
  const byConnId = new Map();
  let aliases = readAliases(aliasFile);
  let legacySeq = 0;

  function aliasFor(instanceId, type) {
    if (aliases[instanceId]) return aliases[instanceId];
    const taken = new Set(Object.values(aliases));
    let n = 1;
    while (taken.has(`${type}-${n}`)) n++;
    aliases[instanceId] = `${type}-${n}`;
    writeAliases(aliasFile, aliases);
    return aliases[instanceId];
  }

  function list() {
    return [...byConnId.values()].sort((a, b) => a.alias.localeCompare(b.alias));
  }

  // Matches a caller-given selector (alias, label, instanceId or browser type) against the
  // connected entries, and picks a default when no selector is given at all.
  function resolve(selector) {
    const all = list();
    if (!all.length) {
      return { error: { code: "NO_BROWSER", message: "no browser is connected", candidates: [] } };
    }
    if (selector == null || selector === "") {
      if (all.length === 1) return { entry: all[0] };
      const focused = all
        .filter((e) => e.lastFocusedAt != null)
        .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt);
      if (focused.length) return { entry: focused[0] };
      return selectorError(
        all,
        "NEEDS_BROWSER",
        "several browsers are connected and none was focused yet; name one with 'browser'",
        all
      );
    }
    return matchBrowser(all, selector);
  }

  return {
    admit({ connId, instanceId, browserType, label = null, focused = false }) {
      const legacy = !instanceId;
      let previousFocusedAt = null;
      if (!legacy) {
        for (const [cid, e] of byConnId) {
          if (e.instanceId !== instanceId) continue;
          previousFocusedAt = e.lastFocusedAt;
          byConnId.delete(cid);
        }
      }
      const now = Date.now();
      const newFocusedAt = focused ? now : null;
      const entry = {
        connId,
        instanceId: legacy ? `legacy_${randomUUID().slice(0, 8)}` : instanceId,
        browserType: browserType || "chromium",
        label,
        alias: legacy ? `legacy-${++legacySeq}` : aliasFor(instanceId, browserType || "chromium"),
        connectedAt: now,
        // A reconnect (same instanceId, a fresh service-worker) keeps whichever focus timestamp
        // is more recent, so a restart never silently hands the "last focused" default to
        // another browser.
        lastFocusedAt: legacy ? newFocusedAt : maxTimestamp(previousFocusedAt, newFocusedAt),
        legacy,
      };
      byConnId.set(connId, entry);
      return entry;
    },
    remove(connId) {
      const e = byConnId.get(connId) || null;
      byConnId.delete(connId);
      return e;
    },
    byConn: (connId) => byConnId.get(connId) || null,
    byInstance: (id) => [...byConnId.values()].find((e) => e.instanceId === id) || null,
    list,
    touchFocus(connId, focused, at = Date.now()) {
      const e = byConnId.get(connId);
      if (e && focused) e.lastFocusedAt = at;
    },
    resolve,
  };
}

function describeBrowser(e) {
  return `${e.alias}${e.label ? ` ("${e.label}")` : ""}`;
}

function selectorError(all, code, message, candidates) {
  return {
    error: {
      code,
      message: `${message}. Connected: ${all.map(describeBrowser).join(", ")}`,
      candidates,
    },
  };
}

// Matches a non-empty selector against `all` (entries with alias, label, instanceId and
// browserType): an alias, then a label (both case-insensitive), then an instanceId, then a
// browser type that exactly one entry has. Shared by the bridge and the MCP server, so a selector names
// the same browser in both.
export function matchBrowser(all, selector) {
  if (!all.length) {
    return { error: { code: "NO_BROWSER", message: "no browser is connected", candidates: [] } };
  }
  const s = String(selector).trim();
  const lower = s.toLowerCase();
  const byAlias = all.find((e) => e.alias.toLowerCase() === lower);
  if (byAlias) return { entry: byAlias };
  const byLabel = all.filter((e) => e.label && e.label.toLowerCase() === lower);
  if (byLabel.length === 1) return { entry: byLabel[0] };
  if (byLabel.length > 1) {
    return selectorError(
      all,
      "AMBIGUOUS_BROWSER",
      `label '${s}' names ${byLabel.length} browsers`,
      byLabel
    );
  }
  const byId = all.find((e) => e.instanceId === s);
  if (byId) return { entry: byId };
  const byType = all.filter((e) => e.browserType === lower);
  if (byType.length === 1) return { entry: byType[0] };
  if (byType.length > 1) {
    return selectorError(
      all,
      "AMBIGUOUS_BROWSER",
      `'${s}' matches ${byType.map(describeBrowser).join(" and ")}`,
      byType
    );
  }
  return selectorError(all, "UNKNOWN_BROWSER", `no connected browser is '${s}'`, all);
}

function maxTimestamp(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

function readAliases(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// Written to a temp file beside it and renamed over it, so a crash mid-write never leaves a
// half-written file (which would read back as empty and hand every profile a new alias)
function writeAliases(file, aliases) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(aliases, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
  }
}
