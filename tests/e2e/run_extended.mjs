// End-to-end tests for browserctl EXTENDED profiles:
// storage, cookies, console, network, cdp, record, tabs, advanced, system.
//
// Drives the live stack (bridge + extension + Chrome).
// Run: node tests/e2e/run_extended.mjs

import http from "node:http";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import {
  cmd,
  cmdFail,
  assert,
  test,
  openMainTab,
  teardown,
  verifyClean,
  installReaper,
  report,
} from "./harness.mjs";

installReaper();
const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_RAW = readFileSync(join(HERE, "testpage.html"), "utf8");

let PORT;

// Controls whose name, state or input handling the census and the action tools must get right:
// a search box inside a labelled region, a number field (it sanitizes a partial value), an icon
// link, a labelled field with a placeholder, a checkbox, a disabled button, a <select> wrapped
// in its label, two links for find's ranking, and a field that echoes the key it hears.
const SEARCH_FORM_PAGE = `<!doctype html><title>search form</title>
<form role="search" aria-label="Search"><input id="q" placeholder="Search"></form>
<input id="qty" type="number" aria-label="Quantity">
<a href="/" aria-label="Home logo"><svg width="20" height="20" role="img"><title>Home</title><rect width="20" height="20"/></svg></a>
<label for="em2">Work email</label><input id="em2" placeholder="you@company.com">
<input type="checkbox" id="agree"><label for="agree">I agree</label>
<button disabled>Pay now</button>
<label>Fruit <select id="fruit"><option>Apple</option><option>Pear</option></select></label>
<a href="/hn">Hacker News</a> <a href="/new">new</a>
<input id="keys" aria-label="Key sink"><span id="keyout"></span>
<script>document.getElementById("keys").addEventListener("keydown", (e) => {
  document.getElementById("keyout").textContent = e.code + ":" + e.which; });</script>`;

// A long page that counts the scroll events it hears, and a menu opened by pointerenter.
const TALL_PAGE = `<!doctype html><title>tall</title>
<button id="menu">Menu</button><span id="opened">closed</span>
<div id="links">${Array.from({ length: 40 }, (_, i) => `<a href="/story/${i}">Story ${i}</a>`).join(" ")}</div>
<div style="height:5000px"></div>
<script>
  window.__scrolls = 0;
  addEventListener("scroll", () => window.__scrolls++);
  document.getElementById("menu").addEventListener("pointerenter", () => {
    document.getElementById("opened").textContent = "open";
  });
</script>`;

// A form control whose label lives in the same shadow root, as web components ship them.
const SHADOW_LABEL_PAGE = `<!doctype html><title>shadow label</title>
<login-box></login-box>
<script>
  customElements.define("login-box", class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" }).innerHTML =
        '<label for="em">Work email</label><input id="em">' +
        '<span id="pw-l">Passcode</span><input aria-labelledby="pw-l">';
    }
  });
</script>`;

