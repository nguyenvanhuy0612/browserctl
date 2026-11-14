// @ts-check
// chrome.debugger relay for the CDP lane. The extension only attaches, detaches and forwards; the
// daemon decides when (specs/relay.md). Attachments are remembered in session storage because they
// survive a service-worker restart.
import { emit } from "./connection.js";
import { guarded, note } from "./diag.js";

const KEY = "bctl.attached";
const INPUT_TIMEOUT_MS = 5000;

/** @type {Set<number> | null} */
let attached = null;
/** @type {Map<number, Promise<unknown>>} */
const inputQueues = new Map();

async function load() {
  if (attached) return attached;
  try {
    const stored = (await chrome.storage.session.get(KEY))[KEY];
    attached = new Set(Array.isArray(stored) ? stored : []);
  } catch (error) {
    note("debugger.load", error);
    attached = new Set();
  }
  return attached;
}

async function save() {
  try {
    await chrome.storage.session.set({ [KEY]: [...(attached ?? [])] });
  } catch (error) {
    note("debugger.save", error);
  }
}

/** @param {unknown} error */
function classify(error) {
  const message = String(/** @type {any} */ (error)?.message ?? error);
  if (/another debugger is already attached/i.test(message)) return Object.assign(new Error(message), { code: "DEBUGGER_BUSY" });
  if (/no tab with/i.test(message)) return Object.assign(new Error(message), { code: "TAB_CLOSED" });
  if (/cannot (access|attach)|chrome:\/\/|extensions gallery/i.test(message)) {
    return Object.assign(new Error(message), { code: "PAGE_UNSCRIPTABLE" });
  }
  return Object.assign(new Error(message), { code: "DEBUGGER_ERROR" });
}

/** @param {{tabId: number}} params */
export async function attach({ tabId }) {
  const set = await load();
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    throw classify(error);
  }
  set.add(tabId);
  await save();
  const { targetInfo } = /** @type {any} */ (await chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo"));
  return { targetInfo };
}

/** @param {{tabId: number}} params */
export async function detach({ tabId }) {
  const set = await load();
  set.delete(tabId);
  inputQueues.delete(tabId);
  await save();
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already detached or the tab closed: the goal state is reached either way.
  }
  return {};
}

export async function list() {
  return { tabIds: [...(await load())] };
}

/** @param {{tabId: number, sessionId?: string, method: string, params?: object}} params */
export async function send({ tabId, sessionId, method, params }) {
  const run = async () => {
    try {
      return (await chrome.debugger.sendCommand({ tabId, sessionId }, method, params ?? {})) ?? {};
    } catch (error) {
      const message = String(/** @type {any} */ (error)?.message ?? error);
      throw Object.assign(new Error(message), { code: /not attached/i.test(message) ? "NOT_ATTACHED" : "CDP_ERROR" });
    }
  };
  if (!method.startsWith("Input.")) return run();
  // Input commands go one at a time per tab, each bounded: a hidden tab can leave one unanswered.
  const previous = inputQueues.get(tabId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() =>
    Promise.race([
      run(),
      new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error(`${method} timed out`), { code: "INPUT_TIMEOUT" })), INPUT_TIMEOUT_MS),
      ),
    ]),
  );
  inputQueues.set(tabId, next);
  return next;
}

export function listen() {
  chrome.debugger.onEvent.addListener(
    guarded("debugger.onEvent", (source, method, params) => {
      emit("debugger.event", { tabId: source.tabId, sessionId: /** @type {any} */ (source).sessionId, method, params });
    }),
  );
  chrome.debugger.onDetach.addListener(
    guarded("debugger.onDetach", async (source, reason) => {
      const set = await load();
      if (source.tabId !== undefined) set.delete(source.tabId);
      await save();
      emit("debugger.detached", { tabId: source.tabId, reason });
    }),
  );
}
