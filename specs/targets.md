# Targets: refs and selectors

Status: verified (revision 2, 2026-11-14: locator forms; TGT-U03, TGT-E08)
Depends on: `dom-lane.md`

## Forms

| Form | Example | Meaning |
| --- | --- | --- |
| ref | `e5` | element `e5` from a snapshot of this tab's current document, main frame |
| frame ref | `f2e7` | element `e7` in frame 2 of the current document |
| CSS | `#save`, `form .primary`, `css=div >> nth=1` | Playwright's CSS engine (a bare word is a CSS type selector, as in Playwright) |
| `id=` | `id=save` | element with that id (Playwright engine) |
| `name=` | `name=email` | element with that `name` attribute |
| `text=` | `text=Save`, `text="Save"` | Playwright text engine: unquoted is a case-insensitive substring, quoted is exact |
| `role=` | `role=button[name="Save"]` | Playwright role engine |
| `label=` | `label=Email` | form control by its label |
| `placeholder=` | `placeholder=Search` | element by placeholder |
| `testid=` | `testid=submit` | `data-testid` attribute (`data-testid=`, `data-test=`, `data-test-id=` work too) |
| `alt=`, `title=` | `alt=Logo` | element by `alt` or `title` attribute |
| XPath | `xpath=//button[2]`, `//button` | Playwright XPath engine |
| chains | `role=listitem >> text=Done`, `css=li >> nth=2` | Playwright's `>>` chaining, `nth=` |

`^(f\d+)?e\d+$` is a ref. `name=`, `label=`, `placeholder=`, `testid=`, `alt=` and `title=` are
not Playwright engine names; the daemon rewrites them, in every part of a `>>` chain (with or
without spaces around `>>`; a `>>` inside quotes is part of the value, not a separator), into
Playwright's own (`css=[name="email"]`, `internal:label="Email"i`,
`internal:attr=[placeholder="Search"i]`, `internal:testid=[data-testid="submit"s]`,
`internal:attr=[alt="Logo"i]`). `name=` and `testid=` always match exactly (attribute values);
for the others, unquoted values match case-insensitively as substrings, quoted
values (`label="Email"`) match exactly, as Playwright's text rule. Everything else goes to
Playwright's selector parser unchanged, so every Playwright engine works; XPath is allowed because
Playwright supports it at no cost (the owner had expected it to be hard). A parse error is
`INVALID_TARGET` with the parser's message, which names the selector as the agent wrote it.
Rewriting happens in the daemon, before the DOM lane resolves the target, so both lanes accept
every form.

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
- The main-frame snapshot shows each iframe as a node with a ref, also an iframe inside an open shadow root (SNAP-E06); the daemon nests the child
  frame's snapshot under it. The child frame is matched to its iframe element by a handshake: the
  parent's runtime posts a nonce to `iframe.contentWindow`, the child's runtime records it, and the
  daemon reads both through `chrome.scripting` with frame ids. Spike (`temp/spike/frames-check.mjs`):
  same-origin, cross-origin and nested `about:blank` frames each received their parent's nonce, so
  every frame id pairs with its iframe element. The nonce is the parent frame's ref of the iframe.
- Each frame's runtime numbers its own refs from `e1`, so the `f<seq>` prefix is what keeps them
  apart; frames without a prefix would collide (spike: every frame had an `e1`).
- Selectors resolve in the main frame only. Elements in frames are reached by frame refs.

## Handing a target to the CDP lane

The DOM lane resolves every target first (the same errors in both lanes, and the `resolved`
description). A ref (and the control of a label, `tools/fill_form.md`) is then handed over by a
one-time attribute `data-bctl-target="<nonce>"` on the element: the CDP lane looks for
`[data-bctl-target="<nonce>"]` in every frame of the page (`page.frames()`; extension frame ids are
not CDP frame ids), so frame refs work too. The attribute is removed afterwards in both lanes, also
on failure. A selector goes to Playwright as the rewritten selector instead, so Playwright
resolves it again on each of its retries, as the DOM lane does: an element the page replaces while
the action waits (a select swapped on hydration, Playwright SO-033) is found again.

## Errors

`REF_NOT_FOUND`, `TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`, `INVALID_TARGET` (see `errors.md`).

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| TGT-U01 | unit | `e5`, `f12e3` | refs |
| TGT-U02 | unit | `text=e5`, `#e5`, `e5x`, `button` | selectors |
| TGT-U03 | unit | `name=`, `label=`, `label="x"`, `placeholder=`, `testid=`, `alt=`, `title=`, the same inside a `>>` chain with and without spaces, a quoted value containing ` >> `, a value with quotes, `css=`/`xpath=`/`id=` untouched | the Playwright selector each becomes |
| TGT-E08 | live | locators fixture: one element per form above, in the DOM lane and with `trusted: true` | each resolves to the expected element (`get`), `click` lands |
| TGT-E01 | live | snapshot twice, same element | same ref |
| TGT-E02 | live | ref after navigation | `REF_NOT_FOUND` |
| TGT-E03 | live | ref whose element was removed and replaced by an identical one | `REF_NOT_FOUND`, not the new element |
| TGT-E07 | live | full snapshot, then a partial snapshot (`target`), then a ref from the first | still resolves |
| TGT-U04 | unit | a child frame's snapshot and its parent's iframe line | nested under the iframe line, one level deeper |
| TGT-E04 | live | same-origin and cross-origin iframe | frame refs resolve; snapshot nests both |
| TGT-E05 | live | ref and frame ref acted on with `trusted: true` | CDP lane hits the same element; marker attribute removed |
| TGT-E06 | live | `role=button` matching 3 buttons | `AMBIGUOUS_TARGET` listing 3 |
| SE-002, SE-003, SE-022, SE-028, SE-037, SE-038, SE-041, SE-050, SE-059, SE-060, SE-071, SE-077, SE-084, SE-087..SE-089, SE-135, SE-136, SE-139, SE-143, SE-144 | live | Playwright selector cases, one or more per engine and per locator form of this spec (css with shadow roots, text, role, `testid=`, `label=`, `placeholder=`, `alt=`, `title=`, `visible=`, `nth=`, XPath), read with `get` and `all` | same matches through the extension |

Not adopted: the other selector cases. They test Playwright's engines, which run here unchanged
(the same injected script, `scripts/build-extension.js`); the adopted ones show that each engine
and each rewritten form works inside the extension's isolated world.
