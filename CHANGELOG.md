# Changelog

One entry per published version. The reasoning and measurements behind each change are in the
commit history and on the GitHub release.

## 0.9.2

Several agents can now work on the same browser at the same time, and long-open background tabs
no longer stall.

- Two sessions taking screenshots on one browser no longer refuse each other. Chrome allows two
  visible-tab captures a second per extension; captures are queued. A tab that another session
  moves out of view while a capture waits is captured as a background tab, never as the other
  tab's pixels.
- Commands on one tab from several sessions share a single debugger attach, so none fails with
  "another debugger is already attached".
- Edge now captures background tabs without bringing them to the front, as Chrome and Brave do.
  Focus emulation is on only for the moment of the capture.
- A tab the browser froze in the background (Edge sleeping tabs, Chrome and Brave memory and
  energy savers) is woken before a command, instead of every command waiting 30 s. A discarded tab
  is reported with a reload hint, and `browser_tabs list` marks `frozen` and `discarded` tabs.
- `browser_get_property` reads `checked` on a checkbox or radio. A click that checks one, or its
  label, is confirmed instead of warned about as "the page did not change".
- New release gate: one session per connected browser (up to three) runs every core action at the
  same time, and each session's commands must stay on its own browser and tab.

## 0.9.1

One bridge serves every browser and profile on the machine. Install the extension in each profile
and leave its port at 8765: there is no port to assign and nothing to add to the MCP config. Each
agent session keeps its own target tab, chosen on first use (the visible tab of the browser you
focused last) and kept afterwards, so two sessions can work in Chrome and Edge at the same time.
`browser_tabs` gained `browser`, `query` and `activate`; `tabId` routes to whichever browser owns
it. The CLI gained `--browser` / `-b` and `BROWSERCTL_BROWSER`, and `browserctl status` lists
every connected browser.

**BREAKING:**
- Point every extension at port 8765 (Options > port, Save & reconnect) and stop any extra bridge
  you ran for a second browser.
- `browser_tabs select` no longer brings the tab to the front; pass `activate: true` for that. The
  CLI's `tab switch` still does.
- A closed target tab is `TARGET_CLOSED` (listing the open tabs) instead of falling back to the
  active tab, until `browser_tabs` select or new. A disconnected browser is
  `BROWSER_DISCONNECTED` until it reconnects.
- A session's first call answers with a `target` block instead of the "re-issue" guard error.
- `browser_tabs list` returns `{tabs, browsers, target}`, each tab tagged with its `browser`.
- `/status` and `browser_status` list `browsers` instead of a top-level `instanceId` /
  `browserType`. No browser connected is `409 NO_BROWSER` (was `503`). CLI routing errors exit 2.

## 0.9.0

Every tool was run against real pages and automation practice sites; this release is what that
turned up.

**BREAKING:** a compact `browser_snapshot` no longer carries `elements`. Folded controls come back
in `folded` as `{ref, text, href}`; `compact: false` still returns `elements`. Snapshots are about a
third of their old size (Google search 152 KB → 23 KB).

- The census shows state: native checkbox/radio `[checked]`/`[unchecked]`, closed menus
  `[collapsed]`, disabled controls listed as `[disabled]`; each control appears once.
- Controls are named the way the page names them (icon link by `aria-label`, `<label>` over
  placeholder, wrapped `<select>` by its label), and the census, `browser_find` and target
  resolution agree on names.
- `browser_navigate` waits up to 20 s for the navigation to commit and fails with Chrome's network
  error instead of reporting the old page.
- `browser_find` ranks exact names first; `browser_press_key` sends `code`/`keyCode`/`which`.
- Scrolling a background tab dispatches the `scroll` event pages listen for; `browser_hover` sends
  pointer events as well as mouse events.
- Capturing one element no longer needs `browser_cdp_attach`; an iframe element's `frame` is origin
  and path only; `browser_a11y_snapshot` coverage counts the whole census; `browser_extract` renders
  refs with one `@`.

## 0.8.4

Fixes where a tool reported success for something that did not happen, or where `target` had not
reached every path.

- `browser_element_screenshot` and `browser_describe_element` take `target`; the old spellings are
  refused.
- `browser_action` runs a tool's name through that tool's own checks and schema.
- Calls that succeeded at nothing now fail: `replay` on a failed step, `go_back`/`go_forward` that do
  not move, `record_start` on an unhookable page, `fill_form` with a missing `<select>` option.
- `browser_spoof_visibility` takes `restore: true`.
- An action is sent once (a slow click on an attached tab ran two or three times; the MCP client no
  longer resends after a timeout).
- Frame-qualified refs work through `target`; `browser_file_upload` honours `target`;
  `method: "type"` types key by key.
- Target resolution, recording, element screenshots, CDP dialogs and the network buffer fixed;
  `browser_stop` stops the daemon; `browserctl stop` on Windows no longer kills Chrome.

