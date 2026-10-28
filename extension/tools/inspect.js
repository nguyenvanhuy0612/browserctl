// Inspection Tools Domain for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/03-tools-and-handlers.md.

import { RpcError, INVALID_PARAMS } from "../transport/errors.js";
import { csv_safe } from "../content/table.js";

/**
 * Handles DOM snapshot (census or VOM format).
 */
export async function handleSnapshot(params, ctx) {
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.contentBridge) {
    return await ctx.contentBridge.send("snapshot", params, tabId);
  }
  return { ok: true, result: { census: "", tabId } };
}

/**
 * Handles element finding.
 */
export async function handleFind(params, ctx) {
  if (!params || (!params.query && !params.selector && !params.text)) {
    throw new RpcError("find requires 'query', 'selector', or 'text'", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.contentBridge) {
    return await ctx.contentBridge.send("find", params, tabId);
  }
  return { ok: true, result: { matches: [], count: 0, tabId } };
}

/**
 * Handles reading page structure and accessibility tree.
 */
export async function handleReadPage(params, ctx) {
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.contentBridge) {
    return await ctx.contentBridge.send("read_page", params, tabId);
  }
  return { ok: true, result: { tree: "", tabId } };
}

/**
 * Handles getting page HTML or text content.
 */
export async function handleGetContent(params, ctx) {
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.contentBridge) {
    return await ctx.contentBridge.send("get_page_content", params, tabId);
  }
  return { ok: true, result: { content: "", tabId } };
}

/**
 * Handles reading element properties or attributes.
 */
export async function handleGetProperty(params, ctx) {
  if (!params || (!params.target && !params.selector)) {
    throw new RpcError("get_property requires 'target' or 'selector'", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.contentBridge) {
    return await ctx.contentBridge.send("get_property", params, tabId);
  }
  return { ok: true, result: { value: null, tabId } };
}

/**
 * Handles structured table and list extraction with csv_safe injection guard.
 */
export async function handleExtract(params, ctx) {
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.contentBridge) {
    const res = await ctx.contentBridge.send("extract", params, tabId);
    if (res && res.result && Array.isArray(res.result.rows)) {
      res.result.rows = res.result.rows.map((row) =>
        Array.isArray(row) ? row.map((cell) => csv_safe(cell)) : row
      );
    }
    return res;
  }
  return { ok: true, result: { rows: [], tabId } };
}

/**
 * Handles JavaScript evaluation.
 */
export async function handleEvaluate(params, ctx) {
  if (!params || (!params.script && !params.expression)) {
    throw new RpcError("evaluate requires 'script' or 'expression'", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = ctx?.resolveTabId(params);
  const expression = params.script || params.expression;
  if (ctx?.driver) {
    return await ctx.driver.sendCdpCommand(tabId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
  }
  return { ok: true, result: { value: null, tabId } };
}

/**
 * Handles taking screenshot.
 */
export async function handleTakeScreenshot(params, ctx) {
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.driver) {
    return await ctx.driver.sendCdpCommand(tabId, "Page.captureScreenshot", {
      format: params?.format || "png",
      quality: params?.quality,
    });
  }
  return { ok: true, result: { data: "", format: "png", tabId } };
}

export const inspectTools = [
  {
    name: "browser_snapshot",
    profile: "core",
    aliases: ["snapshot"],
    handler: handleSnapshot,
  },
  {
    name: "browser_find",
    profile: "advanced",
    aliases: ["find"],
    handler: handleFind,
  },
  {
    name: "browser_read_page",
    profile: "advanced",
    aliases: ["read_page"],
    handler: handleReadPage,
  },
  {
    name: "browser_get_content",
    profile: "advanced",
    aliases: ["get_content", "get_page_content"],
    handler: handleGetContent,
  },
  {
    name: "browser_get_property",
    profile: "advanced",
    aliases: ["get_property"],
    schema: { required: ["target"] },
    handler: handleGetProperty,
  },
  {
    name: "browser_extract",
    profile: "core",
    aliases: ["extract"],
    handler: handleExtract,
  },
  {
    name: "browser_evaluate",
    profile: "core",
    aliases: ["evaluate", "eval"],
    handler: handleEvaluate,
  },
  {
    name: "browser_take_screenshot",
    profile: "core",
    aliases: ["take_screenshot", "screenshot"],
    handler: handleTakeScreenshot,
  },
];
