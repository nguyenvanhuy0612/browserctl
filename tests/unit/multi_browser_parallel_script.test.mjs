// tests/e2e/multi_browser_parallel.mjs: its call-log and overlap analysis directly, and the
// whole script against a real bridge and fake extensions rather than the owner's real browsers.
// The script cases live in children/multi-browser-parallel.mjs, one process per case (each needs
// its own bridge and its own call-log file).
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import util from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const run = util.promisify(execFile);
const FIXTURE = join(HERE, "children", "multi-browser-parallel.mjs");
const SCRIPT = join(HERE, "..", "e2e", "multi_browser_parallel.mjs");
const homes = [];

after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const line = (session, browser, action, tabId, extra = {}) => ({
  session,
  source: "mcp",
  browser,
  action,
  tabId,
  seq: 1,
  ...extra,
});
const RUNS = [
  { alias: "chrome-1", tabId: 11 },
  { alias: "edge-1", tabId: 22 },
];

test("call log: each session on its own browser and tab is clean; fanned-out list_tabs is allowed", async () => {
  const { checkCallLog } = await import(SCRIPT);
  const entries = [
    line("aaaa", "chrome-1", "new_tab", null),
    line("aaaa", "chrome-1", "list_tabs", null),
    line("aaaa", "edge-1", "list_tabs", null),
    line("aaaa", "chrome-1", "click", 11),
    line("aaaa", "chrome-1", "close_tab", null, { params: { id: 11 } }),
    line("bbbb", "edge-1", "click", 22),
    line("bbbb", "chrome-1", "list_tabs", null, { internal: true }),
    line("zzzz", "chrome-1", "click", 99),
    {
      session: "parallel-gate",
      source: "e2e",
      browser: "chrome-1",
      action: "close_tab",
      tabId: null,
      params: { id: 11 },
    },
  ];
  const { problems, lines } = checkCallLog(entries, RUNS);
  assert.deepEqual(problems, []);
  assert.deepEqual({ ...lines }, { "chrome-1": 5, "edge-1": 2 });
});

test("call log: a session line sent to another browser is a problem", async () => {
  const { checkCallLog } = await import(SCRIPT);
  const entries = [
    line("aaaa", "chrome-1", "click", 11),
    line("aaaa", "edge-1", "snapshot", 11),
    line("bbbb", "edge-1", "click", 22),
  ];
  const { problems } = checkCallLog(entries, RUNS);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /chrome-1: session aaaa sent snapshot .* to edge-1/);
});

test("call log: a session line on another tab id is a problem", async () => {
  const { checkCallLog } = await import(SCRIPT);
  const entries = [
    line("aaaa", "chrome-1", "click", 11),
    line("aaaa", "chrome-1", "click", 33),
    line("bbbb", "edge-1", "click", 22),
  ];
  const { problems } = checkCallLog(entries, RUNS);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /to tab 33, not its own tab 11/);
});

test("call log: a tab named by two sessions, or by none, is a problem", async () => {
  const { checkCallLog } = await import(SCRIPT);
  const twice = checkCallLog(
    [
      line("aaaa", "chrome-1", "click", 11),
      line("cccc", "chrome-1", "click", 11),
      line("bbbb", "edge-1", "click", 22),
    ],
    RUNS
  );
  assert.match(twice.problems.join(";"), /tab 11 is named by 2 MCP sessions/);
  const none = checkCallLog([line("aaaa", "chrome-1", "click", 11)], RUNS);
  assert.match(none.problems.join(";"), /tab 22 is named by 0 MCP sessions/);
});

test("overlap: the shared share of the combined span", async () => {
  const { overlapRatio } = await import(SCRIPT);
  assert.equal(
    overlapRatio([
      { start: 0, end: 100 },
      { start: 0, end: 100 },
    ]),
    1
  );
  assert.equal(
    overlapRatio([
      { start: 0, end: 100 },
      { start: 0, end: 40 },
    ]),
    0.4
  );
  assert.equal(
    overlapRatio([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]),
    0
  );
});

const CASES = [
  "case-pass",
  "case-readback-fails",
  "case-capture-fails",
  "case-close-fails",
  "case-one-browser-skips",
];

describe("multi_browser_parallel.mjs against fake extensions", { concurrency: 3 }, () => {
  for (const name of CASES) {
    test(name, async () => {
      const home = mkdtempSync(join(tmpdir(), "browserctl-parallel-"));
      homes.push(home);
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      for (const k of ["BROWSERCTL_BRIDGE_URL", "BRIDGE_URL", "PORT", "BROWSERCTL_CALL_LOG"])
        delete env[k];
      const { stdout } = await run(process.execPath, [FIXTURE, name], { env, timeout: 90000 });
      if (!stdout.includes(`OK ${name}`))
        throw new Error(`fixture did not report success:\n${stdout}`);
    });
  }
});
