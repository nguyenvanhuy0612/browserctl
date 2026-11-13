const MAX_MESSAGE_CHARS = 200;

function describe(err) {
  let raw;
  try {
    raw = err instanceof Error ? err.message : String(err);
  } catch {
    raw = "unprintable error";
  }
  return String(raw)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, MAX_MESSAGE_CHARS);
}

// Remembers the uncaught exceptions a long-running process survived. `snapshot()` is null while
// there were none, else {count, lastAt, lastError}, with lastError a single line of at most 200
// characters. `record` never throws, whatever it is given.
export function createFaultLog({ now = Date.now } = {}) {
  let count = 0;
  let lastAt = null;
  let lastError = null;
  return {
    record(err) {
      count += 1;
      lastAt = new Date(now()).toISOString();
      lastError = describe(err);
    },
    snapshot() {
      return count === 0 ? null : { count, lastAt, lastError };
    },
  };
}
