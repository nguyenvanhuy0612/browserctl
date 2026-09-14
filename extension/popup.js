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
  } catch {}
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
