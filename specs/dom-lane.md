# DOM lane

Status: verified (2026-11-21: ref numbering continues across documents; `info` content count)
Depends on: `architecture.md`, `targets.md`

The default way of operating a page: no `chrome.debugger`, so no debugging bar.

## Runtime

- `pw-injected.js`: Playwright's injected script, extracted from the pinned `playwright-core` by
  a build script (never edited by hand). The build emits the `InjectedScript` class; the runtime
  creates one instance per frame with that frame's sequence number (`frameSeq`), which Playwright
  uses as the ref prefix (`f2e7`). The same build step extracts Playwright's US keyboard layout for
  `press_key`. The build also exposes Playwright's ref counter to the runtime
  (`__bctlRefCounter`, isolated world only): `init` raises it to the tab's highest ref number,
  which the extension passes in, and every operation's answer carries the counter (`refHigh`),
  which the extension records and strips (`targets.md`). It supplies the aria snapshot with refs, the selector
  engines, `elementState`, `expectHitTarget`, `dispatchEvent`, `fill`, `selectOptions`,
  `setInputFiles`.
- `runtime.js`: ours. The operations below, built on the injected script. Every operation
  returns `{ok: true, ...}` or `{ok: false, code, message}`; nothing throws out of the page.
- Both are injected with `chrome.scripting.executeScript({files})` into the extension's isolated
  world, in every frame, on first use after each document load. Injection is idempotent.
  Measured: first call on Facebook 119 ms including injection, later calls 40 ms.
- The isolated world is immune to page globals (`window.Node` removed, `innerWidth` corrupted).
- Closed shadow roots of custom elements are walked like open ones: in the isolated world only,
  the runtime makes `Element.prototype.shadowRoot` answer, for an element whose name has a hyphen
  and no open root, `chrome.dom.openOrClosedShadowRoot(element)`, so Playwright's engines and the
  runtime see into them for snapshots, selectors, actions and `read`; the page's own `shadowRoot`
  is untouched. Measured 2026-11-21: a closed root's text was missing from both `snapshot` and
  `read` before; asking `chrome.dom` for every element made a 20,000-element snapshot 30% slower
  (2.1 s instead of 1.6 s), asking only for custom elements costs nothing measurable. Closed roots
  on built-in hosts (`div`, `span`, `section`, ...) are left out: components put them on custom
  elements.

## Operations

The runtime's whole surface, called as `dom.call({tabId, frameId?, op, args})`. Every operation
returns `{ok: true, ...}` or `{ok: false, code, message}`; checks are one try, the daemon polls.

