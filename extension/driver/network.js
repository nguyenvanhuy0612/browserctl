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
 * Replays a recorded network request inside the target web page context,
 * preserving active session credentials, cookies, and tokens.
 *
 * @param {number} tabId
 * @param {object} recordedRequest
 * @param {object} [overrides={}]
 * @returns {Promise<any>}
 */
export async function networkReplay(tabId, recordedRequest, overrides = {}) {
  const url = overrides.url || recordedRequest?.url;
  const method = overrides.method || recordedRequest?.method || "GET";
  const headers = { ...(recordedRequest?.headers || {}), ...(overrides.headers || {}) };

  // Strip pseudo-headers
  for (const k of Object.keys(headers)) {
    if (k.startsWith(":")) delete headers[k];
  }

  const body = overrides.body !== undefined ? overrides.body : recordedRequest?.postData;

  const expression = `
    (async () => {
      try {
        const fetchOpts = {
          method: ${JSON.stringify(method)},
          headers: ${JSON.stringify(headers)},
          credentials: "include",
        };
        if (${JSON.stringify(body)} && !["GET", "HEAD"].includes(${JSON.stringify(method)})) {
          fetchOpts.body = ${JSON.stringify(body)};
        }
        const res = await window.fetch(${JSON.stringify(url)}, fetchOpts);
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        const resHeaders = {};
        for (const [k, v] of res.headers.entries()) resHeaders[k] = v;
        return {
          ok: true,
          status: res.status,
          statusText: res.statusText,
          headers: resHeaders,
          body: text.length > 50000 ? text.slice(0, 50000) + "... [truncated]" : text,
          json,
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    })()
  `;

  const evalRes = await sendCdpCommand(tabId, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  const val = evalRes.result?.value;
  if (!val) throw new Error("network_replay evaluation returned no value");
  if (!val.ok) throw new Error(`replay failed in page: ${val.error}`);

  let pointerVal = undefined;
  if (overrides.pointer && val.json) {
    pointerVal = resolveJsonPointer(val.json, overrides.pointer);
  }

  return {
    status: val.status,
    statusText: val.statusText,
    headers: val.headers,
    body: val.body,
    json: val.json,
    ...(overrides.pointer ? { pointer: overrides.pointer, pointerValue: pointerVal } : {}),
  };
}

export const network_replay = networkReplay;
