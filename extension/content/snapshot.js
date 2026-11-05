// Census DOM Snapshot Generator & VOM Tree Engine for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/04-content-and-dom.md.

import { registerElement } from "./registry.js";

const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "meta", "link", "head"]);

const STATIC_SEMANTIC_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "td",
  "th",
  "blockquote",
  "pre",
  "code",
  "time",
  "figcaption",
  "caption",
  "table",
  "tbody",
  "thead",
  "tfoot",
  "tr",
]);

const PROSE_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "li",
  "dt",
  "dd",
  "figcaption",
  "caption",
  "time",
  "span",
  "div",
]);

const INLINE_PHRASING_TAGS = new Set([
  "b",
  "strong",
  "i",
  "em",
  "mark",
  "small",
  "del",
  "ins",
  "sub",
  "sup",
  "code",
  "span",
  "br",
  "font",
  "time",
]);

/**
 * Normalizes Unicode non-breaking spaces and collapses redundant whitespace.
 *
 * @param {*} str
 * @returns {string}
 */
export function normalizeText(str) {
  if (str == null) return "";
  return String(str)
    .replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Sanitizes cell/leaf text against spreadsheet formula injection (CWE-1236).
 * Prepends a single quote if the text begins with =, +, -, @, \t, or \r.
 *
 * @param {*} val
 * @returns {string}
 */
export function csvSafe(val) {
  if (val == null) return "";
  const s = String(val);
  if (/^[=+\-@\t\r]/.test(s)) {
    return "'" + s;
  }
  return s;
}

/**
 * Redacts sensitive password values.
 *
 * @param {Element} el
 * @param {string} [val]
 * @returns {string}
 */
export function sanitizeElementValue(el, val) {
  if (!el || el.nodeType !== 1) return val || "";
  const type = el.getAttribute?.("type") || (el.type ? String(el.type).toLowerCase() : "");
  const autocomplete = el.getAttribute?.("autocomplete") || "";
  if (
    type === "password" ||
    autocomplete === "current-password" ||
    autocomplete === "new-password"
  ) {
    return "[REDACTED]";
  }
  return val !== undefined ? String(val) : el.value || "";
}

/**
 * Checks if an element is a standard native interactive HTML control.
 * Native controls must never be suppressed during container collapsing.
 *
 * @param {Element} el
 * @returns {boolean}
 */
export function isNativeControl(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  if (tag === "a") {
    return Boolean(typeof el.hasAttribute === "function" && el.hasAttribute("href"));
  }
  if (tag === "button" || tag === "select" || tag === "textarea" || tag === "summary") {
    return true;
  }
  if (tag === "input") {
    const type = (el.getAttribute?.("type") || el.type || "").toLowerCase();
    return type !== "hidden";
  }
  return false;
}

export const isNativeInteractive = isNativeControl;

/**
 * Checks if an element is an editable target (contenteditable, rich input, click-to-edit cell).
 *
 * @param {Element} el
 * @returns {boolean}
 */
export function isEditableControl(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  if (tag === "textarea") return true;
  if (tag === "input") {
    const type = (el.getAttribute?.("type") || el.type || "text").toLowerCase();
    return !["hidden", "button", "submit", "reset", "image", "checkbox", "radio"].includes(type);
  }

  // 1. contenteditable variants
  const ce = typeof el.getAttribute === "function" ? el.getAttribute("contenteditable") : null;
  if (ce === "true" || ce === "" || ce === "plaintext-only") return true;
  if (el.isContentEditable === true || el.contentEditable === "true" || el.contentEditable === "") {
    return true;
  }

  // 2. Rich input identifier or role
  const id =
    typeof el.getAttribute === "function" ? el.getAttribute("id") || el.id || "" : el.id || "";
  if (id === "richInput" || /rich[-_]?input/i.test(id)) return true;
  const role = el.getAttribute?.("role");
  if (role === "textbox" || role === "searchbox") return true;

  // 3. Click-to-edit table cells
  if (tag === "td" || tag === "th" || role === "gridcell" || role === "cell") {
    if (
      el.hasAttribute?.("data-editable") ||
      el.hasAttribute?.("data-click-to-edit") ||
      el.getAttribute?.("aria-readonly") === "false" ||
      /\b(editable|click-to-edit|cell-edit)\b/i.test(el.className || "")
    ) {
      return true;
    }
  }

  return false;
}

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
    if (el.style.display === "contents") return false;
    if (el.style.display === "none") return true;
    if (el.style.visibility === "hidden" || el.style.visibility === "collapse") return true;
    if (el.style.opacity === "0" && (!el.children || el.children.length === 0)) return true;
  }

  // 3. offsetParent in real browser
  if (
    typeof el.offsetParent !== "undefined" &&
    el.offsetParent === null &&
    el.tagName &&
    el.tagName.toLowerCase() !== "body" &&
    typeof window !== "undefined" &&
    typeof window.getComputedStyle === "function"
  ) {
    try {
      const s = window.getComputedStyle(el);
      if (s.position !== "fixed" && s.display !== "contents") return true;
    } catch {}
  }

  // 4. computed style (in browser DOM)
  if (typeof window !== "undefined" && window.getComputedStyle) {
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "contents") return false;
      if (style.display === "none") return true;
      if (style.visibility === "hidden" || style.visibility === "collapse") return true;
      if (style.opacity === "0") {
        const hasInteractiveChild =
          typeof el.querySelector === "function" &&
          el.querySelector("input, select, textarea, button, a[href]");
        if (!hasInteractiveChild) return true;
      }
    } catch {}
  }

  // 4. bounding client rect (0x0 rect)
  if (typeof el.getBoundingClientRect === "function") {
    try {
      const rect = el.getBoundingClientRect();
      const hasChildren = el.children && el.children.length > 0;
      if (rect && rect.width === 0 && rect.height === 0 && !hasChildren) {
        return true;
      }
    } catch {}
  }

  return false;
}

