# `read`

Status: verified
Depends on: `dom-lane.md`, `targets.md`, `errors.md`

## Purpose

Read the page's content as text: articles, long lists, whole tables, values shown in the page. It
is what `snapshot` is not: complete and pageable, where `snapshot` is a compact map for acting.
The old tool set's reading tools (`get_property`, `read_page`, `get_page_content`, `extract`)
were 9% of agent calls, and `evaluate` with `innerText` was the usual fallback; this tool replaces
both.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | no | the page | ref or selector | read only this element |
| `main` | boolean | no | `false` | not with `target` | read the main content only (`main`, `[role=main]`, or the largest `article`), without navigation and footers |
| `offset` | integer | no | 0 | 0 or more | start at this character of the text |
| `maxChars` | integer | no | 20000 | 1000 to 200000 | return at most this many characters |
| `links` | boolean | no | `true` | | write links as `[text](url)` |
| `tab` | integer | no | current tab | owned tab | which tab |

## Behaviour

1. Resolve the tab; take a DOM-lane snapshot silently if this document has none, so controls in
   the text carry refs (`targets.md`).
2. Walk the rendered DOM of `target`, the main content, or the body, skipping what is not visible
   (Playwright `isElementVisible`), in every frame (frames are written where their iframe is):
   - headings as `#`..`######`, paragraphs separated by blank lines, list items as `- ` / `1. `;
   - tables as Markdown tables, every row (no folding);
   - links as `[text](url)`; images as `![alt]`; buttons and form fields as
     `[button "Save" e12]`, `[textbox "Email" e7: value]`, `[checkbox "Remember" e9: checked]`;
   - `pre` and `code` kept verbatim.
3. Cut the text at `offset` and `offset + maxChars`, on a line boundary when one is within 200
   characters. The same page gives the same text, so offsets are stable while the page does not
   change.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` | yes | |
| `url`, `title` | string | yes | |
| `text` | string | yes | the slice |
| `offset` | integer | yes | where the slice starts |
| `total` | integer | yes | length of the whole text |
| `nextOffset` | integer \| null | yes | where to continue; null at the end |

## Errors

`NO_TAB`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `PAGE_UNSCRIPTABLE`, `REF_NOT_FOUND`,
`TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`, `INVALID_TARGET`, `INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
Read the page (or target) as text: headings, paragraphs, lists, full tables, links, and form
fields with their values and refs. main: true skips navigation and footers. Long pages come in
slices: pass nextOffset as offset to continue.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| READ-U01 | unit | slicing at a line boundary; `nextOffset` null at the end | offsets |
| READ-E01 | live | article page, `main: true` | headings and paragraphs, no nav text |
| READ-E02 | live | 300-row table | all rows across slices, header once per table |
| READ-E03 | live | hidden and `display:none` text | absent |
| READ-E04 | live | cross-origin iframe with text | text present at the iframe's place |
| READ-E05 | live | a button ref from the text | `click` on it works |
| READ-E06 | live | form with filled fields | values shown |
| READ-E07 | live | background tab | works, no debugger |
| READ-S01 | site | GitHub repository page, `main: true` | README text, no header links |
