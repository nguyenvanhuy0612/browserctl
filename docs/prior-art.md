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
