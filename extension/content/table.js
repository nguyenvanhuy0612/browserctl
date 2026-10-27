// Structured Table, Grid, and List Extraction Engine for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/04-content-and-dom.md.
// Provides 2D matrix normalization, multi-tier header paths, ARIA grid/treegrid support,
// nested container boundary isolation, split ARIA row fragment joining, cell spans tracking,
// row provenance metadata, coverage determination, and CWE-1236 CSV safe defense.

/**
 * Custom error class for structured extraction failures.
 */
export class ExtractionFailure extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "ExtractionFailure";
    this.reason = reason;
  }
}

/**
 * Sanitizes a cell string against CSV formula injection (CWE-1236).
 * Prepends a single quote if the value begins with an executable trigger character.
 *
 * @param {*} val
 * @returns {string}
 */
export function csv_safe(val) {
  if (val == null) return "";
  const s = String(val);
  if (/^[=+\-@\t\r]/.test(s)) {
    return "'" + s;
  }
  return s;
}

/**
 * Formats a single value for CSV serialization, applying formula defense and quote escaping.
 *
 * @param {*} val - Value to sanitize.
 * @param {boolean} [csvSafe=true] - Whether to apply CWE-1236 formula defense.
 * @returns {string} Sanitized and escaped CSV cell value.
 */
