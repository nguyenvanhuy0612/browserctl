// Fixture for tests/unit/multi_browser_parallel_script.test.mjs: a real bridge (bridge/server.js
// on an ephemeral port), fake extensions that model the gate's fixture page in memory, and the
// real tests/e2e/multi_browser_parallel.mjs spawned as a child process pointed at that bridge
// through BROWSERCTL_BRIDGE_URL. Usage: node multi-browser-parallel.mjs <case>. Prints OK <case>
// on success; a failed assertion exits non-zero. HOME/USERPROFILE must already point at a temp
// directory (the parent test sets them).
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { execFile } from "node:child_process";
import util from "node:util";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const run = util.promisify(execFile);
const CASE = process.argv[2];
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, "..", "..", "e2e", "multi_browser_parallel.mjs");

process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.FANOUT_TIMEOUT_MS = "1000";
process.env.COMMAND_TIMEOUT_MS = "5000";
const CALL_LOG = join(mkdtempSync(join(tmpdir(), "browserctl-parallel-script-")), "calls.jsonl");
process.env.BROWSERCTL_CALL_LOG = CALL_LOG;

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

// ---------------------------------------------------------------- fake extension

let nextInstance = 0;
let nextTabId = 7000;
// Every answer takes this long, as a real page action does, so a session's window is set by the
// commands it runs rather than by how the test machine schedules three processes.
const ANSWER_MS = 40;
const IMAGE = `data:image/jpeg;base64,${Buffer.alloc(2000, 7).toString("base64")}`;

// The fixture page as the gate reads it: what each selector reads back, per page.
function freshPage(url) {
  const path = new URL(url).pathname;
  return {
    url,
    path,
    title:
      {
        "/form": "browserctl test form",
        "/next": "browserctl next page",
        "/long": "browserctl long page",
        "/submit": "browserctl submitted",
      }[path] || "",
    values: { "#name": "", "#email": "", "#notes": "", "#color": "" },
    text: {
      "#count": "0",
      "#hoverstate": "idle",
      "#lastkey": "none",
      "#uploaded": "none",
      "#title": { "/next": "Next page", "/submit": "Submitted" }[path] || "browserctl test form",
    },
    checked: { "#agree": false, "input[value=l]": false },
    atBottom: false,
  };
}

