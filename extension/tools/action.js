// Action Tools Domain for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/03-tools-and-handlers.md.

import { RpcError, INVALID_PARAMS } from "../transport/errors.js";

/**
 * Handles element click action.
 */
export async function handleClick(params, ctx) {
  if (!params || (!params.target && params.x == null && params.y == null)) {
    throw new RpcError("click requires 'target' or coordinates (x, y)", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.contentBridge) {
    return await ctx.contentBridge.send("click", params, tabId);
  }
  return { ok: true, result: { clicked: params.target || `${params.x},${params.y}`, tabId } };
}

/**
 * Handles form fill action.
 */
export async function handleFillForm(params, ctx) {
  if (!params || (!Array.isArray(params.fields) && !params.elements && !params.target)) {
    throw new RpcError("fill_form requires 'fields' array or 'elements'", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.contentBridge) {
    return await ctx.contentBridge.send("fill_form", params, tabId);
  }
  return { ok: true, result: { filled: true, tabId } };
}

/**
 * Handles text typing action.
 */
export async function handleType(params, ctx) {
  if (!params || params.text == null) {
    throw new RpcError("type requires 'text' parameter", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.contentBridge) {
    return await ctx.contentBridge.send("type", params, tabId);
  }
  return { ok: true, result: { typed: params.text, tabId } };
}

/**
 * Handles mouse hover action.
 */
export async function handleHover(params, ctx) {
  if (!params || (!params.target && params.x == null && params.y == null)) {
    throw new RpcError("hover requires 'target' or coordinates (x, y)", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.contentBridge) {
    return await ctx.contentBridge.send("hover", params, tabId);
  }
  return { ok: true, result: { hovered: params.target || `${params.x},${params.y}`, tabId } };
}

/**
 * Handles keyboard key press action.
 */
export async function handlePressKey(params, ctx) {
  if (!params || !params.key) {
    throw new RpcError("press_key requires 'key' parameter", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.driver && Array.isArray(params.modifiers) && params.modifiers.length) {
    return await ctx.driver.sendCdpCommand(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: params.key,
    });
  }
  if (ctx?.contentBridge) {
    return await ctx.contentBridge.send("press_key", params, tabId);
  }
  return { ok: true, result: { pressed: params.key, tabId } };
}

/**
 * Handles select option action.
 */
export async function handleSelectOption(params, ctx) {
  if (!params || (!params.target && !params.selector)) {
    throw new RpcError("select_option requires 'target' select element", INVALID_PARAMS, {
      reason: "invalid_params",
    });
  }
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.contentBridge) {
    return await ctx.contentBridge.send("select_option", params, tabId);
  }
  return { ok: true, result: { selected: params.value || params.option || true, tabId } };
}

/**
 * Handles mouse wheel scroll action.
 */
export async function handleWheel(params, ctx) {
  const tabId = ctx?.resolveTabId(params);
  const deltaX = Number(params?.deltaX) || 0;
  const deltaY = Number(params?.deltaY) || 0;
  if (ctx?.driver) {
    return await ctx.driver.wheel(tabId, { ...params, deltaX, deltaY });
  }
  return { ok: true, result: { scrolled: true, deltaX, deltaY, tabId } };
}

/**
 * Handles mouse drag and drop action.
 */
export async function handleDrag(params, ctx) {
  if (
    !params ||
    ((params.fromX == null || params.fromY == null || params.toX == null || params.toY == null) &&
      (!params.source || !params.target))
  ) {
    throw new RpcError(
      "drag requires both source (or fromX, fromY) and target (or toX, toY)",
      INVALID_PARAMS,
      { reason: "invalid_params" }
    );
  }
  const tabId = ctx?.resolveTabId(params);
  if (ctx?.driver && params.fromX != null && params.toX != null) {
    return await ctx.driver.coordinate_drag(tabId, params);
  }
  return { ok: true, result: { dragged: true, tabId } };
}

export const actionTools = [
  {
    name: "browser_click",
    profile: "core",
    aliases: ["click"],
    schema: { required: ["target"] },
    handler: handleClick,
  },
  {
    name: "browser_fill_form",
    profile: "core",
    aliases: ["fill_form"],
    schema: { required: ["fields"] },
    handler: handleFillForm,
  },
  {
    name: "browser_type",
    profile: "core",
    aliases: ["type"],
    schema: { required: ["text"] },
    handler: handleType,
  },
  {
    name: "browser_hover",
    profile: "core",
    aliases: ["hover"],
    schema: { required: ["target"] },
    handler: handleHover,
  },
  {
    name: "browser_press_key",
    profile: "core",
    aliases: ["press_key"],
    schema: { required: ["key"] },
    handler: handlePressKey,
  },
  {
    name: "browser_select_option",
    profile: "core",
    aliases: ["select_option"],
    schema: { required: ["target"] },
    handler: handleSelectOption,
  },
  {
    name: "browser_wheel",
    profile: "advanced",
    aliases: ["wheel"],
    handler: handleWheel,
  },
  {
    name: "browser_drag",
    profile: "advanced",
    aliases: ["drag"],
    handler: handleDrag,
  },
];
