// Options page: edit the bridge host/port and show live connection status.

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;

const hostEl = document.getElementById("host");
const portEl = document.getElementById("port");
const statusEl = document.getElementById("status");
const dotEl = document.getElementById("dot");
const connEl = document.getElementById("conn");
const connUrlEl = document.getElementById("connurl");

async function loadConfig() {
  const { bridgeHost = DEFAULT_HOST, bridgePort = DEFAULT_PORT } =
    await chrome.storage.local.get(["bridgeHost", "bridgePort"]);
  hostEl.value = bridgeHost;
  portEl.value = bridgePort;
}

async function save() {
  const bridgeHost = (hostEl.value || "").trim() || DEFAULT_HOST;
  const bridgePort = Number(portEl.value) || DEFAULT_PORT;
  if (bridgePort < 1 || bridgePort > 65535) {
    statusEl.textContent = "Port must be between 1 and 65535.";
    statusEl.className = "status err";
    return;
  }
  await chrome.storage.local.set({ bridgeHost, bridgePort });
  statusEl.textContent = `Saved. Reconnecting to ${bridgeHost}:${bridgePort}...`;
  statusEl.className = "status ok";
}

// Reflect pipeline health by asking the bridge whether the extension is connected.
async function refreshStatus() {
  const { bridgeHost = DEFAULT_HOST, bridgePort = DEFAULT_PORT } =
    await chrome.storage.local.get(["bridgeHost", "bridgePort"]);
  const base = `http://${bridgeHost}:${bridgePort}`;
  connUrlEl.textContent = `ws://${bridgeHost}:${bridgePort}/extension`;
  try {
    const res = await fetch(`${base}/status`, { cache: "no-store" });
    const data = await res.json();
    if (data.extensionConnected) {
      dotEl.className = "dot on";
      connEl.textContent = "Connected";
    } else {
      dotEl.className = "dot off";
      connEl.textContent = "Bridge up, extension reconnecting...";
    }
  } catch {
    dotEl.className = "dot off";
    connEl.textContent = "Bridge not reachable";
  }
}

document.getElementById("save").addEventListener("click", save);
loadConfig();
refreshStatus();
setInterval(refreshStatus, 1500);
