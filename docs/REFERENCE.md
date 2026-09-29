# browserctl Core Tool Reference — v0.9.2

browserctl provides 25 core tools (69 tools across all profiles) for web automation and agent inspection.

## Targeting an element

Every tool that acts on an element takes one parameter, `target`. It accepts five forms, and a
bare string is resolved in this order:

| | Form | Example |
| :--- | :--- | :--- |
| 1 | a ref from a read | `"@ref_5"`, `"ref_5"` |
| 2 | a string carrying CSS syntax — `# . [ ] > + ~ :` or a descendant space | `"#login"`, `".btn.primary"`, `"[data-id=x]"` |
| 3 | the exact visible text of a control | `"Sign in"` |
| 4 | an exact `placeholder` or `aria-label` | `"Search the docs"` |
| 5 | part of a control's visible text | `"Sign"` |
| 6 | a bare tag name, only if nothing above matched | `"tbody"` |

A bare word is tried as text **before** it is tried as a tag name. `search`, `main`, `menu`,
`details`, `summary`, `output` and `time` are all valid HTML tags *and* common button labels; the
control a person can see wins.

**Prefixes force one step**, when the guess would be wrong or you want to be explicit:

    css=#row-3        text=Save Draft        placeholder=Email        index=7

A snapshot index can also be passed as a number: `target: 7`.

**Ambiguity is an error, not a coin flip.** If more than one element matches, the call fails and
returns up to five candidates with their refs, tags and labels. Narrow the string, or use the ref.
The one exception is an explicit `css=`, which follows normal CSS rules and acts on the first
match — but still reports how many it saw.

**Every action tells you what it hit:**

```json
"resolved": {"by": "text-exact", "ref": "@ref_12", "tag": "button",
             "label": "Sign in", "matchCount": 1}
```

`by` is one of `ref`, `css`, `text-exact`, `placeholder`, `text-substring`, `index`. Read it
alongside `effect` to confirm the call landed where you meant, without taking a screenshot.

**Refs go stale.** They come from a read and are invalidated by navigation, submission or a
re-render. A stale ref is refused rather than re-pointed at whatever now occupies that position;
where the old label can still be found, the error names the ref that replaced it.

## Several browsers

One bridge serves every connected browser and profile at once — nothing to configure. Each MCP
session keeps a **target**: the browser and tab that session is driving. The agent never passes
it; the server applies it to every call automatically.

- The first call of a session resolves the target: the browser last focused by the user, or the
  sole browser if only one is connected, and in it the tab the user sees (the active tab of its
  focused window) — never a tab another session selected in the background. With several browsers connected and
  none focused, the call fails with `NEEDS_BROWSER`, naming the connected browsers.
- The target is then sticky: later focus changes elsewhere do not move it. It changes only through
  `browser_tabs({action: "select", ...})` or `browser_tabs({action: "new", ...})`.
- `tabId` (already documented above) is the per-call, cross-browser override: a call carrying it
  acts on that tab once, without moving the session's target. The server finds which browser owns
  the id; an id open in two browsers is `AMBIGUOUS_TAB`.

`browser_tabs` gains three parameters for this:

- `browser` (`'list'`, `'select'`, `'new'`): which browser, by alias (`"chrome-1"`), label (set in
  the extension's Options), `instanceId`, or type (`"chrome"`, `"edge"` — matches only when
  exactly one connected browser has that type; two is `AMBIGUOUS_BROWSER`, naming both). `new`
  without `browser` opens in the session's target browser if one is set (or the browser a closed
  target was in), else the bridge's own default (the sole connection, or last-focused).
- `query` (`'list'`): keep only tabs whose title or URL contains this text, case-insensitive.
- `activate` (`'select'`, `'new'`): make the tab the visible tab of its window (default `false` —
  selecting or opening a tab does not raise it, so a background session does not disturb what the
  user is looking at).

