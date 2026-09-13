// Dumps every tool's description and parameter descriptions, for the tests that assert on
// what an agent is told. A fixture file rather than an inline template literal: the inline
// version carried two escaping layers and lost a backslash twice.
process.env.BROWSERCTL_MCP_PROFILE = "all";
const { server } = await import(new URL("../../../mcp/index.js", import.meta.url).href);

const out = {};
for (const [name, t] of Object.entries(server._registeredTools)) {
  out[name] = { description: t.description || "", shape: {} };
  const shape = t.inputSchema && t.inputSchema.shape;
  if (shape) for (const [k, v] of Object.entries(shape)) out[name].shape[k] = (v && v.description) || "";
}

// Flush before exiting: stdout is a pipe here, so writes are asynchronous and process.exit()
// truncates whatever is still buffered. The dump grew past the pipe buffer when a parameter
// was added to every tool, and the payload vanished silently.
await new Promise((r) => process.stdout.write("JSON_START" + JSON.stringify(out) + "JSON_END\n", r));
process.exit(0);
