import http from "node:http";
    const stub = http.createServer((req, res) => {
      if (req.url === "/status") { res.writeHead(200, {"content-type":"application/json"}); return res.end(JSON.stringify({ ok: true })); }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { params } = JSON.parse(body);
        const result = params.fields
          ? { all: true, selector: params.selector, count: 30, fields: ["title", "url", "box"],
              matches: [
                { ref: "ref_1", title: "First  post", url: "https://x.test/one", box: { x: 10.4, y: 20.6, width: 80, height: 30 } },
                { ref: "ref_2", title: "Second post", url: null, box: null },
              ],
              note: "30 elements matched; the first 2 are listed." }
          : { property: "attr", all: true, selector: params.selector, count: 2,
              matches: [
                { ref: "ref_1", property: "attr", name: "href", present: true, value: "/one", resolved: "https://x.test/one" },
                { ref: "ref_2", property: "attr", name: "href", present: false, value: null },
              ] };
        res.writeHead(200, {"content-type":"application/json"});
        res.end(JSON.stringify({ ok: true, result }));
      });
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    process.env.BROWSERCTL_BRIDGE_URL = "http://127.0.0.1:" + stub.address().port;
    const { server } = await import(new URL("../../../mcp/index.js", import.meta.url).href);
    const extract = (args) => server._registeredTools["browser_extract"].handler(args).then((r) => r.content[0].text);
    const readProp = (args) => server._registeredTools["browser_get_property"].handler(args).then((r) => r.content[0].text);

    const survey = await extract({ selector: "li", fields: { title: "h3", url: "a", box: "x" } });
    const lines = survey.split("\n");
    if (lines.length > 5) throw new Error("a two-row survey must not exceed header + rows + note: " + survey);
    if (!/30 matches for li, 2 listed — title, url, box$/.test(lines[0])) throw new Error("header: " + lines[0]);
    if (!lines[1].includes("@ref_1") || !lines[1].includes("title=First post")) throw new Error("row: " + lines[1]);
    if (!lines[1].includes("box=10,21 80x30")) throw new Error("a box must render as coordinates, not JSON: " + lines[1]);
    if (!lines[2].includes("url=-")) throw new Error("a null field must render as a dash, not 'null': " + lines[2]);
    if (!/Note: /.test(lines[3])) throw new Error("the note must survive: " + survey);

    const href = await readProp({ target: "a", property: "attr", attr: "href" });
    if (!href.includes("https://x.test/one")) throw new Error("a URL must render resolved: " + href);

    console.log("ALL_RENDER_OK");
    process.exit(0);
