// @ts-check
// MCP server and CLI against a daemon on a free port (no browser needed).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Registry } from "../../src/daemon/registry.js";
import { tools } from "../../src/daemon/tools/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const run = promisify(execFile);
/** @type {string} */
let home;
/** @type {number} */
let port;
/** @type {NodeJS.ProcessEnv} */
let env;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bctl-clients-"));
  port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = /** @type {net.AddressInfo} */ (s.address()).port;
      s.close(() => resolve(p));
    });
  });
  env = { ...process.env, BROWSERCTL_PORT: String(port), BROWSERCTL_HOME: home };
});

after(async () => {
  await run(process.execPath, [path.join(root, "src/cli/main.js"), "daemon", "stop"], { env }).catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
});

/** @param {string[]} args */
async function cli(...args) {
  try {
    const { stdout } = await run(process.execPath, [path.join(root, "src/cli/main.js"), ...args], { env });
    return { code: 0, out: stdout };
  } catch (error) {
    const e = /** @type {any} */ (error);
    return { code: e.code, out: e.stdout + e.stderr };
  }
}

test("API-E02 / API-E03 MCP server starts the daemon and registers every tool; exit ends its session", async () => {
  const child = spawn(process.execPath, [path.join(root, "src/mcp/main.js")], { env, stdio: ["pipe", "pipe", "inherit"] });
  // a failed assertion must not leave the MCP server running, or the test runner never exits
  try {
    let buffer = "";
    /** @type {Map<number, (m: any) => void>} */
    const waiting = new Map();
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        const message = JSON.parse(line);
        waiting.get(message.id)?.(message);
      }
    });
    /** @param {number} id @param {string} method @param {object} params */
    const rpc = (id, method, params) =>
      new Promise((resolve) => {
        waiting.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    const init = /** @type {any} */ (await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }));
    assert.match(init.result.instructions, /trusted: true/);
    for (const word of [/label=/, /\btimeout\b/, /\bscroll\b/, /\bwait\b/, /\bget\b/]) assert.match(init.result.instructions, word);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = /** @type {any} */ (await rpc(2, "tools/list", {}));
    assert.equal(list.result.tools.length, 19);
    const budget = JSON.stringify(list.result.tools).length + init.result.instructions.length;
    assert.ok(budget < 22_500, `agent reading budget: ${budget} chars`);
    const call = /** @type {any} */ (await rpc(3, "tools/call", { name: "click", arguments: { selector: "#x" } }));
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /INVALID_PARAMS/);
    const status = /** @type {any} */ (await rpc(4, "tools/call", { name: "status", arguments: {} }));
    const sessionId = JSON.parse(status.result.content[0].text).session.id;
    assert.match(sessionId, /^mcp-/);
    child.stdin.end();
    await new Promise((r) => child.once("exit", r));
    const sessions = JSON.parse(fs.readFileSync(path.join(home, "sessions.json"), "utf8")).sessions;
    assert.ok(!sessions.some((/** @type {any} */ s) => s.id === sessionId), "session ended on exit");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

test("API-U01 the CLI and the HTTP registry list every tool and every parameter, nothing else", async () => {
  const expected = new Registry(tools).list();
  const res = await fetch(`http://127.0.0.1:${port}/v1/tools`);
  assert.deepEqual((await res.json()).tools, expected);
  const lines = (await cli("tools")).out.trim().split("\n");
  assert.equal(lines.length, expected.length);
  for (const tool of expected) {
    const line = lines.find((/** @type {string} */ l) => l.split(/\s+/)[0] === tool.name);
    assert.ok(line, tool.name);
    const flags = line.split(/\s+/).slice(1).map((/** @type {string} */ f) => f.replace(/^\*/, "").split(":")[0]);
    assert.deepEqual(flags, Object.keys(tool.inputSchema.properties), tool.name);
  }
});

test("API-U05 CLI: typed flags, sessions and exit codes", async () => {
  const tools = await cli("tools");
  assert.equal(tools.code, 0);
  assert.match(tools.out, /^click\s+\*target:string/m);
  const status = await cli("status");
  assert.equal(status.code, 0);
  assert.equal(JSON.parse(status.out).session.id, "cli");
  const bad = await cli("click", "--target", "#x", "--doubleClick", "--button", "back");
  assert.equal(bad.code, 1);
  assert.match(bad.out, /INVALID_PARAMS/);
  const noTab = await cli("snapshot", "--maxChars", "5000", "--session", "other");
  assert.equal(noTab.code, 1);
  assert.match(noTab.out, /NO_TAB/);
  assert.equal((await cli("daemon", "status")).code, 0);
});

test("API-U06 extension path copies the extension into BROWSERCTL_HOME/extension and refreshes it", async () => {
  const first = await cli("extension", "path");
  assert.equal(first.code, 0, first.out);
  const folder = first.out.trim();
  assert.equal(folder, path.join(home, "extension"));
  assert.ok(fs.existsSync(path.join(folder, "manifest.json")));
  assert.ok(fs.existsSync(path.join(folder, "generated", "pw-injected.js")));
  fs.writeFileSync(path.join(folder, "stray.js"), "");
  const second = await cli("extension", "path");
  assert.equal(second.out.trim(), folder);
  assert.ok(!fs.existsSync(path.join(folder, "stray.js")));
});
