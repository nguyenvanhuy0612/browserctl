// @ts-check
// Operations on Playwright's aria snapshot text (one node per line, "- " items indented by two
// spaces): nesting frame snapshots, and compaction (specs/tools/snapshot.md).

/** @typedef {{line: string, children: Node[]}} Node */
/** @typedef {{folded: number, textFolded: number, maxText: number}} Stats */

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

// ---------- YAML-safe lines (Playwright's quoting rules, ariaSnapshotRenderer) ----------

/** @param {string} str */
function needsQuotes(str) {
  if (str.length === 0) return true;
  if (/^\s|\s$/.test(str)) return true;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(str)) return true;
  if (/^-/.test(str)) return true;
  if (/[\n:](\s|$)/.test(str)) return true;
  if (/\s#/.test(str)) return true;
  if (/[\n\r]/.test(str)) return true;
  if (/^[&*\],?!>|@"'#%]/.test(str)) return true;
  if (/[{}`]/.test(str)) return true;
  if (/^\[/.test(str)) return true;
  if (!isNaN(Number(str)) || ["y", "n", "yes", "no", "true", "false", "on", "off", "null", "~"].includes(str.toLowerCase())) return true;
  return /^[-+]?\.(inf|nan)$/i.test(str);
}

/** @param {string} key */
const escapeKey = (key) => (needsQuotes(key) ? `'${key.replace(/'/g, "''")}'` : key);

/** @param {string} value */
const escapeValue = (value) =>
  needsQuotes(value)
    ? '"' + value.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, (c) => ({ "\\": "\\\\", '"': '\\"', "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" })[c] ?? "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0")) + '"'
    : value;

/** @param {string} raw a double-quoted YAML scalar */
function unescapeValue(raw) {
  return raw.slice(1, -1).replace(/\\(x[0-9a-fA-F]{2}|.)/g, (_, c) =>
    c[0] === "x" && c.length === 3 ? String.fromCharCode(parseInt(c.slice(1), 16)) : /** @type {Record<string, string>} */ ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" })[c] ?? c,
  );
}

/**
 * Splits a line into key, value and whether it opens children.
 * @param {string} line @returns {{key: string, value: string | null, container: boolean}}
 */
export function parseLine(line) {
  let rest = line.replace(/^- /, "");
  let key;
  if (rest.startsWith("'")) {
    let i = 1;
    for (; i < rest.length; i++) {
      if (rest[i] === "'" && rest[i + 1] === "'") i++;
      else if (rest[i] === "'") break;
    }
    key = rest.slice(1, i).replace(/''/g, "'");
    rest = rest.slice(i + 1);
  } else {
    const colon = rest.search(/:( |$)/);
    key = colon < 0 ? rest : rest.slice(0, colon);
    rest = colon < 0 ? "" : rest.slice(colon);
  }
  if (rest === ":") return { key, value: null, container: true };
  if (rest.startsWith(": ")) {
    const raw = rest.slice(2);
    return { key, value: raw.startsWith('"') && raw.endsWith('"') && raw.length > 1 ? unescapeValue(raw) : raw, container: false };
  }
  return { key, value: null, container: false };
}

/** @param {{key: string, value: string | null, container: boolean}} parts */
export function formatLine({ key, value, container }) {
  return "- " + escapeKey(key) + (value !== null ? ": " + escapeValue(value) : container ? ":" : "");
}

