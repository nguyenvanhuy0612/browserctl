// The MCP session target across several browsers, one use case per process: each case starts a
// real bridge, fake extensions, and one or two real MCP server processes. The cases themselves
// live in children/browsers-mcp.mjs.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import util from "node:util";

const run = util.promisify(execFile);
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "children", "browsers-mcp.mjs");
const homes = [];

after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const CASES = [
  "uc-edge",
  "uc-fb-one-profile",
  "uc-fb-two-profiles",
  "uc-no-browser-single",
  "uc-no-browser-focus",
  "uc-no-browser-no-focus",
  "uc-sticky-target",
  "uc-ambiguous-type",
  "uc-new-tab-in-edge",
  "uc-two-sessions-two-browsers",
  "uc-two-sessions-one-browser",
  "uc-other-session-switch",
  "uc-per-call-tab",
  "uc-subagent-tabid",
  "uc-unknown-tabid-lookup",
  "uc-tab-id-collision",
  "uc-target-closed",
  "uc-browser-gone",
  "uc-sw-restart",
  "uc-activate",
  "uc-browser-action",
  "uc-100-profiles",
  "uc-hung-browser",
  "uc-legacy-plus-new",
  "uc-group-tab-by-id",
  "uc-group-tab-default",
  "uc-raw-tab-actions",
  "uc-select-during-resolution",
  "uc-per-call-ambiguous",
  "uc-per-call-not-found",
  "uc-target-closed-then-new",
  "uc-browser-reconnects-and-resumes",
  "uc-new-session-after-other-select",
  "uc-first-call-one-agent-entry",
];

describe("session target across browsers", { concurrency: 6 }, () => {
  for (const name of CASES) {
    test(name, async () => {
      const home = mkdtempSync(join(tmpdir(), "browserctl-browsers-"));
      homes.push(home);
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      for (const k of ["BROWSERCTL_BRIDGE_URL", "BRIDGE_URL", "PORT", "BROWSERCTL_CALL_LOG"]) {
        delete env[k];
      }
      let stdout;
      try {
        ({ stdout } = await run(process.execPath, [FIXTURE, name], { env, timeout: 60_000 }));
      } catch (err) {
        throw new Error(`${name} failed:\n${err.stderr || err.message}`);
      }
      assert.ok(stdout.includes(`OK ${name}`), stdout);
    });
  }
});
