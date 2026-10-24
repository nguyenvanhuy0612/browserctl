// Census DOM Snapshot Generator & VOM Tree Engine for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/04-content-and-dom.md.

import { registerElement } from "./registry.js";

/**
 * Checks if an element is hidden from view or assistive technology.
 *
 * @param {Element} el
 * @returns {boolean}
 */
export function isElementHidden(el) {
  if (!el || typeof el !== "object") return true;

  // 1. aria-hidden
  if (typeof el.getAttribute === "function" && el.getAttribute("aria-hidden") === "true") {
    return true;
  }

  // 2. inline or mock style properties
  if (el.style) {
    if (el.style.display === "none") return true;
    if (el.style.visibility === "hidden" || el.style.visibility === "collapse") return true;
    if (el.style.opacity === "0") return true;
  }

  // 3. computed style (in browser DOM)
  if (typeof window !== "undefined" && window.getComputedStyle) {
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none") return true;
      if (style.visibility === "hidden" || style.visibility === "collapse") return true;
      if (style.opacity === "0") {
        const hasInteractiveChild =
          typeof el.querySelector === "function" &&
          el.querySelector("input, select, textarea, button, a");
        if (!hasInteractiveChild) return true;
      }
    } catch {}
  }

  // 4. bounding client rect (0x0 rect)
  if (typeof el.getBoundingClientRect === "function") {
    try {
      const rect = el.getBoundingClientRect();
      if (rect && rect.width === 0 && rect.height === 0) return true;
    } catch {}
  }

  return false;
}

/**
 * Compacts whitespace and truncates string beyond max length.
 *
 * @param {string} text
 * @param {number} [max=150]
 * @returns {string}
 */
export function compactText(text, max = 150) {
  if (!text) return "";
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  if (cleaned.length > max) {
    return cleaned.slice(0, max - 3) + "...";
  }
  return cleaned;
}

/**
 * Determines whether an element is interactive and should be indexed in census.
 *
 * @param {Element} el
 * @returns {boolean}
 */
export function isInteractive(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  if (["a", "button", "input", "select", "textarea", "summary"].includes(tag)) {
    return true;
  }
  const role = el.getAttribute?.("role");
  if (
    [
      "button",
      "link",
      "textbox",
      "checkbox",
      "radio",
      "combobox",
      "menuitem",
      "tab",
      "switch",
      "option",
    ].includes(role)
  ) {
    return true;
  }
  if (el.hasAttribute?.("onclick") || el.hasAttribute?.("tabindex")) {
    return true;
  }
  return false;
}

/**
 * Builds a Virtual Object Model (VOM) node tree for layout and occlusion diagnosis.
 *
 * @param {Element} root
 * @param {number} [depth=0]
 * @param {number} [maxDepth=8]
 * @param {string|null} [parentId=null]
 * @param {boolean} [redactValues=true]
 * @returns {object|null}
 */
export function buildVOMNode(root, depth = 0, maxDepth = 8, parentId = null, redactValues = true) {
  if (!root || depth > maxDepth) return null;
  if (root.nodeType !== 1) return null;
  if (["script", "style", "noscript"].includes(root.tagName?.toLowerCase())) return null;

  let rect = { x: 0, y: 0, w: 0, h: 0, width: 0, height: 0 };
  if (typeof root.getBoundingClientRect === "function") {
    try {
      const b = root.getBoundingClientRect();
      const x = Math.round(b.left ?? b.x ?? 0);
      const y = Math.round(b.top ?? b.y ?? 0);
      const width = Math.round(b.width ?? 0);
      const height = Math.round(b.height ?? 0);
      rect = { x, y, w: width, h: height, width, height };
    } catch {}
  }

  const tag = root.tagName ? root.tagName.toLowerCase() : "div";
  const role = root.getAttribute?.("role") || null;
  let text = compactText(root.innerText || root.textContent || "");
  let value = undefined;

  if (tag === "input" || tag === "textarea") {
    if (redactValues) {
      value = "[REDACTED]";
      if (root.getAttribute?.("type") === "password") {
        text = "[REDACTED]";
      }
    } else {
      value = root.value || "";
    }
  }

  const token = isInteractive(root) ? registerElement(root) : null;
  const domId = root.getAttribute?.("id");
  const id =
    token || (domId ? `#${domId}` : `node_${depth}_${Math.random().toString(36).slice(2, 7)}`);

  let layer = "page";
  if (root.getAttribute?.("role") === "dialog" || tag === "dialog") {
    layer = "modal";
  }

  const children = [];
  for (const child of root.children || []) {
    const childNode = buildVOMNode(child, depth + 1, maxDepth, id, redactValues);
    if (childNode) children.push(childNode);
  }

  return {
    id,
    tag,
    role,
    rect,
    parentId,
    depth,
    layer,
    text,
    ...(value !== undefined ? { value } : {}),
    ...(token ? { ref: token } : {}),
    children,
  };
}