/**
 * Compacts whitespace, applies formula injection defense, and truncates beyond max length.
 *
 * @param {string} text
 * @param {number} [max=150]
 * @returns {string}
 */
export function compactText(text, max = 150) {
  if (text == null) return "";
  const cleaned = normalizeText(text);
  const safe = csvSafe(cleaned);
  if (safe.length > max) {
    return safe.slice(0, max - 3) + "...";
  }
  return safe;
}

/**
 * Determines whether an element is actionable (native control, ARIA role, editable, or SPA clickable container).
 *
 * @param {Element} el
 * @returns {boolean}
 */
export function isActionable(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName ? el.tagName.toLowerCase() : "";

  // 1. Native interactive controls
  if (isNativeControl(el)) return true;

  // 2. Editable / fillable elements
  if (isEditableControl(el)) return true;

  // 3. Explicit interactive ARIA roles
  const role = el.getAttribute?.("role");
  if (
    role &&
    [
      "button",
      "link",
      "textbox",
      "checkbox",
      "radio",
      "combobox",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "tab",
      "switch",
      "option",
      "treeitem",
      "searchbox",
      "slider",
      "spinbutton",
    ].includes(role)
  ) {
    return true;
  }

  // 4. Explicit click / keyboard listeners
  if (
    el.hasAttribute?.("onclick") ||
    (el.hasAttribute?.("tabindex") && el.getAttribute?.("tabindex") !== "-1")
  ) {
    return true;
  }

  // 5. Framework synthetic event check (React 16+)
  try {
    for (const key of Object.keys(el)) {
      if (key.startsWith("__reactProps") && el[key] && typeof el[key].onClick === "function") {
        return true;
      }
    }
  } catch {}

  // 6. Style-based affordance (SPA composite clickable container)
  if (!STATIC_SEMANTIC_TAGS.has(tag) && role !== "row" && role !== "grid") {
    let cursor = null;
    if (el.style && el.style.cursor) {
      cursor = el.style.cursor;
    } else if (typeof window !== "undefined" && window.getComputedStyle) {
      try {
        const style = window.getComputedStyle(el);
        cursor = style?.cursor;
      } catch {}
    }

    if (cursor === "pointer") {
      const raw =
        el.innerText ||
        el.textContent ||
        el.getAttribute?.("aria-label") ||
        el.getAttribute?.("title") ||
        "";
      const cleaned = normalizeText(raw);
      if (cleaned.length > 0 && cleaned.length <= 150) {
        return true;
      }
    }
  }

  return false;
}

export const isInteractive = isActionable;

/**
 * Checks whether an element is an atomic prose block whose text should be emitted
 * as a single coherent prose line, avoiding recursion into inline formatting tags.
 *
 * @param {Element} el
 * @returns {boolean}
 */
export function isAtomicProseBlock(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  if (!PROSE_TAGS.has(tag)) return false;

  // If it has children, all child elements must be inline phrasing tags
  if (el.children && el.children.length > 0) {
    for (const child of el.children) {
      const childTag = child.tagName ? child.tagName.toLowerCase() : "";
      if (!INLINE_PHRASING_TAGS.has(childTag)) {
        return false;
      }
    }
  }

  // Must not contain any interactive descendants
  function hasInteractiveDescendant(n) {
    for (const c of n.children || []) {
      if (isActionable(c)) return true;
      if (hasInteractiveDescendant(c)) return true;
    }
    return false;
  }
  if (hasInteractiveDescendant(el)) return false;

  const raw = el.innerText || el.textContent || "";
  return normalizeText(raw).length > 0;
}

