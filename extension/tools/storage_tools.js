// Storage and Cookies Tools Domain for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/03-tools-and-handlers.md.

import { RpcError, INVALID_PARAMS } from "../transport/errors.js";

/**
 * Handles getting cookies.
 */
export async function handleGetCookies(params, ctx) {
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.driver) {
    return await ctx.driver.sendCdpCommand(tabId, "Network.getCookies", {
      urls: params?.urls || (params?.url ? [params.url] : undefined),
    });
  }
  return { ok: true, result: { cookies: [], tabId } };
}

/**
 * Handles setting cookie.
 */
export async function handleSetCookie(params, ctx) {
  if (!params || !params.name || params.value == null) {
    throw new RpcError("set_cookie requires 'name' and 'value'", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.driver) {
    return await ctx.driver.sendCdpCommand(tabId, "Network.setCookie", params);
  }
  return { ok: true, result: { success: true, tabId } };
}

/**
 * Handles deleting cookies.
 */
export async function handleDeleteCookies(params, ctx) {
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.driver) {
    return await ctx.driver.sendCdpCommand(tabId, "Network.clearBrowserCookies");
  }
  return { ok: true, result: { cleared: true, tabId } };
}

/**
 * Handles localStorage get.
 */
export async function handleStorageGet(params, ctx) {
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.contentBridge) {
    return await ctx.contentBridge.send("storage_get", params, tabId);
  }
  return { ok: true, result: { value: null, tabId } };
}

/**
 * Handles localStorage set.
 */
export async function handleStorageSet(params, ctx) {
  if (!params || !params.key || params.value == null) {
    throw new RpcError("storage_set requires 'key' and 'value'", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.contentBridge) {
    return await ctx.contentBridge.send("storage_set", params, tabId);
  }
  return { ok: true, result: { success: true, tabId } };
}

/**
 * Handles localStorage remove.
 */
export async function handleStorageRemove(params, ctx) {
  if (!params || !params.key) {
    throw new RpcError("storage_remove requires 'key'", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.contentBridge) {
    return await ctx.contentBridge.send("storage_remove", params, tabId);
  }
  return { ok: true, result: { removed: true, tabId } };
}

/**
 * Handles localStorage clear.
 */
export async function handleStorageClear(params, ctx) {
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.contentBridge) {
    return await ctx.contentBridge.send("storage_clear", params, tabId);
  }
  return { ok: true, result: { cleared: true, tabId } };
}

export const storageTools = [
  {
    name: "browser_get_cookies",
    profile: "cookies",
    aliases: ["get_cookies", "cookies_get"],
    handler: handleGetCookies,
  },
  {
    name: "browser_set_cookie",
    profile: "cookies",
    aliases: ["set_cookie", "cookies_set"],
    schema: { required: ["name", "value"] },
    handler: handleSetCookie,
  },
  {
    name: "browser_delete_cookies",
    profile: "cookies",
    aliases: ["delete_cookies", "cookies_clear"],
    handler: handleDeleteCookies,
  },
  {
    name: "browser_storage_get",
    profile: "storage",
    aliases: ["storage_get", "local_storage_get"],
    handler: handleStorageGet,
  },
  {
    name: "browser_storage_set",
    profile: "storage",
    aliases: ["storage_set", "local_storage_set"],
    schema: { required: ["key", "value"] },
    handler: handleStorageSet,
  },
  {
    name: "browser_storage_remove",
    profile: "storage",
    aliases: ["storage_remove", "local_storage_remove"],
    schema: { required: ["key"] },
    handler: handleStorageRemove,
  },
  {
    name: "browser_storage_clear",
    profile: "storage",
    aliases: ["storage_clear", "local_storage_clear"],
    handler: handleStorageClear,
  },
];
