// browser_snapshot against a stub bridge that answers with a fixed snapshot: a compact answer
// drops 'elements' and passes on the 'folded' list the extension built; compact:false keeps
// 'elements'.
import http from "node:http";

const census = [
  '  [@ref_1] <input>[type=text] "Search"',
  '  [@ref_2] <a> "Home" -> /',
  "  ... [folded 2 links (refs: @ref_3, @f2:ref_9)]",
].join("\n");
const snap = {
  url: "https://x.test/",
  title: "X",
  scope: "viewport",
  window: { offset: 0, shown: 4, inScope: 4 },
  totalElementsCount: 4,
  foldedCount: 2,
  census,
  elements: [
    { ref: "ref_1", tag: "input", text: "Search", index: 0 },
    { ref: "ref_2", tag: "a", text: "Home", href: "/", index: 1 },
    { ref: "ref_3", tag: "a", text: "Story one", href: "/item?id=1", index: 2, landmark: "main" },
    { ref: "f2:ref_9", tag: "a", text: "In frame", href: "/f", frame: "https://ads.test/frame" },
  ],
  text: "page text",
  folded: [
    { ref: "ref_3", text: "Story one", href: "/item?id=1" },
    { ref: "f2:ref_9", text: "In frame", href: "/f", frame: "https://ads.test/frame" },
  ],
};
const stub = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url === "/status") return res.end(JSON.stringify({ ok: true }));
  req.resume();
  req.on("end", () => res.end(JSON.stringify({ ok: true, result: snap })));
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
process.env.BROWSERCTL_BRIDGE_URL = "http://127.0.0.1:" + stub.address().port;
process.env.BROWSERCTL_MCP_PROFILE = "core";
const { server } = await import(new URL("../../../mcp/index.js", import.meta.url).href);
const call = (a) => server._registeredTools["browser_snapshot"].handler(a);
const fail = (m) => {
  console.log("FAIL " + m);
  process.exit(1);
};

const compact = JSON.parse((await call({})).content[0].text);
if ("elements" in compact) fail("a compact snapshot still carries 'elements'");
if (compact.census !== census) fail("the census changed");
if (compact.text !== "page text") fail("the page text was dropped");
const refs = (compact.folded || []).map((f) => f.ref).join(",");
if (refs !== "ref_3,f2:ref_9") fail("folded must pass through as the extension sent it: " + refs);
const one = compact.folded[0];
if (one.text !== "Story one" || one.href !== "/item?id=1") fail("a folded entry lost its fields: " + JSON.stringify(one));
if (compact.folded[1].frame !== "https://ads.test/frame") fail("a folded control keeps its frame");

const full = JSON.parse((await call({ compact: false })).content[0].text);
if (!Array.isArray(full.elements) || full.elements.length !== 4) fail("compact:false must keep every element");

const smart = (await call({ format: "smart" })).content[0].text;
if (!smart.includes("[@ref_1]")) fail("the smart rendering lost the census");

console.log("COMPACT_SNAPSHOT_OK");
process.exit(0);
