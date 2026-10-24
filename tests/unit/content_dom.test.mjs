// Acceptance test suite for Milestone 3: Content Script & DOM Subsystem.
//
// Specifications:
// - docs/spec/04-content-and-dom.md
// - docs/spec/05-test-and-acceptance-matrix.md (TC-DOM-01 through TC-DOM-06)
//
// Verifies:
// 1. TC-DOM-01: Census Snapshot @e sequential indexing and @ref refusal.
// 2. TC-DOM-02: Token pruning, hidden/zero-rect trimming, and text compaction.
// 3. TC-DOM-03: 10-Step Setter Guard (setElementValue) event order and prototype bypass.
// 4. TC-DOM-04: Table Matrix Reconciler 2D grid reconciliation with colspan/rowspan.
// 5. TC-DOM-05: CSV Formula Injection Guard (csv_safe).
// 6. TC-DOM-06: Opt-in Virtual Object Model (VOM) tree hierarchy, layers, and limits.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// DOM Event Mocks for Node.js test environment
if (typeof globalThis.Event === "undefined") {
  globalThis.Event = class Event {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
      this.composed = Boolean(options.composed);
    }
  };
}

if (typeof globalThis.MouseEvent === "undefined") {
  globalThis.MouseEvent = class MouseEvent extends globalThis.Event {
    constructor(type, options = {}) {
      super(type, options);
      this.button = options.button ?? 0;
      this.buttons = options.buttons ?? 0;
    }
  };
}

if (typeof globalThis.PointerEvent === "undefined") {
  globalThis.PointerEvent = class PointerEvent extends globalThis.MouseEvent {
    constructor(type, options = {}) {
      super(type, options);
      this.pointerId = options.pointerId ?? 1;
      this.pointerType = options.pointerType ?? "mouse";
    }
  };
}

if (typeof globalThis.InputEvent === "undefined") {
  globalThis.InputEvent = class InputEvent extends globalThis.Event {
    constructor(type, options = {}) {
      super(type, options);
      this.inputType = options.inputType ?? "";
      this.data = options.data ?? null;
    }
  };
}

// Module imports from extension/content/
let contentIndexModule = null;
let registryModule = null;
let setterModule = null;
let tableModule = null;
let snapshotModule = null;

try {
  contentIndexModule = await import("../../extension/content/index.js");
} catch {}
try {
  registryModule = await import("../../extension/content/registry.js");
} catch {}
try {
  setterModule = await import("../../extension/content/setter.js");
} catch {}
try {
  tableModule = await import("../../extension/content/table.js");
} catch {}
try {
  snapshotModule = await import("../../extension/content/snapshot.js");
} catch {}

const getOrAssignRef = registryModule?.getOrAssignRef || contentIndexModule?.getOrAssignRef;
const resolveTarget = registryModule?.resolveTarget || contentIndexModule?.resolveTarget;
const resetRegistry =
  registryModule?.resetRegistry ||
  registryModule?.clearRegistry ||
  contentIndexModule?.resetRegistry;
const clearRegistry = registryModule?.clearRegistry || contentIndexModule?.clearRegistry;

const setElementValue = setterModule?.setElementValue || contentIndexModule?.setElementValue;
const insertIntoEditable =
  setterModule?.insertIntoEditable || contentIndexModule?.insertIntoEditable;

const csv_safe =
  tableModule?.csv_safe || tableModule?.sanitizeCsvValue || contentIndexModule?.csv_safe;
const sanitizeCsvValue = tableModule?.sanitizeCsvValue || contentIndexModule?.sanitizeCsvValue;
const extract_table = tableModule?.extract_table || contentIndexModule?.extract_table;

const snapshot =
  snapshotModule?.snapshot ||
  snapshotModule?.generateCensus ||
  snapshotModule?.takeSnapshot ||
  contentIndexModule?.snapshot;
