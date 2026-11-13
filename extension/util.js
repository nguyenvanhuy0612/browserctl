export function truncate(str, max = 8000) {
  if (typeof str !== "string" || str.length <= max) return str;
  return str.slice(0, max) + `\n...[truncated ${str.length - max} chars]`;
}

function messageOf(err) {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return "unprintable error";
  }
}

// Records an error that is deliberately not propagated. console.debug is hidden at the service
// worker console's default level. `tag` is a static "<file>.<operation>" string. Never throws.
export function noteSwallowed(tag, err) {
  try {
    console.debug("[browserctl] swallowed", tag, messageOf(err));
  } catch {
    // Logging must never throw into the caller.
  }
}

// A promise rejection handler that records and drops the error: `p.catch(swallow("cdp.detach"))`.
export function swallow(tag) {
  return (err) => noteSwallowed(tag, err);
}
