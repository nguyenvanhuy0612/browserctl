# Installation & Setup Guide

This guide covers setup, installation, Chrome extension loading, and daemon configuration for browserctl.

## Prerequisites

- Node.js >= 18.0.0
- A Chromium-based browser (Google Chrome, Microsoft Edge, Brave, Chromium)

## Step 1: Install browserctl

### Option A: Direct Execution (Zero-Install via NPX)

Run browserctl without cloning or global installation:

```bash
npx -y -p browserctl-mcp browserctl status
```

### Option B: Global CLI Installation

Install globally via npm to access `browserctl` and `bctl` commands:

```bash
npm install -g browserctl-mcp
```

### Option C: From Source

Clone the repository and install dependencies:

```bash
git clone https://github.com/nguyenvanhuy0612/browserctl.git
cd browserctl
npm install
```

## Step 2: Load the Chrome Extension

First, find the folder to load. It ships inside the package, so it is not where you installed
from — ask the CLI:

```bash
browserctl extension-path          # or: npx -y -p browserctl-mcp browserctl extension-path
```

If you installed from source (Option C), it is the `extension/` directory in the clone.

The extension connects only to the local bridge (default `127.0.0.1:8765`), sends no analytics,
and contacts no other server; its source is the folder you are about to load.

1. Open `chrome://extensions` (or `edge://extensions` in Edge).
2. Enable **Developer mode** toggle in the top-right corner.
3. Click **Load unpacked**.
4. Select the folder printed above.
5. Click the browserctl extension icon in your browser toolbar and click **Connect**.

Once connected, the extension automatically maintains connection and reconnects on browser startup.

## Step 3: MCP Configuration

### For Claude Desktop, Antigravity, Cursor, Windsurf (`.mcp.json`)

```json
{
  "mcpServers": {
    "browserctl": {
      "command": "npx",
      "args": ["-y", "browserctl-mcp"],
      "env": {
        "BROWSERCTL_BRIDGE_URL": "http://127.0.0.1:8765",
        "BROWSERCTL_MCP_PROFILE": "core"
      }
    }
  }
}
```

### For Claude Code CLI

```bash
claude mcp add browserctl -- npx -y browserctl-mcp
```

### Local Path Setup

```json
{
  "mcpServers": {
    "browserctl": {
      "command": "node",
      "args": ["/absolute/path/to/browserctl/mcp/index.js"],
      "env": {
        "BROWSERCTL_BRIDGE_URL": "http://127.0.0.1:8765",
        "BROWSERCTL_MCP_PROFILE": "core"
      }
    }
  }
}
```

## Step 4: Bridge Daemon Management

The bridge daemon (`127.0.0.1:8765`) auto-starts on demand when any CLI or MCP tool is invoked. You can also control it manually:

- Check status: `browserctl status`
- Start daemon: `browserctl start`
- Stop daemon: `browserctl stop`
- Restart daemon: `browserctl restart`

### Environment Variables

- `BROWSERCTL_BRIDGE_URL`: Bridge server URL (default: `http://127.0.0.1:8765`).
- `BROWSERCTL_MCP_PROFILE`: Tool profile to expose (`core` for 25 tools, `all` for all 69 tools).
- `BROWSERCTL_AUTO_START`: Daemon auto-start policy (`auto` or `manual`).

## Troubleshooting

- **Extension Disconnected**: Ensure the bridge server is running (`browserctl status`). In Chrome, click the extension icon and confirm it shows "Connected".
- **Port Conflict**: If port `8765` is in use, start the bridge on another port via `PORT=8766 npm start` and set `BROWSERCTL_BRIDGE_URL=http://127.0.0.1:8766`.
