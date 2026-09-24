# browserctl

Universal Browser Control Protocol & MCP Server for AI Agents and Developers.

browserctl gives LLM agents a small core set of tools, with more loaded on demand, to inspect,
navigate, and drive real browser sessions with high token efficiency and deterministic execution.

**Setup:** see [docs/INSTALL.md](docs/INSTALL.md) — Node and browser prerequisites, installing or
running via npx, loading the unpacked Chrome extension, and daemon configuration.

**Is the extension safe to load?** It talks to one place only: the local bridge address you
configure (default `127.0.0.1:8765`). It sends no analytics and contacts no other server, and it
acts only on commands that arrive from that bridge. Its full source ships in the package, so you
can read exactly what you load. It asks for broad permissions (all sites, `debugger`) because
driving any page is its job.

## Architecture

1. **MCP Server**: Stdio MCP server exposing tools with smart input resolution, structured schema definitions, and compact output formatting.
2. **Bridge Daemon**: Fast local HTTP/WebSocket daemon (`127.0.0.1:8765`) managing active browser connections and command routing.
3. **Chrome Extension**: Lightweight background MV3 extension executing commands directly in page contexts and DevTools sessions.

## The Interaction Loop

1. **Navigate**: `browser_navigate` to open a URL or reload, or `browser_tabs` to manage open tabs.
2. **Read**: `browser_snapshot` to take a compact text census of the page controls with stable refs (`@ref_1`), or `browser_get_content` / `browser_extract`.
3. **Act**: `browser_click`, `browser_type`, `browser_fill_form`, or `browser_select_option` on a resolved target.
4. **Verify**: Check the returned `effect` and `resolved` blocks to verify DOM mutations and unique targeting.

## Core Tools

- **Daemon & Session**: `browser_status`, `browser_start`, `browser_stop`.
- **Navigation & Tabs**: `browser_navigate`, `browser_tabs`.
- **Inspection & Reading**: `browser_snapshot`, `browser_read_page`, `browser_find`, `browser_extract`, `browser_get_content`, `browser_get_property`.
- **Action & Input**: `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_press_key`, `browser_scroll`, `browser_hover`, `browser_file_upload`.
- **Synchronization & Utilities**: `browser_wait_for`, `browser_take_screenshot`, `browser_evaluate`, `browser_action`.
- **Dynamic Extensibility**: `browser_load_tools`, `browser_list_available_tools`.

## Documentation

- [docs/INSTALL.md](docs/INSTALL.md) — installation, Chrome extension loading, daemon configuration.
- [docs/REFERENCE.md](docs/REFERENCE.md) — full parameter reference for the core tools.
- [docs/TOOLS.md](docs/TOOLS.md) — generated catalogue of every tool in every profile.
- [CHANGELOG.md](CHANGELOG.md) — release history.
