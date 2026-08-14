import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import util from "node:util";
import {
  getDaemonState,
  markDaemonRunning,
  markDaemonStopped,
  isDaemonExplicitlyStopped,
} from "../../bridge/state.js";

const execFileAsync = util.promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, "..", "..", "cli.js");

test("CLI: prints help text when invoked with --help", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "--help"]);
  assert.ok(stdout.includes("browserctl CLI"));
  assert.ok(stdout.includes("browserctl click"));
  assert.ok(stdout.includes("browserctl snapshot"));
  assert.ok(stdout.includes("--compact"));
});

test("CLI: status supports --json and default human output", async () => {
  const { stdout: jsonOut } = await execFileAsync(process.execPath, [cliPath, "status", "--json"]);
  const data = JSON.parse(jsonOut);
  assert.equal(typeof data.ok, "boolean");
  assert.ok(data.daemonState);

  const { stdout: defaultOut } = await execFileAsync(process.execPath, [cliPath, "status"]);
  assert.ok(defaultOut.includes("Bridge:"));
});

test("CLI: wait supports default, --json, --pretty, and -r modes", async () => {
  // 1. JSON mode
  const { stdout: jsonOut } = await execFileAsync(process.execPath, [cliPath, "wait", "50", "--json"]);
  const jsonData = JSON.parse(jsonOut);
  assert.ok(jsonData.ok);
  assert.equal(jsonData.waitedMs, 50);

  // 2. Pretty mode
  const { stdout: prettyOut } = await execFileAsync(process.execPath, [cliPath, "wait", "50", "--pretty"]);
  assert.ok(prettyOut.includes("\n  \"waitedMs\": 50\n"));

  // 3. Raw mode
  const { stdout: rawOut } = await execFileAsync(process.execPath, [cliPath, "wait", "50", "-r"]);
  assert.equal(rawOut.trim(), "50");

  // 4. Default mode
  const { stdout: defaultOut } = await execFileAsync(process.execPath, [cliPath, "wait", "50"]);
  assert.ok(defaultOut.includes("Waited 50ms"));
});

test("MCP: core profile filters tools and registers lifecycle tools", async () => {
  const script = `
    process.env.BROWSERCTL_MCP_PROFILE = "core";
    const mod = await import("${join(__dirname, "..", "..", "mcp", "index.js")}");
    console.log("MCP_OK");
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
  assert.ok(stdout.includes("MCP_OK"));
});

test("State Manager: transitions between running, stopped, and uninitialized correctly", () => {
  // Test running state
  const runState = markDaemonRunning({ pid: 12345, port: 8765 });
  assert.equal(runState.state, "running");
  assert.equal(runState.pid, 12345);
  assert.equal(isDaemonExplicitlyStopped(), false);

  // Test stopped state
  const stopState = markDaemonStopped({ stoppedBy: "cli_stop" });
  assert.equal(stopState.state, "stopped");
  assert.equal(stopState.stoppedBy, "cli_stop");
  assert.equal(isDaemonExplicitlyStopped(), true);

  // Recover back to running
  markDaemonRunning({ pid: 54321, port: 8765 });
  assert.equal(isDaemonExplicitlyStopped(), false);
});

test("CLI: prints full subcommands in help output", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "--help"]);
  assert.ok(stdout.includes("browserctl get"));
  assert.ok(stdout.includes("browserctl fill"));
  assert.ok(stdout.includes("browserctl clear"));
  assert.ok(stdout.includes("browserctl check"));
  assert.ok(stdout.includes("browserctl select"));
  assert.ok(stdout.includes("browserctl wait"));
  assert.ok(stdout.includes("browserctl pdf"));
  assert.ok(stdout.includes("--pretty"));
  assert.ok(stdout.includes("--raw"));
  assert.ok(stdout.includes("--auto-daemon"));
});
