const dot = document.getElementById("dot");
const status = document.getElementById("status");
const btn = document.getElementById("toggle");

function set(state, text) {
  dot.className = "dot " + state;
  status.textContent = text;
}

function render(state) {
  const s = (state && state.connState) || "idle";
  if (s === "connected") {
    const alias = state.alias;
    const label = state.label;
    set("on", alias ? `Connected as ${alias}${label ? ` (${label})` : ""}` : "Connected");
    btn.textContent = "Disconnect";
    btn.dataset.act = "disconnect";
    btn.disabled = false;
  } else if (s === "connecting") {
    set("off", "Connecting...");
    btn.textContent = "Disconnect";
    btn.dataset.act = "disconnect";
    btn.disabled = false;
  } else {
    set("off", "Disconnected");
    btn.textContent = "Connect";
    btn.dataset.act = "connect";
    btn.disabled = false;
  }
}

// The alias and label the bridge knows this extension by come from /status, matched by the
// instanceId this extension stored for itself — the same lookup Options does.
async function myBrowserInfo(state) {
  if (!state || state.connState !== "connected") return {};
  try {
    const { instanceId } = await chrome.storage.local.get(["instanceId"]);
    const res = await fetch(`http://${state.host}:${state.port}/status`, { cache: "no-store" });
    const data = await res.json();
    const mine = (data.browsers || []).find((b) => b.instanceId === instanceId);
    return mine ? { alias: mine.alias, label: mine.label } : {};
  } catch {
    return {};
  }
}

async function refresh() {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ __bctl_getState: true }, async (state) => {
      void chrome.runtime?.lastError;
      if (!state) return;
      try {
        const info = await myBrowserInfo(state);
        render({ ...state, ...info });
      } catch {}
    });
  } catch {}
}

btn.addEventListener("click", async () => {
  const act = btn.dataset.act;
  btn.disabled = true;
  try {
    const msg = act === "disconnect" ? { __bctl_disconnect: true } : { __bctl_connect: true };
    chrome.runtime.sendMessage(msg, () => {
      void chrome.runtime?.lastError;
    });
  } catch {}
  setTimeout(refresh, 200);
});

document.getElementById("options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

refresh();
setInterval(refresh, 1000);
