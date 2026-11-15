# `click`

Status: verified (2026-11-14: common parameters from `actions.md`)
Depends on: `actions.md`, `architecture.md` (lanes), `targets.md`, `settle.md`, `sessions.md`, `errors.md`
(the parts this spec relies on are stated inline until those exist)

## Purpose

Click one element in a tab the session owns and report what changed. Works on foreground and
background tabs. Runs without the debugging bar unless `trusted: true`.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | yes | | a ref from the latest `snapshot` of this tab (`e5`, `f1e7`), or a Playwright selector (`text=Save`, `role=button[name="Save"]`, `#id`) | the element |
| `button` | string | no | `"left"` | `"left"`, `"right"`, `"middle"` | mouse button |
| `doubleClick` | boolean | no | `false` | | double click |
| `modifiers` | string[] | no | `[]` | each of `"Alt"`, `"Control"`, `"Meta"`, `"Shift"`, no duplicates | keys held |
| `trusted` | boolean | no | `false` | | run in the CDP lane with real input (shows the debugging bar) |
| `timeout` | number | no | 5 | 0 to 60 seconds | wait for the target to be actionable (`actions.md`) |
| `scroll` | string | no | `"auto"` | `"auto"`, `"center"`, `"none"` | scrolling before the action (`actions.md`) |
| `wait` | object | no | none | one `wait_for` condition plus `timeout` | wait for it after the action settles (`actions.md`) |
| `tab` | integer | no | session's current tab | a tab this session owns | which tab |

Unknown parameters are refused with `INVALID_PARAMS`, naming the valid ones.

## Behaviour

1. Resolve the tab (`tab`, else the session's current tab). Not owned → `TAB_NOT_OWNED`; none →
   `NO_TAB`.
2. Resolve `target` (`targets.md`): `^(f\d+)?e\d+$` is a ref, valid while its element is in the
   current document (otherwise `REF_NOT_FOUND`); anything else is a Playwright selector. More than one match →
   `AMBIGUOUS_TARGET`.
3. **DOM lane** (`trusted: false`), Playwright's injected script in the extension:
   1. Retarget as Playwright does for clicks: an element that is not itself a control (for
      example the text inside a button, or a node with `pointer-events: none`) acts through the
      closest enclosing `button`, link, `[role=button]` or `[role=link]` (`retarget(…,
      "button-link")`).
   2. Actionability, polled by the daemon every 100 ms for up to `timeout` (5 s) (page timers are throttled
      in background tabs, so the page does not poll): attached, visible, enabled, non-inert;
      scroll into view if outside the viewport; hit test (`expectHitTarget`) at the click point:
      the centre of the element's first box (`getClientRects()`, so a link that wraps is hit on
      its first line), or, for an element without boxes of its own (`display: contents`), of its
      contents' first box.
   3. Each poll after a failed check scrolls the element again with the next alignment (`end`,
      `center`, `start`, as Playwright does), so an element under a sticky or absolute header
      comes out from under it; a cover that stays fails with `TARGET_COVERED` naming it when
      `timeout` runs out.
   4. The events go to the deepest element under the click point inside the element of step 1
      (the target a real pointer would hit, through open shadow roots), else to that element.
      Dispatch, in order: `pointerover`, `pointerenter`, `mouseover`, `mouseenter`, `pointermove`,
      `mousemove`, `pointerdown`, `mousedown`, focus if focusable, `pointerup`, `mouseup`, then
      `click` (left), `auxclick` (middle) or `contextmenu` (right). `doubleClick` repeats
      down/up/click with `detail: 2` and adds `dblclick`. Modifiers set `altKey`, `ctrlKey`,
      `metaKey`, `shiftKey` on every event.
4. In the DOM lane, when the click changed nothing (no navigation, no DOM change, no new tab),
   the result's `hint` names `trusted: true` (popups, `isTrusted` checks).