// A stand-in extension whose tabs hold a model of the fixture page. Faults: brokenCounter (the
// click counter never moves), failBackgroundCapture (a viewport capture of a background tab
// fails as a browser that paints nothing would), failCloseTab (a tab cannot be closed).
function fake({ type, faults = {} }) {
  const f = { instanceId: `inst-p${++nextInstance}`, type, tabs: new Map(), received: [] };
  f.tabs.set(++nextTabId, {
    id: nextTabId,
    active: true,
    page: freshPage("https://owner.example/"),
  });
  const tabOf = (params) => {
    const t = f.tabs.get(params.tabId);
    if (!t) throw new Error(`tab ${params.tabId} not found`);
    return t;
  };
  const view = (t) => ({
    id: t.id,
    url: t.page.url,
    title: t.page.title,
    active: t.active,
    windowId: 1,
    focusedWindow: t.active,
  });
  const goTo = (t, url) => {
    t.page = freshPage(url);
    return { url };
  };
  const answer = (action, params) => {
    switch (action) {
      case "list_tabs":
        return { tabs: [...f.tabs.values()].map(view), pinned: null };
      case "new_tab": {
        const t = { id: ++nextTabId, active: false, page: freshPage(params.url) };
        f.tabs.set(t.id, t);
        return { id: t.id, url: t.page.url, title: t.page.title, ready: true };
      }
      case "close_tab":
        if (faults.failCloseTab)
          throw new Error(`close_tab failed (simulated) for tab ${params.id}`);
        f.tabs.delete(params.id);
        return { id: params.id, alreadyClosed: false };
      case "current_tab": {
        const t = tabOf(params);
        return { ...view(t), pinned: true };
      }
    }
    const t = tabOf(params);
    const p = t.page;
    switch (action) {
      case "wait_for":
        return { found: true, waitedMs: 3 };
      case "snapshot":
        return {
          url: p.url,
          title: p.title,
          census: '  [@ref_1] <button> "Add one"',
          elements: [],
        };
      case "read_page":
        return { url: p.url, title: p.title, tree: 'textbox "Full name" [ref_1]' };
      case "find":
        return { count: 1, matches: [{ ref: "ref_1", name: params.query }] };
      case "get_page_content":
        return { title: p.title, url: p.url, text: "Alpha 10 Beta 20 Gamma 30" };
      case "extract":
        return {
          extracted: 3,
          count: 3,
          selector: params.selector,
          fields: ["title", "n"],
          matches: [
            { ref: "ref_2", title: "Alpha", n: "10" },
            { ref: "ref_3", title: "Beta", n: "20" },
            { ref: "ref_4", title: "Gamma", n: "30" },
          ],
        };
      case "click": {
        const effect = { measured: true, domMutated: true, mutationCount: 1, urlChanged: false };
        if (params.target === "#inc") {
          if (!faults.brokenCounter) p.text["#count"] = String(Number(p.text["#count"]) + 1);
        } else if (params.target in p.checked) {
          p.checked[params.target] = true;
          return {
            clicked: params.target,
            effect: {
              ...effect,
              domMutated: false,
              mutationCount: 0,
              controlState: { changed: ["checked: false -> true"], unchanged: [] },
            },
          };
        } else if (params.target === "#nextlink") {
          goTo(t, new URL("/next", p.url).href);
          return { navigated: true };
        } else if (params.target === "#submit") {
          const name = p.values["#name"];
          goTo(t, new URL(`/submit?name=${encodeURIComponent(name)}`, p.url).href);
          t.page.text["#echo"] = `?name=${name}&email=&color=&notes=&upload=`;
          return { navigated: true };
        }
        return { clicked: params.target, effect };
      }
      case "fill":
        p.values[params.target] = params.text;
        return { typed: params.target };
      case "fill_form":
        for (const fl of params.fields) p.values[fl.target] = fl.value;
        return { filled: params.fields.length };
      case "select_option":
        p.values[params.target] = (params.values || [])[0] ?? params.value;
        return { selected: [p.values[params.target]] };
      case "hover":
        p.text["#hoverstate"] = "hovered";
        return { hovered: params.target };
      case "press_key":
        p.text["#lastkey"] = params.key;
        return { pressed: params.key };
      case "upload":
        p.text["#uploaded"] = basename(params.file);
        return { files: [basename(params.file)], count: 1 };
      case "get_property": {
        const k = params.target;
        let value;
        if (params.property === "checked") value = p.checked[k];
        else if (params.property === "value") value = p.values[k];
        else value = p.text[k];
        if (value === undefined) throw new Error(`no element matches ${k}`);
        return { property: params.property, value };
      }
      case "eval_js": {
        const e = params.expression;
        if (e === "document.title") return { value: p.title, type: "string" };
        if (e === "document.visibilityState")
          return { value: t.active ? "visible" : "hidden", type: "string" };
        if (e.includes("getElementById('bottom')")) return { value: p.atBottom, type: "boolean" };
        return { value: null };
      }
      case "navigate":
        return goTo(t, params.url);
      case "scroll":
        if (params.direction === "down" && params.amount >= 10000) p.atBottom = true;
        return { scrolledY: 6000, delta: 6000 };
      case "screenshot":
        if (faults.failBackgroundCapture && !t.active) {
          throw new Error(
            `tab ${t.id} is not in front and this browser did not paint it for a capture.`
          );
        }
        return { dataUrl: IMAGE };
      case "element_screenshot":
      case "capture_screenshot":
        return { dataUrl: IMAGE };
      default:
        return { action, tabId: t.id };
    }
  };
  f.connect = () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      f.ws = ws;
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
        if (!msg.id) return;
        f.received.push({ action: msg.action, params: msg.params || {} });
        let reply;
        try {
          reply = { id: msg.id, ok: true, result: answer(msg.action, msg.params || {}) };
        } catch (err) {
          reply = { id: msg.id, ok: false, error: err.message };
        }
        setTimeout(() => ws.send(JSON.stringify(reply)), ANSWER_MS);
      });
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            type: "hello",
            instanceId: f.instanceId,
            browserType: type,
            focused: false,
          })
        );
        resolve();
      });
      ws.once("error", reject);
    });
  return f;
}

async function browsers(...specs) {
  const out = [];
  for (const spec of specs) {
    const f = fake(spec);
    const before = (await status()).browsers.length;
    await f.connect();
    await waitFor(
      async () => (await status()).browsers.length === before + 1,
      "a browser to register"
    );
    f.alias = (await status()).browsers.find((b) => b.instanceId === f.instanceId).alias;
    out.push(f);
  }
  return out;
}

async function runScript() {
  const env = { ...process.env };
  for (const k of [
    "PORT",
    "HOST",
    "FANOUT_TIMEOUT_MS",
    "COMMAND_TIMEOUT_MS",
    "BROWSERCTL_CALL_LOG",
    "BRIDGE_URL",
    "BROWSERCTL_PARALLEL_BROWSERS",
  ]) {
    delete env[k];
  }
  env.BROWSERCTL_BRIDGE_URL = BASE;
  try {
    const { stdout } = await run(process.execPath, [SCRIPT_PATH], { env, timeout: 60000 });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.code ?? 1, stdout: (err.stdout || "") + (err.stderr || "") };
  }
}

