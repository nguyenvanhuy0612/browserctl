// The shipped source carries no commentary. Rationale for shipped behaviour lives in a test
// that fails when the behaviour drifts, in CHANGELOG.md, and in each tool's description() —
// none of which go quiet when the code changes underneath them, the way a comment does.
// scripts/ and tests/ are exempt: they are not published, and a gate whose reason is not
// written down is a gate somebody deletes to get a green run.
// See CONTRIBUTING.md.
const ALLOWED_PRAGMA = /^\s*(prettier-ignore|eslint-|@ts-|global\s|globals\s|#|!)/;

const shippedSourceHasNoComments = {
  meta: {
    type: "problem",
    docs: { description: "published source carries no commentary; pragmas only" },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        for (const c of context.sourceCode.getAllComments()) {
          if (c.type === "Shebang" || c.range[0] === 0) continue;
          if (ALLOWED_PRAGMA.test(c.value)) continue;
          context.report({
            loc: c.loc,
            message:
              "published source carries no comments. Put the reason in a test that fails without it, in CHANGELOG.md, or in the tool's description(). Pragmas (prettier-ignore, eslint-*) are allowed. See CONTRIBUTING.md.",
          });
        }
      },
    };
  },
};

const local = { rules: { "shipped-source-has-no-comments": shippedSourceHasNoComments } };

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
    rules: { "local/shipped-source-has-no-comments": "error" },
  },
];
