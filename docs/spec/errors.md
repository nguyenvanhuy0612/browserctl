# Spec: errors

An error is a message to an agent that has to decide what to do next. It has one job: make the next
move obvious. Three things follow from that.

## Rules

**1. An error must be distinguishable from a missing capability.**
`unknown action: get_text` reads as "this does not exist", so the agent stops asking and writes
`eval_js`. Six of the commonest reads failed this way, because tool names and protocol action names
are different lists and only the first is visible to an agent [F49].

**2. A valid answer is never an error.**
`get_count` returned `ELEMENT_NOT_FOUND` when the count was zero. Counting is a question about a set;
zero is the answer [F52]. Three states, three responses:

```
get_count("a")                      -> 228
get_count("tr > td > span > link")  -> 0  + "This is an answer, not a failure … If you meant an
                                            ARIA role, CSS needs [role=...]"
get_count("a[[[")                   -> INVALID_SELECTOR: 'a[[[' is not a valid CSS selector
```

The invalid-syntax case needs its own check: `deepQueryAll` swallows selector errors and returns `[]`,
so bad CSS would report "0 matches" — indistinguishable from a valid selector matching nothing.

**3. An error must survive transport.**
`callBridge` once retried application errors — dispatching the action a second time — and relabelled
them as connectivity failures, discarding `code`, `diagnostics` and `recoveryHint` [F24]. One layer
down, `crossFrame` mapped any non-ok frame reply to `null`, so a content-script exception surfaced as
*"no frame could handle this (page not accessible)"* — a permissions-shaped message for a crash, which
sent debugging in the wrong direction for an hour [F42].

> Never reduce a reply to a boolean. Whatever the layer below said, say it.

## Shape

```jsonc
{
  "ok": false,
  "error": "human sentence, with the specific values in it",
  "code": "STALE_REF",
  "diagnostics": { "ref": "@ref_2", "relocatedTo": "ref_199", "label": "Hacker News" },
  "recoveryHint": "Retry the same action with @ref_199. No re-snapshot needed."
}
```

`error` says what happened **to this element, on this page** — not a template. `diagnostics` carries
the values a caller could branch on. `recoveryHint` is the next call, spelled out.

## Codes

| Code | Meaning | Recovery it must offer |
|---|---|---|
| `ELEMENT_NOT_FOUND` | nothing matched the target | what the page does call things — see `nearest` / `pageLabels` |
| `STALE_REF` | the ref's element is gone | the ref that now carries the same label, when one exists |
| `ELEMENT_NOT_INTERACTIVE` | matched text, but nothing listens for a click | the nearest genuinely interactive ancestor |
| `ELEMENT_NOT_EDITABLE` | target cannot take text | candidate input refs on the page |
| `ELEMENT_DISABLED` | the browser will suppress this input | none — this is a hard stop |
| `SCROLL_TARGET_NOT_SCROLLABLE` | the target does not scroll | the nearest scrollable ancestor's ref |
| `MODAL_NOT_DISMISSED` | dismiss ran and the modal is still open | what was tried |
| `INVALID_SELECTOR` | malformed CSS | that ARIA roles are not CSS tags; `find` searches by label |
| `WAIT_TIMEOUT` | the condition never held | `readyState`, and the closest text actually on the page |
| `NET_CAPTURE_NOT_STARTED` | reading a capture that was never started | `net_start` |
| `NETWORK_IDLE_TIMEOUT` | still in flight at the deadline | `wait_settle`, or a `maxInFlight` tolerance |
| `MCP_ONLY_TOOL` | routed a client-layer tool through `browser_action` | call `browser_<name>` directly |
| `NOT_A_PAGE_ACTION` | the extension cannot serve this name | the layer that can |

## Failures that are the tool working

Two responses look like errors and are correct behaviour. Both must say so in the message, and the
audit harness grades them on the quality of the error rather than its absence:

- `wait_for` on text that is not present.
- `net_get` before `net_start` — the old behaviour returned an empty list, which reads as "no requests"
  rather than "not recording" [F23].

## Diagnostics worth carrying

- `wait_for` on timeout: `readyState`, whether the text is present in another case, and the longest
  prefix of the query that *is* on the page. Text matching is case- and whitespace-insensitive by
  default; a raw `includes` burned two full timeouts on "weekly downloads" versus "Weekly
  Downloads" [F45].
- `find` on zero matches: `nearest` (diacritics/case-folded candidates) **and** `pageLabels` (what this
  page actually calls things). A probe spent three calls guessing `account`, `profile`, `studio` on a
  Vietnamese UI where the control was "Trình đơn tài khoản". No fuzzy match bridges that; showing the
  page's vocabulary does [F58].
