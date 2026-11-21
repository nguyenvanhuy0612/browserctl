# Sessions, browsers, tabs and the debugger lifecycle

Status: verified (2026-11-21: agents sharing a session, current tab closed)
Depends on: `architecture.md`

## Browsers

- Each extension instance generates an `instanceId` once (stored in `chrome.storage.local`) and
  sends it in its hello with the browser name, version and profile label.
- The daemon keeps one connection per `instanceId`. A new connection with the same `instanceId`
  replaces that instance's old socket; a connection with another `instanceId` is a second browser.
  A connection never displaces another browser's.
- Each browser gets an alias in connection order per browser name: `chrome-1`, `chrome-2`,
  `edge-1`. Aliases are kept in `~/.browserctl/browsers.json` by `instanceId`, so they survive
  restarts.
- Tab ids come from Chrome and are unique within one browser; the daemon keys tabs by
  (`instanceId`, tab id). A bare `tab` that exists in two connected browsers →
  `AMBIGUOUS_BROWSER`.
- The way out of `AMBIGUOUS_BROWSER` is `tabs` with `browser` (`new`, `select`): the session's
  current tab then pins the browser, and later calls without `tab` go to it.
- With one browser connected, calls go to it. With several, a session's first call that needs a
  browser and does not name one fails with `AMBIGUOUS_BROWSER`, listing aliases.
- On every connect the daemon asks the extension for its debugger attachments and detaches every
  one it does not track (a daemon crash never leaves the bar or focus emulation behind).

## Sessions

| Client | Session id |
| --- | --- |
| MCP server | generated at process start, sent on every request (`X-Browserctl-Session`) |
| CLI | `--session <name>`, default `cli` |
| HTTP scripts | `X-Browserctl-Session` header, default `http` |

- A session is created on its first request. It ends on `DELETE /v1/sessions/<id>` (the MCP server
  sends it on exit) or after `BROWSERCTL_SESSION_IDLE` seconds (default 300) without a request.
  A heartbeat (`POST /v1/sessions/<id>/heartbeat`, `interface.md`) counts as a request for a
  session that exists; it never creates one. The MCP server sends it every 60 s, so its session
  lives as long as its process and a killed process frees its tabs within the idle limit. A call
  in flight keeps its session alive however long it runs.
- Ending a session detaches the debugger from its tabs and releases them. Tabs stay open unless
  the session was created with `closeTabsOnEnd: true` (the `X-Browserctl-Close-Tabs: 1` header
  on its first call, `interface.md`); then the tabs it owns are closed, adopted tabs stay open.
- Ownership is persisted in `~/.browserctl/sessions.json` (session id, browser `instanceId`, tab
  id), so a daemon restart keeps it.

## Tabs

| State | Meaning |
| --- | --- |
| owned | created by the session, or opened by a tab the session owns (popup, `target=_blank`) |
| adopted | an existing tab the session took with `tabs({action: "adopt"})` |
| free | anything else, including every tab the user opened |

- A session acts only on tabs it owns or adopted. Another session's tab → `TAB_NOT_OWNED`,
  on every tool and on `adopt` without `force`, with the holder and the hint
  `Take it only if the user asked for this tab: tabs({action: "adopt", tab: <id>, force: true}). Otherwise open a tab of your own.`
  `tabs({action: "adopt", force: true})` takes it over and the previous holder's next call on it
  gets `TAB_NOT_OWNED` naming the new holder.
- Actions on one tab run one at a time: an action tool (`click`, `hover`, `type`, `fill_form`,
  `press_key`, `scroll`, `file_upload`) starts after the previous action on that tab has settled,
  so each `outcome` describes its own action. Reading tools do not wait. A tab is not taken in the
  middle of an action: `adopt` with `force` waits for the action in flight to end, at most 5 s,
  then takes the tab.
- Each session has one current tab; tools default to it. `tabs({action: "new"})` and
  `tabs({action: "select"})` change it.
- One MCP server process is one session, and agents that share it (subagents of one client) share
  its current tab: a call without `tab` from one agent acts on the tab another agent last opened
  or selected (measured 2026-11-21: a second agent's `navigate` moved the first agent's page). No
  per-agent identity reaches the server, so the agents keep apart themselves: the MCP instructions
  tell each agent to open its own tab and pass `tab` on every call, and every result of a call that
  acted on a tab names it (`tab`, `interface.md`), so a change of tab is visible.
- New tabs are created with `active: false` in the browser's last focused normal window, next to
  the user's tabs and not in a tab group (the owner dropped grouping on 2026-11-14: groups moved the
  user's tabs around and added nothing an agent needs). If no normal window exists, a minimized,
  unfocused window is created.
