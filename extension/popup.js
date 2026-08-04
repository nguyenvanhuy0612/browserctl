// Reflects pipeline health by asking the service worker for its connection
// state, and lets the user Connect / Disconnect on demand. No /status fetch:
// when the bridge is down, a fetch would itself log a console error.
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
    set("on", "Connected");
    btn.textContent = "Disconnect";
    btn.dataset.act = "disconnect";
    btn.disabled = false;
  } else if (s === "connecting") {
    // Retries with capped backoff until the bridge answers. Keep Disconnect
    // available so the user can stop the auto-retry loop while it's dialing.
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

async function refresh() {
  try {
    const state = await chrome.runtime.sendMessage({ __bctl_getState: true });
    render(state);
  } catch {
    // Service worker not reachable yet; leave the last rendered state.
  }
}

btn.addEventListener("click", async () => {
  const act = btn.dataset.act;
  btn.disabled = true;
  try {
    if (act === "disconnect") await chrome.runtime.sendMessage({ __bctl_disconnect: true });
    else await chrome.runtime.sendMessage({ __bctl_connect: true });
  } catch {}
  setTimeout(refresh, 200);
});

document.getElementById("options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

refresh();
setInterval(refresh, 1000);
