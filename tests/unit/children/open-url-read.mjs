// open_url's read must come back as rendered TEXT, not as a field in a JSON object: the raw
// snapshot object ran to 63K characters on a dense page, and JSON-escaping the census footer
// stopped the hint rewriter from matching it, so the line telling an agent what to call next
// arrived in a syntax it cannot call. Both were measured on a live Hacker News page.
import http from "node:http";

const stub = http.createServer((req, res) => {
  if (req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { action, params } = JSON.parse(body);
    const result =
      action === "list_tabs" ? { tabs: [], pinned: null }
      : action === "new_tab" ? { id: 7 }
      : action === "read_pdf" ? { isPdf: false }
      : action === "snapshot" ? {
          census: '  [@ref_1] <a> "x"',
          structure: "main 3",
          window: { offset: 0, shown: 1, inScope: 1 },
        }
      : {};
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result }));
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
process.env.BROWSERCTL_BRIDGE_URL = "http://127.0.0.1:" + stub.address().port;

const { server } = await import(new URL("../../../mcp/index.js", import.meta.url).href);
const out = (await server._registeredTools.browser_open_url.handler({
  url: "https://x.test", wait: "none", read: "snapshot",
})).content[0].text;

const o = JSON.parse(out); // a read is structured now, not prose
if (o.tabId !== 7) throw new Error("the tab it drove must be a field: " + out);
if (!String(o.census).includes("[@ref_1]")) throw new Error("the census must be in the census field: " + out);
if (/\[Next:|suggestions/.test(out)) throw new Error("a result must carry no advice block: " + out);
console.log("OPEN_URL_READ_OK");
process.exit(0);
