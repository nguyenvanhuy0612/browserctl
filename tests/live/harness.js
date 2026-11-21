// @ts-check
// Live test harness: the daemon in-process on a free port, Chrome for Testing with a copy of the
// extension pointed at that port (so the owner's real Chrome is never reached), fixture pages
// over HTTP, and a CDP side channel to chrome://extensions to switch "Allow User Scripts" on and to
// read the extension's Errors page.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { chromium } from "playwright-core";
import { Daemon } from "../../src/daemon/app.js";
import { CdpLane } from "../../src/daemon/cdp/lane.js";
import { startServer } from "../../src/daemon/server.js";
import { tools } from "../../src/daemon/tools/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = /** @type {net.AddressInfo} */ (s.address()).port;
      s.close(() => resolve(port));
    });
  });
}

/** @param {string} dir @param {number} port */
function extensionCopy(dir, port) {
  const target = path.join(dir, "extension");
  fs.cpSync(path.join(root, "extension"), target, { recursive: true });
  const file = path.join(target, "sw/connection.js");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("const DEFAULT_PORT = 8765;", `const DEFAULT_PORT = ${port};`));
  return target;
}

const TYPES = /** @type {Record<string, string>} */ ({ ".json": "application/json", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".pdf": "application/pdf" });

/**
 * Fixture pages from tests/fixtures. /csp/<name> serves the page with a strict CSP; /slow/<ms>/<name>
 * delays it; /content/<n> serves HTML given to the harness (Playwright's setContent);
 * /redirect?to=<url> answers 302.
 * @param {Map<string, string>} contents
 * @returns {http.RequestListener}
 */
function fixtureHandler(contents) {
  const dir = path.join(root, "tests/fixtures");
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let name = url.pathname.replace(/^\//, "") || "index.html";
    /** @type {Record<string, string>} */
    const headers = { "content-type": "text/html; charset=utf-8" };
    if (name.startsWith("content/")) {
      res.writeHead(contents.has(name) ? 200 : 404, headers).end(contents.get(name) ?? "not found");
      return;
    }
    if (name === "redirect") {
      res.writeHead(302, { location: url.searchParams.get("to") ?? "/" }).end();
      return;
    }
    let delay = 0;
    if (name.startsWith("csp/")) {
      name = name.slice(4);
      headers["content-security-policy"] = "script-src 'nonce-fixture'";
    }
    const slow = /^slow\/(\d+)\/(.*)$/.exec(name);
    if (slow) {
      delay = Number(slow[1]);
      name = slow[2];
    }
    const file = path.join(dir, name);
    setTimeout(() => {
      if (!file.startsWith(dir) || !fs.existsSync(file)) {
        res.writeHead(404, headers).end("not found");
        return;
      }
      const type = TYPES[path.extname(name)];
      if (type) headers["content-type"] = type;
      res.writeHead(200, headers).end(fs.readFileSync(file));
    }, delay);
  };
}

/** @param {http.Server} server @returns {Promise<http.Server>} */
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));

