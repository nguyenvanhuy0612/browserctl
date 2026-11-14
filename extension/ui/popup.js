// @ts-check
// Toolbar popup: connection, alias, user scripts, debugger attachments (specs/extension-ui.md).
// Every call is caught; nothing is logged (an extension error would land on chrome://extensions).

/** @param {string} id */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @param {string} id @param {string} text @param {string} [tone] */
function set(id, text, tone = "") {
  const node = el(id);
  node.textContent = text;
  node.className = tone;
}

/** @param {object} message */
async function ask(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return null;
  }
}

let portEdited = false;

/** @param {any} s */
function render(s) {
  if (!s || s.error) {
    set("connection", "Unknown", "warn");
    return;
  }
  const connected = s.phase === "connected";
  set("connection", connected ? "Connected" : s.phase === "down" ? "Daemon not running" : "Connecting…", connected ? "ok" : s.phase === "down" ? "bad" : "warn");
  el("connection-note").textContent =
    s.phase === "down" ? `Nothing answers on 127.0.0.1:${s.port}. Start an agent that uses browserctl, or run: browserctl daemon start` : "";
  set("alias", s.alias ?? "—");
  set("daemon", connected ? `${s.daemonVersion ?? "?"} · 127.0.0.1:${s.port}` : `127.0.0.1:${s.port}`);
  set("userscripts", s.userScripts ? "On" : "Off", s.userScripts ? "ok" : "warn");
  el("userscripts-note").textContent = s.userScripts ? "" : "Turn on Allow User Scripts in this extension's Details so evaluate works without the debugging bar.";
  set("debugger", s.attachedTabs ? `Attached to ${s.attachedTabs} tab${s.attachedTabs > 1 ? "s" : ""}` : "Not attached", s.attachedTabs ? "warn" : "ok");
  el("debugger-note").textContent = s.attachedTabs ? "This is what shows Chrome's debugging bar; it detaches when idle." : "";
  set("version", s.extensionVersion ?? "—");
  const port = /** @type {HTMLInputElement} */ (el("port"));
  if (!portEdited) port.value = String(s.port);
}

async function refresh() {
  render(await ask({ type: "bctl.status" }));
}

el("reconnect").addEventListener("click", async () => render(await ask({ type: "bctl.reconnect" })));
el("port").addEventListener("input", () => (portEdited = true));
el("save").addEventListener("click", async () => {
  const value = Number(/** @type {HTMLInputElement} */ (el("port")).value);
  if (!Number.isInteger(value) || value < 1 || value > 65535) return;
  portEdited = false;
  render(await ask({ type: "bctl.setPort", port: value }));
});

refresh();
setInterval(refresh, 1000);
