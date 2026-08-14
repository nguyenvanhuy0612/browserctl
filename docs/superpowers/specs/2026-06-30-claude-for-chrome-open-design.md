# browserctl: "claude-for-chrome, open + extras" — design

Captured 2026-06-30. Design for browserctl. Approved direction, implementing in
4 phases.

## North-star

Reach capability parity with Anthropic's official "Claude in Chrome" browser-control
surface, but **open** (no domain blocklist, no org lock, no per-action permission
gating) and with the agent kept **external** (driven over MCP/HTTP — no in-extension
side panel, agent loop, system prompt, or Anthropic-API integration). Keep the extras
this project already has that the official extension lacks (HAR export, record/replay,
light `chrome.webRequest` capture, secret stripping on network output, a neutral
MCP + HTTP control surface).

## Architecture principle: DOM-first, CDP-fallback

Every structured interaction is done through the DOM / content script (no debugger
banner). Drop to CDP (`chrome.debugger`, banner accepted) only for the four things the
DOM cannot do:
1. Pixel-coordinate input on canvas/WebGL/maps.
2. Screenshotting a background tab (DOM `captureVisibleTab` only captures the visible tab).
3. Console / full network (with bodies) / HAR capture.
4. JS eval that must bypass page CSP.

This is the project's existing philosophy (DOM-index primary, CDP opt-in); the work
raises it to full parity. A useful consequence: a task that only clicks/types/reads via
DOM never attaches the debugger, so no banner appears until the first screenshot/CDP tool.

## Capability matrix

| Capability | Mechanism | Status |
|---|---|---|
| read_page (a11y tree as indented text + refs) | DOM content script | new |
| get_page_text | DOM | have (`get_page_content`) |
| find (text match → refs) | DOM | new (no LLM-over-tree; agent is external) |
| navigate / tabs (new/close/switch/list) | chrome API | have |
| click / type / hover / select / press_key by index\|ref | DOM | have (+ ref identity) |
| form_input / fill | DOM | have |
| scroll / scroll_to | DOM | have |
| javascript eval | DOM MAIN world; CDP to bypass CSP | have (`eval_js`) |
| screenshot | DOM `captureVisibleTab` when target active; CDP `Page.captureScreenshot` for background tab | upgrade |
| coordinate click/drag/hover/key (canvas/visual) | CDP | upgrade |
| zoom / element screenshot (clip) | CDP | have |
| console / network+body / HAR | CDP | have |
| light network (no banner) | `chrome.webRequest` | have (extra) |

## Components (what changes)

Concentrated in `extension/background.js`, `extension/cdp.js`, `extension/content.js`,
with dispatch/tool wiring in `background.js`, `mcp/index.js`, and docs in `PROTOCOL.md`.

### 1. Background tab control (background.js + cdp.js)
- `targetTab()`: **pin on first touch** — if no valid pinned target, resolve the focused
  active tab and pin it (`targetTabId = tab.id`); never silently follow the active tab
  afterward. Removes the drift bug. `chrome.tabs.onRemoved` clears `targetTabId` when the
  target closes. `navigate`/`new_tab` keep pinning; `switch_tab {id}` is the explicit
  retarget (may point at a user tab).
- `screenshot()`: remove the `tabs.update(active:true)` activation. Capture the target via
  CDP `Page.captureScreenshot` (auto-attach if needed) so a background tab is captured
  with no focus steal. Fast-path: if the target is already the active tab, use
  `captureVisibleTab` to avoid attaching (no banner). Keep jpeg-default + degrade.

### 2. read_page + refs + find (content.js)
- WeakRef ref map: `elementMap[ref] = new WeakRef(el)` + reverse `WeakMap`;
  `getOrAssignRef` reuses a live ref, `resolveRef` sweeps dead ones and reports staleness.
  Augments the existing `data-bctl-ref` index identity (refs survive re-snapshots, don't
  mutate the page).
- `read_page { mode?: "interactive"|"all", depth?, ref_id?, maxChars? }`: walk the DOM,
  role inference fallback (tag+type → ARIA role), accessible-name cascade
  (`aria-label`→`placeholder`→`title`→`alt`→`<label for>`→value(<50)→text(≥3), cap 100),
  viewport/visibility cull in non-`all` mode, emit compact indented text lines
  (`textbox "Email" [ref_5] type="email"`), depth cap 15, output cap ~50k chars with an
  actionable over-limit message. Does NOT pierce shadow DOM/iframes (manifest
  `all_frames` injects per frame) — acceptable; revisit if needed.
