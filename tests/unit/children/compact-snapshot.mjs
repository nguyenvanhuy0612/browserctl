// browser_snapshot against a stub bridge that answers with a fixed snapshot: the default answer
// is the census, drops 'elements' and writes the controls the extension folded as one line each
// in 'folded', in the census's own '@ref "text" -> href' form;
// elements:true keeps 'elements'. The output format never decides which: format 'json' (the
// default) and 'pretty' answer the same census as no format at all. 'compact' is not a parameter
// and is refused, never read as elements:false.
import http from "node:http";
import { z } from "zod";

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
  next: 4,
  structure: "main 4 (@ref_20)",
  hiddenContent: [{ kind: "load-more", text: "Show more", ref: "ref_30" }],
  pageState: { openDialogs: [{ label: "Cookies", ref: "ref_40" }] },
  folded: [
    { ref: "ref_3", text: "Story one", href: "/item?id=1" },
    { ref: "f2:ref_9", text: "In frame", href: "/f", frame: "https://ads.test/frame" },
    { ref: "ref_10", text: "", href: "vote?id=1" },
    { ref: "ref_11", text: 'say "hi"' },
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
  '@ref_3 "Story one" -> /item?id=1',
  '@f2:ref_9 "In frame" -> /f (frame https://ads.test/frame)',
  "@ref_10 -> vote?id=1",
  '@ref_11 "say \\"hi\\""',
].join("\n");
if (compact.folded !== want) fail("folded must be one line per control, every field kept:\n" + compact.folded);

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
// The smart rendering is the same answer for a human reader: every field the JSON carries is
// in it, so choosing it never costs the agent the page text, the paging cursor or a folded link.
for (const [what, needle] of [
  ["the page text", "page text"],
  ["the structure line", "main 4 (@ref_20)"],
  ["the paging cursor", "cursor: 4"],
  ["a folded control's text and href", '@ref_3 "Story one" -> /item?id=1'],
  ["a hidden-content hint", '"Show more" (@ref_30)'],
  ["an open dialog", '"Cookies" (@ref_40)'],
]) {
  if (!smart.includes(needle)) fail(`the smart rendering lost ${what}:\n${smart}`);
}

// 'only' reaches the extension as the kinds asked for, and a kind outside the three is refused.
await call({ only: ["fields", "buttons"] });
if (JSON.stringify(sent.at(-1).only) !== '["fields","buttons"]')
  fail("'only' must reach the extension unchanged: " + JSON.stringify(sent.at(-1)));
const schema = server._registeredTools["browser_snapshot"].inputSchema;
const parse = (v) => (typeof schema.safeParse === "function" ? schema : z.object(schema)).safeParse(v);
if (parse({ only: ["images"] }).success) fail("an unknown kind in 'only' must be refused by the schema");
if (parse({ only: [] }).success) fail("an empty 'only' must be refused by the schema");
if (!parse({ only: ["links"] }).success) fail("a known kind in 'only' must be accepted");
// 'raw' is the bare value of a result; a snapshot has none, and the old rendering answered with
// the page text alone, without a single ref. The schema refuses it.
if (parse({ format: "raw" }).success) fail("format 'raw' must be refused on a snapshot");
for (const format of ["json", "pretty", "smart"])
  if (!parse({ format }).success) fail(`format '${format}' must stay accepted`);

console.log("COMPACT_SNAPSHOT_OK");
process.exit(0);
