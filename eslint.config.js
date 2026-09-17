// Comments in shipped source describe the code as it stands. A comment names what the thing
// does and the constraints on it, not how it came to be that way: no revision history, no
// account of what was tried first, no note addressed to whoever is reading it this session.
// Those belong in CHANGELOG.md, in a test that fails when the behaviour drifts, or in the
// tool's own description(). A comment that narrates a change goes silent the next time the
// code changes; a comment that states what the code is can be checked against it.
// See CONTRIBUTING.md.
const ALLOWED_PRAGMA = /^\s*(prettier-ignore|eslint-|@ts-|global\s|globals\s|#|!)/;

const HISTORY_IN_COMMENT = [
  [/\b(used to|previously|formerly|originally|no longer|superseded|it turned out)\b/i, "narrates history"],
  [/\bwe (tried|changed|renamed|moved|removed|added|had)\b/i, "narrates the change rather than the code"],
  [/\b(rev \d+|§\d)/i, "points into a design document"],
  [/\bv\d+\.\d+/i, "names a version; CHANGELOG.md owns versions"],
  [/\b20\d{2}-\d{2}-\d{2}\b/, "carries a date"],
  [/\bthe old [a-z_]+\b/i, "describes code by contrast with a past version"],
];

const commentsDescribeTheCode = {
  meta: {
    type: "problem",
    docs: { description: "comments state what the code is, not how it got that way" },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        for (const c of context.sourceCode.getAllComments()) {
          if (c.type === "Shebang" || c.type === "Hashbang") continue;
          if (ALLOWED_PRAGMA.test(c.value)) continue;
          for (const [pattern, why] of HISTORY_IN_COMMENT) {
            if (!pattern.test(c.value)) continue;
            context.report({
              loc: c.loc,
              message:
                `this comment ${why}. Say what the code does now and what constrains it. ` +
                "History goes in CHANGELOG.md, rationale in a test that fails without it. See CONTRIBUTING.md.",
            });
            break;
          }
        }
      },
    };
  },
};

const local = { rules: { "comments-describe-the-code": commentsDescribeTheCode } };

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  clearImmediate: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  fetch: "readonly",
};

const browserGlobals = {
  window: "readonly",
  document: "readonly",
  chrome: "readonly",
  location: "readonly",
  navigator: "readonly",
  HTMLElement: "readonly",
  Element: "readonly",
  Node: "readonly",
  Event: "readonly",
  CustomEvent: "readonly",
  MutationObserver: "readonly",
  IntersectionObserver: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
};

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "**/*.min.js",
      "bridge/calls.jsonl*",
      "bridge/telemetry.jsonl*",
      "tests/benchmark/runs/**",
    ],
  },
  // Node.js files
  {
    files: ["cli.js", "bridge/**/*.js", "mcp/**/*.js", "scripts/**/*.js", "tests/**/*.js", "tests/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-extra-semi": "error",
      "no-unreachable": "warn",
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // Chrome Extension files
  {
    files: ["extension/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: browserGlobals,
    },
    rules: {
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-extra-semi": "error",
      "no-unreachable": "warn",
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // The published surface: exactly what package.json "files" ships, and nothing else.
  {
    files: ["cli.js", "bridge/**/*.js", "mcp/**/*.js", "extension/**/*.js"],
    plugins: { local },
    rules: { "local/comments-describe-the-code": "error" },
  },
];
