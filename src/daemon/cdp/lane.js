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
import { REF, toSelector } from "../targets.js";
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
 *   captures: Map<number, Capture>,
 * }} BrowserState
 * @typedef {{
 *   bodies: {url: string, method: string, at: number, body: string, base64: boolean, size: number}[],
 *   bytes: number,
 *   inflight: Map<string, {url: string, method: string, at: number}>,
 * }} Capture
 * @typedef {{
 *   child: import("node:child_process").ChildProcess,
 *   ref: TabRef,
 *   relay: Promise<CdpRelay>,
 *   connected: (relay: CdpRelay) => void,
 * }} Worker
 */

// Bodies not kept: binary files an agent reads through the page (specs/tools/network_requests.md).
const SKIPPED_BODIES = new Set(["Image", "Media", "Font"]);

/** Playwright's errors as public codes (specs/tools/click.md). @param {unknown} error */
export function mapPlaywrightError(error) {
  const message = String(/** @type {any} */ (error)?.message ?? error);
  if (error instanceof BctlError) return error;
  if (/strict mode violation/i.test(message)) return new BctlError("AMBIGUOUS_TARGET", message.split("\n")[0]);
  if (/intercepts pointer events/i.test(message)) return new BctlError("TARGET_COVERED", message.split("\n").find((l) => /intercepts/.test(l))?.trim() ?? message);
  if (/not enabled|is disabled/i.test(message)) return new BctlError("TARGET_DISABLED", "the element stayed disabled");
  if (/element is inert/i.test(message)) return new BctlError("TARGET_DISABLED", "the element stayed inert");
  if (/not visible/i.test(message)) return new BctlError("TARGET_HIDDEN", "the element stayed hidden");
  if (/not editable|not an <input>|cannot type/i.test(message)) return new BctlError("TARGET_NOT_EDITABLE", message.split("\n")[0]);
  if (/has been closed|Target closed/i.test(message)) return new BctlError("TAB_CLOSED", "the tab closed");
  if (/Timeout .* exceeded/i.test(message)) return new BctlError("TIMEOUT", message.split("\n")[0]);
  return toBctlError(error);
}

