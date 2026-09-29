# Multi-browser agent probes (Task 8, Step 2)

These are the checks Step 1 (`tests/e2e/multi_browser_live.mjs`) cannot script: an agent product
reading the prompt in its own voice and deciding what tool calls to make. Run each prompt with a
fresh agent session (AGY, and separately Claude Code), on its unchanged single MCP entry — no
per-agent config for the second browser. Follow `browserctl-agent-probe-scoring`: score every
prompt from the bridge call log, never from the agent's own report of what it did.

## Setup

- The bridge running with `BROWSERCTL_CALL_LOG=<path>` set before it starts, so every command
  through it is recorded. `GET /status` on the bridge reports the same path back as `callLog`.
- The same browsers Step 1 used: Chrome with two profiles (one has facebook.com open), Edge
  with the SAC login page open.
- Note the call log's byte size before each prompt (`stat` or the bridge's own `callLogBytes`
  in `/status`), so the log lines belonging to one prompt can be read back out by offset.

## Reading the call log

Each line is one JSON object per command the bridge routed, in order, with at least: `session`
(the MCP process that sent it), `source`, `instanceId`, `browser` (the alias that served it),
`seq`, `action`, `tabId`, and `internal: true` on a command the MCP server sent for its own
routing rather than because the agent called a tool.

One tool call can write several lines: `browser_tabs select {browser}` is an internal
`list_tabs` plus a `switch_tab`; `browser_tabs list` is one `list_tabs` line per connected
browser, all sharing one `seq`; a session's first call naming no tab is preceded by an internal `list_tabs`
that resolves its target; `TARGET_CLOSED` adds an internal `list_tabs` for its listing, and a
`tabId` the server has not seen adds an internal fan-out lookup. So the agent's calls are the
distinct `seq` values among the lines without `internal`, not the raw line count.

To score a prompt:

1. Read every line appended since the byte offset noted before the prompt.
2. Group by `session` — an agent's whole run is one session id (a new MCP process only starts
   between prompts, never mid-prompt, unless the prompt itself is stated as two sessions).
3. Drop the lines with `internal: true`, then count the distinct `seq` values left. This is the
   call count — not what the agent says it did.
4. Read `browser` and `tabId` off each line (internal ones included) to check which browser and
   tab actually served the prompt.
5. For "no shell-out to the CLI": a line with `source: "cli"` is the CLI (its own client tag is
   `cli-<pid>`); the MCP server tags every line it sends `source: "mcp"`, so any `"cli"` line in
   the group is the shell-out the criterion rules out.

## Prompts

| Prompt | Pass if |
|---|---|
| "click Users trên edge" | at most 3 agent calls (`switch_tab` from `select{browser}`, `snapshot`, `click`); every `switch_tab`, `snapshot` and `click` line's `browser` is the Edge alias; no shell-out to the CLI |
| "mở tab facebook đang mở và click Home" (facebook open in one Chrome profile) | at most 4 agent calls (`list`, `select`, `snapshot`, `click`); the `click` line's `tabId` is that profile's tab |
| "click Home trên facebook" (facebook open in two Chrome profiles) | the agent asks which profile, or names both, before any call whose `action` is `click`; no click line appears in the log before it does |
| "mở example.com trên edge" | the `new_tab` line's `browser` is the Edge alias |
| "click abc" (Edge focused last, no browser named in the prompt) | every line's `browser` (internal ones included) is the Edge alias, and the first result the agent read back carries `target.browser` equal to that alias |
| Two sessions at once: "làm trên chrome" / "làm trên edge", each doing 10 steps | grouping the log by `session` shows each session's lines other than `list_tabs` carrying only its own browser's alias — no such line from session A carries session B's browser, or vice versa (a `list_tabs` fan-out reaches every browser by design) |

## Recording a result

For each prompt, record: agent product, pass/fail, and the call count and browser/tabId
grouping the log actually shows (not the agent's transcript). These go into the RFC Section 14
results table once the live run (Steps 1 and 2 together) is done.
