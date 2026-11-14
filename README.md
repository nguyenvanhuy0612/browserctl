# browserctl

Browser control for AI agents in your own Chrome: your logins, background tabs of the agent's
own, and no "started debugging this browser" bar unless a task needs real input.

How it is built and why: `specs/` (start with `specs/architecture.md`).

## Install

Requires Node.js 22+ and Chrome 135+ (or Edge, Brave).

```bash
npm install
npm run build          # extracts Playwright's page script and key table into extension/generated/
```

Load the extension:

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked**, pick the folder printed by `node src/cli/main.js extension path`.
3. Open the extension's **Details** and turn on **Allow User Scripts** (lets `evaluate` run on
   every page without the debugging bar).

Register the MCP server (Claude Code shown; any MCP client takes the same command):

```bash
# macOS / Linux
claude mcp add browserctl -s user -- node "$(git rev-parse --show-toplevel)/src/mcp/main.js"
```

```powershell
# Windows (PowerShell)
claude mcp add browserctl -s user -- node "$(git rev-parse --show-toplevel)\src\mcp\main.js"
```

The MCP server starts the daemon (`127.0.0.1:8765`) when it is not running. `status` reports what
is missing.

## CLI

```bash
node src/cli/main.js tools                                   # every tool and its parameters
node src/cli/main.js navigate --url example.com
node src/cli/main.js snapshot
node src/cli/main.js click --target e5
node src/cli/main.js evaluate --function "() => document.title"
node src/cli/main.js daemon status
```

## HTTP API (scripts, any language)

```python
import json, urllib.request

def call(tool, **params):
    req = urllib.request.Request(
        f"http://127.0.0.1:8765/v1/tools/{tool}",
        data=json.dumps(params).encode(),
        headers={"content-type": "application/json", "x-browserctl-session": "my-script"},
    )
    return json.load(urllib.request.urlopen(req))

call("navigate", url="https://example.com")
print(call("read", main=True)["text"])
```

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `BROWSERCTL_PORT` | `8765` | daemon port (set the same port in the extension's storage key `daemonPort` when changed) |
| `BROWSERCTL_HOME` | `~/.browserctl` | sessions, aliases, call log, screenshots |
| `BROWSERCTL_DETACH_IDLE` | `30` | seconds without a CDP-lane call before the debugger detaches |
| `BROWSERCTL_AUTO_START` | | `manual`: clients never start the daemon |

## Tests

```bash
npm test               # unit: no browser
npm run test:live      # live: Chrome for Testing with the extension (npx playwright-core install chromium once)
npm run typecheck
```
