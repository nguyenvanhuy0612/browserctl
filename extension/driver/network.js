// Network Controller and Interceptor for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/02-driver-and-cdp.md.

import { sendCdpCommand } from "./session.js";

/**
 * Traverses an object using RFC 6901 JSON pointer syntax.
 *
 * @param {object} obj - Target object.
 * @param {string} pointer - RFC 6901 pointer (e.g. "/data/users/0/name").
 * @returns {*} Resolved value or undefined.
 */
export function resolveJsonPointer(obj, pointer) {
  if (!pointer || pointer === "" || pointer === "/") return obj;
  if (!pointer.startsWith("/")) {
    throw new Error(`JSON pointer must start with '/' (got: ${pointer})`);
  }
  const parts = pointer
    .slice(1)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (Number.isNaN(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else {
      cur = cur[part];
    }
  }
  return cur;
}

/**
 * Checks if a URL matches a wildcard pattern.
 * @param {string} url
 * @param {string} pattern
 * @returns {boolean}
 */
export function urlMatchesPattern(url, pattern) {
  if (!pattern || pattern === "*") return true;
  if (!pattern.includes("*")) return url.includes(pattern);
  const regex = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$"
  );
  return regex.test(url);
}

let ruleCounter = 0;

/**
 * Factory for creating a declarative network intercept rule.
 * @param {object} options
 * @param {object} options.match - { url, method? }
 * @param {object} options.effect - { type: "mock"|"block", status?, headers?, body? }
 * @returns {{ id: string, match: object, effect: object }}
 */
export function createNetworkRule({ match, effect } = {}) {
  return {
    id: "rule_" + ++ruleCounter,
    match,
    effect,
  };
}

/**
 * Adds a declarative fetch intercept rule.
 *
 * @param {number} tabId
 * @param {object} session
 * @param {object} match - { url, method? }
 * @param {object} effect - { type: "mock"|"block", status?, headers?, body? }
 * @returns {Promise<{ ruleId: string, rulesCount: number }>}
 */
export async function addFetchRule(tabId, session, match, effect) {
  if (!match || !effect) {
    throw new Error(
      "addFetchRule requires 'match' ({ url, method? }) and 'effect' ({ type: 'mock'|'block', ... })"
    );
  }
  const rule = {
    id: "rule_" + ++ruleCounter,
    match,
    effect,
  };
  if (!session.fetchRules || session.fetchRules.length === 0) {
    await sendCdpCommand(tabId, "Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    session.fetchRules = [];
  }
  session.fetchRules.push(rule);
  return { ruleId: rule.id, rulesCount: session.fetchRules.length };
}

/**
 * Removes a declarative fetch intercept rule by ID.
 *
 * @param {number} tabId
 * @param {object} session
 * @param {string} ruleId
 * @returns {Promise<{ removed: string, remaining: number }>}
 */
export async function removeFetchRule(tabId, session, ruleId) {
  if (!ruleId) throw new Error("removeFetchRule requires 'ruleId'");
  session.fetchRules = (session.fetchRules || []).filter((r) => r.id !== ruleId);
  if (session.fetchRules.length === 0) {
    try {
      await sendCdpCommand(tabId, "Fetch.disable");
    } catch {}
  }
  return { removed: ruleId, remaining: session.fetchRules.length };
}

/**
 * Clears all fetch intercept rules for a session.
 *
 * @param {number} tabId
 * @param {object} session
 * @returns {Promise<{ cleared: boolean }>}
 */
export async function clearFetchRules(tabId, session) {
  session.fetchRules = [];
  try {
    await sendCdpCommand(tabId, "Fetch.disable");
  } catch {}
  return { cleared: true };
}

/**
 * Retrieves the response body for a network request, optionally querying a JSON pointer.
 *
 * @param {number} tabId
 * @param {string} requestId
 * @param {string} [pointer]
 * @returns {Promise<any>}
 */
export async function getResponseBody(tabId, requestId, pointer) {
  if (!requestId) throw new Error("get_response_body requires 'requestId'");
  let res;
  try {
    res = await sendCdpCommand(tabId, "Network.getResponseBody", { requestId });
  } catch (err) {
    throw new Error(`response body unavailable for ${requestId}: ${err.message}`);
  }

  if (pointer) {
    if (res.base64Encoded) {
      throw new Error("cannot query JSON pointer on base64-encoded response");
    }
    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new Error("response body is not valid JSON; cannot query pointer");
    }
    const val = resolveJsonPointer(parsed, pointer);
    return {
      requestId,
      pointer,
      value: val,
      found: val !== undefined,
    };
  }

  return {
    requestId,
    body: res.body,
    base64Encoded: res.base64Encoded,
  };
}