/**
 * Normalizes takeSnapshot arguments allowing either:
 * - takeSnapshot(rootElement, options)
 * - takeSnapshot({ root, format, maxDepth, redactValues, ... })
 *
 * @param {Element|object} [rootOrOptions]
 * @param {object} [options]
 * @returns {{ root: Element|null, options: object }}
 */
function normalizeSnapshotArgs(rootOrOptions, options = {}) {
  let root = null;
  let opts = {};

  if (rootOrOptions && typeof rootOrOptions === "object" && !rootOrOptions.nodeType) {
    opts = { ...rootOrOptions, ...options };
    root = opts.root || null;
  } else {
    root = rootOrOptions || null;
    opts = { ...options };
  }

  if (!root && typeof document !== "undefined") {
    root = document.body || document.documentElement || null;
  }

  return { root, options: opts };
}

/**
 * Takes a census DOM snapshot of interactive elements.
 *
 * @param {Element|object} [rootOrOptions]
 * @param {object} [options]
 * @param {boolean} [options.elements=false] - Return structured element array
 * @param {string} [options.format="compact"] - "compact" | "vom"
 * @param {number} [options.maxDepth=8]
 * @param {boolean} [options.redactValues=true]
 * @returns {object} { census, text, elements?, vom?, tree? }
 */
export function takeSnapshot(rootOrOptions, options = {}) {
  const { root, options: opts } = normalizeSnapshotArgs(rootOrOptions, options);

  if (!root) {
    return { census: "", text: "", elements: [] };
  }

  // Virtual Object Model tree mode
  if (opts.format === "vom") {
    const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 8;
    const redactValues = opts.redactValues !== false;
    const vomTree = buildVOMNode(root, 0, maxDepth, null, redactValues);
    return { vom: vomTree, tree: vomTree };
  }

  const interactiveElements = [];
  const lines = [];

  function walk(node) {
    if (!node || node.nodeType !== 1) return;
    const tag = node.tagName?.toLowerCase();
    if (["script", "style", "noscript"].includes(tag)) return;
    if (isElementHidden(node)) return;

    if (isInteractive(node)) {
      const ref = registerElement(node);
      const rawText =
        node.innerText ||
        node.textContent ||
        node.getAttribute?.("placeholder") ||
        node.getAttribute?.("aria-label") ||
        "";
      const text = compactText(rawText);
      const role = node.getAttribute?.("role") || tag;
      const type = node.getAttribute?.("type");

      const elementRecord = {
        ref,
        tag,
        role,
        text,
        ...(type ? { type } : {}),
      };
      interactiveElements.push(elementRecord);

      const normalizedRef = ref.startsWith("@") ? ref : "@" + ref;
      let line = `  [${normalizedRef}] <${tag}>`;
      if (type) line += `[type=${type}]`;
      if (text) line += ` "${text}"`;
      lines.push(line);
    } else {
      // Leaf content node or element with direct text
      const rawText = node.innerText || node.textContent || "";
      if (rawText.trim() && (!node.children || node.children.length === 0)) {
        const text = compactText(rawText);
        if (text) {
          lines.push(`  <${tag}> "${text}"`);
        }
      }
    }

    for (const child of node.children || []) {
      walk(child);
    }
  }

  walk(root);

  const censusText = lines.join("\n");
  const result = {
    census: censusText,
    text: censusText,
  };

  if (opts.elements) {
    result.elements = interactiveElements;
  }

  return result;
}

export const snapshot = takeSnapshot;
export const generateVOM = (rootOrOptions, options = {}) =>
  takeSnapshot(rootOrOptions, { ...options, format: "vom" });
export const buildVOM = generateVOM;