| Operation | What it does |
| --- | --- |
| `info()` | URL, title, `visibilityState`, `readyState`, document age, frame sequence number, scroll position, and the mutation counts the daemon reads: `mutations` (every change), `content` (nodes added or removed, text changed; `settle.md`) and `structure` (nodes added or removed; snapshot readiness) |
| `snapshot({depth?, root?})` | aria snapshot, `mode: "ai"`, with the facts of `tools/snapshot.md` |
| `read({target?, main?, links?})` | the text of `tools/read.md` |
| `resolve(target)` | ref or selector to one element, strict; its description |
| `get(target, what, name?, all?)` | `tools/get.md` |
| `elementState(target)` | `visible`, `hidden` or `detached`, with the element's description (`wait_for`) |
| `findText(text)` | whether visible text is on the page, and the element holding it (`wait_for`) |
| `click(target, {button, doubleClick, modifiers, scroll, attempt})` | actionability and the event sequence in `tools/click.md` |
| `hover(target, {scroll, attempt})` | actionability and the hover events in `tools/hover.md` |
| `fill(target, value, {scroll, attempt})` | Playwright `fill`; text inputs and textareas through the prototype `value` setter plus `beforeinput`/`input`/`change` (React value trackers see it); contenteditable through `execCommand("insertText")`, returning a `readBack` token for it; clearing an empty field sends nothing |
| `typeChars(target, chars)` | `type` with `slowly`: the key events of each character (`tools/type.md`) |
| `readBack(token)` | the text of the element a `fill` or `typeChars` typed into, without resolving the target again (`tools/type.md`, step 6); `REF_NOT_FOUND` when the element left the page |
| `press(target?, key, modifierKeys)` | synthetic key events with the default action emulated (`tools/press_key.md`) |
| `kind(target)` | what `fill_form` sets: text, select (`multiple`), checkable (native radio, checked, through the label's control), file |
| `select(target, values, {scroll, attempt})` | Playwright `selectOptions` |
| `check(target, checked, {scroll, attempt})` | click if the state differs, then verify (`tools/fill_form.md`) |
| `findFileInput(target)` / `setFiles(target, files)` | the file input of a target; Playwright `setInputFiles` with file contents sent from the daemon |
| `scroll({target?, direction?, amount?, to?})` / `scrollMetrics(target?)` | `scrollBy` / `scrollTo` on the element or the page; the scroll height after settle |
| `box(target)` | the element scrolled into view and its rectangle, for a DOM-lane screenshot crop |
| `historyGo(delta)` | `history.go` for `navigate` back and forward |
| `mark(target, {control?})` / `unmark(nonce)` | the one-time marker for the CDP lane (`targets.md`) |
| `armDialogs(policy)` / `dialogLog(since)` | the shim channel below |

- A call that reaches a document while it is being replaced (a navigation; Chrome: "Frame with
  ID 0 was removed", measured 2026-11-15 in Playwright CL-067: about one run in three) is repeated
  on the new document, every 100 ms for at most 2 s, then `TIMEOUT`. In a child frame the frame is
  gone for good: `REF_NOT_FOUND`.

## Evaluate

- Through `chrome.userScripts.execute` in the page's MAIN world: not bound by the page's CSP
  (spike: works on Facebook and GitHub, where `chrome.scripting` with `eval` is blocked).
- Needs "Allow User Scripts" on the extension. When it is off: `USER_SCRIPTS_OFF`, hint offers
  `trusted: true` (CDP lane `Runtime.evaluate`).

## Dialogs

- `dialog-shim.js` runs in the MAIN world at `document_start` in every frame. It replaces
  `alert`, `confirm` and `prompt`, and stays inert (calls the originals) unless the daemon armed a
  policy on that document, so pages the agent does not own are untouched.
- The daemon arms every owned tab after each document load with the tab's policy
  (`tools/handle_dialog.md`; default: `alert` accepted, `confirm` and `prompt` dismissed). Every
  dialog is logged and reported by the action that opened it.
- The policy and the log travel through attributes on `<html>`, the only channel between the
  isolated and the MAIN world.
- `beforeunload`: in an armed document the shim makes `BeforeUnloadEvent.preventDefault()`, the
  `returnValue` setter and a value returned by an `onbeforeunload` handler no-ops (a handler set
  on `window`, on `document.body`, or by the `<body onbeforeunload>` attribute, which the shim
  wraps at `DOMContentLoaded`), so
  the page's handlers still run (drafts saved on unload are kept) but Chrome never asks "Leave
  site?" and the tab leaves the page. Measured 2026-11-15 on Chrome for Testing 158: after real
  input, Chrome queues a background tab's `beforeunload` dialog until the user activates the tab,
  and meanwhile the page answers neither the DOM lane nor the debugger; a debugger attached after
  the dialog opened neither sees it nor answers it (`Page.enable` hangs,
  `Page.handleJavaScriptDialog` says no dialog is showing). An agent's tab cannot wait for that.
- Not covered: a dialog a page opens before the daemon armed the document (an `alert` in an inline
  script) in the active tab of a focused window, the only place such a dialog blocks; the same
  measurement shows nothing can answer it but the user. DOM-lane calls on that tab time out with a
  hint that names the dialog (`errors.md`, `TIMEOUT`).
- Measured: in a background tab Chrome suppresses native dialogs (owner's Chrome 157: a timer
  `alert` returned in milliseconds, the page went on, CDP saw no dialog; Chrome for Testing 158 the
  same, also for the active tab of an unfocused window). Without the shim the agent would never
  learn a dialog happened, and a `confirm` would silently answer false. The shim makes the answer
  the tab's policy and reports it. A dialog that does block (the active tab of a focused window,
  unarmed) is left to the user.

## Limits

| Limit | Consequence |
| --- | --- |
| events are `isTrusted: false` | sites that check it need `trusted: true` |
| background tabs do not render | IntersectionObserver lazy load, animations and `requestAnimationFrame` work stop; scroll-to-load-more in a background tab needs the CDP lane (focus emulation) |
| no stable-position check | needs animation frames; the CDP lane has it |
| restricted pages | `PAGE_UNSCRIPTABLE` |

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| DOM-U01 | unit | a `dom.call` answered "frame removed" once in the main frame; the same in a child frame | the call is repeated and succeeds; `REF_NOT_FOUND` |
| DOM-E01 | live | first operation on a fresh document | runtime injected once, operation works |
| DOM-E02 | live | operation after navigation | re-injected |
| DOM-E03 | live | page deletes `window.Node`, overrides `addEventListener` | operations unaffected |
| DOM-E04 | live | React-style tracked input, contenteditable | input events seen by the page |
| DOM-E05 | live | armed `confirm`, unarmed tab with `confirm` | armed answered and logged; unarmed shows the real dialog |
| DOM-E06 | live | strict-CSP page, `evaluate` | works through userScripts; `USER_SCRIPTS_OFF` when disabled |
| DOM-E07 | live | background tab: snapshot, click, fill, scroll | all work; no debugger attached at any point |
| DOM-E08 | live | `chrome://settings` tab | `PAGE_UNSCRIPTABLE` |
| DOM-E09 | live | focused tab whose page opened an `alert` while loading (before arming) | DOM-lane calls fail with `TIMEOUT` and the page-blocked hint; `tabs close` closes the tab |
| DOM-S01 | site | Facebook in a background tab: snapshot, type in the search box, hover, evaluate, the request log | no debugger attached (no bar) |
