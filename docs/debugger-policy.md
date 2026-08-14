# chrome.debugger dependency map, and how to forbid it per site

Captured 2026-08-04 against v0.5, by reading the source (not from memory). Re-derive with
the script at the end if the command surface changes.

## Why this document exists

Attaching `chrome.debugger` makes Chrome show **`"browserctl" started debugging this
browser`**. That banner **cannot be suppressed** — it is a deliberate Chrome security
guarantee, and every project that uses `chrome.debugger` carries it (chrome-devtools-mcp,
playwright-mcp's extension mode, the official Claude in Chrome extension). The only way to
avoid it is to not attach.

So the question "can we forbid the debugger on site X?" reduces to: which commands would
stop working, which degrade, and where is the single place to enforce it. This document
answers all three.

## The chokepoint

There are exactly **two** callers of `attach(tabId)` in `extension/cdp.js`:

| Site | Caller | When |
|---|---|---|
| `cdp.js:191` | `ensureAttached()` | first acquisition of a session |
| `cdp.js:169` | `send()`'s auto-reattach | a session dropped (tab reload, SW recycle) and one command is being retried |

Both funnel through `attach()`, so **a policy check inside `attach()` covers 100% of
debugger acquisition** — including the auto-reattach path, which is easy to miss.

> ⚠️ **Attach-time enforcement alone is bypassable.** A CDP session survives same-tab
> navigation, so a tab attached on an allowed site and then navigated to a forbidden one
> keeps its session and its banner. A correct policy therefore needs a second hook: on
> `chrome.tabs.onUpdated`, if the tab's new URL is forbidden and a session exists, detach
> it. `dropTab()` already exists for the tab-closed case and is the natural sibling.

## Tiers

### Tier A — Never touches chrome.debugger — safe on any site

| Command | How it gets its capability |
|---|---|
| `cdp_detach` | releases a session; never acquires one |
| `click` | content script |
| `click_selector` | content script |
| `close_tab` | chrome.tabs / chrome.windows |
| `current_tab` | chrome.tabs / chrome.windows |
| `describe_element` | content script |
| `fill_selector` | content script |
| `find` | content script |
| `find_text` | content script |
| `focus_window` | chrome.tabs / chrome.windows |
| `get_page_content` | content script |
| `go_back` | chrome.tabs / chrome.windows |
| `go_forward` | chrome.tabs / chrome.windows |
| `group_tab` | chrome.tabs / chrome.windows |
| `hover` | content script |
| `list_tabs` | chrome.tabs / chrome.windows |
| `list_windows` | chrome.tabs / chrome.windows |
| `navigate` | chrome.tabs / chrome.windows |
| `net_clear` | chrome.webRequest |
| `net_get` | chrome.webRequest |
| `net_start` | chrome.webRequest |
| `net_stop` | chrome.webRequest |
| `new_tab` | chrome.tabs / chrome.windows |
| `press_key` | content script |
| `read_page` | content script |
| `read_pdf` | chrome.tabs / chrome.windows |
| `record_get` | chrome.tabs / chrome.windows |
| `record_start` | chrome.tabs / chrome.windows |
| `record_stop` | chrome.tabs / chrome.windows |
| `reload` | chrome.tabs / chrome.windows |
| `reload_extension` | chrome.tabs / chrome.windows |
| `replay` | chrome.tabs / chrome.windows |
| `scroll` | content script |
| `select_option` | content script |
| `snapshot` | content script |
| `storage_clear` | content script |
| `storage_get` | content script |
| `storage_remove` | content script |
| `storage_set` | content script |
| `switch_tab` | chrome.tabs / chrome.windows |
| `type` | content script |
| `ungroup_tab` | chrome.tabs / chrome.windows |
| `wait_for` | chrome.tabs / chrome.windows |
| `wait_network_idle` | chrome.webRequest |
| `wait_settle` | content script |

### Tier B — Conditional — has a non-debugger path

| Command | How it gets its capability |
|---|---|
| `eval_js` | CDP only if already attached; else chrome.scripting MAIN world (page CSP applies) |
| `screenshot` | active tab -> captureVisibleTab (no banner); BACKGROUND tab -> auto-attaches |

### Tier C — Requires an existing session — fails cleanly if attach is denied

| Command | How it gets its capability |
|---|---|
| `a11y_snapshot` | needs an existing session; errors cleanly if attach is blocked |
| `audit` | needs an existing session; errors cleanly if attach is blocked |
| `capture_screenshot` | needs an existing session; errors cleanly if attach is blocked |
| `cdp_send` | needs an existing session; errors cleanly if attach is blocked |
| `coordinate_click` | needs an existing session; errors cleanly if attach is blocked |
| `coordinate_drag` | needs an existing session; errors cleanly if attach is blocked |
| `delete_cookies` | needs an existing session; errors cleanly if attach is blocked |
| `element_screenshot` | needs an existing session; errors cleanly if attach is blocked |
| `export_har` | needs an existing session; errors cleanly if attach is blocked |
| `get_console_logs` | needs an existing session; errors cleanly if attach is blocked |
| `get_cookies` | needs an existing session; errors cleanly if attach is blocked |
| `get_network_requests` | needs an existing session; errors cleanly if attach is blocked |
| `get_response_body` | needs an existing session; errors cleanly if attach is blocked |
| `insert_text` | needs an existing session; errors cleanly if attach is blocked |
| `print_pdf` | needs an existing session; errors cleanly if attach is blocked |
| `set_cookie` | needs an existing session; errors cleanly if attach is blocked |

### Tier D — Acquires a session itself — these are what raise the banner

| Command | How it gets its capability |
|---|---|
| `cdp_attach` | auto-attaches — WILL raise the banner unprompted |
| `spoof_visibility` | auto-attaches — WILL raise the banner unprompted |
## What a per-site denial actually costs

Blocking the debugger on a site leaves **45 of 65 commands (tier A) fully working**: every
DOM read and interaction, the accessibility tree, refs, waits, tab/window management, light
network capture via `chrome.webRequest`, storage, record/replay, `read_pdf`.

Tier B degrades rather than fails:

- `eval_js` runs in the page's MAIN world via `chrome.scripting` instead of
  `Runtime.evaluate`. The only loss is CSP bypass — on a site with a strict CSP the eval
  may be refused by the page.
- `screenshot` still works via `chrome.tabs.captureVisibleTab` **when the tab is active**
  (that path has never used the debugger). Only a *background*-tab screenshot needs it.

Tier C (16 commands) stops working, but **fails cleanly** — those all call
`requireSession` / `requireDomains` and already produce "not attached: call cdp_attach
first". With a policy in place the message should say the site is forbidden, not that the
caller forgot to attach.

Tier D is the honest cost: `cdp_attach` (explicit intent, so refusing it is
straightforward) and `spoof_visibility`. Plus the background-tab branch of `screenshot`.

Net: on a forbidden site you lose console/network/HAR capture, pixel input, PDF print,
element screenshots, background-tab screenshots, cookie read/write, and CSP-bypass eval.
You keep everything needed to read and drive the page.

## Suggested shape, when it is built

1. **Storage.** A list of forbidden origin patterns in `chrome.storage.local`, editable on
   the options page. Not in page-reachable storage, and not in the bridge — a page must
   never be able to widen its own permissions, and the bridge has no auth (see README
   "Security").
2. **Matching.** Normalise both sides (lowercase, strip `www.`, bare domain → `<domain>/*`,
   glob `*` → `.*`), then test against `hostname + pathname`. The official extension's
   `blockedUrlPatterns` matcher is a clean copyable spec — see `prior-art.md` #9, which also
   notes it hot-reloads via `chrome.storage.onChanged`.
3. **Enforcement point 1 — `attach(tabId)`.** Look up the tab's URL, and if forbidden throw
   a message that names the tier-A/B alternative rather than a bare denial, e.g.
   *"chrome.debugger is not permitted on example.com by policy. DOM reads and interaction
   still work; for a screenshot, foreground the tab (captureVisibleTab needs no debugger)."*
4. **Enforcement point 2 — `chrome.tabs.onUpdated`.** If a tab with a live session
   navigates into a forbidden origin, detach immediately. Without this, the session and
   banner survive the navigation.
5. **Report it.** Add the policy verdict to `browser_status` so an agent can see the site is
   restricted before it plans a CDP-dependent route.
6. **Fail closed on an unreadable URL.** If the tab URL cannot be determined, treat it as
   forbidden — the opposite of `requireForegroundForInput`, which deliberately fails *open*
   on a lookup failure because there the cost of a false block is a broken command, not a
   policy breach.

Not recommended: silently downgrading a tier-C command to a non-debugger approximation. The
project's stated principle is that a command never reports success for something it did not
do — see the foreground-input guard in `PROTOCOL.md` v0.5.

## Re-derive this classification

```bash
# prints the tier of every action, straight from the routing tables and handler bodies
python3 - <<'EOF'
import re, pathlib
cdp = pathlib.Path("extension/cdp.js").read_text()
bg  = pathlib.Path("extension/background.js").read_text()
body = cdp[cdp.index("export async function handleCdp"):]
for p in re.split(r'\n    case "', body)[1:]:
    name = p[:p.index('"')]
    blk = p[:p.find('\n    case "')] if '\n    case "' in p else p
    tier = ("D auto-attach" if "ensureAttached(" in blk
            else "C needs-session" if re.search(r'require(Session|Domains)', blk)
            else "B/A conditional")
    print(f"{name:24s} {tier}")
EOF
```
