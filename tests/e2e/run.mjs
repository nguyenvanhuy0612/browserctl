// End-to-end test runner for ai-browser-control.
//
// Drives the LIVE stack (agent -> bridge -> extension -> Chrome) by POSTing real
// commands to the running bridge, against a controlled test page this script
// serves over http (real origin, so localStorage works). Exercises the essential
// commands and the behaviours most recently changed:
//   - type/fill via the native value setter survives a React-like controlled input
//   - element_screenshot resolves by REF (not just a snapshot index), incl. shadow DOM
//   - snapshot/find pierce an open shadow root
//   - navigate/go_back/go_forward wait for the real load (hardened waitForComplete)
//   - coordinate_click maps viewport pixels correctly
//
// Prereqs: bridge running (bridge/ npm start) and the extension connected.
// Run:  node tests/e2e/run.mjs
// It creates a dedicated tab, runs everything there, and closes it at the end.

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BRIDGE = process.env.BRIDGE_URL || "http://127.0.0.1:8765";
const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_RAW = readFileSync(join(HERE, "testpage.html"), "utf8");
const SECOND = "<!doctype html><title>second</title><h1 id=sec>Second Page</h1>";
// Inner document for the cross-origin iframe (served from a second origin/port).
const INNER = `<!doctype html><meta charset=utf-8><title>inner</title>
  <button id=ibtn onclick="this.textContent='Iframe Clicked'">Iframe Button</button>
  <input id=iinput placeholder="Iframe Input">`;

// ---- full command surface, for a coverage report at the end ----
const ALL_ACTIONS = [
  "snapshot","read_page","find","navigate","click","type","scroll","hover","select_option",
  "press_key","wait_settle","wait_for","get_page_content","click_selector","fill_selector",
  "storage_get","storage_set","storage_remove","storage_clear","list_tabs","new_tab","group_tab",
  "ungroup_tab","switch_tab","current_tab","close_tab","go_back","go_forward","reload","list_windows",
  "focus_window","cdp_attach","cdp_detach","get_console_logs","get_network_requests","export_har",
  "eval_js","screenshot","capture_screenshot","a11y_snapshot","element_screenshot","print_pdf","audit",
  "get_cookies","set_cookie","delete_cookies","coordinate_click","coordinate_drag","insert_text",
  "get_response_body","net_start","net_stop","net_get","net_clear","wait_network_idle",
  "record_start","record_stop","record_get","replay","reload_extension",
];

