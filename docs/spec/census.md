# Spec: the census

A census (`browser_snapshot`) is a **text** list of the page's controls, each with a stable `ref`. It
is not an image. Three consecutive agent probes read the tool's name as "screenshot" and reached for
`browser_read_page` instead, so the description now says so in its first clause.

The census answers "what can I act on here". Its hardest requirement is not completeness — it is
**admitting what it left out**.

## What is included

An element is censused when it matches `INTERACTIVE_SELECTOR` and passes `isCensusVisible()`.

### The selector covers every ARIA widget role, not a subset

Native: `a[href]`, `button`, `input:not([type=hidden])`, `textarea`, `select`, `summary`,
`[contenteditable]`, `[onclick]`.

Command: `button`, `link`, `menuitem`, **`menuitemradio`**, **`menuitemcheckbox`**, `tab`, `treeitem`.
Selection: `option`, `checkbox`, `radio`, `switch`.
Input: `combobox`, `searchbox`, `textbox`, `slider`, `spinbutton`.

The list once held four roles. A CSS attribute selector matches exactly, so `[role=menuitem]` does
**not** match `menuitemradio` — and GitHub's sort menu is built from `menuitemradio`. With the menu
open and painted at 192×316, both readers returned zero results for "Oldest", and the agent fell back
to `eval_js` with a hand-written querySelector loop. The same hole hid every custom listbox, toggle,
tree and slider on every site [F48].

`INTERACTIVE_SELECTOR` and `read_page`'s `INTERACTIVE_ROLES` must cover the same roles; a test fails if
they drift.

### Visibility: three ways in

`isCensusVisible()` = `isVisible()` **or** operable-through-a-label **or** revealed-on-hover.

| Case | Rule | Marked as |
|---|---|---|
| plainly visible | painted, non-zero box, not `display:none` / `visibility:hidden` / `opacity:0` | — |
| operated through its label | a form control that is `opacity:0` or zero-size **and** has an associated **visible** `<label>` | `[via label]` |
| revealed on hover/focus | `opacity:0`, a real box ≥ 8px, inside the layout, **and it has a name** | `[hidden until hover/focus]` |

The second case is the standard accessible custom checkbox: a 1×1 `opacity:0` input behind a visible
label. Booking.com's "I'm travelling for work" is exactly this, and excluding it meant an agent could
not tick a box a person ticks without thinking. The third covers carousel arrows and skip links —
excluding them meant **a carousel could not be paged at all** [F68].

Both are bounded to `opacity` and zero-size. `display:none` and `visibility:hidden` are removed from
Chrome's accessibility tree too, and stay out.

## What the response must admit

A census that quietly omits things is worse than a smaller one that says so. Every omission has a
line.

### Structure, before the elements

```
[Structure: 92 repeated <tr> rows (~2 controls each: a) · 11 inputs · 1 open dialog · main 124, nav 9]
```

Volume is not structure. Hacker News folded 186 of 198 elements into one opaque line, so an agent saw
a nav bar and a number and had to spend calls discovering the page is a feed [F55]. Suppressed on
trivial pages — `[Structure: main 1]` above a single link is noise.

### Offscreen, by kind

```
[Notice: 108/120 elements visible in viewport. 12 offscreen, including 2× "Online status indicator
 Active …", 1 "See previous notifications". Call 'snapshot --all' to see them, or scroll down]
```

Counting elements is a token-budget note an agent cannot act on. A probe read `46 elements offscreen`
as "46 more notifications" and hedged an answer that was already complete; on the same page it
stopped at 11 of 206 friends with 30 rows sitting in the DOM [F30]. Naming the *kind* of thing
withheld is what turns a budget note into a correctness warning.

### Content no scope setting can reveal

```
[Possible hidden content: "See previous notifications" (@ref_81); filter tabs: "All", "Unread".
 Lists like these load on demand — 'snapshot --all' will NOT reveal rows that are not in the DOM yet]
```

`scope: 'all'` means *every element currently in the DOM*, not everything the page can show. A probe
that escalated to `all` unprompted — doing everything the notices ask — still reported 5 unread
notifications where there were 15, because the other ten did not exist until a filter tab was clicked.
Two different model families made the identical wrong inference [F39].

Detection uses three signals, ordered by how site-agnostic they are: a load-more **phrase**;
`aria-expanded="false"` on a control that is not a menu opener; a more-ish label at the end of a run of
5+ similar rows. A bare `show` is Hacker News' Show HN link, not a load-more — matching bare verbs put
a wrong hint on every page, and a hint that fires on everything is one an agent learns to skip [F47].

### Folding, duplicates, dialogs

- A folded run names what it folded: `folded 186 links — 27× "hide", 26× unlabelled <a>` [F55].
- Anchors sharing a normalised href and label collapse to one row, with the count reported [F28].
- Every open dialog is listed **whether or not it blocks the page**. A right-rail popover blocks
  nothing and still owns the interaction; the blocking-only gate missed it three probes running, and
  each of those agents hallucinated a modal landmark it had never been shown [F27].
- `--all` emits its own notice covering folded elements. It used to say nothing at all, so the mode an
  agent escalates to *for completeness* was silently incomplete [F38].

## Ordering

Reading order within each landmark block. Landmark blocks stay contiguous — interleaving them repeats
every `[Navigation]` header, which costs more than the ordering fix is worth. Within a block, elements
run top-to-bottom, left-to-right, so a portal-rendered popover no longer prints before the content it
visually sits on top of [F31].

## Cost

Measured on facebook.com, viewport scope: 12,877 → 7,178 chars across the 0.6.0 work. The saving came
from repairing the frame merge and truncating hrefs, **not** from scope tuning — viewport scoping saves
2.7% on a real SPA, against the 75-85% its description used to claim [F36]. Half the payload was href
strings and a fifth was opaque tracking parameters, dropped by value length rather than by a per-site
list of parameter names.

## The frame merge

On any page with an iframe — i.e. every real site — `background.js` merges per-frame results. It must
**pass the content script's compact view through**, appending each sub-frame under an
`[iframe f<id> …]` header with frame-qualified refs, and emit exactly one guidance footer.

It used to rebuild the view from the merged element list whenever `parts.length !== 1`, discarding
landmark grouping, key-input hoisting, folding and every notice. Only single-frame test pages ever saw
the good path [F41]. It then dropped `nearest`, and later `pageLabels`, by enumerating the fields it
kept [F59].

> **Enumerate what to REPLACE, never what to keep.** A merge that lists what to keep must be edited
> every time the content script learns a field, and forgetting is invisible.
