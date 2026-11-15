# Changelog

## 1.0.0

browserctl is rebuilt from scratch. Install the new extension and register the MCP server again:
nothing from 0.9.x (tools, extension, bridge, settings) carries over.

### What it is

- An MCP server, a CLI and an HTTP API over one local daemon, which drives your own Chrome (or
  Edge, Brave) through an MV3 extension: your logins, background tabs of the agent's own.
- Two lanes. The DOM lane (default) runs Playwright's injected script inside the extension, so
  nothing shows Chrome's "started debugging this browser" bar. The CDP lane (`trusted: true`,
  `run`, background screenshots, response bodies) attaches the debugger only when a task needs
  real input, and detaches after 30 s idle.
- 19 tools: `status`, `tabs`, `navigate`, `snapshot`, `read`, `get`, `click`, `hover`, `type`,
  `fill_form`, `press_key`, `scroll`, `wait_for`, `take_screenshot`, `file_upload`,
  `handle_dialog`, `evaluate`, `run`, `network_requests` (`docs/TOOLS.md`).
- Targets are snapshot refs (`e5`, `f1e3` in frames) or any Playwright locator, plus `label=`,
  `placeholder=`, `testid=`, `alt=`, `title=`, `name=` and XPath.
- Actions take `timeout`, `scroll` and `wait` (act, then wait for a condition, in one call) and
  report what changed: URL, new tabs, dialogs and their answers, DOM changes.
- `run` executes Playwright code (`page`, `context`, a persistent `state`) in a worker process
  that can be stopped without stopping the daemon.
- Sessions own their tabs; another session's tab is refused unless adopted. A session can close
  its tabs when it ends (`BROWSERCTL_CLOSE_TABS=1` for the MCP server).
- Every call is logged to `~/.browserctl/calls.jsonl` with its parameters, for measuring how
  agents use the tools.

### Coming from 0.9.x

Tool names have no prefix, and several tools were merged:

| 0.9.x | Now |
| --- | --- |
| `browser_click`, `browser_hover`, `browser_type`, `browser_press_key`, `browser_scroll`, `browser_file_upload`, `browser_handle_dialog`, `browser_navigate`, `browser_tabs`, `browser_take_screenshot`, `browser_wait_for`, `browser_evaluate`, `browser_snapshot`, `browser_status`, `browser_fill_form` | the same name without `browser_` |
| `browser_select_option` | `fill_form` with the option's value or label |
| `browser_get_content`, `browser_extract` | `read` |
| `browser_get_property` | `get` |
| `browser_monitor_requests` | `network_requests` |
| `browser_make_request` | `evaluate` with `fetch` (the page's cookies apply) |
| `browser_cdp` | `run` (Playwright code over the same debugger connection) |
| `browser_find` | `snapshot`, or `get` with a locator and `all: true` |
| `browser_start`, `browser_stop`, `browser_action`, `browser_list_available_tools`, `browser_load_tools` | none: the daemon starts on demand and every tool is always listed |
