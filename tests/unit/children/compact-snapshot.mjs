// browser_snapshot against a stub bridge that answers with a fixed snapshot: the default answer
// is the census, drops 'elements' and passes on the 'folded' list the extension built;
// elements:true keeps 'elements'. The output format never decides which: format 'json' (the
// default) and 'pretty' answer the same census as no format at all. 'compact' is not a parameter
// and is refused, never read as elements:false.
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
const sent = [];
const stub = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url === "/status") return res.end(JSON.stringify({ ok: true }));
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    sent.push(JSON.parse(body).params);
    res.end(JSON.stringify({ ok: true, result: snap }));
  });
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

const full = JSON.parse((await call({ elements: true })).content[0].text);
if (!Array.isArray(full.elements) || full.elements.length !== 4) fail("elements:true must keep every element");

if (sent.at(-1).compact !== false) fail("elements:true must ask the extension for the full list");

for (const format of ["json", "pretty"]) {
  const out = JSON.parse((await call({ format })).content[0].text);
  if ("elements" in out) fail(`format '${format}' must not change compactness: 'elements' came back`);
  if (sent.at(-1).compact !== true) fail(`format '${format}' must ask the extension for a compact census`);
}
const fullJson = JSON.parse((await call({ format: "json", elements: true })).content[0].text);
if (!Array.isArray(fullJson.elements)) fail("format 'json' with elements:true must keep every element");

const sentBefore = sent.length;
const refused = await call({ compact: false });
if (!refused.isError || !/elements/.test(refused.content[0].text))
  fail("'compact' must be refused with a pointer to 'elements': " + JSON.stringify(refused));
if (sent.length !== sentBefore) fail("a refused 'compact' must not reach the bridge");

const smart = (await call({ format: "smart" })).content[0].text;
if (!smart.includes("[@ref_1]")) fail("the smart rendering lost the census");

console.log("COMPACT_SNAPSHOT_OK");
process.exit(0);
