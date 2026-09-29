// Per-port daemon state (bridge/state.js): one file per port, the legacy daemon.json kept only for
// 8765, and damaged or foreign records never read as "explicitly stopped".
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "browserctl-state-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
for (const k of ["PORT", "BROWSERCTL_PORT", "BROWSERCTL_BRIDGE_URL", "BRIDGE_URL"])
  delete process.env[k];

const state = await import("../../bridge/state.js");
const DIR = join(HOME, ".browserctl");
const file = (name) => join(DIR, name);
const read = (name) => JSON.parse(readFileSync(file(name), "utf8"));

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  for (const k of ["PORT", "BROWSERCTL_PORT", "BROWSERCTL_BRIDGE_URL", "BRIDGE_URL"])
    delete process.env[k];
});

after(() => rmSync(HOME, { recursive: true, force: true }));

test("each port has its own file; a stop on one port never reads as stopped on another", () => {
  state.markDaemonRunning({ pid: 11, port: 8765 });
  state.markDaemonRunning({ pid: 22, port: 8766 });
  state.markDaemonRunning({ pid: 33, port: 9100 });
  state.markDaemonStopped({ stoppedBy: "t", port: 8766 });

  assert.equal(state.isDaemonExplicitlyStopped(8765), false);
  assert.equal(state.isDaemonExplicitlyStopped(8766), true);
  assert.equal(state.isDaemonExplicitlyStopped(9100), false);
  assert.equal(read("daemon-8766.json").pid, null);
  assert.equal(read("daemon-9100.json").pid, 33);
});

test("only port 8765 mirrors to the legacy daemon.json", () => {
  state.markDaemonStopped({ stoppedBy: "t", port: 8766 });
  assert.equal(existsSync(file("daemon.json")), false, "8766 must not write the legacy file");

  state.markDaemonRunning({ pid: 44, port: 8765 });
  assert.equal(read("daemon.json").pid, 44);
  assert.equal(read("daemon.json").port, 8765);
});

test("the per-port file wins over the legacy file", () => {
  writeFileSync(file("daemon.json"), JSON.stringify({ state: "stopped", port: 8765 }));
  writeFileSync(file("daemon-8765.json"), JSON.stringify({ state: "running", port: 8765, pid: 5 }));
  assert.equal(state.isDaemonExplicitlyStopped(8765), false);
  assert.equal(state.getDaemonState(8765).pid, 5);
});

test("the legacy file is read for 8765 only, and only when it was written for 8765", () => {
  writeFileSync(file("daemon.json"), JSON.stringify({ state: "stopped", port: 8766 }));
  assert.equal(state.isDaemonExplicitlyStopped(8765), false, "a record for 8766 is not 8765's");
  assert.equal(state.isDaemonExplicitlyStopped(8766), false, "8766 never reads the legacy file");

  writeFileSync(file("daemon.json"), JSON.stringify({ state: "stopped", port: "8766" }));
  assert.equal(state.isDaemonExplicitlyStopped(8765), false, "a string port is still a port");

  writeFileSync(file("daemon.json"), JSON.stringify({ state: "stopped" }));
  assert.equal(state.isDaemonExplicitlyStopped(8765), true, "a portless legacy record is 8765's");
});

test("a damaged state file reads as uninitialized, not stopped, and the next write repairs it", () => {
  for (const junk of ["{not json", "", "null", "[]", '"stopped"', "42"]) {
    writeFileSync(file("daemon-8766.json"), junk);
    assert.equal(state.isDaemonExplicitlyStopped(8766), false, `junk ${JSON.stringify(junk)}`);
    assert.equal(typeof state.getDaemonState(8766), "object", `junk ${JSON.stringify(junk)}`);
    assert.notEqual(state.getDaemonState(8766), null, `junk ${JSON.stringify(junk)}`);
  }
  state.markDaemonRunning({ pid: 7, port: 8766 });
  assert.equal(read("daemon-8766.json").pid, 7);
  assert.equal(read("daemon-8766.json").state, "running");
});

test("a damaged legacy file does not block 8765", () => {
  writeFileSync(file("daemon.json"), "{broken");
  assert.equal(state.isDaemonExplicitlyStopped(8765), false);
  writeFileSync(file("daemon.json"), "null");
  assert.equal(state.isDaemonExplicitlyStopped(8765), false);
});

test("a record always carries the port of the file it is written to", () => {
  state.setDaemonState({ state: "running", port: 9999 }, 8766);
  assert.equal(read("daemon-8766.json").port, 8766);
  assert.equal(existsSync(file("daemon-9999.json")), false);
});

test("start after stop clears the stop fields and records the matching url", () => {
  state.markDaemonStopped({ stoppedBy: "mcp_stop", port: 8766 });
  const next = state.markDaemonRunning({ pid: 9, port: 8766 });
  assert.equal(next.state, "running");
  assert.equal(next.stoppedBy, null);
  assert.equal(next.stoppedAt, null);
  assert.equal(next.url, "http://127.0.0.1:8766");
});

test("port resolution: explicit value, then PORT, then the bridge URL, then 8765", () => {
  assert.match(state.getStatePath(9001), /daemon-9001\.json$/);
  assert.match(state.getStatePath("9002"), /daemon-9002\.json$/);
  assert.match(state.getStatePath(), /daemon-8765\.json$/);

  process.env.BROWSERCTL_BRIDGE_URL = "http://127.0.0.1:9003";
  assert.match(state.getStatePath(), /daemon-9003\.json$/);
  process.env.BROWSERCTL_BRIDGE_URL = "https://bridge.example";
  assert.match(state.getStatePath(), /daemon-443\.json$/);
  process.env.PORT = "9004";
  assert.match(state.getStatePath(), /daemon-9004\.json$/, "PORT is the bridge's own port");
});

test("an invalid port never names a file", () => {
  for (const bad of [0, -1, "abc", 1.5, 70000, NaN, Infinity]) {
    const path = state.getStatePath(bad);
    assert.match(path, /daemon-8765\.json$/, `port ${String(bad)} gave ${path}`);
  }
});
