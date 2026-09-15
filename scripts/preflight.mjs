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

import { execFileSync, spawnSync } from "node:child_process";
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

// Three gates below scan "everywhere the tool surface is spoken about", and each used to carry
// its own copy of the list. The copies drifted: two of them still named skills/browserctl/SKILL.md
// and one named PROTOCOL.md, neither of which has existed for some time, and because every gate
// skipped a missing path in silence, each reported a file count larger than what it actually read.
// A guarded path that disappears shrinks the guard, so GUARDED_PATHS gets a gate of its own
// instead of a quiet `continue`.
// The spec states what is true now, so it is scanned like any shipping document. Its sibling
// docs/internal/history.md is deliberately NOT here: it quotes dead syntax and superseded counts
// on purpose, which is what a history is for.
// The spec states what is true now, so it is scanned like any shipping document in the source
// repo. In the public clone, docs/internal/ is excluded by sync-public.sh, so SPEC only applies
// where it exists (or in the source repo where its presence is mandatory).
const IS_SOURCE_REPO = existsSync(join(ROOT, "scripts/sync-public.sh"));
const SPEC = "docs/internal/tool-surface.md";
const SURFACE_SOURCE = [
  "mcp/index.js",
  "cli.js",
  "extension/background.js",
  "extension/content.js",
  "extension/netlog.js",
];
const SURFACE_DOCS = [
  "README.md",
  "CONTRIBUTING.md",
  "docs/REFERENCE.md",
  "docs/INSTALL.md",
  "docs/TOOLS.md",
  ...(IS_SOURCE_REPO || existsSync(join(ROOT, SPEC)) ? [SPEC] : []),
];
const GUARDED_PATHS = [...SURFACE_SOURCE, ...SURFACE_DOCS];

gate("every guarded path still exists", () => {
  const gone = GUARDED_PATHS.filter((f) => !existsSync(join(ROOT, f)));
  if (gone.length)
    throw new Error(
      `these gates scan a file that is no longer there, so their coverage silently shrank: ${gone.join(", ")} — delete the entry deliberately, or restore the file`
    );
  return `${GUARDED_PATHS.length} paths`;
});