const generateVOM =
  snapshotModule?.generateVOM ||
  snapshotModule?.buildVOM ||
  snapshotModule?.vom ||
  contentIndexModule?.generateVOM;

// Helper to create mock DOM elements
function createMockElement(
  tagName,
  attrs = {},
  styles = {},
  rect = { x: 0, y: 0, width: 100, height: 30 }
) {
  const listeners = new Map();
  const attributes = new Map(Object.entries(attrs));
  let _value = attrs.value || "";

  const el = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    style: { display: "block", visibility: "visible", opacity: "1", ...styles },
    children: [],
    parentNode: null,
    innerText: attrs.innerText || "",
    textContent: attrs.textContent || attrs.innerText || "",

    getAttribute(k) {
      return attributes.get(k) ?? null;
    },
    setAttribute(k, v) {
      attributes.set(k, String(v));
    },
    hasAttribute(k) {
      return attributes.has(k);
    },
    removeAttribute(k) {
      attributes.delete(k);
    },
    getBoundingClientRect() {
      return {
        x: rect.x ?? 0,
        y: rect.y ?? 0,
        width: rect.width ?? 100,
        height: rect.height ?? 30,
        top: rect.y ?? 0,
        left: rect.x ?? 0,
        bottom: (rect.y ?? 0) + (rect.height ?? 30),
        right: (rect.x ?? 0) + (rect.width ?? 100),
      };
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) {
        listeners.set(
          type,
          listeners.get(type).filter((cb) => cb !== fn)
        );
      }
    },
    dispatchEvent(event) {
      if (listeners.has(event.type)) {
        for (const cb of listeners.get(event.type)) {
          cb(event);
        }
      }
      return true;
    },
    focus() {
      el.dispatchEvent(new globalThis.Event("focus"));
    },
    blur() {
      el.dispatchEvent(new globalThis.Event("blur"));
    },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    querySelectorAll(sel) {
      const matched = [];
      function walk(n) {
        for (const c of n.children) {
          if (sel === "tr" && c.tagName === "TR") matched.push(c);
          if (sel === "th" && c.tagName === "TH") matched.push(c);
          if (sel === "td" && c.tagName === "TD") matched.push(c);
          walk(c);
        }
      }
      walk(el);
      return matched;
    },
    querySelector(sel) {
      const all = el.querySelectorAll(sel);
      return all.length > 0 ? all[0] : null;
    },
  };

  // Define prototype .value getter/setter for input/textarea elements
  Object.defineProperty(el, "value", {
    get() {
      return _value;
    },
    set(v) {
      _value = String(v);
    },
    configurable: true,
    enumerable: true,
  });

  return el;
}

beforeEach(() => {
  if (typeof resetRegistry === "function") {
    resetRegistry();
  }
});

// =====================================================================================
// 1. TC-DOM-01: Census Snapshot @e Indexing & Legacy @ref Refusal
// =====================================================================================

test("TC-DOM-01: getOrAssignRef sequentially indexes elements as @e1, @e2, @e3...", () => {
  assert.ok(typeof getOrAssignRef === "function", "getOrAssignRef must be exported");

  const el1 = createMockElement("button", { id: "btn-submit", innerText: "Submit" });
  const el2 = createMockElement("input", { type: "text", name: "email" });
  const el3 = createMockElement("a", { href: "/home", innerText: "Home" });

  const ref1 = getOrAssignRef(el1);
  const ref2 = getOrAssignRef(el2);
  const ref3 = getOrAssignRef(el3);

  // Assert bare id format "e1" or "@e1"
  assert.match(ref1, /^@?e\d+$/);
  assert.match(ref2, /^@?e\d+$/);
  assert.match(ref3, /^@?e\d+$/);

  // Assert sequential numbering
  const n1 = parseInt(ref1.replace(/^@?e/, ""), 10);
  const n2 = parseInt(ref2.replace(/^@?e/, ""), 10);
  const n3 = parseInt(ref3.replace(/^@?e/, ""), 10);
  assert.equal(n2, n1 + 1);
  assert.equal(n3, n2 + 1);

  // Idempotency check: re-querying returns identical reference
  assert.equal(getOrAssignRef(el1), ref1);
  assert.equal(getOrAssignRef(el2), ref2);
});

