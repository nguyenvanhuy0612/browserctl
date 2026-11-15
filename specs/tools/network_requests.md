# `network_requests`

Status: verified
Depends on: `sessions.md`, `relay.md`, `errors.md`

## Purpose

See the requests the tab made (to find the API behind a page) and read response bodies.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `filter` | string | no | | substring of the URL, or `/regex/` | |
| `types` | string[] | no | all | `document`, `xhr`, `script`, `stylesheet`, `image`, `media`, `font`, `websocket`, `other` | `xhr` covers `fetch` too: `webRequest` reports both as `xmlhttprequest` |
| `since` | integer | no | | a request `id` | only newer requests |
| `limit` | integer | no | 50 | 1 to 500 | newest first |
| `id` | integer | no | | | details of one request instead of a list |
| `body` | boolean | no | `false` | with `id` | include the response body |
| `captureBodies` | boolean | no | | | start (true) or stop (false) keeping response bodies for this tab |
| `tab` | integer | no | current tab | owned tab | which tab |

## Behaviour

1. Request metadata comes from `chrome.webRequest` in the extension (no debugger): method, URL,
   type, status, request and response headers, timing, from the moment the tab became owned. The
   daemon keeps the last 1000 per tab.
2. Response bodies need the CDP lane: `captureBodies: true` attaches the tab, enables `Network`,
   and pins the attachment until `captureBodies: false` or the session ends. Bodies are kept for
   requests made while capture is on (at most 10 MB per body, 100 MB per tab).
3. `id` with `body: true` for a request without a captured body → `BODY_UNAVAILABLE`, hint:
   turn on `captureBodies` and repeat the action.
4. Requests to replay with cookies: `evaluate` with `fetch` in the page (the page's cookies and
   origin apply); this tool does not send requests.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `requests` | `{id, method, url, type, status, ms}[]` | list form | |
| `request` | `{id, method, url, type, status, requestHeaders, responseHeaders, timing, body?, bodyTruncated?}` | `id` form | |
| `capturingBodies` | boolean | yes | |
| `lane` | `"dom"` \| `"cdp"` | yes | `cdp` when capture is on |

## Errors

`BODY_UNAVAILABLE`, `NO_TAB`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `DEBUGGER_CANCELED`,
`DEBUGGER_BUSY`, `INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
List the tab's network requests (filter, types, since, limit) or one request's details (id).
Response bodies need captureBodies: true first (shows Chrome's debugging bar until turned off).
To call an API with the page's cookies, use evaluate with fetch.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| NET-E01 | live | page making 3 fetches | listed with status, no debugger |
| NET-E02 | live | `filter`, `types`, `since` | correct subset |
| NET-E03 | live | body without capture | `BODY_UNAVAILABLE` |
| NET-S01 | site | Facebook after load, `limit: 5` | requests listed |
| NET-E04 | live | capture on, fetch JSON, read body | body equals the response; bar shown; capture off detaches after idle |
| NET-E05 | live | playwright-mcp `network.spec.ts`: a click's fetch (200) and a missing image (404), a substring `filter`, an invalid `/regex/` filter, ids that stay with their request, details of one request with its headers, a failed request | listed with status; filtered; `INVALID_PARAMS`; the same id finds the same request; `requestHeaders` and `status`; the failure with its error, listed once |

Not adopted from `network.spec.ts`: the `static` option (`types` selects instead), the list's text
numbering (ids are fields), saving a response body to a file (bodies come back in the result).
