// @ts-check
// Locator forms that Playwright has no engine for, rewritten into Playwright selectors
// (specs/targets.md, "Forms"). Refs and every other selector pass through unchanged.

export const REF = /^(f\d+)?e\d+$/;

/** Value as written: `"x"` is exact, anything else a case-insensitive substring. @param {string} raw */
function parseValue(raw) {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return { text: v.slice(1, -1), exact: true };
  }
  return { text: v, exact: false };
}

/** @param {string} text @param {boolean} exact */
const quoted = (text, exact) => JSON.stringify(text) + (exact ? "s" : "i");

/** @type {Record<string, (value: {text: string, exact: boolean}) => string>} */
const FRIENDLY = {
  name: ({ text }) => `css=[name=${JSON.stringify(text)}]`,
  label: ({ text, exact }) => `internal:label=${quoted(text, exact)}`,
  placeholder: ({ text, exact }) => `internal:attr=[placeholder=${quoted(text, exact)}]`,
  testid: ({ text }) => `internal:testid=[data-testid=${quoted(text, true)}]`,
  alt: ({ text, exact }) => `internal:attr=[alt=${quoted(text, exact)}]`,
  title: ({ text, exact }) => `internal:attr=[title=${quoted(text, exact)}]`,
};

/**
 * Splits a selector at `>>` outside quotes, keeping each separator as written.
 * @param {string} selector @returns {{parts: string[], separators: string[]}}
 */
function splitChain(selector) {
  const parts = [];
  const separators = [];
  let quote = "";
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">" && selector[i + 1] === ">") {
      let from = i;
      while (from > start && /\s/.test(selector[from - 1])) from--;
      let to = i + 2;
      while (to < selector.length && /\s/.test(selector[to])) to++;
      parts.push(selector.slice(start, from));
      separators.push(selector.slice(from, to));
      start = to;
      i = to - 1;
    }
  }
  parts.push(selector.slice(start));
  return { parts, separators };
}

/**
 * The Playwright selector for a target, or the target itself when it is a ref or already one.
 * @param {string} target
 */
export function toSelector(target) {
  if (REF.test(target)) return target;
  const { parts, separators } = splitChain(target);
  const rewritten = parts.map((part) => {
    const match = /^\s*([a-z]+)=([\s\S]*)$/.exec(part);
    const rewrite = match ? FRIENDLY[match[1]] : undefined;
    return rewrite && match ? rewrite(parseValue(match[2])) : part;
  });
  return rewritten.map((part, i) => part + (separators[i] ?? "")).join("");
}