5. **CDP lane** (`trusted: true`): attach (focus emulation if the tab is in the background), then
   Playwright `locator.click({ button, clickCount, modifiers, timeout: 5000 })`.
6. A JavaScript dialog opened by the click is answered by the tab's dialog policy
   (`tools/handle_dialog.md`; default dismisses `confirm`) and reported with the answer given.
7. Settle (`settle.md`): wait for a navigation to commit if the URL changed, then until the DOM is
   quiet for 300 ms, at most 3 s.
8. Return the result. Never retry on a different element.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` \| `"cdp"` | yes | which lane ran |
| `resolved.by` | `"ref"` \| `"selector"` | yes | how `target` was read |
| `resolved.ref` | string \| null | yes | the element's ref if a snapshot gave it one, else null |
| `resolved.role` | string | yes | accessible role |
| `resolved.name` | string | yes | accessible name, cut to 80 chars |
| `outcome.urlChanged` | boolean | yes | URL differs from before |
| `outcome.url` | string | yes | URL after settle |
| `outcome.title` | string | yes | title after settle |
| `outcome.newTabs` | `{tab, url}[]` | yes | tabs the click opened; they join the session |
| `outcome.dialogs` | `{type, message, answer}[]` | yes | dialogs the click opened, each with the answer the tab's policy gave |
| `outcome.domChanged` | boolean | yes | any DOM mutation between click and settle |
| `outcome.settled` | boolean | yes | false when the 3 s cap was hit |
| `hint` | string \| null | yes | set when the DOM-lane click had no visible effect, or when `wait` timed out |
| `waited` | object \| null | yes | the `wait` result (`actions.md`) |

```json
{
  "lane": "dom",
  "resolved": { "by": "ref", "ref": "e46", "role": "link", "name": "Marketplace" },
  "outcome": { "urlChanged": true, "url": "https://www.facebook.com/marketplace/", "title": "Marketplace | Facebook",
               "newTabs": [], "dialogs": [], "domChanged": true, "settled": true }
}
```

## Errors

| Code | When | `hint` text |
| --- | --- | --- |
| `NO_TAB` | no current tab and no `tab` | `Open or select a tab first: tabs({action: "new"}).` |
| `TAB_NOT_OWNED` | the tab is not this session's | `Use a tab from tabs({action: "list"}) marked as yours, or adopt it.` |
| `REF_NOT_FOUND` | the ref's element is gone or the page navigated | `The element is gone or the page changed. Take a new snapshot.` |
| `TARGET_NOT_FOUND` | selector matched nothing for 5 s | `Nothing matches. Take a snapshot and use a ref.` |
| `AMBIGUOUS_TARGET` | selector matched several elements | `Matches N elements: <up to 5 as role "name" ref>. Use one ref.` |
| `TARGET_COVERED` | another element is hit at the centre for 5 s | `<covering element> is on top. Close or click it first.` |
| `TARGET_DISABLED` | still disabled after 5 s | `The element is disabled. Fill the required fields or wait.` |
| `TARGET_HIDDEN` | still invisible after 5 s | `The element is not visible. Open its menu or section first.` |
| `TAB_CLOSED` | the tab closed during the call | `The tab is gone. Check tabs({action: "list"}).` |
| `DEBUGGER_CANCELED` | `trusted: true` after the user pressed Cancel on the bar | `The user stopped debugging in this browser. Retry without trusted, or ask the user and call status({allowDebugger: true}).` |
| `DEBUGGER_BUSY` | `trusted: true` while DevTools or another debugger holds the tab | `Another debugger is attached to this tab. Close DevTools there, or retry without trusted.` |
| `INVALID_TARGET` | the selector does not parse | `Selector syntax error at <pos>. Use a ref from snapshot.` |
| `PAGE_UNSCRIPTABLE` | `chrome://`, Web Store, PDF viewer, error page | `Extensions cannot act on this page. Navigate elsewhere.` |
| `TARGET_OUTSIDE_VIEWPORT` | `scroll: "none"` and the target's centre is outside the viewport | `The element is outside the viewport. Use scroll: "auto" or scroll it into view.` |
| `INVALID_PARAMS` | unknown or invalid parameter | `Valid parameters: target, button, doubleClick, modifiers, timeout, scroll, wait, trusted, tab.` |

