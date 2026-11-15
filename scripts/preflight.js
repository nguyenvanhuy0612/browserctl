#!/usr/bin/env node
// @ts-check
// Release gates. Nothing is published unless every gate passes.
// Usage: node scripts/preflight.js [--live] [--release]
//   --live     also run the live suites (Chrome for Testing; minutes)
//   --release  also check the version strings and the CHANGELOG entry for the version
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check as checkSpecIds } from "./spec-ids.js";
import { render as renderToolsDoc } from "./tools-doc.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/** Files that must ship, and patterns that must never ship (call logs, scratch, private docs). */
const REQUIRED = ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "docs/TOOLS.md", "src/mcp/main.js", "src/cli/main.js", "src/daemon/main.js", "extension/manifest.json", "extension/generated/pw-injected.js", "extension/generated/keyboard-layout.json"];
const FORBIDDEN = [/^temp\//, /^tests\//, /^specs\//, /^docs\/internal\//, /\.jsonl(\.\d+)?$/, /\.log$/, /(^|\/)\.env$/, /\.tgz$/];

/** @type {{name: string, ok: boolean, detail: string}[]} */
const results = [];
/** @param {string} name @param {() => string | void} fn */
function gate(name, fn) {
  try {
    results.push({ name, ok: true, detail: fn() ?? "" });
  } catch (error) {
    results.push({ name, ok: false, detail: String(/** @type {any} */ (error)?.message ?? error) });
  }
}

/** @param {string} command @param {string[]} commandArgs */
function run(command, commandArgs) {
  const r = spawnSync(command, commandArgs, { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} failed:\n${(r.stdout + r.stderr).split("\n").slice(-25).join("\n")}`);
  return r.stdout + r.stderr;
}

/** "ℹ pass 31" and "ℹ fail 0" from node --test output. @param {string} output */
function counts(output) {
  const n = (/** @type {string} */ label) => Number(new RegExp(`ℹ ${label} (\\d+)`).exec(output)?.[1] ?? NaN);
  return `${n("pass")} pass, ${n("fail")} fail, ${n("skipped")} skipped`;
}

gate("build", () => {
  run(npm, ["run", "build"]);
});
gate("typecheck", () => {
  run(npm, ["run", "typecheck"]);
});
gate("unit tests", () => counts(run(npm, ["test"])));
gate("spec IDs", () => {
  const r = checkSpecIds();
  const problems = [...r.untested.map((u) => `untested ${u.id}`), ...r.unspecified.map((u) => `unspecified ${u.id}`), ...r.unnamed.map((u) => `no ID: ${u}`)];
  if (problems.length) throw new Error(problems.join("\n"));
  return `${r.specs} IDs tested; manual checks to do by hand: ${r.manual.map((m) => m.id).join(", ") || "none"}`;
});
gate("docs/TOOLS.md", () => {
  if (fs.readFileSync(path.join(root, "docs/TOOLS.md"), "utf8") !== renderToolsDoc()) throw new Error("out of date: run node scripts/tools-doc.js");
});
gate("package contents", () => {
  const [pack] = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", shell: process.platform === "win32" }));
  const shipped = new Set(pack.files.map((/** @type {{path: string}} */ f) => f.path));
  const missing = REQUIRED.filter((f) => !shipped.has(f));
  const forbidden = [...shipped].filter((f) => FORBIDDEN.some((p) => p.test(f)));
  // a shipped module that imports a file that does not ship would break the installed package
  const unresolved = [];
  for (const file of shipped) {
    if (!file.endsWith(".js")) continue;
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const [, spec] of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      if (!shipped.has(target)) unresolved.push(`${file} imports ${spec}`);
    }
  }
  const problems = [...missing.map((f) => `missing ${f}`), ...forbidden.map((f) => `must not ship ${f}`), ...unresolved];
  if (problems.length) throw new Error(problems.join("\n"));
  return `${shipped.size} files, ${(pack.unpackedSize / 1024 / 1024).toFixed(1)} MB unpacked`;
});
if (args.has("--release")) {
  gate("versions", () => {
    const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8")).version;
    const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    const firstEntry = /^## (\S+)/m.exec(changelog)?.[1];
    const problems = [];
    if (/-dev$/.test(version)) problems.push(`package.json version is ${version}`);
    if (manifest !== version) problems.push(`extension/manifest.json is ${manifest}, package.json is ${version}`);
    if (firstEntry !== version) problems.push(`the first CHANGELOG entry is ${firstEntry}, not ${version}`);
    if (problems.length) throw new Error(problems.join("\n"));
    return version;
  });
}
if (args.has("--live")) gate("live tests", () => counts(run(npm, ["run", "test:live"])));

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  ${r.detail.split("\n").join("\n      ")}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} gate(s) failed` : "\nall gates passed");
process.exitCode = failed ? 1 : 0;
