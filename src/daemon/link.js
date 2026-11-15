// @ts-check
// One extension connection: request/response with timeouts, and events (specs/interface.md).
import { EventEmitter } from "node:events";
import { BctlError, PAGE_BLOCKED_HINT, toBctlError } from "./errors.js";

// Requests the page itself answers: a timeout means the page is blocked (specs/interface.md).
const PAGE_METHODS = new Set(["dom.call", "eval.user"]);

const DEFAULT_TIMEOUT_MS = 10_000;
const KEEPALIVE_MS = 20_000;

export class ExtensionLink extends EventEmitter {
  /** @type {import("ws").WebSocket} */
  #socket;
  #nextId = 1;
  /** @type {Map<number, {resolve: (v: any) => void, reject: (e: unknown) => void, timer: NodeJS.Timeout}>} */
  #pending = new Map();
  #keepAlive;
  closed = false;

  /** @param {import("ws").WebSocket} socket */
  constructor(socket) {
    super();
    this.#socket = socket;
    socket.on("message", (raw) => this.#onMessage(raw.toString()));
    socket.on("close", () => this.#onClose());
    socket.on("error", () => {});
    // Traffic keeps the extension's service worker from being stopped while connected.
    this.#keepAlive = setInterval(() => this.#send({ event: "ping" }), KEEPALIVE_MS);
  }

  /** @param {object} message */
  #send(message) {
    if (this.#socket.readyState === this.#socket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  /** A one-way message to the extension. @param {string} event @param {object} data */
  notify(event, data) {
    this.#send({ event, data });
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new BctlError("NO_BROWSER", "the browser disconnected"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const message = `${method} got no answer in ${timeoutMs} ms`;
        reject(PAGE_METHODS.has(method) ? new BctlError("TIMEOUT", message, { hint: PAGE_BLOCKED_HINT }) : Object.assign(new Error(message), { code: "TIMEOUT", method }));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ id, method, params });
    });
  }

  /** @param {string} text */
  #onMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(toBctlError(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.event === "string") this.emit(message.event, message.data);
  }

  #onClose() {
    this.closed = true;
    clearInterval(this.#keepAlive);
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(new BctlError("NO_BROWSER", "the browser disconnected"));
    }
    this.#pending.clear();
    this.emit("close");
  }

  close() {
    this.#socket.close();
  }
}
