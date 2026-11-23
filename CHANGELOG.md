# Changelog

## 1.0.3

Security release. After updating, stop the old daemon (`browserctl daemon stop`) and restart your
agent's MCP client: a daemon left running from an older version is still open, and an MCP server
or CLI from an older install starts the daemon of its own version. The extension needs no reload
(same wire protocol).

- **Fixed: any web page could control the browser through the daemon** (CVSS 3.1 9.3,
  `AV:N/AC:L/PR:N/UI:R/S:C/C:H/I:H/A:N`; versions up to 1.0.2). The daemon's HTTP API had no check
  and answered with `Access-Control-Allow-Origin: *`, so a page the user opened could call every
  tool, including `evaluate`, and read the answers: page content, cookies and tokens of the user's
  logged-in sites. A page could also open the `/extension` socket (to pose as a browser) and the
  `/cdp` socket of a session. Now:
  - every request must name the daemon's own host (`127.0.0.1:<port>` or `localhost:<port>`),
    which stops DNS rebinding;
  - a request that carries an `Origin` header, which browsers add to every request a page sends,
    is refused with 403 `REQUEST_REFUSED`; `/extension` accepts only a `chrome-extension://`
    origin, and `/health` stays open;
  - no answer carries `Access-Control-Allow-Origin: *`.

  The MCP server, the CLI, `run` and your own scripts (curl, Python) send no `Origin` and work as
  before. A request copied from the browser's DevTools carries one: remove that header.

  Reported privately by Giulliano Amaral (https://giullianoamaral.com).

- **Known limitations.** These checks stop web pages, not everything that runs on the machine:
  - other OS users on the same machine can reach `127.0.0.1` and run tools in your Chrome;
  - a bug in another local program that lets a remote attacker make it send a POST with a chosen
    JSON body to the daemon (server-side request forgery) would pass the checks;
  - another extension you installed can connect as a browser and see the calls sent to it (it
    still cannot call the tool API).

  On a machine shared with other users, stop the daemon when you are not using it
  (`browserctl daemon stop`, and `BROWSERCTL_AUTO_START=manual` so clients do not start it). A
  secret token on every call is the planned next layer.

## 1.0.2

Reload the extension after updating: it speaks wire protocol 2, and the daemon refuses an older one
with `EXTENSION_OUTDATED`.

- Refs are unique within a tab across pages: a ref from an earlier page now fails with
  `REF_NOT_FOUND` instead of naming an element of the new page once that page was snapshotted.
- Every result of a call on a tab names the tab (`tab`). Subagents that share one MCP server share
  its current tab; the server's instructions tell them to open their own tab and pass `tab`.
- A current tab the user closed is `TAB_CLOSED` (was `NO_TAB`); `navigate` then opens a new tab.
- The MCP server and CLI never send a call twice: a lost connection is reported as a call that may
  have run, and long calls (`run` up to 600 s) are no longer cut at 300 s.
- `snapshot` and `read` text comes as its own MCP text block, without JSON escaping.
- Actions no longer wait 3 s on pages whose attributes change all the time (animations, progress
  bars): only nodes and text count toward the page settling.
- `evaluate` takes `timeout` (default 30 s) and `action: true`, which waits for the page to react
  and returns `outcome` like `click`. A timeout while the page still answers says the code was
  still waiting.
- `run`: one worker per session for all its tabs (`state` survives switching tabs, `page` is the
  call's tab); tabs a page opens appear as popups (`page.waitForEvent("popup")`); after the
  extension reconnects the next call starts a fresh worker instead of failing.
  `page.waitForLoadState()` no longer hangs now and then.
- Body capture skips images, media and fonts (they are still listed) and drops the pending body of
  a failed request; the extension sends network events for the agent's tabs only.
- `snapshot` and `read` see into closed shadow roots of web components (the DOM lane acts on their
  elements too), `read` follows shadow roots and slots, and frames nest 10 levels deep (was 4); an
  iframe that could not be read says `[not read]`.
- A PDF tab and canvas-drawn areas get a notice line in `snapshot` (and `read` for a PDF) instead
  of an empty or silent result. `read` works on SVG and XML documents.

## 1.0.1

- Sessions end after 5 minutes without a request instead of 30 (`BROWSERCTL_SESSION_IDLE`, in
  seconds). The MCP server sends a heartbeat every minute, so its session lives as long as its
  process; a call that is still running never lets its session expire.
- A call on a tab another session holds is refused with `TAB_NOT_OWNED` and a hint naming the way
  to take it: `tabs({action: "adopt", tab: <id>, force: true})`.
- Actions on one tab (`click`, `hover`, `type`, `fill_form`, `press_key`, `scroll`,
  `file_upload`) run one at a time, so each result describes its own action. A forced `adopt`
  waits for the action in flight (at most 5 s) before it takes the tab.
- `evaluate` returns results up to 1 MB (was 50 KB).
- The extension is unchanged apart from its version number.

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
