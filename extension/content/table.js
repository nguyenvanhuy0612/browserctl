// 2D Table Matrix Reconciler & CSV Formula Injection Guard for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/04-content-and-dom.md.

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
 * Reconciles multi-row (rowspan) and multi-column (colspan) cell spans into a
 * normalized 2D rectangular grid.
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

  const rows = Array.from(table?.querySelectorAll ? table.querySelectorAll("tr") : []).slice(
    0,
    max_rows
  );
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
 *
 * @param {object} params
 * @param {Element|string} [params.target]
 * @param {string} [params.selector]
 * @param {boolean} [params.csv_safe=true]
 * @param {number} [params.max_rows=500]
 * @param {number} [params.max_cols=100]
 * @param {string} [params.format="json"] - "json" | "csv"
 * @param {object} [context] - Injected resolver helpers if called from content script
 * @returns {object} { headers, rows, total_rows, total_cols, csv? }
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
    return { headers: [], rows: [], total_rows: 0, total_cols: 0 };
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

  return {
    headers,
    rows: resultRows,
    total_rows: resultRows.length,
    total_cols: totalCols,
    ...(csvOutput !== undefined ? { csv: csvOutput } : {}),
  };
}
