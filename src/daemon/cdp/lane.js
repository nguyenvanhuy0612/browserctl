// @ts-check
// The CDP lane: Playwright over the extension relay, for what the DOM lane cannot do
// (specs/architecture.md, specs/relay.md). Targets come from DOM-lane refs through a one-time
// marker attribute (specs/targets.md).
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { Daemon } from "../app.js";
import { BctlError, toBctlError } from "../errors.js";
import { Attachments } from "./attachments.js";
import { CdpRelay } from "./relay.js";

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-worker.js");
const BODY_LIMIT = 10 * 1024 * 1024;
const TAB_BODY_LIMIT = 100 * 1024 * 1024;

/** @typedef {import("../sessions.js").TabRef} TabRef */

/**
 * @typedef {{
 *   link: any,
 *   attachments: Attachments,
 *   relay: CdpRelay,
 *   browser: Promise<import("playwright-core").Browser>,
 *   pages: Map<number, import("playwright-core").Page>,
 *   claiming: Promise<unknown>,
 *   captures: Map<number, {bodies: {url: string, method: string, at: number, body: string, base64: boolean, size: number}[], bytes: number}>,
 * }} BrowserState
 */

/** @param {unknown} error */
function mapPlaywrightError(error) {
  const message = String(/** @type {any} */ (error)?.message ?? error);
  if (error instanceof BctlError) return error;
  if (/intercepts pointer events/i.test(message)) return new BctlError("TARGET_COVERED", message.split("\n").find((l) => /intercepts/.test(l))?.trim() ?? message);
  if (/not enabled|is disabled/i.test(message)) return new BctlError("TARGET_DISABLED", "the element stayed disabled");
  if (/not visible/i.test(message)) return new BctlError("TARGET_HIDDEN", "the element stayed hidden");
  if (/not editable|not an <input>|cannot type/i.test(message)) return new BctlError("TARGET_NOT_EDITABLE", message.split("\n")[0]);
  if (/has been closed|Target closed/i.test(message)) return new BctlError("TAB_CLOSED", "the tab closed");
  if (/Timeout .* exceeded/i.test(message)) return new BctlError("TIMEOUT", message.split("\n")[0]);
  return toBctlError(error);
}

/** Width and height from a PNG or JPEG header. @param {Buffer} buffer */
function imageSize(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  for (let i = 2; i < buffer.length - 9; ) {
    if (buffer[i] !== 0xff) break;
    const marker = buffer[i + 1];
    const length = buffer.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
    i += 2 + length;
  }
  return { width: 0, height: 0 };
}

export class CdpLane {
  #daemon;
  #idleMs;
  /** @type {Map<string, BrowserState>} */
  #states = new Map();
  /** @type {Map<string, {child: import("node:child_process").ChildProcess, ref: TabRef}>} */
  #workers = new Map();
  #nextCall = 1;

  /** @param {Daemon} daemon @param {{idleMs: number}} options */
  constructor(daemon, { idleMs }) {
    this.#daemon = daemon;
    this.#idleMs = idleMs;
  }