// Only the tab each fake started with is left: the run closed every tab it opened.
function onlyOwnerTabsLeft(fakes) {
  for (const f of fakes) {
    const urls = [...f.tabs.values()].map((t) => t.page.url);
    assert.deepEqual(
      urls,
      ["https://owner.example/"],
      `${f.alias} has tabs left: ${urls.join(", ")}`
    );
  }
}

// The fakes' own view of who touched which tab: nothing but list_tabs and the tab it opened.
function eachFakeSawOnlyItsOwnTab(fakes) {
  for (const f of fakes) {
    const opened = f.received.filter((m) => m.action === "new_tab").length;
    assert.equal(opened, 1, `${f.alias} opened ${opened} tabs`);
    const ownerTab = [...f.tabs.keys()][0];
    const touched = f.received.filter(
      (m) => m.params.tabId === ownerTab || m.params.id === ownerTab
    );
    assert.deepEqual(touched, [], `${f.alias}: the owner's tab was touched`);
  }
}

// ---------------------------------------------------------------- the cases

const CASES = {
  async "case-pass"() {
    const fakes = await browsers({ type: "chrome" }, { type: "edge" }, { type: "brave" });
    const { code, stdout } = await runScript();
    assert.equal(code, 0, stdout);
    for (const f of fakes)
      assert.match(stdout, new RegExp(`^${f.alias}: (\\d+)/\\1 steps passed$`, "m"));
    assert.match(stdout, /\[PASS\] sessions ran in parallel — windows overlap \d+%/);
    const logLine = stdout.match(
      /\[PASS\] call log names only each session's own browser and tab — (.*)/
    );
    assert.ok(logLine, stdout);
    for (const f of fakes) assert.match(logLine[1], new RegExp(`${f.alias} \\d+ lines`));
    assert.match(stdout, /\[PASS\] every opened tab is closed — 3 opened, 0 left/);
    assert.match(
      stdout,
      /\[PASS\] chrome-1: screenshot \(background\) — \d+ ms, tab in the background/
    );
    assert.match(stdout, /RESULT: (\d+)\/\1 checks passed, 0 skipped, 0 failed/);
    onlyOwnerTabsLeft(fakes);
    eachFakeSawOnlyItsOwnTab(fakes);
  },

  // A read-back that does not match fails the run, names the step, and the tab is still closed.
  async "case-readback-fails"() {
    const fakes = await browsers(
      { type: "chrome" },
      { type: "edge", faults: { brokenCounter: true } }
    );
    const { code, stdout } = await runScript();
    assert.equal(code, 1, stdout);
    assert.match(stdout, /\[FAIL\] edge-1: #count reads 2 — read back "0", expected "2"/);
    assert.doesNotMatch(stdout, /\[FAIL\] chrome-1/);
    assert.match(stdout, /\[PASS\] every opened tab is closed/);
    onlyOwnerTabsLeft(fakes);
  },

  // A background capture that fails is a FAIL, not an expected outcome.
  async "case-capture-fails"() {
    const fakes = await browsers(
      { type: "chrome" },
      { type: "edge", faults: { failBackgroundCapture: true } }
    );
    const { code, stdout } = await runScript();
    assert.equal(code, 1, stdout);
    assert.match(stdout, /\[FAIL\] edge-1: screenshot \(background\) — \d+ ms, .*did not paint it/);
    onlyOwnerTabsLeft(fakes);
  },

  // A tab that cannot be closed is reported with its id, and the run still finishes.
  async "case-close-fails"() {
    await browsers({ type: "chrome" }, { type: "edge", faults: { failCloseTab: true } });
    const { code, stdout } = await runScript();
    assert.equal(code, 1, stdout);
    assert.match(stdout, /\[FAIL\] edge-1: close tab \d+ — .*close it by hand/);
    assert.match(stdout, /\[FAIL\] every opened tab is closed — left open: edge-1 tab \d+/);
    assert.match(stdout, /RESULT: /);
  },

  async "case-one-browser-skips"() {
    const [f] = await browsers({ type: "chrome" });
    const { code, stdout } = await runScript();
    assert.equal(code, 0, stdout);
    assert.match(stdout, /^SKIPPED \(one browser\)/m);
    assert.doesNotMatch(stdout, /RESULT:/);
    assert.deepEqual(f.received, []);
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