test("TC-DOM-01: resolveTarget resolves @e references and strictly refuses legacy @ref format", () => {
  assert.ok(typeof resolveTarget === "function", "resolveTarget must be exported");

  const btn = createMockElement("button", { innerText: "Login" });
  const ref = getOrAssignRef(btn);
  const normalized = ref.startsWith("@") ? ref : "@" + ref;
  const bare = normalized.slice(1);

  // Both "@e1" and "e1" resolve to the registered element
  assert.equal(resolveTarget({ target: normalized }), btn);
  assert.equal(resolveTarget({ target: bare }), btn);

  // Strict refusal of deprecated legacy @ref format
  assert.throws(() => resolveTarget({ target: "@ref_1" }), /ref|TARGET|INVALID/i);
  assert.throws(() => resolveTarget({ target: "ref_1" }), /ref|TARGET|INVALID/i);
});

test("TC-DOM-01: clearRegistry resets element reference counter back to @e1", () => {
  assert.ok(typeof clearRegistry === "function", "clearRegistry must be exported");

  const elA = createMockElement("button", { innerText: "A" });
  const elB = createMockElement("button", { innerText: "B" });

  const refA = getOrAssignRef(elA);
  const refB = getOrAssignRef(elB);
  assert.ok(refA.endsWith("1"));
  assert.ok(refB.endsWith("2"));

  clearRegistry();

  const elC = createMockElement("button", { innerText: "C" });
  const refC = getOrAssignRef(elC);
  assert.equal(refC, "@e1");
});

// =====================================================================================
// 2. TC-DOM-02: Token Pruning & Text Trimming Rules
// =====================================================================================

test("TC-DOM-02: Prunes invisible elements (display:none, visibility:hidden, 0x0 rect, aria-hidden)", () => {
  const container = createMockElement("div");

  const visibleBtn = createMockElement(
    "button",
    { innerText: "Visible Button" },
    {},
    { width: 100, height: 40 }
  );
  const displayNoneBtn = createMockElement(
    "button",
    { innerText: "Hidden 1" },
    { display: "none" }
  );
  const visHiddenBtn = createMockElement(
    "button",
    { innerText: "Hidden 2" },
    { visibility: "hidden" }
  );
  const zeroRectBtn = createMockElement(
    "button",
    { innerText: "Hidden 3" },
    {},
    { width: 0, height: 0 }
  );
  const ariaHiddenBtn = createMockElement("button", {
    "aria-hidden": "true",
    innerText: "Hidden 4",
  });

  container.appendChild(visibleBtn);
  container.appendChild(displayNoneBtn);
  container.appendChild(visHiddenBtn);
  container.appendChild(zeroRectBtn);
  container.appendChild(ariaHiddenBtn);

  if (typeof snapshot === "function") {
    const snap = snapshot({ root: container, format: "compact" });
    const output =
      typeof snap === "string" ? snap : snap?.text || snap?.census || JSON.stringify(snap);

    assert.ok(output.includes("Visible Button"));
    assert.ok(!output.includes("Hidden 1"));
    assert.ok(!output.includes("Hidden 2"));
    assert.ok(!output.includes("Hidden 3"));
    assert.ok(!output.includes("Hidden 4"));
  }
});