/**
 * Recursively collects preserved native and editable descendants within a collapsed container.
 *
 * @param {Element} parent
 * @returns {Element[]}
 */
export function findPreservedDescendants(parent) {
  const list = [];
  function collect(n) {
    for (const c of n.children || []) {
      if (isNativeControl(c) || isEditableControl(c)) {
        list.push(c);
      } else {
        collect(c);
      }
    }
  }
  collect(parent);
  return list;
}

/**
 * Recursively locates all rows in a native table or ARIA grid.
 *
 * @param {Element} tableEl
 * @returns {Element[]}
 */
function findTableRows(tableEl) {
  const isNative = tableEl.tagName?.toLowerCase() === "table";
  if (isNative && tableEl.rows && tableEl.rows.length > 0) {
    return Array.from(tableEl.rows);
  }
  const rows = [];
  function search(n) {
    for (const c of n.children || []) {
      const tag = c.tagName ? c.tagName.toLowerCase() : "";
      const role = c.getAttribute?.("role");
      if (tag === "tr" || role === "row") {
        rows.push(c);
      }
      search(c);
    }
  }
  search(tableEl);
  return rows;
}

/**
 * Recursively locates all cells in a table row.
 *
 * @param {Element} rowEl
 * @returns {Element[]}
 */
function findRowCells(rowEl) {
  const isNative = rowEl.tagName?.toLowerCase() === "tr";
  if (isNative && rowEl.cells && rowEl.cells.length > 0) {
    return Array.from(rowEl.cells);
  }
  const cells = [];
  function search(n) {
    for (const c of n.children || []) {
      const tag = c.tagName ? c.tagName.toLowerCase() : "";
      const role = c.getAttribute?.("role");
      if (
        tag === "td" ||
        tag === "th" ||
        role === "cell" ||
        role === "gridcell" ||
        role === "columnheader" ||
        role === "rowheader"
      ) {
        cells.push(c);
      } else {
        search(c);
      }
    }
  }
  search(rowEl);
  return cells;
}

/**
 * Finds an interactive control within a table cell.
 *
 * @param {Element} cell
 * @returns {Element|null}
 */
function findInteractiveCellControl(cell) {
  for (const c of cell.children || []) {
    if (isNativeControl(c) || isEditableControl(c) || isActionable(c)) {
      return c;
    }
    const inner = findInteractiveCellControl(c);
    if (inner) return inner;
  }
  return null;
}

/**
 * Formats a native <table> or ARIA grid as a clean, aligned row-matrix layout.
 *
 * @param {Element} tableEl
 * @param {number} depth
 * @param {object} context
 */
export function formatTableStructure(tableEl, depth, context) {
  const { registerElement, lines, scope = "viewport", isInViewport } = context;
  const tableSelector = "table, [role='table'], [role='grid'], [role='treegrid']";

  const allRows = findTableRows(tableEl);

  const ownedRows = allRows.filter((row) => {
    if (typeof row.closest === "function") {
      return row.closest(tableSelector) === tableEl;
    }
    return true;
  });

  if (ownedRows.length === 0) return;

  const captionEl = tableEl.querySelector
    ? tableEl.querySelector(":scope > caption, caption")
    : null;
  const captionText = captionEl ? normalizeText(captionEl.innerText || captionEl.textContent) : "";
  const tableLabel = tableEl.getAttribute?.("aria-label") || captionText || "";
  const baseIndent = "  ".repeat(depth);

  if (tableLabel) {
    lines.push(`${baseIndent}[Table: "${tableLabel}"]`);
  }

  for (let r = 0; r < ownedRows.length; r++) {
    const row = ownedRows[r];
    if (isElementHidden(row)) continue;

    if (scope === "viewport" && typeof isInViewport === "function" && !isInViewport(row)) {
      continue;
    }

    const allCells = findRowCells(row);

    const ownedCells = allCells.filter((cell) => {
      if (typeof cell.closest === "function") {
        return cell.closest("tr, [role='row']") === row;
      }
      return true;
    });

    if (ownedCells.length === 0) continue;

    const formattedCells = [];

    for (let c = 0; c < ownedCells.length; c++) {
      const cell = ownedCells[c];
      if (isElementHidden(cell)) {
        formattedCells.push("");
        continue;
      }

      const isEditable = isEditableControl(cell);
      const interactiveChild = findInteractiveCellControl(cell);

      if (isEditable) {
        const ref = registerElement(cell);
        const text = compactText(cell.innerText || cell.textContent || "");
        formattedCells.push(`[${ref}] <${cell.tagName.toLowerCase()}>[contenteditable] "${text}"`);
      } else if (interactiveChild && !isElementHidden(interactiveChild)) {
        const ref = registerElement(interactiveChild);
        const childTag = interactiveChild.tagName.toLowerCase();
        const childType = interactiveChild.getAttribute?.("type");
        const rawText = normalizeText(
          interactiveChild.innerText ||
            interactiveChild.textContent ||
            interactiveChild.getAttribute?.("aria-label") ||
            interactiveChild.getAttribute?.("placeholder") ||
            ""
        );
        const safeText = csvSafe(rawText);
        let desc = `[${ref}] <${childTag}>`;
        if (childType) desc += `[type=${childType}]`;
        if (childType === "password") {
          desc += ` "[REDACTED]"`;
        } else if (safeText) {
          const display = safeText.length > 50 ? safeText.slice(0, 47) + "..." : safeText;
          desc += ` "${display}"`;
        }
        formattedCells.push(desc);
      } else {
        const raw = normalizeText(cell.innerText || cell.textContent || "");
        formattedCells.push(csvSafe(raw));
      }
    }

    const rowContent = formattedCells.join(" | ");
    lines.push(`${baseIndent}| ${rowContent} |`);
  }
}

