# `snapshot`

Status: verified (revision 2, 2026-11-14: readiness, facts on lines, modal layer, prose folding,
YAML-safe markers, SNAP-U05 to U16 and SNAP-E06 to E10; see the review log in `specs/README.md`)
Depends on: `dom-lane.md`, `targets.md`, `settle.md`, `sessions.md`, `errors.md`

## Purpose

Show the agent what is on the page and give every element it can act on a ref. The main way to
read a page; it has to be small enough to call after every few actions. Its first goal is to keep
the page's structure: compaction removes wrappers, duplicates and noise, and folds long runs and
long prose, but every fold says how much it hides and how to see it, and no ref changes.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | no | whole page | ref or selector (`targets.md`) | snapshot only this subtree |
| `depth` | integer | no | unlimited | 1 to 50 | cut the tree below this depth (Playwright's `depth`; how many nodes it removed is not known) |
| `full` | boolean | no | `false` | | skip compaction and prose folding (facts and readiness still apply) |
| `maxChars` | integer | no | 20000 | 1000 to 200000 | size budget of the whole snapshot (see step 6) |
| `maxText` | integer | no | 2000 | 200 to 200000 | characters of prose kept per run of text blocks before it is folded (step 5) |
| `tab` | integer | no | session's current tab | owned tab | which tab |

## Behaviour

1. Resolve the tab; inject the DOM-lane runtime in every frame if needed.
2. **Readiness.** A page is *ready* when `document.readyState` is `complete`, no element has been
   added or removed for 300 ms, 1.1 s in a background tab (attribute and text changes are not
   counted: YouTube changes attributes all the time; a background tab runs page timers once a
   second, so a page hydrates in 1 s bursts and a 300 ms gap proves nothing: YouTube watch gave
   917 characters after a 300 ms gap and 5,351 six seconds later) and no document, frame, script or XHR/fetch request of the tab that started
   in the last 5 s is still pending. When the page is younger than 15 s
   (`performance.now()`) and not ready, wait until it is, at most 3 s (5 s in a background tab). Requests that are still
   pending at the deadline (ads, analytics, long polls: demoqa had 2), and subresources that
   keep `readyState` at `interactive` (MDN), only extend the wait: at the deadline a page past
   `DOMContentLoaded` whose DOM is quiet counts as ready, with the pending count reported; an older page is not waited
   for and counts as ready when `readyState` is `complete` (soft navigations are settled by the action that caused them, `settle.md`). The result
   reports `ready` and `readiness`. Measuring quiet costs a young page at least one quiet window
   (300 ms, 1.1 s in a background tab) even when it is ready; old pages cost nothing. If the page
   stops answering during the wait (it navigated), the wait ends with `ready: false`,
   `quiet: false` and the last `readyState` actually measured. A page still not ready gets a first line
   `- (page not ready; … snapshot again or wait_for)` naming what is still going on. (Measured:
   YouTube and Facebook right after `navigate` gave an almost empty tree with no warning.)
3. Playwright aria snapshot, `mode: "ai"`, of `target` or the body, in each frame; nest frames under
   their iframe nodes (`targets.md`). Its refs join the document's ref map (`targets.md`); refs
   from earlier snapshots of the same document stay valid.
4. **Facts.** The runtime adds what the aria tree does not say, as extra brackets after the ref of
   the line they describe (`[ref=e5] [empty]`), in every mode:

   | Fact | On | Meaning |
   | --- | --- | --- |
   | `[empty]` | text inputs, textareas, contenteditable textboxes, editable comboboxes | no value yet |
   | `[type=email]` | `input` whose type is not plain text (email, password, number, tel, url, date, time, datetime-local, month, week, color) | what the field accepts |
   | `[value=42]` | `slider`, `spinbutton`, `progressbar`, `meter`, `scrollbar` built without a native input | `aria-valuetext`, else `aria-valuenow`, else the `value` of a native `<progress>` or `<meter>` |
   | `[near="Select State"]` | form control (textbox, searchbox, combobox, checkbox, radio, switch, slider, spinbutton) with no accessible name | the closest visible text before it: at the element and each of up to 3 ancestors, the last visible text with at least two letters in up to 3 previous siblings (60 chars); not its name, so role selectors are not misled |
   | `[ctx="Post title"]` | interactive elements that share role and name with another one (`Reply`, `Like`, `upvote`) | `in heading` for a heading's own anchor link; else the first visible text of the closest item-like ancestor (article, list item, row, section, fieldset, group) that holds only this one of them, or of the highest such ancestor; else the closest heading before it: walking back from the element through previous siblings and their descendants, then up through ancestors, and from the top of a shadow root on to its host; headings inside other components' shadow roots are not seen (50 chars) |
   | `[modal]` | the first listed element of the layer that blocks the page (below) | |
   | `[hidden]`, `[no-pointer-events]` | interactive nodes Playwright lists without a ref | why there is no ref: not rendered (closed menu, zero size) or `pointer-events: none`; act on its opener first |

   Text-level facts added by the daemon: `[rows=R] [cols=C]` on `table`, `grid`, `treegrid`
   (rows and the widest row's cells in the snapshot); `[items=N]` on `list`, `listbox`, `menu`,
   `tree`, `tablist`, `feed` with at least 10 items. Quotes, colons and braces in fact text are
   replaced so a line stays valid YAML. At most 300 elements get `near` or `ctx` per frame.

   **Modal layer.** The blocking element is, in order: an open modal `<dialog>`; a visible
   `[aria-modal=true]` element; or the fixed-position ancestor of the element hit at the viewport
   centre that covers at least 60% of the viewport in both directions, accepts pointer events,
   holds a dialog, a form control, a button or an iframe, and holds less than half of the page's
   elements (an app shell is not a modal; bsk marked YouTube's whole page as modal this way). The
   snapshot gets a first line `- (a modal dialog "Name" covers the page, starting at [ref=e5]; act
   inside it or close it first)`, where the ref is the first listed element inside the layer (the
   layer itself is often an unnamed wrapper Playwright leaves out). That element gets `[modal]`,
   which also keeps it through compaction. The line names the layer by its ARIA role and name; a
   layer without a role whose first listed element is a `dialog` or `alertdialog` (an unnamed
   backdrop around a dialog: HuggingChat, a Facebook post) is named by that dialog; any other
   layer without a role is called `layer`.
5. **Compaction**, unless `full`:
   - a `generic` node with no name, no text, no ref-worthy state or fact (`cursor=pointer`, `active`,
     `checked`, `expanded`, `selected`, `modal`, …) is replaced by its children;
   - a chain of single-child wrappers is collapsed into its last node;
   - runs of more than 10 siblings with the same role and shape keep the first 5 and the last 2,
     and report how many were folded (their refs stay valid); headings are never folded;
   - `/url:` lines are kept for links; a URL longer than 100 characters loses its query string
     (written `?…`), which on Facebook was 27% of the snapshot in tracking parameters, and a path
     still longer than 100 characters is cut there with `…`;
   - `[cursor=pointer]` is dropped from roles that are interactive anyway (link, button, menuitem,
     tab, checkbox, radio, switch, option, textbox, searchbox, combobox, slider, spinbutton); it stays on
     `generic` and other roles, where it is the only sign that an element is clickable. Lines that
     Playwright wraps in single quotes (a name containing a colon) are handled the same way;
   - noise with nothing to read is removed before the rules above (every drop keeps the node's ref
     when the node itself stays):
     - names and inline text containing U+034F, the scrambling Facebook puts in timestamps, are
       dropped (the real text is not recoverable) together with the one-letter nodes under them;
     - Private Use Area characters (icon-font glyphs) are removed; a node left with no text, or a
       name left empty, loses that part;
     - a `tooltip` named `tooltip`, and an `aria-hidden` tooltip whose text is already the name of
       a sibling or of something inside a sibling, are dropped;
     - a label echo is dropped: a text node (`- text:` or a `generic` without `cursor=pointer`)
       right before or after a checkbox, radio, switch, textbox, combobox, searchbox, spinbutton
       or slider whose name is exactly that text (demoqa: `radio "Male"` followed by `generic: Male`);
     - more than 10 siblings that are identical apart from their refs, with nothing to act on
       (no link, button, field or other interactive role below them) and not all next to each
       other (an unbroken run is the same-shape rule's case), keep the first 2; the rest become one line `(N more identical <role>, refs
       a..b; …)` where the third stood (Facebook's `blockquote "Facebook"` placeholders).
   - **Prose folding** runs at each level of the tree before the identical-sibling and same-shape
     folds above (so a long article keeps its first `maxText` characters rather than 5 + 2
     paragraphs). Prose is a `paragraph`, `text`, `blockquote`, `code`, `emphasis`,
     `strong`, `listitem`, `list`, `generic`, `group`, `deletion`, `insertion`, `subscript`,
     `superscript`, `time`, `mark`, `note`, `term` or `definition` node whose children are all
     prose (a fold line counts as prose), with nothing interactive below it and no
     `cursor=pointer` or `[modal]`. In each run of
     prose siblings, the first `maxText` characters are kept (a node that crosses the limit is
     entered; a text that crosses it is cut with `…`, keeping at least 100 characters, unless it is
     at most 40 characters over); the rest of the run
     becomes one line `- (+N chars in M blocks; read target=eX)`, where `eX` is the closest ancestor
     with a ref. Fold lines of the rules above are kept and do not end a run. Headings, links, buttons and
     fields are never folded and end a run, so a long
     email or article keeps its headings and the controls after the body.
6. **Budget.** When the result is larger than `maxChars`, prose folding is repeated with a smaller
   `maxText` (halved, down to 200). If it is still too large, the page becomes an outline: the
   largest subtrees that hold no heading, no `[modal]` line and no iframe anywhere inside (infoboxes, navboxes, reference
   lists, link-heavy paragraphs) and are at most half of `maxChars` (a bigger one is entered and
   its children are candidates: Hacker News is one table) are collapsed, biggest first, into one line under their own
   node, `- (folded; 45 lines, 12 links, 3 controls; snapshot target=eX)`, until the whole fits.
   The collapsed node keeps its line and ref; the refs inside stay valid. Only then is the text
   cut at a line boundary, so that the whole snapshot, notice lines and the cut line included, is
   at most `maxChars` (measured: Wikipedia "Hanoi" is 335 KB; a plain cut at 20,000 showed 2
   of its headings). Every fold and cut leaves a line saying how many nodes or characters it hides and how
   to see them (`snapshot` with `target` and `full`, a larger `maxChars`, or `read`).
7. Every line the daemon adds is valid YAML (no `: ` or ` #` outside quotes, no braces), so the
   whole snapshot parses as YAML like Playwright's own.
8. Add page state: URL, title, open dialogs from the shim, whether the tab is in the background.

Measured on the owner's Chrome (Facebook home, background tab): 24 to 26 KB uncompacted; wrapper
removal and folding alone cut 48 to 51%; the URL and cursor rules are measured by SNAP-S01. Feed
content changes the size from run to run, so SNAP-S01 checks the cut, not a fixed size.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` | yes | |
| `url`, `title` | string | yes | |
| `background` | boolean | yes | the page is not being rendered (`document.visibilityState` is `hidden`) |
| `ready` | boolean | yes | step 2 |
| `readiness` | `{readyState, quiet, pendingRequests, waitedMs}` | yes | what step 2 saw at the end; `quiet` is null when the page was too old to be waited for |
| `modal` | `{ref, role, name}` \| null | yes | the blocking layer, step 4 |
| `snapshot` | string | yes | the aria snapshot (YAML, refs as `[ref=e5]`) |
| `folded` | integer | yes | sibling nodes folded by compaction |
| `textFolded` | integer | yes | characters of snapshot lines folded as prose (step 5), markup included |
| `collapsed` | integer | yes | subtrees collapsed into one line to fit `maxChars` (step 6) |
| `cut` | `{depth: n \| null, chars: n}` \| null | yes | the `depth` applied and the characters `maxChars` removed; null when neither applied |
| `dialogs` | `{type, message, answer}[]` | yes | the last 5 dialogs of this document, as the shim answered them |

## Errors

`NO_TAB`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `PAGE_UNSCRIPTABLE`, `REF_NOT_FOUND`,
`TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`, `INVALID_TARGET`, `INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
Read the page as an accessibility tree (YAML); each element you can act on has a ref ([ref=e5])
to pass as target to click, type, fill_form, evaluate. A ref stays valid until its element is
removed or the page navigates. Extra brackets tell state: [empty], [type=email], [value=42],
[near="label"] for unnamed fields, [ctx="..."] to tell identical buttons apart, [modal],
[hidden] (no ref: open its menu first). Long lists and long text are folded; each fold line says
how to see the rest (read target=eX). target: a ref to read only that part. If the first line
says the page is not ready, snapshot again. Works in background tabs without the debugging bar.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| SNAP-U01 | unit | compaction on stored Facebook, GitHub and fixture trees | size cut; every node with a ref and an actionable role kept |
| SNAP-U02 | unit | 50 identical list items | 5 + 2 shown, `folded: 43`, folded refs resolvable |
| SNAP-U03 | unit | `depth: 2`, `maxChars: 1000` | `cut` reported; the text with its cut line is at most `maxChars` |
| SNAP-E01 | live | `cursor:pointer` div with a delegated handler | listed with a ref |
| SNAP-E02 | live | `target` a ref | only that subtree; refs from it act |
| SNAP-E03 | live | same-origin and cross-origin iframes | nested, frame refs |
| SNAP-E04 | live | background tab | works, no debugger attached |
| SNAP-E05 | live | open shadow root | included |
| SNAP-E06 | live | iframe inside an open shadow root (web component embedding a demo frame) | nested under its iframe node with a frame ref; the frame ref acts |
| AR-048, AR-055, AR-065, AR-076, AR-077, AR-090, AR-091 | live | Playwright ai-snapshot cases the compaction relies on (refs, no ref without pointer events, nameless images, visible children of hidden elements, the active element, depth, `aria-hidden`), with `full: true`; AR-077 in a tab shown with `focus: true`, since `[active]` needs a focused document as in Playwright's runs | same lines through the extension |
| SNAP-S01 | site | Facebook home | at least 55% smaller than `full: true`; the search box and nav links keep refs |
| SNAP-U04 | unit | long tracking URL; `[cursor=pointer]` on a link and on a generic | query cut to `?…`; cursor kept only on the generic |
| SNAP-U05 | unit | quoted role line (`- 'link "A: B" … [cursor=pointer]':`) | cursor dropped on the link, kept on a quoted generic |
| SNAP-U06 | unit | link named with U+034F letters and one-letter children | name and letter nodes gone, ref and sibling button kept |
| SNAP-U07 | unit | Private Use Area glyphs in a name, in text and in a child | glyphs gone, emptied nodes gone, real text kept |
| SNAP-U08 | unit | echoing tooltip, `tooltip "tooltip"`, tooltip with its own text | first two dropped, the third kept |
| SNAP-U09 | unit | 14 placeholders interleaved with 14 posts that hold a button | placeholders fold to 2 plus a line; every post button kept or counted in a fold |
| SNAP-U10 | unit | outputs of SNAP-U01 to U09 and U11 to U15, plus fold, cut, modal and readiness lines | every output parses as YAML |
| SNAP-U11 | unit | `radio "Male"` followed by `generic: Male`; `text: Name` before `textbox "Name"`; text that differs | echoes dropped, the different text kept |
| SNAP-U12 | unit | facts map applied to plain, quoted and container lines; refless list applied in order | brackets after the ref; quoted key stays valid; `[hidden]` on the right line |
| SNAP-U13 | unit | table with 3 rows of 4 cells; list of 12 items; list of 3 | `[rows=3] [cols=4]`, `[items=12]`, none on the short list |
| SNAP-U14 | unit | 30 paragraphs of 300 chars between two headings, then a button; one 5,000-char paragraph | headings and button kept; fold line with chars and the ancestor ref; long paragraph cut with `…` |
| SNAP-U15 | unit | budget: page of 60 KB prose with 20 headings, `maxChars` 20000 | fits without a hard cut; every heading kept |
| SNAP-U20 | unit | outline: a region holding a `[modal]` button and a region holding an iframe, over budget; 20 list items of 3 KB, `maxText` 2000 | neither region collapsed; the list keeps about 2,000 characters of prose |
| SNAP-U19 | unit | label echoes next to a searchbox, a spinbutton and a slider; a run of long `note` and `time` nodes | echoes dropped; the run folds as prose |
| SNAP-U18 | unit | readiness with a page that stops answering after the first measurement | `ready: false`, `quiet: false`, the measured `readyState` (not a guessed one) |
| SNAP-U17 | unit | 30 sections, each a heading, a 3 KB link-heavy paragraph and a 2 KB table, `maxChars` 20000 | all 30 headings kept; paragraphs and tables collapsed with their refs and `snapshot target=`; no hard cut; valid YAML |
| SNAP-U16 | unit | readiness and modal top lines | text and YAML validity |
| SNAP-E07 | live | form fixture: empty and filled inputs, email field, unnamed select with a label before it, custom slider, native `<progress>`, two "Reply" buttons in two posts | `[empty]` only on the empty ones, `[type=email]`, `[near=…]`, `[value=…]`, two different `[ctx=…]`; every annotated ref clicks or fills |
| SNAP-E08 | live | overlay fixture: fixed full-screen modal with a button; fixed full-height app shell holding the whole page; an `aria-modal` backdrop without a role around `role=dialog` named "Welcome" | modal line and `[modal]` on the first, nothing on the second, `modal dialog "Welcome"` on the third; the modal's button ref clicks |
| SNAP-E11 | live | two `Edit` buttons outside any item, each after its own `h2`, with headings in open shadow roots before, between and after them | `[ctx="Section A"]`, `[ctx="Section B"]` |
| SNAP-E12 | live | a page heading, then a web component whose shadow root holds `h2 "Shadow A"`, `Edit`, `h2 "Shadow B"`, `Edit` | `[ctx="Shadow A"]`, `[ctx="Shadow B"]` |
| SNAP-E09 | live | page that adds its content 1 s after load | snapshot right after `navigate` has the content, `ready: true`, `waitedMs` about 1000 |
| SNAP-E10 | live | link inside a closed menu | listed with `[hidden]` and no ref; after opening the menu it has a ref and clicks |

Not adopted: the other `page-aria-snapshot-ai.spec.ts` cases. They test Playwright's snapshot
generator, which runs here unchanged; frame stitching and ref numbering across frames are this
project's own (`targets.md`) and have their own tests.

## Edge cases left out

| Case | Why |
| --- | --- |
| Canvas content | not in the accessibility tree; `take_screenshot` |
| Closed shadow roots | unreachable |
