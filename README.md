# browserctl

Browser control for AI agents in your own Chrome: your logins, background tabs of the agent's
own, and no "started debugging this browser" bar unless a task needs real input.

The 19 tools and their parameters: `docs/TOOLS.md`. How it is built and why: `specs/` (start with
`specs/architecture.md`). Coming from 0.9.x: `CHANGELOG.md` maps the old tool names.

## Install

Requires Node.js 22+ and Chrome 135+ (or Edge, Brave).

From npm (macOS, Linux, Windows):

```bash
npm install -g browserctl-mcp
browserctl extension path       # the folder to load in Chrome
```

From a checkout:

```bash
npm install
npm run build          # extracts Playwright's page script and key table into extension/generated/
```

Load the extension:

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked**, pick the folder printed by `browserctl extension path` (from a checkout:
   `node src/cli/main.js extension path`).
3. Open the extension's **Details** and turn on **Allow User Scripts** (lets `evaluate` run on
   every page without the debugging bar).

Register the MCP server (Claude Code shown; any MCP client takes the same command). Installed from
npm:

```bash
claude mcp add browserctl -s user -- browserctl-mcp
```

From a checkout:

```bash
# macOS / Linux
claude mcp add browserctl -s user -- node "$(git rev-parse --show-toplevel)/src/mcp/main.js"
```

```powershell
# Windows (PowerShell)
claude mcp add browserctl -s user -- node "$(git rev-parse --show-toplevel)\src\mcp\main.js"
```

The MCP server starts the daemon (`127.0.0.1:8765`) when it is not running. `status` reports what
is missing. With `BROWSERCTL_CLOSE_TABS=1` in the MCP server's environment, the tabs the agent
opened close when the MCP server exits.

`run` executes Playwright code against the agent's tab, for what the other tools do not cover
(drag, coordinates, routes, cookies, emulation, loops): `page`, `context` and a `state` object that
persists between calls are in scope, and the code's return value is the result.

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
| `BROWSERCTL_CLOSE_TABS` | | `1`: the client's session closes the tabs it opened when it ends |

## Tests

```bash
npm test               # unit: no browser
npm run test:live      # live: Chrome for Testing with the extension (npx playwright-core install chromium once)
npm run typecheck
npm run preflight      # every release gate; -- --live adds the live suites, -- --release the version checks
```

Each test carries the ID of the spec row it proves (`CLICK-E01`; Playwright's own cases by their
IDs, `CL-001`), and `node scripts/spec-ids.js` fails when a spec row has no test or a test no row.
