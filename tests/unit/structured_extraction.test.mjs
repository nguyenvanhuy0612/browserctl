// Comprehensive Structured Extraction Test Suite for browserctl.
// Validates the full table, grid, list, and discovery engine ported and adapted from BrowserSkill:
// - Native HTML <table> and ARIA [role="table|grid|treegrid"]
// - Nested container boundary isolation (no leakage of child table cells)
// - Multi-tier hierarchical headers (header_path) and explicit headers attribute
// - Split ARIA row merging (split_aria_rows_merged) and ARIA rowindex sorting
// - Cell spans metadata tracking (spans) with null for covered cells
// - Row provenance (row_sources) with locators and row_kind
// - Budget guards (max_rows, max_columns, fitExtractBudget atomic row pruning)
// - Discovery mode (action: "discover") with container preview headers
// - CWE-1236 CSV safe defense and format serialization

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateExtract,
  collectExtractDom,
  normalizeExtract,
  fitExtractBudget,
  structuredExtract,
  ExtractionFailure,
  reconcileTableMatrix,
  csv_safe,
  sanitizeCsvValue,
} from "../../extension/content/table.js";

// =============================================================================
// Mock DOM Factory for JSDOM-free Node test runner
// =============================================================================

function createMockElement(tag, attrs = {}, children = [], textContent = "") {
  const el = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    attributes: { ...attrs },
    children: [],
    childNodes: [],
    parentElement: null,
    parentNode: null,
    id: attrs.id || "",
    textContent: textContent || "",
    innerText: textContent || "",
    getAttribute(name) {
      return this.attributes[name] !== undefined ? this.attributes[name] : null;
    },
    setAttribute(name, val) {
      this.attributes[name] = String(val);
      if (name === "id") this.id = String(val);
    },
    hasAttribute(name) {
      return this.attributes[name] !== undefined;
    },
    closest(selector) {
      let cur = this;
      while (cur) {
        if (cur.matches && cur.matches(selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    matches(selector) {
      const parts = selector.split(",").map((s) => s.trim().toLowerCase());
      const tagLower = this.tagName.toLowerCase();
      const role = (this.getAttribute("role") || "").toLowerCase();
      const className = (this.getAttribute("class") || "").toLowerCase();
      for (let part of parts) {
        let tagPart = "";
        let rolePart = "";
        let classPart = "";
        let idPart = "";

        if (part.includes("[role=")) {
          const m = part.match(/\[role=["']?([^"']+)["']?\]/);
          if (m) rolePart = m[1];
          part = part.replace(/\[role=["']?[^"']+["']?\]/, "");
        }
        if (part.includes(".")) {
          const idx = part.indexOf(".");
          classPart = part.slice(idx + 1);
          part = part.slice(0, idx);
        }
        if (part.includes("#")) {
          const idx = part.indexOf("#");
          idPart = part.slice(idx + 1);
          part = part.slice(0, idx);
        }
        tagPart = part;

        let ok = true;
        if (tagPart && tagPart !== ":scope" && tagPart !== tagLower) ok = false;
        if (rolePart && rolePart !== role) ok = false;
        if (classPart && !className.includes(classPart)) ok = false;
        if (idPart && this.id !== idPart) ok = false;
        if (ok) return true;
      }
      return false;
    },
    querySelectorAll(selector) {
      const matches = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (child.matches && child.matches(selector)) {
            matches.push(child);
          }
          walk(child);
        }
      };
      walk(this);
      return matches;
    },
    querySelector(selector) {
      const all = this.querySelectorAll(selector);
      return all.length ? all[0] : null;
    },
  };

  if (textContent && (!children || children.length === 0)) {
    el.childNodes.push({ nodeType: 3, nodeValue: textContent });
  }

  for (const c of children) {
    if (typeof c === "string") {
      el.textContent += c;
      el.innerText += c;
      el.childNodes.push({ nodeType: 3, nodeValue: c });
    } else if (c) {
      c.parentElement = el;
      c.parentNode = el;
      el.children.push(c);
      el.childNodes.push(c);
      if (c.textContent) {
        el.textContent += c.textContent;
        el.innerText += c.innerText;
      }
    }
  }

  for (let i = 0; i < el.children.length; i++) {
    el.children[i].nextElementSibling = el.children[i + 1] || null;
    el.children[i].previousElementSibling = el.children[i - 1] || null;
  }
  el.firstElementChild = el.children[0] || null;
  el.lastElementChild = el.children[el.children.length - 1] || null;

  // Define properties for table elements
  if (tag.toUpperCase() === "TABLE") {
    Object.defineProperty(el, "rows", {
      get() {
        return this.querySelectorAll("tr");
      },
    });
  }
  if (tag.toUpperCase() === "TR") {
    Object.defineProperty(el, "cells", {
      get() {
        return this.children.filter((c) => c.tagName === "TH" || c.tagName === "TD");
      },
    });
  }
  if (tag.toUpperCase() === "TD" || tag.toUpperCase() === "TH") {
    Object.defineProperty(el, "rowSpan", {
      get() {
        return parseInt(this.getAttribute("rowspan") || "1", 10);
      },
    });
    Object.defineProperty(el, "colSpan", {
      get() {
        return parseInt(this.getAttribute("colspan") || "1", 10);
      },
    });
  }

  return el;
}

const h = createMockElement;

// =============================================================================
// 1. Facts Preservation, Types & Row Provenance
// =============================================================================

test("Structured Extraction: preserves identifiers, currency, multiline text, empty cells, and row provenance", () => {
  const table = h("table", { id: "orders" }, [
    h("thead", {}, [
      h("tr", {}, [
        h("th", {}, [], "Order ID"),
        h("th", {}, [], "Customer"),
        h("th", {}, [], "Amount"),
        h("th", {}, [], "Status"),
        h("th", {}, [], "Note"),
      ]),
    ]),
    h("tbody", {}, [
      h("tr", { id: "order-1" }, [
        h("td", {}, [], "000123"),
        h("td", {}, [], "Alice"),
        h("td", {}, [], "$1,280.00"),
        h("td", {}, [], "Paid"),
        h("td", {}, ['Line 1, "Quotes"', h("br"), "Line 2"]),
      ]),
      h("tr", {}, [
        h("td", {}, [], "000124"),
        h("td", {}, [], "Bob"),
        h("td", {}, [], "$88.50"),
        h("td", {}, [], "Pending"),
        h("td", {}, [], ""),
      ]),
      h("tr", {}, [
        h("td", {}, [], "000125"),
        h("td", {}, [], "Charlie"),
        h("td", {}, [], "-12.00"),
        h("td", {}, [], "Refunded"),
        h("td", {}, [], "=SUM(1,1)"),
      ]),
      h("tr", { hidden: "true" }, [h("td", {}, [], "SECRET_HIDDEN")]),
    ]),
  ]);

  const options = validateExtract({ action: "table" });
  const raw = collectExtractDom(table, options);
  assert.equal(raw.error, undefined);

  const result = normalizeExtract(raw, options, 1, { page_url: "https://example.com/orders" });

  assert.deepEqual(
    result.columns.map((c) => c.name),
    ["Order ID", "Customer", "Amount", "Status", "Note"]
  );
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows[0], {
    c1: "000123",
    c2: "Alice",
    c3: "$1,280.00",
    c4: "Paid",
    c5: 'Line 1, "Quotes"\nLine 2',
  });
  assert.equal(result.rows[1].c5, "");
  assert.equal(result.rows[2].c5, "=SUM(1,1)");

  // Hidden row must be excluded
  assert.ok(!JSON.stringify(result).includes("SECRET_HIDDEN"));

  // Check row provenance
  assert.equal(result.row_sources[0].source_row, 2);
  assert.equal(result.row_sources[0].row_kind, "data");
  assert.equal(result.row_sources[0].locator, "#order-1");
  assert.equal(result.coverage.truncated, false);
  assert.equal(result.coverage.dataset_complete, "unknown");
});

