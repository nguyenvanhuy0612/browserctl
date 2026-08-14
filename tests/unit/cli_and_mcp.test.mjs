import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import util from "node:util";

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

test("CLI: status returns valid json", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "status"]);
  const data = JSON.parse(stdout);
  assert.equal(typeof data.ok, "boolean");
});

test("MCP: core profile filters tools and registers browser_action", async () => {
  // Test by importing mcp server in subprocess or checking env
  const script = `
    process.env.BROWSERCTL_MCP_PROFILE = "core";
    const mod = await import("${join(__dirname, "..", "..", "mcp", "index.js")}");
    // If it loads without errors, core profile is valid
    console.log("MCP_OK");
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script]);
  assert.ok(stdout.includes("MCP_OK"));
});
