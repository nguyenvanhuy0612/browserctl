// @ts-check
// The daemon's HTTP API and the extension's WebSocket endpoint (specs/interface.md).
import http from "node:http";
import { WebSocketServer } from "ws";
import { PROTOCOL } from "../../extension/sw/protocol.js";

const MAX_BODY = 64 * 1024 * 1024;

/**
 * @param {import("./app.js").Daemon} daemon
 * @param {{port: number, host?: string}} options
 * @returns {Promise<http.Server>}
 */
export function startServer(daemon, { port, host = "127.0.0.1" }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    /** @param {number} status @param {unknown} body */
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        send(200, { ok: true, version: daemon.version, protocol: PROTOCOL });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/tools") {
        send(200, { ok: true, tools: daemon.registry.list() });
        return;
      }
      const tool = /^\/v1\/tools\/([a-z_]+)$/.exec(url.pathname);
      if (req.method === "POST" && tool) {
        const body = await readBody(req);
        let params;
        try {
          params = body ? JSON.parse(body) : {};
        } catch {
          send(400, { ok: false, error: { code: "INVALID_PARAMS", message: "the body is not JSON" } });
          return;
        }
        const sessionId = header(req, "x-browserctl-session") ?? "http";
        const client = header(req, "x-browserctl-client") ?? "http";
        const closeTabsOnEnd = header(req, "x-browserctl-close-tabs") === "1";
        send(200, await daemon.call(tool[1], params, { sessionId, client, closeTabsOnEnd }));
        return;
      }
      const session = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
      if (req.method === "DELETE" && session) {
        send(200, { ok: true, ...(await daemon.endSession(decodeURIComponent(session[1]))) });
        return;
      }
      send(404, { ok: false, error: { code: "NOT_FOUND", message: `${req.method} ${url.pathname}` } });
    } catch (error) {
      send(500, { ok: false, error: { code: "INTERNAL_ERROR", message: String(/** @type {any} */ (error)?.message ?? error) } });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/extension") {
      wss.handleUpgrade(req, socket, head, (ws) => daemon.browsers.adopt(ws));
      return;
    }
    // A run worker's own Playwright connection (specs/tools/run.md).
    const cdp = daemon.cdp;
    const browser = url.searchParams.get("browser");
    const tab = Number(url.searchParams.get("tab"));
    if (url.pathname === "/cdp" && cdp && browser && tab) {
      wss.handleUpgrade(req, socket, head, (ws) => cdp.serveWorker(browser, tab, ws));
      return;
    }
    socket.destroy();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      daemon.port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
      resolve(server);
    });
  });
}

/** @param {http.IncomingMessage} req @param {string} name */
function header(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** @param {http.IncomingMessage} req @returns {Promise<string>} */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
