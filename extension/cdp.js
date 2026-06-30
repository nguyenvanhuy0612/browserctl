// CDP module: console logs, network capture, HAR export, JS eval.
//
// These require attaching chrome.debugger to a tab (which shows the "is being
// debugged" infobar). Opt in with cdp_attach, then read with get_console_logs /
// get_network_requests / export_har. eval_js works with or without attach
// (attach bypasses page CSP via Runtime.evaluate).

import { redactHeaderList, truncate } from "./util.js";

const MAX_CONSOLE = 1000;
const MAX_NETWORK = 2000;

// tabId -> { console: [], network: Map(requestId -> entry) }
const sessions = new Map();

function attach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message)); else resolve();
    });
  });
}

function detach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach({ tabId }, () => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message)); else resolve();
    });
  });
}

function send(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message)); else resolve(res);
    });
  });
}

function requireSession(tabId) {
  const s = sessions.get(tabId);
  if (!s) throw new Error("not attached: call cdp_attach first");
  return s;
}

function remoteToString(o) {
  if (!o) return "";
  if (o.value !== undefined) return typeof o.value === "object" ? JSON.stringify(o.value) : String(o.value);
  if (o.description) return o.description;
  return o.type || "";
}

// Buffer CDP events per attached tab.
chrome.debugger.onEvent.addListener((source, method, params) => {
  const s = sessions.get(source.tabId);
  if (!s) return;

  switch (method) {
    case "Runtime.consoleAPICalled":
      pushConsole(s, {
        type: params.type,
        text: (params.args || []).map(remoteToString).join(" "),
        ts: params.timestamp,
      });
      break;
    case "Runtime.exceptionThrown": {
      const d = params.exceptionDetails || {};
      pushConsole(s, {
        type: "error",
        text: d.exception ? d.exception.description || d.text : d.text,
        ts: params.timestamp,
      });
      break;
    }
    case "Log.entryAdded":
      pushConsole(s, {
        type: params.entry.level,
        text: params.entry.text,
        source: params.entry.source,
        url: params.entry.url,
        ts: params.entry.timestamp,
      });
      break;

    case "Network.requestWillBeSent":
      if (s.network.size < MAX_NETWORK) {
        s.network.set(params.requestId, {
          requestId: params.requestId,
          request: params.request,
          resourceType: params.type,
          wallTime: params.wallTime,
          startTs: params.timestamp,
        });
      }
      break;
    case "Network.responseReceived": {
      const e = s.network.get(params.requestId);
      if (e) { e.response = params.response; e.resourceType = params.type; }
      break;
    }
    case "Network.loadingFinished": {
      const e = s.network.get(params.requestId);
      if (e) { e.endTs = params.timestamp; e.encodedDataLength = params.encodedDataLength; }
      break;
    }
    case "Network.loadingFailed": {
      const e = s.network.get(params.requestId);
      if (e) { e.failed = params.errorText; e.endTs = params.timestamp; }
      break;
    }
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) sessions.delete(source.tabId);
});

function pushConsole(s, entry) {
  s.console.push(entry);
  if (s.console.length > MAX_CONSOLE) s.console.shift();
}

async function runtimeEval(tabId, expression) {
  const res = await send(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || "eval error");
  return { value: res.result.value, type: res.result.type };
}

function toHeaders(h) {
  return Object.entries(h || {}).map(([name, value]) => ({ name, value: String(value) }));
}

function buildHar(entries, bodies) {
  const harEntries = entries
    .filter((e) => e.request)
    .map((e) => {
      const time = e.endTs && e.startTs ? Math.max(0, (e.endTs - e.startTs) * 1000) : 0;
      const resp = e.response || {};
      const content = { size: e.encodedDataLength || 0, mimeType: resp.mimeType || "" };
      const body = bodies && bodies.get(e.requestId);
      if (body) {
        content.text = body.text;
        if (body.base64Encoded) content.encoding = "base64";
      }
      return {
        startedDateTime: new Date((e.wallTime || 0) * 1000).toISOString(),
        time,
        request: {
          method: e.request.method,
          url: e.request.url,
          httpVersion: resp.protocol || "HTTP/1.1",
          headers: redactHeaderList(toHeaders(e.request.headers)),
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: e.request.postData ? e.request.postData.length : 0,
        },
        response: {
          status: resp.status || (e.failed ? 0 : 0),
          statusText: resp.statusText || (e.failed || ""),
          httpVersion: resp.protocol || "HTTP/1.1",
          headers: redactHeaderList(toHeaders(resp.headers)),
          cookies: [],
          content,
          redirectURL: "",
          headersSize: -1,
          bodySize: e.encodedDataLength || 0,
        },
        cache: {},
        timings: { send: 0, wait: time, receive: 0 },
        _resourceType: e.resourceType,
        _error: e.failed,
      };
    });
  return {
    log: {
      version: "1.2",
      creator: { name: "ai-browser-control", version: "0.1.0" },
      entries: harEntries,
    },
  };
}

