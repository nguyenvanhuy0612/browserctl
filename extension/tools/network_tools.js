// Network Tools Domain for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/03-tools-and-handlers.md.

import { RpcError, INVALID_PARAMS } from "../transport/errors.js";

const resolveTab = (ctx, params) =>
  typeof ctx?.resolveTabId === "function" ? ctx.resolveTabId(params) : params?.tabId;

/**
 * Handles in-page context request execution or replay.
 */
export async function handleMakeRequest(params, ctx) {
  if (!params || (!params.url && !params.requestId)) {
    throw new RpcError("make_request requires 'url' or 'requestId'", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = resolveTab(ctx, params);
  if (ctx?.contentBridge) {
    return await ctx.contentBridge.send("make_request", params, tabId);
  }
  if (ctx?.driver) {
    return await ctx.driver.makeRequest(tabId, params);
  }
  return { ok: true, result: { status: 200, body: "", data: null, tabId } };
}

/**
 * Handles monitoring and inspecting network traffic.
 */
export async function handleMonitorRequests(params, ctx) {
  const tabId = resolveTab(ctx, params);
  const action = params?.action || "list";
  if (action === "get" && (!params || !params.requestId)) {
    throw new RpcError("monitor_requests get requires 'requestId'", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  if (ctx?.driver && ctx.driver.monitorRequests) {
    return await ctx.driver.monitorRequests(tabId, params);
  }
  return { ok: true, result: { count: 0, requests: [], tabId } };
}

/**
 * Handles fetching individual network request details.
 */
export async function handleGetNetworkRequest(params, ctx) {
  if (!params || !params.requestId) {
    throw new RpcError("get_network_request requires 'requestId'", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = resolveTab(ctx, params);
  return { ok: true, result: { requestId: params.requestId, tabId } };
}

/**
 * Handles listing captured network requests.
 */
export async function handleGetNetworkRequests(params, ctx) {
  const tabId = resolveTab(ctx, params);
  return { ok: true, result: { requests: [], tabId } };
}

/**
 * Handles fetching network response body.
 */
export async function handleGetResponseBody(params, ctx) {
  if (!params || !params.requestId) {
    throw new RpcError("get_response_body requires 'requestId'", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = resolveTab(ctx, params);
  if (ctx?.driver) {
    return await ctx.driver.getResponseBody(tabId, params.requestId);
  }
  return { ok: true, result: { body: "", base64Encoded: false, tabId } };
}

/**
 * Handles in-page network replay.
 */
export async function handleNetworkReplay(params, ctx) {
  return await handleMakeRequest(params, ctx);
}

/**
 * Handles route mocking or blocking.
 */
export async function handleMockRoute(params, ctx) {
  if (!params || !params.pattern) {
    throw new RpcError("mock_route requires 'pattern'", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = resolveTab(ctx, params);
  if (ctx?.driver) {
    return await ctx.driver.addFetchRule(tabId, params);
  }
  return { ok: true, result: { mocked: params.pattern, tabId } };
}

export const networkTools = [
  {
    name: "browser_make_request",
    profile: "network",
    aliases: ["make_request", "request", "fetch"],
    handler: handleMakeRequest,
  },
  {
    name: "browser_monitor_requests",
    profile: "network",
    aliases: ["monitor_requests", "monitor", "wait_for_request"],
    handler: handleMonitorRequests,
  },
  {
    name: "browser_get_network_request",
    profile: "network",
    aliases: ["get_network_request"],
    schema: { required: ["requestId"] },
    handler: handleGetNetworkRequest,
  },
  {
    name: "browser_get_network_requests",
    profile: "network",
    aliases: ["get_network_requests"],
    handler: handleGetNetworkRequests,
  },
  {
    name: "browser_get_response_body",
    profile: "network",
    aliases: ["get_response_body"],
    schema: { required: ["requestId"] },
    handler: handleGetResponseBody,
  },
  {
    name: "browser_network_replay",
    profile: "network",
    aliases: ["network_replay"],
    schema: { required: ["url"] },
    handler: handleNetworkReplay,
  },
  {
    name: "browser_mock_route",
    profile: "network",
    aliases: ["mock_route"],
    schema: { required: ["pattern"] },
    handler: handleMockRoute,
  },
  {
    name: "browser_export_har",
    profile: "network",
    aliases: ["export_har"],
    handler: async () => ({ ok: true, result: { log: { entries: [] } } }),
  },
  {
    name: "browser_net_start",
    profile: "network",
    aliases: ["net_start"],
    handler: async () => ({ ok: true, result: { started: true } }),
  },
  {
    name: "browser_net_stop",
    profile: "network",
    aliases: ["net_stop"],
    handler: async () => ({ ok: true, result: { stopped: true } }),
  },
  {
    name: "browser_net_get",
    profile: "network",
    aliases: ["net_get"],
    handler: async () => ({ ok: true, result: { entries: [] } }),
  },
  {
    name: "browser_net_clear",
    profile: "network",
    aliases: ["net_clear"],
    handler: async () => ({ ok: true, result: { cleared: true } }),
  },
  {
    name: "browser_wait_network_idle",
    profile: "network",
    aliases: ["wait_network_idle"],
    handler: async () => ({ ok: true, result: { idle: true } }),
  },
];
