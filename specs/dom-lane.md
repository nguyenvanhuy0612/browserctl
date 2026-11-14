# DOM lane

Status: approved
Depends on: `architecture.md`, `targets.md`

The default way of operating a page: no `chrome.debugger`, so no debugging bar.

## Runtime

- `pw-injected.js`: Playwright's injected script, extracted from the pinned `playwright-core` by
  a build script (never edited by hand). The build emits the `InjectedScript` class; the runtime
  creates one instance per frame with that frame's sequence number (`frameSeq`), which Playwright
  uses as the ref prefix (`f2e7`). The same build step extracts Playwright's US keyboard layout for
  `press_key`. It supplies the aria snapshot with refs, the selector
  engines, `elementState`, `expectHitTarget`, `dispatchEvent`, `fill`, `selectOptions`,
  `setInputFiles`.
- `runtime.js`: ours. The operations below, built on the injected script. Every operation
  returns `{ok: true, ...}` or `{ok: false, code, message}`; nothing throws out of the page.
- Both are injected with `chrome.scripting.executeScript({files})` into the extension's isolated
  world, in every frame, on first use after each document load. Injection is idempotent.
  Measured: first call on Facebook 119 ms including injection, later calls 40 ms.
- The isolated world is immune to page globals (`window.Node` removed, `innerWidth` corrupted).

## Operations

| Operation | What it does |
| --- | --- |
| `snapshot({depth?, root?})` | aria snapshot, `mode: "ai"` |
| `resolve(target)` | ref or selector to one element, strict |
| `actionable(target)` | attached, visible, enabled, non-inert, scrolled into view, hit test at the centre; one check, the daemon polls |
| `click(target, {button, doubleClick, modifiers})` | the event sequence in `tools/click.md` |
| `fill(target, value)` | Playwright `fill`; text inputs and textareas through the prototype `value` setter plus `beforeinput`/`input`/`change` (React value trackers see it); contenteditable through `execCommand("insertText")` |
| `press(target?, key, modifiers)` | synthetic `keydown`/`keypress`/`keyup`; Enter in a form also calls `requestSubmit()` |
| `select(target, values)` | Playwright `selectOptions` |
| `check(target, checked)` | click if the state differs, then verify |
| `setFiles(target, files)` | Playwright `setInputFiles` with file contents sent from the daemon |
| `scroll({target?, dx, dy})` | `scrollBy` on the element or the page |
| `mark(target)` | the one-time marker for the CDP lane (`targets.md`) |
| `mutationCount()` | for `settle.md` |
| `armDialogs(policy)` / `dialogLog()` | the shim channel below |

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
- Not covered by the shim: `beforeunload`, and dialogs a page opens before the daemon has armed
  the new document. If such a dialog blocks the page, DOM-lane calls time out and are reported as
  `DIALOG_OPEN` (`interface.md`), handled with `handle_dialog({trusted: true})`.
- Measured: in a background tab Chrome suppresses native dialogs (owner's Chrome 157: a timer
  `alert` returned in milliseconds, the page went on, CDP saw no dialog; Chrome for Testing 158 the
  same, also for the active tab of an unfocused window). Without the shim the agent would never
  learn a dialog happened, and a `confirm` would silently answer false. The shim makes the answer
  the tab's policy and reports it. A dialog that does block (the active tab of a focused window,
  unarmed) is the `DIALOG_OPEN` case.

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
| DOM-E01 | live | first operation on a fresh document | runtime injected once, operation works |
| DOM-E02 | live | operation after navigation | re-injected |
| DOM-E03 | live | page deletes `window.Node`, overrides `addEventListener` | operations unaffected |
| DOM-E04 | live | React-style tracked input, contenteditable | input events seen by the page |
| DOM-E05 | live | armed `confirm`, unarmed tab with `confirm` | armed answered and logged; unarmed shows the real dialog |
| DOM-E06 | live | strict-CSP page, `evaluate` | works through userScripts; `USER_SCRIPTS_OFF` when disabled |
| DOM-E07 | live | background tab: snapshot, click, fill, scroll | all work; no debugger attached at any point |
| DOM-E08 | live | `chrome://settings` tab | `PAGE_UNSCRIPTABLE` |
| DOM-S01 | site | Facebook: snapshot, fill search, click Marketplace, background tab | works with no bar |
