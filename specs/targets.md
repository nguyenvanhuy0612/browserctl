# Targets: refs and selectors

Status: approved
Depends on: `dom-lane.md`

## Forms

| Form | Example | Meaning |
| --- | --- | --- |
| ref | `e5` | element `e5` from a snapshot of this tab's current document, main frame |
| frame ref | `f2e7` | element `e7` in frame 2 of the current document |
| Playwright selector | `text=Save`, `role=button[name="Save"]`, `#id`, `css=div >> nth=1`, `label=Email` | resolved by Playwright's selector engines in the main frame |

`^(f\d+)?e\d+$` is a ref; everything else is passed to Playwright's selector parser unchanged. A
parse error is `INVALID_TARGET` with the parser's message. There is no bare-text guessing: a
plain word is a CSS type selector, as in Playwright.

## Refs

- Refs are produced by the DOM lane snapshot (Playwright's aria snapshot, `mode: "ai"`). The DOM
  lane is the only source of refs, so a ref means the same thing whichever lane acts on it.
- Playwright gives an element the same ref across snapshots while it stays in the document
  (spike: `e3` then `e3`). The runtime keeps every ref it has handed out for the current document
  in a map of ref to element (weakly held), so a ref stays valid after later snapshots, including
  partial ones (`snapshot` with `target`).
- A ref resolves while its element is still in the document. A removed element, or any ref after
  the tab navigated to a new document, → `REF_NOT_FOUND`. A ref is never re-pointed at another
  element, even an identical one.
- A ref sent to a document whose runtime has not produced it (new document, fresh isolated world)
  → `REF_NOT_FOUND` with the hint to take a snapshot.

## Frames

- The DOM lane injects into every frame it may (`allFrames`). Each frame's runtime gets a frame
  sequence number; its refs carry the `f<seq>` prefix, the main frame has none.
- The main-frame snapshot shows each iframe as a node with a ref; the daemon nests the child
  frame's snapshot under it. The child frame is matched to its iframe element by a handshake: the
  parent's runtime posts a nonce to `iframe.contentWindow`, the child's runtime records it, and the
  daemon reads both through `chrome.scripting` with frame ids. Spike (`temp/spike/frames-check.mjs`):
  same-origin, cross-origin and nested `about:blank` frames each received their parent's nonce, so
  every frame id pairs with its iframe element. The nonce is the parent frame's ref of the iframe.
- Each frame's runtime numbers its own refs from `e1`, so the `f<seq>` prefix is what keeps them
  apart; frames without a prefix would collide (spike: every frame had an `e1`).
- Selectors resolve in the main frame only. Elements in frames are reached by frame refs.

## Handing a ref to the CDP lane

The DOM-lane runtime resolves the ref, sets a one-time attribute `data-bctl-target="<nonce>"` on
the element, and the CDP lane looks for `[data-bctl-target="<nonce>"]` in every frame of the page
(`page.frames()`; extension frame ids are not CDP frame ids), so frame refs work too. The
attribute is removed afterwards in both lanes, also on failure.

## Errors

`REF_NOT_FOUND`, `TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`, `INVALID_TARGET` (see `errors.md`).

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| TGT-U01 | unit | `e5`, `f12e3` | refs |
| TGT-U02 | unit | `text=e5`, `#e5`, `e5x`, `button` | selectors |
| TGT-E01 | live | snapshot twice, same element | same ref |
| TGT-E02 | live | ref after navigation | `REF_NOT_FOUND` |
| TGT-E03 | live | ref whose element was removed and replaced by an identical one | `REF_NOT_FOUND`, not the new element |
| TGT-E07 | live | full snapshot, then a partial snapshot (`target`), then a ref from the first | still resolves |
| TGT-E04 | live | same-origin and cross-origin iframe | frame refs resolve; snapshot nests both |
| TGT-E05 | live | ref and frame ref acted on with `trusted: true` | CDP lane hits the same element; marker attribute removed |
| TGT-E06 | live | `role=button` matching 3 buttons | `AMBIGUOUS_TARGET` listing 3 |
| Playwright `selectors-*.spec.ts`, `page-aria-snapshot-ai.spec.ts` | live | adopted by test ID when the DOM-lane runtime is built | same results through the extension |
