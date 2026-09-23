// browser_stop against a stand-in bridge running as its own process: the stand-in reports its
// pid in /status the way bridge/server.js does, and the test checks that exactly that process
// ends. HOME points at a scratch directory, so the stopped state it records is not the user's.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "bctl-stop-"));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;

const standIn = spawn(
  process.execPath,
  [
    "-e",
    `const http = require("node:http");
     const s = http.createServer((q, r) => { r.writeHead(200, {"content-type": "application/json"}); r.end(JSON.stringify({ ok: true, pid: process.pid })); });
     s.listen(0, "127.0.0.1", () => console.log("PORT " + s.address().port));`,
  ],
  { stdio: ["ignore", "pipe", "inherit"] }
);
const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("stand-in bridge did not start")), 5000);
  standIn.on("exit", () => reject(new Error("stand-in bridge exited before listening")));
  standIn.stdout.on("data", (d) => {
    const m = String(d).match(/PORT (\d+)/);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
});
const exited = new Promise((r) => standIn.on("exit", () => r(true)));

process.env.BROWSERCTL_BRIDGE_URL = `http://127.0.0.1:${port}`;
process.env.BROWSERCTL_MCP_PROFILE = "core";
const { server } = await import(new URL("../../../mcp/index.js", import.meta.url).href);
const res = await server._registeredTools["browser_stop"].handler({});
const body = JSON.parse(res.content[0].text);
const gone = await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 3000))]);
if (!gone) standIn.kill();
rmSync(scratch, { recursive: true, force: true });

if (!gone) throw new Error("the bridge that reported its pid is still running");
if (!body.ok) throw new Error("browser_stop reported failure after the bridge exited: " + JSON.stringify(body));
console.log("STOP_BRIDGE_OK");
process.exit(0);
