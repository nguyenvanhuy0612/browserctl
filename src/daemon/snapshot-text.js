// @ts-check
// Operations on Playwright's aria snapshot text (one node per line, "- " items indented by two
// spaces): nesting frame snapshots, and compaction (specs/tools/snapshot.md).

/** @typedef {{line: string, children: Node[]}} Node */

/** @param {string} text @returns {Node[]} */
export function parse(text) {
  /** @type {Node[]} */
  const roots = [];
  /** @type {{indent: number, node: Node}[]} */
  const stack = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const node = { line: raw.trimStart(), children: [] };
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else roots.push(node);
    stack.push({ indent, node });
  }
  return roots;
}

/** @param {Node[]} nodes @param {number} [depth] @returns {string} */
export function render(nodes, depth = 0) {
  return nodes.map((n) => "  ".repeat(depth) + n.line + (n.children.length ? "\n" + render(n.children, depth + 1) : "")).join("\n");
}

/** @param {string} line */
export function refOf(line) {
  return /\[ref=((?:f\d+)?e\d+)\]/.exec(line)?.[1] ?? null;
}

/** @param {string} line */
function role(line) {
  return /^- ([a-z/]+)/.exec(line)?.[1] ?? "";
}

// A wrapper adds nothing: generic, no name, no state besides its ref, no text of its own.
/** @param {Node} node */
function isWrapper(node) {
  const match = /^- generic((?: \[[^\]]+\])*):?$/.exec(node.line);
  if (!match) return false;
  const attributes = match[1].match(/\[[^\]]+\]/g) ?? [];
  return attributes.every((a) => a.startsWith("[ref="));
}

/** @param {Node} node */
function shape(node) {
  return role(node.line) + "(" + node.children.map((c) => role(c.line)).join(",") + ")";
}

/**
 * Removes wrapper nodes and folds long runs of same-shaped siblings.
 * @param {Node[]} nodes
 * @param {{folded: number}} stats
 * @param {string | null} parentRef
 * @returns {Node[]}
 */
function compactNodes(nodes, stats, parentRef) {
  /** @type {Node[]} */
  const flat = [];
  for (const node of nodes) {
    const ref = refOf(node.line) ?? parentRef;
    const children = compactNodes(node.children, stats, ref);
    if (isWrapper(node) && children.length > 0) flat.push(...children);
    else if (!(isWrapper(node) && children.length === 0)) flat.push({ line: node.line, children });
  }
  /** @type {Node[]} */
  const out = [];
  for (let i = 0; i < flat.length; ) {
    let j = i + 1;
    while (j < flat.length && shape(flat[j]) === shape(flat[i])) j++;
    const run = flat.slice(i, j);
    if (run.length > 10) {
      const hidden = run.slice(5, run.length - 2);
      stats.folded += hidden.length;
      const refs = hidden.map((n) => refOf(n.line)).filter(Boolean);
      const range = refs.length ? `, refs ${refs[0]}..${refs[refs.length - 1]}` : "";
      const how = parentRef ? `snapshot({target: "${parentRef}", full: true}) or read({target: "${parentRef}"})` : "snapshot({full: true}) or read()";
      out.push(...run.slice(0, 5), { line: `- (${hidden.length} more ${role(run[0].line) || "items"}${range}: ${how})`, children: [] }, ...run.slice(-2));
    } else out.push(...run);
    i = j;
  }
  return out;
}

const INTERACTIVE = new Set(["link", "button", "menuitem", "tab", "checkbox", "radio", "switch", "option", "textbox", "combobox"]);

/** Per-line rules: long URLs lose their query, redundant cursor markers go. @param {Node[]} nodes */
function trimLines(nodes) {
  for (const node of nodes) {
    const url = /^- \/url: (.*)$/.exec(node.line);
    if (url && url[1].length > 100) {
      const q = url[1].indexOf("?");
      const kept = q > 0 ? url[1].slice(0, q) : url[1];
      node.line = `- /url: ${kept.length > 100 ? kept.slice(0, 100) + "…" : kept}${q > 0 ? "?…" : ""}`;
    }
    if (INTERACTIVE.has(role(node.line))) node.line = node.line.replace(" [cursor=pointer]", "");
    trimLines(node.children);
  }
  return nodes;
}

/** @param {string} text */
export function compact(text) {
  const stats = { folded: 0 };
  const result = render(trimLines(compactNodes(parse(text), stats, null)));
  return { text: result, folded: stats.folded };
}

/**
 * Puts each frame's snapshot under the line of its iframe element.
 * @param {string} text
 * @param {Map<string, string>} frames iframe ref -> that frame's snapshot text
 */
export function nestFrames(text, frames) {
  /** @param {Node[]} nodes */
  const visit = (nodes) => {
    for (const node of nodes) {
      const ref = refOf(node.line);
      const inner = ref ? frames.get(ref) : undefined;
      if (inner !== undefined) {
        if (!node.line.endsWith(":")) node.line += ":";
        node.children.push(...parse(inner));
      }
      visit(node.children);
    }
  };
  const roots = parse(text);
  visit(roots);
  return render(roots);
}

/**
 * Cuts to `maxChars` at a line boundary; depth is cut by Playwright already.
 * @param {string} text
 * @param {number} maxChars
 */
export function cut(text, maxChars) {
  if (text.length <= maxChars) return { text, cutChars: 0 };
  const end = text.lastIndexOf("\n", maxChars);
  const kept = text.slice(0, end > 0 ? end : maxChars);
  const cutChars = text.length - kept.length;
  return { text: `${kept}\n- (${cutChars} more characters: raise maxChars, snapshot a part with target, or read() for the text)`, cutChars };
}