// =============================================================================
// 2. Multi-Level Hierarchical Headers (header_path)
// =============================================================================

test("Structured Extraction: associates multi-tier column headers into header_path", () => {
  const table = h("table", { id: "financial" }, [
    h("thead", {}, [
      h("tr", {}, [
        h("th", { rowspan: "2" }, [], "Region"),
        h("th", { colspan: "2", scope: "colgroup" }, [], "Revenue"),
        h("th", { rowspan: "2" }, [], "Units"),
      ]),
      h("tr", {}, [
        h("th", {}, [], "Current"),
        h("th", {}, [], "Prior"),
      ]),
    ]),
    h("tbody", {}, [
      h("tr", {}, [
        h("th", { scope: "row" }, [], "North"),
        h("td", {}, [], "12,000"),
        h("td", {}, [], "10,500"),
        h("td", {}, [], "80"),
      ]),
    ]),
  ]);

  const options = validateExtract({ action: "table" });
  const raw = collectExtractDom(table, options);
  const result = normalizeExtract(raw, options, 1);

  assert.deepEqual(
    result.columns.map((c) => c.header_path),
    [["Region"], ["Revenue", "Current"], ["Revenue", "Prior"], ["Units"]]
  );
  assert.deepEqual(
    result.columns.map((c) => c.name),
    ["Region", "Revenue / Current", "Revenue / Prior", "Units"]
  );
  assert.deepEqual(result.rows[0], {
    c1: "North",
    c2: "12,000",
    c3: "10,500",
    c4: "80",
  });
});

