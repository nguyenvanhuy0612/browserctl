// @ts-check
// Runs `run` code in its own process with its own Playwright connection to the daemon's relay, so
// a runaway script can be killed without stopping the daemon (specs/tools/run.md). One worker
// serves a session's tabs; `state` persists between calls while this process lives.
import { chromium } from "playwright-core";

const endpoint = /** @type {string} */ (process.env.BROWSERCTL_CDP_ENDPOINT);
const AsyncFunction = /** @type {FunctionConstructor} */ (Object.getPrototypeOf(async () => {}).constructor);
/** @type {Record<string, unknown>} */
const state = {};
const connection = chromium.connectOverCDP(endpoint, { noDefaults: true });

// Errors thrown by listeners and route handlers that code registered fail the running call, or
// go to the next call's console; they never stop the worker (specs/tools/run.md).
/** @type {((error: unknown) => void) | null} */
let failRunning = null;
/** @type {string[]} */
const between = [];
/** @param {unknown} error */
function onUncaught(error) {
  if (failRunning) failRunning(error);
  else between.push(`uncaught: ${error}`);
}
process.on("uncaughtException", onUncaught);
process.on("unhandledRejection", onUncaught);

/** @type {WeakMap<import("playwright-core").Page, string>} */
const targetIds = new WeakMap();

/**
 * The page of a tab, by the target id the daemon sends with each call; a tab the relay just added
 * takes a moment to come up.
 * @param {import("playwright-core").BrowserContext} context @param {string} targetId
 */
async function pageOf(context, targetId) {
  for (let i = 0; i < 50; i++) {
    for (const page of context.pages()) {
      if (!targetIds.has(page)) {
        const session = await context.newCDPSession(page);
        targetIds.set(page, (await session.send("Target.getTargetInfo")).targetInfo.targetId);
        await session.detach().catch(() => {});
      }
      if (targetIds.get(page) === targetId) return page;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the tab did not come up in the worker");
}

/** @param {unknown} v @param {Set<unknown>} seen @param {number} depth @returns {unknown} */
function plain(v, seen = new Set(), depth = 0) {
  if (v === undefined) return null;
  if (v === null || typeof v !== "object") return typeof v === "function" ? `[function ${v.name || "anonymous"}]` : typeof v === "bigint" ? String(v) : v;
  if (seen.has(v) || depth > 20) return "[circular]";
  seen.add(v);
  if (Buffer.isBuffer(v)) return `[buffer ${v.length} bytes]`;
  if (Array.isArray(v)) return v.map((x) => plain(x, seen, depth + 1));
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Error) return { message: v.message };
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = plain(x, seen, depth + 1);
  return out;
}

process.on("message", async (/** @type {any} */ message) => {
  const lines = between.splice(0);
  const capture = { log: (/** @type {unknown[]} */ ...a) => lines.length < 200 && lines.push(a.map(String).join(" ")) };
  try {
    const browser = await connection;
    const context = browser.contexts()[0];
    const page = await pageOf(context, message.targetId);
    page.setDefaultTimeout(10_000);
    const fn = new AsyncFunction("page", "context", "state", "console", message.code);
    const work = fn(page, context, state, { ...capture, info: capture.log, warn: capture.log, error: capture.log });
    work.catch(() => {}); // an abandoned call's late rejection is not news
    const uncaught = new Promise((_, reject) => {
      failRunning = (error) => reject(new Error(`uncaught in a listener or route handler: ${error}`));
    });
    const value = await Promise.race([work, uncaught]);
    process.send?.({ id: message.id, ok: true, value: plain(value), console: lines });
  } catch (error) {
    const e = /** @type {any} */ (error);
    const where = /<anonymous>:(\d+)/.exec(String(e?.stack ?? ""));
    process.send?.({ id: message.id, ok: false, error: `${e?.message ?? e}${where ? ` (line ${Number(where[1]) - 2} of code)` : ""}`, console: lines });
  } finally {
    failRunning = null;
  }
});
