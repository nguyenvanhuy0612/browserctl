# Safe MCP Tool Consolidation Plan

**Goal:** Reduce the registered MCP tool surface in `mcp/index.js` from 79 to 48 tools while keeping `TOOL_CATEGORIES.core` (20 tools), `browser_load_tools`, `cli.js`, and all `extension/background.js` protocol actions intact.

**Architecture:**

- MCP-only consolidation in `mcp/index.js`: duplicate/overlapping tools are removed from `TOOL_CATEGORIES` and `server.registerTool(...)`, and CRUD/state/window/CDP tool clusters are merged into single `action`-dispatched MCP tools.
- Underlying protocol actions in `extension/background.js` and `cli.js` commands remain unchanged so E2E harnesses, unit tests targeting the bridge/driver, and `browser_action({action, params})` continue working without breaking edits in the extension runtime.
- Docs (`docs/REFERENCE.md`, `README.md`, `docs/TOOLS.md` generated via `npm run preflight -- --fix`) and unit assertions in `tests/unit/cli_and_mcp.test.mjs` are updated in lockstep per batch.

## Global Constraints

- Follow `AGENTS.md`: no MCP legacy alias shims (`no live pointer to a removed tool` preflight gate), comments describe code not history (`local/comments-describe-the-code`), and never hand-edit `docs/TOOLS.md`.
- Keep `AGENT_TEXT_BUDGET` <= 20,200 chars; document every new parameter added to core tools in `docs/REFERENCE.md`.
- Do not commit, push, edit `CHANGELOG.md`, or bump versions.
- Verify `npm run lint`, `npm test`, and `npm run preflight` at the end of every batch, plus `npm run preflight -- --e2e` after Batch 3.

---

## Step 0: Baseline Verification

- [x] Run `npm run preflight` and confirm all unit gates pass before modifying any code.

---

## Step 1 (Batch 1): Remove 10 Redundant MCP Tools (79 -> 69)

### Mapping

| Removed MCP Tool               | Replacement                                                                         | Protocol / Underlying Behavior                                          |
| ------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `browser_element_screenshot`   | `browser_take_screenshot({target})`                                                 | Calls `element_screenshot` and returns image block                      |
| `browser_a11y_snapshot`        | `browser_snapshot`                                                                  | Snapshot already uses CDP `DOMSnapshot` + `Accessibility.getFullAXTree` |
| `browser_coordinate_drag`      | `browser_drag({fromX, fromY, toX, toY})`                                            | Calls `drag` (also supports coordinates)                                |
| `browser_go_back`              | `browser_navigate({history: "back"})`                                               | Calls `go_back`                                                         |
| `browser_go_forward`           | `browser_navigate({history: "forward"})`                                            | Calls `go_forward`                                                      |
| `browser_wait_network_idle`    | `browser_wait_for({for: "network-idle", idleMs, maxInFlight})`                      | Calls `wait_network_idle`                                               |
| `browser_get_network_requests` | `browser_monitor_requests({action: "list", url_pattern})`                           | `monitor_requests` covers list + filter                                 |
| `browser_get_network_request`  | `browser_monitor_requests({action: "get", requestId, pointer})`                     | `monitor_requests` covers single-request inspection                     |
| `browser_get_response_body`    | `browser_monitor_requests({action: "get", requestId, include_body: true, pointer})` | `monitor_requests` covers body extraction                               |
| `browser_reload_extension`     | CLI `reload_extension` or `browser_action({action: "reload_extension"})`            | Dev-only helper removed from MCP registry                               |

### Checklist

- [x] **Update specs/docs:** Update `docs/REFERENCE.md` (document `history` on `browser_navigate`; update `browser_wait_for` `for` values + `idleMs`/`maxInFlight` and remove reference to `browser_wait_network_idle`). Check `README.md` for any removed tool pointers.
- [x] **Implement (`mcp/index.js`):**
  - Extend `browser_navigate` schema (`url`, `reload`, `history`) with exactly-one validation and handler routing `go_back` / `go_forward`.
  - Extend `browser_wait_for` (`for: enum(["settle", "selector", "text", "network-idle"])`, `idleMs`, `maxInFlight`) routing `"network-idle"` to `wait_network_idle`.
  - Remove the 10 `server.registerTool` blocks and update `TOOL_CATEGORIES`, `NO_TAB_TOOLS`, and tool descriptions referencing removed tools.
- [x] **Regenerate & Test:**
  - Run `npm run preflight -- --fix` to update `docs/TOOLS.md`.
  - Add/update unit tests in `tests/unit/cli_and_mcp.test.mjs` verifying removed tools are absent from `server._registeredTools`, `navigate({history})`, and `wait_for({for: "network-idle"})`.
  - Run `npm run lint`, `npm test`, `npm run preflight`.

---

## Step 2 (Batch 2): Consolidate State & Light Network Capture Clusters (69 -> 60)

### Mapping

