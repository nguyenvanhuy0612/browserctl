import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function getStateDir() {
  const dir = join(homedir(), ".browserctl");
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }
  return dir;
}

function validPort(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function resolvePort(port) {
  const explicit = validPort(port);
  if (explicit) return explicit;
  const envPort = validPort(process.env.PORT) || validPort(process.env.BROWSERCTL_PORT);
  if (envPort) return envPort;
  const envUrl = process.env.BROWSERCTL_BRIDGE_URL || process.env.BRIDGE_URL;
  if (envUrl) {
    try {
      const u = new URL(envUrl);
      const n = validPort(u.port) || (u.protocol === "https:" ? 443 : 80);
      return n;
    } catch {}
  }
  return 8765;
}

// A state record is a JSON object. Anything else (damaged, empty, null, an array) is no record:
// it must read as "uninitialized", never as "stopped", and never throw.
function readRecord(path) {
  try {
    if (!fs.existsSync(path)) return null;
    const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function getStatePath(port) {
  const p = resolvePort(port);
  return join(getStateDir(), `daemon-${p}.json`);
}

export function getDaemonState(port) {
  const p = resolvePort(port);
  const own = readRecord(getStatePath(p));
  if (own) return own;
  // The legacy single-daemon file belongs to 8765, and only when it was written for 8765
  if (p === 8765) {
    const legacy = readRecord(join(getStateDir(), "daemon.json"));
    if (legacy && (legacy.port == null || Number(legacy.port) === 8765)) return legacy;
  }
  return { state: "uninitialized" };
}

export function setDaemonState(updates, port) {
  const p = resolvePort(port !== undefined ? port : updates?.port);
  try {
    const current = getDaemonState(p);
    const next = { ...current, ...updates, port: p, updatedAt: new Date().toISOString() };
    fs.writeFileSync(getStatePath(p), JSON.stringify(next, null, 2), "utf8");
    // Also mirror to legacy daemon.json if default port 8765
    if (p === 8765) {
      try {
        fs.writeFileSync(join(getStateDir(), "daemon.json"), JSON.stringify(next, null, 2), "utf8");
      } catch {}
    }
    return next;
  } catch (err) {
    return { state: "uninitialized", error: err.message };
  }
}

export function markDaemonRunning({ pid, port = 8765, url } = {}) {
  const p = resolvePort(port);
  return setDaemonState(
    {
      state: "running",
      pid: pid !== undefined ? pid : process.pid,
      port: p,
      url: url || `http://127.0.0.1:${p}`,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      stoppedBy: null,
    },
    p
  );
}

export function markDaemonStopped({ stoppedBy = "cli_stop", port } = {}) {
  const p = resolvePort(port);
  return setDaemonState(
    {
      state: "stopped",
      pid: null,
      stoppedAt: new Date().toISOString(),
      stoppedBy,
    },
    p
  );
}

export function isDaemonExplicitlyStopped(port) {
  const p = resolvePort(port);
  const s = getDaemonState(p);
  return s.state === "stopped";
}