/**
 * Quotes a string for safe usage in shell/curl commands.
 * @param {string} str
 * @returns {string}
 */
export function shellQuote(str) {
  if (typeof str !== "string") str = String(str);
  if (/^[a-zA-Z0-9_./:=@%+-]+$/.test(str)) {
    return str;
  }
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

/**
 * Generates an executable, minimal curl command string representing the HTTP request.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.method="GET"]
 * @param {object} [options.headers={}]
 * @param {string|object} [options.body]
 * @param {object} [options.query]
 * @param {string} [options.credentials="include"]
 * @returns {string} Ready-to-copy curl invocation
 */
export function generateCurlCommand({
  url,
  method = "GET",
  headers = {},
  body,
  query,
  credentials = "include",
} = {}) {
  let targetUrl = url || "";
  if (query && typeof query === "object") {
    const qStr = Object.entries(query)
      .filter(([_, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    if (qStr) {
      targetUrl += (targetUrl.includes("?") ? "&" : "?") + qStr;
    }
  }

  const parts = ["curl"];
  const upperMethod = (method || "GET").toUpperCase();
  if (upperMethod !== "GET") {
    parts.push(`-X ${upperMethod}`);
  }

  const cleanHeaders = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lower = k.toLowerCase();
    // Exclude noisy browser pseudo-headers and ephemeral headers
    if (
      lower.startsWith(":") ||
      lower.startsWith("sec-ch-ua") ||
      lower.startsWith("sec-fetch-") ||
      lower === "host" ||
      lower === "content-length" ||
      lower === "connection"
    ) {
      continue;
    }
    cleanHeaders[k] = v;
  }

  for (const [k, v] of Object.entries(cleanHeaders)) {
    parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  }

  if (body !== undefined && body !== null && !["GET", "HEAD"].includes(upperMethod)) {
    const bodyStr = typeof body === "object" ? JSON.stringify(body) : String(body);
    parts.push(`--data ${shellQuote(bodyStr)}`);
  }

  parts.push(shellQuote(targetUrl));
  return parts.join(" \\\n  ");
}

/**
 * Replays or initiates an in-page HTTP request inside the target web page context,
 * with options to inherit active session state or run isolated with custom headers.
 *
 * @param {number} tabId
 * @param {object} [paramsOrRecorded={}]
 * @param {object} [overrides={}]
 * @returns {Promise<object>} Standard MakeRequestResult
 */
export async function makeRequest(tabId, paramsOrRecorded = {}, overrides = {}) {
  const isRecorded =
    paramsOrRecorded?.request !== undefined || paramsOrRecorded?.requestId !== undefined;
  const recorded = isRecorded ? paramsOrRecorded : null;
  const opts = isRecorded
    ? { ...recorded.request, ...overrides }
    : { ...paramsOrRecorded, ...overrides };

  let url = opts.url || recorded?.url || "";
  let method = (opts.method || recorded?.method || "GET").toUpperCase();
  let headers = { ...(recorded?.headers || {}), ...(opts.headers || {}) };

  // Strip pseudo-headers
  for (const k of Object.keys(headers)) {
    if (k.startsWith(":")) delete headers[k];
  }

  // Handle query parameter serialization
  if (opts.query && typeof opts.query === "object") {
    const qStr = Object.entries(opts.query)
      .filter(([_, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    if (qStr) {
      url += (url.includes("?") ? "&" : "?") + qStr;
    }
  }

  let bodyPayload = undefined;
  if (opts.json !== undefined) {
    bodyPayload = JSON.stringify(opts.json);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }
  } else if (opts.body !== undefined && opts.body !== null) {
    if (typeof opts.body === "object") {
      bodyPayload = JSON.stringify(opts.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json; charset=utf-8";
      }
    } else {
      bodyPayload = String(opts.body);
    }
  } else if (recorded?.postData !== undefined) {
    bodyPayload = recorded.postData;
  }

  const credentialsMode = opts.credentials || (opts.inherit_session === false ? "omit" : "include");
  const timeoutMs = Number(opts.timeout_ms || opts.timeoutMs) || 15000;

  const expression = `
    (async () => {
      const startTime = Date.now();
      try {
        let finalUrl = ${JSON.stringify(url)};
        try {
          finalUrl = new URL(finalUrl, window.location.href).toString();
        } catch {}

        const fetchOpts = {
          method: ${JSON.stringify(method)},
          headers: ${JSON.stringify(headers)},
          credentials: ${JSON.stringify(credentialsMode)},
        };

        if (${JSON.stringify(bodyPayload !== undefined)} && !["GET", "HEAD"].includes(${JSON.stringify(method)})) {
          fetchOpts.body = ${JSON.stringify(bodyPayload)};
        }

        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        let timer = null;
        if (controller) {
          fetchOpts.signal = controller.signal;
          timer = setTimeout(() => controller.abort(), ${timeoutMs});
        }

        let res;
        try {
          res = await window.fetch(finalUrl, fetchOpts);
        } finally {
          if (timer) clearTimeout(timer);
        }

        const durationMs = Date.now() - startTime;
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}

        const resHeaders = {};
        if (res.headers && typeof res.headers.entries === "function") {
          for (const [k, v] of res.headers.entries()) {
            resHeaders[k] = v;
          }
        }

        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          headers: resHeaders,
          body: text.length > 50000 ? text.slice(0, 50000) + "... [truncated]" : text,
          json,
          duration_ms: durationMs,
        };
      } catch (err) {
        const isTimeout = err.name === "AbortError";
        return {
          ok: false,
          status: isTimeout ? 408 : 0,
          statusText: isTimeout ? "Request Timeout" : "Network Error",
          error: err.message,
          duration_ms: Date.now() - startTime,
        };
      }
    })()
  `;

  const evalRes = await sendCdpCommand(tabId, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  const val = evalRes.result?.value;
  if (!val) throw new Error("make_request evaluation returned no value");

  let pointerVal = undefined;
  if (opts.pointer && val.json) {
    pointerVal = resolveJsonPointer(val.json, opts.pointer);
  }

  const curl = generateCurlCommand({
    url,
    method,
    headers,
    body: bodyPayload,
    credentials: credentialsMode,
  });

  return {
    ok: val.ok ?? false,
    status: val.status,
    statusText: val.statusText,
    headers: val.headers || {},
    body: val.body || "",
    json: val.json || null,
    data: val.json || null,
    pointer: opts.pointer,
    pointer_value: pointerVal,
    ...(pointerVal !== undefined ? { pointerValue: pointerVal } : {}),
    duration_ms: val.duration_ms || 0,
    curl,
    ...(val.error ? { error: val.error } : {}),
  };
}

/**
 * Replays a recorded network request inside the target web page context,
 * preserving active session credentials, cookies, and tokens.
 * Retained for 100% backward compatibility.
 */
export async function networkReplay(tabId, recordedRequest, overrides = {}) {
  return await makeRequest(tabId, recordedRequest, overrides);
}

export const network_replay = networkReplay;
