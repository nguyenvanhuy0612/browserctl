// The CLI's own browser selection, against a real bridge with fake extensions, one case per
// process. Usage: node cli-browser-select.mjs <case>. Prints "OK <case>" on success; a failed
// assertion exits non-zero. HOME/USERPROFILE must already point at a temp directory (the parent
// test sets them) so the registry's alias file never touches a real one.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import util from "node:util";
import { WebSocket } from "ws";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = util.promisify(execFile);
const CASE = process.argv[2];
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "..", "..", "..", "cli.js");

process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
delete process.env.BROWSERCTL_CALL_LOG;

const { server: bridge } = await import("../../../bridge/server.js");
if (!bridge.listening) await new Promise((r) => bridge.once("listening", r));
const BASE = `http://127.0.0.1:${bridge.address().port}`;
const WS_URL = `ws://127.0.0.1:${bridge.address().port}/extension`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function status() {
  return (await fetch(`${BASE}/status`)).json();
}

async function waitFor(pred, what) {
  for (let i = 0; i < 200; i++) {
    if (await pred()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A stand-in extension: answers ping, and every routed command with its own type/action so a
// case can see exactly what reached it.
function fake({ type, focused = false }) {
  const f = { type, received: [], instanceId: `${type}-${Math.random().toString(36).slice(2)}` };
  f.connect = () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      f.ws = ws;
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
        if (!msg.id) return;
        f.received.push({ action: msg.action, params: msg.params || {} });
        const result =
          msg.action === "list_tabs"
            ? { tabs: [{ id: 1, url: "https://example.com/", title: f.type, active: true }] }
            : { by: f.type, action: msg.action };
        ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
      });
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            type: "hello",
            instanceId: f.instanceId,
            browserType: type,
            focused,
          })
        );
        resolve();
      });
      ws.once("error", reject);
    });
  return f;
}

async function connectAll(...fakes) {
  for (const f of fakes) {
    const before = (await status()).browsers.length;
    await f.connect();
    await waitFor(
      async () => (await status()).browsers.length === before + 1,
      `${f.type} to register`
    );
  }
  const s = await status();
  for (const f of fakes) {
    f.alias = s.browsers.find((b) => b.instanceId === f.instanceId).alias;
  }
}

// Runs cli.js exactly the way a real invocation would see it: BROWSERCTL_BRIDGE_URL points at
// this test bridge, BROWSERCTL_AUTO_START=manual so it never tries to spawn a real daemon, and
// any BROWSERCTL_BROWSER this process inherited is stripped so a case controls selection purely
// through argv (unless it passes its own via extraEnv).
async function runCli(args, extraEnv = {}) {
  const env = {
    ...process.env,
    BROWSERCTL_BRIDGE_URL: BASE,
    BROWSERCTL_AUTO_START: "manual",
  };
  for (const k of ["PORT", "HOST", "BROWSERCTL_CALL_LOG", "BROWSERCTL_BROWSER"]) delete env[k];
  Object.assign(env, extraEnv);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout || "", stderr: err.stderr || "" };
  }
}

const CASES = {
  // A --browser selector reaches only the named connection; the other one sees nothing.
  async "select-reaches-only-that-browser"() {
    const chrome = fake({ type: "chrome" });
    const edge = fake({ type: "edge" });
    await connectAll(chrome, edge);
    const res = await runCli(["click", "abc", "--browser", "edge"]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(edge.received.filter((c) => c.action === "click").length, 1);
    assert.equal(chrome.received.filter((c) => c.action === "click").length, 0);
  },

  // The short flag behaves the same as the long one.
  async "short-flag-reaches-only-that-browser"() {
    const chrome = fake({ type: "chrome" });
    const edge = fake({ type: "edge" });
    await connectAll(chrome, edge);
    const res = await runCli(["click", "abc", "-b", "chrome"]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(chrome.received.filter((c) => c.action === "click").length, 1);
    assert.equal(edge.received.filter((c) => c.action === "click").length, 0);
  },

  // BROWSERCTL_BROWSER supplies the default selector when no flag is given.
  async "env-var-selects-default-browser"() {
    const chrome = fake({ type: "chrome" });
    const edge = fake({ type: "edge" });
    await connectAll(chrome, edge);
    const res = await runCli(["click", "abc"], { BROWSERCTL_BROWSER: "edge" });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(edge.received.filter((c) => c.action === "click").length, 1);
    assert.equal(chrome.received.filter((c) => c.action === "click").length, 0);
  },

  // No selector, two browsers connected, neither focused: the bridge cannot pick a default and
  // the CLI must surface that as a distinct, scriptable exit code with both aliases named.
  async "no-flag-two-browsers-no-focus-needs-browser"() {
    const chrome = fake({ type: "chrome" });
    const edge = fake({ type: "edge" });
    await connectAll(chrome, edge);
    const res = await runCli(["click", "abc"]);
    assert.equal(res.code, 2, `stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stderr, /NEEDS_BROWSER/);
    assert.match(res.stderr, new RegExp(chrome.alias));
    assert.match(res.stderr, new RegExp(edge.alias));
  },

  // `status` (default, human output) lists a line per connected browser, aliases included.
  async "status-prints-both-aliases"() {
    const chrome = fake({ type: "chrome" });
    const edge = fake({ type: "edge" });
    await connectAll(chrome, edge);
    const res = await runCli(["status"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, new RegExp(chrome.alias));
    assert.match(res.stdout, new RegExp(edge.alias));
  },

  // `tab list` gains a BROWSER column only once more than one browser is connected.
  async "tab-list-shows-browser-column-with-two-browsers"() {
    const chrome = fake({ type: "chrome" });
    const edge = fake({ type: "edge" });
    await connectAll(chrome, edge);
    const res = await runCli(["tab", "list"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /BROWSER/);
  },
};

if (!CASES[CASE]) {
  console.error(`unknown case ${CASE}; known: ${Object.keys(CASES).join(", ")}`);
  process.exit(2);
}
let code = 0;
try {
  await CASES[CASE]();
  process.stdout.write(`OK ${CASE}\n`);
} catch (err) {
  console.error(err);
  code = 1;
}
process.exit(code);