// =============================================================================
// 3. Merged Cell Anchors & Spans
// =============================================================================

test("Structured Extraction: retains cell spans anchors and sets covered positions to null", () => {
  const table = h("table", { id: "merged" }, [
    h("thead", {}, [
      h("tr", {}, [
        h("th", {}, [], "Order"),
        h("th", {}, [], "Item"),
        h("th", {}, [], "Qty"),
      ]),
    ]),
    h("tbody", {}, [
      h("tr", {}, [
        h("td", { rowspan: "2" }, [], "A-001"),
        h("td", {}, [], "Keyboard"),
        h("td", {}, [], "1"),
      ]),
      h("tr", {}, [
        h("td", {}, [], "Mouse"),
        h("td", {}, [], "2"),
      ]),
      h("tr", {}, [
        h("td", {}, [], "A-002"),
        h("td", { colspan: "2" }, [], "Cancelled"),
      ]),
    ]),
    h("tfoot", {}, [
      h("tr", {}, [
        h("th", { scope: "row" }, [], "Total"),
        h("td", {}, [], ""),
        h("td", {}, [], "3"),
      ]),
    ]),
  ]);

  const options = validateExtract({ action: "table" });
  const raw = collectExtractDom(table, options);
  const result = normalizeExtract(raw, options, 1);

  assert.deepEqual(result.rows, [
    { c1: "A-001", c2: "Keyboard", c3: "1" },
    { c1: null, c2: "Mouse", c3: "2" },
    { c1: "A-002", c2: "Cancelled", c3: null },
    { c1: "Total", c2: "", c3: "3" },
  ]);

  assert.deepEqual(result.spans, [
    { row: 0, column: "c1", row_span: 2, column_span: 1 },
    { row: 2, column: "c2", row_span: 1, column_span: 2 },
  ]);
  assert.equal(result.row_sources[3].row_kind, "footer");
});

// =============================================================================
// 4. Nested Container Boundary Isolation
// =============================================================================

test("Structured Extraction: completely isolates nested tables without leaking cells into parent", () => {
  const innerTable = h("table", { id: "inner" }, [
    h("thead", {}, [
      h("tr", {}, [h("th", {}, [], "SKU"), h("th", {}, [], "Qty")]),
    ]),
    h("tbody", {}, [
      h("tr", {}, [h("td", {}, [], "SKU-99"), h("td", {}, [], "5")]),
    ]),
  ]);

  const outerTable = h("table", { id: "outer" }, [
    h("thead", {}, [
      h("tr", {}, [h("th", {}, [], "Package"), h("th", {}, [], "Details")]),
    ]),
    h("tbody", {}, [
      h("tr", {}, [
        h("td", {}, [], "Bundle A"),
        h("td", {}, ["Bundle description text", innerTable]),
      ]),
    ]),
  ]);

  const options = validateExtract({ action: "table" });

  // Extract outer table
  const outerRaw = collectExtractDom(outerTable, options);
  const outerResult = normalizeExtract(outerRaw, options, 1);

  assert.deepEqual(outerResult.columns.map((c) => c.name), ["Package", "Details"]);
  assert.equal(outerResult.rows.length, 1);
  assert.equal(outerResult.rows[0].c1, "Bundle A");
  // Outer cell must NOT include inner table's headers or row cells!
  assert.equal(outerResult.rows[0].c2, "Bundle description text");

  // Extract inner table
  const innerRaw = collectExtractDom(innerTable, options);
  const innerResult = normalizeExtract(innerRaw, options, 1);

  assert.deepEqual(innerResult.columns.map((c) => c.name), ["SKU", "Qty"]);
  assert.deepEqual(innerResult.rows, [{ c1: "SKU-99", c2: "5" }]);
});