  /** @param {TabRef} ref */
  #state(ref) {
    const browser = this.#daemon.browserOf(ref);
    const link = this.#daemon.linkOf(ref);
    let state = this.#states.get(ref.instanceId);
    if (state && state.link === link) return state;
    const attachments = new Attachments(browser, { idleMs: this.#idleMs });
    const relay = new CdpRelay(attachments, { onCreateTarget: async () => this.#newTabFor(ref) });
    state = {
      link,
      attachments,
      relay,
      browser: chromium.connectOverCDP(/** @type {any} */ (relay.transport()), { noDefaults: true }),
      pages: new Map(),
      claiming: Promise.resolve(),
      captures: new Map(),
    };
    link.on("debugger.event", (/** @type {any} */ e) => this.#onNetworkEvent(/** @type {BrowserState} */ (state), e));
    this.#states.set(ref.instanceId, state);
    return state;
  }

  /** A tab opened by Playwright code joins the session of the tab it came from. @param {TabRef} from */
  async #newTabFor(from) {
    const owner = this.#daemon.sessions.ownerOf(from.instanceId, from.tabId);
    const created = await this.#daemon.linkOf(from).request("tabs.create", { url: "about:blank" });
    const session = owner ? this.#daemon.sessions.sessions.get(owner.sessionId) : undefined;
    if (session) {
      this.#daemon.sessions.own(session, from.instanceId, created.tabId, "owned");
      await this.#daemon.groupTab(session, { instanceId: from.instanceId, tabId: created.tabId }).catch(() => {});
    }
    return created.tabId;
  }

  /** The Playwright page of a tab, attached and awake. @param {TabRef} ref */
  async page(ref) {
    const state = this.#state(ref);
    const existing = state.pages.get(ref.tabId);
    if (existing && !existing.isClosed()) {
      await state.attachments.ensure(ref.tabId);
      return existing;
    }
    const run = async () => {
      const browser = await state.browser;
      const context = browser.contexts()[0];
      const announced = context.waitForEvent("page", { timeout: 10_000 });
      await state.relay.claim(ref.tabId);
      const page = await announced;
      page.setDefaultTimeout(5000);
      page.on("close", () => state.pages.delete(ref.tabId));
      page.on("dialog", (dialog) => this.#answer(ref, dialog).catch(() => {}));
      state.pages.set(ref.tabId, page);
      return page;
    };
    const claim = state.claiming.then(run, run);
    state.claiming = claim.catch(() => {});
    return claim;
  }

  /** Dialogs the shim did not take (beforeunload, early dialogs) follow the tab's policy. @param {TabRef} ref @param {import("playwright-core").Dialog} dialog */
  async #answer(ref, dialog) {
    const policy = /** @type {any} */ (this.#daemon.sessions.ownerOf(ref.instanceId, ref.tabId)?.dialogPolicy) ?? { confirm: "dismiss" };
    const accept = dialog.type() === "alert" || (policy[dialog.type() === "beforeunload" ? "confirm" : dialog.type()] ?? "dismiss") === "accept";
    if (accept) await dialog.accept(policy.promptText);
    else await dialog.dismiss();
  }

  /**
   * A Playwright locator for a DOM-lane target, through a one-time marker.
   * @param {TabRef} ref @param {string} target
   */
  async #locate(ref, target) {
    const frameId = Daemon.frameOf(target);
    const mark = await this.#daemon.retrying(() => this.#daemon.dom(ref, "mark", { target }, { frameId }));
    const page = await this.page(ref);
    const selector = `[data-bctl-target="${mark.nonce}"]`;
    let locator = null;
    for (const frame of page.frames()) {
      const candidate = frame.locator(selector);
      if ((await candidate.count().catch(() => 0)) > 0) {
        locator = candidate;
        break;
      }
    }
    const cleanup = () => this.#daemon.dom(ref, "unmark", { nonce: mark.nonce }, { frameId }).catch(() => {});
    if (!locator) {
      await cleanup();
      throw new BctlError("REF_NOT_FOUND", `${target} could not be found through the debugger`);
    }
    return { locator, resolved: mark.resolved, page, cleanup };
  }

  /**
   * @template T
   * @param {TabRef} ref @param {string} target
   * @param {(locator: import("playwright-core").Locator, page: import("playwright-core").Page) => Promise<T>} fn
   */
  async #withTarget(ref, target, fn) {
    const { locator, resolved, page, cleanup } = await this.#locate(ref, target);
    try {
      const result = await fn(locator, page);
      return { resolved, result };
    } catch (error) {
      throw mapPlaywrightError(error);
    } finally {
      await cleanup();
    }
  }

  /** @param {TabRef} ref @param {{target: string, button: "left" | "middle" | "right", doubleClick: boolean, modifiers: ("Alt" | "Control" | "Meta" | "Shift")[]}} p */
  async click(ref, p) {
    const { resolved } = await this.#withTarget(ref, p.target, (l) => l.click({ button: p.button, clickCount: p.doubleClick ? 2 : 1, modifiers: p.modifiers }));
    return { resolved };
  }

  /** @param {TabRef} ref @param {{target: string}} p */
  async hover(ref, p) {
    const { resolved } = await this.#withTarget(ref, p.target, (l) => l.hover());
    return { resolved };
  }

  /** @param {TabRef} ref @param {{key: string, target?: string}} p */
  async press(ref, p) {
    if (p.target) {
      const { resolved } = await this.#withTarget(ref, p.target, (l) => l.press(p.key));
      return { focused: resolved, defaultAction: null };
    }
    const page = await this.page(ref);
    await page.keyboard.press(p.key).catch((e) => Promise.reject(mapPlaywrightError(e)));
    return { focused: null, defaultAction: null };
  }

  /** @param {TabRef} ref @param {{target: string, text: string, slowly?: boolean}} p */
  async type(ref, p) {
    const { resolved, result } = await this.#withTarget(ref, p.target, async (l) => {
      if (p.slowly) {
        await l.fill("");
        await l.pressSequentially(p.text);
      } else await l.fill(p.text);
      return l.inputValue().catch(() => l.innerText());
    });
    return { resolved, value: result };
  }

