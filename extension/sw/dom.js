// @ts-check
// DOM lane plumbing in the service worker: injects the runtime into frames and calls its
// operations; runs evaluate through chrome.userScripts; captures the visible tab. Nothing here
// touches chrome.debugger (specs/dom-lane.md).
import { note } from "./diag.js";

const RUNTIME_FILES = ["generated/pw-injected.js", "runtime/runtime.js"];
const CAPTURE_SPACING_MS = 550;

/** @param {unknown} error */
function scriptingError(error) {
  const message = String(/** @type {any} */ (error)?.message ?? error);
  let code = "SCRIPTING_ERROR";
  if (/no tab with/i.test(message)) code = "TAB_CLOSED";
  else if (/no frame with/i.test(message)) code = "FRAME_GONE";
  else if (/cannot access|cannot be scripted|chrome:\/\/|error page|extensions gallery|devtools:/i.test(message)) code = "PAGE_UNSCRIPTABLE";
  return Object.assign(new Error(message), { code });
}

/** @param {number} tabId @param {number} frameId */
async function initFrame(tabId, frameId) {
  const target = { tabId, frameIds: [frameId] };
  await chrome.scripting.executeScript({ target, world: "ISOLATED", files: RUNTIME_FILES });
  await chrome.scripting.executeScript({
    target,
    world: "ISOLATED",
    func: (id) => /** @type {any} */ (globalThis).__bctlRuntime.init(id),
    args: [frameId],
  });
}

/**
 * @param {number} tabId
 * @param {{frameIds?: number[], allFrames?: boolean}} where
 * @param {string} op
 * @param {unknown[]} args
 */
async function run(tabId, where, op, args) {
  const target = where.allFrames ? { tabId, allFrames: true } : { tabId, frameIds: where.frameIds ?? [0] };
  const results = await chrome.scripting.executeScript({
    target,
    world: "ISOLATED",
    func: (name, params) => {
      const runtime = /** @type {any} */ (globalThis).__bctlRuntime;
      if (!runtime || !runtime.ready) return { ok: false, code: "RUNTIME_MISSING" };
      return runtime.call(name, params);
    },
    args: [op, args],
  });
  return results.map((r) => ({ frameId: r.frameId, result: /** @type {any} */ (r.result) }));
}

/**
 * Runs a runtime operation in one frame (default the main frame) or in every frame. Frames
 * without the runtime get it injected and the call is repeated there.
 * @param {{tabId: number, frameId?: number, allFrames?: boolean, op: string, args?: unknown[]}} params
 */
export async function call({ tabId, frameId, allFrames, op, args = [] }) {
  try {
    const where = allFrames ? { allFrames: true } : { frameIds: [frameId ?? 0] };
    let results = await run(tabId, where, op, args);
    const missing = results.filter((r) => r.result?.code === "RUNTIME_MISSING").map((r) => r.frameId);
    if (missing.length) {
      for (const id of missing) {
        try {
          await initFrame(tabId, id);
        } catch (error) {
          if (!allFrames) throw error;
          note("dom.initFrame", error);
        }
      }
      const again = await run(tabId, { frameIds: missing }, op, args);
      results = results.filter((r) => !missing.includes(r.frameId)).concat(again);
    }
    if (allFrames) return { frames: results.filter((r) => r.result?.code !== "RUNTIME_MISSING") };
    return results[0]?.result ?? { ok: false, code: "RUNTIME_MISSING" };
  } catch (error) {
    throw scriptingError(error);
  }
}

/** @param {{tabId: number}} params */
export async function frames({ tabId }) {
  const list = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  return { frames: list.map((f) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url, errorOccurred: f.errorOccurred })) };
}

export function userScriptsAvailable() {
  try {
    return typeof chrome.userScripts?.execute === "function";
  } catch {
    return false;
  }
}

/** @param {{tabId: number, frameId?: number, code: string}} params */
export async function evaluate({ tabId, frameId, code }) {
  if (!userScriptsAvailable()) {
    throw Object.assign(new Error("chrome.userScripts is unavailable: turn on 'Allow User Scripts' in the extension's details"), {
      code: "USER_SCRIPTS_OFF",
    });
  }
  try {
    const [result] = await /** @type {any} */ (chrome.userScripts).execute({
      target: { tabId, frameIds: [frameId ?? 0] },
      world: "MAIN",
      injectImmediately: true,
      js: [{ code }],
    });
    if (result?.error) return { ok: false, code: "EVAL_ERROR", message: String(result.error) };
    return { ok: true, value: result?.result };
  } catch (error) {
    throw scriptingError(error);
  }
}

let lastCapture = 0;

/** @param {Blob} blob */
async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Screenshot of a window's visible tab, optionally cropped (CSS pixels times devicePixelRatio).
 * @param {{windowId: number, format?: "png" | "jpeg", quality?: number, crop?: {x: number, y: number, width: number, height: number, scale: number}}} params
 */
export async function capture({ windowId, format = "jpeg", quality = 80, crop }) {
  const wait = lastCapture + CAPTURE_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCapture = Date.now();
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format, quality });
  const image = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const box = crop
    ? {
        x: Math.max(0, Math.round(crop.x * crop.scale)),
        y: Math.max(0, Math.round(crop.y * crop.scale)),
        width: Math.round(crop.width * crop.scale),
        height: Math.round(crop.height * crop.scale),
      }
    : { x: 0, y: 0, width: image.width, height: image.height };
  box.width = Math.max(1, Math.min(box.width, image.width - box.x));
  box.height = Math.max(1, Math.min(box.height, image.height - box.y));
  const canvas = new OffscreenCanvas(box.width, box.height);
  const context = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext("2d"));
  context.drawImage(image, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  const blob = await canvas.convertToBlob({ type: format === "png" ? "image/png" : "image/jpeg", quality: quality / 100 });
  return { base64: await toBase64(blob), width: box.width, height: box.height, format };
}