/** @param {string} url */
async function cdpClient(url) {
  const ws = new WebSocket(url);
  await new Promise((r) => ws.once("open", r));
  let id = 0;
  return {
    /** @param {string} method @param {object} [params] @param {string} [sessionId] @returns {Promise<any>} */
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const my = ++id;
        const on = (/** @type {any} */ raw) => {
          const m = JSON.parse(raw);
          if (m.id !== my) return;
          ws.off("message", on);
          m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        };
        ws.on("message", on);
        ws.send(JSON.stringify({ id: my, method, params, sessionId }));
      }),
    /** @param {string} method @param {string} sessionId @returns {Promise<any>} */
    nextEvent: (method, sessionId, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${method} in ${timeoutMs} ms`)), timeoutMs);
        const on = (/** @type {any} */ raw) => {
          const m = JSON.parse(raw);
          if (m.method !== method || m.sessionId !== sessionId) return;
          clearTimeout(timer);
          ws.off("message", on);
          resolve(m.params);
        };
        ws.on("message", on);
      }),
    close: () => ws.close(),
  };
}

export async function startHarness({ userScripts = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bctl-live-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const port = await freePort();
  const startDaemon = async () => {
    const created = new Daemon({ home, version: "test", tools });
    created.cdp = new CdpLane(created, { idleMs: 3000 });
    return { daemon: created, server: await startServer(created, { port }) };
  };
  let { daemon, server } = await startDaemon();
  /** @type {Map<string, string>} */
  const contents = new Map();
  const fixtures = await listen(http.createServer(fixtureHandler(contents)));
  const base = `http://127.0.0.1:${/** @type {net.AddressInfo} */ (fixtures.address()).port}`;
  // the same pages over HTTPS with Playwright's self-signed test certificate (bad TLS for Chrome)
  const tls = { cert: fs.readFileSync(path.join(root, "tests/fixtures/pw/cert.pem")), key: fs.readFileSync(path.join(root, "tests/fixtures/pw/key.pem")) };
  const secureFixtures = await listen(https.createServer(tls, fixtureHandler(contents)));
  const secureBase = `https://127.0.0.1:${/** @type {net.AddressInfo} */ (secureFixtures.address()).port}`;
  const extension = extensionCopy(dir, port);
  const profile = path.join(dir, "profile");
  const proc = spawn(
    chromium.executablePath(),
    [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--remote-debugging-port=0", "--window-size=1200,900", "about:blank"],
    { stdio: "ignore" },
  );
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 300 && !fs.existsSync(portFile); i++) await sleep(100);
  await sleep(300);
  const devtools = fs.readFileSync(portFile, "utf8").split("\n")[0];
  const { webSocketDebuggerUrl } = /** @type {any} */ (await (await fetch(`http://127.0.0.1:${devtools}/json/version`)).json());
  const side = await cdpClient(webSocketDebuggerUrl);
  const { targetId } = await side.send("Target.createTarget", { url: "chrome://extensions", background: true });
  await sleep(1000);
  const { sessionId } = await side.send("Target.attachToTarget", { targetId, flatten: true });
  /** @param {string} expression */
  const onExtensionsPage = async (expression) =>
    (await side.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
  await onExtensionsPage("chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }).then(() => true)");
  const extensionId = await onExtensionsPage("chrome.developerPrivate.getExtensionsInfo().then(l => l.find(e => e.name === 'browserctl').id)");
  if (userScripts) {
    await onExtensionsPage(`chrome.developerPrivate.updateExtensionConfiguration({ extensionId: '${extensionId}', userScriptsAccess: true }).then(() => true, e => String(e))`);
    await onExtensionsPage(`chrome.developerPrivate.reload('${extensionId}', { failQuietly: true }).then(() => true)`);
  }
  for (let i = 0; i < 300 && daemon.browsers.connected().length === 0; i++) await sleep(100);
  if (!daemon.browsers.connected().length) throw new Error("extension did not connect");

  /** The targets the browser started with (its first tab, the extensions page): never closed by closeTabs. */
  const initialPages = new Set(await pageTargets());
  async function pageTargets() {
    const { targetInfos } = await side.send("Target.getTargets");
    return targetInfos.filter((/** @type {any} */ t) => t.type === "page").map((/** @type {any} */ t) => /** @type {string} */ (t.targetId));
  }

  let sessionCounter = 0;
  const harness = {
    side,
    get daemon() {
      return daemon;
    },
    base,
    secureBase,
    extensionId,
    /**
     * Calls a tool over HTTP as a session.
     * @param {string} tool @param {object} [params] @param {string} [session] @param {Record<string, string>} [headers]
     * @returns {Promise<any>}
     */
    async call(tool, params = {}, session = "test", headers = {}) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/tools/${tool}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-browserctl-session": session, "x-browserctl-client": "live-test", ...headers },
        body: JSON.stringify(params),
      });
      return res.json();
    },
    /** Calls and fails the test on ok: false. @param {string} tool @param {object} [params] @param {string} [session] @param {Record<string, string>} [headers] */
    async ok(tool, params = {}, session = "test", headers = {}) {
      const r = await harness.call(tool, params, session, headers);
      if (!r.ok) throw new Error(`${tool} failed: ${JSON.stringify(r.error)}`);
      return r;
    },
    newSession: () => `s${++sessionCounter}`,
    /** Serves `html` as a page and returns its URL (Playwright's setContent). @param {string} html */
    content(html) {
      const name = `content/${contents.size + 1}`;
      contents.set(name, html);
      return `${base}/${name}`;
    },
    /** The fixture server under another origin (Playwright's CROSS_PROCESS_PREFIX). */
    get crossOrigin() {
      return base.replace("127.0.0.1", "localhost");
    },
    port,
    /** @param {string} session */
    async endSession(session) {
      return (await fetch(`http://127.0.0.1:${port}/v1/sessions/${encodeURIComponent(session)}`, { method: "DELETE" })).json();
    },
    /** The browser's active tab in its window (the user's view). */
    async activeTab() {
      const link = /** @type {any} */ (daemon.browsers.connected()[0].link);
      const { tabs } = await link.request("tabs.list");
      return tabs.find((/** @type {any} */ t) => t.active && t.windowFocused) ?? tabs.find((/** @type {any} */ t) => t.active);
    },
    /** The toolbar popup's text, opened as a page. */
    async popupText() {
      const { targetId: popup } = await side.send("Target.createTarget", { url: `chrome-extension://${extensionId}/ui/popup.html`, background: true });
      await sleep(1500);
      const { sessionId: s } = await side.send("Target.attachToTarget", { targetId: popup, flatten: true });
      const text = (await side.send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true }, s)).result.value;
      await side.send("Target.closeTarget", { targetId: popup });
      return /** @type {string} */ (text);
    },
    /** Entries on the extension's chrome://extensions Errors page. */
    async extensionErrors() {
      return onExtensionsPage(
        `chrome.developerPrivate.getExtensionInfo('${extensionId}').then(e => [...(e.runtimeErrors||[]), ...(e.manifestErrors||[])].map(x => x.message))`,
      );
    },
    /** @param {boolean} on */
    async setUserScripts(on) {
      await onExtensionsPage(`chrome.developerPrivate.updateExtensionConfiguration({ extensionId: '${extensionId}', userScriptsAccess: ${on} }).then(() => true, e => String(e))`);
      await onExtensionsPage(`chrome.developerPrivate.reload('${extensionId}', { failQuietly: true }).then(() => true)`);
      await sleep(500);
      for (let i = 0; i < 300 && daemon.browsers.connected().length === 0; i++) await sleep(100);
    },
    /** Stops the daemon as a crash would (its attachments stay in Chrome) and starts a new one on the same port. */
    async restartDaemon() {
      for (const b of daemon.browsers.connected()) b.link?.close();
      server.closeAllConnections();
      server.close();
      daemon.close();
      ({ daemon, server } = await startDaemon());
      for (let i = 0; i < 300 && daemon.browsers.connected().length === 0; i++) await sleep(100);
      if (!daemon.browsers.connected().length) throw new Error("extension did not reconnect");
    },
    /** Stops the extension's service worker, as Chrome does when it is idle. */
    async stopServiceWorker() {
      const { targetInfos } = await side.send("Target.getTargets");
      const worker = targetInfos.find((/** @type {any} */ t) => t.type === "service_worker" && t.url.includes(extensionId));
      await side.send("Target.closeTarget", { targetId: worker.targetId });
    },
    /**
     * A tab the user opened: no session owns it and the daemon never armed it.
     * @param {string} url
     */
    async userTab(url) {
      const { targetId } = await side.send("Target.createTarget", { url, background: true });
      await sleep(800);
      const { sessionId: s } = await side.send("Target.attachToTarget", { targetId, flatten: true });
      await side.send("Page.enable", {}, s);
      return {
        /** @param {string} expression */
        evaluate: async (expression) => (await side.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, s)).result.value,
        /** Runs `expression` later and answers the native dialog it opens; resolves with the dialog. @param {string} expression */
        async dialogFrom(expression) {
          const opening = side.nextEvent("Page.javascriptDialogOpening", s);
          await side.send("Runtime.evaluate", { expression: `setTimeout(() => { ${expression} }, 0)` }, s);
          const dialog = await opening;
          await side.send("Page.handleJavaScriptDialog", { accept: false }, s);
          return dialog;
        },
        close: () => side.send("Target.closeTarget", { targetId }),
      };
    },
    /** Closes every tab opened since the browser started, so a long file does not pile tabs up. */
    async closeTabs() {
      for (const targetId of await pageTargets()) {
        if (!initialPages.has(targetId)) await side.send("Target.closeTarget", { targetId }).catch(() => {});
      }
    },
    async close() {
      side.close();
      daemon.cdp?.close();
      proc.kill();
      server.closeAllConnections();
      server.close();
      fixtures.close();
      secureFixtures.close();
      daemon.close();
      await sleep(500);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

/** @typedef {Awaited<ReturnType<typeof startHarness>>} Harness */

/** Opens a fixture page in a new tab of the session; returns the tab id. @param {Harness} h @param {string} session */
export async function freshPage(h, session, page = "page.html") {
  return (await h.ok("tabs", { action: "new", url: `${h.base}/${page}` }, session)).tab.tab;
}

/** The ref on the first snapshot line that matches. @param {string} snapshot @param {RegExp | string} line */
export function refIn(snapshot, line) {
  const found = snapshot.split("\n").find((l) => (typeof line === "string" ? l.includes(line) : line.test(l)));
  return /\[ref=((?:f\d+)?e\d+)\]/.exec(found ?? "")?.[1];
}

/** The fixture page's `window.__log`. @param {Harness} h @param {string} session */
export async function pageLog(h, session) {
  return (await h.ok("evaluate", { function: "() => window.__log" }, session)).value;
}
