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
    /** @param {number} status @param {unknown} body @param {Record<string, string>} [extra] */
    const send = (status, body, extra = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...extra });
      res.end(JSON.stringify(body));
    };
    const refused = refusal(req, url.pathname, boundPort(server));
    if (refused) {
      send(403, { ok: false, error: refused });
      return;
    }
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        // the extension's probe is a CORS request when the user limits its site access
        const origin = header(req, "origin");
        send(200, { ok: true, version: daemon.version, protocol: PROTOCOL }, origin?.startsWith(EXTENSION_ORIGIN) ? { "access-control-allow-origin": origin } : {});
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
      const beat = /^\/v1\/sessions\/([^/]+)\/heartbeat$/.exec(url.pathname);
      if (req.method === "POST" && beat) {
        send(200, { ok: true, known: daemon.sessions.heartbeat(decodeURIComponent(beat[1])) });
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
    if (refusal(req, url.pathname, boundPort(server))) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (url.pathname === "/extension") {
      wss.handleUpgrade(req, socket, head, (ws) => daemon.browsers.adopt(ws));
      return;
    }
    // A run worker's own Playwright connection (specs/tools/run.md).
    const cdp = daemon.cdp;
    const session = url.searchParams.get("session");
    if (url.pathname === "/cdp" && cdp && session) {
      wss.handleUpgrade(req, socket, head, (ws) => cdp.serveWorker(session, ws));
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

const EXTENSION_ORIGIN = "chrome-extension://";

/** @param {http.Server} server */
function boundPort(server) {
  return /** @type {import("node:net").AddressInfo} */ (server.address()).port;
}

/**
 * Who may call the daemon (specs/interface.md): only its own Host, no Origin except the
 * extension's on /extension and any on /health. Returns the error for a refused request.
 * @param {http.IncomingMessage} req @param {string} pathname @param {number} port
 * @returns {{code: string, message: string, hint: string} | null}
 */
function refusal(req, pathname, port) {
  const hint = `Call http://127.0.0.1:${port} from a local process, without an Origin header (a request copied from the browser's DevTools carries one).`;
  const host = header(req, "host")?.toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { code: "REQUEST_REFUSED", message: `request refused: its Host header is not 127.0.0.1:${port} or localhost:${port}`, hint };
  }
  const origin = header(req, "origin");
  const allowed = pathname === "/extension" ? origin?.startsWith(EXTENSION_ORIGIN) === true : pathname === "/health" || origin === undefined;
  return allowed ? null : { code: "REQUEST_REFUSED", message: "request refused: it carries an Origin header, so a web page sent it", hint };
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
