#!/usr/bin/env node
// Pre-release gates. Run `npm run preflight` before cutting any version.
//
// Why a script and not a checklist: a checklist is written against the surface that
// existed the day it was written, and then a feature ships that it cannot see. Every gate
// here DERIVES what it checks from the code — the tool registry, the protocol action list,
// the parameter schemas — so a new tool or a new parameter is checked the moment it exists,
// without anyone remembering to add a line.
//
//   node scripts/preflight.mjs           unit gates only (no browser needed)
//   node scripts/preflight.mjs --e2e     also run the live end-to-end suite
//   node scripts/preflight.mjs --fix     rewrite the generated surface doc in place
//
// Exit code is non-zero if any gate fails. Every failure prints what to do about it.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const argv = process.argv.slice(2);
const RUN_E2E = argv.includes("--e2e");
const FIX = argv.includes("--fix");

const results = [];
const read = (p) => readFileSync(join(ROOT, p), "utf8");
function gate(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || "" });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
  }
}

// The registry is the source of truth for every gate below.
process.env.BROWSERCTL_MCP_PROFILE = "all";
const mcp = await import(join(ROOT, "mcp", "index.js"));
const TOOLS = mcp.server._registeredTools;
const TOOL_NAMES = Object.keys(TOOLS);
const CORE = mcp.TOOL_CATEGORIES?.core || [];
const paramsOf = (name) =>
  Object.keys(TOOLS[name]?.inputSchema?.shape || {}).filter((k) => k !== "tabId" && k !== "tab_id");

