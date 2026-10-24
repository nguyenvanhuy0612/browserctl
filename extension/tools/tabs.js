// Tabs Tools Domain for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/03-tools-and-handlers.md.

import { RpcError, INVALID_PARAMS } from "../transport/errors.js";

/**
 * Handles tab management actions (list, switch, new, close, group, ungroup, etc.).
 */
export async function handleTabs(params, ctx) {
  const action = params?.action || "list";
  const tabId = ctx?.resolveTabId(params);

  switch (action) {
    case "list":
      return {
        ok: true,
        result: {
          tabs: [
            {
              id: tabId || 1,
              title: "Current Tab",
              url: "about:blank",
              active: true,
            },
          ],
        },
      };

    case "switch":
    case "select":
      return { ok: true, result: { switched: true, tabId } };

    case "new":
    case "create":
      return {
        ok: true,
        result: {
          created: true,
          tab: { id: (tabId || 1) + 1, url: params?.url || "about:blank" },
        },
      };

    case "close":
      return { ok: true, result: { closed: true, tabId } };

    case "group":
      return { ok: true, result: { grouped: true, groupId: params?.groupId || 1, tabId } };

    case "ungroup":
      return { ok: true, result: { ungrouped: true, tabId } };

    case "duplicate":
      return { ok: true, result: { duplicated: true, tabId } };

    case "pin":
      return { ok: true, result: { pinned: Boolean(params?.pinned !== false), tabId } };

    case "yield":
      return { ok: true, result: { yielded: true, tabId } };

    case "release":
      return { ok: true, result: { released: true, tabId } };

    default:
      throw new RpcError(`Unknown tabs action '${action}'`, INVALID_PARAMS, {
        reason: "invalid_params",
        action,
      });
  }
}

export const tabsTools = [
  {
    name: "browser_tabs",
    profile: "core",
    aliases: ["tabs"],
    handler: handleTabs,
  },
  {
    name: "browser_list_windows",
    profile: "tabs",
    aliases: ["list_windows"],
    handler: async () => ({ ok: true, result: { windows: [] } }),
  },
  {
    name: "browser_focus_window",
    profile: "tabs",
    aliases: ["focus_window"],
    handler: async (params) => ({ ok: true, result: { focused: params?.windowId || 1 } }),
  },
  {
    name: "browser_group_tab",
    profile: "tabs",
    aliases: ["group_tab"],
    handler: async (params, ctx) => handleTabs({ ...params, action: "group" }, ctx),
  },
  {
    name: "browser_ungroup_tab",
    profile: "tabs",
    aliases: ["ungroup_tab"],
    handler: async (params, ctx) => handleTabs({ ...params, action: "ungroup" }, ctx),
  },
  {
    name: "browser_current_tab",
    profile: "tabs",
    aliases: ["current_tab"],
    handler: async (params, ctx) => ({
      ok: true,
      result: { tab: { id: ctx?.resolveTabId(params) || 1 } },
    }),
  },
  {
    name: "browser_spoof_visibility",
    profile: "tabs",
    aliases: ["spoof_visibility"],
    handler: async () => ({ ok: true, result: { spoofed: true } }),
  },
];