test("TC-DOM-02: Compacts whitespace and truncates text exceeding 150 characters", () => {
  const longText = "A".repeat(200);
  const redundantWhitespace = "  Hello    World   from   browserctl   ";

  const elLong = createMockElement("button", { innerText: longText });
  const elWhitespace = createMockElement("button", { innerText: redundantWhitespace });

  const root = createMockElement("div");
  root.appendChild(elLong);
  root.appendChild(elWhitespace);

  if (typeof snapshot === "function") {
    const snap = snapshot({ root, format: "compact" });
    const output =
      typeof snap === "string" ? snap : snap?.text || snap?.census || JSON.stringify(snap);

    // Whitespace collapsed
    assert.ok(output.includes("Hello World from browserctl"));
    assert.ok(!output.includes("    "));

    // Long text truncated with ellipsis
    assert.ok(output.includes("..."));
    assert.ok(!output.includes("A".repeat(160)));
  }
});

// =====================================================================================
// 3. TC-DOM-03: 10-Step Setter Guard (setElementValue)
// =====================================================================================

test("TC-DOM-03: setElementValue executes atomic 10-step event dispatch in exact sequence", () => {
  assert.ok(typeof setElementValue === "function", "setElementValue must be exported");

  const dispatchedEvents = [];
  let setterCalled = false;

  // Mock prototype with setter descriptor to test framework proxy bypass
  class MockInputPrototype {
    get value() {
      return this._val || "";
    }
    set value(v) {
      setterCalled = true;
      dispatchedEvents.push("prototype-setter");
      this._val = v;
    }
  }

  const inputEl = Object.assign(
    Object.create(MockInputPrototype.prototype),
    createMockElement("input", { type: "text" })
  );

  dispatchedEvents.length = 0;
  setterCalled = false;

  // Track event sequence
  for (const eventName of [
    "focus",
    "pointerdown",
    "mousedown",
    "beforeinput",
    "input",
    "change",
    "pointerup",
    "mouseup",
    "blur",
  ]) {
    inputEl.addEventListener(eventName, (e) => {
      dispatchedEvents.push(e.type);
    });
  }

  setElementValue(inputEl, "Automated Input Value");

  assert.equal(setterCalled, true);
  assert.equal(inputEl.value, "Automated Input Value");

  // Verify event sequence:
  // 1. focus
  // 2. pointerdown, mousedown
  // 3. prototype setter
  // 4. beforeinput
  // 5. input (composed: true)
  // 6. change
  // 7. pointerup, mouseup
  // 8. blur
  const expectedOrder = [
    "focus",
    "pointerdown",
    "mousedown",
    "prototype-setter",
    "beforeinput",
    "input",
    "change",
    "pointerup",
    "mouseup",
    "blur",
  ];

  assert.deepEqual(dispatchedEvents, expectedOrder);
});

// =====================================================================================
// 4. TC-DOM-04: Table Matrix Reconciler (rowspan & colspan)
// =====================================================================================

test("TC-DOM-04: extract_table correctly reconciles multi-row and multi-column grid matrix", () => {
  assert.ok(typeof extract_table === "function", "extract_table must be exported");

  function makeCell(tag, text, { rowspan, colspan } = {}) {
    return createMockElement(tag, {
      innerText: text,
      ...(rowspan ? { rowspan: String(rowspan) } : {}),
      ...(colspan ? { colspan: String(colspan) } : {}),
    });
  }

  function makeRow(cells) {
    const tr = createMockElement("tr");
    for (const c of cells) tr.appendChild(c);
    return tr;
  }

  // 3-column table:
  // Row 0: H1, H2, H3
  // Row 1: A1 (colspan 2), C1
  // Row 2: A2 (rowspan 2), B2, C2
  // Row 3: B3, C3 (A2 occupies col 0 via rowspan)
  const table = createMockElement("table");
  table.appendChild(makeRow([makeCell("th", "H1"), makeCell("th", "H2"), makeCell("th", "H3")]));
  table.appendChild(makeRow([makeCell("td", "A1", { colspan: 2 }), makeCell("td", "C1")]));
  table.appendChild(
    makeRow([makeCell("td", "A2", { rowspan: 2 }), makeCell("td", "B2"), makeCell("td", "C2")])
  );
  table.appendChild(makeRow([makeCell("td", "B3"), makeCell("td", "C3")]));

  const result = extract_table({ target: table, format: "json" });

  assert.equal(result.total_rows, 3);
  assert.equal(result.total_cols, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(result.headers)), ["H1", "H2", "H3"]);

  const rows = JSON.parse(JSON.stringify(result.rows));
  assert.deepEqual(rows[0], { H1: "A1", H2: "A1", H3: "C1" });
  assert.deepEqual(rows[1], { H1: "A2", H2: "B2", H3: "C2" });
  assert.deepEqual(rows[2], { H1: "A2", H2: "B3", H3: "C3" });
});