- The user's active tab and focused window change only through `tabs({action: "select",
  focus: true})`.
- A tab that a page in an owned tab opens (a `target=_blank` link, `window.open`) joins that tab's
  session and is reported by the action that opened it. The source tab comes from
  `webNavigation.onCreatedNavigationTarget`, which names it even for `noopener` links; measured
  2026-11-15 (Chrome for Testing 158): `tabs.onCreated` gave the window's active tab as
  `openerTabId`, not the tab whose link was clicked, so it is not used for ownership.
- Such a tab must not take the user's view: when Chrome opens it active, the daemon activates
  again the tab that was active before, which Chrome reports as the new tab's `openerTabId`
  (same measurement: in three runs it was the previously active tab every time).
- A closed tab is dropped from its session; the next call on it, by id or as the session's current
  tab, fails with `TAB_CLOSED` (not `NO_TAB`), and `navigate` without `tab` opens a new tab.

## Debugger lifecycle (CDP lane)

| Event | Behaviour |
| --- | --- |
| a CDP-lane call on a tab | attach if not attached; enable focus emulation if the tab is not the active tab of a focused window |
| no CDP-lane call on a tab for `BROWSERCTL_DETACH_IDLE` (default 30 s) | detach (the bar disappears about 5 s after the last tab detaches) |
| pins: network capture running, `run` in progress, a dialog waiting | no idle detach while pinned |
| session ends, tab released, tab closed | detach |
| the user presses Cancel on the bar (`canceled_by_user`) | every tab of that browser is detached by Chrome; the browser is marked `debuggerCanceled`; CDP-lane calls fail with `DEBUGGER_CANCELED` until `status({allowDebugger: true})` is called (the agent asks the user first) |
| another debugger holds the tab (DevTools open) | `DEBUGGER_BUSY`, no detach of the other client |

`status` lists, per browser, the attached tabs, their idle time left and their pins.

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| SES-U01 | unit | two connections, different `instanceId` | both kept, aliases `chrome-1`, `chrome-2` |
| SES-U02 | unit | reconnect with the same `instanceId` | replaces its own socket, alias kept |
| SES-U03 | unit | two browsers, call without `browser` | `AMBIGUOUS_BROWSER` listing aliases |
| SES-U04 | unit | session B acts on session A's tab | `TAB_NOT_OWNED`; after B adopts with `force`, A gets `TAB_NOT_OWNED` naming B |
| SES-U05 | unit | `nav.createdTarget` from an owned tab, after a `tabs.created` whose `openerTabId` is another session's tab | owned by the source tab's session only |
| SES-U06 | unit | idle past the limit | session ends, attachments detached, tabs kept |
| SES-U07 | unit | daemon restart with `sessions.json` | ownership restored |
| SES-U08 | unit | idle timer with a pin | no detach until unpinned |
| SES-U09 | unit | `canceled_by_user` | browser marked; CDP-lane call → `DEBUGGER_CANCELED`; `allowDebugger` clears it |
| SES-U10 | unit | heartbeats past the idle limit, then none; a heartbeat for an unknown session | the session lives while they come and ends after; the unknown one is not created |
| SES-U11 | unit | session B calls `click` on A's tab, then `adopt` without `force` | both `TAB_NOT_OWNED` with A as `holder` and a hint naming `adopt` with `force: true` |
| SES-U12 | unit | two `click` calls sent together on one tab; `adopt` with `force` during an action | the second click starts after the first settled; the adopt answers after the action ended |
| SES-U13 | unit | the session's current tab closes in the browser | the next call without `tab` → `TAB_CLOSED`; `navigate` with a URL opens a new tab and makes it current |
| SES-E01 | live | `tabs new` | tab inactive, not grouped, user's active tab unchanged |
| SES-E02 | live | daemon killed with an attached tab, restarted | on reconnect the stale attachment is detached |
| SES-E03 | live | CDP call, then 30 s idle | detached; bar gone within 6 s more |
| SES-E04 | live | session created with `X-Browserctl-Close-Tabs: 1` owns one tab and adopted another, then ends | the owned tab is closed, the adopted one stays open; a session without the header keeps its tab |
| SES-S01 | manual | owner's Chrome: Cancel on the bar | `DEBUGGER_CANCELED` on the next trusted call |

## Edge cases left out

| Case | Why |
| --- | --- |
| Incognito windows | the extension is not allowed there unless the user enables it; then they behave like any window |
| Tab ids reused after a browser restart | on every reconnect the daemon drops ownership of tabs the browser no longer has (tab ids are large random numbers, so a restarted browser does not reuse them); `browserStartedAt` is informational, because session storage is also cleared by an extension reload |
