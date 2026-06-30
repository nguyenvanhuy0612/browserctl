// Reflects pipeline health by asking the bridge whether the extension is connected.
const dot = document.getElementById("dot");
const status = document.getElementById("status");

function set(state, text) {
  dot.className = "dot " + state;
  status.textContent = text;
}

async function refresh() {
  const { bridgeHost = "127.0.0.1", bridgePort = 8765 } =
    await chrome.storage.local.get(["bridgeHost", "bridgePort"]);
  try {
    const res = await fetch(`http://${bridgeHost}:${bridgePort}/status`, { cache: "no-store" });
    const data = await res.json();
    if (data.extensionConnected) set("on", "Connected");
    else set("off", "Bridge up, extension reconnecting...");
  } catch {
    set("off", "Bridge not running");
  }
}

document.getElementById("options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

refresh();
setInterval(refresh, 1500);
