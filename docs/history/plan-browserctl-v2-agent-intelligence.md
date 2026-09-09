# browserctl v2: AI-Agent Intelligence & Token Optimization

Captured 2026-09-08. The original tracking document and execution plan for upgrading `browserctl`
into an AI-agent browser intelligence layer. Superseded — see the follow-up below.

> **Follow-up:** the Phase 1-4 items below were implemented, but blind-agent probing afterwards found
> 25 defects in that work, several of which silently reported success for actions that never happened.
> See `fix-plan-v2-verified-2026-09-08.md` for the verified findings, their repros and their status.
> Where the two documents disagree about behaviour, that one is current.

## 1. Overview & Objectives

Traditional browser automation tools dump massive raw DOM structures or unbounded element lists, forcing AI agents into expensive exploration loops, high token consumption, and fragile retries.

This project enhances `browserctl` with:
1. **Viewport-scoped & landmark-pruned snapshots**: reducing token consumption by 75-85% on complex SPAs.
2. **Complete physical-equivalent event sequencing**: eliminating click failures on modern frameworks (React, Vue, Angular, Polymer/Web Components) without sacrificing background tab execution.
3. **Adaptive mutation quiescence (smart wait)**: waiting for asynchronous hydration and DOM settling before returning control to the agent.
4. **Structured failure diagnostics & next-action hints**: replacing bare error strings with actionable machine-readable diagnostics.
5. **Automated benchmark & telemetry harness**: tracking token usage, latency, and success rates across 20+ real-world web architectures.

All improvements are strictly **generic** across modern web applications and do not rely on website-specific adapters or hardcoded rules.

---

## 2. Implementation Progress Tracking

### Phase 1: Viewport Scoped Snapshot & Token Optimization
- [x] Add 2D viewport intersection checks to `isVisible` / snapshot collection in `extension/content.js`.
- [x] Add `scope` parameter to `snapshot` (`viewport` by default, `all` for full page inspection).
- [x] Implement repetitive element deduplication (folding runs of identical structural items like repeated chat buttons or feed cards).
- [x] Implement landmark and dialog tagging (`[Modal Active]`, `[Main Content]`, `[Navigation]`).
- [x] Update MCP schema in `mcp/index.js` and CLI formatting in `cli.js`.
- [x] Verification: Tested on long/complex pages (ChatGPT, YouTube, Wikipedia); element count dropped from 370+ to 50 on YouTube and 1376 to 97 on Wikipedia.

### Phase 2: Input Event Sequencing & Adaptive Quiescence
- [x] Upgrade DOM click in `extension/content.js` to dispatch complete event sequence: `pointerover` -> `pointerenter` -> `pointerdown` -> `mousedown` -> `focus` -> `pointerup` -> `mouseup` -> `click`.
- [x] Add overlay detection via `document.elementFromPoint` before clicking to prevent clicking covered elements.
- [x] Upgrade `wait_settle` with adaptive debounce (100ms debounce, 250ms default ceiling for auto-settle).
- [x] Verification: Tested physical event sequencing across React/Lit/Shoelace web components with 74% verified action rate in background tabs.

### Phase 3: Structured Diagnostics & Next-Action Hints
- [x] Standardize error taxonomy (`ELEMENT_NOT_FOUND`, `ELEMENT_OUT_OF_VIEWPORT`, `ELEMENT_COVERED`, `ELEMENT_DISABLED`, `STALE_REF`, `INVALID_ARGUMENT`).
- [x] Return structured diagnostic objects with contextual remedies (`code`, `diagnostics`, `recoveryHint`).
- [x] Expose page state metadata in snapshot responses (`viewport`, `pageState`, `foldedCount`).
- [x] Add Viewport & Scroll Census Header + Footer Actionable Notice with Quick Actions affordances (`click`, `fill`, `press`, `scroll`, `get text`) to eliminate Lite model hallucination and tool unfamiliarity.
- [x] Flexible position-independent CLI flags and ergonomic aliases (e.g. `--tab <id>` before action, `tabs`, `switch`, `get_text`, `get_count`).
- [x] Autonomous multi-step guidance hints & schema guards: eliminates Lite model pause-to-ask behavior on SPAs and prevents empty tool probes.
- [x] Verification: Verified 100% structured error rate across test queries with actionable remediation hints.

