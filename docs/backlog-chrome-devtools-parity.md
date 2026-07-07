# Backlog: extend ai-browser-control to cover chrome-devtools MCP

Captured 2026-07-03. Deferred — not yet implemented. Goal: fold the useful parts of
the `chrome-devtools` MCP into `ai-browser-control` so the former can be dropped.

## Why

`ai-browser-control` (`browser` MCP) already speaks CDP via `chrome.debugger`
(`extension/cdp.js`), and the extension manifest already holds the `debugger` +
`<all_urls>` permissions. It drives ONE pinned tab in the background (no focus
steal, no "is being debugged" banner unless CDP is attached). `chrome-devtools`
instead needs Chrome launched with `--remote-debugging-port=9222` and owns the
whole browser. For our QA workflow the `browser` model is preferable, so
consolidating onto it is the right direction.

## What chrome-devtools has that browser lacks

| chrome-devtools feature | Cover? | How in ai-browser-control |
|---|---|---|
| Network/console/HAR, screenshot, eval, cookies | Already have | `Network.*`, `Runtime.*`, `Log.*`, `Page.captureScreenshot` in cdp.js |
| Device emulation (`emulate`/`resize`) | Easy | already use `Emulation.setDeviceMetricsOverride`; add width/height/mobile/UA |
| CPU / network throttling | Easy, high-value for QA | `Emulation.setCPUThrottlingRate` + `Network.emulateNetworkConditions` |
| Performance trace + insights (`performance_*`) | Hard | needs DevTools trace engine to parse trace events into insights — NOT worth reimplementing |
| Heap snapshot (`take_heapsnapshot`) | Medium / narrow value | `HeapProfiler.takeHeapSnapshot` streams MBs of JSON; only useful as a FILE a human loads into DevTools, not agent-consumable |
| Lighthouse audit | Hard / skip | Lighthouse is an npm lib that owns its own raw-CDP session (port 9222); does not fit the `chrome.debugger` model. Run `npx lighthouse` standalone when needed. |

Note: `browser_audit` already returns `Performance.getMetrics` basics
(JSHeapUsedSize, LayoutCount, ScriptDuration, TaskDuration) plus a lightweight a11y
audit. `JSHeapUsedSize` already covers the cheap end of "memory".

## Scope decision still open (the cost driver)

The performance capability is the fork that dominates effort. Three options:

1. **Web Vitals summary (light, recommended default).** LCP/CLS/FCP/TTFB/load +
   long tasks via `PerformanceObserver` / Navigation Timing through `eval_js`. No
   Tracing domain. ~1 file, ~80 LOC, robust. Covers ~90% of day-to-day QA. No deep
   flame-chart insight.
2. **Full trace + insight.** Embed/parse DevTools trace via `Tracing.*`. Very
   heavy (needs Google's trace engine), high risk, not worth it for QA.
3. **Web Vitals + raw trace file export.** Option 1 plus a tool that writes a raw
   `trace.json.gz` to disk (via the bridge) for manual loading into DevTools UI. No
   auto-insight. Two tools.

Leaning option 1 (optionally 3 if manual deep-dives ever come up). Skip option 2.

Also worth adding regardless of the perf choice, both cheap + high QA value:
- `browser_emulate` — device metrics (width/height/mobile/deviceScaleFactor) + UA override.
- `browser_throttle` — CPU rate + network conditions (offline / slow-3G / 4x CPU) for
  perf-degradation testing.

## Implementation pattern (verified against the code)

Each new capability is three edits, no new architecture:

1. **`extension/cdp.js`** — add a `case "<action>":` to the `handleCdp` switch
   (use `send(tabId, "<Domain>.<method>", params)`), and add `"<action>"` to the
   exported `CDP_ACTIONS` array so background.js routes it to `handleCdp`.
2. **`mcp/index.js`** — `server.registerTool("browser_<x>", { title, description,
   inputSchema (zod) }, tool("<action>", async (args) => text(await
   callBridge("<action>", args))))`. Follow the existing `export_har` / `audit`
   registrations as the template.
3. **`bridge/server.js`** + **`extension/background.js`** — generic relay by action
   name; CDP actions dispatch through `CDP_ACTIONS` membership. Usually no change
   needed beyond step 1's array entry.
4. Document the new commands in **`PROTOCOL.md`**.

## When resumed

Re-enter via `superpowers:brainstorming` to lock the scope (answer the perf-scope
question above), then `superpowers:writing-plans`. Spec dir: `docs/superpowers/specs/`.
