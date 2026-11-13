# CONCEPTS.md

Core vocabulary, domain models, and architectural concepts for browserctl.

### Target

The universal element-addressing parameter used across all interaction tools. Resolves deterministically in order: exact ref (`@e1`, `e1`), frame-qualified ref (`@f1:e2`), explicit prefix (`css=`, `text=`, `placeholder=`), raw CSS selector, case-insensitive visible text, or numeric index (`#1`). Ambiguity across multiple equally visible candidates is rejected with `AMBIGUOUS_TARGET`.

Owned by: `extension/content.js`

### Ref

A snapshot-scoped identifier assigned to actionable DOM controls (e.g., `@e1`, `@e2`). Ref tokens are assigned sequentially during snapshot traversal and indexed in a WeakMap/Map pair. In multi-frame documents, subframe elements receive frame-qualified tokens (`@f<id>:e<n>`).

Owned by: `extension/content.js`

### Stale Ref

A reference token whose underlying DOM node is detached, hidden, or replaced after dynamic page mutations. browserctl strictly refuses stale refs with error code `STALE_REF` and never silently rebinds an action to a replacement element. Taking a fresh snapshot re-indexes controls with new refs.

Owned by: `extension/content.js`

### Snapshot

The primary observation mechanism (`browser_snapshot`). Traverses the live DOM to produce an accessibility census, a hierarchical Virtual Object Model (VOM) tree, and active page state metadata. Supports configurable scope (`viewport` or `all`), maximum depth (`maxDepth`), and text truncation limit (`maxText`).

Owned by: `extension/content.js`

### Census

The indexed inventory of all interactive controls found within a snapshot. Each entry records the control's `@e` ref, role, accessible name, current value, disabled/checked state, and bounding rectangle.

Owned by: `extension/content.js`

### VOM (Virtual Object Model)

A hierarchical, depth-indented textual tree of the page structure. Renders containers, interactive controls, and prose blocks while suppressing layout-only wrappers and preserving table grid relationships. Designed for token efficiency in agent context windows.

Owned by: `extension/content.js`

### PageState

The runtime execution state of a page reported during observation. Includes document title, current URL, navigation settle state, scroll dimensions, and open dialog tracking (`openDialogs`).

Owned by: `extension/content.js`

### Effect

The structured verification payload returned by mutating actions (`browser_click`, `browser_type`, `browser_fill_form`). Reports whether the action mutated the DOM (`domChanges`), triggered navigation (`urlChanged`), updated form control values (`controlState`), or opened dialog surfaces.

Owned by: `extension/content.js`

### Core Tool vs Loadable Tool

The structural partitioning of the MCP tool surface. Core tools (20 tools) are loaded into every session and strictly governed by `AGENT_TEXT_BUDGET`. Loadable tools (tabs, network inspection, emulation, storage) provide advanced capabilities without inflating initial context tokens.

Owned by: `mcp/index.js`

### Bridge

The background daemon running locally at `127.0.0.1:8765`. Routes JSON-RPC/REST commands from CLI and MCP clients to connected browser extensions over WebSocket connections.

Owned by: `bridge/server.js`

### Browser Alias

A human-friendly, deterministic identifier assigned to each connected browser instance (e.g., `chrome-1`, `edge-1`). Allows commands to target specific profiles across multi-browser setups via the `-b` / `--browser` flag.

Owned by: `bridge/server.js`

### Hold or Lease

A concurrency primitive managed by the bridge. When an agent session acts on a tab, it acquires a lease that prevents competing sessions from modifying or navigating that tab without explicit force flags.

Owned by: `bridge/server.js`

### Session Target

The default browser and tab binding established when an agent first selects or opens a tab. Subsequent tool calls automatically route to this target unless overridden by explicit parameters.

Owned by: `bridge/server.js`

### Native Dialog

Browser-level modal interfaces (`alert`, `confirm`, `prompt`, `beforeunload`). These block ordinary DOM execution and must be inspected or dismissed via `browser_handle_dialog` before further interactions proceed.

Owned by: `extension/background.js`