export function sanitizeCsvValue(val, csvSafe = true) {
  if (val == null) return "";
  let str = String(val);
  if (csvSafe && /^[=+\-@\t\r]/.test(str)) {
    str = "'" + str;
  }
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Validates and bounds extraction parameters.
 *
 * @param {object} params
 * @returns {object} Validated collector options
 */
export function validateExtract(params = {}) {
  const invalid = (message) => {
    throw new ExtractionFailure("extract_params_invalid", message);
  };

  const action = params.action || (params.fields || params.item_selector ? "list" : "table");
  if (!["discover", "table", "list"].includes(action)) {
    invalid("action must be discover, table, or list");
  }

  const bound = (value, fallback, maximum, name, minimum = 1) => {
    if (value === undefined || value === null) return fallback;
    const num = Number(value);
    if (!Number.isSafeInteger(num) || num < minimum || num > maximum) {
      invalid(`${name} must be an integer from ${minimum} to ${maximum}`);
    }
    return num;
  };

  for (const key of ["selector", "ref", "target_id", "item_selector"]) {
    const val = params[key];
    if (val !== undefined && val !== null) {
      if (typeof val !== "string" || !val.trim() || val.length > 2048) {
        invalid(`${key} must be a non-empty string of at most 2048 characters`);
      }
    }
  }

  const targetSpecCount = [params.selector, params.ref, params.target_id, params.target].filter(
    (v) => v !== undefined && v !== null && (typeof v !== "object" || v !== null)
  ).length;
  if (targetSpecCount > 1 && !params.target && !params.selector) {
    invalid("selector, ref, and target_id are mutually exclusive");
  }

  if (action === "discover" && (params.ref !== undefined || params.target_id !== undefined)) {
    invalid("discover accepts a selector scope, not a ref or target_id");
  }

  if (action !== "list" && (params.item_selector !== undefined || params.fields !== undefined)) {
    invalid("item_selector and fields require action=list");
  }

  const maxColumns = bound(params.max_columns, 100, 200, "max_columns");

  let fields = undefined;
  if (params.fields !== undefined && params.fields !== null) {
    if (Array.isArray(params.fields)) {
      if (!params.fields.length || params.fields.length > maxColumns) {
        invalid("fields must be a non-empty array within max_columns");
      }
      const keys = new Set();
      for (const field of params.fields) {
        if (
          !field ||
          typeof field.key !== "string" ||
          !field.key.trim() ||
          field.key.length > 128 ||
          ["__proto__", "constructor", "prototype"].includes(field.key) ||
          keys.has(field.key)
        ) {
          invalid(
            "field keys must be unique non-empty names (reserved object keys are not allowed)"
          );
        }
        keys.add(field.key);
        if (
          typeof field.selector !== "string" ||
          !field.selector.trim() ||
          field.selector.length > 2048
        ) {
          invalid("each field requires a CSS selector");
        }
        if (!["text", "href", "attribute"].includes(field.read)) {
          invalid("field read must be text, href, or attribute");
        }
        if (
          field.name !== undefined &&
          (typeof field.name !== "string" || !field.name.trim() || field.name.length > 500)
        ) {
          invalid("field name must be a non-empty string of at most 500 characters");
        }
        if (field.read === "attribute") {
          if (
            typeof field.attribute !== "string" ||
            !/^[a-zA-Z][a-zA-Z0-9_:.-]{0,127}$/.test(field.attribute)
          ) {
            invalid("attribute reads require a valid attribute name");
          }
        } else if (field.attribute !== undefined) {
          invalid("attribute is only valid for attribute reads");
        }
      }
      fields = params.fields;
    } else if (typeof params.fields === "object") {
      // Convert legacy map { name: selectorOrSpec } into array
      fields = Object.entries(params.fields).map(([key, spec]) => {
        if (typeof spec === "string") {
          return { key, selector: spec, read: "text" };
        }
        return {
          key,
          selector: spec.selector || ":scope",
          read: spec.attr || spec.attribute ? "attribute" : "text",
          attribute: spec.attr || spec.attribute,
          name: spec.name || key,
        };
      });
    }
  } else if (action === "list" && maxColumns < 2) {
    invalid("default list extraction requires two columns");
  }

  const maxRowsInput = params.max_rows !== undefined ? params.max_rows : params.max;
  const maxBytesInput = params.max_bytes !== undefined ? params.max_bytes : undefined;
  const timeoutMsInput = params.timeout_ms !== undefined ? params.timeout_ms : params.timeoutMs;

  return {
    action,
    selector: params.selector,
    target: params.target,
    ref: params.ref,
    target_id: params.target_id,
    item_selector: params.item_selector,
    fields,
    anchored: Boolean(
      params.ref || params.target_id || (params.target && typeof params.target === "object")
    ),
    max_rows: bound(maxRowsInput, 500, 5000, "max_rows"),
    max_columns: maxColumns,
    max_bytes: bound(maxBytesInput, 1048576, 4194304, "max_bytes", 1024),
    timeout_ms: bound(timeoutMsInput, 5000, 15000, "timeout_ms", 100),
    format: params.format || "json",
    csv_safe: params.csv_safe !== false,
  };
}

/**
 * Runs in the page context to collect structured extraction facts.
 * Isolates nested table boundaries, reads live inputs/selects, computes locators,
 * and handles ARIA attributes.
 *
 * @param {Element} [contextElement] - Context root or target element.
 * @param {object} options - Validated options from validateExtract.
 * @param {object} [helpers] - Resolver helpers (resolveTarget, deepQuery).
 * @returns {object} RawCapture facts.
 */
export function collectExtractDom(contextElement, options, helpers = {}) {
  const doc = typeof document !== "undefined" ? document : null;
  const result = {
    frame_url: doc?.URL || "about:blank",
    title: doc?.title || "",
    captured_at: new Date().toISOString(),
    rows: [],
    items: [],
    item_sources: [],
    targets: [],
    truncated: false,
    warnings: [],
    omitted_rows: [],
  };

  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  let work = 0;
  let textBytes = 0;
  const encoder =
    typeof TextEncoder !== "undefined" ? new TextEncoder() : { encode: (s) => Buffer.from(s) };
  const tableSelector = 'table, [role="table"], [role="grid"], [role="treegrid"]';
  const listSelector = 'ul, ol, [role="list"]';
  const hiddenSubtrees = new WeakMap();
  const styles = new WeakMap();

  const styleOf = (element) => {
    if (!element || typeof getComputedStyle === "undefined")
      return { display: "block", visibility: "visible", whiteSpace: "normal" };
    let s = styles.get(element);
    if (!s) {
      try {
        s = getComputedStyle(element);
      } catch {
        s = { display: "block", visibility: "visible", whiteSpace: "normal" };
      }
      styles.set(element, s);
    }
    return s || { display: "block", visibility: "visible", whiteSpace: "normal" };
  };

  const fail = (reason, message) => {
    throw new ExtractionFailure(reason, message);
  };

  const consume = (value) => {
    if (!value) return;
    const len = encoder.encode(value).length;
    if (value.length > options.max_bytes - textBytes || textBytes + len > options.max_bytes) {
      fail("extract_limit", "Text byte budget exceeded");
    }
    textBytes += len;
  };

  const workLimit = Math.min(5000000, 100000 + options.max_rows * (options.max_columns * 6 + 48));

  const tick = () => {
    if (++work > workLimit) fail("extract_limit", "DOM traversal budget exceeded");
    if (work % 64 === 0) {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now - started > options.timeout_ms) {
        fail("extract_limit", "DOM collection deadline exceeded");
      }
    }
  };

  const closedDetailsContent = (element) => {
    const parent = element?.parentElement;
    return (
      parent &&
      parent.tagName === "DETAILS" &&
      !parent.open &&
      element !== parent.querySelector?.(":scope > summary")
    );
  };

  const isSubtreeHidden = (node) => {
    if (!node || !(node instanceof (typeof Element !== "undefined" ? Element : Object)))
      return false;
    const cached = hiddenSubtrees.get(node);
    if (cached !== undefined) return cached;
    const chain = [];
    let current = node;
    let value = false;
    while (current) {
      tick();
      const known = hiddenSubtrees.get(current);
      if (known !== undefined) {
        value = known;
        break;
      }
      chain.push(current);
      const style = styleOf(current);
      const tag = current.tagName ? current.tagName.toLowerCase() : "";
      if (
        (current.hasAttribute && current.hasAttribute("hidden")) ||
        (current.hasAttribute && current.hasAttribute("data-browserctl-overlay")) ||
        (current.hasAttribute && current.hasAttribute("data-bsk-overlay")) ||
        tag === "browserctl-overlay" ||
        tag === "browser-skill-overlay" ||
        closedDetailsContent(current) ||
        style.display === "none" ||
        (style.visibility === "collapse" &&
          /^table-(row|row-group|header-group|footer-group|column|column-group)$/.test(
            style.display
          )) ||
        style.opacity === "0"
      ) {
        value = true;
        break;
      }
      current =
        current.assignedSlot ||
        current.parentElement ||
        (current.getRootNode ? current.getRootNode()?.host : null) ||
        null;
    }
    for (const item of chain) hiddenSubtrees.set(item, value);
    return value;
  };

  const childrenOf = (element) => {
    if (!element) return [];
    if (element.tagName === "SLOT" && typeof element.assignedNodes === "function") {
      return element.assignedNodes({ flatten: true });
    }
    if (element.tagName === "DETAILS" && !element.open) {
      const summary = element.querySelector ? element.querySelector(":scope > summary") : null;
      return summary ? [summary] : [];
    }
    return element.shadowRoot ? element.shadowRoot.childNodes : element.childNodes;
  };

  const isVisibilityHidden = (element) => {
    const v = styleOf(element).visibility;
    return v === "hidden" || v === "collapse";
  };

  const hiddenContent = new WeakMap();
  const isHidden = (root) => {
    if (!root) return true;
    const known = hiddenContent.get(root);
    if (known !== undefined) return known;
    const stack = [{ element: root }];
    while (stack.length) {
      const { element, exit } = stack.pop();
      if (hiddenContent.has(element)) continue;
      tick();
      if (isSubtreeHidden(element)) {
        hiddenContent.set(element, true);
        continue;
      }
      if (!isVisibilityHidden(element)) {
        hiddenContent.set(element, false);
        continue;
      }
      const children = childrenOf(element);
      if (exit) {
        let hidden = true;
        for (let i = 0; i < children.length; i++) {
          if (hiddenContent.get(children[i]) === false) hidden = false;
        }
        hiddenContent.set(element, hidden);
        continue;
      }
      stack.push({ element, exit: true });
      for (let i = children.length - 1; i >= 0; i--) {
        if (children[i] && (children[i].nodeType === 1 || children[i].tagName)) {
          stack.push({ element: children[i] });
        }
      }
    }
    return hiddenContent.get(root) ?? false;
  };

  const renderedSvg = new Set([
    "svg",
    "g",
    "a",
    "switch",
    "text",
    "tspan",
    "textPath",
    "foreignObject",
  ]);

  const text = (root) => {
    if (!root || isSubtreeHidden(root)) return "";
    const pieces = [];
    const push = (v) => {
      consume(v);
      pieces.push(v);
    };
    let pendingSpace = false;
    let pendingBreak = false;
    let lineStart = true;
    const emit = (val) => {
      if (!val) return;
      if (pendingBreak && !lineStart) push("\n");
      else if (pendingSpace && !lineStart && !val.startsWith("\n")) push(" ");
      pendingSpace = false;
      pendingBreak = false;
      push(val);
      lineStart = val.endsWith("\n");
    };
    const newline = () => {
      push("\n");
      pendingBreak = false;
      pendingSpace = false;
      lineStart = true;
    };
    const append = (value, whiteSpace) => {
      if (["pre", "pre-wrap", "break-spaces"].includes(whiteSpace)) {
        emit(value.replace(/\r\n?/g, "\n"));
        return;
      }
      const lines = whiteSpace === "pre-line" ? value.replace(/\r\n?/g, "\n").split("\n") : [value];
      for (const [idx, line] of lines.entries()) {
        if (idx) newline();
        const collapsed = line.replace(/[ \t\r\n\f]+/g, " ");
        if (collapsed.startsWith(" ")) pendingSpace = true;
        emit(collapsed.replace(/^ +| +$/g, ""));
        if (collapsed.endsWith(" ")) pendingSpace = true;
      }
    };

    const stack = [
      { node: root, whiteSpace: styleOf(root).whiteSpace, visible: !isVisibilityHidden(root) },
    ];
    while (stack.length) {
      const { node, whiteSpace, visible, exit } = stack.pop();
      if (node !== root) tick();
      if (exit) {
        pendingBreak = true;
        pendingSpace = false;
        continue;
      }
      if (node.nodeType === 3) {
        // Node.TEXT_NODE
        if (visible) append(node.nodeValue || "", whiteSpace);
        continue;
      }
      if (!node.tagName && node.nodeType !== 1) continue;
      const tag = node.tagName.toUpperCase();
      if (
        isSubtreeHidden(node) ||
        (node.namespaceURI === "http://www.w3.org/2000/svg" && !renderedSvg.has(node.localName)) ||
        (node.matches &&
          node.matches(
            'script, style, template, noscript, input[type="password"], input[type="hidden"]'
          )) ||
        (node !== root && node.matches && node.matches(tableSelector))
      ) {
        continue;
      }
      const nodeVisible = !isVisibilityHidden(node);
      if (tag === "BR") {
        if (nodeVisible) newline();
        continue;
      }
      const style = styleOf(node);
      const block =
        node !== root &&
        /^(block|flow-root|list-item|flex|grid|table|table-row|table-caption)( |$)/.test(
          style.display || ""
        );
      if (block) {
        pendingBreak = true;
        pendingSpace = false;
        stack.push({ node, whiteSpace, visible: nodeVisible, exit: true });
      }
      if (tag === "INPUT") {
        if (nodeVisible && !["checkbox", "radio", "file", "image"].includes(node.type)) {
          append(node.value || "", "pre-wrap");
        }
        continue;
      }
      if (tag === "TEXTAREA") {
        if (nodeVisible) append(node.value || "", "pre-wrap");
        continue;
      }
      if (tag === "SELECT") {
        if (!nodeVisible) continue;
        const optionsList = Array.from(node.selectedOptions || []);
        for (const [idx, opt] of optionsList.entries()) {
          tick();
          if (idx) newline();
          append(opt.label || opt.text || "", "normal");
        }
        continue;
      }
      const children = childrenOf(node);
      if ((!children || children.length === 0) && (node.textContent || node.innerText)) {
        if (nodeVisible) append(node.textContent || node.innerText, style.whiteSpace || "normal");
        continue;
      }
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({
          node: children[i],
          whiteSpace: style.whiteSpace || "normal",
          visible: nodeVisible,
        });
      }
    }
    return pieces.join("");
  };

  const ariaSpan = (cell, name, allowZero = false) => {
    const val = cell.getAttribute ? cell.getAttribute(name) : null;
    if (val === null) return 1;
    const num = Number(val);
    if (/^\d+$/.test(val) && Number.isSafeInteger(num) && num >= (allowZero ? 0 : 1)) {
      return num;
    }
    result.warnings.push(`invalid_${name}`);
    return 1;
  };

  const positions = new WeakMap();
  const siblings = new WeakMap();
  const positionOf = (node) => {
    const known = positions.get(node);
    if (known !== undefined) return known;
    const parent = node.parentNode || node.parentElement;
    if (!parent) return 1;
    if (parent.firstElementChild) {
      let scan = siblings.get(parent);
      if (!scan) {
        scan = { last: null, counts: new Map() };
        siblings.set(parent, scan);
      }
      for (
        let child = scan.last ? scan.last.nextElementSibling : parent.firstElementChild;
        child;
        child = child.nextElementSibling
      ) {
        tick();
        const count = (scan.counts.get(child.tagName) || 0) + 1;
        scan.counts.set(child.tagName, count);
        positions.set(child, count);
        scan.last = child;
        if (child === node) return count;
      }
    }
    if (parent.children) {
      let count = 0;
      for (const child of parent.children) {
        if (child.tagName === node.tagName) count++;
        if (child === node) {
          positions.set(node, count);
          return count;
        }
      }
    }
    return 1;
  };

  const select = (root, selector) => {
    try {
      return Array.from(root.querySelectorAll ? root.querySelectorAll(selector) : []);
    } catch {
      return fail("extract_selector_invalid", `Invalid CSS selector: ${selector}`);
    }
  };

  const ariaIndex = (element, name, fallback) => {
    const raw = element.getAttribute ? element.getAttribute(name) : null;
    if (raw === null) return { value: fallback, explicit: false };
    const trimmed = raw.trim();
    const num = Number(trimmed);
    if (/^\d+$/.test(trimmed) && Number.isSafeInteger(num) && num >= 1) {
      return { value: num, explicit: true };
    }
    result.warnings.push(`invalid_${name}`);
    return { value: fallback, explicit: false };
  };

  const ariaCount = (element, name) => {
    const raw = element.getAttribute ? element.getAttribute(name) : null;
    if (raw === null) return undefined;
    const trimmed = raw.trim();
    const num = Number(trimmed);
    if (/^(-1|\d+)$/.test(trimmed) && Number.isSafeInteger(num)) return num;
    result.warnings.push(`invalid_${name}`);
    return undefined;
  };

  const locator = (element) => {
    const segments = [];
    let node = element;
    for (let depth = 0; node && depth < 32; depth++) {
      tick();
      if (node.id) {
        if (node.id.length > 2048) fail("extract_limit", "Locator ID exceeds metadata budget");
        segments.unshift(
          `#${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(node.id) : node.id}`
        );
        break;
      }
      const pos = positionOf(node);
      segments.unshift(`${(node.tagName || "element").toLowerCase()}:nth-of-type(${pos})`);
      if (!node.parentElement && node.getRootNode && node.getRootNode().host) {
        segments.unshift("::shadow");
        node = node.getRootNode().host;
      } else {
        node = node.parentElement;
      }
    }
    return segments.join(" > ");
  };

  const stop = (reason) => {
    result.truncated = true;
    result.stop_reason = reason;
  };

  const isLimit = (err) => err instanceof ExtractionFailure && err.reason === "extract_limit";
  const limitReason = (err, fallback) =>
    err.message.includes("deadline") ? "time_limit" : fallback;

  const omit = (element, fallback, attribute) => {
    result.omitted_rows.push(ariaIndex(element, attribute, fallback).value);
    result.warnings.push("hidden_rows_omitted");
  };

  try {
    let root =
      contextElement ||
      (options.anchored && typeof contextElement === "object"
        ? contextElement
        : doc?.documentElement);
    if (options.selector) {
      const matches = select(doc || root, options.selector);
      if (matches.length === 0) {
        fail("selector_not_found", "No extraction target matches the selector");
      }
      if (matches.length !== 1) {
        fail("extract_target_ambiguous", "The selector must match exactly one container");
      }
      root = matches[0];
    } else if (options.target && typeof options.target === "string") {
      if (helpers.resolveTarget) {
        root = helpers.resolveTarget({ target: options.target });
      } else {
        const matches = select(doc || root, options.target);
        if (matches.length === 0)
          fail("selector_not_found", "No extraction target matches the selector");
        root = matches[0];
      }
    }

    if (options.action === "discover") {
      const stack = [root];
      const tables = [];
      const lists = [];
      let found = 0;
      try {
        while (stack.length) {
          tick();
          const el = stack.pop();
          if (isHidden(el)) continue;
          if (
            el.matches &&
            el.matches(`${tableSelector}, ${listSelector}`) &&
            !["presentation", "none"].includes(el.getAttribute?.("role") || "")
          ) {
            found++;
            const candidates = el.matches(tableSelector) ? tables : lists;
            if (tables.length === 32) {
              stop("target_limit");
              break;
            }
            if (candidates.length < 32) {
              const columns = [];
              for (const header of select(el, 'th, [role="columnheader"]')) {
                if (columns.length >= 8) break;
                if ((header.closest && header.closest(tableSelector) !== el) || isHidden(header))
                  continue;
                const role = header.getAttribute?.("role");
                const scope = header.getAttribute?.("scope") || "";
                const row = header.closest ? header.closest('tr, [role="row"]') : null;
                const columnHeader =
                  role === "columnheader" ||
                  (role !== "rowheader" &&
                    !["row", "rowgroup"].includes(scope) &&
                    ((header.closest && header.closest("thead") !== null) ||
                      ["col", "colgroup"].includes(scope) ||
                      !(row && row.querySelector?.('td, [role="cell"], [role="gridcell"]'))));
                if (columnHeader) columns.push(text(header));
              }
              const caption = el.caption ? el.caption : null;
              const label =
                el.getAttribute?.("aria-label") ||
                (caption ? text(caption) : "") ||
                el.id ||
                el.tagName.toLowerCase();
              candidates.push({
                kind: el.matches(tableSelector) ? "table" : "list",
                name: label.slice(0, 500),
                columns,
                target_id: el.id ? `#${el.id}` : `xt_${candidates.length + 1}`,
              });
            }
          }
          const children = childrenOf(el);
          for (let i = children.length - 1; i >= 0; i--) {
            if (children[i] && (children[i].nodeType === 1 || children[i].tagName)) {
              stack.push(children[i]);
            }
          }
        }
      } catch (err) {
        if (!isLimit(err)) throw err;
        stop(limitReason(err, "traversal_limit"));
      }
      result.targets = [...tables, ...lists].slice(0, 32);
      if (!result.truncated && found > 32) stop("target_limit");
      return result;
    }

    if (!options.anchored && !options.selector && !options.target) {
      if (
        root &&
        root.matches &&
        root.matches(options.action === "table" ? tableSelector : listSelector)
      ) {
        // root is already the targeted container
      } else {
        const matches = select(root, options.action === "table" ? tableSelector : listSelector);
        let selected = undefined;
        for (const node of matches) {
          tick();
          if (
            isHidden(node) ||
            ["presentation", "none"].includes(node.getAttribute?.("role") || "")
          ) {
            continue;
          }
          if (selected) {
            fail(
              "extract_target_ambiguous",
              "Multiple containers found; use discover or a selector"
            );
          }
          selected = node;
        }
        if (!selected) fail("selector_not_found", "No extractable container found");
        root = selected;
      }
    }

    if (isHidden(root)) fail("extract_target_hidden", "The extraction container is hidden");

    for (const [attr, field] of [
      ["aria-rowcount", "declared_rows"],
      ["aria-colcount", "declared_columns"],
    ]) {
      const count = ariaCount(root, attr);
      if (count !== undefined) result[field] = count;
    }

    if (options.action === "list") {
      const fields = options.fields || [
        { key: "text", name: "Text", selector: ":scope", read: "text" },
        { key: "url", name: "URL", selector: "a[href]", read: "href" },
      ];
      const nodes = options.item_selector
        ? select(root, options.item_selector)
        : select(root, 'li, [role="listitem"]');
      let sourceRow = 0;
      for (const item of nodes) {
        try {
          tick();
          if (!options.item_selector && item.closest && item.closest(listSelector) !== root)
            continue;
          sourceRow++;
          if (isHidden(item)) {
            omit(item, sourceRow, "aria-posinset");
            continue;
          }
          if (result.items.length === options.max_rows) {
            stop("row_limit");
            break;
          }
          const rowObj = {};
          const position = ariaIndex(item, "aria-posinset", sourceRow).value;
          const count = ariaCount(item, "aria-setsize");
          if (count !== undefined) {
            result.declared_rows =
              result.declared_rows === undefined
                ? count
                : result.declared_rows === -1 || count === -1
                  ? -1
                  : Math.max(result.declared_rows, count);
          }
          for (const f of fields) {
            const matches = f.selector === ":scope" ? [item] : select(item, f.selector);
            const visible = [];
            for (const m of matches) {
              tick();
              if (!isHidden(m)) visible.push(m);
              if (visible.length > 1) break;
            }
            if (visible.length > 1 && !options.fields && f.key === "url") {
              rowObj[f.key] = null;
              result.warnings.push("ambiguous_default_url");
              continue;
            }
            if (visible.length > 1) {
              fail("extract_field_ambiguous", `Field ${f.key} matches multiple elements`);
            }
            const el = visible[0];
            if (!el || (el.matches && el.matches('input[type="password"], input[type="hidden"]'))) {
              rowObj[f.key] = null;
              continue;
            }
            if (f.read === "text") {
              rowObj[f.key] = text(el);
            } else {
              const val = el.getAttribute
                ? el.getAttribute(f.read === "href" ? "href" : f.attribute)
                : null;
              if (val !== null) consume(val);
              if (f.read === "href" && val !== null) {
                try {
                  rowObj[f.key] = new URL(
                    val,
                    el.baseURI || doc?.baseURI || "http://localhost"
                  ).href;
                } catch {
                  rowObj[f.key] = val;
                  result.warnings.push("invalid_link_url");
                }
              } else {
                rowObj[f.key] = val;
              }
            }
          }
          result.items.push(rowObj);
          result.item_sources.push({
            row: result.items.length - 1,
            source_row: position,
            row_kind: "data",
            locator: locator(item),
          });
        } catch (err) {
          if (isLimit(err) && result.items.length) {
            stop(limitReason(err, "collection_limit"));
            break;
          }
          throw err;
        }
      }
      return result;
    }

    if (!root.matches || !root.matches(tableSelector)) {
      fail("extract_structure_invalid", "Target is not an HTML or ARIA table/grid");
    }

    const native = root.tagName === "TABLE";
    result.aria_rows = !native;
    const rawRows = native ? root.rows || select(root, "tr") : select(root, '[role="row"]');
    const groups = new Map();
    let dataRows = 0;
    const dataPositions = new Set();
    let sawData = false;
    let ownedRows = 0;

    for (let i = 0; i < rawRows.length; i++) {
      try {
        tick();
        const rowEl = rawRows[i];
        if (rowEl.closest && rowEl.closest(tableSelector) !== root) continue;
        ownedRows++;
        if (isHidden(rowEl)) {
          omit(rowEl, ownedRows, "aria-rowindex");
          continue;
        }
        const pos = ariaIndex(rowEl, "aria-rowindex", ownedRows);
        const sourceRow = pos.value;
        if (pos.explicit) result.aria_rows = true;

        if (dataRows === options.max_rows && !dataPositions.has(sourceRow)) {
          if (native) {
            stop("row_limit");
            break;
          }
          if (rowEl.querySelector && !rowEl.querySelector('[role="columnheader"]')) {
            stop("row_limit");
            continue;
          }
        }

        const rawCells =
          native && rowEl.cells
            ? rowEl.cells
            : select(
                rowEl,
                '[role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"], td, th'
              );

        const cells = [];
        const groupEl = native
          ? rowEl.parentElement
          : rowEl.closest
            ? rowEl.closest('[role="rowgroup"]')
            : null;
        if (!groups.has(groupEl)) groups.set(groupEl, groups.size);
        const headerGroup = groupEl?.tagName === "THEAD";
        const footerGroup = groupEl?.tagName === "TFOOT";

        for (let c = 0; c < rawCells.length; c++) {
          tick();
          const cell = rawCells[c];
          if (cell.closest && cell.closest(native ? "tr" : '[role="row"]') !== rowEl) continue;
          if (cells.length === options.max_columns) fail("extract_limit", "Column budget exceeded");

          const scope = (cell.getAttribute && cell.getAttribute("scope")) || "";
          if (
            (cell.id && cell.id.length > 2048) ||
            ((cell.getAttribute && cell.getAttribute("headers")?.length) || 0) > 8192 ||
            scope.length > 128
          ) {
            fail("extract_limit", "Cell attributes exceed metadata budget");
          }

          const role = cell.getAttribute ? cell.getAttribute("role") : null;
          const header =
            role === "columnheader" ||
            ((headerGroup || cell.tagName === "TH") &&
              !["row", "rowgroup"].includes(scope) &&
              role !== "rowheader");

          const indexSource =
            cell.hasAttribute && cell.hasAttribute("aria-colindex")
              ? cell
              : c === 0 && rowEl.hasAttribute && rowEl.hasAttribute("aria-colindex")
                ? rowEl
                : null;
          const colIdx = indexSource && ariaIndex(indexSource, "aria-colindex", 0);

          let rowSpanVal = 1;
          let colSpanVal = 1;
          if (cell.getAttribute) {
            const rawRs = cell.getAttribute("rowspan");
            if (rawRs === "0") rowSpanVal = 0;
            else if (rawRs != null) rowSpanVal = Math.max(1, parseInt(rawRs, 10) || 1);
            else rowSpanVal = ariaSpan(cell, "aria-rowspan", true);

            const rawCs = cell.getAttribute("colspan");
            if (rawCs != null) colSpanVal = Math.max(1, parseInt(rawCs, 10) || 1);
            else colSpanVal = ariaSpan(cell, "aria-colspan");
          }

          cells.push({
            text: isHidden(cell) ? null : text(cell),
            id: cell.id || "",
            headers: (cell.getAttribute?.("headers") || "").split(/\s+/).filter(Boolean),
            scope: role === "rowheader" ? "row" : scope,
            header,
            row_span: rowSpanVal,
            column_span: colSpanVal,
            ...(colIdx?.explicit ? { column_index: colIdx.value } : {}),
          });
        }

        const isHeader =
          headerGroup ||
          ((!native || !sawData) &&
            cells.some((cell) => cell.header) &&
            cells.every((cell) => cell.header || !cell.text));

        if (!isHeader && !dataPositions.has(sourceRow) && dataRows === options.max_rows) {
          stop("row_limit");
          if (native) break;
          continue;
        }

        if (isHeader && result.rows.filter((r) => r.kind === "header").length >= 32) {
          fail("extract_limit", "Header row budget exceeded");
        }

        result.rows.push({
          cells,
          source_row: sourceRow,
          group: groups.get(groupEl) || 0,
          kind: isHeader ? "header" : footerGroup ? "footer" : "data",
          locator: locator(rowEl),
          indexed: pos.explicit,
        });

        if (!isHeader) {
          dataPositions.add(sourceRow);
          dataRows = dataPositions.size;
          sawData = true;
        }
      } catch (err) {
        if (isLimit(err) && dataRows) {
          if (result.stop_reason !== "row_limit") stop(limitReason(err, "collection_limit"));
          break;
        }
        throw err;
      }
    }

    return result;
  } catch (err) {
    if (err instanceof ExtractionFailure) {
      result.error = { reason: err.reason, message: err.message };
      return result;
    }
    const msg = err instanceof Error ? err.message : String(err);
    result.error = { reason: "extract_structure_invalid", message: msg };
    return result;
  }
}

