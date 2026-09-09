// Ground-truth coverage check: everything snapshot --all can see must be reachable by
// the tools an agent would actually use to act on it.
import http from "node:http";
const BRIDGE = "http://127.0.0.1:8765";
const [, , URL_, LABEL] = process.argv;

const call = (action, params = {}) => new Promise((resolve) => {
  const body = JSON.stringify({ action, params });
  const req = http.request(`${BRIDGE}/command`, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 30000 },
    (res) => { let r = ""; res.on("data", (c) => (r += c)); res.on("end", () => { try { resolve(JSON.parse(r)); } catch { resolve({ ok: false, error: "bad json" }); } }); });
  req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "TIMEOUT" }); });
  req.on("error", (e) => resolve({ ok: false, error: e.message }));
  req.end(body);
});

const main = async () => {
  // Own tab, not the pinned one (see audit_tools.mjs).
  const opened = (await call("new_tab", { url: URL_ })).result;
  const ownTabId = opened && opened.id;
  await call("wait_settle", { timeoutMs: 3000 });

  const all = (await call("snapshot", { scope: "all", compact: false, maxText: 0 })).result || {};
  const vp = (await call("snapshot", { scope: "viewport", compact: true, maxText: 0 })).result || {};
  const truth = all.elements || [];
  const labelled = truth.filter((e) => e.text && e.text.length > 2);

  // 1. Can find() reach each labelled element?
  const sample = labelled.filter((_, i) => i % Math.max(1, Math.floor(labelled.length / 25)) === 0).slice(0, 25);
  let findable = 0; const misses = [];
  for (const e of sample) {
    const q = e.text.slice(0, 40);
    const r = await call("find", { query: q, max: 5 });
    if (r.ok && r.result.count > 0) findable++;
    else misses.push({ ref: e.ref, tag: e.tag, text: q, nearest: r.result?.nearest?.length || 0 });
  }

  // 2. Can get_text read each one back?
  let readable = 0; const unreadable = [];
  for (const e of sample) {
    const r = await call("get_property", { property: "text", ref: "@" + e.ref });
    if (r.ok) readable++; else unreadable.push({ ref: e.ref, err: String(r.error).slice(0, 60) });
  }

  // 3. Does the viewport census DISCLOSE what it withheld?
  const cv = vp.compactView || "";
  const hidden = truth.length - (vp.elements || []).length;
  const notice = /\[Notice:[^\]]*offscreen/.test(cv);
  const namesKinds = /offscreen, including/.test(cv);

  console.log(`${LABEL}`);
  console.log(`  truth(all)=${truth.length} labelled=${labelled.length} viewport=${(vp.elements||[]).length} withheld=${hidden}`);
  console.log(`  find() reached ${findable}/${sample.length} sampled labels`);
  console.log(`  get_text read ${readable}/${sample.length} sampled refs`);
  console.log(`  viewport discloses withholding: notice=${notice} namesKinds=${namesKinds}`);
  if (misses.length) { console.log("  UNREACHABLE BY find():"); for (const m of misses.slice(0, 8)) console.log(`    <${m.tag}> "${m.text}" (nearest offered: ${m.nearest})`); }
  if (unreadable.length) { console.log("  UNREADABLE BY get_text:"); for (const u of unreadable.slice(0, 8)) console.log(`    @${u.ref}: ${u.err}`); }
  if (ownTabId != null) await call("close_tab", { id: ownTabId });
};
main();
