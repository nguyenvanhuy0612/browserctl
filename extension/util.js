// Shared helpers for network/console payloads sent to an LLM.
// Imported by netlog.js and cdp.js. Keep this dependency-free.

// Header names whose values must never reach the agent / LLM.
export const SENSITIVE_HEADERS = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-goog-api-key",
  "www-authenticate",
]);

const REDACTED = "[redacted]";

// Redact sensitive values in a header MAP ({ name: value }). Returns a new object.
export function stripHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

// Redact sensitive values in a header LIST ([{ name, value }]). Returns a new array.
export function redactHeaderList(list) {
  return (list || []).map((h) => ({
    name: h.name,
    value: SENSITIVE_HEADERS.has(String(h.name).toLowerCase()) ? REDACTED : h.value,
  }));
}

// Truncate a string, appending a marker noting how many chars were dropped.
export function truncate(str, max = 8000) {
  if (typeof str !== "string" || str.length <= max) return str;
  return str.slice(0, max) + `\n...[truncated ${str.length - max} chars]`;
}