// =============================================================================
// 5. Virtualized ARIA Grid & Split Row Joining
// =============================================================================

test("Structured Extraction: ARIA grid sorts by aria-rowindex and merges split row fragments", () => {
  // Simulate an enterprise grid with pinned columns and scrollable columns
  // Both fragments share aria-rowindex="2"
  const grid = h("div", { role: "grid", "aria-rowcount": "50", "aria-colcount": "3" }, [
    // Header row
    h("div", { role: "row", "aria-rowindex": "1" }, [
      h("div", { role: "columnheader", "aria-colindex": "1" }, [], "ID"),
      h("div", { role: "columnheader", "aria-colindex": "2" }, [], "Name"),
      h("div", { role: "columnheader", "aria-colindex": "3" }, [], "Score"),
    ]),
    // Split row: Fragment 1 (pinned ID column)
    h("div", { role: "row", id: "row-1-pinned", "aria-rowindex": "2" }, [
      h("div", { role: "gridcell", "aria-colindex": "1" }, [], "P-101"),
    ]),
    // Split row: Fragment 2 (scrollable Name and Score columns)
    h("div", { role: "row", id: "row-1-scroll", "aria-rowindex": "2" }, [
      h("div", { role: "gridcell", "aria-colindex": "2" }, [], "Gamma"),
      h("div", { role: "gridcell", "aria-colindex": "3" }, [], "98.5"),
    ]),
  ]);

  const options = validateExtract({ action: "table" });
  const raw = collectExtractDom(grid, options);
  assert.equal(raw.error, undefined);

  const result = normalizeExtract(raw, options, 1);

  // Must merge split row fragments into a single row
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0], {
    c1: "P-101",
    c2: "Gamma",
    c3: "98.5",
  });
  assert.ok(result.warnings.includes("split_aria_rows_merged"));
  assert.equal(result.row_sources[0].source_row, 2);
  assert.ok(result.row_sources[0].locator.includes(" | "));
  assert.equal(result.coverage.dataset_complete, "incomplete"); // 50 declared, only 1 returned
  assert.equal(result.coverage.declared_rows, 50);
});

// =============================================================================
// 6. Progressive Truncation within max_bytes Budget
// =============================================================================

test("Structured Extraction: fitExtractBudget prunes complete rows without corrupting schema", () => {
  const fullResult = {
    schema_version: 1,
    kind: "table",
    tab_id: 1,
    source: { page_url: "http://test", frame_url: "", frame_id: "root", title: "", captured_at: "now" },
    columns: [{ key: "c1", name: "Col 1", header_path: ["Col 1"], name_source: "header" }],
    rows: Array.from({ length: 50 }, (_, i) => ({ c1: `Item ${i} with extra padding string payload` })),
    row_sources: Array.from({ length: 50 }, (_, i) => ({ row: i, source_row: i + 1, row_kind: "data", locator: `tr:nth-of-type(${i + 1})` })),
    spans: [],
    coverage: { scope: "loaded_dom", rows_returned: 50, truncated: false, dataset_complete: "unknown" },
    warnings: [],
  };

  // Restrict to small byte budget (e.g. 1500 bytes)
  const fitted = fitExtractBudget(fullResult, 1500);

  assert.ok(fitted.rows.length > 0 && fitted.rows.length < 50);
  assert.equal(fitted.row_sources.length, fitted.rows.length);
  assert.equal(fitted.coverage.rows_returned, fitted.rows.length);
  assert.equal(fitted.coverage.truncated, true);
  assert.equal(fitted.coverage.stop_reason, "byte_limit");
  assert.equal(fitted.coverage.dataset_complete, "incomplete");

  const byteLength = new TextEncoder().encode(JSON.stringify(fitted)).length;
  assert.ok(byteLength <= 1500, `Must be within 1500 bytes, was ${byteLength}`);
});

// =============================================================================
// 7. Security: CWE-1236 CSV Formula Injection Defense
// =============================================================================

