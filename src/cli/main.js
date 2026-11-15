#!/usr/bin/env node
// @ts-check
// browserctl CLI: every tool as a subcommand with flags from its schema, plus daemon and extension
// helpers (specs/interface.md). Output is the JSON result; exit code 1 when ok is false.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { base, callTool, health, home, listTools, port, spawnDaemon } from "../client.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const USAGE = `usage:
  browserctl <tool> [--param value ...] [--session name] [--pretty]
  browserctl tools                    list tools and their parameters
  browserctl daemon start|stop|status
  browserctl extension path           copy the extension to ~/.browserctl/extension and print it

examples:
  browserctl navigate --url example.com
  browserctl snapshot
  browserctl click --target e5
  browserctl fill_form --fields '[{"target":"e7","value":"me@example.com"}]'
  browserctl evaluate --function "() => document.title"`;

/** @param {any} schema @param {string} raw */
function convert(schema, raw) {
  const type = schema?.type ?? (schema?.anyOf ? "json" : "string");
  if (type === "integer" || type === "number") {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`expected a number, got ${raw}`);
    return n;
  }
  if (type === "boolean") return raw !== "false";
  if (type === "array" || type === "object" || type === "json") {
    try {
      return JSON.parse(raw);
    } catch {
      if (type === "array" && schema.items?.type === "string") return raw.split(",");
      throw new Error(`expected JSON, got ${raw}`);
    }
  }
  return raw;
}

/** @param {string[]} argv @param {any} schema */
function parseFlags(argv, schema) {
  /** @type {Record<string, any>} */
  const params = {};
  const options = { session: "cli", pretty: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (name === "pretty") {
      options.pretty = true;
      continue;
    }
    const prop = schema.properties?.[name];
    const takesValue = name === "session" || prop?.type !== "boolean";
    const value = inline ?? (takesValue || (argv[i + 1] && /^(true|false)$/.test(argv[i + 1])) ? argv[++i] : "true");
    if (value === undefined) throw new Error(`--${name} needs a value`);
    if (name === "session") options.session = value;
    else params[name] = prop ? convert(prop, value) : value;
  }
  return { params, options };
}

async function daemonCommand(/** @type {string | undefined} */ action) {
  if (action === "status") {
    const h = await health();
    console.log(JSON.stringify(h ? { running: true, url: base, ...h } : { running: false, url: base }));
    return h ? 0 : 1;
  }
  if (action === "start") {
    if (await health()) {
      console.log(JSON.stringify({ running: true, url: base, started: false }));
      return 0;
    }
    spawnDaemon();
    for (let i = 0; i < 50 && !(await health()); i++) await new Promise((r) => setTimeout(r, 100));
    const h = await health();
    console.log(JSON.stringify({ running: Boolean(h), url: base, started: Boolean(h) }));
    return h ? 0 : 1;
  }
  if (action === "stop") {
    try {
      const { pid } = JSON.parse(fs.readFileSync(path.join(home, `daemon-${port}.json`), "utf8"));
      process.kill(pid, "SIGTERM");
      console.log(JSON.stringify({ stopped: true, pid }));
      return 0;
    } catch {
      console.log(JSON.stringify({ stopped: false, reason: "no daemon record for this port" }));
      return 1;
    }
  }
  console.error(USAGE);
  return 2;
}

/**
 * Copies the extension of this install into BROWSERCTL_HOME/extension, a fixed folder to load
 * unpacked, and prints it (specs/interface.md).
 */
function extensionPath() {
  const source = path.join(root, "extension");
  if (!fs.existsSync(path.join(source, "generated/pw-injected.js"))) {
    console.error("extension/generated is missing: run npm run build");
    return 1;
  }
  const target = path.join(home, "extension");
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  console.log(target);
  return 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return 0;
  }
  if (command === "daemon") return daemonCommand(rest[0]);
  if (command === "extension" && rest[0] === "path") return extensionPath();
  const tools = await listTools();
  if (command === "tools") {
    for (const t of tools) {
      const params = Object.entries(t.inputSchema.properties)
        .map(([k, v]) => `${(t.inputSchema.required ?? []).includes(k) ? "*" : ""}${k}:${/** @type {any} */ (v).type ?? "json"}`)
        .join(" ");
      console.log(`${t.name.padEnd(17)} ${params}`);
    }
    return 0;
  }
  const tool = tools.find((t) => t.name === command);
  if (!tool) {
    console.error(`unknown command ${command}\n\n${USAGE}`);
    return 2;
  }
  const { params, options } = parseFlags(rest, tool.inputSchema);
  const result = await callTool(command, params, { session: options.session, client: "cli" });
  console.log(options.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result));
  return result.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`browserctl: ${error?.message ?? error}`);
    process.exit(1);
  },
);