// ---------------------------------------------------------------- 1. versions
gate("versions agree", () => {
  const pkg = JSON.parse(read("package.json"));
  const manifest = JSON.parse(read("extension/manifest.json"));
  if (pkg.version !== manifest.version) {
    throw new Error(`package.json ${pkg.version} vs extension/manifest.json ${manifest.version} — bump both; the manifest version is the only thing in chrome://extensions that shows the loaded extension is stale`);
  }
  if (!/const SERVER_VERSION = \(\(\) =>/.test(read("mcp/index.js"))) {
    throw new Error("SERVER_VERSION must be derived from package.json, not restated");
  }
  // The docs claim a version too, and nothing was checking them: PROTOCOL.md said 0.6.3
  // while the package was at 0.7.1, and docs/REFERENCE.md claimed "80 tools" when there
  // were 67. A number in prose is a number that rots.
  const stale = [];
  for (const f of ["PROTOCOL.md", "README.md", "docs/REFERENCE.md", "docs/TOOLS.md", "skills/browserctl/SKILL.md"]) {
    if (!existsSync(join(ROOT, f))) continue;
    const doc = read(f);
    for (const m of doc.matchAll(/(?:Version|version:?|v)\s*\**(\d+\.\d+\.\d+)\**/g)) {
      if (m[1] !== pkg.version) stale.push(`${f}: says ${m[1]}`);
    }
    for (const m of doc.matchAll(/(\d+)\s+tools\b/g)) {
      const n = Number(m[1]);
      if (n !== TOOL_NAMES.length && n !== CORE.length) stale.push(`${f}: claims ${n} tools (there are ${TOOL_NAMES.length}, ${CORE.length} in core)`);
    }
  }
  if (stale.length) throw new Error(stale.join("; ") + " — a number in prose rots; state it once or derive it");
  return `v${pkg.version}`;
});

// -------------------------------------------- 1b. the version people will actually see
gate("the changelog leads with this version", () => {
  const pkg = JSON.parse(read("package.json"));
  const headings = [...read("CHANGELOG.md").matchAll(/^## (\d+\.\d+\.\d+)/gm)].map((m) => m[1]);
  if (!headings.length) throw new Error("no version heading in CHANGELOG.md");
  if (headings[0] !== pkg.version) {
    throw new Error(`CHANGELOG leads with ${headings[0]}, package.json says ${pkg.version} — a version number is read from OUTSIDE, where internal iteration is invisible. If you bumped several times while working, collapse them into the one version you will publish.`);
  }
  return headings[0];
});

// ---------------------------------------------------------------- 2. unit tests
gate("unit tests", () => {
  const out = execFileSync("npm", ["test"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const pass = out.match(/^ℹ pass (\d+)$/m)?.[1];
  const fail = out.match(/^ℹ fail (\d+)$/m)?.[1];
  if (fail !== "0") throw new Error(`${fail} failing`);
  return `${pass}/${pass}`;
});

// ------------------------------------------- 3. the generated surface doc is current
// The doc that lists every tool with its parameters is generated. If it has drifted, a
// tool or a parameter shipped without appearing in the one place that claims to list them.
// docs/, not improvements/: this is a user-facing reference to what the tools are, and
// improvements/ is third-party input that never leaves this machine — a gate that reads a
// private file cannot run in the public repo.
const SURFACE_DOC = "docs/TOOLS.md";
function renderSurface() {
  const src = read("mcp/index.js");
  const catBlock = src.match(/const TOOL_CATEGORIES\s*=\s*\{([\s\S]*?)\n\};/)[1];
  const cats = {};
  for (const g of catBlock.matchAll(/(\w+):\s*\[([\s\S]*?)\]/g)) {
    cats[g[1]] = [...g[2].matchAll(/"(browser_[a-z_0-9]+)"/g)].map((m) => m[1]);
  }
  const version = JSON.parse(read("package.json")).version;
  const lines = [
    `# Tool surface as it actually is — generated ${new Date().toISOString().slice(0, 10)}, browserctl ${version}`,
    "",
    "Generated from the running server (`server._registeredTools`), not written by hand — the last",
    "hand-written version of this list claimed `all` on a tool that did not have it.",
    "",
    "`*` = required. `tabId`/`tab_id` accepted on every tab-scoped tool, omitted from the tables.",
    "",
  ];
  for (const [cat, names] of Object.entries(cats)) {
    lines.push("", `### ${cat} (${names.length})`, "", "| Tool | Parameters | Description |", "|---|---|---|");
    for (const name of names) {
      const t = TOOLS[name];
      const shape = t?.inputSchema?.shape || {};
      const ps = Object.keys(shape)
        .filter((k) => k !== "tab_id" && k !== "tabId")
        .map((k) => {
          let optional = true;
          try { optional = shape[k].safeParse(undefined).success; } catch {}
          return optional ? k : "*" + k;
        });
      const d = (t?.description || "").replace(/^\[[A-Z]+\][\s\S]*?\n\n/, "").split("\n")[0].trim().replace(/\|/g, "\\|");
      lines.push(`| \`${name.replace("browser_", "")}\` | ${ps.join(", ") || "(none)"} | ${d} |`);
    }
  }
  return lines.join("\n") + "\n";
}
gate("generated surface doc is current", () => {
  const fresh = renderSurface();
  const stripDate = (s) => s.replace(/generated \d{4}-\d{2}-\d{2}/, "generated <date>");
  const current = existsSync(join(ROOT, SURFACE_DOC)) ? read(SURFACE_DOC) : "";
  if (stripDate(fresh) !== stripDate(current)) {
    if (FIX) {
      writeFileSync(join(ROOT, SURFACE_DOC), fresh);
      return "rewritten (--fix)";
    }
    throw new Error(`${SURFACE_DOC} no longer matches the registry — run: node scripts/preflight.mjs --fix`);
  }
  return `${TOOL_NAMES.length} tools`;
});

// ------------------------------------------------ 4. every core tool is documented
gate("every core tool appears in the docs", () => {
  const readme = read("README.md");
  const reference = read("docs/REFERENCE.md");
  const missing = CORE.filter((n) => !readme.includes(n) && !reference.includes(n));
  if (missing.length) {
    throw new Error(`not mentioned in README.md or docs/REFERENCE.md: ${missing.join(", ")} — a tool nobody documented is a tool nobody finds`);
  }
  return `${CORE.length} core tools`;
});

// --------------------------------------- 5. every parameter of a core tool is documented
// This is the gate that catches the specific rot: a feature ships as a NEW PARAMETER on an
// existing tool, every doc still describes the tool, and nothing says the parameter exists.
gate("every core tool parameter is documented", () => {
  // Two audiences, two places. An agent reads the schema, so every parameter needs its own
  // describe(); a human reads docs/REFERENCE.md, so a core tool's parameters have to be
  // listed there too. A feature that ships as a new PARAMETER is invisible to both if
  // neither is updated — which is the failure this gate exists for.
  const corpus = read("README.md") + read("docs/REFERENCE.md") + read("CHANGELOG.md");
  const unexplained = [];
  const undocumented = [];
  for (const name of CORE) {
    const shape = TOOLS[name]?.inputSchema?.shape || {};
    const desc = TOOLS[name]?.description || "";
    for (const p of paramsOf(name)) {
      const explained = (shape[p]?.description || "").trim().length > 0 || desc.includes(p);
      if (!explained) unexplained.push(`${name}.${p}`);
      if (!corpus.includes(p)) undocumented.push(`${name}.${p}`);
    }
  }
  if (unexplained.length) {
    throw new Error(`no describe() an agent can read: ${unexplained.join(", ")}`);
  }
  if (undocumented.length) {
    throw new Error(`absent from README/REFERENCE/CHANGELOG: ${undocumented.join(", ")} — a feature that ships as a new parameter is invisible unless the docs name it`);
  }
  return "explained and documented";
});

// -------------------------------------- 6. nothing points at a tool that no longer exists
// Derived, so it keeps working after the next rename: any `browser_x` mentioned in a STRING
// an agent can read (not a comment, not a changelog) must be a tool that is registered.
gate("no live pointer to a removed tool", () => {
  const files = ["mcp/index.js", "cli.js", "extension/background.js", "extension/content.js", "extension/netlog.js", "README.md", "docs/REFERENCE.md", "skills/browserctl/SKILL.md"];
  const known = new Set(TOOL_NAMES);
  const bad = [];
  for (const f of files) {
    if (!existsSync(join(ROOT, f))) continue;
    read(f).split("\n").forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("#")) return; // commentary may name history
      if (/→|->/.test(line)) return;                                            // migration notes name both sides
      if (/\bno\s+`?browser_/i.test(line)) return;                                // "There is no browser_check tool" is the opposite of a pointer
      for (const m of line.matchAll(/\bbrowser_[a-z_0-9]+/g)) {
        if (!known.has(m[0]) && !bad.some((b) => b.endsWith(m[0]))) bad.push(`${f}:${i + 1} ${m[0]}`);
      }
    });
  }
  if (bad.length) throw new Error(`points at a tool that does not exist: ${bad.join(", ")}`);
  return `${files.length} files`;
});

// ------------------------------------- 7. every protocol action is exercised or excused
gate("e2e covers every protocol action", () => {
  // Coverage is spread over several suites; read them all, or a check in run_editors reads
  // as a hole in run.mjs.
  const suites = ["run.mjs", "run_editors.mjs", "run_labels.mjs", "run_multiframe.mjs"]
    .filter((f) => existsSync(join(ROOT, "tests/e2e", f)))
    .map((f) => read(join("tests/e2e", f)))
    .join("\n");
  const run = suites;
  const excused = new Set([...run.matchAll(/^\s{2}([a-z_0-9]+):\s*"/gm)].map((m) => m[1]));
  const src = read("mcp/index.js");
  const registered = [...src.matchAll(/\btool\(\s*"([a-z_0-9]+)"/g)].map((m) => m[1]);
  const aliasBlock = src.match(/const ACTION_ALIASES\s*=\s*\{([\s\S]*?)\n\};/);
  const aliases = aliasBlock ? [...aliasBlock[1].matchAll(/^\s*([a-z_0-9]+)\s*:/gm)].map((m) => m[1]) : [];
  const extraBlock = src.match(/const extra = \[([\s\S]*?)\];/);
  const extra = extraBlock ? [...extraBlock[1].matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]) : [];
  const surface = [...new Set([...registered, ...aliases, ...extra])];
  const unmentioned = surface.filter((a) => a !== "action" && !excused.has(a) && !new RegExp(`cmd(Fail)?\\(\\s*"${a}"`).test(run));
  if (unmentioned.length) {
    throw new Error(`neither exercised nor excused in tests/e2e/run.mjs: ${unmentioned.join(", ")} — add a check, or add it to NOT_EXERCISED with the reason`);
  }
  return `${surface.length} actions`;
});

// ------------------------------------- 7b. the loop, and the group notes that carry it
// The group note is prefixed onto every description in its group, so a stale one is wrong on
// every tool at once — the READ note listed "find_text, get_text" for two releases after both
// were merged away. The member lists are generated now; this gate keeps them that way, and
// keeps the loop itself present on both surfaces an agent reads.
gate("the loop is stated, and group notes are generated", () => {
  const src = read("mcp/index.js");
  // The loop must be STATED, not phrased one particular way. What matters is that an agent
  // reading the instructions once can see the shape: open, read, act, then check the effect.
  const iStart = src.indexOf("const INSTRUCTIONS = `");
  const instructions = src.slice(iStart, src.indexOf("`;", iStart));
  if (!/THE LOOP/.test(instructions)) throw new Error("the instructions do not state the loop");
  for (const step of ["browser_open_url", "browser_snapshot", "browser_click", "effect"]) {
    if (!instructions.includes(step)) {
      throw new Error(`the loop in the instructions never mentions ${step} — an agent cannot follow a loop it is not told about`);
    }
  }
  if (!/const members = \(g\) =>/.test(src)) {
    throw new Error("group notes must generate their member lists from TOOL_GROUPS — a hand-written list is wrong on every tool in the group at once");
  }
  const noteBlock = src.slice(src.indexOf("const GROUP_NOTE"), src.indexOf("const GROUP_NOTE") + 2500);
  const hardcoded = [...noteBlock.matchAll(/\(([a-z_]+(?:, [a-z_]+){2,})\)/g)].map((m) => m[1]);
  if (hardcoded.length) {
    throw new Error(`group notes still hard-code a tool list: ${hardcoded[0]}`);
  }
  // Every step of the loop must map to a group an agent can see on a tool.
  for (const g of ["ORIENT", "READ", "ACT"]) {
    if (!new RegExp(`^\\s*${g}:`, "m").test(src)) throw new Error(`no ${g} group — the loop has a step with no tools behind it`);
  }
  return "loop stated, notes generated";
});

// ------------------------------------------------ 8. the intent index names the new calls
gate("the intent index is not stale", () => {
  const src = read("mcp/index.js");
  // Not every core tool: the instructions carry the tools an agent needs to START, and the
  // rest live in their own descriptions — the same division playwright-mcp makes, and the
  // reason its server instructions are empty. What must never go missing is the entry point
  // for each kind of work.
  const iStart2 = src.indexOf("const INSTRUCTIONS = `");
  const index = src.slice(iStart2, src.indexOf("`;", iStart2));
  const entryPoints = [
    "browser_open_url", "browser_snapshot", "browser_get_page_content", "browser_get_property",
    "browser_find", "browser_click", "browser_fill", "browser_eval_js", "browser_action",
    "browser_load_tools",
  ];
  // A count typed into the instructions is read by every agent at connect and is wrong the
  // first time a tool moves between profiles: it said 45 when there were 44. Interpolate it.
  const handCount = index.match(/\b\d+ (further capabilities|tools|actions)\b/);
  if (handCount) {
    throw new Error(`the server instructions state "${handCount[0]}" as a literal — derive it from the registry instead`);
  }

  const missing = entryPoints.filter((n) => !index.includes(n));
  if (missing.length) {
    throw new Error(`absent from the server instructions an agent reads at connect: ${missing.join(", ")} — an entry point not named there is reachable only by luck`);
  }
  return `${entryPoints.length} entry points routed`;
});

// -------------------------------------------- 8b. child test scripts are real files
gate("child test scripts parse on their own", () => {
  const dir = join(ROOT, "tests/unit/children");
  if (!existsSync(dir)) return "none yet";
  const files = execFileSync("sh", ["-c", `ls ${dir}/*.mjs 2>/dev/null || true`], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  for (const f of files) {
    try {
      execFileSync("node", ["--check", f], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      throw new Error(`${f.split("/").pop()} does not parse — a fixture is a real source file, so this is a plain syntax error`);
    }
  }
  return `${files.length} checked`;
});

// --------------------------------------------------------------- 9. the shipped tarball
gate("npm tarball is clean", () => {
  // npm writes its file list to stderr, so capture both streams or the gate checks nothing.
  const out = execFileSync("sh", ["-c", "npm pack --dry-run 2>&1"], { cwd: ROOT, encoding: "utf8" });
  for (const leak of ["calls.jsonl", "improvements/", "telemetry"]) {
    if (out.includes(leak)) throw new Error(`the tarball would ship ${leak}`);
  }
  const files = out.match(/total files:\s*(\d+)/)?.[1];
  return `${files} files`;
});

// --------------------------------------------------------------- 10. live end-to-end
gate("end-to-end (live browser)", () => {
  if (!RUN_E2E) return "SKIPPED — rerun with --e2e once the bridge and extension are up";

  // Check the stack is actually up first. Running the suite against a bridge whose
  // extension is still reconnecting (the first seconds after reload_extension) produces a
  // failure that reads like a regression and is not one — that happened on this gate's
  // first real run.
  let status = null;
  try {
    status = JSON.parse(execFileSync("sh", ["-c", "curl -s -m 3 http://127.0.0.1:8765/status"], { encoding: "utf8" }));
  } catch {}
  if (!status || !status.extensionConnected) {
    throw new Error("bridge unreachable or extension not connected — start it (npm start) and load the extension; if you just reloaded the extension, give it a second");
  }

  // Every suite that drives the live stack, not just run.mjs. The gate used to run one of
  // four, and the other three were left to be run by hand — so three assertions in
  // run_multiframe.mjs went on asserting a census shape that had been replaced two releases
  // earlier, and nothing said a word. A suite the release does not run is a suite that rots.
  const SUITES = [
    ["tests/e2e/run.mjs", null],
    ["tests/e2e/run_multiframe.mjs", null],
    ["tests/e2e/run_labels.mjs", /all label paths agree/],
    ["tests/e2e/run_editors.mjs", null],
  ];
  const runOnce = (file) => {
    try {
      return execFileSync("node", [file], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      // A suite prints its failures to stdout and exits non-zero; surface those instead of
      // node's "Command failed", which says nothing about what broke.
      return String(err.stdout || "") || null;
    }
  };
  const clean = (o, ok) => {
    if (o && ok && ok.test(o)) return ["ok", "ok", "ok"];
    const m = o && o.match(/==== (\d+)\/(\d+) checks passed ====/);
    return m && m[1] === m[2] ? m : null;
  };
  const counts = [];
  for (const [file, ok] of SUITES) {
    let out = runOnce(file);
    if (!clean(out, ok)) out = runOnce(file); // one retry: the live stack has genuine transients
    const m = clean(out, ok);
    if (!m) {
      const failures = (out || "").split("FAILURES:")[1]?.trim().slice(0, 400);
      throw new Error(
        `${file}:` + (failures ? `\n      ${failures.replace(/\n/g, "\n      ")}` : " did not report a clean run")
      );
    }
    if (file.endsWith("run.mjs")) {
      const missed = out.match(/(\d+) missed/)?.[1];
      if (missed && missed !== "0") throw new Error(`${missed} protocol actions neither exercised nor excused`);
    }
    counts.push(m[1] === "ok" ? file.split("/").pop() : `${file.split("/").pop()} ${m[1]}/${m[2]}`);
  }
  return counts.join(", ");
});

// ----------------------------------------------------------------------- report
let failed = 0;
console.log("");
for (const r of results) {
  const mark = r.ok ? "PASS" : "FAIL";
  if (!r.ok) failed++;
  console.log(`  ${mark}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
console.log("");
if (failed) {
  console.log(`  ${failed} gate${failed > 1 ? "s" : ""} failed. Nothing is released until they are green.\n`);
  process.exit(1);
}
console.log(RUN_E2E ? "  All gates green. Ready to cut a release.\n" : "  Unit gates green. Run with --e2e before cutting a release.\n");
process.exit(0);
