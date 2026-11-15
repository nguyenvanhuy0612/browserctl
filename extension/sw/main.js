// @ts-check
// Service worker entry. Listeners are registered synchronously at top level so browser events can
// wake a stopped worker.
import { configure, connect, connectionState, emit, reconnect } from "./connection.js";
import * as debuggerRelay from "./debugger.js";
import { forwardDiagnostics, guarded, readDiagnostics } from "./diag.js";
import * as dom from "./dom.js";
import * as events from "./events.js";
import * as tabs from "./tabs.js";

async function identity() {
  const local = await chrome.storage.local.get("instanceId");
  let instanceId = local.instanceId;
  if (typeof instanceId !== "string") {
    instanceId = crypto.randomUUID();
    await chrome.storage.local.set({ instanceId });
  }
  // Session storage is cleared when the browser restarts, not when the worker does.
  const session = await chrome.storage.session.get("browserStartedAt");
  let browserStartedAt = session.browserStartedAt;
  if (typeof browserStartedAt !== "number") {
    browserStartedAt = Date.now();
    await chrome.storage.session.set({ browserStartedAt });
  }
  return { instanceId, browserStartedAt };
}

function browserInfo() {
  const ua = navigator.userAgent;
  const brands = /** @type {any} */ (navigator).userAgentData?.brands ?? [];
  const brand = brands.find((/** @type {any} */ b) => !/not.?a.?brand|chromium/i.test(b.brand))?.brand;
  const name = brand ?? (/Edg\//.test(ua) ? "Microsoft Edge" : "Chrome");
  return { name, version: /Chrom(?:e|ium)\/([\d.]+)/.exec(ua)?.[1] ?? "", userAgent: ua };
}

async function hello() {
  const { instanceId, browserStartedAt } = await identity();
  const profile = await chrome.identity?.getProfileUserInfo?.().catch(() => null);
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    instanceId,
    browserStartedAt,
    browser: browserInfo(),
    profileLabel: profile?.email || "",
    userScripts: dom.userScriptsAvailable(),
  };
}

configure(
  {
    "ext.info": async () => ({ ...(await hello()) }),
    "tabs.list": tabs.list,
    "tabs.get": tabs.get,
    "tabs.create": tabs.create,
    "tabs.navigate": tabs.navigate,
    "tabs.history": tabs.history,
    "tabs.close": tabs.close,
    "tabs.activate": tabs.activate,
    "dom.call": dom.call,
    "dom.frames": dom.frames,
    "dom.capture": dom.capture,
    "eval.user": dom.evaluate,
    "debugger.attach": debuggerRelay.attach,
    "debugger.detach": debuggerRelay.detach,
    "debugger.send": debuggerRelay.send,
    "debugger.list": debuggerRelay.list,
    "diag.read": async () => ({ entries: readDiagnostics() }),
  },
  hello,
);

forwardDiagnostics((entry) => emit("diag", entry));

// The toolbar popup (specs/extension-ui.md).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || typeof message?.type !== "string") return false;
  const answer = async () => {
    if (message.type === "bctl.reconnect") await reconnect();
    if (message.type === "bctl.setPort") {
      await chrome.storage.local.set({ daemonPort: Number(message.port) });
      await reconnect();
    }
    const { tabIds } = await debuggerRelay.list();
    return {
      ...connectionState(),
      userScripts: dom.userScriptsAvailable(),
      attachedTabs: tabIds.length,
      extensionVersion: chrome.runtime.getManifest().version,
    };
  };
  answer().then(sendResponse, (error) => sendResponse({ error: String(error?.message ?? error) }));
  return true;
});
debuggerRelay.listen();
events.listen();
chrome.alarms.create("bctl.reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(guarded("alarm", () => connect()));
chrome.runtime.onStartup.addListener(guarded("onStartup", () => connect()));
chrome.runtime.onInstalled.addListener(guarded("onInstalled", () => connect()));
connect();