/**
 * Normalizes raw captured extraction facts into canonical rectangular ExtractResult.
 * Resolves 2D matrix, multi-level headers, cell spans, and joined split rows.
 *
 * @param {object} raw - Output of collectExtractDom.
 * @param {object} options - Validated options.
 * @param {number} [tabId=1] - Tab ID.
 * @param {object} [source={}] - Source metadata.
 * @returns {object} Canonical ExtractResult.
 */
export function normalizeExtract(raw, options, tabId = 1, source = {}) {
  const result = {
    schema_version: 1,
    kind: options.action,
    tab_id: tabId,
    source: {
      page_url: source.page_url || "",
      frame_url: raw.frame_url || "",
      frame_id: source.frame_id || "root",
      title: raw.title || "",
      captured_at: raw.captured_at || new Date().toISOString(),
      ...(options.selector ? { selector: options.selector } : {}),
    },
    columns: [],
    rows: [],
    row_sources: [],
    spans: [],
    coverage: {
      scope: "loaded_dom",
      rows_returned: 0,
      truncated: Boolean(raw.truncated),
      dataset_complete: raw.truncated ? "incomplete" : "unknown",
      ...(raw.stop_reason ? { stop_reason: raw.stop_reason } : {}),
      ...(raw.declared_rows !== undefined ? { declared_rows: raw.declared_rows } : {}),
      ...(raw.declared_columns !== undefined ? { declared_columns: raw.declared_columns } : {}),
    },
    warnings: [...new Set(raw.warnings || [])],
  };

  const positions = (visible) =>
    [...new Set([...visible, ...(raw.omitted_rows || [])])].sort((a, b) => a - b);
  const hasGaps = (indices) => indices.some((val, idx) => val !== (idx ? indices[idx - 1] + 1 : 1));

  if (options.action === "list") {
    const fields = options.fields || [
      { key: "text", name: "Text" },
      { key: "url", name: "URL" },
    ];
    result.columns = fields.map((f) => ({
      key: f.key,
      name: f.name || f.key,
      header_path: [],
      name_source: "field",
    }));

    const order = (raw.item_sources || [])
      .map((src, idx) => ({ source: src, index: idx }))
      .sort((a, b) => a.source.source_row - b.source.source_row);

    if (order.some(({ index }, pos) => index !== pos)) {
      result.warnings.push("aria_rows_reordered");
    }
    if (
      order.some(
        ({ source: s }, pos) => pos > 0 && s.source_row === order[pos - 1].source.source_row
      )
    ) {
      result.warnings.push("duplicate_item_positions");
    }

    result.rows = order.map(({ index }) => raw.items[index]);
    result.row_sources = order.map(({ source: s }, rowIdx) => ({ ...s, row: rowIdx }));

    const indices = positions((raw.item_sources || []).map((r) => r.source_row));
    if (
      hasGaps(indices) ||
      (raw.declared_rows !== undefined &&
        (raw.declared_rows === -1 || raw.declared_rows > indices.length))
    ) {
      result.coverage.dataset_complete = "incomplete";
      result.warnings.push("partial_dom_dataset");
    }
  } else if (options.action === "table") {
    let rows = raw.rows || [];
    if (raw.aria_rows) {
      if (rows.some((row, idx) => idx > 0 && row.source_row < rows[idx - 1].source_row)) {
        result.warnings.push("aria_rows_reordered");
      }
      const ordered = [...rows].sort((a, b) => a.source_row - b.source_row);
      const groups = new Map();
      const getGroup = (val) => {
        let curr = val;
        while (groups.has(curr)) curr = groups.get(curr);
        return curr;
      };
      const merged = [];
      for (const row of ordered) {
        const prev = merged[merged.length - 1];
        if (!prev || prev.source_row !== row.source_row) {
          merged.push({ ...row, cells: [...row.cells] });
          continue;
        }
        if (
          !prev.indexed ||
          !row.indexed ||
          prev.kind !== row.kind ||
          [...prev.cells, ...row.cells].some((cell) => cell.column_index === undefined)
        ) {
          throw new ExtractionFailure("extract_structure_invalid", "Ambiguous ARIA row fragments");
        }
        if (prev.cells.length + row.cells.length > options.max_columns) {
          throw new ExtractionFailure("extract_limit", "Merged ARIA row exceeds max_columns");
        }
        const from = getGroup(row.group);
        const to = getGroup(prev.group);
        if (from !== to) groups.set(from, to);
        prev.cells.push(...row.cells);
        prev.locator += ` | ${row.locator}`;
        result.warnings.push("split_aria_rows_merged");
      }
      rows = merged.map((row) => ({ ...row, group: getGroup(row.group) }));
    }

    const active = [];
    const matrix = [];
    const groupEnds = new Map();
    const headers = new Map();

    for (const row of rows) {
      groupEnds.set(row.group, Math.max(groupEnds.get(row.group) || 0, row.source_row));
      for (const cell of row.cells) {
        if (cell.id) headers.set(cell.id, cell);
      }
    }

    let width = 0;
    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx];
      const slots = [];
      for (let c = 0; c < active.length; c++) {
        const slot = active[c];
        if (slot && slot.group === row.group && slot.end >= row.source_row) {
          slots[c] = slot;
        } else {
          active[c] = undefined;
        }
      }
      let cursor = 0;
      for (const cell of row.cells) {
        if (cell.column_index !== undefined) {
          cursor = cell.column_index - 1;
        } else {
          while (slots[cursor]) cursor++;
        }
        if (cursor < 0 || cursor + cell.column_span > options.max_columns) {
          throw new ExtractionFailure("extract_limit", "Logical table width exceeds max_columns");
        }
        const groupMaxEnd = groupEnds.get(row.group) || row.source_row;
        const end = Math.min(
          groupMaxEnd,
          cell.row_span === 0 ? groupMaxEnd : row.source_row + cell.row_span - 1
        );
        const slot = { cell, row: rIdx, column: cursor, end, group: row.group };
        for (let c = cursor; c < cursor + cell.column_span; c++) {
          if (slots[c]) {
            throw new ExtractionFailure(
              "extract_structure_invalid",
              "Overlapping table cells or ARIA indices"
            );
          }
          slots[c] = slot;
          if (end > row.source_row) active[c] = slot;
        }
        cursor += cell.column_span;
      }
      width = Math.max(width, slots.length);
      matrix.push(slots);
    }

    for (let c = 0; c < width; c++) {
      const path = [];
      const seen = new Set();
      for (let rIdx = 0; rIdx < rows.length; rIdx++) {
        if (rows[rIdx].kind !== "header") continue;
        const cell = matrix[rIdx]?.[c]?.cell;
        if (cell?.text && cell.header && !seen.has(cell)) {
          path.push(cell.text);
          seen.add(cell);
        }
      }
      const associations = rows.flatMap((row, rIdx) => {
        if (row.kind === "header") return [];
        const cell = matrix[rIdx]?.[c]?.cell;
        if (!cell?.headers?.length) return [];
        const names = cell.headers
          .map((id) => headers.get(id))
          .filter((h) => h?.header && h.text)
          .map((h) => h.text);
        return names.length ? [names] : [];
      });
      const explicit = associations[0];
      if (
        explicit &&
        associations.some((names) => JSON.stringify(names) !== JSON.stringify(explicit))
      ) {
        result.warnings.push("varying_cell_header_associations");
      }
      const headerPath = explicit || path;
      const column = {
        key: `c${c + 1}`,
        name: headerPath.length ? headerPath.join(" / ") : `Column ${c + 1}`,
        header_path: headerPath,
        name_source: headerPath.length ? "header" : "generated",
      };
      result.columns.push(column);
    }

    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx];
      if (row.kind === "header") continue;
      const output = {};
      for (let c = 0; c < width; c++) {
        const slot = matrix[rIdx]?.[c];
        const key = result.columns[c].key;
        output[key] = slot?.row === rIdx && slot.column === c ? slot.cell.text : null;
        if (slot?.row === rIdx && slot.column === c) {
          const rowSpan =
            slot.cell.row_span === 0 ? slot.end - row.source_row + 1 : slot.cell.row_span;
          if (slot.cell.row_span === 0 && raw.truncated) {
            result.warnings.push("rowspan_zero_extent_truncated");
          }
          if (rowSpan > 1 || slot.cell.column_span > 1) {
            result.spans.push({
              row: result.rows.length,
              column: key,
              row_span: rowSpan,
              column_span: slot.cell.column_span,
            });
          }
        }
      }
      result.row_sources.push({
        row: result.rows.length,
        source_row: row.source_row,
        row_kind: row.kind,
        locator: row.locator,
      });
      result.rows.push(output);
    }

    if (result.columns.some((col) => col.name_source === "generated")) {
      result.warnings.push("generated_column_names");
    }

    const indices = positions(rows.map((r) => r.source_row));
    if (
      hasGaps(indices) ||
      (raw.declared_rows !== undefined &&
        (raw.declared_rows === -1 || raw.declared_rows > indices.length)) ||
      (raw.declared_columns !== undefined &&
        (raw.declared_columns === -1 || raw.declared_columns > width))
    ) {
      result.coverage.dataset_complete = "incomplete";
      result.warnings.push("partial_dom_dataset");
    }
  }

  result.coverage.rows_returned = result.rows.length;
  result.warnings = [...new Set(result.warnings)];
  return result;
}

