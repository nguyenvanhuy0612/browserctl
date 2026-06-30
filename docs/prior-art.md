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
   Cleaner than our `data-aibc-ref` DOM stamping (doesn't mutate the page under test;
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
intermediary. Never run against any SecureAge or otherwise sensitive account. Reference
value is only indirect (it reflects the official extension's hybrid design: CDP coordinate
input + accessibility tree, side-panel agent loop, per-action permission gating with
once/always/deny + a `highRisk` class, and an enterprise managed-policy URL blocklist) —
and even that is filtered through minified bundles, so treat it as approximate.

### Official extension internals (decompiled v1.0.66, git 2bdae70)
Reverse-engineered from the `claude-for-chrome` bundles (beautified). **Provenance:** the
*logic* is genuine Anthropic code; only the connection allowlist was swapped to third-party
domains (`*.111724.xyz`, `cfc.aroic.workers.dev`) — the stock agent bridge is
`wss://bridge.claudeusercontent.com/chrome/<token>`. File-name gotcha: the real code lives in
`assets/mcpPermissions-*.js` (CDP transport + tool schema + screenshot pipeline + policy),
`assets/accessibility-tree.js-*.js` (a11y tree, ~188 lines), `assets/sidepanel-*.js` (agent
loop + action DSL + system prompt). Borrowable, roughly by value:

1. **Token-budget screenshot sizing** (`mcpPermissions`). Instead of a fixed quality, they size
   to the Anthropic vision tiling budget: `pxPerToken=28`, `maxTargetTokens=1568`, binary-search
   the largest aspect-preserving size under budget, and do the downscale *inside* CDP via
   `Page.captureScreenshot { clip.scale }` (JPEG q75, `captureBeyondViewport:false`,
   `fromSurface:true`); re-encode stepping quality down by .05 to floor .1 if base64 > ~1.4MB.
   **Refines our just-shipped #2** (we use flat q55→q30). Upgrade path if screenshot tokens matter.
2. **`eval_js` / JS-result secret scrubber** (`mcpPermissions` ~3878). Before returning eval
   results to the model, recursively sanitize: block keys matching
   `password|token|secret|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key|bearer|oauth|session`,
   and block string *values* shaped like JWTs (`x.y.z`), base64 (`^[A-Za-z0-9+/]{20,}={0,2}$`),
   hex creds (`^[a-f0-9]{32,}$`), or cookie/query strings. Caps depth 5 / array 100 / string 1000.
   Keeps secrets out of context even when the model runs arbitrary JS. **We strip network/HAR
   headers but `eval_js` returns raw values unfiltered — real gap. Strong candidate. Pending.**
3. **Settle detection** (`mcpPermissions`): poll every 50ms on
   `document.readyState === 'complete' && document.getAnimations().length === 0`. The
   `getAnimations()` check catches CSS/JS animations that load/networkidle miss. Cheap upgrade for
   `wait_for` / pre-screenshot settle. **Pending.**
4. **Mid-action domain re-check** (`A()`): before each action, compare current hostname to the
   expected one; abort with "Domain changed from X to Y" on mismatch. Cheap guard against
   navigation races / mid-action redirects. Complements our target-tab pinning. **Pending.**
5. **CDP click/type correctness** (`mcpPermissions`): click = `mouseMoved`→100ms→`mousePressed`
   (12ms)→`mouseReleased` (button bitmask left=1/right=2/middle=4); type char-by-char with
   `Input.insertText` fallback for emoji/IME/multibyte; on Mac, inject native editor `commands`
   (`selectAll`/`undo`) on `dispatchKeyEvent` so `Cmd+A`/`Cmd+Z` actually fire. Our
   `coordinate_click` is a bare press/release — borrow the move+sleep and the Mac-commands detail.
6. **Live `ref` resolution** (`mcpPermissions`): ref clicks do `scrollIntoView({block:'center'})`,
   force layout (`el.offsetHeight`), then click the bounding-rect center — never trust stale model
   coordinates. Pairs with the WeakRef ref map (#3 above).
7. **a11y tree as compact indented TEXT, not JSON** (`accessibility-tree.js`):
   `textbox "Email" [ref_5] type="email"`; filter modes `all`/`interactive`; viewport-cull
   (aria-hidden + visibility + off-screen via getBoundingClientRect); role inference fallback;
   accessible-name cascade (`aria-label`→`placeholder`→`title`→`alt`→`<label for>`→value→text,
   cap 100); depth cap 15, output cap 50000 chars with an *actionable* over-limit error telling
   the model to reduce depth / pass `ref_id`. Cheaper than our JSON snapshot. Note: it does NOT
   pierce shadow DOM / iframes (relies on `all_frames:true` per-frame injection) — if we pierce
   in-process we're ahead.
8. **Safety model is layered, not keyword-scored** (correcting the earlier guess): (a) coarse
   permission grid keyed on **origin × tool-category** (`READ_PAGE_CONTENT`/`CLICK`/`TYPE`/
   `EXECUTE_JAVASCRIPT`) with once/always/deny remembered per pair; (b) **remote** domain
   categorization (`api.anthropic.com/.../domain_info`, 5-min cache) for org block decisions —
   `highRisk` gates the *autonomous mode*, not individual clicks; (c) a verbatim `<security_rules>`
   block in the system prompt (instructions only from user / never enter passwords-SSN-cards /
   never bypass CAPTCHAs / confirm before downloads/messages). Reusable architecture if we add gating.
9. **Enterprise `blockedUrlPatterns`** (`managed_schema.json` + matcher): normalize both sides
   (strip scheme + `www.`, lowercase, bare domain → `<domain>/*`, glob `*`→`.*`), regex-test against
   `hostname+pathname`; loaded from `chrome.storage.managed`, **hot-reloaded** via
   `chrome.storage.onChanged`. Clean copyable spec + `forceLoginOrgUUID` org lock.
10. **Compact line-DSL fast path** (`sidepanel`): one-token-per-action commands (`C x y`, `T text`,
    `S dir amt x y`, `N url`, ...) terminated by `<<END>>`, so the model batches several actions per
    turn against a single screenshot, with `{{platformModifier}}` templated per-OS. Bigger change,
    but a strong latency/cost win over one JSON tool-call per step.

Also noted (lower priority): `find` = an LLM ranking over the a11y text tree (vs CSS selectors);
indicator-suppression around each action so the overlay never pollutes the screenshot/click; a
throttled `Page.startScreencast` (100x100, q10, everyNthFrame 30) liveness preview.