/**
 * Renders an indented Virtual Object Model (VOM) text tree.
 * Captures structural semantic roles, pointer recovery, actionable @e tokens, and leaf content text.
 *
 * @param {Element} root
 * @param {object} [options]
 * @param {Function} [options.refAssigner]
 * @param {number} [options.maxDepth=25]
 * @param {boolean} [options.redactValues=true]
 * @returns {string}
 */
export function renderVomTree(root, options = {}) {
  if (!root || root.nodeType !== 1) return "";

  const refAssigner = options.refAssigner || registerElement;
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 25;
  const redactValues = options.redactValues !== false;

  const SKIP_ROLES = new Set(["generic", "none", "presentation", "inlinetextbox"]);
  const TAG_TO_ROLE = {
    a: "link",
    button: "button",
    input: "textbox",
    textarea: "textbox",
    select: "combobox",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    ul: "list",
    ol: "list",
    li: "listitem",
    table: "grid",
    tr: "row",
    th: "columnheader",
    td: "cell",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    form: "form",
    section: "region",
    aside: "complementary",
    dialog: "dialog",
    article: "article",
  };

  function getCleanText(el) {
    const raw = el.innerText || el.textContent || "";
    return normalizeText(raw);
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    return !isElementHidden(el);
  }

  function getRole(el) {
    const explicitRole = el.getAttribute?.("role");
    if (explicitRole) return explicitRole.toLowerCase();
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "input") {
      const type = (el.getAttribute?.("type") || el.type || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "search") return "searchbox";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      return "textbox";
    }
    return TAG_TO_ROLE[tag] || null;
  }

  const lines = [];
  const docTitle = typeof document !== "undefined" ? document.title || "Untitled" : "Untitled";
  const rootToken = refAssigner ? refAssigner(root) : "@e0";
  const formattedRootToken = rootToken
    ? rootToken.startsWith("@")
      ? rootToken
      : `@${rootToken}`
    : "@e0";
  lines.push(
    `- RootWebArea "${docTitle.replace(/\s+/g, " ").replace(/"/g, '\\"')}" [${formattedRootToken}]`
  );

  function hasInteractiveDescendant(n) {
    if (!n || !n.children) return false;
    for (let i = 0; i < n.children.length; i++) {
      const c = n.children[i];
      if (isNativeControl(c) || isEditableControl(c)) return true;
      const r = c.getAttribute?.("role");
      if (
        r &&
        [
          "button",
          "link",
          "checkbox",
          "radio",
          "combobox",
          "textbox",
          "searchbox",
          "tab",
          "menuitem",
        ].includes(r.toLowerCase())
      ) {
        return true;
      }
      if (hasInteractiveDescendant(c)) return true;
    }
    return false;
  }

  function walk(el, depth) {
    if (!el || el.nodeType !== 1 || depth > maxDepth) return;
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (SKIP_TAGS.has(tag)) return;
    if (!isVisible(el)) return;

    let isPointer = false;
    if (typeof getComputedStyle === "function") {
      try {
        isPointer = getComputedStyle(el).cursor === "pointer";
      } catch {}
    }

    let role = getRole(el);
    let name =
      el.getAttribute?.("aria-label") ||
      el.getAttribute?.("placeholder") ||
      el.getAttribute?.("title") ||
      el.getAttribute?.("alt");

    const isPassword =
      tag === "input" &&
      ((el.getAttribute?.("type") || el.type || "").toLowerCase() === "password" ||
        (el.getAttribute?.("autocomplete") || "").includes("password"));

    const hasInteractive = hasInteractiveDescendant(el);

    // VOM Recovery: cursor: pointer + compact text recovers as button (only if no interactive descendants)
    if ((!role || SKIP_ROLES.has(role)) && isPointer && !hasInteractive) {
      const text = getCleanText(el);
      if (text && text.length > 0 && text.length < 100) {
        role = "button";
        if (!name) name = text;
      }
    }

    // Leaf text and name recovery
    let isLeafText = false;
    const childElementCount = el.children ? el.children.length : 0;
    if (!name && childElementCount === 0) {
      const text = getCleanText(el);
      if (text && text.length > 0) {
        name = text;
        if (!role || SKIP_ROLES.has(role)) {
          isLeafText = true;
        }
      }
    }

    // Password redaction
    if (isPassword && redactValues) {
      name = "[REDACTED]";
    }

    const indent = "  ".repeat(depth);
    let emitted = false;

    if (role && !SKIP_ROLES.has(role)) {
      let line = `${indent}- ${role}`;
      if (name) {
        const cleanName = compactText(name, 150).replace(/"/g, '\\"');
        line += ` "${cleanName}"`;
      }
      if (refAssigner) {
        const token = refAssigner(el);
        if (token) {
          const formattedToken = token.startsWith("@") ? token : `@${token}`;
          line += ` [${formattedToken}]`;
        }
      }
      lines.push(line);
      emitted = true;
    } else if (isLeafText && name) {
      const cleanText = compactText(name, 150).replace(/"/g, '\\"');
      lines.push(`${indent}- text: "${cleanText}"`);
      emitted = true;
    }

    // Container Collapsing: If this container was recovered as an actionable button, don't recurse into child elements
    if (role === "button" && isPointer && childElementCount > 0 && !hasInteractive) {
      return;
    }

    const nextDepth = emitted ? depth + 1 : depth;
    const children = el.children || [];
    for (let i = 0; i < children.length; i++) {
      walk(children[i], nextDepth);
    }
  }

  const isDocRoot =
    root.tagName?.toLowerCase() === "body" ||
    root.tagName?.toLowerCase() === "html" ||
    (typeof document !== "undefined" &&
      (root === document.body || root === document.documentElement));

  if (isDocRoot) {
    const children = root.children || [];
    for (let i = 0; i < children.length; i++) {
      walk(children[i], 1);
    }
  } else {
    walk(root, 1);
  }

  return lines.join("\n");
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

  const isPassword =
    root.getAttribute?.("type") === "password" ||
    root.type === "password" ||
    (root.getAttribute?.("autocomplete") || "").includes("password");

  if (tag === "input" || tag === "textarea") {
    if (redactValues && isPassword) {
      value = "[REDACTED]";
      text = "[REDACTED]";
    } else if (redactValues) {
      value = "[REDACTED]";
    } else {
      value = root.value || "";
    }
  }

  const token = isActionable(root) ? registerElement(root) : null;
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
 * @param {string} [options.format="compact"] - "compact" | "vom"
 * @param {number} [options.maxDepth=64]
 * @param {boolean} [options.redactValues=true]
 * @returns {object} { census, text, vom?, tree? }
 */
export function takeSnapshot(rootOrOptions, options = {}) {
  const { root, options: opts } = normalizeSnapshotArgs(rootOrOptions, options);

  if (!root) {
    return { census: "", text: "" };
  }

  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 25;
  const redactValues = opts.redactValues !== false;
  const vomTree = buildVOMNode(root, 0, Math.min(maxDepth, 8), null, redactValues);
  const vomText = renderVomTree(root, {
    refAssigner: registerElement,
    maxDepth,
    redactValues,
    scope: opts.scope || "viewport",
  });

  return {
    census: vomText,
    vom: vomTree,
    tree: vomTree,
    text: vomText,
    structure: "Virtual Object Model Tree",
    scope: opts.scope || "viewport",
    window: { offset: 0, shown: 1, inScope: 1 },
    duplicateCount: 0,
    foldedCount: 0,
    folded: [],
  };
}

export const snapshot = takeSnapshot;
export const generateVOM = (rootOrOptions, options = {}) =>
  takeSnapshot(rootOrOptions, { ...options, format: "vom" });
export const buildVOM = generateVOM;