/**
 * Truncates rows using binary search to strictly fit within maxBytes.
 * Guarantees atomic complete rows.
 *
 * @param {object} result - ExtractResult.
 * @param {number} maxBytes - Maximum allowed UTF-8 bytes.
 * @returns {object} Truncated ExtractResult.
 */
export function fitExtractBudget(result, maxBytes) {
  const encoder =
    typeof TextEncoder !== "undefined" ? new TextEncoder() : { encode: (s) => Buffer.from(s) };
  const byteSize = () => encoder.encode(JSON.stringify(result)).length;
  if (byteSize() <= maxBytes) return result;

  result.coverage.truncated = true;
  result.coverage.dataset_complete = "incomplete";
  result.coverage.stop_reason = "byte_limit";

  const rows = result.rows;
  const sources = result.row_sources;
  const spans = result.spans;
  let low = 0;
  let high = rows.length;

  const use = (count) => {
    result.rows = rows.slice(0, count);
    result.row_sources = sources.slice(0, count);
    result.spans = spans.filter((span) => span.row < count);
    result.coverage.rows_returned = count;
  };

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    use(mid);
    if (byteSize() <= maxBytes) low = mid;
    else high = mid - 1;
  }
  use(low);

  if ((rows.length && !low) || byteSize() > maxBytes) {
    throw new ExtractionFailure(
      "extract_limit",
      "Metadata or the first complete row exceeds max_bytes"
    );
  }
  return result;
}

