// State manager for browserctl daemon lifecycle
// Stores state in ~/.browserctl/daemon.json

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function getStateDir() {
  const dir = join(homedir(), ".browserctl");
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }
  return dir;
}

export function getStatePath() {
  return join(getStateDir(), "daemon.json");
}

export function getDaemonState() {
  try {
    const file = getStatePath();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {}
  return { state: "uninitialized" };
}

export function setDaemonState(updates) {
  try {
    const current = getDaemonState();
    const next = { ...current, ...updates, updatedAt: new Date().toISOString() };
    fs.writeFileSync(getStatePath(), JSON.stringify(next, null, 2), "utf8");
    return next;
  } catch (err) {
    return { state: "uninitialized", error: err.message };
  }
}

export function markDaemonRunning({ pid, port = 8765, url = "http://127.0.0.1:8765" } = {}) {
  return setDaemonState({
    state: "running",
    pid: pid !== undefined ? pid : process.pid,
    port,
    url,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    stoppedBy: null,
  });
}

export function markDaemonStopped({ stoppedBy = "cli_stop" } = {}) {
  return setDaemonState({
    state: "stopped",
    pid: null,
    stoppedAt: new Date().toISOString(),
    stoppedBy,
  });
}

export function isDaemonExplicitlyStopped() {
  const s = getDaemonState();
  return s.state === "stopped";
}
