// Navigation Tools Domain for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/03-tools-and-handlers.md.

import { RpcError, INVALID_PARAMS } from "../transport/errors.js";

/**
 * Handles navigation to a URL.
 */
export async function handleNavigate(params, ctx) {
  if (!params || !params.url) {
    throw new RpcError("navigate requires 'url' parameter", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.driver) {
    return await ctx.driver.sendCdpCommand(tabId, "Page.navigate", { url: params.url });
  }
  return { ok: true, result: { navigated: params.url, tabId } };
}

/**
 * Handles waiting for condition, selector, or timeout.
 */
export async function handleWaitFor(params, ctx) {
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.contentBridge) {
    return await ctx.contentBridge.send("wait_for", params, tabId);
  }
  return { ok: true, result: { waited: true, tabId } };
}

/**
 * Handles page reload.
 */
export async function handleReload(params, ctx) {
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.driver) {
    return await ctx.driver.sendCdpCommand(tabId, "Page.reload", {
      ignoreCache: Boolean(params?.ignoreCache),
    });
  }
  return { ok: true, result: { reloaded: true, tabId } };
}

/**
 * Handles history back.
 */
export async function handleGoBack(params, ctx) {
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.driver) {
    return await ctx.driver.sendCdpCommand(tabId, "Page.navigate", { historyOffset: -1 });
  }
  return { ok: true, result: { back: true, tabId } };
}

/**
 * Handles history forward.
 */
export async function handleGoForward(params, ctx) {
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.driver) {
    return await ctx.driver.sendCdpCommand(tabId, "Page.navigate", { historyOffset: 1 });
  }
  return { ok: true, result: { forward: true, tabId } };
}

export const navigateTools = [
  {
    name: "browser_navigate",
    profile: "core",
    aliases: ["navigate", "reload", "browser_reload"],
    schema: { required: ["url"] },
    handler: handleNavigate,
  },
  {
    name: "browser_wait_for",
    profile: "core",
    aliases: ["wait_for"],
    handler: handleWaitFor,
  },
  {
    name: "browser_go_back",
    profile: "advanced",
    aliases: ["go_back", "history_back", "browser_history_back"],
    handler: handleGoBack,
  },
  {
    name: "browser_go_forward",
    profile: "advanced",
    aliases: ["go_forward", "history_forward", "browser_history_forward"],
    handler: handleGoForward,
  },
];