| Removed MCP Tools                                                                               | Consolidated MCP Tool                                                                      | Protocol Actions                                                |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `browser_get_cookies`, `browser_set_cookie`, `browser_delete_cookies`                           | `browser_cookies({action: "get" \| "set" \| "delete", ...})`                               | `get_cookies`, `set_cookie`, `delete_cookies`                   |
| `browser_storage_get`, `browser_storage_set`, `browser_storage_remove`, `browser_storage_clear` | `browser_storage({action: "get" \| "set" \| "remove" \| "clear", area, key, value})`       | `storage_get`, `storage_set`, `storage_remove`, `storage_clear` |
| `browser_net_start`, `browser_net_stop`, `browser_net_get`, `browser_net_clear`                 | `browser_net_capture({action: "start" \| "stop" \| "get" \| "clear", urlContains, limit})` | `net_start`, `net_stop`, `net_get`, `net_clear`                 |

### Checklist

- [x] **Update specs/docs:** Document `browser_cookies`, `browser_storage`, and `browser_net_capture` in `docs/REFERENCE.md` if referenced, and verify no pointers to old names remain.
- [x] **Implement (`mcp/index.js`):** Register the 3 action-dispatched tools with Zod `.refine(...)` validation for per-action required fields (`set`/`delete` cookie names, `storage` `key`/`value`), update `TOOL_CATEGORIES.cookies`, `TOOL_CATEGORIES.storage`, `TOOL_CATEGORIES.network`, and clean up descriptions.
- [x] **Regenerate & Test:**
  - Run `npm run preflight -- --fix`.
  - Add unit schema/validation tests for the 3 consolidated tools in `tests/unit/cli_and_mcp.test.mjs`.
  - Run `npm run lint`, `npm test`, `npm run preflight`.

---

## Step 3 (Batch 3): Consolidate Record, Tabs/Windows, CDP, and Input Clusters (60 -> 48)

### Mapping

| Removed MCP Tools                                                                     | Consolidated MCP Tool                                                                                                              | Protocol Actions                                      |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `browser_record_start`, `browser_record_stop`, `browser_record_get`, `browser_replay` | `browser_record({action: "start" \| "stop" \| "get" \| "replay", startUrl, steps})`                                                | `record_start`, `record_stop`, `record_get`, `replay` |
| `browser_current_tab`, `browser_group_tab`, `browser_ungroup_tab`                     | `browser_tabs({action: "list" \| "new" \| "select" \| "close" \| "release" \| "yield" \| "current" \| "group" \| "ungroup", ...})` | `current_tab`, `group_tab`, `ungroup_tab`             |
| `browser_list_windows`, `browser_focus_window`, `browser_agent_window`                | `browser_windows({action: "list" \| "focus" \| "open_agent" \| "close_agent" \| "status_agent", id, url, width, height})`          | `list_windows`, `focus_window`, `agent_window`        |
| `browser_cdp_attach`, `browser_cdp_detach`, `browser_cdp_send`                        | `browser_cdp({action: "attach" \| "detach" \| "send", method, params})`                                                            | `cdp_attach`, `cdp_detach`, `cdp_send`                |
| `browser_wheel`                                                                       | `browser_scroll({mode: "dom" \| "wheel", deltaX, deltaY, modifiers, ...})`                                                         | `scroll`, `wheel`                                     |
| `browser_insert_text`                                                                 | `browser_type({method: "set" \| "type" \| "paste" \| "ime", ...})`                                                                 | `type`, `insert_text`                                 |
| `browser_network_replay`                                                              | `browser_make_request({requestId, url, method, headers, body, pointer, ...})`                                                      | `make_request`, `network_replay`                      |

### Checklist

- [x] **Update specs/docs:** Update `docs/REFERENCE.md` for all new parameters on core tools (`browser_tabs`, `browser_scroll`, `browser_type`, `browser_make_request`) and update line mentioning `browser_cdp_send` to `browser_cdp`. Ensure `AGENT_TEXT_BUDGET` stays <= 20,200 chars.
- [x] **Implement (`mcp/index.js`):**
  - Register `browser_record`, `browser_windows`, `browser_cdp`; update `browser_tabs`, `browser_scroll`, `browser_type`, `browser_make_request`.
  - Update `TOOL_CATEGORIES`, `NO_TAB_TOOLS`, and tool descriptions (`browser_load_tools`, `browser_take_screenshot`, `browser_get_cookies`/etc. notes).
- [x] **Regenerate & Test:**
  - Run `npm run preflight -- --fix`.
  - Update unit tests in `tests/unit/cli_and_mcp.test.mjs` / MCP child specs for the new signatures and 48-tool surface.
  - Run `npm run lint`, `npm test`, `npm run preflight`.

---

## Step 4: Final Full Verification

- [x] Run `npm run preflight -- --e2e` with connected Chrome & Edge browsers and verify all unit gates, single-browser E2E suites, and multi-browser suites pass.
- [x] Smoke-test consolidated MCP tools (`browser_cookies`, `browser_storage`, `browser_cdp`, `browser_tabs`, `browser_windows`, `browser_record`) via MCP server invocation / unit harness.