/**
 * High-level structured extraction entry point executing validate -> collect -> normalize -> fitBudget.
 *
 * @param {object} params - Extract parameters.
 * @param {object} [context] - Context with resolveTarget, tabId, etc.
 * @returns {object} Canonical ExtractResult.
 */
export function structuredExtract(params = {}, context = {}) {
  const options = validateExtract(params);
  let targetEl = null;

  if (params.target && typeof params.target === "object") {
    targetEl = params.target;
  } else if (context.resolveTarget && (params.target || params.ref)) {
    targetEl = context.resolveTarget({ target: params.target || params.ref });
  } else if (params.selector && typeof document !== "undefined") {
    targetEl = document.querySelector(params.selector);
  } else if (context.deepQuery && params.selector) {
    targetEl = context.deepQuery(params.selector);
  }

  const raw = collectExtractDom(targetEl, options, context);
  if (raw.error) {
    throw new ExtractionFailure(raw.error.reason, raw.error.message);
  }

  const tabId = context.tabId || 1;
  const source = {
    page_url: typeof document !== "undefined" ? document.URL : "",
    frame_url: raw.frame_url || "",
    frame_id: "root",
    title: raw.title || "",
    captured_at: raw.captured_at,
    selector: options.selector,
  };

  const normalized = normalizeExtract(raw, options, tabId, source);
  const fitted = fitExtractBudget(normalized, options.max_bytes);

  if (options.format === "csv") {
    const headerLine = fitted.columns.map((col) => sanitizeCsvValue(col.name, false)).join(",");
    const dataLines = fitted.rows.map((row) =>
      fitted.columns.map((col) => sanitizeCsvValue(row[col.key], options.csv_safe)).join(",")
    );
    fitted.csv = [headerLine, ...dataLines].join("\n");
  }

  return fitted;
}

