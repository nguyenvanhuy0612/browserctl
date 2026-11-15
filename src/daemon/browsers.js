// @ts-check
// Connected browsers, one per extension instanceId, with stable aliases (specs/sessions.md).
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PROTOCOL } from "../../extension/sw/protocol.js";
import { BctlError } from "./errors.js";
import { ExtensionLink } from "./link.js";

/**
 * @typedef {{
 *   instanceId: string,
 *   alias: string,
 *   link: ExtensionLink | null,
 *   hello: any,
 *   outdated: boolean,
 *   debuggerCanceled: boolean,
 * }} Browser
 */

/** @param {string} name */
function family(name) {
  const lower = name.toLowerCase();
  if (lower.includes("edge")) return "edge";
  if (lower.includes("brave")) return "brave";
  if (lower.includes("opera")) return "opera";
  if (lower.includes("vivaldi")) return "vivaldi";
  if (lower.includes("chrome") || lower.includes("chromium")) return "chrome";
  return lower.replace(/[^a-z]+/g, "") || "browser";
}

export class Browsers extends EventEmitter {
  /** @type {Map<string, Browser>} */
  #byId = new Map();
  #aliasFile;
  /** @type {Record<string, string>} */
  #aliases;

  /** @param {{home: string}} options */
  constructor({ home }) {
    super();
    this.#aliasFile = path.join(home, "browsers.json");
    try {
      this.#aliases = JSON.parse(fs.readFileSync(this.#aliasFile, "utf8"));
    } catch {
      this.#aliases = {};
    }
  }

  /** @param {string} instanceId @param {string} name */
  #aliasFor(instanceId, name) {
    if (this.#aliases[instanceId]) return this.#aliases[instanceId];
    const base = family(name);
    const taken = new Set(Object.values(this.#aliases));
    let n = 1;
    while (taken.has(`${base}-${n}`)) n++;
    this.#aliases[instanceId] = `${base}-${n}`;
    try {
      fs.mkdirSync(path.dirname(this.#aliasFile), { recursive: true });
      fs.writeFileSync(this.#aliasFile, JSON.stringify(this.#aliases, null, 2));
    } catch {
      // Aliases still work for this run.
    }
    return this.#aliases[instanceId];
  }

  /** @param {import("ws").WebSocket} socket */
  adopt(socket) {
    const link = new ExtensionLink(socket);
    link.once("hello", (hello) => this.#register(link, hello));
  }

  /** @param {ExtensionLink} link @param {any} hello */
  #register(link, hello) {
    const instanceId = String(hello?.instanceId ?? "");
    if (!instanceId) {
      link.close();
      return;
    }
    const previous = this.#byId.get(instanceId);
    if (previous?.link && previous.link !== link) previous.link.close();
    /** @type {Browser} */
    const browser = {
      instanceId,
      alias: this.#aliasFor(instanceId, hello.browser?.name ?? "chrome"),
      link,
      hello,
      outdated: hello.protocol !== PROTOCOL,
      debuggerCanceled: previous?.debuggerCanceled ?? false,
    };
    this.#byId.set(instanceId, browser);
    link.on("close", () => {
      if (browser.link === link) {
        browser.link = null;
        this.emit("disconnected", browser);
      }
    });
    const forward = (/** @type {string} */ name) => (/** @type {any} */ data) => this.emit("event", browser, name, data);
    for (const name of ["tabs.created", "tabs.removed", "tabs.updated", "nav.beforeNavigate", "nav.committed", "nav.domContentLoaded", "nav.historyStateUpdated", "nav.completed", "nav.createdTarget", "nav.error", "net.request", "debugger.event", "debugger.detached", "diag"]) {
      link.on(name, forward(name));
    }
    this.emit("connected", browser);
  }

  /** @returns {Browser[]} */
  connected() {
    return [...this.#byId.values()].filter((b) => b.link && !b.link.closed);
  }

  /** @param {string} instanceId */
  byId(instanceId) {
    return this.#byId.get(instanceId);
  }

  /**
   * The browser a call goes to (specs/sessions.md).
   * @param {string} [alias]
   * @returns {Browser}
   */
  pick(alias) {
    const list = this.connected();
    if (alias) {
      const found = list.find((b) => b.alias === alias);
      if (!found) throw new BctlError("NO_BROWSER", `no connected browser named ${alias}`, { browsers: list.map((b) => b.alias) });
      return found;
    }
    if (list.length === 0) throw new BctlError("NO_BROWSER", "no browser is connected");
    if (list.length > 1) throw new BctlError("AMBIGUOUS_BROWSER", `${list.length} browsers are connected`, { browsers: list.map((b) => b.alias) });
    return list[0];
  }

  /** @param {Browser} browser */
  static usable(browser) {
    if (!browser.link || browser.link.closed) throw new BctlError("NO_BROWSER", `${browser.alias} is not connected`);
    if (browser.outdated) {
      throw new BctlError("EXTENSION_OUTDATED", `${browser.alias} runs extension protocol ${browser.hello.protocol}, the daemon speaks ${PROTOCOL}`);
    }
    return /** @type {ExtensionLink} */ (browser.link);
  }
}
