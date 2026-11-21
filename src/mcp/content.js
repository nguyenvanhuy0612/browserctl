// @ts-check
// A tool result as MCP content blocks (specs/interface.md): the JSON result, the long text of
// snapshot and read as its own unescaped block, and a screenshot's image.
import fs from "node:fs";

/** The result field that holds a tool's long text. */
const TEXT_FIELD = /** @type {Record<string, string>} */ ({ snapshot: "snapshot", read: "text" });

/**
 * @param {string} tool @param {any} result
 * @returns {({type: "text", text: string} | {type: "image", data: string, mimeType: string})[]}
 */
export function toolContent(tool, result) {
  const field = TEXT_FIELD[tool];
  if (result.ok && field && typeof result[field] === "string") {
    const { [field]: text, ...rest } = result;
    return [
      { type: "text", text: JSON.stringify(rest) },
      { type: "text", text },
    ];
  }
  /** @type {({type: "text", text: string} | {type: "image", data: string, mimeType: string})[]} */
  const content = [{ type: "text", text: JSON.stringify(result) }];
  if (result.ok && tool === "take_screenshot" && result.path) {
    try {
      content.push({ type: "image", data: fs.readFileSync(result.path).toString("base64"), mimeType: result.mimeType });
    } catch {
      // the path is in the text result
    }
  }
  return content;
}