## 0.8.3

- Closing an already-closed tab succeeds with `alreadyClosed: true`, and releases the pin.
- The call log's size cap is honoured.
- `POST /command` accepts an optional `client: {session, source}` recorded in the call log.

## 0.8.2

- Inline hints no longer suggest the `ref` / `selector` parameters that 0.8.0 removed.

## 0.8.1

0.8.0 was withdrawn on the day it was published; this carries the same release.

**BREAKING — a clean break from 0.7.x.** Tools were renamed or merged, element addressing is one
`target` parameter, and no compatibility shims remain. A removed parameter is refused with the form
that replaces it. Pin 0.7.1 if you are not ready to move.

| 0.7 | 0.8 |
|---|---|
| `browser_open_url`, `browser_reload` | `browser_navigate` (`url` or `reload: true`) |
| `browser_list_tabs`, `browser_switch_tab`, `browser_close_tab`, new tab | `browser_tabs` (`action: list \| new \| select \| close`) |
| `browser_fill` | `browser_type` (`method: set \| type \| paste`) |
| `browser_eval_js` | `browser_evaluate` |
| `browser_screenshot` | `browser_take_screenshot` |
| `browser_upload` | `browser_file_upload` |
| `browser_get_page_content` | `browser_get_content` |

- New: one target resolver (refs, `css=` / `text=` / `placeholder=` / `index=`, CSS, visible text,
  placeholder / aria-label, `AMBIGUOUS_TARGET` on several matches); `browser_fill_form`;
  `browser_extract`.
- A session is handed 47% less text at connect; a snapshot distinguishes several regions of one
  kind; `browser_tabs` reports `groupId`.
- A call that raises `alert()` / `confirm()` / `prompt()` on an attached tab returns
  `DIALOG_BLOCKED` instead of hanging (answering dialogs is experimental, `cdp` profile).
- `browser_take_screenshot({format: "png"})` works; `go_back` / `go_forward` work on background tabs.

## 0.7.1

**BREAKING for output parsers:** tools answer in compact JSON by default (`format: "smart"` for the
old rendering), and nothing is injected into results — notices became fields (`offscreenCount`,
`foldedCount`, `duplicateCount`, `structure`, `hiddenContent`).

- `browser_upload` attaches local files to file inputs, walking from a styled label to the hidden
  input.
- A click waits for a moving target to stop.
- `eval_js` answers the same with or without the debugger; the release gate runs every live suite.

## 0.7.0

**BREAKING:** `core` went from 35 tools to 23, with no aliases kept; every protocol action is still
reachable through `browser_action`.

| Removed | Call instead |
|---|---|
| `browser_get_text`, `browser_get_attribute`, `browser_get_count` | `browser_get_property` (`property: text \| value \| html \| box \| attr \| count`) |
| `browser_type`, `browser_paste`, `browser_select_option` | `browser_fill` (`method` / `option`) |
| `browser_navigate`, `browser_new_tab`, `browser_open_and_read` | `browser_open_url` |
| `browser_find_text` | `browser_find({query, in: "text"})` |
| `browser_screenshot_fullpage` | `browser_screenshot({fullPage: true})` |
| `browser_wait_settle` | `browser_wait_for({for: "settle"})` |
| `browser_dismiss_modal` | `browser_action({action: "dismiss"})` |

- `browser_get_property` reads one element, a region, every match (`all`), or rows (`fields`).
- The census is paged (`limit` / `cursor`), regions and dialogs carry refs, and `browser_find`
  takes a CSS `selector`.
- Unknown parameters are refused with the legal set and a did-you-mean; `tab_id` normalises to
  `tabId`.
- A click that navigates is reported as a navigation, not a stale ref.

## 0.6.3

- Inline hints are written as MCP calls, not CLI syntax; the read tools point at each other.
- Runtime logs are bounded, and `browserctl status` reports the call log.

## 0.6.2

- `dismiss` closes a native `<dialog>`; `browserctl find <query>` works.
- CLI help carries the same guidance as the MCP descriptions; docs describe what exists.

## 0.6.1

- `paste` inserts once; `press_key(Enter)` submits once; the paste fallback runs when insertion did
  not happen.
- New `run_editors.mjs` suite; test harnesses close the tabs they open.

## 0.6.0

- Controls carry the name Chrome computes for them (GitHub login 71% → 100% match).
- Operable-but-hidden controls are censused (`[via label]`, `[hidden until hover/focus]`); the full
  ARIA widget set is matched; role and state render inline.
- A click on a stateful control reports whether the state moved; a stale ref names its replacement.
- `browser_a11y_snapshot` added; opt-in per-call log (`BROWSERCTL_CALL_LOG=1`).

## 0.5.1

Extension and bridge version bump.