/**
 * Reconciles multi-row (rowspan) and multi-column (colspan) cell spans into a
 * normalized 2D rectangular grid. Preserved for backward compatibility.
 * Filters out nested table rows so sub-tables do not pollute outer matrix.
 *
 * @param {Element} tableElement - <table> element or container.
 * @param {object} [options]
 * @param {number} [options.max_rows=500]
 * @param {number} [options.max_cols=100]
 * @returns {{ matrix: Array<Array<string>>, totalRows: number, totalCols: number, hasTh: boolean, rows: Array<Element> }}
 */
export function reconcileTableMatrix(tableElement, { max_rows = 500, max_cols = 100 } = {}) {
  let table = tableElement;
  if (table && table.tagName && table.tagName.toLowerCase() !== "table") {
    const nested = table.querySelector ? table.querySelector("table") : null;
    if (nested) table = nested;
  }

  const tableSelector = 'table, [role="table"], [role="grid"], [role="treegrid"]';
  const allRows = Array.from(table?.querySelectorAll ? table.querySelectorAll("tr") : []);
  const rows = allRows
    .filter((r) => !r.closest || r.closest(tableSelector) === table)
    .slice(0, max_rows);

  const matrix = [];
  let totalCols = 0;

  for (let r = 0; r < rows.length; r++) {
    if (!matrix[r]) matrix[r] = [];
    const tr = rows[r];
    const cells = Array.from(tr.children || []).filter(
      (el) => el.tagName === "TH" || el.tagName === "TD"
    );
    let colIdx = 0;

    for (const cell of cells) {
      while (matrix[r][colIdx] !== undefined) {
        colIdx++;
      }
      if (colIdx >= max_cols) break;

      const rowspan = Math.max(1, parseInt(cell.getAttribute?.("rowspan") || "1", 10));
      const colspan = Math.max(1, parseInt(cell.getAttribute?.("colspan") || "1", 10));
      const text = (cell.innerText || cell.textContent || "").trim();

      for (let dr = 0; dr < rowspan; dr++) {
        const targetR = r + dr;
        if (!matrix[targetR]) matrix[targetR] = [];
        for (let dc = 0; dc < colspan; dc++) {
          const targetC = colIdx + dc;
          if (targetC < max_cols) {
            matrix[targetR][targetC] = text;
            if (targetC + 1 > totalCols) totalCols = targetC + 1;
          }
        }
      }
      colIdx += colspan;
    }
  }

  const hasTh = Boolean(rows[0] && rows[0].querySelector?.("th"));
  return {
    matrix,
    totalRows: matrix.length,
    totalCols,
    hasTh,
    rows,
  };
}