  /** @param {TabRef} ref @param {string} target @param {boolean} checked */
  async check(ref, target, checked) {
    const { resolved } = await this.#withTarget(ref, target, (l) => l.setChecked(checked));
    return { resolved, value: checked };
  }

  /** @param {TabRef} ref @param {string} target @param {string[]} values */
  async select(ref, target, values) {
    const { resolved, result } = await this.#withTarget(ref, target, (l) => l.selectOption(values));
    return { resolved, value: result };
  }

  /** @param {TabRef} ref @param {{target?: string, direction?: string, amount?: number, to?: string}} p */
  async wheel(ref, p) {
    const page = await this.page(ref);
    const metrics = () => page.evaluate(() => ({ x: scrollX, y: scrollY, height: document.scrollingElement?.scrollHeight ?? 0, view: innerHeight }));
    const before = await metrics();
    let point = { x: (page.viewportSize()?.width ?? 800) / 2, y: before.view / 2 };
    if (p.target) {
      const { result } = await this.#withTarget(ref, p.target, (l) => l.boundingBox());
      if (result) point = { x: result.x + result.width / 2, y: result.y + result.height / 2 };
    }
    const size = p.amount ?? before.view * 0.8;
    const dir = p.direction ?? "down";
    const dy = p.to ? (p.to === "top" ? -1e6 : 1e6) : dir === "down" ? size : dir === "up" ? -size : 0;
    const dx = dir === "right" ? size : dir === "left" ? -size : 0;
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(dx, dy);
    // Loaders answer the scroll late: watch the page height for up to 1.5 s.
    let after = await metrics();
    for (let waited = 0; waited < 1500 && after.height <= before.height; waited += 250) {
      await page.waitForTimeout(250);
      after = await metrics();
    }
    const atEnd = dy < 0 ? after.y <= 0 : after.y + after.view >= after.height - 1;
    return { before: { x: before.x, y: before.y }, after: { x: after.x, y: after.y }, atEnd, contentGrew: after.height > before.height };
  }

