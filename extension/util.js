// Shared helpers for network/console payloads sent to an LLM.
// Imported by cdp.js. Keep this dependency-free.
//
// Note: this is a local, internal-only tool, so network/HAR headers (including
// cookies and auth) are returned verbatim — no redaction. Add a redaction pass
// here if this is ever pointed at a shared/untrusted context.

// Truncate a string, appending a marker noting how many chars were dropped.
export function truncate(str, max = 8000) {
  if (typeof str !== "string" || str.length <= max) return str;
  return str.slice(0, max) + `\n...[truncated ${str.length - max} chars]`;
}
