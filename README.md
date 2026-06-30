# ai-browser-control

A Chrome extension + local bridge server that lets any AI agent (Claude, GPT, or a
plain script) drive a real Chrome browser through a neutral HTTP/WebSocket API.

## How it works

```
Agent (Claude / GPT / your script)
      │  HTTP REST  +  WebSocket
      ▼
Bridge server (Node, runs on localhost)   <- relay, no build step
      │  WebSocket
      ▼
Chrome extension (Manifest V3)
   ├─ background.js  (service worker: WS client, command dispatch)
   └─ content.js     (reads the DOM, indexes elements, clicks/types/scrolls)
```

The agent never talks to Chrome directly. It POSTs a command to the bridge; the
bridge relays it to the extension over WebSocket; the extension runs it and the
result travels back the same path.

Control is done at the **DOM level** (no `chrome.debugger`, so no "is being
debugged" banner). The extension extracts the interactive elements on the page,
assigns each an **index**, and the agent acts by index ("click 5", "type into 8").
This is the same approach browser-use / Playwright-agent mode use, and it is robust
on most sites. A CDP (`chrome.debugger`) module can be added later for canvas /
cross-origin-iframe / coordinate-click cases.

## Setup

### 1. Bridge server

```bash
cd bridge
npm install
npm start          # listens on http://localhost:8765
```

### 2. Load the extension

1. Open `chrome://extensions` (or `edge://extensions` on Microsoft Edge)
2. Enable **Developer mode** (top right)
3. **Load unpacked** -> select the `extension/` folder
4. Click the extension icon; the popup shows the connection status to the bridge.

When both are running, the popup should read **Connected**.

Works on any Chromium browser (Chrome, Edge). The host/port the extension dials
is configurable on the extension's **options page** (popup -> "Open settings",
or the Extensions page -> Details -> Extension options) and stored in
`chrome.storage`; the service worker reconnects automatically on change.

## Using it from Claude Code (MCP)

The `mcp/` server exposes the browser as native tools (`browser_snapshot`,
`browser_navigate`, `browser_click`, ...) for any MCP client. This is the
recommended path for Claude Code / Claude Desktop.

```bash
cd mcp
npm install
# Register with Claude Code (run from anywhere; use the absolute path):
claude mcp add browser -- node "C:/Users/HUYNGUYEN/Documents/ai-browser-control/mcp/index.js"
```

Or add it to a project's `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["C:/Users/HUYNGUYEN/Documents/ai-browser-control/mcp/index.js"],
      "env": { "BRIDGE_URL": "http://127.0.0.1:8765" }
    }
  }
}
```

The bridge server (`bridge/ npm start`) and the extension must be running; the MCP
server is a thin stdio wrapper that POSTs to the bridge. Typical Claude Code use:
"snapshot the page, then click the login button" -> Claude calls `browser_snapshot`,
reads the indexed elements, then `browser_click`.

## Using it from any other agent (raw HTTP)

Send commands as JSON over HTTP. See `PROTOCOL.md` for the full list.

```bash
# Take a snapshot of the current page (interactive elements + text)
curl -s -X POST http://localhost:8765/command \
  -H 'content-type: application/json' \
  -d '{"action":"snapshot"}'

# Navigate
curl -s -X POST http://localhost:8765/command \
  -H 'content-type: application/json' \
  -d '{"action":"navigate","params":{"url":"https://example.com"}}'

# Click the element that snapshot labeled index 3
curl -s -X POST http://localhost:8765/command \
  -H 'content-type: application/json' \
  -d '{"action":"click","params":{"index":3}}'
```

A typical agent loop: `snapshot` -> reason about the returned element list ->
issue `click` / `type` / `scroll` / `navigate` -> `snapshot` again.

## Status

MVP. See `PROTOCOL.md` for implemented commands and the roadmap at the bottom.

## Security

Internal-use tool, by design: no login, no auth. The bridge listens on `localhost`
only; anything that can reach `localhost:8765` can drive your browser, so do not
expose the port. An optional API token is left on the roadmap for if this ever
leaves a trusted machine.

**Prompt injection still applies.** A web page can embed hidden text that tries to
hijack whatever agent is driving the browser (the same risk the official Claude in
Chrome documents). No login removes that risk. When pointing an agent at untrusted
pages, keep a human in the loop for anything destructive or sensitive.
