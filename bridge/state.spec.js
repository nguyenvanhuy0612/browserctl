import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  getStateDir,
  getStatePath,
  getDaemonState,
  setDaemonState,
  markDaemonRunning,
  markDaemonStopped,
  isDaemonExplicitlyStopped,
} from "./state.js";

describe("bridge/state.js (Colocated Unit Spec)", () => {
  // Use a dedicated high port for test isolation to avoid touching active daemon state
  const TEST_PORT = 58765;
  let testStatePath;

  beforeEach(() => {
    testStatePath = getStatePath(TEST_PORT);
    try {
      if (fs.existsSync(testStatePath)) fs.rmSync(testStatePath, { force: true });
    } catch {}
  });

  afterEach(() => {
    try {
      if (fs.existsSync(testStatePath)) fs.rmSync(testStatePath, { force: true });
    } catch {}
  });

  it("getStateDir: returns non-empty state directory path", () => {
    const dir = getStateDir();
    assert.ok(dir);
    assert.ok(dir.includes(".browserctl"));
    assert.ok(fs.existsSync(dir));
  });

  it("getStatePath: constructs path incorporating port number", () => {
    const pathStr = getStatePath(TEST_PORT);
    assert.ok(pathStr.endsWith(`daemon-${TEST_PORT}.json`));
  });

  it("getDaemonState: returns uninitialized state when record file is missing", () => {
    const state = getDaemonState(TEST_PORT);
    assert.deepEqual(state, { state: "uninitialized" });
  });

  it("markDaemonRunning: writes running state, pid, and timestamps", () => {
    const res = markDaemonRunning({
      pid: 9988,
      port: TEST_PORT,
      url: `http://127.0.0.1:${TEST_PORT}`,
    });

    assert.equal(res.state, "running");
    assert.equal(res.pid, 9988);
    assert.equal(res.port, TEST_PORT);
    assert.equal(res.url, `http://127.0.0.1:${TEST_PORT}`);
    assert.ok(res.startedAt);
    assert.equal(res.stoppedAt, null);

    // Verify persisted state matches
    const persisted = getDaemonState(TEST_PORT);
    assert.equal(persisted.state, "running");
    assert.equal(persisted.pid, 9988);
    assert.equal(isDaemonExplicitlyStopped(TEST_PORT), false);
  });

  it("markDaemonStopped: transitions state to stopped with actor metadata", () => {
    markDaemonRunning({ pid: 1122, port: TEST_PORT });

    const stopped = markDaemonStopped({ stoppedBy: "unit_test_actor", port: TEST_PORT });

    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.pid, null);
    assert.equal(stopped.stoppedBy, "unit_test_actor");
    assert.ok(stopped.stoppedAt);

    // Check query helper
    assert.equal(isDaemonExplicitlyStopped(TEST_PORT), true);
  });

  it("setDaemonState: safely merges partial updates and updates timestamp", () => {
    markDaemonRunning({ pid: 1234, port: TEST_PORT });

    const updated = setDaemonState({ customTelemetry: "enabled" }, TEST_PORT);
    assert.equal(updated.state, "running");
    assert.equal(updated.customTelemetry, "enabled");
    assert.ok(updated.updatedAt);

    const reloaded = getDaemonState(TEST_PORT);
    assert.equal(reloaded.customTelemetry, "enabled");
  });
});
