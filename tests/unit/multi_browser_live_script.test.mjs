// tests/e2e/multi_browser_live.mjs's own pass/fail logic, against a real bridge and fake
// extensions rather than the owner's real browsers. The cases live in
// children/multi-browser-live.mjs, one process per case (each needs its own bridge and its own
// call-log file).
import { describe, test, after } from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import util from "node:util";

const run = util.promisify(execFile);
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "children", "multi-browser-live.mjs");
const homes = [];

after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const CASES = [
  "case-pass",
  "case-fail-probe-not-opened",
  "case-close-tab-fails",
  "case-one-browser-skips",
];

describe("multi_browser_live.mjs pass/fail logic", { concurrency: 3 }, () => {
  for (const name of CASES) {
    test(name, async () => {
      const home = mkdtempSync(join(tmpdir(), "browserctl-live-"));
      homes.push(home);
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      for (const k of ["BROWSERCTL_BRIDGE_URL", "BRIDGE_URL", "PORT", "BROWSERCTL_CALL_LOG"]) {
        delete env[k];
      }
      const { stdout } = await run(process.execPath, [FIXTURE, name], {
        env,
        timeout: 30000,
      });
      if (!stdout.includes(`OK ${name}`)) {
        throw new Error(`fixture did not report success:\n${stdout}`);
      }
    });
  }
});
