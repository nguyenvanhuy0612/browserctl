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

test("MCP: core profile registers lifecycle and dynamic load/unload tools", async () => {
  const script = `
    process.env.BROWSERCTL_MCP_PROFILE = "core";
    const { server, TOOL_CATEGORIES } = await import("${join(__dirname, "..", "..", "mcp", "index.js")}");
    const initialTools = Object.values(server._registeredTools).filter(t => t.enabled !== false);
    const initialCount = initialTools.length;

    // 1. Check browser_list_available_tools
    const listHandler = server._registeredTools["browser_list_available_tools"].handler;
    const listRes = await listHandler();
    if (!listRes.content[0].text.includes("categories")) throw new Error("List failed");

    // 2. Load 'network' category
    const loadHandler = server._registeredTools["browser_load_tools"].handler;
    await loadHandler({ profile: "network" });
    const afterLoadCount = Object.values(server._registeredTools).filter(t => t.enabled !== false).length;
    if (afterLoadCount <= initialCount) throw new Error("Load profile network failed: count did not increase");

    // 3. Unload back to core
    const unloadHandler = server._registeredTools["browser_unload_tools"].handler;
    await unloadHandler();
    const afterUnloadCount = Object.values(server._registeredTools).filter(t => t.enabled !== false).length;
    if (afterUnloadCount !== initialCount) throw new Error("Reset to core failed: count did not match initial");

    console.log("DYNAMIC_LOAD_OK");
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
  assert.ok(stdout.includes("DYNAMIC_LOAD_OK"));
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
  assert.ok(stdout.includes("browserctl paste"));
  assert.ok(stdout.includes("browserctl clear"));
  assert.ok(stdout.includes("browserctl check"));
  assert.ok(stdout.includes("browserctl select"));
  assert.ok(stdout.includes("browserctl wait"));
  assert.ok(stdout.includes("browserctl pdf"));
  assert.ok(stdout.includes("--pretty"));
  assert.ok(stdout.includes("--raw"));
  assert.ok(stdout.includes("--auto-daemon"));
});
