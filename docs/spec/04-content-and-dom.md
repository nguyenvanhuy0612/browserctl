# Specification 04: Content Script DOM Engine, Census Snapshot & Element Registry

## 1. Content Script Architecture

The content script subsystem operates directly within web page contexts. It executes DOM observation, element accessibility indexing, atomic input dispatch, and 2D table matrix extraction.

```mermaid
flowchart TD
    subgraph PageDOM ["Web Page DOM Context"]
        HTML["DOM Tree"]
        Frames["Subframes / iframes"]
    end

    subgraph ContentEngine ["Content Script Subsystem (extension/content/)"]
        Indexer["Element Registry (@e Indexer)<br/>(registry.js)"]
        Census["Census Snapshot Generator<br/>(snapshot.js)"]
        Setter["10-Step Setter Guard<br/>(setter.js)"]
        TableExt["Table Matrix Reconciler<br/>(table.js)"]
        Observer["DOM Mutation Observer<br/>(observer.js)"]
    end

    subgraph BackgroundWorker ["Extension Background Worker"]
        ExtIPC["chrome.runtime IPC"]
    end

    ExtIPC <-->|"chrome.tabs.sendMessage"| Indexer
    HTML --> Census
    Census --> Indexer
    Indexer -->|"Element References (@e)"| ExtIPC
    Setter -->|"Synthetic Events"| HTML
    TableExt -->|"2D Grid & csv_safe"| ExtIPC
    HTML --> Observer
    Observer -->|"Invalidate Cache"| Indexer
```

---

## 2. Census DOM Snapshot Engine (`extension/content/snapshot.js`)

### 2.1 The `@e` Element Indexing Invariant
- Interactive nodes (links, buttons, inputs, selects, textareas, elements with `role` or click listeners) are indexed sequentially as `@e1`, `@e2`, `@e3`, etc.
- References using the deprecated `@ref` format are strictly forbidden and will fail schema validation.

### 2.2 Pruning & Token Trimming Rules
To keep agent prompt context small and token-efficient:
1. **Visibility Pruning**: Skip elements with:
   - `display: none`
   - `visibility: hidden`
   - `opacity: 0` (unless interactive child within)
   - Zero bounding client rect (`width === 0 && height === 0`)
   - `aria-hidden="true"`
2. **Text Compaction**: Collapse redundant whitespace, strip script/style tags, and truncate text nodes longer than 150 characters with `...`.
3. **Role & Attribute Normalization**: Emit accessible roles (`button`, `link`, `textbox`, `checkbox`, `combobox`) and essential states (`checked`, `disabled`, `expanded`, `selected`).

### 2.3 Output Representation Formats
The snapshot engine supports three output modes:
1. **Compact Census Text (Default)**: Single line per interactive element with `@e` token and reading label. Optimized for minimum token consumption.
2. **Structured Elements (`elements: true`)**: Flat JSON list of interactive element objects.
3. **Virtual Object Model Tree (`format: "vom"`, Opt-in)**: Hierarchical node tree with viewport-relative bounding boxes (`rect: {x, y, w, h}`), parentage (`parentId`, `depth`), and layer classification (`layer: "page" | "modal" | "mask"`). Used when layout or occlusion diagnosis is requested. Retains unified `@e` identifiers; bounded by `maxDepth` (default: 8) and `redactValues: true`.

---

## 3. 10-Step Atomic Setter Guard (`extension/content/setter.js`)

Modern reactive frameworks (React, Vue, Angular, Svelte) intercept standard `.value = val` assignments via custom prototype descriptors. To reliably trigger state synchronization without page corruption:

```javascript
export function setElementValue(element, value) {
  // 1. Focus element
  element.focus();

  // 2. Dispatch pointerdown / mousedown
  element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

  // 3. Locate prototype setter to bypass framework proxies
  const prototype = Object.getPrototypeOf(element);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor && descriptor.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }

  // 4. Dispatch beforeinput
  element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: value }));

  // 5. Dispatch input event (Crucial for React 16+)
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));

  // 6. Dispatch change event
  element.dispatchEvent(new Event("change", { bubbles: true }));

  // 7. Dispatch pointerup / mouseup
  element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

  // 8. Dispatch blur / settle
  element.dispatchEvent(new Event("blur", { bubbles: true }));
}
```

---

## 4. Table Matrix Reconciler & CSV Injection Guard (`extension/content/table.js`)

### 4.1 2D Matrix Grid Algorithm
When extracting tables via `extract_table`, multi-row (`rowspan`) and multi-column (`colspan`) spans must be correctly reconciled into a normalized rectangular grid:
1. Initialize a dynamic 2D grid matrix `grid[row][col]`.
2. Iterate through each row `<tr>`.
3. Track active column index, skipping cells already occupied by previous `rowspan` declarations.
4. Fill all cells spanned by `colspan` and `rowspan` with the cell value.

### 4.2 CSV Formula Injection (CWE-1236) Invariant
Any cell string starting with a formula trigger character must be escaped by prepending an apostrophe (`'`):
```javascript
export function csv_safe(val) {
  if (val == null) return "";
  const s = String(val);
  if (/^[=+\-@\t\r]/.test(s)) {
    return "'" + s;
  }
  return s;
}
```

---

## 5. Multi-Frame Context Handling (`extension/content/frame_bridge.js`)

1. **Same-Origin iframes**:
   - Content script inspects `iframe.contentDocument` directly.
   - Assigns namespaced IDs: `@e12(iframe#login)`.
2. **Cross-Origin iframes**:
   - Direct DOM access is blocked by browser security sandbox.
   - The content script emits frame descriptor metadata (`frameId`, `src`, `rect`).
   - The tool dispatcher routes execution through CDP `driver/frame.js` using `Runtime.evaluate` targeted at the subframe's specific execution context ID.
