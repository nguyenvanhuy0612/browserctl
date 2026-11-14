# `snapshot`

Status: approved
Depends on: `dom-lane.md`, `targets.md`, `sessions.md`, `errors.md`

## Purpose

Show the agent what is on the page and give every element it can act on a ref. The main way to
read a page; it has to be small enough to call after every few actions.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | no | whole page | ref or selector (`targets.md`) | snapshot only this subtree |
| `depth` | integer | no | unlimited | 1 to 50 | cut the tree below this depth; cut nodes are counted |
| `full` | boolean | no | `false` | | skip compaction (below) |
| `maxChars` | integer | no | 20000 | 1000 to 200000 | cut the text; the cut is reported |
| `tab` | integer | no | session's current tab | owned tab | which tab |

## Behaviour

1. Resolve the tab; inject the DOM-lane runtime in every frame if needed.
2. Playwright aria snapshot, `mode: "ai"`, of `target` or the body, in each frame; nest frames under
   their iframe nodes (`targets.md`). Its refs join the document's ref map (`targets.md`); refs
   from earlier snapshots of the same document stay valid.
3. Compaction, unless `full`:
   - a `generic` node with no name, no text, no ref-worthy state (`cursor=pointer`, `active`,
     `checked`, `expanded`, `selected`) is replaced by its children;
   - a chain of single-child wrappers is collapsed into its last node;
   - runs of more than 10 siblings with the same role and shape keep the first 5 and the last 2,
     and report how many were folded (their refs stay valid);
   - `/url:` lines are kept for links; a URL longer than 100 characters loses its query string
     (written `?…`), which on Facebook was 27% of the snapshot in tracking parameters;
   - `[cursor=pointer]` is dropped from roles that are interactive anyway (link, button, menuitem,
     tab, checkbox, radio, switch, option, textbox, combobox); it stays on `generic` and other
     roles, where it is the only sign that an element is clickable.
4. Cut at `depth` and `maxChars`. Every fold and cut leaves a line in the snapshot saying how many
   nodes it hides and how to see them (`target: "<ref of the list>", full: true`, a larger
   `maxChars`, or `read` for the complete text of long lists, tables and articles).
5. Add page state: URL, title, open dialogs from the shim, whether the tab is in the background.

Measured on the owner's Chrome (Facebook home, background tab): 24 to 26 KB uncompacted; wrapper
removal and folding alone cut 48 to 51%; the URL and cursor rules are measured by SNAP-S01. Feed
content changes the size from run to run, so SNAP-S01 checks the cut, not a fixed size.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` | yes | |
| `url`, `title` | string | yes | |
| `background` | boolean | yes | the page is not being rendered (`document.visibilityState` is `hidden`) |
| `snapshot` | string | yes | the aria snapshot (YAML-like, refs as `[ref=e5]`) |
| `folded` | integer | yes | sibling nodes folded by compaction |
| `cut` | `{depth: n, chars: n}` \| null | yes | what `depth` / `maxChars` removed |
| `dialogs` | `{type, message, answer}[]` | yes | dialogs since the last action |

## Errors

`NO_TAB`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `PAGE_UNSCRIPTABLE`, `REF_NOT_FOUND`,
`TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`, `INVALID_TARGET`, `INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
Read the page as an accessibility tree; each element you can act on has a ref ([ref=e5]) to
pass as target to click, type, fill_form, evaluate. A ref stays valid until its element is
removed or the page navigates. Long repeated lists are shortened; the snapshot says how to see
all items. target: a ref to read only that part. Works in background tabs without the debugging
bar.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| SNAP-U01 | unit | compaction on stored Facebook, GitHub and fixture trees | size cut; every node with a ref and an actionable role kept |
| SNAP-U02 | unit | 50 identical list items | 5 + 2 shown, `folded: 43`, folded refs resolvable |
| SNAP-U03 | unit | `depth: 2`, `maxChars: 1000` | `cut` reported |
| SNAP-E01 | live | `cursor:pointer` div with a delegated handler | listed with a ref |
| SNAP-E02 | live | `target` a ref | only that subtree; refs from it act |
| SNAP-E03 | live | same-origin and cross-origin iframes | nested, frame refs |
| SNAP-E04 | live | background tab | works, no debugger attached |
| SNAP-E05 | live | open shadow root | included |
| Playwright `page-aria-snapshot-ai.spec.ts` | live | adopted by ID when the runtime is built | same snapshot through the extension |
| SNAP-S01 | site | Facebook home | at least 55% smaller than `full: true`; the search box and nav links keep refs |
| SNAP-U04 | unit | long tracking URL; `[cursor=pointer]` on a link and on a generic | query cut to `?…`; cursor kept only on the generic |

## Edge cases left out

| Case | Why |
| --- | --- |
| Canvas content | not in the accessibility tree; `take_screenshot` |
| Closed shadow roots | unreachable |