/** Text that goes inside a fact or a marker: no quotes, colons, braces or hashes that would need escaping. @param {string} text @param {number} max */
export function factText(text, max) {
  const clean = text.replace(/\s+/g, " ").replace(/["'`{}]/g, "").replace(/:(\s|$)/g, " -$1").replace(/\s#/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

/** @param {string} line */
export function refOf(line) {
  return /\[ref=((?:f\d+)?e\d+)\]/.exec(line)?.[1] ?? null;
}

/** @param {string} line */
function role(line) {
  return /^- '?([a-z/]+)/.exec(line)?.[1] ?? "";
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
 * @param {Stats} stats
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
  dropLabelEchoes(flat);
  // prose first, so a long article keeps its first maxText characters rather than 5 + 2 paragraphs
  const prose = foldProse(flat, stats.maxText, stats, parentRef, false);
  flat.splice(0, flat.length, ...prose);
  /** @param {Node[]} hidden @param {string} what */
  const foldLine = (hidden, what) => {
    stats.folded += hidden.length;
    const refs = hidden.map((n) => refOf(n.line)).filter(Boolean);
    const range = refs.length ? `, refs ${refs[0]}..${refs[refs.length - 1]}` : "";
    const how = parentRef ? `snapshot target=${parentRef} full=true, or read target=${parentRef}` : "snapshot full=true, or read";
    return { line: `- (${hidden.length} more ${what}${range}; ${how})`, children: [] };
  };
  // Identical siblings that are not next to each other (a feed's placeholders between posts): more than
  // 10 with nothing to act on keep the first 2; the rest become one line where the third stood.
  /** @type {Map<string, Node[]>} */
  const groups = new Map();
  for (const node of flat) {
    if (hasInteractive(node)) continue;
    const key = signature(node);
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  /** @type {Set<Node>} */
  const dropped = new Set();
  /** @type {Map<Node, Node>} */
  const summaryAt = new Map();
  for (const members of groups.values()) {
    if (members.length <= 10 || members.every((n, i) => i === 0 || flat.indexOf(n) === flat.indexOf(members[i - 1]) + 1)) continue;
    const hidden = members.slice(2);
    for (const n of hidden) dropped.add(n);
    summaryAt.set(hidden[0], foldLine(hidden, `identical ${role(members[0].line) || "items"}`));
  }
  const spread = flat.flatMap((n) => (summaryAt.has(n) ? [/** @type {Node} */ (summaryAt.get(n))] : dropped.has(n) ? [] : [n]));
  /** @type {Node[]} */
  const out = [];
  for (let i = 0; i < spread.length; ) {
    let j = i + 1;
    while (j < spread.length && shape(spread[j]) === shape(spread[i])) j++;
    const run = spread.slice(i, j);
    if (run.length > 10 && role(run[0].line) !== "heading") out.push(...run.slice(0, 5), foldLine(run.slice(5, run.length - 2), role(run[0].line) || "items"), ...run.slice(-2));
    else out.push(...run);
    i = j;
  }
  return out;
}

const INTERACTIVE = new Set(["link", "button", "menuitem", "tab", "checkbox", "radio", "switch", "option", "textbox", "combobox", "slider", "spinbutton", "searchbox"]);

// ---------- noise removal (specs/tools/snapshot.md, compaction rule 3) ----------

// Facebook writes timestamps as one element per letter, each followed by U+034F (combining grapheme joiner),
// in scrambled order: the real text is not recoverable, so the name and the letter nodes go.
const OBFUSCATION = /\u034f/;
// Icon fonts put their glyphs in the Private Use Area; the agent cannot read them.
const GLYPHS = /[\ue000-\uf8ff]/g;

/**
 * Cleans one line. `drop` is true when what is left carries nothing.
 * @param {string} line
 * @returns {{line: string, drop: boolean}}
 */
function cleanLine(line) {
  let out = line;
  let obfuscated = false;
  if (OBFUSCATION.test(out)) {
    obfuscated = true;
    // the name (or inline text) is scrambled: remove the quoted name, then the inline text
    out = out.replace(/^(- '?[a-z/]+) "(?:[^"\\]|\\.)*"/, "$1");
    if (OBFUSCATION.test(out)) {
      const colon = out.indexOf(": ");
      if (colon > 0 && !/^- (?:link|button|textbox|combobox)/.test(out)) return { line: out.slice(0, colon + 1), drop: true };
      out = out.replace(OBFUSCATION, "");
    }
    out = out.replace(/^- '/, "- ").replace(/'(:?)$/, "$1");
  }
  if (GLYPHS.test(out)) {
    out = out.replace(GLYPHS, "");
    out = out.replace(/^(- '?[a-z/]+) ""/, "$1").replace(/: +$/, ":");
    if (/^- text:\s*$/.test(out)) return { line: out, drop: true };
  }
  return { line: out.trimEnd(), drop: obfuscated && /^- generic(?: \[[^\]]+\])*:?$/.test(out.trimEnd()) };
}

/** @param {Node[]} nodes @returns {Node[]} */
function clean(nodes) {
  /** @type {Node[]} */
  const out = [];
  for (const node of nodes) {
    const cleaned = cleanLine(node.line);
    const children = clean(node.children);
    if (cleaned.drop && children.length === 0) continue;
    out.push({ line: cleaned.line, children });
  }
  return out;
}

/** Quoted names in a subtree. @param {Node[]} nodes @param {Set<string>} into */
function collectNames(nodes, into) {
  for (const n of nodes) {
    const name = /^- '?[a-z/]+ "((?:[^"\\]|\\.)*)"/.exec(n.line)?.[1];
    if (name) into.add(name);
    collectNames(n.children, into);
  }
}

/**
 * Drops tooltips that only repeat a name already on the page next to them: the unnamed `tooltip "tooltip"`
 * and an aria-hidden tooltip whose text is the name of a sibling or of something inside a sibling.
 * @param {Node[]} nodes @returns {Node[]}
 */
function dropEchoTooltips(nodes) {
  const names = new Set();
  for (const n of nodes) if (role(n.line) !== "tooltip") collectNames([n], names);
  return nodes
    .filter((n) => {
      if (role(n.line) !== "tooltip") return true;
      if (/^- tooltip "tooltip"$/.test(n.line) && n.children.length === 0) return false;
      const text = /^- tooltip(?: \[[^\]]+\])*: (.+)$/.exec(n.line)?.[1];
      return !(n.line.includes("[aria-hidden]") && text && names.has(text.replace(/^"|"$/g, "")));
    })
    .map((n) => ({ line: n.line, children: dropEchoTooltips(n.children) }));
}

/** Line of a node without its refs: what makes two siblings "the same". @param {Node} node @returns {string} */
function signature(node) {
  return node.line.replace(/ \[ref=[^\]]+\]/g, "") + "\n" + node.children.map(signature).join("\n");
}

/** @param {Node} node @returns {boolean} */
function hasInteractive(node) {
  return INTERACTIVE.has(role(node.line)) || node.children.some(hasInteractive);
}

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

/**
 * @param {string} text
 * @param {number} [maxText] characters of prose kept per run (compaction rule "prose folding")
 */
export function compact(text, maxText = 2000) {
  const stats = { folded: 0, textFolded: 0, maxText };
  const result = render(trimLines(compactNodes(dropEchoTooltips(clean(parse(text))), stats, null)));
  return { text: result, folded: stats.folded, textFolded: stats.textFolded };
}

/**
 * Compaction within a size budget: prose is folded harder (maxText halved down to 200) before
 * anything is cut (specs/tools/snapshot.md, step 6).
 * @param {string} text @param {{full?: boolean, maxChars: number, maxText: number}} options
 */
export function fit(text, { full = false, maxChars, maxText }) {
  let out = { text, folded: 0, textFolded: 0 };
  let collapsed = 0;
  if (!full) {
    for (let budget = maxText; ; budget = Math.max(200, Math.floor(budget / 2))) {
      out = compact(text, budget);
      if (out.text.length <= maxChars || budget <= 200) break;
    }
    if (out.text.length > maxChars) {
      const roots = parse(out.text);
      collapsed = collapseToFit(roots, maxChars);
      out.text = render(roots);
    }
  }
  const cutResult = cut(out.text, maxChars);
  return { text: cutResult.text, folded: out.folded, textFolded: out.textFolded, collapsed, cutChars: cutResult.cutChars };
}

/** Whether the node or anything below it matches. @param {Node} node @param {(n: Node) => boolean} test @returns {boolean} */
const holds = (node, test) => test(node) || node.children.some((c) => holds(c, test));
/** @param {Node} node */
const keepsWhole = (node) => role(node.line) === "heading" || role(node.line) === "iframe" || node.line.includes("[modal]");

/** @param {Node} node @param {number} depth @returns {number} rendered length of the subtree */
const renderedSize = (node, depth) => node.line.length + 2 * depth + 1 + node.children.reduce((sum, c) => sum + renderedSize(c, depth + 1), 0);

/**
 * Outline for pages over budget: the largest subtrees that hold no heading (infoboxes, navboxes,
 * reference lists, link-heavy paragraphs) are collapsed into one line, biggest first, until the
 * whole fits. The collapsed node keeps its own line and ref. Returns how many were collapsed.
 * @param {Node[]} roots @param {number} maxChars
 */
function collapseToFit(roots, maxChars) {
  /** @type {{node: Node, size: number, ref: string}[]} */
  const candidates = [];
  /** @param {Node[]} nodes @param {number} depth */
  const collect = (nodes, depth) => {
    for (const node of nodes) {
      const ref = refOf(node.line);
      const size = renderedSize(node, depth) - node.line.length - 2 * depth - 1;
      // a subtree bigger than half the budget is not hidden whole (HN is one table): its children are
      if (ref && node.children.length && size <= maxChars / 2 && !holds(node, keepsWhole)) {
        candidates.push({ node, size, ref });
      } else collect(node.children, depth + 1);
    }
  };
  collect(roots, 0);
  candidates.sort((a, b) => b.size - a.size);
  let total = render(roots).length;
  let collapsed = 0;
  for (const { node, size, ref } of candidates) {
    // the running total is an estimate; check the real size before stopping
    if (total <= maxChars && (total = render(roots).length) <= maxChars) break;
    let lines = 0;
    let links = 0;
    let controls = 0;
    /** @param {Node[]} nodes */
    const count = (nodes) => {
      for (const n of nodes) {
        lines++;
        const r = role(n.line);
        if (r === "link") links++;
        else if (INTERACTIVE.has(r)) controls++;
        count(n.children);
      }
    };
    count(node.children);
    const what = [`${lines} lines`, links && `${links} links`, controls && `${controls} controls`].filter(Boolean).join(", ");
    const summary = { line: `- (folded; ${what}; snapshot target=${ref})`, children: [] };
    node.children = [summary];
    total -= size - (summary.line.length + 4);
    collapsed++;
  }
  return collapsed;
}

// ---------- label echoes (compaction rule 3) ----------

const LABELLED = new Set(["checkbox", "radio", "switch", "textbox", "combobox", "searchbox", "spinbutton", "slider"]);

/** The quoted name of a line, or "". @param {string} line */
export function nameOf(line) {
  const quoted = /^[a-z/]+ ("(?:[^"\\]|\\.)*")/.exec(parseLine(line).key)?.[1];
  if (!quoted) return "";
  try {
    return JSON.parse(quoted);
  } catch {
    return quoted.slice(1, -1);
  }
}

/** Text of a plain text node (`- text: T`, or a generic with only a ref and text), else null. @param {Node} node */
function plainText(node) {
  if (node.children.length) return null;
  const { key, value } = parseLine(node.line);
  if (value === null) return null;
  if (key === "text" || /^generic(?: \[ref=[^\]]+\])?$/.test(key)) return value.trim();
  return null;
}

/** Drops text nodes that repeat the name of the control next to them. @param {Node[]} flat */
function dropLabelEchoes(flat) {
  for (let i = flat.length - 1; i >= 0; i--) {
    const text = plainText(flat[i]);
    if (!text) continue;
    const echoes = [flat[i - 1], flat[i + 1]].some((n) => n && LABELLED.has(role(n.line)) && nameOf(n.line) === text);
    if (echoes) flat.splice(i, 1);
  }
}

// ---------- prose folding (compaction rule "prose folding") ----------

const PROSE = new Set(["paragraph", "text", "blockquote", "code", "emphasis", "strong", "listitem", "list", "generic", "group", "deletion", "insertion", "subscript", "superscript", "time", "mark", "note", "term", "definition"]);

/** @param {Node} node @returns {boolean} */
function isProse(node) {
  return PROSE.has(role(node.line)) && !node.line.includes("[cursor=pointer]") && !node.line.includes("[modal]") && !hasInteractive(node) && node.children.every((c) => c.line.startsWith("- (") || isProse(c));
}

/** @param {Node} node @returns {number} */
const sizeOf = (node) => node.line.length + 1 + node.children.reduce((sum, c) => sum + sizeOf(c), 0);

/**
 * Keeps the first `budget` characters of each run of prose siblings; the rest of the run becomes
 * one line naming the closest ancestor ref to read it from.
 * `deep` also enters non-prose nodes (compactNodes calls it per level, children already done).
 * @param {Node[]} nodes @param {number} budget @param {{textFolded: number}} stats @param {string | null} parentRef @param {boolean} deep
 * @returns {Node[]}
 */
function foldProse(nodes, budget, stats, parentRef, deep) {
  /** @type {Node[]} */
  const out = [];
  let used = 0;
  let hiddenBlocks = 0;
  let hiddenChars = 0;
  const readHint = parentRef ? `read target=${parentRef}` : "read";
  const flush = () => {
    if (hiddenBlocks) {
      out.push({ line: `- (+${hiddenChars} chars in ${hiddenBlocks} blocks; ${readHint})`, children: [] });
      stats.textFolded += hiddenChars;
    }
    used = hiddenBlocks = hiddenChars = 0;
  };
  for (const node of nodes) {
    const ref = refOf(node.line) ?? parentRef;
    if (node.line.startsWith("- (")) {
      // a fold line from an earlier rule: kept, and it does not end the run
      out.push(node);
      continue;
    }
    if (!isProse(node)) {
      flush();
      out.push(deep ? { line: node.line, children: foldProse(node.children, budget, stats, ref, true) } : node);
      continue;
    }
    const size = sizeOf(node);
    if (used >= budget) {
      hiddenBlocks++;
      hiddenChars += size;
    } else if (used + size <= budget) {
      out.push(node);
      used += size;
    } else if (node.children.length) {
      out.push({ line: node.line, children: foldProse(node.children, budget - used, stats, ref, true) });
      used = budget;
    } else {
      const parts = parseLine(node.line);
      const keep = Math.max(100, budget - used);
      if (parts.value !== null && parts.value.length > keep + 40) {
        const dropped = parts.value.length - keep;
        stats.textFolded += dropped;
        parts.value = `${parts.value.slice(0, keep)}… (+${dropped} chars; ${ref ? `read target=${ref}` : "read"})`;
        out.push({ line: formatLine(parts), children: [] });
      } else out.push(node);
      used = budget;
    }
  }
  flush();
  return out;
}

// ---------- facts (specs/tools/snapshot.md, step 4) ----------

const COUNTED = /** @type {Record<string, string[]>} */ ({
  list: ["listitem"],
  listbox: ["option"],
  menu: ["menuitem", "menuitemcheckbox", "menuitemradio"],
  tree: ["treeitem"],
  tablist: ["tab"],
  feed: ["article"],
});
const TABLES = new Set(["table", "grid", "treegrid"]);
const CELLS = new Set(["cell", "gridcell", "columnheader", "rowheader"]);

/** Descendants with one of `roles`, not looking inside nested containers of role `stop`. @param {Node} node @param {string[]} roles @param {Set<string>} stop */
function countBelow(node, roles, stop) {
  let n = 0;
  for (const child of node.children) {
    const r = role(child.line);
    if (roles.includes(r)) n++;
    else if (!stop.has(r)) n += countBelow(child, roles, stop);
  }
  return n;
}

/** @param {Node} node @returns {string[]} */
function countsOf(node) {
  const r = role(node.line);
  if (TABLES.has(r)) {
    /** @type {Node[]} */
    const rows = [];
    /** @param {Node} n */
    const collect = (n) => {
      for (const c of n.children) {
        const cr = role(c.line);
        if (cr === "row") rows.push(c);
        else if (!TABLES.has(cr)) collect(c);
      }
    };
    collect(node);
    if (!rows.length) return [];
    const cols = Math.max(...rows.map((row) => row.children.filter((c) => CELLS.has(role(c.line))).length));
    return [`[rows=${rows.length}]`, `[cols=${cols}]`];
  }
  const items = COUNTED[r];
  if (!items) return [];
  const n = countBelow(node, items, new Set(Object.keys(COUNTED)));
  return n >= 10 ? [`[items=${n}]`] : [];
}

/** Puts facts after the ref (and its cursor marker), or at the end of the key. @param {string} line @param {string[]} facts */
function withFacts(line, facts) {
  const parts = parseLine(line);
  const anchor = /\[ref=[^\]]+\](?: \[cursor=pointer\])?/.exec(parts.key);
  const add = " " + facts.join(" ");
  parts.key = anchor ? parts.key.slice(0, anchor.index + anchor[0].length) + add + parts.key.slice(anchor.index + anchor[0].length) : parts.key + add;
  return formatLine(parts);
}

/**
 * Adds the runtime's facts (by ref), the reason refless interactive nodes have no ref (matched in
 * tree order by role and name), and counts on tables and lists. Applies in every mode.
 * @param {string} text
 * @param {{facts?: Record<string, string[]>, refless?: {role: string, name: string, reason: string}[]}} [data]
 */
export function annotate(text, { facts = {}, refless = [] } = {}) {
  const roots = parse(text);
  let next = 0;
  /** @param {Node[]} nodes */
  const visit = (nodes) => {
    for (const node of nodes) {
      const ref = refOf(node.line);
      const r = role(node.line);
      /** @type {string[]} */
      const extra = [];
      if (ref && facts[ref]) extra.push(...facts[ref]);
      if (!ref && INTERACTIVE.has(r)) {
        const name = nameOf(node.line);
        for (let k = next; k < Math.min(refless.length, next + 50); k++) {
          if (refless[k].role === r && refless[k].name === name) {
            extra.push(refless[k].reason);
            next = k + 1;
            break;
          }
        }
      }
      extra.push(...countsOf(node));
      if (extra.length) node.line = withFacts(node.line, extra);
      visit(node.children);
    }
  };
  visit(roots);
  return render(roots);
}

/** The whole snapshot and `read` text of a PDF tab: Chrome's viewer keeps its text out of the page. */
export const PDF_NOTICE = "- (PDF in Chrome's viewer; its text is not in the page; take_screenshot shows it, evaluate with fetch(location.href) gets the file)";

/**
 * First lines that tell the agent the page is not ready, is covered by a modal, or draws content
 * on canvases (specs/tools/snapshot.md).
 * @param {{ready: boolean, readyState: string, quiet: boolean | null, pendingRequests: number}} readiness
 * @param {{ref: string | null, role: string, name: string} | null} modal
 * @param {{count: number, largest: string} | null} [canvas]
 */
export function noticeLines(readiness, modal, canvas = null) {
  const lines = [];
  if (!readiness.ready) {
    const why = [];
    if (readiness.readyState !== "complete") why.push(`document ${readiness.readyState}`);
    if (readiness.quiet === false) why.push("DOM still changing");
    if (readiness.pendingRequests) why.push(`${readiness.pendingRequests} requests pending`);
    lines.push(`- (page not ready; ${why.join(", ") || "still loading"}; snapshot again or wait_for)`);
  }
  if (modal) {
    const name = modal.name ? ` "${factText(modal.name, 60)}"` : "";
    const at = modal.ref ? `, starting at [ref=${modal.ref}]` : "";
    lines.push(`- (a modal ${modal.role}${name} covers the page${at}; act inside it or close it first)`);
  }
  if (canvas) {
    const areas = canvas.count === 1 ? "1 canvas area" : `${canvas.count} canvas areas`;
    lines.push(`- (${areas} drawn on the page, largest ${canvas.largest} px; their content is pixels, not text; take_screenshot shows it)`);
  }
  return lines;
}

/**
 * Puts each frame's snapshot under the line of its iframe element; an iframe whose frame was not
 * read gets `[not read]` (specs/tools/snapshot.md).
 * @param {string} text
 * @param {Map<string, string>} frames iframe ref -> that frame's snapshot text
 * @param {Set<string>} [unread] iframe refs whose frame could not be read
 */
export function nestFrames(text, frames, unread = new Set()) {
  /** @param {Node[]} nodes */
  const visit = (nodes) => {
    for (const node of nodes) {
      const ref = refOf(node.line);
      const inner = ref ? frames.get(ref) : undefined;
      if (ref && unread.has(ref)) node.line = withFacts(node.line, ["[not read]"]);
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
  /** @param {number} n */
  const marker = (n) => `\n- (${n} more characters; raise maxChars, snapshot a part with target, or read for the text)`;
  // the cut line counts toward maxChars too
  const room = Math.max(0, maxChars - marker(text.length).length);
  const end = text.lastIndexOf("\n", room);
  const kept = text.slice(0, end > 0 ? end : room);
  const cutChars = text.length - kept.length;
  return { text: kept + marker(cutChars), cutChars };
}
