# Interfaces: HTTP API, MCP, CLI, extension wire protocol, call log

Status: verified (2026-11-21: `tab` in results, MCP text blocks, client resend rule, `watch`)
Depends on: `architecture.md`, `sessions.md`, `errors.md`

## Tool registry

One module lists every tool: name, parameter schema (JSON Schema, from which validation, MCP
`inputSchema`, CLI flags and `docs/TOOLS.md` are generated), handler, description. Nothing else
defines a tool. Tool names are the spec file names: `status`, `tabs`, `navigate`, `snapshot`,
`read`, `get`, `click`, `hover`, `type`, `fill_form`, `press_key`, `scroll`, `wait_for`,
`take_screenshot`, `file_upload`, `handle_dialog`, `evaluate`, `run`, `network_requests`.

Validation is strict: unknown parameters, wrong types and out-of-range values →
`INVALID_PARAMS` listing the valid parameters. No aliases.

## Daemon HTTP API

Listens on `127.0.0.1:8765` (`BROWSERCTL_PORT` to change).

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /health` | | `{ok: true, version, protocol}`; the extension probes this before opening its socket |
| `GET /v1/tools` | | the registry: names, schemas, descriptions |
| `POST /v1/tools/<name>` | the tool's parameters as JSON | `{ok: true, ...result}` or `{ok: false, error: {code, message, hint}}` |
| `DELETE /v1/sessions/<id>` | | ends the session (`sessions.md`) |
| `POST /v1/sessions/<id>/heartbeat` | | `{ok: true, known}`; keeps an existing session alive (`sessions.md`), `known: false` when there is none |
| `GET /extension` (WebSocket upgrade) | | the extension's connection |

Headers on tool calls: `X-Browserctl-Session` (session id), `X-Browserctl-Client` (`mcp`, `cli`,
or a script's name, recorded in the call log), `X-Browserctl-Close-Tabs` (`1`: the session closes
the tabs it opened when it ends, `sessions.md`; read only when the call creates the session). HTTP status is 200 for every tool answer, including
`ok: false`; transport problems use 4xx/5xx.

Every successful result of a call that resolved a tab carries `tab`, the tab's id, unless the
tool's own result has a `tab` field already (`tabs`, `navigate`), so an agent sees which tab it
acted on (`sessions.md`: agents sharing a session).

Python and other scripts use this API directly; no client library is required. Scripts that run
at the same time each set their own `X-Browserctl-Session`: the default `http` is one session with
one current tab.

## Environment

| Variable | Read by | Default | Meaning |
| --- | --- | --- | --- |
| `BROWSERCTL_PORT` | daemon, clients | `8765` | daemon port (the extension's storage key `daemonPort` must match) |
| `BROWSERCTL_HOME` | daemon, clients | `~/.browserctl` | sessions, aliases, call log, screenshots, daemon log, the extension copy (`extension path`) |
| `BROWSERCTL_DETACH_IDLE` | daemon | `30` | seconds without a CDP-lane call before the debugger detaches (`sessions.md`) |
| `BROWSERCTL_SESSION_IDLE` | daemon | `300` | seconds without a request or heartbeat before a session ends (`sessions.md`) |
| `BROWSERCTL_AUTO_START` | clients | | `manual`: clients never start the daemon |
| `BROWSERCTL_CLOSE_TABS` | clients | | `1`: send `X-Browserctl-Close-Tabs: 1`, so the session's tabs close when it ends |

## MCP server

- stdio server, started by the agent's client (`npx browserctl-mcp` or equivalent).
- Starts the daemon if `/health` does not answer, then registers the tools from `GET /v1/tools`.
- Generates one session id at start; sends a heartbeat every 60 s and `DELETE /v1/sessions/<id>` on exit.
- A tool result is one text block with the JSON result. The long text of `snapshot` (its
  `snapshot` field) and of `read` (its `text` field) leaves the JSON and follows as a second text
  block as it is, so its quotes and line breaks are not escaped (escaped YAML costs tokens and reads
  worse). `take_screenshot` adds an image block.
- Server instructions (what the agent reads at connect): the loop in a few lines (`navigate` →
  `snapshot` → act with refs → read `outcome`), the target forms (`targets.md`), the common
  action parameters (`actions.md`), `get` and `read`, the two lanes and `trusted`, `evaluate`
  as the fallback, and that agents sharing the server open their own tab and pass `tab`
  (`sessions.md`). They are budgeted with the tool descriptions; a preflight gate measures the total
  (API-E02: under 22,500 characters; raised from 20,200 on 2026-11-14 for `get` and the common
  action parameters, whose locator list lives once in the instructions instead of in every
  `target`).

## Clients

The MCP server and the CLI share one HTTP client. It waits for a tool's answer without a time
limit: the tool's own `timeout` bounds the call (measured 2026-11-21: Node's `fetch` gives up after
300 s without response headers, which cut `run` calls that may last 600 s, and its retry ran the
code a second time). It sends a call again only when the daemon refused the connection, so the call
never reached it; then it starts the daemon (unless `BROWSERCTL_AUTO_START=manual`) and sends once
more. A connection lost after the call was sent is an error saying the call may have run; it is
never sent again, since a repeated click or `run` acts twice.

## CLI

- `browserctl <tool> [--param value ...]`, flags generated from the registry (`--target e5`,
  `--fields '[...]'` as JSON). Output is the JSON result; `--pretty` indents it.
- `browserctl daemon start|stop|status`.
- `browserctl extension path` copies the extension that ships with this install into
  `$BROWSERCTL_HOME/extension` (default `~/.browserctl/extension`), replacing what is there, and
  prints that folder. The user loads it unpacked from that one fixed place, which does not move
  with the npm install location or the Node version; after an upgrade the same command refreshes
  the copy, and **Reload** in `chrome://extensions` picks it up.
