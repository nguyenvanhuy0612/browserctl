const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;

const hostEl = document.getElementById("host");
const portEl = document.getElementById("port");
const labelEl = document.getElementById("label");
const statusEl = document.getElementById("status");
const dotEl = document.getElementById("dot");
const connEl = document.getElementById("conn");
const connUrlEl = document.getElementById("connurl");

async function loadConfig() {
  const {
    bridgeHost = DEFAULT_HOST,
    bridgePort = DEFAULT_PORT,
    label = "",
  } = await chrome.storage.local.get(["bridgeHost", "bridgePort", "label"]);
  hostEl.value = bridgeHost;
  portEl.value = bridgePort;
  labelEl.value = label;
}

async function save() {
  const bridgeHost = (hostEl.value || "").trim() || DEFAULT_HOST;
  const bridgePort = Number(portEl.value) || DEFAULT_PORT;
  const label = (labelEl.value || "").trim().slice(0, 40);
  if (bridgePort < 1 || bridgePort > 65535) {
    statusEl.textContent = "Port must be between 1 and 65535.";
    statusEl.className = "status err";
    return;
  }
  await chrome.storage.local.set({ bridgeHost, bridgePort, label });
  statusEl.textContent = `Saved. Reconnecting to ${bridgeHost}:${bridgePort}...`;
  statusEl.className = "status ok";
}

async function refreshStatus() {
  const {
    bridgeHost = DEFAULT_HOST,
    bridgePort = DEFAULT_PORT,
    instanceId,
  } = await chrome.storage.local.get(["bridgeHost", "bridgePort", "instanceId"]);
  const base = `http://${bridgeHost}:${bridgePort}`;
  connUrlEl.textContent = `ws://${bridgeHost}:${bridgePort}/extension`;
  try {
    const res = await fetch(`${base}/status`, { cache: "no-store" });
    const data = await res.json();
    const mine = (data.browsers || []).find((b) => b.instanceId === instanceId);
    if (mine) {
      dotEl.className = "dot on";
      connEl.textContent = `Connected as ${mine.alias}${mine.label ? ` (${mine.label})` : ""}`;
    } else if (data.extensionConnected) {
      dotEl.className = "dot off";
      connEl.textContent = "Bridge up, this instance is reconnecting...";
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