## Tool description (what the agent reads)

```text
Click an element. target: a ref from snapshot (e5) or a Playwright selector
(text=Save, role=button[name="Save"], #id). Works in background tabs. trusted: true sends real
mouse input for sites that ignore synthetic clicks (shows Chrome's debugging bar). Returns the
element hit and what changed (url, new tabs, dialog, DOM).
```

## Tests

Playwright cases are adopted by their IDs (`temp/refs/playwright/tests/page/page-click*.spec.ts`,
`locator-click.spec.ts`, `tests/mcp/click.spec.ts`). Each adopted case runs in both lanes unless
the lane column says otherwise. Fixture pages come from Playwright's `tests/assets`.

| ID | Kind | Lane | Case | Asserts |
| --- | --- | --- | --- | --- |
| CLICK-U01 | unit | | `"e5"`, `"f1e7"` read as refs; `"#save"`, `"text=Save"` as selectors | parsing |
| CLICK-U04 | unit | | duplicate modifier, `button: "back"`, unknown param `selector` | `INVALID_PARAMS` naming valid params |
| CLICK-U05 | unit | | tab owned by another session | `TAB_NOT_OWNED`, extension never called |
| CLICK-U06 | unit | | Playwright errors (strict mode, intercepts pointer events, not enabled, inert, not visible, not editable, closed, timeout) | `AMBIGUOUS_TARGET`, `TARGET_COVERED`, `TARGET_DISABLED`, `TARGET_HIDDEN`, `TARGET_NOT_EDITABLE`, `TAB_CLOSED`, `TIMEOUT` |
| CLICK-E01 | live | both | background tab, native button | handler fires; user's active tab unchanged; DOM lane shows no bar |
| CLICK-E02 | live | both | `cursor:pointer` div with a document-level delegated handler | handler fires |
| CLICK-E03 | live | both | link to another page | `urlChanged`, new title, `settled` |
| CLICK-E04 | live | both | `target=_blank` link, also while another session's tab is the window's active tab | `newTabs` has one tab owned by the clicking session; the active tab is the one that was active before |
| CLICK-E05 | live | both | button calling `confirm()`; button calling `alert` then `confirm` | one, then two entries in `outcome.dialogs`; `confirm` answered false by default |
| CLICK-E11 | live | dom | covered, disabled, ambiguous, unknown ref, malformed selector | `TARGET_COVERED` naming the cover, `TARGET_DISABLED`, `AMBIGUOUS_TARGET` with candidates, `REF_NOT_FOUND`, `INVALID_TARGET` |
| CLICK-E10 | live | both | button calling `window.open` | DOM lane: no new tab, result hint names `trusted: true`; CDP lane: `newTabs` has the popup |
| CLICK-E06 | live | cdp | idle detach, then a ref from before it | re-attaches once, click lands |
| CLICK-E07 | live | both | ref from before a navigation | `REF_NOT_FOUND` |
| CLICK-E08 | live | both | DOM changes forever (ticker) | returns after 3 s, `settled: false` |
| CLICK-E09 | live | dom | handler that rejects `isTrusted: false` | no effect in DOM lane; works with `trusted: true` |
| CL-001, CL-004, CL-006, CL-023, CL-071, CL-072, CL-073 | live | both | button, svg, span with inline child, wrapped link, climb to `[role=button]` / anchor / `[role=link]` | click lands |
| CL-007..CL-012 | live | both | 1x1 divs, aligned and unaligned | hit test passes |
| CL-017, CL-026, CL-058, CL-099 | live | both | offscreen element, smooth scroll, span | scrolled into view, clicked |
| CL-020, CL-021, CL-022, CL-114, CL-115 | live | both | display:none / visibility:hidden becoming visible, and never | waits; `TARGET_HIDDEN` after 5 s |
| CL-024, CL-025, CL-066 | live | both | checkbox, its label, zero-size input by label | toggles |
| CL-028, CL-031, CL-057, CL-083, CL-084 | live | both | double, right click order, modifiers | event order and flags |
| CL-029, CL-036, CL-037, CL-048, CL-117, CL-119 | live | both | partially obscured, sticky and absolute headers, obscured | clicks a visible point or `TARGET_COVERED` naming the cover |
| CL-030 | live | both | rotated button | click lands |
| CL-032, CL-013, CL-014 | live | both | navigation by link; click after (cross-origin) navigation | lands; settles |
| CL-034, CL-074, CL-077, CL-087, CL-088 | live | both | iframe, bordered and transformed iframe, shadow root | click lands |
| CL-049, CL-052, CL-053, CL-055, CL-056, CL-111 | live | both | waits for enabled and for pointer-events | waits; `TARGET_DISABLED` after 5 s |
| CL-050, CL-112 | live | both | inert element | waits; error after 5 s |
| CL-005, CL-065 | live | dom | page removed `window.Node` / corrupted `innerWidth` | still clicks (isolated world) |
| CL-094, CL-095, CL-096, CL-097 | live | both | scroll bar, `display:contents` | correct element |
| CL-106 | live | both | click opens `alert` | reported, not a hang |
| CL-107, CL-108 | live | both | element changes or is recycled on hover | no retarget |
| LO-055, LO-056 | live | both | target removed in pointerdown / pointerup | no error |
| CLICK-E12 | live | both | playwright-mcp `click.spec.ts`: click, double, right, modifiers `Control`, `Shift`, `Shift`+`Alt`, a `testid=` locator, an id that looks like a ref (`#z2l9e43l3`) | the page sees each click and its modifier flags (in the CDP lane on macOS a real Control+click is a context click, as macOS makes it, so Control is checked there in the DOM lane only); the id resolves as a selector |
| CLICK-S01 | site | dom | Facebook: Marketplace nav link by ref | `urlChanged`; snapshot shows Marketplace |