/**
 * High-level extract_table handler for extracting structured data from DOM tables.
 * Maintains full backward compatibility with legacy tests while also supporting
 * rich metadata (columns, row_sources, spans, coverage).
 *
 * @param {object} params
 * @param {Element|string} [params.target]
 * @param {string} [params.selector]
 * @param {boolean} [params.csv_safe=true]
 * @param {number} [params.max_rows=500]
 * @param {number} [params.max_cols=100]
 * @param {string} [params.format="json"] - "json" | "csv"
 * @param {object} [context] - Injected resolver helpers if called from content script
 * @returns {object} { table_ref, headers, rows, total_rows, total_cols, csv? }
 */
export function extract_table(
  {
    target,
    selector,
    csv_safe: safeCsv = true,
    max_rows = 500,
    max_cols = 100,
    format = "json",
  } = {},
  context = {}
) {
  let table = null;
  if (target && typeof target === "object") {
    table = target;
  } else if (context.resolveTarget && target) {
    table = context.resolveTarget({ target });
  } else if (context.deepQuery && selector) {
    table = context.deepQuery(selector);
  } else if (typeof document !== "undefined") {
    if (selector) table = document.querySelector(selector);
    else if (target && typeof target === "string") table = document.querySelector(target);
  }

  if (!table) {
    const err = new Error("table element not found");
    err.code = "ELEMENT_NOT_FOUND";
    err.details = { target: target || selector };
    throw err;
  }

  const { matrix, totalCols, hasTh } = reconcileTableMatrix(table, {
    max_rows,
    max_cols,
  });

  if (matrix.length === 0) {
    return {
      table_ref:
        "@" + (context.getOrAssignRef ? context.getOrAssignRef(table) : table.__ref || "e1"),
      headers: [],
      rows: [],
      total_rows: 0,
      total_cols: 0,
    };
  }

  let headers = [];
  let startRow = 0;

  if (hasTh) {
    headers = (matrix[0] || []).map((h, i) => (h && h.trim() ? h.trim() : `col_${i + 1}`));
    startRow = 1;
  } else {
    headers = Array.from({ length: totalCols }, (_, i) => `col_${i + 1}`);
  }

  const resultRows = [];
  for (let r = startRow; r < matrix.length; r++) {
    const rowObj = {};
    const rowArr = matrix[r] || [];
    for (let c = 0; c < totalCols; c++) {
      const key = headers[c] || `col_${c + 1}`;
      const rawVal = rowArr[c] !== undefined ? rowArr[c] : null;
      rowObj[key] = rawVal;
    }
    resultRows.push(rowObj);
  }

  let csvOutput = undefined;
  if (format === "csv") {
    const headerLine = headers.map((h) => sanitizeCsvValue(h, false)).join(",");
    const dataLines = resultRows.map((row) =>
      headers.map((h) => sanitizeCsvValue(row[h], safeCsv)).join(",")
    );
    csvOutput = [headerLine, ...dataLines].join("\n");
  }

  const ref = context.getOrAssignRef ? context.getOrAssignRef(table) : table.__ref || "e1";

  return {
    table_ref: "@" + (ref.startsWith("e") ? ref : "e" + ref),
    headers,
    rows: resultRows,
    total_rows: resultRows.length,
    total_cols: totalCols,
    ...(csvOutput !== undefined ? { csv: csvOutput } : {}),
  };
}
