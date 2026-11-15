# Tools

Generated from the tool registry by `node scripts/tools-doc.js`; do not edit by hand. The specs in
`specs/tools/` define each tool; this page is what agents and scripts see.

## `status`

Show connected browsers, setup problems, your tabs, and where Chrome's debugging bar comes from. Call it first when a tool reports NO_BROWSER, USER_SCRIPTS_OFF or DEBUGGER_CANCELED.

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `allowDebugger` | boolean | no | `false` |  | Clear DEBUGGER_CANCELED after asking the user. |

## `tabs`

Manage tabs. action: list | new | select | close | adopt | release. New tabs open in the background and become your current tab. adopt takes an existing tab (e.g. one the user opened) so you can act on it. select with focus: true shows the tab to the user.

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `action` | `"list"`, `"new"`, `"select"`, `"close"`, `"adopt"`, `"release"` | yes |  |  |  |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |
| `url` | string | no |  |  | For new: the page to open. |
| `focus` | boolean | no | `false` |  | For select: bring the tab and its window to the front. |
| `force` | boolean | no | `false` |  | For adopt: take a tab another session holds. |
| `browser` | string | no |  |  | Browser alias from status, when several are connected. |
| `all` | boolean | no | `false` |  | For list: every tab, not only yours. |

## `navigate`

