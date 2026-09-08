// Call every read-only browserctl action against a live page and record what comes back.
// Purpose: find tools that are broken, silently empty, or misleading — the classes an
// agent cannot detect from the response alone.
import http from "node:http";
import { writeFileSync } from "node:fs";

const BRIDGE = "http://127.0.0.1:8765";
const [, , SITE_URL, LABEL] = process.argv;

function call(action, params = {}, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ action, params });
    const started = Date.now();
    const req = http.request(`${BRIDGE}/command`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = { ok: false, error: "unparseable", raw: raw.slice(0, 200) }; }
        resolve({ action, ms: Date.now() - started, status: res.statusCode, ...parsed });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ action, ms: Date.now() - started, ok: false, error: "TIMEOUT" }); });
    req.on("error", (e) => resolve({ action, ms: Date.now() - started, ok: false, error: e.message }));
    req.end(body);
  });
}

const size = (v) => (v === undefined ? 0 : JSON.stringify(v).length);

// Read-only actions only. Anything that writes to the page, the account, the user's
// tabs or the filesystem is excluded — this audit runs against real sites.
const SKIP = new Set([
  "exec_system_cmd", "stop", "start", "reload_extension", "close_tab", "switch_tab",
  "focus_window", "new_tab", "navigate", "go_back", "go_forward", "reload",
  "set_cookie", "delete_cookies", "storage_set", "storage_remove", "storage_clear",
  "net_clear", "replay", "record_start", "record_stop", "print_pdf", "spoof_visibility",
  "coordinate_click", "coordinate_drag", "insert_text", "click_selector", "fill_selector",
  "click", "fill", "type", "paste", "press_key", "select_option", "dismiss", "close_modal",
  "ungroup_tab", "group_tab", "cdp_detach", "load_tools", "unload_tools", "audit",
]);

async function main() {
  // Open our OWN tab. Navigating the pinned target hijacks whatever tab the user is
  // on — it redirected a YouTube tab mid-session twice.
  await call("new_tab", { url: SITE_URL });
  await call("wait_settle", { timeoutMs: 3000 });

  // Ground truth: the full-DOM census.
  const truth = await call("snapshot", { scope: "all", compact: false, maxText: 200000 });
  const els = truth.result?.elements || [];
  const truthText = (truth.result?.text || "");

  const results = [];
  const rec = async (name, params, note, expectFail) => {
    const r = await call(name, params);
    results.push({
      name, params, note,
      // Some failures are the tool doing its job: waiting for text that is not there
      // must time out, and reading a capture that was never started must say so. Those
      // are graded on the QUALITY of the error, not on it being absent.
      expectFail: !!expectFail,
      ok: !!r.ok,
      error: r.error || null,
      code: r.code || null,
      ms: r.ms,
      bytes: size(r.result),
      sample: JSON.stringify(r.result ?? r.error ?? null).slice(0, 260),
    });
  };

  // A ref and a selector that definitely exist on this page, so "not found" is a real finding.
  const firstRef = els[0]?.ref;
  const firstText = (els.find((e) => e.text && e.text.length > 3)?.text || "").slice(0, 20);
  const anyLink = els.find((e) => e.tag === "a" && e.href);

  const CASES = [
    ["snapshot", { scope: "viewport" }, "default census"],
    ["snapshot", { scope: "all" }, "full census"],
    ["read_page", { mode: "interactive" }, "a11y tree"],
    ["read_page", { mode: "all", maxChars: 20000 }, "a11y tree, everything"],
    ["a11y_snapshot", { max: 50 }, "chrome a11y api"],
    ["find", { query: firstText }, `find a label known to exist: "${firstText}"`],
    ["find", { query: "zzz-definitely-absent-zzz" }, "find a label known to be absent"],
    ["get_attribute", { selector: "body", attr: "class" }, "read a present attribute"],
    ["get_text", { selector: "title", property: "text" }, "get_text alias with explicit property"],
    ["find_text", { query: (truthText.split(/\s+/)[3] || "the") }, "find_text on real page text"],
    ["get_page_content", { maxChars: 5000 }, "page text"],
    ["get_text", firstRef ? { ref: firstRef } : { selector: "body" }, "read first element"],
    ["get_attribute", anyLink ? { ref: anyLink.ref, attr: "href" } : { selector: "a", attr: "href" }, "read an href"],
    ["get_attribute", { selector: "body", attr: "data-absolutely-not-here" }, "absent attribute"],
    ["get_count", { selector: "a" }, "count links"],
    ["describe_element", firstRef ? { ref: firstRef } : { selector: "body" }, "describe first element"],
    ["current_tab", {}, "which tab"],
    ["list_tabs", {}, "tabs"],
    ["list_windows", {}, "windows"],
    ["status", {}, "bridge status"],
    ["screenshot", { format: "jpeg", quality: 40 }, "viewport image"],
    ["element_screenshot", firstRef ? { ref: firstRef } : { selector: "body" }, "element image"],
    ["scroll", { direction: "down", amount: 300 }, "scroll page"],
    ["hover", firstRef ? { ref: firstRef } : {}, "hover first element"],
    ["wait_settle", { timeoutMs: 2000 }, "settle"],
    ["wait_for", { text: firstText, timeoutMs: 4000 }, "wait for text that exists"],
    ["wait_for", { text: "zzz-absent-zzz", timeoutMs: 2500 }, "wait for text that does not exist", true],
    ["eval_js", { expression: "document.title" }, "eval"],
    ["get_console_logs", { limit: 20 }, "console"],
    ["get_cookies", { limit: 20 }, "cookies for this page"],
    ["storage_get", { area: "local" }, "localStorage"],
    ["get_network_requests", {}, "network without capture"],
    ["net_get", { limit: 10 }, "net_get without start", true],
    ["net_start", {}, "start capture"],
    ["net_get", { limit: 10 }, "net_get after start"],
    ["export_har", { bodies: false }, "har"],
    ["net_stop", {}, "stop capture"],
    ["wait_network_idle", { idleMs: 300, timeoutMs: 4000, maxInFlight: 2 }, "network idle"],
    ["cdp_attach", {}, "attach debugger"],
    ["cdp_send", { method: "Page.getLayoutMetrics" }, "raw cdp"],
    ["record_get", {}, "recording buffer"],
    ["read_pdf", {}, "pdf read on a non-pdf page"],
    ["list_available_tools", {}, "tool listing (MCP-layer only; must refuse with guidance)", true],
    ["action", {}, "action catalogue (MCP-layer only; must refuse with guidance)", true],
  ];

  for (const [n, p, note, xf] of CASES) await rec(n, p, note, xf);
  await call("cdp_detach", {});

  writeFileSync(`${LABEL}.json`, JSON.stringify({
    site: SITE_URL,
    truth: { elements: els.length, textChars: truthText.length, censusBytes: size(truth.result) },
    results,
  }, null, 1));

  const unexpected = results.filter((r) => !r.ok && !r.expectFail);
  const expected = results.filter((r) => !r.ok && r.expectFail);
  console.log(`${LABEL}: ${results.length} calls | ${unexpected.length} UNEXPECTED failures | ${expected.length} expected failures`);
  for (const r of unexpected) console.log(`   x ${r.name}: ${String(r.error).slice(0, 90)}`);
}
main();
