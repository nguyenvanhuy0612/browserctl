# browserctl Core Tool Reference — v0.8.0

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

## Navigation & Tabs

### browser_navigate
- url: Destination URL to navigate to.
- reload: Boolean flag to reload the current page.
- format: Output format ('json', 'pretty', 'smart', 'raw').

### browser_tabs
- action: Tab operation ('list', 'new', 'select', 'close').
- tabId: Which tab — required for 'select' and 'close'.
- url: URL for new tab when action is 'new'.

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
- property: Property name to read ('text', 'value', 'html', 'box', 'attr', 'count').
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