// ---------------------------------------------------------------- 1. versions
gate("versions agree", () => {
  const pkg = JSON.parse(read("package.json"));
  const manifest = JSON.parse(read("extension/manifest.json"));
  if (pkg.version !== manifest.version) {
    throw new Error(
      `package.json ${pkg.version} vs extension/manifest.json ${manifest.version} — bump both; the manifest version is the only thing in chrome://extensions that shows the loaded extension is stale`
    );
  }
  if (!/const SERVER_VERSION = \(\(\) =>/.test(read("mcp/index.js"))) {
    throw new Error("SERVER_VERSION must be derived from package.json, not restated");
  }
  // The docs claim a version too, and nothing was checking them: PROTOCOL.md said 0.6.3
  // while the package was at 0.7.1, and docs/REFERENCE.md claimed "80 tools" when there
  // were 67. A number in prose is a number that rots.
  const stale = [];
  for (const f of SURFACE_DOCS) {
    const doc = read(f);
    for (const m of doc.matchAll(/(?:Version|version:?|v)\s*\**(\d+\.\d+\.\d+)\**/g)) {
      if (m[1] !== pkg.version) stale.push(`${f}: says ${m[1]}`);
    }
    // "24 core tools" puts a word between the number and "tools", which the earlier pattern
    // skipped — so README and REFERENCE both shipped a stale core count while this gate was
    // green. One optional qualifier is allowed in between now.
    // The lookbehind keeps "v0.7 tools" from reading as a claim of 7 tools — it did, for as long
    // as this gate has existed, and the false positive is why the check was never pointed at the
    // documents that actually had a stale count.
    for (const m of doc.matchAll(/(?<![.\d])(\d+)\s+(?:\w+\s+)?tools\b/g)) {
      const n = Number(m[1]);
      if (n !== TOOL_NAMES.length && n !== CORE.length)
        stale.push(
          `${f}: claims ${n} tools (there are ${TOOL_NAMES.length}, ${CORE.length} in core)`
        );
    }
  }
  if (stale.length)
    throw new Error(stale.join("; ") + " — a number in prose rots; state it once or derive it");
  return `v${pkg.version}`;
});

// -------------------------------------------- 1b. the version people will actually see
gate("the changelog leads with this version", () => {
  const pkg = JSON.parse(read("package.json"));
  const headings = [...read("CHANGELOG.md").matchAll(/^## (\d+\.\d+\.\d+)/gm)].map((m) => m[1]);
  if (!headings.length) throw new Error("no version heading in CHANGELOG.md");
  if (headings[0] !== pkg.version) {
    throw new Error(
      `CHANGELOG leads with ${headings[0]}, package.json says ${pkg.version} — a version number is read from OUTSIDE, where internal iteration is invisible. If you bumped several times while working, collapse them into the one version you will publish.`
    );
  }
  return headings[0];
});

// ------------------------------------------------------- 1b. lint and formatting
// The no-comments rule on published source (CONTRIBUTING.md) lives in eslint.config.js, so it
// only binds if lint runs. Running it here makes the convention a release gate rather than a
// thing somebody remembers.
gate("lint and formatting", () => {
  // Report what eslint said, not "Command failed": a gate whose message is not actionable
  // costs the reader a second run to find out what it meant.
  for (const [what, cmd] of [
    ["eslint", "npm run lint --silent"],
    ["prettier", "npm run format:check --silent"],
  ]) {
    const res = spawnSync("sh", ["-c", `${cmd} 2>&1`], { cwd: ROOT, encoding: "utf8" });
    if (res.status !== 0) {
      const detail = (res.stdout || "").trim().split("\n").filter(Boolean).slice(-6).join(" | ");
      throw new Error(`${what} failed: ${detail || "no output"}`);
    }
  }
  return "eslint + prettier clean";
});

// ------------------------------- 1c. what the agent has to read before it can act
// Every description, every parameter describe(), and the instructions block are loaded into
// an agent's context at connect, on every session, whether or not the tool is used. Text added
// here is not free documentation — it is a standing tax on every run, and the same fact stated
// in four places costs four times and rots in three.
//
// Two things are checked. A BUDGET, so added text has to be paid for by deleted text rather
// than waved through; and REPETITION, so a fact lands in the one place that owns it. Where a
// 18800: raised from 18500 on owner directive — browser_hover promoted to CORE (25 tools)
// to align with Playwright MCP defaults.
const AGENT_TEXT_BUDGET = 18800;
const REPEAT_ALLOWED = {
  "requires the target tab in the foreground: chrome silently drops cdp synthetic mouse input for background tabs so this errors rather than pretending to click":
    "coordinate_click and coordinate_drag are siblings and this is a hard constraint on both; an agent reading one description cannot be sent to the other",
  "for background work use browser_click ref selector or text instead":
    "the escape from that same constraint, and it has to travel with it",
  "headers are included verbatim local tool no redaction":
    "export_har and net_get both hand back headers; a privacy property stated on only one of them is worse than repeated",
};
gate("the agent's reading budget is respected", () => {
  // Measured off the REGISTRY, not the source file: what a default session is handed is the
  // number that costs anything. Measuring the source instead hid the largest waste there was —
  // the group note was one constant in the file and 24 identical copies on the wire.
  const src = read("mcp/index.js");
  const iStart = src.indexOf("const INSTRUCTIONS = `");
  const instructions = src.slice(iStart, src.indexOf("`;", iStart));
  let descChars = 0;
  let paramChars = 0;
  const descs = [];
  for (const name of CORE) {
    const t = TOOLS[name];
    if (!t) continue;
    const d = t.description || "";
    descChars += d.length;
    descs.push([name, d]);
    for (const k of Object.keys(t.inputSchema?.shape || {})) {
      paramChars += (t.inputSchema.shape[k]?.description || "").length;
    }
  }
  const total = descChars + paramChars + instructions.length;
  if (total > AGENT_TEXT_BUDGET) {
    throw new Error(
      `a default session is handed ${total} chars before it does anything (${descChars} descriptions + ${paramChars} parameters + ${instructions.length} instructions), ${total - AGENT_TEXT_BUDGET} over the ${AGENT_TEXT_BUDGET} budget. Biggest descriptions: ${descs
        .map(([n, d]) => [n, d.length])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([n, l]) => `${n} ${l}ch`)
        .join(
          ", "
        )}. Either delete as much as you added, or raise AGENT_TEXT_BUDGET here with the reason — both are fine; deciding by accident is not.`
    );
  }

  const norm = (t) =>
    t
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .replace(/[`'"(),.:]/g, "")
      .trim();
  const owner = new Map();
  for (const [name, d] of descs) {
    for (const raw of d.split(/(?<=[.!?])\s+|\n/)) {
      const t = norm(raw);
      if (t.length < 45 || REPEAT_ALLOWED[t]) continue;
      if (owner.has(t) && owner.get(t) !== name) {
        throw new Error(
          `the same sentence is stated in ${owner.get(t)} and ${name}: "${t.slice(0, 70)}…" — say it once where it belongs (CONTRIBUTING.md), or add it to REPEAT_ALLOWED with the reason it has to travel`
        );
      }
      owner.set(t, name);
    }
  }

  const shingles = (t) => {
    const w = t.split(" ");
    return new Set(
      w.slice(0, Math.max(1, w.length - 3)).map((_, i) => w.slice(i, i + 4).join(" "))
    );
  };
  const sentences = descs.flatMap(([name, d]) =>
    d
      .split(/(?<=[.!?])\s+|\n/)
      .map(norm)
      .filter((t) => t.length >= 45 && !REPEAT_ALLOWED[t])
      .map((t) => [name, t])
  );
  for (let i = 0; i < sentences.length; i++) {
    for (let j = i + 1; j < sentences.length; j++) {
      if (sentences[i][0] === sentences[j][0]) continue;
      const a = shingles(sentences[i][1]);
      const b = shingles(sentences[j][1]);
      const inter = [...a].filter((x) => b.has(x)).length;
      const jac = inter / (a.size + b.size - inter);
      if (jac >= 0.6) {
        throw new Error(
          `${sentences[i][0]} and ${sentences[j][0]} say nearly the same thing (${jac.toFixed(2)}): "${sentences[i][1].slice(0, 60)}…" / "${sentences[j][1].slice(0, 60)}…" — one of them owns the fact`
        );
      }
    }
  }
  return `${total}/${AGENT_TEXT_BUDGET} chars handed to a default session, no repeated sentence`;
});

// --------------------------- 1d. the one fact that legitimately lives in three places
// Target resolution has to be in hand for three audiences that cannot follow a cross-reference:
// the agent (server instructions), the reader (docs/REFERENCE.md) and the spec
// (docs/internal/tool-surface.md). CONTRIBUTING.md allows exactly this exception. What it does
// not allow is the three drifting, so the enumeration every copy depends on is pinned here.
// A result field named in the instructions has to exist where they say it does. openDialogs was
// documented at the top level of a snapshot for two releases while the code returned it under
// pageState — an agent reading result.openDialogs found nothing, on every page.
gate("documented result fields sit where the docs say", () => {
  const src = read("mcp/index.js");
  const iStart = src.indexOf("const INSTRUCTIONS = `");
  const instructions = src.slice(iStart, src.indexOf("`;", iStart));
  const content = read("extension/content.js");
  const wrong = [];
  for (const field of [
    "openDialogs",
    "hiddenContent",
    "offscreenCount",
    "foldedCount",
    "structure",
  ]) {
    if (!instructions.includes(field) && !src.includes(field)) continue;
    const nested = new RegExp(`pageState[\\s\\S]{0,400}?\\b${field}:`).test(content);
    if (!nested) continue;
    // Every mention in the instructions must carry its parent. The JSON example is what an
    // agent copies, so a bare "field": there is the failure, whatever the prose says elsewhere.
    for (const m of instructions.matchAll(new RegExp(`"${field}"\\s*:`, "g"))) {
      const before = instructions.slice(Math.max(0, m.index - 60), m.index);
      if (!/pageState/.test(before))
        wrong.push(
          `the instructions show "${field}" outside pageState, but that is where it is returned`
        );
    }
    for (const m of instructions.matchAll(
      new RegExp(`(?<!pageState\\.)\\b${field}\\b(?!")`, "g")
    )) {
      const before = instructions.slice(Math.max(0, m.index - 12), m.index);
      if (!/pageState\./.test(before))
        wrong.push(`the instructions name ${field} without its pageState parent`);
    }
  }
  if (wrong.length) throw new Error(wrong.join("; "));
  return "5 result fields, documented where they are returned";
});

gate("every copy of the target-resolution rules agrees", () => {
  const RESOLVERS = ["ref", "css", "text-exact", "placeholder", "text-substring", "index"];
  const PREFIXES = ["css=", "text=", "placeholder=", "index="];
  // The design doc is internal and is not in the public clone, where this gate also runs.
  // Check the copies that are present: the point is that no two of them disagree, not that
  // all three exist everywhere.
  const sources = {
    "server instructions": (() => {
      const src = read("mcp/index.js");
      const i = src.indexOf("const INSTRUCTIONS = `");
      return src.slice(i, src.indexOf("`;", i));
    })(),
    "docs/REFERENCE.md": read("docs/REFERENCE.md"),
    ...(existsSync(join(ROOT, "docs/internal/tool-surface.md"))
      ? { "docs/internal/tool-surface.md": read("docs/internal/tool-surface.md") }
      : {}),
  };
  for (const [where, text] of Object.entries(sources)) {
    const missingBy = RESOLVERS.filter((r) => !text.includes(r));
    if (missingBy.length) {
      throw new Error(
        `${where} does not name resolution mode(s) ${missingBy.join(", ")} — the copies have drifted, and a reader believing the wrong one debugs for an hour`
      );
    }
    const missingPrefix = PREFIXES.filter((x) => !text.includes(x));
    if (missingPrefix.length) {
      throw new Error(`${where} does not document prefix(es) ${missingPrefix.join(", ")}`);
    }
  }
  return `${RESOLVERS.length} modes and ${PREFIXES.length} prefixes, stated the same in ${Object.keys(sources).length} places`;
});

// ---------------------------------------------------------------- 2. unit tests
gate("unit tests", () => {
  const out = execFileSync("npm", ["test"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
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
    lines.push(
      "",
      `### ${cat} (${names.length})`,
      "",
      "| Tool | Parameters | Description |",
      "|---|---|---|"
    );
    for (const name of names) {
      const t = TOOLS[name];
      const shape = t?.inputSchema?.shape || {};
      const ps = Object.keys(shape)
        .filter((k) => k !== "tab_id" && k !== "tabId")
        .map((k) => {
          let optional = true;
          try {
            optional = shape[k].safeParse(undefined).success;
          } catch {}
          return optional ? k : "*" + k;
        });
      const d = (t?.description || "")
        .replace(/^\[[A-Z]+\][\s\S]*?\n\n/, "")
        .split("\n")[0]
        .trim()
        .replace(/\|/g, "\\|");
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
    throw new Error(
      `${SURFACE_DOC} no longer matches the registry — run: node scripts/preflight.mjs --fix`
    );
  }
  return `${TOOL_NAMES.length} tools`;
});

// ------------------------------------------------ 4. every core tool is documented
gate("every core tool appears in the docs", () => {
  const readme = read("README.md");
  // REFERENCE.md is REQUIRED, not optional. Tolerating a missing file here once let the gate
  // pass while the parameter dictionary did not exist at all: "undocumented" and "the document
  // is gone" have to be different answers, and only one of them is this gate's business.
  if (!existsSync(join(ROOT, "docs/REFERENCE.md"))) {
    throw new Error("docs/REFERENCE.md is missing — the parameter dictionary is not optional");
  }
  const reference = read("docs/REFERENCE.md");
  // README is the catalogue and REFERENCE is the dictionary: a core tool has to be in BOTH.
  // Accepting either let browser_hover be promoted into core and never appear in the README
  // list whose entire job is to enumerate core.
  const missingFromReadme = CORE.filter((n) => !readme.includes(n));
  if (missingFromReadme.length) {
    throw new Error(`absent from README.md's core list: ${missingFromReadme.join(", ")}`);
  }
  const missing = CORE.filter((n) => !reference.includes(n));
  if (missing.length) {
    throw new Error(
      `not mentioned in README.md or docs/REFERENCE.md: ${missing.join(", ")} — a tool nobody documented is a tool nobody finds`
    );
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
  if (!existsSync(join(ROOT, "docs/REFERENCE.md"))) {
    throw new Error("docs/REFERENCE.md is missing — the parameter dictionary is not optional");
  }
  // INSTALL.md counts as documentation: setup content moved out of README, and a parameter
  // explained there must not read as undocumented.
  const install = existsSync(join(ROOT, "docs/INSTALL.md")) ? read("docs/INSTALL.md") : "";
  const reference = read("docs/REFERENCE.md");
  const corpus = read("README.md") + reference + install + read("CHANGELOG.md");
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
  // A parameter documented but NOT registered is the same defect pointing the other way: it
  // sends the reader to something that does not exist. Phase A pruned ref/selector/text/index
  // from seven core tools and REFERENCE.md kept listing all of them, because this gate only
  // ever looked for absence.
  const ghosts = [];
  for (const name of CORE) {
    const real = new Set(Object.keys(TOOLS[name]?.inputSchema?.shape || {}));
    const i = reference.indexOf(`### ${name}`);
    if (i < 0) continue;
    const j = reference.indexOf("\n###", i + 1);
    const body = reference.slice(i, j < 0 ? reference.length : j);
    for (const m of body.matchAll(/^- ([a-zA-Z_]+):/gm)) {
      if (!real.has(m[1])) ghosts.push(`${name}.${m[1]}`);
    }
  }
  // Names are not enough. REFERENCE listed waitFor as an enum when it takes a CSS selector, and
  // named 'networkidle' and 'markdown' as values of enums that have neither. A reader who trusts
  // that spends five seconds timing out on document.querySelector("networkidle").
  const wrongValues = [];
  for (const name of CORE) {
    const shape = TOOLS[name]?.inputSchema?.shape || {};
    const i = reference.indexOf(`### ${name}`);
    if (i < 0) continue;
    const j = reference.indexOf("\n###", i + 1);
    const body = reference.slice(i, j < 0 ? reference.length : j);
    for (const line of body.split("\n")) {
      const m = /^- ([a-zA-Z_]+):(.*)$/.exec(line);
      if (!m) continue;
      let field = shape[m[1]];
      while (field?._zod?.def?.innerType) field = field._zod.def.innerType;
      const values = field?._zod?.def?.entries;
      if (!values) continue;
      const allowed = new Set(Object.values(values));
      for (const q of m[2].matchAll(/'([a-zA-Z_][a-zA-Z_0-9-]*)'/g)) {
        if (!allowed.has(q[1]))
          wrongValues.push(
            `${name}.${m[1]} names '${q[1]}', which is not one of ${[...allowed].join("|")}`
          );
      }
    }
  }
  if (wrongValues.length) {
    throw new Error(
      `docs/REFERENCE.md documents values that do not exist: ${wrongValues.join("; ")}`
    );
  }
  if (ghosts.length) {
    throw new Error(
      `docs/REFERENCE.md documents parameters that do not exist: ${ghosts.join(", ")} — a reader sent to a parameter that was removed loses more time than one who was told nothing`
    );
  }
  if (undocumented.length) {
    throw new Error(
      `absent from README/REFERENCE/CHANGELOG: ${undocumented.join(", ")} — a feature that ships as a new parameter is invisible unless the docs name it`
    );
  }
  return "explained and documented";
});

// -------------------------------------- 6. nothing points at a tool that no longer exists
// Derived, so it keeps working after the next rename: any `browser_x` mentioned in a STRING
// an agent can read (not a comment, not a changelog) must be a tool that is registered.
gate("no live pointer to a removed tool", () => {
  const files = GUARDED_PATHS;
  const known = new Set(TOOL_NAMES);

  const bad = [];
  for (const f of files) {
    read(f)
      .split("\n")
      .forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("#")) return; // commentary may name history
        if (/→|->/.test(line)) return; // migration notes name both sides
        if (/\bno\s+`?browser_/i.test(line)) return; // "There is no browser_check tool" is the opposite of a pointer
        if (/was renamed|deprecated/i.test(line)) return; // deprecation and rename guidance
        // A spec for a clean break has to be able to name what the break removed. Naming a tool
        // alongside the word that retires it is a statement about the past, not a pointer at
        // something callable; naming it with no such word is exactly the stale pointer this gate
        // is for.
        if (/\b(?:dropped|gone|removed|superseded|no longer)\b/i.test(line)) return;
        // §4 of the spec compares this surface against Playwright MCP's, tool name by tool name.
        // Those names look exactly like ours and are not ours; a line that invokes Playwright is
        // talking about another product's API, not pointing at anything callable here.
        if (/playwright|not adopted/i.test(line)) return;
        if (/^\s*browser_[a-z_0-9]+:\s*($|")/i.test(line) && f === "mcp/index.js") return; // legacy hints map
        for (const m of line.matchAll(/\bbrowser_[a-z_0-9]+/g)) {
          if (!known.has(m[0]) && !bad.some((b) => b.endsWith(m[0])))
            bad.push(`${f}:${i + 1} ${m[0]}`);
        }
      });
  }
  if (bad.length) throw new Error(`points at a tool that does not exist: ${bad.join(", ")}`);
  return `${files.length} files`;
});

// ------------------------------------ 6b. no live pointer to a removed PARAMETER
// The gate above catches a tool that no longer exists. It does not catch a tool that still
// exists being called with a parameter that no longer does, and that is the exact shape the
// v0.8 clean break creates: addressing collapsed into `target`, so every hint, example and
// error string that still spelled `ref:` or `selector:` became syntax the server hands out
// and then refuses. It happened in CLI_TO_MCP, where six rewrites kept emitting
// browser_get_property({ref:...}) months after that parameter was gone, and every other gate
// passed the whole time.
//
// Derived, not listed: the allowed keys come from each tool's own schema, so a parameter
// renamed tomorrow is checked tomorrow without anyone editing this gate. Only the first
// brace group after the call is read, and only its top-level keys — a nested object is a
// value, not a parameter.
gate("every tool call in a string names real parameters", () => {
  const files = GUARDED_PATHS;

  // Walk from the opening brace and return the top-level comma-separated segments, so that
  // fields:{title:'h3'} contributes `fields` and never `title`. Quotes are tracked because a
  // selector may legitimately contain a brace.
  function topLevelSegments(src, open) {
    let depth = 0,
      quote = null,
      seg = "";
    const out = [];
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === quote && src[i - 1] !== "\\") quote = null;
        seg += c;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        seg += c;
        continue;
      }
      if (c === "{" || c === "[") {
        depth++;
        if (depth === 1) {
          seg = "";
          continue;
        }
      }
      if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) {
          out.push(seg);
          return out;
        }
      }
      if (c === "," && depth === 1) {
        out.push(seg);
        seg = "";
        continue;
      }
      seg += c;
    }
    return null; // unbalanced: prose, not a call
  }

  const bad = [];
  for (const f of files) {
    if (!existsSync(join(ROOT, f))) continue;
    const src = read(f);
    const lines = src.split("\n");
    for (const m of src.matchAll(/\bbrowser_[a-z_0-9]+\(\s*\{/g)) {
      const name = m[0].match(/browser_[a-z_0-9]+/)[0];
      const declared = Object.keys(TOOLS[name]?.inputSchema?.shape || {});
      if (!declared.length) continue; // unknown tool: the gate above owns that
      const allowed = new Set([...declared, "tabId", "tab_id"]);
      const segments = topLevelSegments(src, m.index + m[0].length - 1);
      if (!segments) continue;
      const line = src.slice(0, m.index).split("\n").length;
      for (const s of segments) {
        const key = s.match(/^\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*(:|$)/);
        if (!key) continue; // a spread, a placeholder, or an ellipsis
        if (!allowed.has(key[1]))
          bad.push(`${f}:${line} ${name} names '${key[1]}' — ${lines[line - 1].trim().slice(0, 80)}`);
      }
    }
  }
  if (bad.length)
    throw new Error(
      `hands out call syntax the server will refuse: ${bad.join("; ")}\n    Fix the string, not the schema — addressing is one parameter, 'target'.`
    );
  return `${files.length} files`;
});

// ------------------------------------- 7. every protocol action is exercised or excused
// The live suite proves the CORE loop works against a real browser. It is deliberately basic:
// one check per core capability, not one per edge case. Profile tools (network, cdp, cookies,
// storage, record, advanced) are reachable and unit-tested, and are not part of this gate —
// covering all 86 actions end to end made the suite slow, order-dependent and a chore to read,
// which is how a suite stops being run at all.
gate("e2e covers every core tool", () => {
  const suites = [
    "run.mjs",
    "run_editors.mjs",
    "run_labels.mjs",
    "run_multiframe.mjs",
    "harness.mjs",
  ]
    .filter((f) => existsSync(join(ROOT, "tests/e2e", f)))
    .map((f) => read(join("tests/e2e", f)))
    .join("\n");
  const src = read("mcp/index.js");
  const excused = new Set([...suites.matchAll(/^\s{2}([a-z_0-9]+):\s*"/gm)].map((m) => m[1]));
  const missing = [];
  for (const tool of CORE) {
    const i = src.indexOf(`server.registerTool(\n  "${tool}",`);
    if (i < 0) continue;
    const block = src.slice(i, src.indexOf("\n);", i));
    const action = /\btool\(\s*"([a-z_0-9]+)"/.exec(block)?.[1];
    if (!action || excused.has(action)) continue;
    const reached =
      new RegExp(`cmd(Fail|Raw)?\\(\\s*"${action}"`).test(suites) ||
      new RegExp(`\\b${action}\\(`).test(suites);
    if (!reached) missing.push(`${tool} (${action})`);
  }
  if (missing.length) {
    throw new Error(
      `core tools with no live check: ${missing.join(", ")} — the e2e suite is basic, but every core tool has to appear in it once`
    );
  }
  return `${CORE.length} core tools`;
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
  for (const step of ["browser_navigate", "browser_snapshot", "browser_click", "effect"]) {
    if (!instructions.includes(step)) {
      throw new Error(
        `the loop in the instructions never mentions ${step} — an agent cannot follow a loop it is not told about`
      );
    }
  }
  if (!/const members = \(g\) =>/.test(src)) {
    throw new Error(
      "group notes must generate their member lists from TOOL_GROUPS — a hand-written list is wrong on every tool in the group at once"
    );
  }
  const noteBlock = src.slice(
    src.indexOf("const GROUP_NOTE"),
    src.indexOf("const GROUP_NOTE") + 2500
  );
  const allToolBaseNames = new Set(TOOL_NAMES.map((n) => n.replace(/^browser_/, "")));
  const parenthesizedLists = [...noteBlock.matchAll(/\(([a-z_]+(?:, [a-z_]+){2,})\)/g)].map(
    (m) => m[1]
  );
  const hardcoded = parenthesizedLists.filter((list) => {
    const items = list.split(",").map((s) => s.trim());
    return items.every((it) => allToolBaseNames.has(it));
  });
  if (hardcoded.length) {
    throw new Error(`group notes still hard-code a tool list: ${hardcoded[0]}`);
  }
  // Every step of the loop must map to a group an agent can see on a tool.
  for (const g of ["NAV", "READ", "ACT"]) {
    if (!new RegExp(`^\\s*${g}:`, "m").test(src))
      throw new Error(`no ${g} group — the loop has a step with no tools behind it`);
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
    "browser_navigate",
    "browser_snapshot",
    "browser_get_content",
    "browser_get_property",
    "browser_find",
    "browser_click",
    "browser_type",
    "browser_evaluate",
    "browser_action",
    "browser_load_tools",
  ];
  // A count typed into the instructions is read by every agent at connect and is wrong the
  // first time a tool moves between profiles: it said 45 when there were 44. Interpolate it.
  const handCount = index.match(/\b\d+ (further capabilities|tools|actions)\b/);
  if (handCount) {
    throw new Error(
      `the server instructions state "${handCount[0]}" as a literal — derive it from the registry instead`
    );
  }

  const missing = entryPoints.filter((n) => !index.includes(n));
  if (missing.length) {
    throw new Error(
      `absent from the server instructions an agent reads at connect: ${missing.join(", ")} — an entry point not named there is reachable only by luck`
    );
  }
  return `${entryPoints.length} entry points routed`;
});

// -------------------------------------------- 8b. child test scripts are real files
gate("child test scripts parse on their own", () => {
  const dir = join(ROOT, "tests/unit/children");
  if (!existsSync(dir)) return "none yet";
  const files = execFileSync("sh", ["-c", `ls ${dir}/*.mjs 2>/dev/null || true`], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const f of files) {
    try {
      execFileSync("node", ["--check", f], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      throw new Error(
        `${f.split("/").pop()} does not parse — a fixture is a real source file, so this is a plain syntax error`
      );
    }
  }
  return `${files.length} checked`;
});

// --------------------------------------------------------------- 9. the shipped tarball
gate("npm tarball is clean", () => {
  // npm writes its file list to stderr, so capture both streams or the gate checks nothing.
  const out = execFileSync("sh", ["-c", "npm pack --dry-run 2>&1"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  for (const leak of ["calls.jsonl", "improvements/", "telemetry"]) {
    if (out.includes(leak)) throw new Error(`the tarball would ship ${leak}`);
  }
  // Working documents are not product. A "docs/" entry in package.json files once shipped
  // tool-surface-design-v2.md — 56 kB of implementation review, counter-review and owner
  // directives — to every npm consumer. Ship the three reader-facing docs by name instead.
  // Development scaffolding is not product. Nested package.json files shipped two stale versions
  // (0.5.1, 0.6.3) and a bin pointing outside their own directory, and a nested lockfile shipped
  // 41 kB for nobody — all dead on arrival, since npm reads the root package.json.
  const scaffolding = out
    .split("\n")
    .filter((l) => /^npm notice.*(package-lock\.json|(bridge|mcp|extension)\/package\.json)/.test(l));
  if (scaffolding.length) {
    throw new Error(
      `the tarball would ship development scaffolding: ${scaffolding.map((l) => l.trim().split(/\s+/).pop()).join(", ")}`
    );
  }
  const internalDoc =
    /^npm notice.*\b(?:[\w.-]*(?:design|review|plan|backlog|history|proposal|notes)[\w.-]*\.md)\b/im;
  const hit = out.split("\n").find((l) => internalDoc.test(l));
  if (hit) {
    throw new Error(`the tarball would ship an internal working document: ${hit.trim()}`);
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
    status = JSON.parse(
      execFileSync("sh", ["-c", "curl -s -m 3 http://127.0.0.1:8765/status"], { encoding: "utf8" })
    );
  } catch {}
  if (!status || !status.extensionConnected) {
    throw new Error(
      "bridge unreachable or extension not connected — start it (npm start) and load the extension; if you just reloaded the extension, give it a second"
    );
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
      return execFileSync("node", [file], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
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
        `${file}:` +
          (failures
            ? `\n      ${failures.replace(/\n/g, "\n      ")}`
            : " did not report a clean run")
      );
    }
    // Coverage of the CORE surface is asserted by its own gate, off the registry. The suite's
    // printed count is information about the whole protocol, which this suite no longer tries
    // to cover — see the note on that gate.
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
  console.log(
    `  ${failed} gate${failed > 1 ? "s" : ""} failed. Nothing is released until they are green.\n`
  );
  process.exit(1);
}
console.log(
  RUN_E2E
    ? "  All gates green. Ready to cut a release.\n"
    : "  Unit gates green. Run with --e2e before cutting a release.\n"
);
process.exit(0);