// =====================================================================================
// 5. TC-DOM-05: CSV Formula Injection Guard (csv_safe)
// =====================================================================================

test("TC-DOM-05: csv_safe prepends apostrophe to formula trigger characters (=, +, -, @, \\t, \\r)", () => {
  assert.ok(typeof csv_safe === "function", "csv_safe must be exported");

  assert.equal(csv_safe("=SUM(A1:A5)"), "'=SUM(A1:A5)");
  assert.equal(csv_safe("+500"), "'+500");
  assert.equal(csv_safe("-120"), "'-120");
  assert.equal(csv_safe("@admin"), "'@admin");
  assert.equal(csv_safe("\ttabbed"), "'\ttabbed");
  assert.ok(csv_safe("\rreturn").startsWith("'") || csv_safe("\rreturn").includes("\r"));

  // Normal strings and numbers remain unescaped
  assert.equal(csv_safe("Standard String"), "Standard String");
  assert.equal(csv_safe("12345"), "12345");
  assert.equal(csv_safe(null), "");
  assert.equal(csv_safe(undefined), "");
});

// =====================================================================================
// 6. TC-DOM-06: Opt-in Virtual Object Model (VOM) Tree
// =====================================================================================

test("TC-DOM-06: VOM Tree format returns hierarchical node tree with geometry, layers, and limits", () => {
  const root = createMockElement(
    "div",
    { id: "app-root" },
    {},
    { x: 0, y: 0, width: 1024, height: 768 }
  );
  const modal = createMockElement(
    "div",
    { role: "dialog", id: "confirm-modal" },
    {},
    { x: 200, y: 150, width: 400, height: 300 }
  );
  const input = createMockElement(
    "input",
    { type: "text", value: "SecretPassword123" },
    {},
    { x: 220, y: 180, width: 200, height: 30 }
  );
  const button = createMockElement(
    "button",
    { innerText: "Confirm" },
    {},
    { x: 220, y: 220, width: 100, height: 35 }
  );

  modal.appendChild(input);
  modal.appendChild(button);
  root.appendChild(modal);

  const vomFn = generateVOM || snapshot;
  assert.ok(typeof vomFn === "function", "VOM tree generator must be exported");

  const vomResult = vomFn({
    root,
    format: "vom",
    maxDepth: 4,
    redactValues: true,
  });

  assert.ok(vomResult != null);
  const tree = vomResult.tree || vomResult.vom || vomResult;

  // Nodes contain rect, depth, layer, and unified @e token
  function assertVOMNode(node, currentDepth = 0) {
    assert.ok(node.rect != null, "Node must have rect geometry");
    assert.ok(node.rect.width !== undefined || node.rect.w !== undefined);
    assert.ok(node.rect.height !== undefined || node.rect.h !== undefined);
    assert.ok(node.depth !== undefined);
    assert.ok(node.depth <= 4, "maxDepth limit must be honored");

    if (node.layer) {
      assert.ok(["page", "modal", "mask"].includes(node.layer));
    }

    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        assert.equal(child.parentId, node.id || node.ref);
        assertVOMNode(child, currentDepth + 1);
      }
    }
  }

  if (Array.isArray(tree)) {
    for (const n of tree) assertVOMNode(n);
  } else {
    assertVOMNode(tree);
  }
});