const used = new Set();
async function cmd(action, params = {}) {
  used.add(action);
  const res = await fetch(`${BRIDGE}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${action}: ${data.error || "HTTP " + res.status}`);
  return data.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll find(query) until it matches or the deadline passes, instead of a fixed
// sleep-style delay — de-flakes waits on things that finish loading at variable
// speed (e.g. a cross-origin iframe) without over- or under-waiting.
async function pollFind(query, timeoutMs = 5000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let r = await cmd("find", { query });
  while (!(r.matches && r.matches.length) && Date.now() < deadline) {
    await sleep(intervalMs);
    r = await cmd("find", { query });
  }
  return r;
}
let PORT;
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (e) { results.push({ name, ok: false, err: e.message }); console.log(`  FAIL  ${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// Find a ref for an element by matching snapshot/read_page text.
function refByText(snap, needle) {
  const el = (snap.elements || []).find((e) => (e.text || "").includes(needle));
  return el && el.ref;
}

async function main() {
  // second origin (different port) for a genuinely cross-origin iframe
  const originB = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(INNER); });
  await new Promise((r) => originB.listen(0, "127.0.0.1", r));
  const PORTB = originB.address().port;
  const iframeSrc = `http://127.0.0.1:${PORTB}/inner.html`;
  const PAGE = PAGE_RAW.replace("__IFRAME_SRC__", iframeSrc);

  // serve the main test page
  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url.startsWith("/index")) { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); }
    else if (req.url.startsWith("/second")) { res.writeHead(200, { "content-type": "text/html" }); res.end(SECOND); }
    else if (req.url.startsWith("/ping")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); }
    else { res.writeHead(404); res.end("no"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;
  const base = `http://127.0.0.1:${PORT}`;
  console.log(`test page served at ${base} (cross-origin iframe at ${iframeSrc})\nrunning against bridge ${BRIDGE}\n`);

  let tabId;
  try {
    // --- tab setup ---
    await test("new_tab", async () => { const r = await cmd("new_tab", { url: base + "/" }); tabId = r.id; assert(tabId != null, "no tab id"); });
    await cmd("wait_settle", {});
    await test("group_tab (no activation)", async () => { const r = await cmd("group_tab", { title: "e2e", color: "green" }); assert(r.tabId === tabId, "grouped wrong tab"); });
    await test("current_tab pinned", async () => { const r = await cmd("current_tab", {}); assert(r.pinned && r.id === tabId, "target not pinned to test tab"); assert(/127\.0\.0\.1/.test(r.url), "wrong url"); });
    await test("list_tabs includes test tab", async () => { const r = await cmd("list_tabs", {}); assert(r.tabs.some((t) => t.id === tabId), "tab missing"); });
    await test("list_windows", async () => { const r = await cmd("list_windows", {}); assert(r.windows.length >= 1, "no windows"); });

    // --- reads (incl. shadow DOM) ---
    let snap;
    await test("snapshot", async () => { snap = await cmd("snapshot", {}); assert(snap.text.includes("AIBC Test Page"), "body text missing"); assert(snap.elements.length >= 5, "too few elements"); });
    await test("snapshot pierces shadow DOM", async () => { assert(refByText(snap, "Shadow Button"), "shadow button not in snapshot"); });
    await test("read_page", async () => { const r = await cmd("read_page", { mode: "interactive" }); assert(/Click Me/.test(r.tree) && /ref_/.test(r.tree), "read_page tree missing button/ref"); });
    await test("read_page pierces shadow DOM", async () => { const r = await cmd("read_page", { mode: "interactive" }); assert(/Shadow Button/.test(r.tree), "read_page tree missing shadow button"); });
    await test("find (shadow)", async () => { const r = await cmd("find", { query: "Shadow Button" }); assert(r.matches.length >= 1 && r.matches[0].ref, "find did not locate shadow button"); });

    // --- cross-origin iframe (all_frames + frame-qualified refs) ---
    let iframeBtnRef;
    await test("snapshot sees cross-origin iframe (frame-qualified ref)", async () => {
      await pollFind("Iframe Button"); // poll until the cross-origin iframe finishes loading
      const s = await cmd("snapshot", {});
      const el = (s.elements || []).find((e) => (e.text || "").includes("Iframe Button"));
      assert(el && /^f\d+:/.test(el.ref), `iframe button missing / not frame-qualified (ref=${el && el.ref})`);
      assert(el.frame && /127\.0\.0\.1/.test(el.frame), "iframe element missing 'frame' url");
      iframeBtnRef = el.ref;
    });
    await test("read_page shows iframe subtree", async () => {
      const r = await cmd("read_page", { mode: "interactive" });
      assert(/iframe \[f\d+\]/.test(r.tree) && /Iframe Button/.test(r.tree), "read_page missing iframe subtree");
    });
    await test("click element INSIDE cross-origin iframe (frame-routed)", async () => {
      await cmd("click", { ref: iframeBtnRef });
      const f = await cmd("find", { query: "Iframe Clicked" });
      assert(f.matches.length >= 1, "iframe click had no effect (not routed into the frame?)");
    });
    await test("type INTO cross-origin iframe input (frame-routed)", async () => {
      const inp = (await cmd("find", { query: "Iframe Input" })).matches[0];
      assert(inp && /^f\d+:/.test(inp.ref), "iframe input not found");
      await cmd("type", { ref: inp.ref, text: "xf" });
      const s = await cmd("snapshot", {});
      const el = (s.elements || []).find((e) => e.ref === inp.ref);
      assert(el && el.value === "xf", `iframe input value=${el && JSON.stringify(el.value)}`);
    });
    await test("get_page_content", async () => { const r = await cmd("get_page_content", {}); assert(r.text.includes("AIBC Test Page"), "content missing"); });
    await test("wait_for selector", async () => { await cmd("wait_for", { selector: "#title" }); });
    await test("wait_for text", async () => { await cmd("wait_for", { text: "AIBC Test Page" }); });

    // --- interactions ---
    await test("click by ref + effect", async () => {
      const ref = refByText(snap, "Click Me"); assert(ref, "no button ref");
      await cmd("click", { ref });
      const v = await cmd("eval_js", { expression: "window.__clicked||0" });
      assert(v.value === 1, `click had no effect (clicked=${v.value})`);
    });
    await test("click shadow button by ref + effect", async () => {
      const ref = refByText(snap, "Shadow Button"); assert(ref, "no shadow button ref");
      await cmd("click", { ref });
      const v = await cmd("eval_js", { expression: "window.__shadowClicked||0" });
      assert(v.value === 1, `shadow click had no effect (clicked=${v.value})`);
    });
    await test("type into plain input", async () => {
      const ref = refByText(snap, "Plain input") || (snap.elements.find((e) => e.type === "text" && e.placeholder === "Plain input") || {}).ref;
      await cmd("type", { ref: ref || (await cmd("find", { query: "Plain" })).matches[0].ref, text: "hello" });
      const v = await cmd("eval_js", { expression: "document.getElementById('plain').value" });
      assert(v.value === "hello", `plain value = ${JSON.stringify(v.value)}`);
    });
    await test("type survives React-like controlled input (native setter)", async () => {
      const ref = (await cmd("find", { query: "Controlled" })).matches[0].ref;
      await cmd("type", { ref, text: "world" });
      const v = await cmd("eval_js", { expression: "document.getElementById('controlled').value" });
      assert(v.value === "world", `controlled input reverted (value=${JSON.stringify(v.value)}) — native setter fix regressed`);
    });
    await test("fill_selector controlled input", async () => {
      await cmd("fill_selector", { selector: "#controlled", value: "css2" });
      const v = await cmd("eval_js", { expression: "document.getElementById('controlled').value" });
      assert(v.value === "css2", `fill_selector value=${JSON.stringify(v.value)}`);
    });
    await test("select_option by value", async () => {
      const ref = (await cmd("find", { query: "Banana" })).matches[0]?.ref || (await cmd("snapshot", {})).elements.find((e) => e.tag === "select")?.ref;
      await cmd("select_option", { ref, value: "b" });
      const v = await cmd("eval_js", { expression: "document.getElementById('sel').value" });
      assert(v.value === "b", `select value=${JSON.stringify(v.value)}`);
    });
    await test("hover", async () => {
      const ref = (await cmd("find", { query: "hover me" })).matches[0].ref;
      await cmd("hover", { ref });
      const v = await cmd("eval_js", { expression: "document.getElementById('hovered').textContent" });
      assert(v.value === "yes", "hover had no effect");
    });
    await test("press_key Escape on input (no throw)", async () => { const ref = (await cmd("find", { query: "Plain" })).matches[0].ref; await cmd("press_key", { ref, key: "Escape" }); });
    await test("scroll", async () => { await cmd("scroll", { direction: "down", amount: 200 }); });
    await test("click_selector", async () => { await cmd("click_selector", { selector: "#btn" }); const v = await cmd("eval_js", { expression: "window.__clicked||0" }); assert(v.value >= 2, "click_selector no effect"); });

    // --- storage ---
    await test("storage set/get/remove/clear", async () => {
      await cmd("storage_set", { key: "k", value: "v1" });
      let r = await cmd("storage_get", { key: "k" }); assert(r.value === "v1", "get after set");
      await cmd("storage_remove", { key: "k" });
      r = await cmd("storage_get", { key: "k" }); assert(r.value === null, "get after remove");
      await cmd("storage_set", { key: "k2", value: "v2" });
      await cmd("storage_clear", {});
      r = await cmd("storage_get", { key: "k2" }); assert(r.value === null, "get after clear");
    });

    // --- CDP-backed ---
    await test("cdp_attach", async () => { const r = await cmd("cdp_attach", {}); assert(r.attached, "not attached"); });
    await test("get_console_logs", async () => { const r = await cmd("get_console_logs", {}); assert(r.logs.some((l) => (l.text || "").includes("aibc-test-page-ready")), "console msg missing"); });
    await test("get_network_requests + get_response_body (CDP)", async () => {
      await cmd("eval_js", { expression: "fetch('/ping.json?cdp='+Date.now())" });
      await cmd("wait_network_idle", { idleMs: 400, timeoutMs: 5000 });
      const r = await cmd("get_network_requests", { urlContains: "ping.json" });
      assert(r.requests.length >= 1 && r.requests[0].requestId, "no cdp requests / missing requestId");
      const body = await cmd("get_response_body", { requestId: r.requests[0].requestId });
      assert((body.body || "").includes("ok"), `no/short response body: ${JSON.stringify(body.body)}`);
    });
    await test("eval_js compute", async () => { const r = await cmd("eval_js", { expression: "6*7" }); assert(r.value === 42, "eval math wrong"); });
    // coordinate_click BEFORE any screenshot: with no capture yet, captureScale is 1, so
    // viewport (CSS) pixels map 1:1 to the model's screenshot space. (After a screenshot
    // on a HiDPI display the scale differs and coords must be given in screenshot space.)
    await test("coordinate_click maps to viewport", async () => {
      const before = (await cmd("eval_js", { expression: "window.__clicked||0" })).value;
      const c = await cmd("eval_js", { expression: "(()=>{const r=document.getElementById('btn').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()" });
      await cmd("coordinate_click", { x: c.value.x, y: c.value.y });
      const after = (await cmd("eval_js", { expression: "window.__clicked||0" })).value;
      assert(after === before + 1, `coordinate_click missed (${before}->${after})`);
    });
    await test("coordinate_drag (no throw)", async () => { const r = await cmd("coordinate_drag", { fromX: 6, fromY: 6, toX: 60, toY: 60 }); assert(r.dragged, "drag failed"); });
    await test("insert_text into focused field", async () => {
      await cmd("eval_js", { expression: "document.getElementById('area').focus()" });
      await cmd("insert_text", { text: "inserted" });
      const v = await cmd("eval_js", { expression: "document.getElementById('area').value" });
      assert(v.value.includes("inserted"), `insert_text value=${JSON.stringify(v.value)}`);
    });
    await test("press_key Cmd/Ctrl+A selectAll then replace (editor command)", async () => {
      const ref = (await cmd("find", { query: "Plain" })).matches[0].ref;
      await cmd("type", { ref, text: "abcdef" });          // focuses #plain, value=abcdef
      await cmd("press_key", { key: "a", modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
      await cmd("insert_text", { text: "Z" });              // replaces the selection
      const v = await cmd("eval_js", { expression: "document.getElementById('plain').value" });
      assert(v.value === "Z", `selectAll+replace did not select all (value=${JSON.stringify(v.value)})`);
    });
    await test("a11y_snapshot", async () => { const r = await cmd("a11y_snapshot", {}); assert(r.count > 0, "empty a11y"); });
    await test("screenshot (viewport)", async () => { const r = await cmd("screenshot", {}); assert(/^data:image\/(jpeg|png);base64,/.test(r.dataUrl), "no image"); });
    await test("capture_screenshot (full page)", async () => { const r = await cmd("capture_screenshot", { fullPage: true, format: "jpeg" }); assert(/^data:image\/(jpeg|png);base64,/.test(r.dataUrl), "no image"); });
    await test("element_screenshot BY REF", async () => {
      const ref = (await cmd("find", { query: "Click Me" })).matches[0].ref;
      const r = await cmd("element_screenshot", { ref, format: "png" });
      assert(/^data:image\/png;base64,/.test(r.dataUrl), "no element image via ref");
    });
    await test("cookies set/get/delete", async () => {
      await cmd("set_cookie", { name: "e2e", value: "1", url: base + "/" });
      const g = await cmd("get_cookies", { urlContains: "127.0.0.1" });
      assert(g.cookies.some((c) => c.name === "e2e"), "cookie not set");
      await cmd("delete_cookies", { name: "e2e", url: base + "/" });
    });
    await test("print_pdf", async () => { const r = await cmd("print_pdf", {}); assert(r.base64 && r.base64.length > 100, "no pdf"); });
    await test("audit", async () => { const r = await cmd("audit", {}); assert(r.performance && r.accessibility, "audit missing sections"); });
    await test("export_har", async () => { const r = await cmd("export_har", {}); assert(r.log && Array.isArray(r.log.entries), "no har"); });

    // --- light network capture ---
    await test("net_start/get/stop + wait_network_idle", async () => {
      await cmd("net_start", {});
      await cmd("eval_js", { expression: "fetch('/ping.json?x='+Date.now())" });
      await cmd("wait_network_idle", { idleMs: 400, timeoutMs: 5000 });
      const r = await cmd("net_get", { urlContains: "ping.json" });
      assert(r.requests.length >= 1, "ping not captured");
      await cmd("net_clear", {});
      await cmd("net_stop", {});
    });

    // --- navigation + hardened waitForComplete ---
    await test("navigate + go_back + go_forward", async () => {
      const n = await cmd("navigate", { url: base + "/second.html" });
      assert(/second\.html/.test(n.url), `navigate url=${n.url}`);
      await cmd("go_back", {}); await cmd("wait_settle", {});
      const c1 = await cmd("current_tab", {}); assert(!/second/.test(c1.url), `go_back url=${c1.url}`);
      await cmd("go_forward", {}); await cmd("wait_settle", {});
      const c2 = await cmd("current_tab", {}); assert(/second/.test(c2.url), `go_forward url=${c2.url}`);
    });
    await test("reload", async () => { await cmd("reload", {}); });

    // --- recorder ---
    await test("record_start/get/stop", async () => {
      await cmd("record_start", {});
      await cmd("click_selector", { selector: "#sec" }).catch(() => {}); // second page element
      const r = await cmd("record_get", {});
      await cmd("record_stop", {});
      assert(typeof r.count === "number", "record_get shape");
    });
    await test("replay explicit steps", async () => {
      const r = await cmd("replay", { steps: [{ type: "navigate", url: base + "/" }, { type: "click", selector: "#btn" }] });
      assert(r.replayed >= 1, `replay did nothing (${JSON.stringify(r)})`);
    });

    // --- switch_tab without focus (no window raise) ---
    await test("switch_tab (focus omitted)", async () => { await cmd("switch_tab", { id: tabId }); const c = await cmd("current_tab", {}); assert(c.id === tabId, "switch_tab retarget"); });

    // --- teardown of CDP ---
    await test("cdp_detach", async () => { const r = await cmd("cdp_detach", {}); assert(r.attached === false, "still attached"); });
    await test("ungroup_tab", async () => { await cmd("ungroup_tab", {}); });
  } finally {
    if (tabId != null) { try { await cmd("close_tab", { id: tabId }); } catch {} }
    server.close();
    originB.close();
  }

  // ---- report ----
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${passed}/${results.length} checks passed ====`);
  if (failed.length) { console.log("FAILURES:"); for (const f of failed) console.log(`  - ${f.name}: ${f.err}`); }

  const untested = ALL_ACTIONS.filter((a) => !used.has(a));
  console.log(`\nCommand coverage: ${ALL_ACTIONS.length - untested.length}/${ALL_ACTIONS.length} exercised`);
  if (untested.length) console.log("NOT exercised (needs visual coords / dev-only / destructive): " + untested.join(", "));

  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("runner crashed:", e); process.exit(2); });
