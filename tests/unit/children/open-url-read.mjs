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
        : action === "navigate" ? { url: "https://x.test" }
        : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  process.env.BROWSERCTL_BRIDGE_URL = "http://127.0.0.1:" + stub.address().port;

  const { server } = await import(new URL("../../../mcp/index.js", import.meta.url).href);
  const navOut = (await server._registeredTools.browser_navigate.handler({
    url: "https://x.test",
  })).content[0].text;
  const navObj = JSON.parse(navOut);
  if (navObj.url !== "https://x.test") throw new Error("navigate must return url: " + navOut);

  const tabOut = (await server._registeredTools.browser_tabs.handler({
    action: "new",
    url: "https://x.test",
  })).content[0].text;
  const tabObj = JSON.parse(tabOut);
  if (tabObj.id !== 7) throw new Error("new tab must return id: " + tabOut);

  console.log("NAVIGATE_AND_TABS_OK");
  process.exit(0);
