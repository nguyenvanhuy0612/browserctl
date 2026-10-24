// CDP Session Manager for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/02-driver-and-cdp.md.

import { RpcError, RPC_ERRORS } from "../transport/errors.js";

/**
 * Active CDP sessions tracked per tabId.
 * @type {Map<number, { console: Array, network: Map, domainsEnabled: boolean, fetchRules: Array }>}
 */
export const sessions = new Map();

/**
 * In-flight attach operations per tabId to prevent duplicate concurrent attachments.
 * @type {Map<number, Promise<void>>}
 */
export const attaching = new Map();

/**
 * In-flight session opening operations per tabId.
 * @type {Map<number, Promise<any>>}
 */
export const opening = new Map();

const ATTACHED_KEY = "bctl_cdp_attached_tabs";

function persistAttached() {
  if (typeof chrome !== "undefined" && chrome.storage?.session?.set) {
    chrome.storage.session.set({ [ATTACHED_KEY]: [...sessions.keys()] }).catch(() => {});
  }
}

/**
 * Check if a tab is currently attached to CDP.
 * @param {number} tabId
 * @returns {boolean}
 */
export function isAttached(tabId) {
  return sessions.has(tabId);
}

/**
 * Sends a CDP command via chrome.debugger.sendCommand wrapped in a deterministic promise with timeout.
 *
 * @param {number} tabId
 * @param {string} method
 * @param {object} [params={}]
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<any>}
 */
export async function sendCdpCommand(tabId, method, params = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let timer = null;
    if (typeof timeoutMs === "number" && timeoutMs > 0 && timeoutMs < Infinity) {
      timer = setTimeout(() => {
        reject(
          new RpcError(RPC_ERRORS.NAVIGATION_TIMEOUT, `CDP command ${method} timed out`, {
            reason: "CDP_TIMEOUT",
            retriable: true,
          })
        );
      }, timeoutMs);
    }

    if (typeof chrome === "undefined" || !chrome.debugger?.sendCommand) {
      if (timer) clearTimeout(timer);
      return reject(
        new RpcError(RPC_ERRORS.CDP_ATTACH_FAILED, "chrome.debugger API is not available", {
          reason: "CDP_UNAVAILABLE",
          retriable: false,
        })
      );
    }

    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (timer) clearTimeout(timer);
      const lastErr = chrome.runtime?.lastError;
      if (lastErr) {
        return reject(
          new RpcError(RPC_ERRORS.CDP_ATTACH_FAILED, lastErr.message, {
            reason: "CDP_COMMAND_ERROR",
            retriable: true,
          })
        );
      }
      resolve(result || {});
    });
  });
}

/**
 * Raw command dispatch matching internal CDP helper convention.
 * @param {number} tabId
 * @param {string} method
 * @param {object} [params={}]
 * @returns {Promise<any>}
 */
export async function sendRaw(tabId, method, params = {}) {
  return sendCdpCommand(tabId, method, params, 30000);
}

/**
 * Single-attachment helper using version "1.3".
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export function attachOnce(tabId) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.debugger?.attach) {
      return reject(
        new RpcError(RPC_ERRORS.CDP_ATTACH_FAILED, "chrome.debugger API is not available", {
          reason: "CDP_UNAVAILABLE",
        })
      );
    }
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const e = chrome.runtime?.lastError;
      if (e) {
        reject(
          new RpcError(RPC_ERRORS.CDP_ATTACH_FAILED, e.message, {
            reason: "CDP_ATTACH_FAILED",
          })
        );
      } else {
        resolve();
      }
    });
  });
}

/**
 * Detach a debugger session for the given tabId.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export function detach(tabId) {
  dropTab(tabId);
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.debugger?.detach) {
      return resolve();
    }
    chrome.debugger.detach({ tabId }, () => {
      const e = chrome.runtime?.lastError;
      if (e) {
        reject(new Error(e.message));
      } else {
        resolve();
      }
    });
  });
}

export const detachDebugger = detach;
export const detachSession = detach;
export const attachDebugger = ensureAttached;
export const attachSession = ensureAttached;

/**
 * Attach with single-attachment guard and retry logic.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export async function attach(tabId) {
  try {
    await attachOnce(tabId);
  } catch (err) {
    if (!/another debugger is already attached/i.test(err.message || "")) {
      throw err;
    }
    try {
      await detach(tabId);
    } catch {}
    try {
      await attachOnce(tabId);
    } catch {
      throw new RpcError(
        RPC_ERRORS.CDP_ATTACH_FAILED,
        "another debugger is already attached to this tab \u2014 Chrome allows only one. " +
          "Close DevTools on that tab (or stop the other automation tool holding it), or drive a different tab.",
        { reason: "CDP_ATTACH_FAILED", retriable: true }
      );
    }
  }

  try {
    await sendRaw(tabId, "Emulation.setDeviceMetricsOverride", {
      width: 0,
      height: 0,
      deviceScaleFactor: 1,
      mobile: false,
    });
  } catch {}
}

/**
 * Concurrency-safe single attach per tab.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export function attachShared(tabId) {
  let pending = attaching.get(tabId);
  if (!pending) {
    pending = attach(tabId).finally(() => attaching.delete(tabId));
    attaching.set(tabId, pending);
  }
  return pending;
}

/**
 * Ensures debugger is attached and Page domain is enabled.
 * @param {number} tabId
 * @returns {Promise<{ console: Array, network: Map, domainsEnabled: boolean, fetchRules: Array }>}
 */
export async function ensureAttached(tabId) {
  if (sessions.has(tabId)) return sessions.get(tabId);
  let pending = opening.get(tabId);
  if (!pending) {
    pending = (async () => {
      await attachShared(tabId);
      try {
        await sendRaw(tabId, "Page.enable");
      } catch (err) {
        if (/not attached/i.test(err.message || "")) {
          throw new RpcError(
            RPC_ERRORS.CDP_ATTACH_FAILED,
            `the debugger detached from tab ${tabId} while attaching; try again`,
            { reason: "CDP_DETACHED_DURING_ATTACH", retriable: true }
          );
        }
      }
      sessions.set(tabId, {
        console: [],
        network: new Map(),
        domainsEnabled: false,
        fetchRules: [],
      });
      persistAttached();
    })().finally(() => opening.delete(tabId));
    opening.set(tabId, pending);
  }
  await pending;
  const s = sessions.get(tabId);
  if (!s) {
    throw new RpcError(
      RPC_ERRORS.CDP_ATTACH_FAILED,
      `the debugger detached from tab ${tabId} while attaching; try again`,
      { reason: "CDP_DETACHED_DURING_ATTACH", retriable: true }
    );
  }
  return s;
}

/**
 * Clears session record and associated state when tab is closed or detached.
 * @param {number} tabId
 */
export function dropTab(tabId) {
  sessions.delete(tabId);
  attaching.delete(tabId);
  opening.delete(tabId);
  persistAttached();
}

// Auto-detach listeners
if (typeof chrome !== "undefined" && chrome.debugger?.onDetach?.addListener) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId != null) {
      dropTab(source.tabId);
    }
  });
}

if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved?.addListener) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    dropTab(tabId);
  });
}