  /** @param {TabRef} ref @param {string} target @param {string[]} paths */
  async upload(ref, target, paths) {
    const { result } = await this.#withTarget(ref, target, async (l, page) => {
      const isInput = await l.evaluate((e) => e instanceof HTMLInputElement && e.type === "file");
      if (isInput) {
        await l.setInputFiles(paths);
        return l.evaluate((e) => [.../** @type {HTMLInputElement} */ (e).files ?? []].map((f) => ({ name: f.name, size: f.size, mimeType: f.type })));
      }
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), l.click()]);
      await chooser.setFiles(paths);
      return chooser.element().evaluate((e) => [.../** @type {HTMLInputElement} */ (e).files ?? []].map((f) => ({ name: f.name, size: f.size, mimeType: f.type })));
    });
    return { files: result };
  }

  /** @param {TabRef} ref @param {{fullPage?: boolean, target?: string, format: "jpeg" | "png"}} p */
  async screenshot(ref, p) {
    const options = { type: p.format, ...(p.format === "jpeg" && { quality: 80 }) };
    let buffer;
    if (p.target) buffer = (await this.#withTarget(ref, p.target, (l) => l.screenshot(options))).result;
    else {
      const page = await this.page(ref);
      buffer = await page.screenshot({ ...options, fullPage: Boolean(p.fullPage) }).catch((e) => Promise.reject(mapPlaywrightError(e)));
    }
    return { base64: buffer.toString("base64"), ...imageSize(buffer) };
  }

  /** @param {TabRef} ref @param {string} fn @param {string | undefined} target */
  async evaluate(ref, fn, target) {
    try {
      // The agent's code is a function or an expression; call it when it is a function.
      /** @type {any} */
      const onElement = new Function("el", `const v = (${fn}); return typeof v === "function" ? v(el) : v;`);
      const value = target
        ? (await this.#withTarget(ref, target, (l) => l.evaluate(onElement))).result
        : await (await this.page(ref)).evaluate(`(async () => { const v = (${fn}); return typeof v === "function" ? await v() : await v; })()`);
      return { value: value === undefined ? null : value, type: value === null ? "null" : typeof value };
    } catch (error) {
      const e = mapPlaywrightError(error);
      if (e.code === "INTERNAL_ERROR") throw new BctlError("EVAL_ERROR", String(/** @type {any} */ (error)?.message ?? error).split("\n")[0]);
      throw e;
    }
  }

  /** Answers a native dialog that is open now. @param {TabRef} ref @param {boolean} accept @param {string} [promptText] */
  async answerDialog(ref, accept, promptText) {
    const state = this.#state(ref);
    await this.page(ref);
    try {
      await state.attachments.send(ref.tabId, undefined, "Page.handleJavaScriptDialog", { accept, ...(promptText !== undefined && { promptText }) });
      return { accepted: accept };
    } catch (error) {
      if (/no dialog/i.test(String(/** @type {any} */ (error)?.message))) return null;
      throw toBctlError(error);
    }
  }

  // ---------- response bodies ----------

  /** @param {TabRef} ref @param {boolean} on */
  async captureBodies(ref, on) {
    const state = this.#state(ref);
    if (on) {
      await this.page(ref);
      state.attachments.pin(ref.tabId, "network");
      await state.attachments.send(ref.tabId, undefined, "Network.enable", {});
      if (!state.captures.has(ref.tabId)) state.captures.set(ref.tabId, { bodies: [], bytes: 0 });
    } else {
      state.captures.delete(ref.tabId);
      state.attachments.unpin(ref.tabId, "network");
    }
  }

  /** @param {TabRef} ref */
  isCapturing(ref) {
    return this.#states.get(ref.instanceId)?.captures.has(ref.tabId) ?? false;
  }

  /** @type {Map<string, {url: string, method: string, at: number}>} */
  #inflight = new Map();

  /** @param {BrowserState} state @param {{tabId: number, sessionId?: string, method: string, params: any}} e */
  #onNetworkEvent(state, e) {
    const capture = state.captures.get(e.tabId);
    if (!capture || e.sessionId) return;
    if (e.method === "Network.responseReceived") {
      this.#inflight.set(`${e.tabId}:${e.params.requestId}`, { url: e.params.response.url, method: "", at: Date.now() });
    }
    if (e.method === "Network.requestWillBeSent") {
      this.#inflight.set(`${e.tabId}:${e.params.requestId}`, { url: e.params.request.url, method: e.params.request.method, at: Date.now() });
    }
    if (e.method === "Network.loadingFinished") {
      const key = `${e.tabId}:${e.params.requestId}`;
      const meta = this.#inflight.get(key);
      this.#inflight.delete(key);
      if (!meta) return;
      state.attachments
        .send(e.tabId, undefined, "Network.getResponseBody", { requestId: e.params.requestId })
        .then((/** @type {any} */ r) => {
          const size = r.body.length;
          if (size > BODY_LIMIT) return;
          capture.bodies.push({ url: meta.url, method: meta.method, at: meta.at, body: r.body, base64: r.base64Encoded, size });
          capture.bytes += size;
          while (capture.bytes > TAB_BODY_LIMIT && capture.bodies.length) capture.bytes -= /** @type {any} */ (capture.bodies.shift()).size;
        })
        .catch(() => {});
    }
  }

  /** @param {TabRef} ref @param {{url: string, method: string, startedAt: number}} entry */
  async responseBody(ref, entry) {
    const capture = this.#states.get(ref.instanceId)?.captures.get(ref.tabId);
    if (!capture) return null;
    const matches = capture.bodies.filter((b) => b.url === entry.url && (!b.method || b.method === entry.method));
    if (!matches.length) return null;
    const best = matches.reduce((a, b) => (Math.abs(b.at - entry.startedAt) < Math.abs(a.at - entry.startedAt) ? b : a));
    const text = best.base64 ? Buffer.from(best.body, "base64").toString("utf8") : best.body;
    const truncated = text.length > 50_000;
    return { body: truncated ? text.slice(0, 50_000) : text, bodyTruncated: truncated };
  }

  // ---------- run ----------

  /**
   * A relay for a worker process's own Playwright connection (specs/tools/run.md).
   * @param {string} instanceId @param {number} tabId @param {import("ws").WebSocket} ws
   */
  serveWorker(instanceId, tabId, ws) {
    const ref = { instanceId, tabId };
    const state = this.#state(ref);
    const relay = new CdpRelay(state.attachments, { onCreateTarget: async () => this.#newTabFor(ref) });
    relay.serve(ws);
    relay.claim(tabId).catch(() => ws.close());
  }

  /**
   * @param {import("../sessions.js").Session} session @param {TabRef} ref @param {string} code @param {number} timeoutSeconds
   * @returns {Promise<{value: any, console: string[], stateLost?: boolean}>}
   */
  async run(session, ref, code, timeoutSeconds) {
    const state = this.#state(ref);
    await this.page(ref);
    state.attachments.pin(ref.tabId, "run");
    const key = `${session.id}`;
    let worker = this.#workers.get(key);
    const dead = (/** @type {import("node:child_process").ChildProcess} */ c) => c.killed || c.exitCode !== null || c.signalCode !== null;
    if (worker && (worker.ref.tabId !== ref.tabId || worker.ref.instanceId !== ref.instanceId || dead(worker.child))) {
      worker.child.kill();
      worker = undefined;
    }
    if (!worker) {
      const endpoint = `ws://127.0.0.1:${/** @type {any} */ (this.#daemon).port}/cdp?browser=${encodeURIComponent(ref.instanceId)}&tab=${ref.tabId}`;
      const child = fork(WORKER, [], { env: { ...process.env, BROWSERCTL_CDP_ENDPOINT: endpoint }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      worker = { child, ref };
      this.#workers.set(key, worker);
      child.on("exit", () => {
        if (this.#workers.get(key)?.child === child) this.#workers.delete(key);
      });
    }
    const id = this.#nextCall++;
    const child = worker.child;
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.#workers.get(key)?.child === child) this.#workers.delete(key);
          child.kill("SIGKILL");
          reject(new BctlError("TIMEOUT", `run took more than ${timeoutSeconds} s; the worker was stopped and state was lost`));
        }, timeoutSeconds * 1000);
        /** @param {any} message */
        const onMessage = (message) => {
          if (message?.id !== id) return;
          clearTimeout(timer);
          child.off("message", onMessage);
          if (message.ok) resolve({ value: message.value, console: message.console });
          else reject(new BctlError("EVAL_ERROR", message.error));
        };
        child.on("message", onMessage);
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new BctlError("TIMEOUT", "the run worker stopped; state was lost"));
        });
        child.send({ id, code });
      });
    } finally {
      state.attachments.unpin(ref.tabId, "run");
    }
  }

  // ---------- lifecycle ----------

  /** @param {string} instanceId */
  attachmentsOf(instanceId) {
    return this.#states.get(instanceId)?.attachments.list() ?? [];
  }

  /** @param {TabRef} ref */
  async detach(ref) {
    const state = this.#states.get(ref.instanceId);
    if (!state) return;
    state.pages.delete(ref.tabId);
    state.relay.release(ref.tabId);
    await state.attachments.detach(ref.tabId);
  }

  /** @param {string} sessionId */
  endSession(sessionId) {
    this.#workers.get(sessionId)?.child.kill();
    this.#workers.delete(sessionId);
  }

  close() {
    for (const w of this.#workers.values()) w.child.kill();
    this.#workers.clear();
    for (const state of this.#states.values()) {
      state.attachments.close();
      state.relay.disconnect();
    }
    this.#states.clear();
  }
}
