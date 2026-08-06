# Prior art: similar projects and what to borrow

Captured 2026-06-29. Survey of GitHub projects with the same shape as this one
(let an AI agent drive a real browser), and concrete things to adopt. Re-verify
star counts / features if this looks stale.

## The landscape

| Project | Stars | Architecture | Closest to us on |
|---|---|---|---|
| [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | ~34.5k | MCP server driving Playwright (headless/headed), **not** an extension | Gold-standard tool design |
| [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) | ~12k | Chrome **extension** + native-messaging bridge + MCP (HTTP/stdio) | Most feature-complete extension MCP |
| [AgentDeskAI/browser-tools-mcp](https://github.com/AgentDeskAI/browser-tools-mcp) | ~7.3k | **Extension -> Node middleware -> MCP** (exactly our 3 tiers) | Identical architecture |
| [BrowserMCP/mcp](https://github.com/BrowserMCP/mcp) | ~6.7k | Extension + MCP over local **websocket** | Same transport as us |
| [335234131/agent-browser-mcp](https://github.com/335234131/agent-browser-mcp) | ~230 | MCP driving real Chrome via CDP | CDP reference |
| [lxe/chrome-mcp](https://github.com/lxe/chrome-mcp) | ~48 | Control Chrome without screenshots (DOM) | DOM-only reference |
| [noemica-io/open-claude-in-chrome](https://github.com/noemica-io/open-claude-in-chrome) | small | Extension (CDP via `chrome.debugger`) + MCP + native-messaging host, TCP rendezvous | Clean-room clone of the official "Claude in Chrome"; readable JS reference |
| [cocodem/claude-for-chrome](https://github.com/cocodem/claude-for-chrome) | small | **Not a project** — decompiled/minified repackage of Anthropic's official extension + a patch | Only shows the official extension's shape; do NOT run (see note) |

Takeaway: our **extension -> local bridge -> MCP** design is the established
pattern (browser-tools-mcp and BrowserMCP are the same). We are not reinventing;
we are in good company. We are even slightly ahead of browser-tools-mcp on HAR
export.

## What each does that we should borrow

### playwright-mcp (design reference, even though it's not an extension)
- **`browser_wait_for`** with time / text-appears / text-disappears. Directly fixes
  our SPA screenshot-caught-stale-frame problem. **Adopt.**
- **Network: list then fetch-by-index.** `browser_network_requests` lists; a second
  tool retrieves full headers/body for one request by index. Avoids dumping every
  body into the context. **Adopt** (we currently only list).
- **Snapshot is the accessibility tree, and screenshots are explicitly "not for
  actions."** Our DOM-index snapshot is the same idea. Worth tightening our element
  identity (see below).
- **Modular capabilities via `--caps`** (vision/devtools/pdf/storage). Validates
  keeping CDP opt-in, which we already do.
- Tool naming `browser_*` — matches ours.

### hangwin/mcp-chrome
- **Dual network capture:** `chrome.webRequest` (light, **no debugger banner**,
  headers/status only) vs Debugger API "with response bodies." **Adopt the light
  webRequest mode** so basic network inspection needs no banner; keep our debugger
  path for bodies/HAR.
- `chrome_inject_script` + `chrome_send_command_to_inject_script` — a channel to a
  long-lived injected page script. More powerful than one-shot `eval_js`. Consider later.
- `chrome_get_interactive_elements` — same indexed-DOM approach as our snapshot.
  Confirms our choice.
- Semantic vector search across open tabs — advanced/optional, probably out of scope.

### AgentDeskAI/browser-tools-mcp (our exact 3-tier architecture)
- **Token hygiene in the middleware:** truncates long strings, de-dupes repeated log
  objects so payloads fit LLM context. **Adopt** for our console/network/snapshot
  responses (YouTube already produced 73 requests / 85 HAR entries — easy to blow context).
- **Strips cookies and sensitive headers** before sending to the LLM. **Adopt** for
  `export_har` / `get_network_requests` (auth tokens, Cookie, Set-Cookie).
- Screenshot over websocket command — same as ours.
- Lighthouse/SEO/a11y audits via a separate Puppeteer instance — out of scope.
- No HAR export — we are ahead here.

### BrowserMCP/mcp
- Value prop worth stating as a **feature**: uses the **real, logged-in browser
  profile and real fingerprint**, so it avoids bot detection / CAPTCHAs that hit
  headless Playwright. This is the core reason an extension beats headless for
  logged-in and QA scenarios. Document it.

## Recommended changes, mapped to our roadmap

Priority order:

1. **`wait_for` tool** (time / selector / text appears). Fixes screenshot timing;
   makes dynamic-page steps reliable. (playwright-mcp)
2. **Light network mode via `chrome.webRequest`** — no debugger banner for
   headers/status/timing; keep debugger only for response bodies. (mcp-chrome)
3. **Network: fetch-one-by-index with body** (`Network.getResponseBody`), instead of
   returning everything. Completes our HAR bodies gap too. (playwright-mcp + mcp-chrome)
4. **Token hygiene + secret stripping** before returning console/network/HAR: truncate,
   de-dupe, drop Cookie/Authorization/Set-Cookie. (browser-tools-mcp)
5. **Stabilize element identity** in snapshot: today indices are positional and reset
   each snapshot. Consider a short-lived ref id (e.g. data attribute) so a click after
   minor DOM churn still resolves. (playwright refs)
6. Document the **real-profile advantage** in the README. (BrowserMCP)

Out of scope for now: Lighthouse audits, semantic tab search, video/tracing.

## Update 2026-06-30: two more "Claude in Chrome" clones

Both control the browser via **CDP (`chrome.debugger`)** as the primary path, so both
always show the "is being debugged" banner. Our default DOM-index path (no debugger,
no banner) remains a real advantage they don't have; the banner only appears once we
use a `cdp_*` tool. Neither was in the original survey above.

### noemica-io/open-claude-in-chrome (readable JS — the useful one)
Clean-room MIT clone of Anthropic's "Claude in Chrome": MV3 extension driven over CDP,
exposed through MCP, bridged by a native-messaging host with a TCP rendezvous on
`127.0.0.1:18765`. ~18 tools (5-6 are stubs). What to borrow:

1. **`deviceScaleFactor: 1` on attach** (`extension/background.js:146-160`). Forces
   screenshots into CSS-pixel space so coordinate clicks line up on Retina/HiDPI; without
   it, Apple Silicon produces 2x screenshots and every coordinate is off by the DPR.
   **DONE 2026-06-30** in `cdp.js attach()` (we use `width:0,height:0` so only the scale
   factor is overridden and the page does not reflow).
2. **Screenshot token hygiene** (`background.js:317-340`): JPEG quality 55, re-shoot at 30
   if base64 > 500KB. **DONE 2026-06-30** for `screenshot` (background.js) and
   `capture_screenshot` (cdp.js); JPEG is now the default, `format:"png"` opt-in for
   lossless pixel-diff QA.
3. **Element refs via `WeakRef`** (`content.js:13-37`): `elementMap[ref]=new WeakRef(el)` +
   a reverse `WeakMap`; `resolveRef` deletes and reports the ref when the element was GC'd.
   Cleaner than our `data-bctl-ref` DOM stamping (doesn't mutate the page under test;
   distinguishes "stale ref" from "element gone"). Consider for `content.js`. **Pending.**
4. **Tab-group scoping** (`background.js:71-96`, `recoverTabGroupState`): automation runs in
   a dedicated window + tab-group titled "MCP"; every handler guards with `isInGroup(tabId)`
   so the agent can't touch the user's personal tabs, and group state is recovered after a
   service-worker restart. Concrete implementation of our roadmap's "hard tab-group scoping".
   **Pending.**
5. **Multi-session multiplex** (`host/mcp-server.js`): first MCP server binds the port =
   primary; later ones get `EADDRINUSE`, connect as clients, primary multiplexes via
   prefixed request IDs. Maps to our "multi-tab sessions" roadmap — easier for us since our
   bridge is already a central relay (just add a `sessionId`); skip their TCP-rendezvous
   plumbing (they need it because the native host and MCP server are separate parent procs).

### cocodem/claude-for-chrome — do NOT run
Not an independent project: a decompiled, minified repackage of Anthropic's official
Web Store extension plus a `request.js` patch that reroutes the Anthropic API and OAuth
through a third-party proxy (`openclaude.111724.xyz` / a Cloudflare worker). Copyright-
infringing redistribution; routes API keys / OAuth / all model traffic through an unknown
intermediary. Never run it against a work or otherwise sensitive account. Reference
value is only indirect (it reflects the official extension's hybrid design: CDP coordinate
input + accessibility tree, side-panel agent loop, per-action permission gating with
once/always/deny + a `highRisk` class, and an enterprise managed-policy URL blocklist) —
and even that is filtered through minified bundles, so treat it as approximate.

### Official extension internals — analysis withheld

An earlier revision of this file summarised the internals of Anthropic's official
Claude-in-Chrome extension, reconstructed from its shipped bundles. That analysis is not
published here: it was derived from a commercial product's compiled code, and nothing in
browserctl depends on it. Every design decision it touched is argued on its own merits
elsewhere in this file.
---

## Update 2026-08-04: a correction, a missed class, and a function-level comparison

Two things changed since 2026-06-30: a fact in the table above went stale, and the
original survey missed an entire class of tools.

### Correction: playwright-mcp is no longer "not an extension"

The landscape table describes playwright-mcp as "MCP server driving Playwright
(headless/headed), **not** an extension". That is now wrong. playwright-mcp supports
an **extension mode** that attaches to an already-running Chrome/Edge via the
Playwright Extension, and its default mode already uses a persistent local profile.

Impact: the "real, logged-in profile and real fingerprint" advantage recorded under
BrowserMCP — and adopted into our README as the core reason an extension beats
headless — is **materially narrowed**. It is no longer a structural differentiator,
only a convenience one. This is the single biggest landscape change since the
original survey.

What still holds: playwright-mcp's extension mode drives the tab you point it at. It
has no equivalent of our pinned-target + background-tab + no-focus-steal control
model, and it goes through CDP, so the "is being debugged" banner is always present.

### The desktop computer-use class (missing from the original survey)

| Project | Shape | Why it loses inside a browser |
|---|---|---|
| UI-TARS Desktop (ByteDance) | Desktop app + own model; screenshot -> pixel coords | Browser is opaque pixels |
| Open Computer Use | Desktop control exposed over MCP (macOS/Linux/Windows) | same |
| vitalops/opendesk | Computer-use tools across one or more machines | same; but does have multi-machine |
| remorses/usecomputer | Screenshot/click/type/scroll automation CLI | same |
| OS-Copilot | Modular perception / planning / action | same |
| Fazm | Accessibility-tree first, macOS, sub-second actions | OS-level a11y tree is coarser than the DOM |

For work inside a browser these are a tier below any DOM-based tool: no element
identity beyond pixel coordinates, no network/console/HAR, no concept of shadow DOM
or iframes, no cookies/storage/eval, `sleep` instead of real wait conditions, one
screenshot round-trip per action, and they must own the visible screen. The 2026
consensus is that pure screenshot+vision is too slow and too expensive for real
workflows — the same conclusion our DOM-first design started from.

Where they beat us: anything **not in the DOM**. The OS file picker, certificate and
OS-level auth prompts, `chrome://` pages, the Web Store, other extensions' popups.
Part of that we can close via CDP (see `backlog-capability-gaps.md`); the
`chrome://` and Web Store cases we structurally cannot.

### Function-level comparison, browser scope only

Us: 64 MCP tools; extension + bridge + MCP; DOM/a11y-first with CDP opt-in.
playwright-mcp: ~70 tools with all `--caps` enabled. chrome-devtools-mcp: 28 tools.
hangwin/mcp-chrome: ~20 tools.

**Unique to us** — no equivalent in the other three:

- Pinned target + background-tab operation with no focus steal, plus per-command
  `tabId` for concurrent agents. No other project treats "do not disturb the human"
  as a design requirement.
- `spoof_visibility` — patching `document.hidden` to unstick lazy-load in a
  backgrounded tab. A direct consequence of the above and not seen anywhere else;
  our most original contribution.
- No debugger banner on the default path. playwright-mcp extension mode and
  chrome-devtools-mcp are both always-CDP.
- `export_har`. Neither playwright-mcp nor chrome-devtools-mcp exports HAR.
- `wait_settle` = `readyState === "complete"` AND `getAnimations().length === 0`.

That is roughly 6-8 tools' worth of genuinely differentiated behaviour. The other
~55 tools have equivalents elsewhere, frequently more mature on edge cases.

**Redundant with the others:** snapshot / read_page (~`browser_snapshot`), find,
click / type / hover / select_option / press_key / scroll, screenshot and
element_screenshot, eval_js, cookies and storage, console and network capture,
coordinate input (~`--caps=vision`), print_pdf (~`--caps=pdf`), wait_for, tab
management.

**They have, we do not** — ranked by value to us:

1. Network mocking / route interception. playwright-mcp `--caps=network`:
   `browser_route`, `browser_route_list`, `browser_unroute`,
   `browser_network_state_set`.
2. File upload. playwright-mcp `browser_file_upload` + `browser_drop`;
   chrome-devtools-mcp `upload_file`.
3. Dialog handling. `browser_handle_dialog` / `handle_dialog`.
4. `storage_state` export/import — bulk cookie + localStorage snapshot to a file.
5. Emulate / resize / CPU and network throttling.
6. Performance trace + insights, Lighthouse, heap snapshot (chrome-devtools-mcp).
   Deliberately out of scope; see `backlog-chrome-devtools-parity.md`.
7. Test assertions and locator generation (playwright-mcp `--caps=testing`). Out of
   scope by positioning; see below.
8. Persistent injected-script channel, semantic tab search, history and bookmarks
   (mcp-chrome). Items 1 and 8's script channel were already on the roadmap.

Items 1-5 are tracked in `backlog-capability-gaps.md`.

### Positioning decision (2026-08-04)

This project is a **general-purpose, high-capability browser control surface for
agents**. It is explicitly **not** a test-automation framework.

Non-goals, and why:

- **Locator generation and test assertions.** playwright-mcp does this better and
  emits locators that paste straight into real Playwright tests. Competing here
  means losing on our opponent's home ground.
- **Performance tracing, insights, Lighthouse.** Needs the DevTools trace engine;
  cost far exceeds value (see `backlog-chrome-devtools-parity.md`).
- **Matching playwright-mcp on feature count.** The moat is the control model, not
  the tool count. Adding tools that already exist elsewhere buys nothing.

What we optimise for instead: driving the user's real, logged-in browser unattended,
in the background, without stealing focus and without a debugger banner on the
common path.
