// Every tool that hands an element's identity to an agent must agree on what that
// identity is. They resolve it through different code paths, so this asks each of them
// about the same elements.
import http from "node:http";
import { readFileSync } from "node:fs";

const BRIDGE = "http://127.0.0.1:8765";
const call = (action, params = {}) => new Promise((resolve) => {
  const body = JSON.stringify({ action, params });
  const req = http.request(`${BRIDGE}/command`, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 20000 },
    (res) => { let r = ""; res.on("data", (c) => (r += c)); res.on("end", () => { try { resolve(JSON.parse(r)); } catch { resolve({ ok: false, error: "bad json" }); } }); });
  req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "TIMEOUT" }); });
  req.on("error", (e) => resolve({ ok: false, error: e.message }));
  req.end(body);
});

const FIXTURE = process.argv[2] || new URL("./labels.html", import.meta.url).pathname;
const srv = http.createServer((_q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end(readFileSync(FIXTURE)); }).listen(0);
const port = srv.address().port;

const EXPECT = ["Only me", "Public", "Accept terms", "Subscribe to updates", "Quantity in cart",
                "Shipping country", "Dark mode", "Delete item", "Search products"];

const main = async () => {
  await call("new_tab", { url: `http://127.0.0.1:${port}/` });
  await call("wait_settle", { timeoutMs: 1200 });

  const snap = (await call("snapshot", { scope: "all", compact: true, maxText: 0 })).result || {};
  const cv = snap.compactView || "";
  const tree = ((await call("read_page", { mode: "interactive" })).result || {}).tree || "";

  console.log(`${"label expected".padEnd(24)} ${"snapshot".padEnd(9)} ${"read_page".padEnd(10)} ${"find".padEnd(6)} click(text)`);
  console.log("-".repeat(64));
  let fails = 0;
  for (const want of EXPECT) {
    const inSnap = cv.includes(`"${want}`) || cv.includes(want);
    const inTree = tree.includes(want);
    const f = (await call("find", { query: want, max: 3 })).result || {};
    const findable = f.count > 0;
    const clickable = findable && (f.matches || []).some((m) => m.clickable);
    const bad = !inSnap || !inTree || !findable || !clickable;
    if (bad) fails++;
    console.log(`${want.padEnd(24)} ${(inSnap ? "yes" : "NO").padEnd(9)} ${(inTree ? "yes" : "NO").padEnd(10)} ${(findable ? "yes" : "NO").padEnd(6)} ${clickable ? "yes" : "NO"}`);
  }
  console.log("-".repeat(64));
  console.log(fails === 0 ? "all label paths agree" : `${fails}/${EXPECT.length} labels are missing from at least one tool`);
  srv.close();
  process.exit(fails === 0 ? 0 : 1);
};
main();
