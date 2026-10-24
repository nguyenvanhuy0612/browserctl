// Native Input Dispatcher for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/02-driver-and-cdp.md.

import { sendCdpCommand } from "./session.js";

export const MOD_BITS = Object.freeze({
  alt: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  command: 4,
  cmd: 4,
  shift: 8,
});

export const NAMED_VK = Object.freeze({
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  " ": 32,
});

export const NAMED_CODE = Object.freeze({
  " ": "Space",
  Escape: "Escape",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
});

const IS_MAC = /Mac/i.test((globalThis.navigator && navigator.userAgent) || "");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Computes a bitmask for an array of modifier names or number.
 * @param {Array<string>|number} mods
 * @returns {number}
 */
export function modMask(mods) {
  if (typeof mods === "number") return mods;
  let m = 0;
  for (const x of mods || []) {
    m |= MOD_BITS[String(x).toLowerCase()] || 0;
  }
  return m;
}

/**
 * Returns Windows virtual key code for key.
 * @param {string} key
 * @returns {number}
 */
export function vkOf(key) {
  if (!key) return 0;
  return key.length === 1 ? key.toUpperCase().charCodeAt(0) : NAMED_VK[key] || 0;
}

/**
 * Returns DOM code string for key.
 * @param {string} key
 * @returns {string|undefined}
 */
export function codeOf(key) {
  if (!key) return undefined;
  if (NAMED_CODE[key]) return NAMED_CODE[key];
  if (key.length === 1) {
    if (/[a-z]/i.test(key)) return "Key" + key.toUpperCase();
    if (/[0-9]/.test(key)) return "Digit" + key;
  }
  return undefined;
}

/**
 * Computes Mac-specific editing commands for Cmd key combinations.
 * @param {string} key
 * @param {Array<string>} mods
 * @returns {Array<string>}
 */
export function macCommands(key, mods) {
  if (!IS_MAC) return [];
  const set = new Set((mods || []).map((x) => String(x).toLowerCase()));
  if (!(set.has("meta") || set.has("command") || set.has("cmd"))) return [];
  const k = (key || "").toLowerCase();
  const shift = set.has("shift");
  if (k === "a") return ["selectAll"];
  if (k === "z") return shift ? ["redo"] : ["undo"];
  if (k === "c") return ["copy"];
  if (k === "v") return ["paste"];
  if (k === "x") return ["cut"];
  return [];
}

/**
 * Dispatches a native mouse event via CDP Input.dispatchMouseEvent.
 *
 * @param {number} tabId
 * @param {object} params
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<any>}
 */
export async function dispatchMouseEvent(tabId, params, timeoutMs = 10000) {
  return sendCdpCommand(tabId, "Input.dispatchMouseEvent", params, timeoutMs);
}

/**
 * Dispatches hardware mouse wheel event via CDP Input.dispatchMouseEvent.
 *
 * @param {number} tabId
 * @param {object} options
 * @param {number} [options.x=0]
 * @param {number} [options.y=0]
 * @param {number} [options.deltaX=0]
 * @param {number} [options.deltaY=0]
 * @param {Array<string>|number} [options.modifiers=0]
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<any>}
 */
export async function dispatchMouseWheel(
  tabId,
  { x = 0, y = 0, deltaX = 0, deltaY = 0, modifiers = 0 },
  timeoutMs = 10000
) {
  const modBits = modMask(modifiers);
  return sendCdpCommand(
    tabId,
    "Input.dispatchMouseEvent",
    {
      type: "mouseWheel",
      x: Math.round(x),
      y: Math.round(y),
      deltaX: Math.round(deltaX),
      deltaY: Math.round(deltaY),
      modifiers: modBits,
    },
    timeoutMs
  );
}

/**
 * Performs multi-step hardware mouse interpolation from source (fromX, fromY)
 * to destination (toX, toY).
 *
 * Supports both positional arguments:
 *   coordinate_drag(tabId, fromX, fromY, toX, toY, steps, sendFn)
 * and options object:
 *   coordinate_drag(tabId, { fromX, fromY, toX, toY, steps }, sendFn)
 *
 * @param {number} tabId
 * @param {number|object} fromX
 * @param {number} [fromY]
 * @param {number} [toX]
 * @param {number} [toY]
 * @param {number} [steps=5]
 * @param {function} [sendFn]
 * @returns {Promise<{ ok: boolean, result: { dragged: boolean } }>}
 */
export async function coordinate_drag(tabId, fromX, fromY, toX, toY, steps = 5, sendFn = null) {
  if (typeof fromX === "object" && fromX !== null) {
    const opts = fromX;
    sendFn = fromY || sendFn;
    steps = opts.steps ?? 5;
    toY = opts.toY;
    toX = opts.toX;
    fromY = opts.fromY;
    fromX = opts.fromX;
  }

  const send = sendFn || ((method, params) => sendCdpCommand(tabId, method, params));

  // 1. Move to initial position
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: fromX, y: fromY });

  // 2. Press left button
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: fromX,
    y: fromY,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await pause(15);

  // 3. Smooth intermediate interpolation steps
  const count = Math.max(2, Math.min(steps, 20));
  for (let i = 1; i < count; i++) {
    const progress = i / count;
    const curX = Math.round(fromX + (toX - fromX) * progress);
    const curY = Math.round(fromY + (toY - fromY) * progress);
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: curX,
      y: curY,
      button: "left",
      buttons: 1,
    });
    await pause(15);
  }

  // 4. Move to final target
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: toX,
    y: toY,
    button: "left",
    buttons: 1,
  });
  await pause(15);

  // 5. Release left button
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: toX,
    y: toY,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });

  return { ok: true, result: { dragged: true } };
}

export const dispatchDrag = coordinate_drag;
export const drag = coordinate_drag;
export const wheel = dispatchMouseWheel;

/**
 * Dispatches a native keyboard event via CDP Input.dispatchKeyEvent.
 *
 * @param {number} tabId
 * @param {object} params
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<any>}
 */
export async function dispatchKeyEvent(tabId, params, timeoutMs = 10000) {
  const modifiers = modMask(params.modifiers);
  const key = params.key;
  const commands = params.commands || (key ? macCommands(key, params.modifiers) : []);
  const evt = {
    type: params.type || "keyDown",
    key,
    code: params.code || codeOf(key),
    windowsVirtualKeyCode: params.windowsVirtualKeyCode ?? vkOf(key),
    nativeVirtualKeyCode: params.nativeVirtualKeyCode ?? vkOf(key),
    modifiers,
    ...(commands.length ? { commands } : {}),
    ...(params.text ? { text: params.text } : {}),
    ...(params.unmodifiedText ? { unmodifiedText: params.unmodifiedText } : {}),
  };
  return sendCdpCommand(tabId, "Input.dispatchKeyEvent", evt, timeoutMs);
}