Open a URL in your current tab (opens a background tab if you have none), or action: back | forward | reload. Waits for the page to load. Does not change what the user is looking at.

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `url` | string | no |  |  | Absolute URL, or a host (https:// is added). |
| `action` | `"back"`, `"forward"`, `"reload"` | no |  |  |  |
| `wait` | object | no |  | keys: text, textGone, target, state, url, time, timeout | Then wait for one wait_for condition. |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |

## `snapshot`

Read the page as an accessibility tree (YAML); each element you can act on has a ref ([ref=e5]) to pass as target to click, type, fill_form, evaluate. A ref stays valid until its element is removed or the page navigates. Extra brackets tell state: [empty], [type=email], [value=42], [near="label"] for unnamed fields, [ctx="..."] to tell identical buttons apart, [modal], [hidden] (no ref: open its menu first). Long lists and long text are folded; each fold line says how to see the rest (read target=eX). target: a ref to read only that part. If the first line says the page is not ready, snapshot again. Works in background tabs without the debugging bar.

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | no |  |  | Snapshot only this element's subtree. |
| `depth` | integer | no |  | 1 to 50 | Cut the tree below this depth. Default: no limit. |
| `full` | boolean | no | `false` |  | Skip compaction and text folding. |
| `maxChars` | integer | no | `20000` | 1000 to 200000 | Size budget; long text is folded harder before anything is cut. |
| `maxText` | integer | no | `2000` | 200 to 200000 | Characters of running text kept before it is folded. |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |

## `read`

Read the page (or target) as text: headings, paragraphs, lists, full tables, links, and form fields with their values and refs. main: true skips navigation and footers. Long pages come in slices: pass nextOffset as offset to continue.

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | no |  |  | Read only this element. |
| `main` | boolean | no | `false` |  | Only the main content (main, [role=main], or the largest article). |
| `offset` | integer | no | `0` | at least 0 |  |
| `maxChars` | integer | no | `20000` | 1000 to 200000 |  |
| `links` | boolean | no | `true` |  | Write links as [text](url). |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |

## `get`

Read one thing about an element: what: text (default) | value | attribute | property | html | state | box; name: the attribute or property (href, dataset.id). target: a ref or a locator. all: true returns every match of a selector. Use it instead of evaluate to read a value.

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | yes |  |  | A ref (e5) or a locator (#id, label=Email, role=button[name="Save"], ...). |
| `what` | `"text"`, `"value"`, `"attribute"`, `"property"`, `"html"`, `"state"`, `"box"` | no | `"text"` |  |  |
| `name` | string | no |  |  | Attribute name, or property path (dataset.id), for what: attribute \| property. |
| `all` | boolean | no | `false` |  | Every element the selector matches (at most 100) instead of AMBIGUOUS_TARGET. |
| `maxChars` | integer | no | `5000` | 100 to 200000 | Cut text and html values. |
| `timeout` | number | no | `5` | 0 to 60 | Seconds to wait for the target to exist (it need not be visible). |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |

## `click`

Click an element (target: ref or locator). Works in background tabs. trusted: true sends real mouse input for sites that ignore synthetic clicks (shows Chrome's debugging bar). Returns the element hit and what changed (url, new tabs, dialogs, DOM).

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | yes |  |  | A ref (e5) or a locator (#id, label=Email, role=button[name="Save"], ...). |
| `button` | `"left"`, `"middle"`, `"right"` | no | `"left"` |  |  |
| `doubleClick` | boolean | no | `false` |  |  |
| `modifiers` | `"Alt"`, `"Control"`, `"Meta"`, `"Shift"`[] | no | `[]` |  |  |
| `timeout` | number | no | `5` | 0 to 60 | Seconds to wait for the target. |
| `scroll` | `"auto"`, `"center"`, `"none"` | no | `"auto"` |  |  |
| `wait` | object | no |  | keys: text, textGone, target, state, url, time, timeout | Then wait for one wait_for condition. |
| `trusted` | boolean | no | `false` |  | Real input through Chrome's debugger (shows its debugging bar). |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |

## `hover`

Hover over an element to open its menu or tooltip. Menus that open only through CSS :hover need trusted: true (real pointer; shows Chrome's debugging bar).

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | yes |  |  | A ref (e5) or a locator (#id, label=Email, role=button[name="Save"], ...). |
| `timeout` | number | no | `5` | 0 to 60 | Seconds to wait for the target. |
| `scroll` | `"auto"`, `"center"`, `"none"` | no | `"auto"` |  |  |
| `wait` | object | no |  | keys: text, textGone, target, state, url, time, timeout | Then wait for one wait_for condition. |
| `trusted` | boolean | no | `false` |  | Real input through Chrome's debugger (shows its debugging bar). |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |

## `type`

Replace the text of an input, textarea or rich-text field. target: a ref or selector. submit: true presses Enter after. slowly: true types key by key for autocomplete fields. Returns the field's value afterwards.

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | yes |  |  | A ref (e5) or a locator (#id, label=Email, role=button[name="Save"], ...). |
| `text` | string | yes |  |  |  |
| `submit` | boolean | no | `false` |  |  |
| `slowly` | boolean | no | `false` |  |  |
| `timeout` | number | no | `5` | 0 to 60 | Seconds to wait for the target. |
| `scroll` | `"auto"`, `"center"`, `"none"` | no | `"auto"` |  |  |
| `wait` | object | no |  | keys: text, textGone, target, state, url, time, timeout | Then wait for one wait_for condition. |
| `trusted` | boolean | no | `false` |  | Real input through Chrome's debugger (shows its debugging bar). |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |

## `fill_form`

Set several form controls at once: fields: [{target, value}]. value is a string for text fields and selects (option value or label), true/false for checkboxes, radios and switches, a list for multi-selects. Stops at the first field that fails and says which.

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `fields` | object[] | yes |  | 1 to 50 items |  |
| `timeout` | number | no | `5` | 0 to 60 | Seconds to wait for the target. |
| `scroll` | `"auto"`, `"center"`, `"none"` | no | `"auto"` |  |  |
| `wait` | object | no |  | keys: text, textGone, target, state, url, time, timeout | Then wait for one wait_for condition. |
| `trusted` | boolean | no | `false` |  | Real input through Chrome's debugger (shows its debugging bar). |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |

## `press_key`

Press a key or chord (Enter, Escape, Tab, ArrowDown, Control+A) on target or on the focused element. Enter submits forms, Tab moves focus. trusted: true for keys a site handles only from real keyboards.

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `key` | string | yes |  |  |  |
| `target` | string | no |  |  | Optional: element to press on; default the focused one. |
| `timeout` | number | no | `5` | 0 to 60 | Seconds to wait for the target. |
| `wait` | object | no |  | keys: text, textGone, target, state, url, time, timeout | Then wait for one wait_for condition. |
| `trusted` | boolean | no | `false` |  | Real input through Chrome's debugger (shows its debugging bar). |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |

## `scroll`

Scroll the page or a container (target), by direction and amount, or to: top | bottom; or bring target into view. Reports whether the end was reached and whether more content loaded. trusted: true uses real wheel input, needed for lazy loading in background tabs.

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `direction` | `"up"`, `"down"`, `"left"`, `"right"` | no |  |  |  |
| `amount` | number | no |  | 1 to 100000 |  |
| `to` | `"top"`, `"bottom"` | no |  |  |  |
| `target` | string | no |  |  | A scrollable container, or an element to bring into view. |
| `timeout` | number | no | `5` | 0 to 60 | Seconds to wait for the target. |
| `wait` | object | no |  | keys: text, textGone, target, state, url, time, timeout | Then wait for one wait_for condition. |
| `trusted` | boolean | no | `false` |  | Real input through Chrome's debugger (shows its debugging bar). |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |

## `wait_for`

Wait for text to appear (text) or disappear (textGone), for target to become visible / hidden / attached / detached, for the URL to match (url), or for time seconds. timeout defaults to 10 s.

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `text` | string | no |  |  |  |
| `textGone` | string | no |  |  |  |
| `target` | string | no |  |  | A ref (e5) or a locator (#id, label=Email, role=button[name="Save"], ...). |
| `state` | `"visible"`, `"hidden"`, `"attached"`, `"detached"` | no | `"visible"` |  |  |
| `url` | string | no |  |  | Substring of the URL, or /regex/. |
| `time` | number | no |  | 0.1 to 60 |  |
| `timeout` | number | no | `10` | 0.1 to 60 |  |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |

## `take_screenshot`

Screenshot the viewport, the full page (fullPage: true) or one element (target). Saved to a file; the path is returned. Background tabs and full pages use Chrome's debugging bar briefly.

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | no |  |  | A ref (e5) or a locator (#id, label=Email, role=button[name="Save"], ...). |
| `fullPage` | boolean | no | `false` |  |  |
| `format` | `"jpeg"`, `"png"` | no |  |  | Default: from path's extension, else jpeg. |
| `path` | string | no |  |  | Absolute path to save to. |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |

## `file_upload`

Attach local files (absolute paths) to a file input or to the upload button that opens a file chooser. paths: [] clears it. Returns the files as the page sees them.

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | yes |  |  | A ref (e5) or a locator (#id, label=Email, role=button[name="Save"], ...). |
| `paths` | string[] | yes |  |  |  |
| `timeout` | number | no | `5` | 0 to 60 | Seconds to wait for the target. |
| `wait` | object | no |  | keys: text, textGone, target, state, url, time, timeout | Then wait for one wait_for condition. |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |

## `handle_dialog`

Set how dialogs in your tab are answered: accept: true/false, promptText, scope: next | always. By default alert is accepted and confirm/prompt are dismissed; actions report each dialog and the answer given. To accept a dismissed confirm, call this and repeat the action.

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `accept` | boolean | yes |  |  |  |
| `promptText` | string | no |  |  |  |
| `scope` | `"next"`, `"always"` | no | `"next"` |  |  |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |

## `evaluate`

Run JavaScript in the page (page globals available). function: "() => document.title", or "(el) => el.value" with target: a ref. Promises are awaited. Use it whenever no other tool fits.

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `function` | string | yes |  |  |  |
| `target` | string | no |  |  | A ref (e5) or a locator (#id, label=Email, role=button[name="Save"], ...). |
| `trusted` | boolean | no | `false` |  | Real input through Chrome's debugger (shows its debugging bar). |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |

## `run`

Run Playwright code for anything the other tools do not cover (drag, coordinates, routes, cookies, emulation, loops). page, context and a persistent state object are in scope; return a value. Shows Chrome's debugging bar while running.

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `code` | string | yes |  |  |  |
| `timeout` | number | no | `60` | 1 to 600 |  |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |

## `network_requests`

List the tab's network requests (filter, types, since, limit) or one request's details (id). Response bodies need captureBodies: true first (shows Chrome's debugging bar until turned off). To call an API with the page's cookies, use evaluate with fetch.

| Parameter | Type | Required | Default | Limits | Meaning |
| --- | --- | --- | --- | --- | --- |
| `filter` | string | no |  |  | Substring of the URL, or /regex/. |
| `types` | `"document"`, `"xhr"`, `"script"`, `"stylesheet"`, `"image"`, `"media"`, `"font"`, `"websocket"`, `"other"`[] | no |  |  | xhr covers fetch too. |
| `since` | integer | no |  | at least 0 |  |
| `limit` | integer | no | `50` | 1 to 500 |  |
| `id` | integer | no |  | at least 1 |  |
| `body` | boolean | no | `false` |  |  |
| `captureBodies` | boolean | no |  |  |  |
| `tab` | integer | no |  | at least 0 | Tab id from tabs list. Default: your current tab. |
