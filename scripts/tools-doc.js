#!/usr/bin/env node
// @ts-check
// Writes docs/TOOLS.md from the tool registry (specs/interface.md: the registry is the one source of
// the MCP schemas, the CLI flags and this page). --check fails when the file is out of date.
// Usage: node scripts/tools-doc.js [--check]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry } from "../src/daemon/registry.js";
import { tools } from "../src/daemon/tools/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "docs/TOOLS.md");

/** @param {any} schema @returns {string} */
function typeOf(schema) {
  if (schema.anyOf) return schema.anyOf.map(typeOf).join(" \\| ");
  if (schema.enum) return schema.enum.map((/** @type {unknown} */ v) => `\`${JSON.stringify(v)}\``).join(", ");
  if (schema.type === "array") return `${typeOf(schema.items ?? {})}[]`;
  return schema.type ?? "any";
}

/** @param {any} schema */
function limits(schema) {
  const parts = [];
  if (schema.minimum !== undefined && schema.maximum !== undefined) parts.push(`${schema.minimum} to ${schema.maximum}`);
  else if (schema.minimum !== undefined) parts.push(`at least ${schema.minimum}`);
  if (schema.minItems !== undefined || schema.maxItems !== undefined) parts.push(`${schema.minItems ?? 0} to ${schema.maxItems ?? "any"} items`);
  if (schema.type === "object" && schema.properties) parts.push(`keys: ${Object.keys(schema.properties).join(", ")}`);
  return parts.join("; ");
}

/** @param {string} text */
const cell = (text) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function render() {
  const lines = [
    "# Tools",
    "",
    "Generated from the tool registry by `node scripts/tools-doc.js`; do not edit by hand. The specs in",
    "`specs/tools/` define each tool; this page is what agents and scripts see.",
    "",
  ];
  for (const tool of new Registry(tools).list()) {
    const required = new Set(tool.inputSchema.required ?? []);
    lines.push(`## \`${tool.name}\``, "", tool.description, "");
    const params = Object.entries(tool.inputSchema.properties);
    if (!params.length) {
      lines.push("No parameters.", "");
      continue;
    }
    lines.push("| Parameter | Type | Required | Default | Limits | Meaning |", "| --- | --- | --- | --- | --- | --- |");
    for (const [name, schema] of params) {
      const s = /** @type {any} */ (schema);
      lines.push(`| \`${name}\` | ${cell(typeOf(s))} | ${required.has(name) ? "yes" : "no"} | ${s.default === undefined ? "" : `\`${JSON.stringify(s.default)}\``} | ${cell(limits(s))} | ${cell(s.description ?? "")} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = render();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (current !== text) {
      console.error("docs/TOOLS.md is out of date: run node scripts/tools-doc.js");
      process.exitCode = 1;
    }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`wrote ${path.relative(root, file)}`);
  }
}
