# `take_screenshot`

Status: verified
Depends on: `relay.md`, `targets.md`, `errors.md`

## Purpose

Capture what the page looks like: the viewport, the full page, or one element.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | no | | ref or selector | capture this element only |
| `fullPage` | boolean | no | `false` | not with `target` | the whole scrollable page |
| `format` | string | no | from `path`'s extension (`.png`; `.jpg`, `.jpeg`; any case, as Playwright), else `"jpeg"` | `"jpeg"`, `"png"` | jpeg at quality 80 keeps images small; given together with a `path` of the other extension → `INVALID_PARAMS` |
| `path` | string | no | `~/.browserctl/out/<tab>-<time>.<ext>` | absolute path on the daemon's host | where to save |
| `tab` | integer | no | current tab | owned tab | which tab |

## Behaviour

1. Lane: DOM lane (`chrome.tabs.captureVisibleTab`, no bar) when the page is being rendered (the
   tab is its window's active tab and `document.visibilityState` is `visible`: not minimized, not
   fully covered) and `fullPage` is false. Otherwise the CDP lane: Playwright
   `page.screenshot` / `locator.screenshot` with focus emulation for background tabs (a hidden tab
   captured without it is blank or stale, spike and BrowserMCP measurement).
2. DOM lane with `target`: scroll the element into view, capture, crop to its rectangle times
   `devicePixelRatio` with `OffscreenCanvas` in the extension.
3. `captureVisibleTab` is limited by Chrome to two calls per second; calls are spaced by the
   extension.
4. Save the file; return the path and the image.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` \| `"cdp"` | yes | |
| `path` | string | yes | saved file |
| `width`, `height`, `bytes` | integer | yes | |
| image | MCP image content | yes (MCP) | the picture itself, for clients that show images |

## Errors

`NO_TAB`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `PAGE_UNSCRIPTABLE` (DOM lane on restricted pages falls
back to the CDP lane first), `REF_NOT_FOUND`, `TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`,
`INVALID_TARGET`, `TARGET_HIDDEN`, `DEBUGGER_CANCELED`, `DEBUGGER_BUSY`, `INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
Screenshot the viewport, the full page (fullPage: true) or one element (target). Saved to a file;
the path is returned. Background tabs and full pages use Chrome's debugging bar briefly.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| SHOT-E01 | live | active tab, viewport, captured once the selected tab reports `visibilityState: visible` (polled up to 5 s: activating the window took 0.5 to 1.5 s on the owner's Mac, and a fixed 500 ms wait made the test flaky). When the tab never becomes visible (the screen is locked: every window is hidden, measured 2026-11-15), the test is skipped with that reason; the product then correctly uses the CDP lane | DOM lane, no bar, image non-blank |
| SHOT-E02 | live | background tab | CDP lane, image matches the page (not blank) |
| SHOT-E03 | live | element by ref, DOM lane, device pixel ratio 2 | crop matches the element |
| SHOT-E04 | live | three calls in one second | all succeed (spacing) |
| SHOT-S01 | site | Facebook, background tab | CDP lane, more than 20 KB |
| SS-001, SS-011, SS-023, SS-027, SS-029, SS-031 | live | Playwright screenshot cases (viewport, full page, canvas, while the page navigates in a loop, `path`, `.jpg` and `.JPG` paths); Playwright compares with stored images, these compare size, format and that the image is not blank | CDP lane |
| SHOT-E05 | live | playwright-mcp `screenshot.spec.ts` "viewport", "element", "filename: output.png", "filename: sub/dir/output.png", "fullPage: true", "fullPage with element should error", "preserves image dimensions" | the image, its folders created; `INVALID_PARAMS` for both; width and height as the page reports times `devicePixelRatio` |

Not adopted from `screenshot.spec.ts`: `--output-dir` and `imageResponses` (server options), "default type
should be png" (the default here is jpeg, step 1), "scale: device" (no scale parameter), "viewport
without snapshot" (no snapshot is sent with a screenshot).
