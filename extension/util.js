export function truncate(str, max = 8000) {
  if (typeof str !== "string" || str.length <= max) return str;
  return str.slice(0, max) + `\n...[truncated ${str.length - max} chars]`;
}