test("Structured Extraction: applies CWE-1236 formula defense and quotes CSV cells", () => {
  assert.equal(csv_safe("=1+1"), "'=1+1");
  assert.equal(csv_safe("-123"), "'-123");
  assert.equal(csv_safe("+456"), "'+456");
  assert.equal(csv_safe("@SUM"), "'@SUM");
  assert.equal(csv_safe("\tTAB"), "'\tTAB");
  assert.equal(csv_safe("Safe Text"), "Safe Text");

  assert.equal(sanitizeCsvValue("Simple"), "Simple");
  assert.equal(sanitizeCsvValue('Has "Quotes"'), '"Has ""Quotes"""');
  assert.equal(sanitizeCsvValue("Has,Comma"), '"Has,Comma"');
  assert.equal(sanitizeCsvValue("=cmd|'calc'!A0", true), "'=cmd|'calc'!A0");
  assert.equal(sanitizeCsvValue("=cmd|'calc'!A0", false), "=cmd|'calc'!A0");
  assert.equal(sanitizeCsvValue('=cmd,"calc"', true), '"\'=cmd,""calc"""');
});

// =============================================================================
// 8. Parameter Validation & Error Contracts
// =============================================================================

test("Structured Extraction: validateExtract enforces parameter bounds and catches invalid inputs", () => {
  assert.throws(() => validateExtract({ action: "invalid_action" }), /action must be discover, table, or list/);
  assert.throws(() => validateExtract({ action: "table", max_rows: 0 }), /max_rows must be an integer from 1 to 5000/);
  assert.throws(() => validateExtract({ action: "table", max_columns: 250 }), /max_columns must be an integer from 1 to 200/);
  assert.throws(() => validateExtract({ action: "table", max_bytes: 500 }), /max_bytes must be an integer from 1024 to 4194304/);
  assert.throws(
    () => validateExtract({ action: "list", fields: [{ key: "__proto__", selector: "a", read: "text" }] }),
    /reserved object keys/
  );
  assert.throws(
    () => validateExtract({ action: "list", fields: [{ key: "k", selector: "a", read: "invalid" }] }),
    /field read must be text, href, or attribute/
  );
});

// =============================================================================
// 9. Discovery Mode (action: "discover")
// =============================================================================

test("Structured Extraction: action discover finds containers and returns column previews", () => {
  const container = h("div", {}, [
    h("table", { id: "tbl-users" }, [
      h("thead", {}, [
        h("tr", {}, [h("th", {}, [], "Username"), h("th", {}, [], "Email")]),
      ]),
    ]),
    h("ul", { id: "list-tasks", role: "list" }, [
      h("li", { role: "listitem" }, [], "Task 1"),
    ]),
  ]);

  const options = validateExtract({ action: "discover" });
  const raw = collectExtractDom(container, options);

  assert.equal(raw.error, undefined);
  assert.equal(raw.targets.length, 2);
  assert.equal(raw.targets[0].kind, "table");
  assert.equal(raw.targets[0].name, "tbl-users");
  assert.deepEqual(raw.targets[0].columns, ["Username", "Email"]);

  assert.equal(raw.targets[1].kind, "list");
  assert.equal(raw.targets[1].name, "list-tasks");
});

// =============================================================================
// 10. rowspan="0" within row group
// =============================================================================

test("Structured Extraction: resolves rowspan=0 to end of active rowgroup", () => {
  const table = h("table", { id: "tbl-rowspan0" }, [
    h("thead", {}, [
      h("tr", {}, [h("th", {}, [], "Category"), h("th", {}, [], "Value")]),
    ]),
    h("tbody", {}, [
      h("tr", {}, [h("td", { rowspan: "0" }, [], "Group A"), h("td", {}, [], "1")]),
      h("tr", {}, [h("td", {}, [], "2")]),
    ]),
    h("tbody", {}, [
      h("tr", {}, [h("td", {}, [], "Group B"), h("td", {}, [], "3")]),
    ]),
  ]);

  const options = validateExtract({ action: "table" });
  const raw = collectExtractDom(table, options);
  const result = normalizeExtract(raw, options, 1);

  assert.deepEqual(result.rows, [
    { c1: "Group A", c2: "1" },
    { c1: null, c2: "2" },
    { c1: "Group B", c2: "3" },
  ]);
  assert.deepEqual(result.spans, [
    { row: 0, column: "c1", row_span: 2, column_span: 1 },
  ]);
});