`doubleClick`, `modifiers` and `button: "right"` are covered in both lanes by CL-028, CL-031,
CL-057, CL-083 and CL-084, which assert the events the page receives.

Not adopted: CL-002 frameset and CL-003 parallel popups (later, with frames and tabs specs);
CL-019, CL-045..047, CL-059, CL-063, CL-079, CL-098, CL-118 (`force` and `trial` are not
parameters); CL-101..105 now map to `scroll: "none"` (`actions.md`, ACT-E04); CL-090..093 (abort signals);
CL-042, CL-060..062, CL-116, CL-120 (stable-position and animation checks need rendering frames,
which background tabs do not have, so the DOM lane has no stable check; in the CDP lane they would
test Playwright's own `locator.click`, which runs unchanged); CL-085, CL-086, CL-089 (pressure and tweened movement: CDP lane
only); CL-064, CL-081 (microtask ordering of real input: CDP lane only); CL-067..069, CL-076
(navigation and frame detach races: in `settle.md`); CL-078, CL-082 (permission popup and open
select: browser UI, CDP lane only); CL-121, CL-122 (timeout retry: covered by the 5 s rule).

## Edge cases left out

| Case | Why |
| --- | --- |
| Click by coordinates (canvas, maps) | `run` (`page.mouse.click`) |
| Closed shadow roots | unreachable by both lanes |
| Stable-position check in the DOM lane | needs animation frames, which background tabs do not produce; the CDP lane has it |

## Open questions

None for the owner. Technical choices (settle numbers, selector syntax) are fixed by measurement
during implementation and recorded here.