### Phase 4: Automated Benchmark Suite & 20+ Complex Sites Testing
- [x] Create benchmark harness in `test/benchmark/run_benchmark.js`.
- [x] Implement telemetry recording in `bridge/telemetry.jsonl` (tokens, latency, retry counts).
- [x] Execute test matrix across 21 diverse web architectures (Infinite scroll, Shadow DOM, heavy SPAs, rich-text editors, complex forms).
- [x] Generate comparative benchmark report and update documentation.

### Empirical Benchmark Results (21 Real-World Web Architectures)

| Metric | Measured Value |
| :--- | :--- |
| **Total Web Architectures Tested** | 21 diverse sites |
| **Successful Automations** | 19 / 21 (90.5%) |
| **Average Element Count** | 64 (Viewport) vs 236 (Full DOM) |
| **Average Token Reduction** | **60% average** (up to **94%** on Wikipedia, **91%** on MDN Docs, **81%** on ArXiv) |
| **Average Census Breakdown** | 22 buttons / 271 links (`a[href]`) / 5 inputs per page |
| **Hidden & Collapsible Structures** | 151 `aria-expanded="false"` / 137 `[hidden]` detected across test set |
| **Structured Diagnostic Error Rate** | **100%** (clean error codes + recovery remedies) |
| **Physical Event Sequence Success** | **74%** across complex frameworks |
| **Telemetry Log Path** | `bridge/telemetry.jsonl` |

---

## 3. Architecture & Data Contracts

### 3.1. Viewport Snapshot Output Schema
```json
{
  "url": "string",
  "title": "string",
  "scope": "viewport | all",
  "viewport": {
    "width": 1280,
    "height": 800,
    "scrollX": 0,
    "scrollY": 450,
    "scrollPercent": 25
  },
  "pageState": {
    "isBusy": false,
    "hasActiveModal": false,
    "activeModalTag": null
  },
  "elements": [
    {
      "index": 0,
      "ref": "ref_1",
      "tag": "button",
      "role": "button",
      "text": "Submit",
      "inViewport": true,
      "landmark": "modal | main | nav | header | footer"
    }
  ],
  "compactView": "string",
  "foldedCount": 0
}
```

### 3.2. Structured Action Result Schema

As implemented (see `fix-plan-v2-verified-2026-09-08.md` F13/F14 — the shape below was
aspirational in the first draft of this document and did not exist in code):

```json
{
  "clicked": "ref_5",
  "waitedMs": 280,
  "effect": {
    "measured": true,
    "domMutated": true,
    "mutationCount": 34,
    "urlChanged": false,
    "targetStillPresent": true
  },
  "dispatchedTo": "<button> inside <sl-button> shadow root",
  "warning": "..."
}
```

`effect` is the honesty contract: `measured` says whether the action waited long enough to
observe anything (false when `autoSettle` is off), and `domMutated:false, mutationCount:0,
urlChanged:false` on a click means the page did not react — the response adds an explicit
"treat this click as NOT confirmed" warning in that case. The mutation counter is attached
BEFORE the event is dispatched, so a handler that mutates synchronously is still counted.
`dispatchedTo` appears only when the event had to be routed into a Web Component's shadow
root. `type`/`fill`/`paste` return the same `effect`, plus `valueNow` for form fields.

### 3.3. Structured Error Schema

```json
{
  "ok": false,
  "error": {
    "code": "ELEMENT_NOT_FOUND | ELEMENT_OUT_OF_VIEWPORT | ELEMENT_COVERED | ELEMENT_DISABLED | STALE_REF | INVALID_ARGUMENT | ELEMENT_NOT_EDITABLE | ELEMENT_NOT_INTERACTIVE | SCROLL_TARGET_NOT_SCROLLABLE | MODAL_NOT_DISMISSED | NET_CAPTURE_NOT_STARTED",
    "message": "\"Approve Payment\" was found only as plain text inside <span>, which has no click handler",
    "diagnostics": { "text": "Approve Payment", "tagName": "span", "ref": "ref_12" },
    "recoveryHint": "Use get_text on @ref_12 to read it, or click a real control such as: @ref_3 (button: Submit)"
  }
}
```

The MCP layer renders this as `Error [CODE]: message` / `Diagnostics: ...` /
`Suggested Remedy: ...`. Until the F24 fix these fields were discarded one layer above the
extension: `callBridge` caught application errors in its transport retry loop, dispatched the
action a second time, and relabelled the failure as `cannot reach bridge at ...`. The
"100% structured error rate" figure in §2 measured the extension, not what reached the agent.