// =============================================================================
// 11. Explicit headers attribute associations
// =============================================================================

test("Structured Extraction: honors explicit headers attributes over physical column order", () => {
  const table = h("table", { id: "tbl-headers-attr" }, [
    h("thead", {}, [
      h("tr", {}, [
        h("th", { id: "hdr-cost" }, [], "Cost"),
        h("th", { id: "hdr-name" }, [], "Item Name"),
      ]),
    ]),
    h("tbody", {}, [
      h("tr", {}, [
        // Physically first cell points to hdr-name, second to hdr-cost
        h("td", { headers: "hdr-name" }, [], "Monitor"),
        h("td", { headers: "hdr-cost" }, [], "$250"),
      ]),
    ]),
  ]);

  const options = validateExtract({ action: "table" });
  const raw = collectExtractDom(table, options);
  const result = normalizeExtract(raw, options, 1);

  assert.deepEqual(result.columns.map((c) => c.name), ["Item Name", "Cost"]);
  assert.deepEqual(result.rows[0], {
    c1: "Monitor",
    c2: "$250",
  });
});

// =============================================================================
// 12. Declarative List Extraction
// =============================================================================

test("Structured Extraction: extracts declarative list items with scoped fields", () => {
  const list = h("ul", { id: "search-list", role: "list" }, [
    h("li", { role: "listitem" }, [
      h("h3", {}, [h("a", { href: "/docs/intro" }, [], "Intro Guide")]),
      h("span", { class: "badge" }, [], "New"),
    ]),
    h("li", { role: "listitem" }, [
      h("h3", {}, [h("a", { href: "/docs/advanced" }, [], "Advanced Architecture")]),
      h("span", { class: "badge" }, [], "Updated"),
    ]),
  ]);

  const options = validateExtract({
    action: "list",
    item_selector: 'li[role="listitem"]',
    fields: [
      { key: "title", selector: "h3", read: "text" },
      { key: "url", selector: "a", read: "href" },
      { key: "tag", selector: ".badge", read: "text" },
    ],
  });

  const raw = collectExtractDom(list, options);
  const result = normalizeExtract(raw, options, 1, { page_url: "https://example.com/search" });

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].title, "Intro Guide");
  assert.equal(result.rows[0].tag, "New");
  assert.ok(result.rows[0].url.endsWith("/docs/intro"));

  assert.equal(result.rows[1].title, "Advanced Architecture");
  assert.equal(result.rows[1].tag, "Updated");
});

// =============================================================================
// 13. Empty Table with Headers Intact
// =============================================================================

test("Structured Extraction: zero-row table returns valid schema with columns", () => {
  const table = h("table", { id: "tbl-empty" }, [
    h("thead", {}, [
      h("tr", {}, [h("th", {}, [], "Col A"), h("th", {}, [], "Col B")]),
    ]),
    h("tbody", {}, []),
  ]);

  const options = validateExtract({ action: "table" });
  const raw = collectExtractDom(table, options);
  const result = normalizeExtract(raw, options, 1);

  assert.deepEqual(result.columns.map((c) => c.name), ["Col A", "Col B"]);
  assert.deepEqual(result.rows, []);
  assert.equal(result.coverage.rows_returned, 0);
});

// =============================================================================
// 14. High-Level structuredExtract with CSV Output
// =============================================================================

test("Structured Extraction: structuredExtract high-level handler exports CSV with headers", () => {
  const table = h("table", { id: "tbl-csv" }, [
    h("thead", {}, [
      h("tr", {}, [h("th", {}, [], "Product"), h("th", {}, [], "Price")]),
    ]),
    h("tbody", {}, [
      h("tr", {}, [h("td", {}, [], "Book"), h("td", {}, [], "$15.00")]),
      h("tr", {}, [h("td", {}, [], "Pen"), h("td", {}, [], "=SUM(1,2)")]),
    ]),
  ]);

  const res = structuredExtract(
    { target: table, action: "table", format: "csv", csv_safe: true },
    { resolveTarget: () => table }
  );

  assert.ok(typeof res.csv === "string");
  const lines = res.csv.split("\n");
  assert.equal(lines[0], "Product,Price");
  assert.equal(lines[1], "Book,$15.00");
  assert.equal(lines[2], 'Pen,"\'=SUM(1,2)"');
});
