#!/usr/bin/env node
// @ts-check
// Spec-ID gate (specs/README.md rule 5): every test ID named in a spec's Tests table has a test
// whose title starts with it (test(), it() or a site check()), every test title starts with an ID,
// and every such ID is named in a spec. Rows of kind `manual` are listed, not required.
// Usage: node scripts/spec-ids.js [--json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Own IDs (CLICK-U01) and adopted Playwright IDs (CL-001). */
const ID = /\b(?:[A-Z]{2,5}-[USE]\d{2}|[A-Z]{2}-\d{3})\b/g;
/** A range of adopted IDs: CL-007..CL-012 or CL-007..012. */
const RANGE = /\b([A-Z]{2})-(\d{3})\.\.(?:[A-Z]{2}-)?(\d{3})\b/g;

/** @param {string} dir @returns {string[]} */
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? files(full) : [full];
  });
}

/** @param {string} cell @returns {string[]} */
export function idsIn(cell) {
  const expanded = cell.replace(RANGE, (_, prefix, from, to) => {
    const ids = [];
    for (let n = Number(from); n <= Number(to); n++) ids.push(`${prefix}-${String(n).padStart(3, "0")}`);
    return ids.join(" ");
  });
  return expanded.match(ID) ?? [];
}

/** IDs named in the first column of each spec's Tests table. @returns {{ids: Map<string, string>, manual: Map<string, string>}} id -> spec file */
export function specIds() {
  /** @type {Map<string, string>} */
  const ids = new Map();
  /** @type {Map<string, string>} */
  const manual = new Map();
  for (const file of files(path.join(root, "specs")).filter((f) => f.endsWith(".md"))) {
    const text = fs.readFileSync(file, "utf8");
    const tests = /^## Tests\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1] ?? "";
    for (const line of tests.split("\n")) {
      if (!line.startsWith("| ") || line.startsWith("| ID ") || line.startsWith("| ---")) continue;
      const [, first, kind] = line.split("|");
      for (const id of idsIn(first)) (kind.trim() === "manual" ? manual : ids).set(id, path.relative(root, file));
    }
  }
  return { ids, manual };
}

/** IDs at the start of test titles (`test("CL-001 / CL-004 ...")`). @returns {{ids: Map<string, string>, unnamed: string[]}} */
export function testIds() {
  /** @type {Map<string, string>} */
  const ids = new Map();
  /** @type {string[]} */
  const unnamed = [];
  const testTitle = /\b(?:test|it)\(\s*["'`]([^"'`]+)/g;
  const siteCheck = /\bcheck\(\s*["'`]([^"'`]+)/g;
  for (const file of files(path.join(root, "tests")).filter((f) => f.endsWith(".js"))) {
    const text = fs.readFileSync(file, "utf8");
    const site = path.relative(root, file).startsWith(`tests${path.sep}site`);
    for (const [, name] of text.matchAll(site ? siteCheck : testTitle)) {
      const head = /^((?:[A-Z][A-Z0-9-]*\d(?:\.\.(?:[A-Z]{2}-)?\d{3})?(?:\s*[/,]\s*)?)+)/.exec(name)?.[1] ?? "";
      const found = idsIn(head);
      if (!found.length) unnamed.push(`${path.relative(root, file)}: ${name}`);
      for (const id of found) ids.set(id, path.relative(root, file));
    }
  }
  return { ids, unnamed };
}

export function check() {
  const { ids: specs, manual } = specIds();
  const { ids: tests, unnamed } = testIds();
  const untested = [...specs].filter(([id]) => !tests.has(id)).map(([id, spec]) => ({ id, spec }));
  const unspecified = [...tests].filter(([id]) => !specs.has(id) && !manual.has(id)).map(([id, test]) => ({ id, test }));
  return { specs: specs.size, tests: tests.size, untested, unspecified, unnamed, manual: [...manual].map(([id, spec]) => ({ id, spec })) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = check();
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 1));
  else {
    for (const { id, spec } of result.untested) console.log(`untested     ${id}  (${spec})`);
    for (const { id, test } of result.unspecified) console.log(`unspecified  ${id}  (${test})`);
    for (const name of result.unnamed) console.log(`no ID        ${name}`);
    for (const { id, spec } of result.manual) console.log(`manual       ${id}  (${spec})`);
    console.log(`${result.specs} spec IDs, ${result.tests} test IDs, ${result.untested.length} untested, ${result.unspecified.length} unspecified, ${result.unnamed.length} without an ID, ${result.manual.length} manual`);
  }
  process.exitCode = result.untested.length || result.unspecified.length || result.unnamed.length ? 1 : 0;
}