// Re-reads until the check passes or the deadline expires; returns the last read either way.
async function poll(read, ok, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await read();
    if (ok(last) || Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main() {
  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url.startsWith("/index")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE_RAW.replace("__IFRAME_SRC__", "about:blank"));
    } else if (req.url.startsWith("/tall")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(TALL_PAGE);
    } else if (req.url.startsWith("/search-form")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(SEARCH_FORM_PAGE);
    } else if (req.url.startsWith("/shadow-label")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(SHADOW_LABEL_PAGE);
    } else if (req.url.startsWith("/ping")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true,"message":"pong"}');
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;
  const base = `http://127.0.0.1:${PORT}`;

  console.log(`extended test page served at ${base}`);

  // Runs fn on one of the fixture pages and returns the tab to the main page, pass or fail, so
  // a failed assertion does not leave the tests after it on the wrong page.
  const withPage = async (path, fn) => {
    await cmd("navigate", { url: base + path });
    try {
      await fn();
    } finally {
      await cmd("navigate", { url: base + "/" });
    }
  };
  const censusOf = async () => {
    const { census } = await cmd("snapshot", { compact: true });
    const lines = census.split("\n").filter((l) => /\[@/.test(l));
    return { census, lines, has: (re) => lines.some((l) => re.test(l)) };
  };

  try {
    await openMainTab(base + "/");
    await cmd("wait_settle", { timeoutMs: 3000 });

    // ==========================================
    // 1. STORAGE PROFILE
    // ==========================================
    await test("storage: set and get single key (localStorage)", async () => {
      await cmd("storage_set", { area: "local", key: "ext_test_k1", value: "ext_val_1" });
      const r = await cmd("storage_get", { area: "local", key: "ext_test_k1" });
      assert(r.value === "ext_val_1", `expected ext_val_1, got ${r.value}`);
    });

    await test("storage: get all items", async () => {
      await cmd("storage_set", { area: "local", key: "ext_test_k2", value: "ext_val_2" });
      const r = await cmd("storage_get", { area: "local" });
      assert(r.items && r.items.ext_test_k1 === "ext_val_1", "missing ext_test_k1 in all items");
      assert(r.items.ext_test_k2 === "ext_val_2", "missing ext_test_k2 in all items");
    });

    await test("storage: sessionStorage isolation", async () => {
      await cmd("storage_set", { area: "session", key: "ext_sess_k", value: "sess_val" });
      const rSess = await cmd("storage_get", { area: "session", key: "ext_sess_k" });
      assert(rSess.value === "sess_val", "sessionStorage failed");
      const rLocal = await cmd("storage_get", { area: "local", key: "ext_sess_k" });
      assert(rLocal.value === null, "sessionStorage leaked into localStorage");
    });

    await test("storage: remove single key", async () => {
      await cmd("storage_remove", { area: "local", key: "ext_test_k1" });
      const r = await cmd("storage_get", { area: "local", key: "ext_test_k1" });
      assert(r.value === null, `key was not removed: ${r.value}`);
    });

    await test("storage: clear area", async () => {
      await cmd("storage_clear", { area: "local" });
      const r = await cmd("storage_get", { area: "local" });
      assert(Object.keys(r.items || {}).length === 0, "localStorage not empty after clear");
    });

    // ==========================================
    // 2. CDP & COOKIES PROFILE
    // ==========================================
    // The suite's tab runs in the background, so this goes through the attach-on-demand route.
    await test("element_screenshot works without a prior cdp_attach", async () => {
      await cmd("cdp_detach", {}).catch(() => {});
      const shot = await cmd("element_screenshot", { target: "css=#btn", format: "png" });
      assert(/^data:image\/png;base64,/.test(shot.dataUrl || ""), "no image without an attach");
      await cmd("cdp_detach", {});
    });

    await test("cdp: attach debugger", async () => {
      const r = await cmd("cdp_attach", {});
      assert(r.attached === true, "cdp_attach failed");
    });

    await test("cookies: set, get and delete cookie", async () => {
      const cookieName = "bctl_test_cookie";
      const cookieValue = "bctl_secret_123";
      await cmd("set_cookie", {
        url: base,
        name: cookieName,
        value: cookieValue,
      });

      const getRes = await cmd("get_cookies", { url: base });
      const found = (getRes.cookies || []).find((c) => c.name === cookieName);
      assert(
        found && found.value === cookieValue,
        `cookie not found in jar: ${JSON.stringify(getRes)}`
      );

      await cmd("delete_cookies", { url: base, name: cookieName });
      const afterDel = await cmd("get_cookies", { url: base });
      const stillFound = (afterDel.cookies || []).find((c) => c.name === cookieName);
      assert(!stillFound, "cookie was not deleted");
    });

    // ==========================================
    // 3. CONSOLE PROFILE
    // ==========================================
    await test("console: capture console log and clear", async () => {
      const marker = `bctl_log_${Date.now()}`;
      await cmd("eval_js", { expression: `console.log('${marker}')` });
      const hasMarker = (r) => (r.logs || []).some((l) => l.text && l.text.includes(marker));
      const logs = await poll(() => cmd("get_console_logs", { limit: 20 }), hasMarker);
      const found = hasMarker(logs);
      assert(found, `console log containing ${marker} not found: ${JSON.stringify(logs)}`);

      await cmd("get_console_logs", { clear: true });
      const cleared = await cmd("get_console_logs", { limit: 20 });
      assert(cleared.count === 0, `logs not cleared, count = ${cleared.count}`);
    });

    // ==========================================
    // 4. NETWORK PROFILE (CDP-based)
    // ==========================================
    await test("network (CDP): capture requests and read response body", async () => {
      await cmd("eval_js", { expression: `fetch('/ping?t=${Date.now()}')` });
      const net = await poll(
        () => cmd("get_network_requests", { urlContains: "ping" }),
        (r) => r.count > 0 && r.requests.some((q) => q.size != null)
      );
      assert(net.count > 0, "no network request captured for /ping");
      const req = net.requests.find((r) => r.url.includes("ping") && r.size != null);
      assert(req && req.requestId, "captured request has no requestId");

      const body = await cmd("get_response_body", { requestId: req.requestId });
      assert(
        body.body && body.body.includes("pong"),
        `response body missing pong: ${JSON.stringify(body)}`
      );

      const har = await cmd("export_har", { bodies: false });
      assert(har.log && Array.isArray(har.log.entries), "export_har failed to produce HAR log");
    });

    // ==========================================
    // 5. NETWORK PROFILE (Light webRequest-based)
    // ==========================================
    await test("network (Light webRequest): net_start, net_get, wait_network_idle, net_stop", async () => {
      await cmd("net_start", {});
      await cmd("eval_js", { expression: `fetch('/ping?light=${Date.now()}')` });

      const idle = await cmd("wait_network_idle", { idleMs: 200, timeoutMs: 3000, maxInFlight: 0 });
      assert(idle.idle === true, "wait_network_idle timed out or failed");

      const net = await cmd("net_get", { urlContains: "light" });
      assert(net.count > 0, "net_get did not record request");

      await cmd("net_clear", {});
      const afterClear = await cmd("net_get", { limit: 10 });
      assert(afterClear.count === 0, "net_clear failed to empty buffer");

      await cmd("net_stop", {});
    });

    // ==========================================
    // 6. CDP RAW & AUDIT & INPUT
    // ==========================================
    await test("cdp: raw cdp_send", async () => {
      const r = await cmd("cdp_send", { method: "Page.getLayoutMetrics" });
      assert(r.result && r.result.contentSize, "Page.getLayoutMetrics failed");
    });

    await test("cdp: audit", async () => {
      const r = await cmd("audit", {});
      assert(r.performance && r.accessibility, `audit result missing keys: ${JSON.stringify(r)}`);
      assert(typeof r.accessibility.totalAxNodes === "number", "audit missing totalAxNodes");
    });

    await test("cdp: insert_text", async () => {
      await cmd("click", { target: "css=#plain" });
      await cmd("insert_text", { text: "inserted_via_cdp" });
      const val = await cmd("get_property", { target: "css=#plain", property: "value" });
      assert(val.value === "inserted_via_cdp", `expected inserted_via_cdp, got ${val.value}`);
    });

    // ==========================================
    // 7. RECORD & REPLAY PROFILE
    // ==========================================
    await test("record: record_start, record_get, record_stop", async () => {
      await cmd("record_start", {});
      try {
        await cmd("click", { target: "css=#btn" });
        const rec = await poll(
          () => cmd("record_get", {}),
          (r) => Array.isArray(r.steps) && r.steps.some((st) => st.type === "click")
        );
        assert(Array.isArray(rec.steps), "record_get did not return steps array");
        assert(
          rec.steps.some((st) => st.type === "click" && /btn/.test(st.selector || "")),
          `the click on #btn was not recorded: ${JSON.stringify(rec.steps)}`
        );
      } finally {
        await cmd("record_stop", {});
      }
    });

    // ==========================================
    // 8. TABS PROFILE
    // ==========================================
    await test("tabs: list_windows and spoof_visibility", async () => {
      const wins = await cmd("list_windows", {});
      assert(Array.isArray(wins.windows) && wins.windows.length > 0, "list_windows failed");

      const spoof = await cmd("spoof_visibility", {});
      assert(spoof.spoofed && spoof.spoofed.hidden === true, "spoof_visibility failed");

      const nativeGetter =
        "Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get.toString().includes('[native code]')";
      const patched = await cmd("eval_js", { expression: nativeGetter });
      assert(patched.value === false, "spoof did not replace the hidden getter");
      const undo = await cmd("spoof_visibility", { restore: true });
      assert(undo.restored === true, `restore: ${JSON.stringify(undo)}`);
      const back = await cmd("eval_js", { expression: nativeGetter });
      assert(back.value === true, "restore did not put the page's own getter back");
      const again = await cmd("spoof_visibility", { restore: true });
      assert(again.restored === false, "a second restore has nothing to undo");
    });

    // ==========================================
    // 9. ADVANCED PROFILE
    // ==========================================
    await test("advanced: describe_element", async () => {
      const desc = await cmd("describe_element", { target: "css=#btn" });
      assert(desc.tag === "button", `expected button tag, got ${desc.tag}`);
      assert(desc.rect && typeof desc.rect.width === "number", "missing rect");
    });

    await test("advanced: a11y_snapshot", async () => {
      const a11y = await cmd("a11y_snapshot", { max: 50 });
      assert(a11y.count > 0 && Array.isArray(a11y.nodes), "a11y_snapshot returned no nodes");
    });

    await test("advanced: element_screenshot", async () => {
      const shot = await cmd("element_screenshot", { target: "css=#btn" });
      assert(
        /^data:image\/(jpeg|png);base64,/.test(shot.dataUrl || ""),
        "element_screenshot invalid dataUrl"
      );
    });

    // ==========================================
    // 10. ONE-PARAMETER ADDRESSING
    // The MCP surface sends only 'target', so each action reached through browser_action or a
    // loadable tool has to resolve from it alone.
    // ==========================================
    await test("target: check / uncheck resolve from target alone", async () => {
      const isChecked = () =>
        cmd("eval_js", { expression: "document.getElementById('cbox').checked" });
      await cmd("check", { target: "css=#cbox" });
      const on = await isChecked();
      assert(on.value === true, `check did not check: ${JSON.stringify(on)}`);
      await cmd("uncheck", { target: "css=#cbox" });
      const off = await isChecked();
      assert(off.value === false, `uncheck did not uncheck: ${JSON.stringify(off)}`);
    });

    await test("target: focus, clear, scrollintoview and dblclick resolve from target alone", async () => {
      await cmd("fill", { target: "css=#plain", text: "to be cleared" });
      await cmd("focus", { target: "Plain input" });
      const focused = await cmd("eval_js", {
        expression: "document.activeElement && document.activeElement.id",
      });
      assert(focused.value === "plain", `focus missed: ${JSON.stringify(focused)}`);
      await cmd("clear", { target: "css=#plain" });
      const val = await cmd("get_property", { target: "css=#plain", property: "value" });
      assert(val.value === "", `clear left: ${val.value}`);
      const s = await cmd("scrollintoview", { target: "css=#btn" });
      assert(s.scrolledIntoView === "css=#btn", `scrollintoview: ${JSON.stringify(s)}`);
      const d = await cmd("dblclick", { target: "css=#btn" });
      assert(d.dblclicked === "css=#btn", `dblclick: ${JSON.stringify(d)}`);
    });

    await test("target: upload names one of two file inputs by target", async () => {
      const file = join(tmpdir(), `bctl-ext-upload-${Date.now()}.txt`);
      writeFileSync(file, "extended upload probe\n");
      try {
        const r = await cmd("upload", { target: "css=#multiinput", files: [file] });
        assert(r.count === 1, `expected 1 file attached, got ${JSON.stringify(r)}`);
        const shown = await cmd("get_property", { target: "css=#multinames", property: "text" });
        assert(
          shown.value.startsWith(basename(file)),
          `the named input did not get the file: ${shown.value}`
        );
      } finally {
        rmSync(file, { force: true });
      }
    });

    // ==========================================
    // 11. INPUT AND RECORDING SEMANTICS
    // ==========================================
    await test("type: method 'type' sends one key per character", async () => {
      await cmd("eval_js", {
        expression:
          "window.__keys = 0; document.getElementById('area').addEventListener('keydown', () => window.__keys++); 1",
      });
      const r = await cmd("type", { target: "css=#area", text: "abc", method: "type" });
      assert(r.effect.valueNow === "abc", `value after typing: ${JSON.stringify(r.effect)}`);
      const keys = await cmd("eval_js", { expression: "window.__keys" });
      assert(keys.value === 3, `expected 3 keydowns, got ${keys.value}`);
    });

    await test("fill_form: a <select> field picks the option by its visible text", async () => {
      await cmd("fill_form", { fields: [{ target: "css=#sel", value: "Cherry" }] });
      const v = await cmd("get_property", { target: "css=#sel", property: "value" });
      assert(v.value === "c", `select value: ${v.value}`);
      const msg = await cmdFail("fill_form", { fields: [{ target: "css=#sel", value: "Durian" }] });
      assert(/no option matching "Durian"/.test(msg), `a missing option must be refused: ${msg}`);
      const still = await cmd("get_property", { target: "css=#sel", property: "value" });
      assert(still.value === "c", `a refused option must not clear the selection: ${still.value}`);
    });

    await test("record: a checkbox is recorded by its checked state", async () => {
      await cmd("eval_js", { expression: "document.getElementById('cbox').checked = true; 1" });
      await cmd("record_start", {});
      try {
        await cmd("click", { target: "css=#cbox" });
        const rec = await poll(
          () => cmd("record_get", {}),
          (r) => (r.steps || []).some((st) => st.type === "input")
        );
        const step = (rec.steps || []).find((st) => st.type === "input");
        assert(
          step && step.value === "false",
          `unchecking must record "false": ${JSON.stringify(rec.steps)}`
        );
      } finally {
        await cmd("record_stop", {});
      }
    });

    await test("replay: a step that fails stops the run and says which", async () => {
      const msg = await cmdFail("replay", {
        steps: [
          { type: "click", selector: "#btn" },
          { type: "click", selector: "#no-such-element" },
          { type: "click", selector: "#btn" },
        ],
      });
      assert(/replay stopped at step 1/.test(msg), `replay must report the failed step: ${msg}`);
    });

    // The tab is attached here, so the click goes through the dialog watcher. A waitFor that
    // never appears keeps the click pending past the watcher's own polling.
    await test("dialog guard: a slow click on an attached tab runs once", async () => {
      await cmd("eval_js", { expression: "window.__clicked = 0; 1" });
      await cmd("click", { target: "css=#btn", waitFor: "#never-appears" });
      const n = await cmd("eval_js", { expression: "window.__clicked" });
      assert(n.value === 1, `the click ran ${n.value} times`);
    });

    await test("shadow DOM: a control is named by the label in its own shadow root", () =>
      withPage("/shadow-label", async () => {
        await cmd("wait_for", { selector: "login-box", timeoutMs: 3000 });
        await cmd("type", { target: "Work email", text: "a@b.test" });
        await cmd("type", { target: "Passcode", text: "1234" });
        const v = await cmd("eval_js", {
          expression:
            "(() => { const r = document.querySelector('login-box').shadowRoot; return r.getElementById('em').value + '|' + r.querySelectorAll('input')[1].value; })()",
        });
        assert(v.value === "a@b.test|1234", `shadow inputs got: ${v.value}`);
      }));

    await test("placeholder= names the input, not the labelled region around it", () =>
      withPage("/search-form", async () => {
        await cmd("type", { target: "placeholder=Search", text: "docs" });
        const q = await cmd("get_property", { target: "css=#q", property: "value" });
        assert(q.value === "docs", `search input got: ${q.value}`);
        await cmd("type", { target: "css=#qty", text: "1.5", method: "type" });
        const qty = await cmd("get_property", { target: "css=#qty", property: "value" });
        assert(qty.value === "1.5", `number input got: ${qty.value}`);
      }));

    await test("census: names, state, and each control listed once", () =>
      withPage("/search-form", async () => {
        const { census, lines, has } = await censusOf();
        const refs = lines.map((l) => l.match(/\[@([^\]]+)\]/)[1]);
        assert(refs.length === new Set(refs).size, `a ref is listed twice:\n${census}`);
        assert(has(/<a> "Home logo"/), `icon link not named by aria-label:\n${census}`);
        assert(has(/"Work email"/), `field not named by its label:\n${census}`);
        assert(has(/<select> "Fruit"/), `select named with its options:\n${census}`);
        await cmd("select_option", { target: "Fruit", option: "Pear" });
        const fruit = await cmd("get_property", { target: "css=#fruit", property: "value" });
        assert(fruit.value === "Pear", `the census name did not reach the select: ${fruit.value}`);
        assert(has(/\[unchecked\] "I agree"/), `an unticked box must say so:\n${census}`);
        assert(!/value: "on"/.test(census), `a checkbox's default value is noise:\n${census}`);
        assert(has(/\[disabled\] "Pay now"/), `a disabled button must say so:\n${census}`);
        await cmd("check", { target: "css=#agree" });
        const after = await censusOf();
        assert(after.has(/\[checked\] "I agree"/), `a ticked box must say so:\n${after.census}`);
      }));

    await test("find ranks the exact name first; press_key carries code and keyCode", () =>
      withPage("/search-form", async () => {
        const f = await cmd("find", { query: "new" });
        const names = f.matches.map((m) => m.name);
        assert(names[0] === "new", `exact match not first: ${JSON.stringify(names)}`);
        await cmd("press_key", { key: "A", target: "css=#keys" });
        const out = await cmd("get_property", { target: "css=#keyout", property: "text" });
        assert(out.value === "KeyA:65", `the page read the key as ${out.value}`);
      }));

    // The suite's tab is in the background, which is where a page would miss the scroll event.
    await test("background tab: scroll reaches the page's listener, hover reaches pointerenter, folded links resolve", () =>
      withPage("/tall", async () => {
        await cmd("scroll", { direction: "down", amount: 800 });
        const heard = await cmd("eval_js", { expression: "window.__scrolls" });
        assert(heard.value >= 1, `the page heard ${heard.value} scroll events`);
        await cmd("hover", { target: "css=#menu" });
        const open = await cmd("get_property", { target: "css=#opened", property: "text" });
        assert(open.value === "open", `pointerenter did not fire: ${open.value}`);
        const snap = await cmd("snapshot", { compact: true, scope: "all" });
        const last = (snap.folded || []).find((f) => f.text === "Story 39");
        assert(
          last && last.href === "/story/39",
          `a folded link is missing: ${JSON.stringify(snap.folded)}`
        );
        const got = await cmd("get_property", { target: "@" + last.ref, property: "text" });
        assert(got.value === "Story 39", `the folded ref resolved to ${got.value}`);
      }));

    await test("navigate: a page that cannot load is an error, and the tab still works", async () => {
      const msg = await cmdFail("navigate", { url: "http://127.0.0.1:9/" });
      assert(/ERR_|failed|had not started/.test(msg), `navigate to a closed port: ${msg}`);
      const r = await cmd("navigate", { url: base + "/" });
      assert(r.url.startsWith(base), `the tab did not recover: ${JSON.stringify(r)}`);
    });

    // localhost and 127.0.0.1 are different origins, which the Navigation API does not list.
    await test("history: go_back returns across an origin change", async () => {
      await cmd("navigate", { url: `http://localhost:${PORT}/search-form` });
      await cmd("navigate", { url: base + "/" });
      const r = await cmd("go_back", {});
      assert(/localhost/.test(r.url), `go_back landed on ${r.url}`);
      await cmd("navigate", { url: base + "/" });
    });

    await test("history: go_forward with nothing ahead is refused", async () => {
      const msg = await cmdFail("go_forward", {});
      assert(/no next page/.test(msg), `go_forward: ${msg}`);
    });

    // ==========================================
    // 12. SYSTEM PROFILE
    // ==========================================
    await test("system: exec_system_cmd", async () => {
      const marker = "bctl_sys_ok_789";
      const sys = await cmd("exec_system_cmd", { command: `echo ${marker}` });
      assert(sys.exitCode === 0, `exec_system_cmd failed with exitCode ${sys.exitCode}`);
      assert(sys.stdout && sys.stdout.includes(marker), `missing stdout marker: ${sys.stdout}`);
    });

    // ==========================================
    // 13. CDP DETACH & CLEANUP
    // ==========================================
    await test("cdp: detach debugger", async () => {
      const r = await cmd("cdp_detach", {});
      assert(r.attached === false, "cdp_detach failed");
    });
  } finally {
    await teardown();
    await test("cleanup leaves no tab and no synced group behind", async () => {
      await verifyClean(`127.0.0.1:${PORT}`);
    });
    server.close();
  }

  const failedCount = report();
  process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL in run_extended.mjs:", err);
  process.exit(1);
});
