// Real-web label audit.
//
// A hand-written fixture only tests the shapes its author thought of. Chrome computes an
// accessible name for every control by the HTML-AAM spec, and exposes it through
// Accessibility.getFullAXTree — so on any real page that is the ground truth to measure
// against, with no fixture and no guessing.
//
// Usage: node tests/e2e/label_vs_chrome.mjs <url> [<url> ...]
import http from "node:http";

const BRIDGE = "http://127.0.0.1:8765";
const call = (action, params = {}, timeoutMs = 45000) => new Promise((resolve) => {
  const body = JSON.stringify({ action, params });
  const req = http.request(`${BRIDGE}/command`, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: timeoutMs },
    (res) => { let r = ""; res.on("data", (c) => (r += c)); res.on("end", () => { try { resolve(JSON.parse(r)); } catch { resolve({ ok: false, error: "bad json" }); } }); });
  req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "TIMEOUT" }); });
  req.on("error", (e) => resolve({ ok: false, error: e.message }));
  req.end(body);
});

// Chrome renders punctuation with its own spacing ("homepage ( g then d )" where the DOM
// says "Homepage (g then d)"), so compare on letters and digits only. Without this the
// harness reported real names as misses and flattered nothing — it just lied downward.
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\u00c0-\u024f\u1e00-\u1eff]+/g, " ").replace(/\s+/g, " ").trim();

// Pair each element browserctl lists with the name Chrome computed for the very same
// node, matched on backendDOMNodeId so nothing depends on text similarity.
const PAIR_JS = `(function(){
  var els = [];
  var sel = ${JSON.stringify("a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=tab],[role=treeitem],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=searchbox],[role=textbox],[role=slider],[role=spinbutton]")};
  var all = document.querySelectorAll(sel);
  for (var i = 0; i < all.length && els.length < 400; i++) {
    var e = all[i];
    var r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    var st = getComputedStyle(e);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    els.push({ tag: e.tagName.toLowerCase(), type: (e.getAttribute('type')||''), role: e.getAttribute('role')||'' });
  }
  return JSON.stringify({ count: els.length, els: els });
})()`;

async function auditSite(url) {
  await call("new_tab", { url });
  await call("wait_settle", { timeoutMs: 3500 });

  const snap = (await call("snapshot", { scope: "all", compact: false, maxText: 0 })).result || {};
  const bctl = (snap.elements || []).filter((e) => e.text !== undefined);

  await call("cdp_attach", {});
  const ax = await call("a11y_snapshot", { max: 4000 });
  const nodes = (ax.result && ax.result.nodes) || [];

  // Chrome's named, interactive nodes.
  const AX_INTERACTIVE = new Set(["button", "link", "textbox", "checkbox", "radio", "combobox",
    "menuitem", "menuitemradio", "menuitemcheckbox", "tab", "switch", "option", "slider",
    "searchbox", "spinbutton", "listbox", "treeitem"]);
  const axNamed = nodes.filter((n) => AX_INTERACTIVE.has(String(n.role || "").toLowerCase()) && norm(n.name));
  const axNames = new Set(axNamed.map((n) => norm(n.name)));

  const named = bctl.filter((e) => norm(e.text));
  const anon = bctl.filter((e) => !norm(e.text));

  // Of the names Chrome computed, how many did browserctl also produce?
  let matched = 0;
  const missed = [];
  const bctlNames = new Set(named.map((e) => norm(e.text)));
  for (const n of axNames) {
    const hit = bctlNames.has(n) || [...bctlNames].some((b) => b.includes(n) || n.includes(b));
    if (hit) matched++; else missed.push(n);
  }

  await call("cdp_detach", {});
  return {
    url,
    bctlTotal: bctl.length,
    bctlNamed: named.length,
    bctlAnon: anon.length,
    chromeNamed: axNames.size,
    matched,
    coverage: axNames.size ? Math.round((matched / axNames.size) * 100) : 100,
    missedSample: missed.slice(0, 6),
    anonSample: anon.slice(0, 5).map((e) => `<${e.tag}${e.type ? " type=" + e.type : ""}${e.role ? " role=" + e.role : ""}>`),
  };
}

const main = async () => {
  const urls = process.argv.slice(2);
  const rows = [];
  for (const u of urls) {
    try { rows.push(await auditSite(u)); } catch (e) { rows.push({ url: u, error: String(e.message || e) }); }
  }
  console.log(`${"site".padEnd(34)} ${"ctl".padEnd(5)} ${"named".padEnd(6)} ${"anon".padEnd(5)} ${"chrome".padEnd(7)} cover`);
  console.log("-".repeat(72));
  for (const r of rows) {
    if (r.error) { console.log(`${r.url.slice(0, 34).padEnd(34)} ERROR ${r.error.slice(0, 30)}`); continue; }
    const host = new URL(r.url).host + new URL(r.url).pathname;
    console.log(`${host.slice(0, 34).padEnd(34)} ${String(r.bctlTotal).padEnd(5)} ${String(r.bctlNamed).padEnd(6)} ${String(r.bctlAnon).padEnd(5)} ${String(r.chromeNamed).padEnd(7)} ${r.coverage}%`);
  }
  console.log("-".repeat(72));
  for (const r of rows) {
    if (r.error) continue;
    if (r.missedSample.length) console.log(`MISSED on ${new URL(r.url).host}: ${r.missedSample.map((m) => JSON.stringify(m.slice(0, 34))).join(", ")}`);
    if (r.anonSample.length) console.log(`ANON   on ${new URL(r.url).host}: ${r.anonSample.join(", ")}`);
  }
};
main();