/** Seconds (specs/actions.md) to a Playwright timeout: 0 means one try, which Playwright spells 1 ms (its 0 is "no limit"). @param {number | undefined} seconds */
const pwTimeout = (seconds) => Math.max(1, (seconds ?? 5) * 1000);

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
  /** @type {Map<string, Worker>} one `run` worker per session */
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
    // the extension reconnected (service worker restart): the old connection's state is gone, and
    // so are the run workers, whose connections were relayed over it (specs/tools/run.md)
    if (state) {
      this.#closeState(state);
      for (const worker of this.#workers.values()) if (worker.ref.instanceId === ref.instanceId) this.#stopWorker(worker);
    }
    const attachments = new Attachments(browser, { idleMs: this.#idleMs });
    const relay = new CdpRelay(attachments, {
      onCreateTarget: async () => {
        throw new Error("the daemon's own connection opens no tabs");
      },
    });
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

  /**
   * A tab that `run` code opens (`context.newPage()`) joins the code's session.
   * @param {TabRef} ref a tab of that browser @param {string} sessionId
   */
  async #newTabFor(ref, sessionId) {
    const created = await this.#daemon.linkOf(ref).request("tabs.create", { url: "about:blank" });
    const session = this.#daemon.sessions.sessions.get(sessionId);
    if (session) this.#daemon.sessions.own(session, ref.instanceId, created.tabId, "owned");
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

  /**
   * Dialogs the shim did not take (a document not armed yet) follow the tab's policy; beforeunload
   * leaves the page, as in armed documents (specs/dom-lane.md).
   * @param {TabRef} ref @param {import("playwright-core").Dialog} dialog
   */
  async #answer(ref, dialog) {
    const policy = /** @type {any} */ (this.#daemon.sessions.ownerOf(ref.instanceId, ref.tabId)?.dialogPolicy) ?? { confirm: "dismiss" };
    const accept = dialog.type() === "alert" || dialog.type() === "beforeunload" || (policy[dialog.type()] ?? "dismiss") === "accept";
    if (accept) await dialog.accept(policy.promptText);
    else await dialog.dismiss();
  }

  /**
   * A Playwright locator for a target the DOM lane resolved: a selector as itself, so Playwright
   * resolves it again on retries; a ref (or a label's control) through a one-time marker
   * (specs/targets.md).
   * @param {TabRef} ref @param {string} target @param {number} [timeoutMs] @param {boolean} [control] mark the label's visible control instead
   */
  async #locate(ref, target, timeoutMs = 5000, control = false) {
    const frameId = Daemon.frameOf(target);
    if (!control && !REF.test(target)) {
      const { resolved } = await this.#daemon.retrying(() => this.#daemon.dom(ref, "resolve", { target }, { frameId }), timeoutMs);
      const page = await this.page(ref);
      return { locator: page.locator(toSelector(target)), resolved, page, cleanup: async () => {} };
    }
    const mark = await this.#daemon.retrying(() => this.#daemon.dom(ref, "mark", { target, control }, { frameId }), timeoutMs);
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
   * @param {{timeout?: number, scroll?: "auto" | "center" | "none", control?: boolean}} [options] timeout in seconds (specs/actions.md); control: the label's control
   */
  async #withTarget(ref, target, fn, { timeout = 5, scroll = "auto", control = false } = {}) {
    const { locator, resolved, page, cleanup } = await this.#locate(ref, target, timeout * 1000, control);
    try {
      if (scroll === "center") await locator.evaluate((e) => e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }));
      if (scroll === "none") {
        const inside = await locator.evaluate((e) => {
          const r = e.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          return x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
        });
        if (!inside) throw new BctlError("TARGET_OUTSIDE_VIEWPORT", `${resolved.role} "${resolved.name}" is outside the viewport`);
      }
      const result = await fn(locator, page);
      return { resolved, result };
    } catch (error) {
      throw mapPlaywrightError(error);
    } finally {
      await cleanup();
    }
  }

  /** @param {TabRef} ref @param {{target: string, button: "left" | "middle" | "right", doubleClick: boolean, modifiers: ("Alt" | "Control" | "Meta" | "Shift")[], timeout?: number, scroll?: "auto" | "center" | "none"}} p */
  async click(ref, p) {
    const ms = pwTimeout(p.timeout);
    const { resolved } = await this.#withTarget(ref, p.target, (l) => l.click({ button: p.button, clickCount: p.doubleClick ? 2 : 1, modifiers: p.modifiers, timeout: ms }), p);
    return { resolved };
  }

  /** @param {TabRef} ref @param {{target: string, timeout?: number, scroll?: "auto" | "center" | "none"}} p */
  async hover(ref, p) {
    const { resolved } = await this.#withTarget(ref, p.target, (l) => l.hover({ timeout: pwTimeout(p.timeout) }), p);
    return { resolved };
  }

  /** @param {TabRef} ref @param {{key: string, target?: string, timeout?: number}} p */
  async press(ref, p) {
    if (p.target) {
      const { resolved } = await this.#withTarget(ref, p.target, (l) => l.press(p.key, { timeout: pwTimeout(p.timeout) }), p);
      return { focused: resolved, defaultAction: null };
    }
    const page = await this.page(ref);
    await page.keyboard.press(p.key).catch((e) => Promise.reject(mapPlaywrightError(e)));
    return { focused: null, defaultAction: null };
  }

  /** @param {TabRef} ref @param {{target: string, text: string, slowly?: boolean, timeout?: number, scroll?: "auto" | "center" | "none"}} p */
  async type(ref, p) {
    const timeout = pwTimeout(p.timeout);
    const { resolved, result } = await this.#withTarget(
      ref,
      p.target,
      async (l) => {
        if (p.slowly) {
          if (await l.evaluate((e) => ("value" in e ? e.value : e.textContent) !== "", undefined, { timeout })) await l.fill("", { timeout });
          await l.pressSequentially(p.text, { timeout });
        } else await l.fill(p.text, { timeout });
        // a field that left the page (typing navigated) reads as null (specs/tools/type.md, step 6)
        return l.evaluate((e) => ("value" in e ? e.value : /** @type {HTMLElement} */ (e).innerText), undefined, { timeout: 1000 }).catch(() => null);
      },
      p,
    );
    return { resolved, value: result };
  }

  /**
   * Sets a checkable; `control` clicks the label's visible control instead of the label (specs/tools/fill_form.md).
   * @param {TabRef} ref @param {string} target @param {boolean} checked @param {{timeout?: number, scroll?: "auto" | "center" | "none", control?: boolean}} [options]
   */
  async check(ref, target, checked, options = {}) {
    const { resolved } = await this.#withTarget(ref, target, (l) => l.setChecked(checked, { timeout: pwTimeout(options.timeout) }), options);
    return { resolved, value: checked };
  }

  /** @param {TabRef} ref @param {string} target @param {string[]} values @param {{timeout?: number, scroll?: "auto" | "center" | "none"}} [options] */
  async select(ref, target, values, options = {}) {
    const { resolved, result } = await this.#withTarget(ref, target, (l) => l.selectOption(values, { timeout: pwTimeout(options.timeout) }), options);
    return { resolved, value: result };
  }

  /** @param {TabRef} ref @param {{target?: string, direction?: string, amount?: number, to?: string, timeout?: number}} p */
  async wheel(ref, p) {
    const page = await this.page(ref);
    const metrics = () => page.evaluate(() => ({ x: scrollX, y: scrollY, height: document.scrollingElement?.scrollHeight ?? 0, view: innerHeight, width: innerWidth }));
    const before = await metrics();
    let point = { x: before.width / 2, y: before.view / 2 };
    if (p.target) {
      // Without a direction, an element that does not scroll is brought into view, as in the DOM lane (specs/tools/scroll.md).
      const bringIntoView = !p.direction && p.amount === undefined && !p.to;
      const { resolved, result } = await this.#withTarget(
        ref,
        p.target,
        async (l) => {
          const scrollable = await l.evaluate((e) => {
            const style = getComputedStyle(e);
            return (e.scrollHeight > e.clientHeight + 1 && /(auto|scroll|overlay)/.test(style.overflowY)) || (e.scrollWidth > e.clientWidth + 1 && /(auto|scroll|overlay)/.test(style.overflowX));
          });
          if (bringIntoView && !scrollable) {
            await l.evaluate((e) => e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }));
            return null;
          }
          await l.scrollIntoViewIfNeeded();
          return l.boundingBox();
        },
        { timeout: p.timeout },
      );
      if (bringIntoView && !result) return { intoView: resolved, before: null, after: null, atEnd: false, contentGrew: false };
      if (result) {
        // the centre of the part of the target inside the viewport, where the wheel reaches it
        const left = Math.max(0, result.x);
        const top = Math.max(0, result.y);
        const right = Math.min(before.width, result.x + result.width);
        const bottom = Math.min(before.view, result.y + result.height);
        point = { x: (left + right) / 2, y: (top + bottom) / 2 };
      }
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

  /** @param {TabRef} ref @param {string} target @param {string[]} paths @param {{timeout?: number}} [options] */
  async upload(ref, target, paths, options = {}) {
    const { result } = await this.#withTarget(ref, target, async (l, page) => {
      const isInput = await l.evaluate((e) => e instanceof HTMLInputElement && e.type === "file");
      const timeout = pwTimeout(options.timeout);
      if (isInput) {
        await l.setInputFiles(paths, { timeout });
        return l.evaluate((e) => [.../** @type {HTMLInputElement} */ (e).files ?? []].map((f) => ({ name: f.name, size: f.size, mimeType: f.type })));
      }
      const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout }), l.click({ timeout })]);
      await chooser.setFiles(paths, { timeout });
      return chooser.element().evaluate((e) => [.../** @type {HTMLInputElement} */ (e).files ?? []].map((f) => ({ name: f.name, size: f.size, mimeType: f.type })));
    }, options);
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

  /**
   * @param {TabRef} ref @param {string} fn @param {string | undefined} target
   * @param {number} timeoutMs how long the code may run; Playwright's evaluate has no limit of its own
   */
  async evaluate(ref, fn, target, timeoutMs) {
    try {
      // The agent's code, a function or an expression, is compiled at the top level of the source,
      // so it sees the page's globals and none of this wrapper's names (specs/tools/evaluate.md).
      const call = `((input) => async (element) => { const value = input(); return typeof value === "function" ? await value(element) : await value; })(() => (\n${fn}\n))`;
      // Playwright runs a string as an expression and a Function as a function of the element.
      /** @type {any} */
      const onElement = new Function("__bctlElement", `return ${call}(__bctlElement);`);
      const work = target ? this.#withTarget(ref, target, (l) => l.evaluate(onElement)).then((r) => r.result) : this.page(ref).then((page) => page.evaluate(`${call}(undefined)`));
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      const late = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new BctlError("TIMEOUT", `evaluate did not finish in ${timeoutMs / 1000} s`)), timeoutMs);
      });
      const value = await Promise.race([work, late]).finally(() => clearTimeout(timer));
      return { value: value === undefined ? null : value, type: value === null ? "null" : typeof value };
    } catch (error) {
      const e = mapPlaywrightError(error);
      if (e.code === "INTERNAL_ERROR") throw new BctlError("EVAL_ERROR", String(/** @type {any} */ (error)?.message ?? error).split("\n")[0]);
      throw e;
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
      if (!state.captures.has(ref.tabId)) state.captures.set(ref.tabId, { bodies: [], bytes: 0, inflight: new Map() });
    } else {
      state.captures.delete(ref.tabId);
      state.attachments.unpin(ref.tabId, "network");
    }
  }

  /** @param {TabRef} ref */
  isCapturing(ref) {
    return this.#states.get(ref.instanceId)?.captures.has(ref.tabId) ?? false;
  }

  /**
   * Keeps the body of each finished request of a capturing tab, except binary files; a failed
   * request is forgotten (specs/tools/network_requests.md).
   * @param {BrowserState} state @param {{tabId: number, sessionId?: string, method: string, params: any}} e
   */
  #onNetworkEvent(state, e) {
    const capture = state.captures.get(e.tabId);
    if (!capture || e.sessionId) return;
    const { requestId } = e.params;
    switch (e.method) {
      case "Network.requestWillBeSent":
        capture.inflight.set(requestId, { url: e.params.request.url, method: e.params.request.method, at: Date.now() });
        return;
      case "Network.responseReceived":
        if (SKIPPED_BODIES.has(e.params.type)) capture.inflight.delete(requestId);
        // a request sent before capture started: known from its response, method unknown
        else if (!capture.inflight.has(requestId)) capture.inflight.set(requestId, { url: e.params.response.url, method: "", at: Date.now() });
        return;
      case "Network.loadingFailed":
        capture.inflight.delete(requestId);
        return;
      case "Network.loadingFinished": {
        const meta = capture.inflight.get(requestId);
        capture.inflight.delete(requestId);
        if (!meta) return;
        state.attachments
          .send(e.tabId, undefined, "Network.getResponseBody", { requestId })
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
   * A session's worker connecting its Playwright to its own relay over the tab attachments
   * (specs/tools/run.md). A tab that a page in one of its tabs opens joins it as that page's popup.
   * @param {string} sessionId @param {import("ws").WebSocket} ws
   */
  serveWorker(sessionId, ws) {
    const worker = this.#workers.get(sessionId);
    if (!worker) {
      ws.close();
      return;
    }
    const state = this.#state(worker.ref);
    /** @type {(() => void)[]} */
    const stops = [];
    const relay = new CdpRelay(state.attachments, {
      onCreateTarget: () => this.#newTabFor(worker.ref, sessionId),
      onClaim: (tabId) => {
        const popups = (/** @type {import("../app.js").TabEvent} */ e) => {
          if (e.name === "newTab") relay.claim(e.data.tab, tabId).catch(() => {});
        };
        stops.push(this.#daemon.onTabEvent({ instanceId: worker.ref.instanceId, tabId }, popups));
      },
    });
    relay.serve(ws);
    ws.on("close", () => {
      for (const stop of stops) stop();
    });
    worker.connected(relay);
  }

  /**
   * The session's worker for a tab of this browser, started if there is none or it cannot serve
   * the tab (another browser, or it died).
   * @param {string} sessionId @param {TabRef} ref
   */
  #worker(sessionId, ref) {
    const existing = this.#workers.get(sessionId);
    if (existing && existing.ref.instanceId === ref.instanceId && existing.child.exitCode === null && existing.child.signalCode === null) return existing;
    if (existing) this.#stopWorker(existing);
    const endpoint = `ws://127.0.0.1:${this.#daemon.port}/cdp?session=${encodeURIComponent(sessionId)}`;
    /** @type {(relay: CdpRelay) => void} */
    let connected = () => {};
    /** @type {Promise<CdpRelay>} */
    const relay = new Promise((resolve) => {
      connected = resolve;
    });
    const child = fork(WORKER, [], { env: { ...process.env, BROWSERCTL_CDP_ENDPOINT: endpoint }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    /** @type {Worker} */
    const worker = { child, ref, relay, connected };
    this.#workers.set(sessionId, worker);
    worker.child.on("exit", () => {
      if (this.#workers.get(sessionId) === worker) this.#workers.delete(sessionId);
    });
    return worker;
  }

  /** @param {Worker} worker */
  #stopWorker(worker) {
    for (const [id, w] of this.#workers) if (w === worker) this.#workers.delete(id);
    worker.child.kill("SIGKILL");
  }

  /**
   * @param {import("../sessions.js").Session} session @param {TabRef} ref @param {string} code @param {number} timeoutSeconds
   * @returns {Promise<{value: any, console: string[]}>}
   */
  async run(session, ref, code, timeoutSeconds) {
    const state = this.#state(ref);
    await this.page(ref);
    state.attachments.pin(ref.tabId, "run");
    const worker = this.#worker(session.id, ref);
    const id = this.#nextCall++;
    try {
      return await new Promise((resolve, reject) => {
        /** @param {(() => void)} settle */
        const end = (settle) => {
          clearTimeout(timer);
          worker.child.off("message", onMessage);
          worker.child.off("exit", onExit);
          settle();
        };
        const timer = setTimeout(() => {
          this.#stopWorker(worker);
          end(() => reject(new BctlError("TIMEOUT", `run took more than ${timeoutSeconds} s; the worker was stopped and state was lost`)));
        }, timeoutSeconds * 1000);
        /** @param {any} message */
        const onMessage = (message) => {
          if (message?.id !== id) return;
          end(() => (message.ok ? resolve({ value: message.value, console: message.console }) : reject(new BctlError("EVAL_ERROR", message.error))));
        };
        const onExit = () => end(() => reject(new BctlError("TIMEOUT", "the run worker stopped; state was lost")));
        worker.child.on("message", onMessage);
        worker.child.once("exit", onExit);
        // the call's tab joins the worker's connection; the worker picks its page by target id
        worker.relay
          .then((relay) => relay.claim(ref.tabId))
          .then(() => worker.child.send({ id, code, targetId: state.attachments.info(ref.tabId)?.targetId }))
          .catch((error) => end(() => reject(toBctlError(error))));
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
    const worker = this.#workers.get(sessionId);
    if (worker) this.#stopWorker(worker);
  }

  close() {
    for (const worker of [...this.#workers.values()]) this.#stopWorker(worker);
    for (const state of this.#states.values()) this.#closeState(state);
    this.#states.clear();
  }

  /** @param {BrowserState} state */
  #closeState(state) {
    state.attachments.close();
    state.relay.disconnect();
  }
}