`browser_tabs({action: "list"})` always fans out to every connected browser, even with one
connected, and returns `{tabs, browsers, target}`: `tabs` (each carrying `browser`), `browsers`
(every connected browser's alias, type, label and reachability), and `target` (the session's
current `{browser, tabId}`, or `null`).

Error codes from browser routing: `NEEDS_BROWSER` (no target and no focus to resolve one),
`AMBIGUOUS_BROWSER` (a `browser` selector matches more than one connected browser),
`AMBIGUOUS_TAB` (a `tabId` is open in more than one browser), `TARGET_CLOSED` (the session's
target tab was closed — nothing falls back to another tab, and the session stays without a target
until `browser_tabs` select or new), `BROWSER_DISCONNECTED` (the session's target browser
disconnected — calls keep failing with it, and resume on the same tab when that browser
reconnects), `UNKNOWN_BROWSER` (a
`browser` selector matches none), `NO_BROWSER` (no browser is connected at all).

## Navigation & Tabs

### browser_navigate
- url: Destination URL to navigate to.
- reload: Boolean flag to reload the current page.
- format: Output format ('json', 'pretty', 'smart', 'raw').

### browser_tabs
- action: Tab operation ('list', 'new', 'select', 'close').
- tabId: Which tab — for 'select' (or give `browser`) and required for 'close'.
- url: URL for new tab when action is 'new'.
- browser: Which browser, by alias, label, instanceId or type — for 'list', 'select' and 'new'.
  'new' without `browser` opens in the session's current target browser if one is set, else the
  bridge's own default (the sole connection, or last-focused).
- query: For 'list', keep only tabs whose title or URL contains this text (case-insensitive).
- activate: For 'select' and 'new', make the tab the visible tab of its window (default false).

In a `list` result, a tab the browser has frozen in the background carries `frozen: true`, and one it
has discarded to save memory carries `discarded: true`. A command on a frozen tab wakes it first. A
command on a discarded tab fails with a hint to reload it (`browser_navigate({reload: true})`),
because a reload loses any unsaved input on that page.

## Inspection & Extraction

### browser_snapshot
- scope: 'viewport' (default) or 'all' elements in DOM.
- compact: Compact representation folding repetitive items.
- maxText: Maximum text length for element labels.
- limit: Maximum number of elements to include in census.
- cursor: Offset cursor for paged snapshot traversal.
- format: Output format.

### browser_read_page
- mode: Inspection mode.
- depth: Maximum tree depth.
- target: Ref of the subtree to inspect from.
- maxChars: Maximum character limit.
- format: Output format.

### browser_find
- query: Text or query string to search for.
- selector: CSS selector to locate elements.
- in: Search scope ('controls' or 'text').
- regex: Boolean flag indicating if query is regular expression.
- contextChars: Number of context characters surrounding match.
- max: Maximum number of matches to return.
- format: Output format.

### browser_extract
- selector: Container CSS selector.
- fields: Object defining fields to extract per item.
- max: Maximum number of items to extract.
- format: Output format.

### browser_get_content
- maxChars: Maximum characters of readable article/page text to return.
- format: Output format.

### browser_get_property
- target: Target element (@ref, CSS selector, visible text, or index).
- property: Property name to read ('text', 'value', 'html', 'box', 'attr', 'count', 'checked'). 'checked' is true or false for a checkbox or radio and an error for any other element; for a custom control, read its aria-checked attribute with 'attr'.
- attr: HTML attribute name when property is 'attr'.
- format: Output format.

## Native dialogs — experimental, not part of the core surface

`alert()`, `confirm()` and `prompt()` suspend the page's JavaScript the moment they open, while
the click that raised one is still running, so they cannot be answered after the fact.

**What the core surface does:** nothing is ever answered on your behalf, and no core tool carries
a dialog parameter. If a debugger is attached and a call raises a dialog, that call returns
`DIALOG_BLOCKED` naming the type and the message instead of hanging. That guard is free — it adds
no parameter to any tool.

**Answering one is behind the `cdp` profile**, because the feature is unfinished:

- `browser_handle_dialog` answers a dialog that is already open; bare, or `action: "peek"`, reads
  it without answering.
- To answer one raised by your own click, that click needs `onDialog`, which is reachable through
  `browser_action({action: "click", params: {target, onDialog: "accept", promptText}})`.

Chrome allows one debugger per tab, so answering is refused while DevTools is open on that tab
(or another automation tool holds it); the error says so and names the fix. The same applies to
`browser_file_upload`, `browser_cdp_send` and anything else needing the debugger.

ARIA modals (`role="dialog"`, `<dialog>`) are ordinary DOM and none of this applies: they appear
in `browser_snapshot` under `pageState.openDialogs` and close with a `browser_click`.

## Interaction & Input

### browser_click
- target: Target element.
- doubleClick: Boolean flag for double clicking.
- button: Mouse button ('left', 'right', 'middle').
- waitFor: CSS selector to wait for after the click, e.g. a modal that should appear.
- autoSettle: Boolean flag to automatically wait for DOM mutations to settle.
- settleMs: Milliseconds to wait during auto settle.
- format: Output format.

### browser_type
- target: Target element.
- text: Text to type into target.
- method: Typing method ('type', 'set', 'paste').
- submit: Press enter to submit after typing.
- waitFor: CSS selector to wait for after typing.
- autoSettle: Automatically wait for DOM to settle.
- settleMs: Settling timeout in milliseconds.
- format: Output format.

### browser_fill_form
- fields: Array of field descriptors containing target and value.
- submitTarget: Optional target of submit button to click after filling.
- format: Output format.

### browser_select_option
- target: Target <select> element.
- values: Array of option values to select.
- value: Single option value to select.
- option: Option text or value to select.
- label: Option label to select.
- format: Output format.

### browser_press_key
- key: Key name or chord to send (e.g. 'Enter', 'Tab', 'Escape').
- target: Optional target element.
- modifiers: Modifier keys ('Control', 'Shift', 'Alt', 'Meta').
- allowSynthetic: Allow synthetic key events.
- format: Output format.

### browser_scroll
- direction: Scroll direction ('down', 'up', 'left', 'right').
- amount: Pixels to scroll.
- target: Target element or scrollable container.
- format: Output format.

### browser_file_upload
- target: Target file input element.
- files: Array of file paths to attach.
- file: Single file path to attach.
- format: Output format.

### browser_hover
- target: Target element.
- format: Output format.

## Synchronization & Utility

### browser_wait_for
- for: What to wait for ('settle', 'selector', 'text'). Network idle is browser_wait_network_idle, in the network profile.
- selector: CSS selector to wait for.
- text: Text content to wait for.
- gone: Boolean flag to wait for target to disappear.
- timeoutMs: Maximum milliseconds to wait.
- format: Output format.

### browser_take_screenshot
- fullPage: Boolean flag for capturing full scrollable page.
- target: Target element selector or ref to screenshot.
- format: Image format ('jpeg', 'png').
- quality: JPEG image quality (0-100).

The visible tab of its window is captured directly. Any other tab, and any tab the debugger is
already attached to that is not the active tab of a focused window, is captured through CDP with
focus emulation on for the moment of the capture, so Chrome, Brave and Edge all return it without
the tab coming to the front. The page sees `visibilitychange` to visible and back. A browser that
still paints nothing fails the capture after 5 s with a hint to select the tab with
`activate: true` first.

### browser_evaluate
- expression: JavaScript expression to evaluate in page context.
- format: Output format.

### browser_action
- action: Name of protocol action to dispatch.
- params: Action parameters object.
- format: Output format.

### browser_load_tools
- profile: Name of profile to load ('network', 'cdp', 'cookies', 'storage', 'console', 'record', 'all').
- tools: Array of specific tool names to load.
- format: Output format.

### browser_list_available_tools
- format: Output format.

## Daemon & Session

### browser_status
- format: Output format.

### browser_start
- (none)

### browser_stop
- (none)