// Build a compact list of meaningful accessibility nodes from a full AX tree.
function collectAxNodes(axNodes, max) {
  const skip = new Set(["none", "GenericContainer", "InlineTextBox", "ignored"]);
  const out = [];
  for (const node of axNodes || []) {
    const role = node.role && node.role.value;
    if (!role || skip.has(role)) continue;
    const name = (node.name && node.name.value) || "";
    const value = node.value && node.value.value;
    if (!name && (value === undefined || value === "")) continue;
    out.push({ role, name, value });
    if (out.length >= max) break;
  }
  return out;
}

function briefRequest(e) {
  return {
    method: e.request.method,
    url: e.request.url,
    resourceType: e.resourceType,
    status: e.response ? e.response.status : null,
    mimeType: e.response ? e.response.mimeType : null,
    size: e.encodedDataLength || null,
    failed: e.failed || null,
  };
}

// Dispatch a CDP-related action. `tabId` is the resolved active tab.
export async function handleCdp(action, params, tabId) {
  switch (action) {
    case "cdp_attach": {
      if (!sessions.has(tabId)) {
        await attach(tabId);
        sessions.set(tabId, { console: [], network: new Map() });
        await send(tabId, "Network.enable");
        await send(tabId, "Runtime.enable");
        await send(tabId, "Log.enable");
        await send(tabId, "Page.enable");
      }
      return { ok: true, result: { attached: true, tabId } };
    }

    case "cdp_detach": {
      if (sessions.has(tabId)) {
        try { await detach(tabId); } catch {}
        sessions.delete(tabId);
      }
      return { ok: true, result: { attached: false, tabId } };
    }

    case "get_console_logs": {
      const s = requireSession(tabId);
      const limit = params.limit || 200;
      const logs = s.console.slice(-limit);
      if (params.clear) s.console.length = 0;
      return { ok: true, result: { count: logs.length, logs } };
    }

    case "get_network_requests": {
      const s = requireSession(tabId);
      const all = [...s.network.values()];
      const filtered = params.urlContains
        ? all.filter((e) => e.request.url.includes(params.urlContains))
        : all;
      return {
        ok: true,
        result: { count: filtered.length, requests: filtered.map(briefRequest) },
      };
    }

    case "export_har": {
      const s = requireSession(tabId);
      const entries = [...s.network.values()];
      if (!params.bodies) {
        return { ok: true, result: buildHar(entries) };
      }
      // Best-effort: gather response bodies before building the HAR. One failed
      // body (e.g. evicted) must not abort the export, so each is try/caught.
      const bodies = new Map();
      await Promise.all(
        entries
          .filter((e) => e.response && e.requestId)
          .map(async (e) => {
            try {
              const res = await send(tabId, "Network.getResponseBody", { requestId: e.requestId });
              bodies.set(e.requestId, { text: res.body, base64Encoded: res.base64Encoded });
            } catch {}
          })
      );
      return { ok: true, result: buildHar(entries, bodies) };
    }

    case "get_response_body": {
      requireSession(tabId);
      if (!params.requestId) throw new Error("get_response_body requires 'requestId'");
      let res;
      try {
        res = await send(tabId, "Network.getResponseBody", { requestId: params.requestId });
      } catch {
        throw new Error(
          "response body unavailable for " + params.requestId +
          " (it may have been evicted; capture is best-effort)"
        );
      }
      return {
        ok: true,
        result: {
          requestId: params.requestId,
          base64Encoded: res.base64Encoded,
          body: res.base64Encoded ? res.body : truncate(res.body, 50000),
        },
      };
    }

    case "capture_screenshot": {
      // Full-page screenshot via CDP (captures beyond the viewport). Requires attach.
      requireSession(tabId);
      const format = params.format === "jpeg" ? "jpeg" : "png";
      const res = await send(tabId, "Page.captureScreenshot", {
        format,
        captureBeyondViewport: params.fullPage !== false,
        fromSurface: true,
      });
      return { ok: true, result: { dataUrl: `data:image/${format};base64,${res.data}` } };
    }

    case "eval_js": {
      if (!params.expression) throw new Error("eval_js requires 'expression'");
      if (sessions.has(tabId)) {
        return { ok: true, result: await runtimeEval(tabId, params.expression) };
      }
      // Fallback without attach: run in the page's MAIN world (subject to page CSP).
      const [out] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (expr) => {
          try { return { ok: true, value: JSON.parse(JSON.stringify(eval(expr))) }; }
          catch (err) { return { ok: false, error: String(err) }; }
        },
        args: [params.expression],
      });
      if (!out.result.ok) {
        throw new Error(out.result.error + " (tip: cdp_attach first to bypass page CSP)");
      }
      return { ok: true, result: { value: out.result.value } };
    }

    case "coordinate_click": {
      requireSession(tabId);
      const { x, y } = params;
      const button = params.button || "left";
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button, clickCount: 1,
      });
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x, y, button, clickCount: 1,
      });
      return { ok: true, result: { clicked: { x, y } } };
    }

    case "coordinate_drag": {
      requireSession(tabId);
      const { fromX, fromY, toX, toY } = params;
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed", x: fromX, y: fromY, button: "left", clickCount: 1,
      });
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: toX, y: toY, button: "left",
      });
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: toX, y: toY, button: "left", clickCount: 1,
      });
      return { ok: true, result: { dragged: true } };
    }

    case "a11y_snapshot": {
      requireSession(tabId);
      const max = params.max || 200;
      try { await send(tabId, "Accessibility.enable"); } catch {}
      const { nodes: axNodes } = await send(tabId, "Accessibility.getFullAXTree");
      const nodes = collectAxNodes(axNodes, max);
      return { ok: true, result: { count: nodes.length, nodes } };
    }

    case "element_screenshot": {
      requireSession(tabId);
      const index = params.index;
      const format = params.format || "png";
      const rect = await send(tabId, "Runtime.evaluate", {
        expression: `(()=>{const e=document.querySelector('[data-aibc-ref="${index}"]');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,dpr:window.devicePixelRatio}})()`,
        returnByValue: true,
      });
      const r = rect.result && rect.result.value;
      if (!r) throw new Error(`no element at index ${index} (snapshot first)`);
      const res = await send(tabId, "Page.captureScreenshot", {
        format,
        clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 },
        fromSurface: true,
        captureBeyondViewport: true,
      });
      return { ok: true, result: { dataUrl: `data:image/${format};base64,${res.data}` } };
    }

    case "print_pdf": {
      // printToPDF is normally headless-only, but Edge/Chrome support it via CDP
      // for the active page. If it errors, the send() rejection propagates.
      requireSession(tabId);
      const res = await send(tabId, "Page.printToPDF", { printBackground: true });
      return { ok: true, result: { base64: res.data } };
    }

    case "audit": {
      requireSession(tabId);
      try { await send(tabId, "Performance.enable"); } catch {}
      const { metrics } = await send(tabId, "Performance.getMetrics");
      const metricMap = {};
      for (const m of metrics || []) metricMap[m.name] = m.value;
      const wanted = [
        "Documents", "Nodes", "JSHeapUsedSize", "LayoutCount",
        "RecalcStyleCount", "ScriptDuration", "TaskDuration",
      ];
      const performance = {};
      for (const name of wanted) {
        if (metricMap[name] !== undefined) performance[name] = metricMap[name];
      }

      // Best-effort accessibility audit: count interactive nodes missing a name.
      let interactiveMissingName = 0;
      let totalAxNodes = 0;
      try {
        try { await send(tabId, "Accessibility.enable"); } catch {}
        const { nodes: axNodes } = await send(tabId, "Accessibility.getFullAXTree");
        const interactiveRoles = new Set([
          "button", "link", "textbox", "checkbox", "radio", "combobox",
          "listbox", "menuitem", "switch", "slider", "tab",
        ]);
        for (const node of axNodes || []) {
          const role = node.role && node.role.value;
          if (!role) continue;
          totalAxNodes++;
          const name = (node.name && node.name.value) || "";
          if (interactiveRoles.has(role) && !name) interactiveMissingName++;
        }
      } catch {}

      return {
        ok: true,
        result: {
          performance,
          accessibility: { interactiveMissingName, totalAxNodes },
        },
      };
    }

    case "get_cookies": {
      requireSession(tabId);
      try { await send(tabId, "Network.enable"); } catch {}
      const { cookies: all } = await send(tabId, "Network.getAllCookies");
      const filtered = params.urlContains
        ? (all || []).filter((c) => String(c.domain || "").includes(params.urlContains))
        : (all || []);
      const cookies = filtered.map((c) => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        value: c.value,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expires: c.expires,
      }));
      return { ok: true, result: { count: cookies.length, cookies } };
    }

    case "set_cookie": {
      requireSession(tabId);
      try { await send(tabId, "Network.enable"); } catch {}
      if (!params.url && !params.domain) {
        throw new Error("set_cookie requires 'url' or 'domain'");
      }
      const cookie = { name: params.name, value: params.value };
      if (params.url) cookie.url = params.url;
      if (params.domain) cookie.domain = params.domain;
      if (params.path) cookie.path = params.path;
      if (params.secure !== undefined) cookie.secure = params.secure;
      if (params.httpOnly !== undefined) cookie.httpOnly = params.httpOnly;
      if (params.expires !== undefined) cookie.expires = params.expires;
      await send(tabId, "Network.setCookie", cookie);
      return { ok: true, result: { set: params.name } };
    }

    case "delete_cookies": {
      requireSession(tabId);
      try { await send(tabId, "Network.enable"); } catch {}
      await send(tabId, "Network.deleteCookies", { name: params.name, url: params.url });
      return { ok: true, result: { deleted: params.name } };
    }

    default:
      throw new Error(`unknown cdp action: ${action}`);
  }
}

export const CDP_ACTIONS = [
  "cdp_attach",
  "cdp_detach",
  "get_console_logs",
  "get_network_requests",
  "get_response_body",
  "export_har",
  "capture_screenshot",
  "eval_js",
  "coordinate_click",
  "coordinate_drag",
  "a11y_snapshot",
  "element_screenshot",
  "print_pdf",
  "audit",
  "get_cookies",
  "set_cookie",
  "delete_cookies",
];
