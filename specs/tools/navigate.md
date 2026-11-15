# `navigate`

Status: verified (2026-11-14: common parameters from `actions.md`)
Depends on: `actions.md`, `sessions.md`, `settle.md`, `errors.md`

## Purpose

Load a URL in the current tab, or go back, forward or reload. No debugger.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `url` | string | one of `url`, `action` | | absolute URL, or a host (`example.com`, gets `https://`) | page to load |
| `action` | string | one of `url`, `action` | | `"back"`, `"forward"`, `"reload"` | history step or reload |
| `wait` | object | no | none | one `wait_for` condition plus `timeout` | wait for it after the action settles (`actions.md`) |
| `tab` | integer | no | session's current tab; if none, a new tab is opened | owned tab | which tab |

Both or neither of `url` and `action` → `INVALID_PARAMS`.

## Behaviour

1. Resolve the tab. With no current tab, open one (`tabs` `new` rules) and make it current.
2. `chrome.tabs.update({url})` or `chrome.tabs.reload`. `back` and `forward` call `history.back()` /
   `history.forward()` in the page through the DOM-lane runtime: `chrome.tabs.goBack` follows Chrome's
   history intervention and skips entries the user never interacted with, which is every entry an
   agent created (measured: it reported no previous page). On a page the runtime cannot reach,
   `chrome.tabs.goBack` / `goForward` are used.
3. Wait through `chrome.webNavigation` for the main frame: committed, then `DOMContentLoaded`, at
   most 30 s. `onErrorOccurred` → `NAVIGATION_FAILED` with Chrome's net error. A same-document
   navigation (hash, `pushState`) finishes at `onHistoryStateUpdated` / `onReferenceFragmentUpdated`.
   `back` or `forward` with nothing to go to: no navigation starts within 2 s, the call returns with
   `urlChanged: false`.
4. Arm the dialog shim on the new document; the DOM-lane runtime is injected on first use.
5. A page's `beforeunload` handlers run but never hold the navigation (`dom-lane.md`).
6. Settle (`settle.md`) from step 4 on, then return.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` | yes | |
| `url`, `title` | string | yes | after settle |
| `urlChanged` | boolean | yes | |
| `settled` | boolean | yes | false when 30 s passed before `DOMContentLoaded` |
| `tab` | integer | yes | the tab, new or existing |
| `waited` | object \| null | yes | the `wait` result, null without `wait` (`actions.md`) |
| `hint` | string \| null | yes | set when `wait` timed out (`actions.md`) |

## Errors

`NO_BROWSER`, `AMBIGUOUS_BROWSER`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `NAVIGATION_FAILED`,
`INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
Open a URL in your current tab (opens a background tab if you have none), or action: back |
forward | reload. Waits for the page to load. Does not change what the user is looking at.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| NAV-U01 | unit | `url` and `action` together, neither | `INVALID_PARAMS` |
| NAV-U02 | unit | `example.com` | `https://example.com` sent to the browser |
| NAV-E01 | live | no current tab | new background tab, current, loaded |
| NAV-E02 | live | back, forward, reload; back with no history | correct URLs; `urlChanged: false` |
| NAV-E03 | live | unreachable host, bad TLS | `NAVIGATION_FAILED` with the net error |
| NAV-E04 | live | pages with `beforeunload` handlers (`preventDefault` with `returnValue` and a string returned from `window.onbeforeunload`; the `<body onbeforeunload>` attribute; `document.body.onbeforeunload`), each after one `trusted` click (Chrome asks only after real input) and the idle detach (the shim answers, not the debugger) | each navigates within the usual time; the handlers ran |
| NAV-E05 | live | hash change, `pushState` page | finishes without waiting 30 s |
| NAV-S01 | site | Facebook home in a new background tab | `settled`, title set |
| NA-001, NA-006, NA-014, NA-015, NA-016, NA-021, NA-023, NA-024, NA-029 | live | Playwright goto cases (cross-process, anchor, redirects, about:blank, bad URL, bad SSL from a local HTTPS server with a self-signed certificate, failed main resource) | same outcome through `chrome.tabs`; a URL without a scheme (`asdfasdf`) gets `https://`, so the bad URL fails as `NAVIGATION_FAILED` with Chrome's net error |
