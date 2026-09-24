// Cut one declaration out of a source file, so a test runs the shipped code itself.
//
// The extension's files register chrome.* listeners and run inside Chrome, so they cannot be
// imported under Node; the tests evaluate these slices in a node:vm context instead, and a
// test breaks when the real implementation changes.

// Pull `function <name>(...) { ... }` out of SRC by counting braces from the first `{`
// to its match, so nested blocks inside the function don't truncate the slice early.
export function extractFunction(src, name) {
  const startMatch = src.match(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (!startMatch) throw new Error(`function ${name} not found`);
  // Skip the parameter list before hunting for the body: a destructured parameter
  // (`function find({ query, selector })`) opens a brace that is not the body, and
  // counting from it stops at the end of the signature.
  const parenStart = src.indexOf("(", startMatch.index);
  let parenDepth = 0;
  let afterParams = -1;
  for (let i = parenStart; i < src.length; i++) {
    if (src[i] === "(") parenDepth++;
    else if (src[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) { afterParams = i + 1; break; }
    }
  }
  if (afterParams < 0) throw new Error(`unbalanced parameter list for function ${name}`);
  const braceStart = src.indexOf("{", afterParams);
  if (braceStart < 0) throw new Error(`no body found for function ${name}`);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(startMatch.index, i + 1);
    }
  }
  throw new Error(`unbalanced braces for function ${name}`);
}

// Pull `const <name> = ...;` (single statement, ends at the first top-level `;`).
export function extractConst(src, name) {
  const startMatch = src.match(new RegExp(`const\\s+${name}\\s*=`));
  if (!startMatch) throw new Error(`const ${name} not found`);
  const semi = src.indexOf(";", startMatch.index);
  if (semi < 0) throw new Error(`no terminating ';' found for const ${name}`);
  return src.slice(startMatch.index, semi + 1);
}