- `find { query, max? }`: substring match over role/name/text/placeholder/aria-label/
  title; return up to `max` refs.
- ref-based interaction: `click`/`type`/etc. accept `ref` in addition to `index`;
  resolve via `resolveRef`, `scrollIntoView({block:'center'})`, force layout, then act.

### 3. Coordinate actions upgrade (cdp.js)
- `coordinate_click`/`coordinate_drag`: model coords are in screenshot-pixel space; remap
  to viewport (`x * viewportW/shotW`, `y * viewportH/shotH`) before dispatch. Click =
  `mouseMoved` → ~100ms → `mousePressed` (~12ms) → `mouseReleased`; button bitmask
  left=1/right=2/middle=4; `clickCount` for multi-click.
- CDP type path: char-by-char `dispatchKeyEvent`, `Input.insertText` fallback for
  emoji/IME/multibyte; on Mac inject native editor `commands` (`selectAll`/`undo`) so
  `Cmd+A`/`Cmd+Z` fire.
- Token-budget screenshot sizing for the CDP capture path: size to the vision-tiling
  budget and downscale inside CDP via `clip.scale` (constants `pxPerToken=28`,
  `maxTargetTokens=1568`); JPEG q55 → degrade. (Refines the flat q55→q30 already shipped.)

### 4. Stability layer (content.js + cdp.js) + wiring
- Settle helper: poll `document.readyState === 'complete' && document.getAnimations().length === 0`
  (bounded), used by `wait_for` and optionally before reads.
- Domain re-check: before a CDP action, compare the tab's current hostname to the
  expected one; abort with "Domain changed from X to Y" on mismatch.
- CDP auto-reattach: when `sendCommand` rejects with `"debugger is not attached"`,
  re-attach once and retry.
- Wire new actions into `background.js` dispatch lists, `PROTOCOL.md`, and expose as MCP
  tools in `mcp/index.js` (`browser_read_page`, `browser_find`, ...).

## Out of scope

In-extension agent / side panel / system prompt / compact-action DSL; Anthropic API
integration; permission gating; domain blocklist; org lock; find-as-LLM (the external
agent does that). Visual indicator + throttled screencast liveness: optional, later.

Explicitly open per user decision: no `eval_js` secret scrubber, no action gating.

## Error handling

- `targetTab()`: throw "no active tab" if no window at all.
- `screenshot()`/CDP capture: restricted pages (`chrome://`, Web Store) reject the
  debugger — surface the CDP error, do not fall back to activating the tab (that would
  reintroduce focus-steal).
- Auto-reattach retries once; a second failure propagates.
- `read_page` over-limit: return the actionable message (reduce depth / pass `ref_id`).

## Testing

No extension test harness exists; verification is a manual checklist run on both macOS
(M1) and Windows 11, with the bridge running and extension connected. Record which
scenarios were run on which OS in the PR.

1. Pin + no drift: agent reads tab A, user switches to B, agent reads again → still A.
2. Background click/screenshot on A while user stays on B; window does not flip; banner
   appears on A only after a screenshot.
3. No-banner path: DOM-only click/type/read → no debugger banner.
4. navigate isolation: A pinned, agent navigates → A changes, B untouched.
5. switch_tab retarget works.
6. read_page returns compact text with stable refs; a ref still resolves after a
   re-snapshot; a stale ref returns the actionable error.
7. coordinate_click on a canvas (e.g. a map) lands correctly on Retina (deviceScaleFactor
   fix) and on Windows.
8. Cmd+A / Cmd+Z work via CDP type on macOS.
9. Auto-reattach: reload the target tab, issue a CDP action → reattaches and succeeds.

## Implementation order

Phase 1 (background control + auto-reattach + token-budget screenshot) → Phase 2
(read_page + refs + find) → Phase 3 (coordinate upgrade + Mac commands + domain re-check)
→ Phase 4 (settle + dispatch/MCP/PROTOCOL wiring). Verify `node --check` after each; full
behavior verified manually in-browser.
