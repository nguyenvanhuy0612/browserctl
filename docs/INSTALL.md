# Installation & Setup Guide

browserctl has three parts, and all three have to be running for a tool call to reach a page:

1. **MCP server** (`browserctl-mcp`) — started by your MCP client over stdio.
2. **Bridge daemon** (`127.0.0.1:8765`) — started automatically on first use; shared by every
   client and the CLI.
3. **Browser extension** — loaded unpacked into Chrome/Edge/Brave; connects to the bridge.

This guide sets up all three, then checks the chain end to end.

## Prerequisites

- Node.js >= 18
- A Chromium-based browser (Google Chrome, Microsoft Edge, Brave, Chromium)

## Step 1: Install browserctl

### Option A: Global install (recommended)

```bash
npm install -g browserctl-mcp
```

This gives you `browserctl-mcp` (the MCP server), `browserctl` and `bctl` (the CLI), and an
extension folder at a fixed path. The server, the CLI and the extension then come from one copy
of the package, so they are always the same version.

### Option B: npx (to try it without installing)

```bash
npx -y -p browserctl-mcp browserctl status
```

npx runs the package from its cache (`~/.npm/_npx/<hash>/` on macOS/Linux,
`%LOCALAPPDATA%\npm-cache\_npx\<hash>\` on Windows). That is fine for a trial, but a poor home for
the extension — see Step 2. npx does not use a global install even when one exists.

### Option C: From source

```bash
git clone https://github.com/nguyenvanhuy0612/browserctl.git
cd browserctl
npm install
```

## Step 2: Load the browser extension

Find the folder to load. It ships inside the package, so ask the CLI:

```bash
browserctl extension-path                              # Option A
npx -y -p browserctl-mcp browserctl extension-path     # Option B
```

From source (Option C), it is the `extension/` directory in the clone.

**With Option B, copy the folder to a fixed place first** and load the copy. The path above is
inside the npx cache: `npm cache clean` deletes it, and a new version lands in a different hash
directory, which leaves Chrome running an old extension against a new server.

```bash
npx -y -p browserctl-mcp browserctl extension-path --copy
```

This copies the extension to `~/.browserctl/extension` (`%USERPROFILE%\.browserctl\extension` on
Windows, next to the daemon's state file) and prints that path. Pass a folder to copy elsewhere:
`--copy <dir>`. Running it again replaces the copy, which is how you update it; it refuses to
replace a folder that is not an earlier copy.

Option A does not need this: the global install already sits at a fixed path, and an update
replaces it in place.

`--copy` is newer than 0.9.0. On 0.9.0 it is ignored, and the command only prints the cache path;
copy that folder by hand instead:

```bash
# macOS / Linux
cp -R "$(npx -y -p browserctl-mcp browserctl extension-path | head -1)" ~/.browserctl/extension
```

```powershell
# Windows (PowerShell)
$src = (npx -y -p browserctl-mcp browserctl extension-path | Select-Object -First 1)
Copy-Item -Recurse $src "$HOME\.browserctl\extension"
```

Then load it:

1. Open `chrome://extensions` (`edge://extensions` in Edge, `brave://extensions` in Brave).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the folder.
4. Click the browserctl icon in the toolbar and press **Connect**.

The extension connects only to the bridge address set in its options (default
`127.0.0.1:8765`), sends no analytics, and contacts no other server; its source is the folder you
just loaded. Once connected it reconnects by itself, including after a browser restart.

## Step 3: Add the MCP server to your client

The server entry is the same for every client; only where it goes differs.

**Standard entry, global install (Option A):**

```json
{
  "mcpServers": {
    "browserctl": {
      "command": "browserctl-mcp",
      "env": {
        "BROWSERCTL_BRIDGE_URL": "http://127.0.0.1:8765",
        "BROWSERCTL_MCP_PROFILE": "core"
      }
    }
  }
}
```

**Standard entry, npx (Option B):** replace the command with

```json
"command": "npx",
"args": ["-y", "browserctl-mcp"]
```

**Standard entry, source (Option C):**

```json
"command": "node",
"args": ["/absolute/path/to/browserctl/mcp/index.js"]
```

**On Windows**, `browserctl-mcp` and `npx` are `.cmd` shims. A client that starts the server
without a shell cannot run them and fails with `ENOENT` or "Connection closed". Claude Code
(2.1.282) and opencode (1.18.32) handle shims themselves and need nothing extra. For any other
client that fails to start the server, wrap the command in `cmd /c`, which works in every client:

```json
"command": "cmd",
"args": ["/c", "browserctl-mcp"]
```

(or `["/c", "npx", "-y", "browserctl-mcp"]`). The `node` form needs no wrapper.

The `env` block is optional: both values shown are the defaults. See
[Environment variables](#environment-variables) for the rest.

<details>
<summary>Claude Code</summary>

Put the server name first, then the options: `-e` takes several values and will swallow a name
placed after it.

```bash
# macOS / Linux
claude mcp add browserctl -s user -- browserctl-mcp               # Option A
claude mcp add browserctl -s user -- npx -y browserctl-mcp        # Option B
claude mcp add browserctl -s user -- node /absolute/path/to/browserctl/mcp/index.js   # Option C
```

On Windows the same commands work as written; Claude Code runs the `.cmd` shims itself.

With environment variables:

```bash
claude mcp add browserctl -s user \
  -e BROWSERCTL_BRIDGE_URL=http://127.0.0.1:8765 \
  -e BROWSERCTL_MCP_PROFILE=core \
  -- browserctl-mcp
```

`-s` picks the scope: `local` (default, this project only, not shared), `user` (every project
on this machine), or `project` (written to `.mcp.json` in the repo and shared with the team).

```bash
claude mcp list                  # browserctl should show Connected
claude mcp get browserctl        # scope, command, env
claude mcp remove browserctl -s user
```

Restart any open Claude Code session to pick the server up. Inside a session, `/mcp` shows its
status and tools.

</details>

<details>
<summary>Claude Desktop</summary>

Settings > Developer > Edit Config opens `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add the standard entry and restart Claude Desktop. Claude Desktop does not read `.mcp.json`.

</details>

<details>
<summary>Codex</summary>

```bash
codex mcp add browserctl -- browserctl-mcp
```

Or edit `~/.codex/config.toml`:

```toml
[mcp_servers.browserctl]
command = "browserctl-mcp"
env = { BROWSERCTL_BRIDGE_URL = "http://127.0.0.1:8765" }
```

</details>

<details>
<summary>opencode</summary>

opencode uses an `mcp` key and a command array. In `~/.config/opencode/opencode.json`
(`%USERPROFILE%\.config\opencode\opencode.json` on Windows) or `opencode.json` in a project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "browserctl": {
      "type": "local",
      "command": ["browserctl-mcp"],
      "enabled": true
    }
  }
}
```

`opencode mcp list` should show browserctl as connected. Its free models
(`opencode models | grep free`) can drive browserctl, e.g.
`opencode run -m opencode/nemotron-3-ultra-free "Open https://example.com with browserctl and take a snapshot."`

</details>

<details>
<summary>VS Code (Copilot)</summary>

VS Code uses a `servers` key, not `mcpServers`. In `.vscode/mcp.json` (workspace) or via
**MCP: Open User Configuration** (all workspaces):

```json
{
  "servers": {
    "browserctl": {
      "type": "stdio",
      "command": "browserctl-mcp"
    }
  }
}
```

</details>

<details>
<summary>Cursor</summary>

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project). Add the standard entry.

</details>

<details>
<summary>Windsurf</summary>

`~/.codeium/windsurf/mcp_config.json`. Add the standard entry.

</details>

<details>
<summary>Antigravity</summary>

Agent panel > ... > MCP Servers > Manage MCP Servers > View raw config. Add the standard entry.

</details>

## Step 4: Verify

Check the bridge and the extension:

```bash
browserctl status
```

Expected:

```
Bridge: RUNNING (http://127.0.0.1:8765)
Extension: CONNECTED
```

`status` only reports; it does not start anything. On a fresh install it prints
`Bridge: OFFLINE` until the bridge has been started, so run `browserctl start` once (any other
CLI command or the first MCP tool call also starts it). Within a few seconds the extension
reconnects and `status` shows `CONNECTED`.

Then check the MCP side from your client with a first prompt:

```
Open https://example.com with browserctl and take a snapshot.
```

The agent should call `browser_navigate` and `browser_snapshot` and report a page titled
"Example Domain" with one link. If the tools are missing, the client has not loaded the server —
restart it and check its MCP status view (`/mcp` in Claude Code).

## Updating

The server, the bridge and the extension are three processes, and each keeps running the code it
started with. After an update, refresh all three.

1. Update the package:
   ```bash
   npm install -g browserctl-mcp@latest    # Option A
   ```
   Option B: `npx -y -p browserctl-mcp@latest browserctl extension-path --copy` moves the npx
   cache to the new version and refreshes `~/.browserctl/extension` in one step.
2. Restart the bridge: `browserctl restart`.
3. Reload the extension: `chrome://extensions` > browserctl > reload icon. Chrome keeps serving
   the old files until you do, even to new tabs. The version shown there should match
   `npm ls -g browserctl-mcp`.
4. Restart your MCP client session so it starts the new server.

## Uninstalling

```bash
claude mcp remove browserctl -s user     # or remove the entry from your client's config
browserctl stop
npm uninstall -g browserctl-mcp
```

Then remove the extension in `chrome://extensions`, and delete `~/.browserctl` (the daemon state, and the extension copy if you made one).

## Bridge daemon

The bridge auto-starts the first time the CLI or an MCP tool needs it. Manual control:

- `browserctl status` — bridge health, daemon state, extension connection
- `browserctl start` — start the daemon
- `browserctl restart` — restart it (after an update, or to pick up new environment variables)
- `browserctl stop` — stop it

`browserctl stop` records a stopped state, and auto-start stays off until `browserctl start`
(or the CLI flag `--auto-daemon`). The daemon is shared by every agent and the CLI, so do not
stop it just to clean up after a task.

The bridge listens on all interfaces (`HOST=0.0.0.0`) by default. To keep it local-only, set
`HOST=127.0.0.1` in the environment that starts it.

## Environment variables

Set these in the MCP entry's `env` (or `claude mcp add -e`) and, for the CLI, in your shell. The
daemon is started by whichever of them runs first and keeps that environment until restarted.

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `BROWSERCTL_BRIDGE_URL` | `http://127.0.0.1:8765` | MCP, CLI | Where to reach the bridge. An auto-started bridge listens on this URL's port. |
| `BROWSERCTL_MCP_PROFILE` | `core` | MCP | `core` exposes 25 tools and loads the rest on demand; `all` (or `full`) exposes all 69. |
| `BROWSERCTL_AUTO_START` | `auto` | MCP, CLI | `manual` (or `false`) never starts the bridge; start it with `browserctl start`. |
| `BROWSERCTL_CALL_LOG` | off | bridge | `1`/`true` logs every call to `bridge/calls.jsonl` inside the package; a path logs there instead. The log holds page content — keep it off unless debugging. |
| `BROWSERCTL_CALL_LOG_MAX_MB` | `8` | bridge | Size at which the call log rotates to `.1`. |
| `HOST` | `0.0.0.0` | bridge | Interface the bridge listens on. |
| `PORT` | `8765` | bridge | Port, when the bridge is started directly (`npm start` from source). An auto-started bridge takes its port from `BROWSERCTL_BRIDGE_URL`. |

## Troubleshooting

- **`Extension: DISCONNECTED`** — Click the extension icon and press **Connect**. If it still
  fails, check that the host/port in the extension's settings (icon > Open settings) match
  `BROWSERCTL_BRIDGE_URL`.
- **Port 8765 already in use** — Pick another port and change it in both places:
  1. `BROWSERCTL_BRIDGE_URL=http://127.0.0.1:8766` in the MCP entry and your shell, then
     `browserctl restart`.
  2. The extension's settings (icon > Open settings): port `8766`, **Save & reconnect**.
- **Client says the server failed to start or `command not found`** — GUI clients (Claude Desktop,
  Cursor) often do not see the PATH of your shell, especially with nvm/fnm/volta. Use the full path
  from `which browserctl-mcp` (macOS/Linux) or `where browserctl-mcp` (Windows) as the command.
- **Windows: `ENOENT` or `Connection closed` right after start** — the client cannot run the
  `.cmd` shim. Wrap the command in `cmd /c` (see Step 3) or use the `node` form.
- **`Bridge daemon is not running` and it does not start** — the daemon was stopped with
  `browserctl stop`, or `BROWSERCTL_AUTO_START=manual`. Run `browserctl start`.
- **Behaviour looks like an old version after an update** — one of the three processes is still
  on old code. Do all of [Updating](#updating) steps 2–4.
- **A tool you expect is missing** — the `core` profile shows 25 tools. Ask the agent to load a
  profile (`browser_load_tools`), call it through `browser_action`, or set
  `BROWSERCTL_MCP_PROFILE=all`.
