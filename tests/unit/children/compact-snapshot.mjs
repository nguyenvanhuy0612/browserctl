// browser_snapshot against a stub bridge that answers with a fixed snapshot: the default answer
// is the census, drops 'elements' and writes the controls the extension folded as one line each
// in 'folded', in the census's own '@ref "text" -> href' form;
// elements:true keeps 'elements'. The output format never decides which: format 'json' (the
// default) and 'pretty' answer the same census as no format at all. 'compact' is not a parameter
// and is refused, never read as elements:false.
import http from "node:http";
import { z } from "zod";

const census = [
  '  [@e1] <input>[type=text] "Search"',
  '  [@e2] <a> "Home" -> /',
  "  ... [folded 2 links (refs: @e3, @f2:e9)]",
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
    { ref: "e1", tag: "input", text: "Search", index: 0 },
    { ref: "e2", tag: "a", text: "Home", href: "/", index: 1 },
    { ref: "e3", tag: "a", text: "Story one", href: "/item?id=1", index: 2, landmark: "main" },
    { ref: "f2:e9", tag: "a", text: "In frame", href: "/f", frame: "https://ads.test/frame" },
  ],
  text: "page text",
  next: 4,
  structure: "main 4 (@e20)",
  hiddenContent: [{ kind: "load-more", text: "Show more", ref: "e30" }],
  pageState: { openDialogs: [{ label: "Cookies", ref: "e40" }] },
  folded: [
    { ref: "e3", text: "Story one", href: "/item?id=1" },
    { ref: "f2:e9", text: "In frame", href: "/f", frame: "https://ads.test/frame" },
    { ref: "e10", text: "", href: "vote?id=1" },
    { ref: "e11", text: 'say "hi"' },
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
const want = [
  '@e3 "Story one" -> /item?id=1',
  '@f2:e9 "In frame" -> /f (frame https://ads.test/frame)',
  "@e10 -> vote?id=1",
  '@e11 "say \\"hi\\""',
].join("\n");
if (compact.folded !== want)
  fail("folded must be one line per control, every field kept:\n" + compact.folded);

for (const format of ["json", "pretty"]) {
  const out = JSON.parse((await call({ format })).content[0].text);
  if ("elements" in out)
    fail(`format '${format}' must not change compactness: 'elements' came back`);
  if (sent.at(-1).compact !== true)
    fail(`format '${format}' must ask the extension for a compact census`);
}

const sentBefore = sent.length;
const refused = await call({ compact: false });
if (!refused.isError || !/compact/.test(refused.content[0].text))
  fail("'compact' must be refused: " + JSON.stringify(refused));
if (sent.length !== sentBefore) fail("a refused 'compact' must not reach the bridge");

const smart = (await call({ format: "smart" })).content[0].text;
if (!smart.includes("[@e1]")) fail("the smart rendering lost the census");
// The smart rendering is the same answer for a human reader: every field the JSON carries is
// in it, so choosing it never costs the agent the page text, the paging cursor or a folded link.
for (const [what, needle] of [
  ["the page text", "page text"],
  ["the structure line", "main 4 (@e20)"],
  ["the paging cursor", "cursor: 4"],
  ["a folded control's text and href", '@e3 "Story one" -> /item?id=1'],
  ["a hidden-content hint", '"Show more" (@e30)'],
  ["an open dialog", '"Cookies" (@e40)'],
]) {
  if (!smart.includes(needle)) fail(`the smart rendering lost ${what}:\n${smart}`);
}

// 'only' filter has been completely removed per spec; schema must not declare it, and handler must refuse it.
const schema = server._registeredTools["browser_snapshot"].inputSchema;
if (schema.shape && "only" in schema.shape)
  fail("the removed 'only' parameter must not exist in the schema");
const badOnly = await call({ only: ["fields", "buttons"] });
if (!badOnly.isError)
  fail("the removed 'only' parameter must be refused by the handler: " + JSON.stringify(badOnly));

console.log("COMPACT_SNAPSHOT_OK");
process.exit(0);