- Session `--session <name>`, default `cli`.

## Extension wire protocol

Transport: the WebSocket at `/extension`, one JSON object per message.

| Direction | Shape |
| --- | --- |
| daemon → extension | `{id, method, params}` |
| extension → daemon | `{id, result}` or `{id, error: {code, message}}` |
| extension → daemon | `{event, data}` |

After registering the browser the daemon answers with `{event: "welcome", data: {alias, version}}`
(`extension-ui.md`), then `{event: "watch", data: {tabIds}}`, the tabs of that browser some session
owns; it sends `watch` again after every change of ownership. The extension sends `net.request`
only for those tabs (every tab until the first `watch`), so the user's own browsing does not
travel to the daemon to be dropped there. A tab that joins a session (a popup) is watched from the `watch`
that names it; requests it made before that are not reported.

Hello (first event): `{protocol, extensionVersion, instanceId, browser: {name, version},
profileLabel, browserStartedAt, userScripts}`. `browserStartedAt` is set in
`chrome.runtime.onStartup` and kept in `chrome.storage.session`, so it changes when the browser
restarts, not when the service worker does. A `protocol` different from the daemon's →
`EXTENSION_OUTDATED` on every call for that browser, with the reload instructions in the hint.

Protocol 2 (2026-11-21) adds what the daemon now relies on: `watch`, the runtime's `content`
count (`settle.md`) and ref numbering across documents (`targets.md`). With an extension speaking
protocol 1, settle would end without waiting and refs could repeat, so it gets
`EXTENSION_OUTDATED` and the reload hint.

Methods (the extension's whole surface):

| Group | Methods |
| --- | --- |
| tabs | `tabs.list`, `tabs.create`, `tabs.update`, `tabs.close`, `tabs.activate`, `tabs.goBack`, `tabs.goForward`, `tabs.reload` |
| DOM lane | `dom.inject`, `dom.call` (`{tabId, frameId?, op, args}`), `dom.capture` (visible tab, optional crop) |
| evaluate | `eval.user` (`chrome.userScripts.execute`, MAIN world) |
| CDP | `debugger.attach`, `debugger.detach`, `debugger.send`, `debugger.list` |
| diagnostics | `diag.read` (the in-memory diagnostics ring) |

Events: `debugger.event`, `debugger.detached`, `tabs.created`, `tabs.removed`, `tabs.updated`,
`nav.beforeNavigate`, `nav.committed`, `nav.domContentLoaded`, `nav.completed`,
`nav.historyStateUpdated`, `nav.createdTarget` (a tab opened by a page, with its source tab even
for `noopener` links), `nav.error`, `net.request` (from `webRequest`, the watched tabs), `diag` (internal errors that
the extension caught).

Rules: the extension never logs errors to the console (`architecture.md`); it probes `GET /health`
with a caught `fetch` and opens the socket only after an answer; it retries the probe every 2 s
while the daemon is down and on a 30 s alarm after a worker restart; it queues events while the
socket is down in `chrome.storage.session` (at most 500), so a worker restart does not lose them.
The daemon sends a WebSocket message every 20 s so the worker is not stopped while connected.
Every daemon → extension request has a timeout (default 10 s; per method in the code). A DOM-lane
call (`dom.call`, `eval.user`) that times out is `TIMEOUT` with the hint for a page that does not
answer: a dialog the user has to answer, or a script that never yields (`errors.md`).

## Call log

`~/.browserctl/calls.jsonl`, one line per tool call: time, session, client, browser alias, tab,
tool, parameters in full (including `evaluate` and `run` code), lane, `ok`, error code, duration,
result size. Rotated at 20 MB, one previous file kept. This is the measurement source for how
agents use the tools (`architecture.md` reuse policy, and the probe runs).

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| API-U01 | unit | registry → MCP schemas, CLI flags | every tool, every parameter, no extras |
| API-U02 | unit | unknown parameter `selector` on `click` | `INVALID_PARAMS` listing the valid ones |
| API-U03 | unit | protocol mismatch in hello | `EXTENSION_OUTDATED` |
| API-U04 | unit | call log line for `evaluate` | full code recorded, with session and browser alias |
| API-U06 | unit | `extension path` twice, with a stray file in the folder before the second run | prints `$BROWSERCTL_HOME/extension`, which holds `manifest.json` and `generated/pw-injected.js`; the second run leaves no stray file |
| API-U05 | unit | CLI: `--doubleClick` with a bad `--button`, `--session other` without a tab, `daemon status` | `INVALID_PARAMS` exit 1, `NO_TAB` exit 1, exit 0 |
| API-U07 | unit | `get` on the current tab; `tabs list` | the `get` result carries `tab`; the `tabs` result keeps its own shape |
| API-U08 | unit | MCP content of a `snapshot`, a `read`, a `click` result | two text blocks with the text unescaped for the first two, one JSON block for `click` |
| API-U09 | unit | the client against a server that drops the connection after reading a call; against a closed port with `BROWSERCTL_AUTO_START=manual` | an error saying the call may have run, the server saw the call once; the daemon-not-running error |
| API-U10 | unit | a session opens a tab, opens a second, releases the first | `watch` after each change with the owned tabs of that browser |
| API-E01 | live | daemon stopped, extension running 60 s, daemon started | extension connects within 35 s; Errors page empty |
| API-E02 | live | MCP server start with no daemon | daemon started, tools registered; the instructions name the locator forms (`label=`), `timeout`, `scroll`, `wait` and `get` |
| API-E03 | live | MCP server exit | session ended, attachments detached |
| API-E04 | live | MCP server started with `BROWSERCTL_CLOSE_TABS=1` opens a tab, then exits; a second one without it | the first tab is closed, the second stays open |
