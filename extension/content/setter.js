// 10-Step Atomic Input Setter Guard for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/04-content-and-dom.md.

/**
 * Walks the prototype chain of an element to find the native setter descriptor,
 * bypassing React/Vue instance-level property overrides.
 *
 * @param {Element} element
 * @param {string} [prop="value"]
 * @returns {function|null} Native setter function or null.
 */
export function findNativeSetter(element, prop = "value") {
  if (!element) return null;
  let cur = Object.getPrototypeOf(element);
  while (cur) {
    const desc = Object.getOwnPropertyDescriptor(cur, prop);
    if (desc && typeof desc.set === "function") {
      return desc.set;
    }
    cur = Object.getPrototypeOf(cur);
  }
  return null;
}

/**
 * Sets an element's value using its native prototype descriptor.
 *
 * @param {Element} element
 * @param {*} value
 * @param {string} [prop="value"]
 */
export function setNativeValue(element, value, prop = "value") {
  if (!element) return;
  const setter = findNativeSetter(element, prop);
  if (setter) {
    setter.call(element, value);
  } else {
    element[prop] = value;
  }
}

/**
 * Normalizes CRLF and inserts text into an editable element with event dispatch.
 *
 * @param {Element} element
 * @param {string} text
 * @returns {{ valueNow: string, matched: boolean }}
 */
export function insertIntoEditable(element, text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  if (typeof element.focus === "function") {
    try {
      element.focus();
    } catch {}
  }

  setNativeValue(element, normalized, "value");

  if (typeof element.dispatchEvent === "function") {
    try {
      const Ev =
        typeof Event !== "undefined"
          ? Event
          : function (t) {
              this.type = t;
            };
      element.dispatchEvent(new Ev("input", { bubbles: true, composed: true }));
      element.dispatchEvent(new Ev("change", { bubbles: true }));
    } catch {}
  }

  const valueNow = element.value !== undefined ? element.value : normalized;
  return {
    valueNow,
    matched: valueNow === normalized,
  };
}

/**
 * 10-Step Atomic Setter Guard:
 * Reliably synchronizes state across reactive UI frameworks (React, Vue, Svelte, Angular)
 * without corruption or missed change events.
 *
 * Steps:
 * 1. element.focus()
 * 2. pointerdown, mousedown
 * 3. Native prototype descriptor value setter (bypassing framework own-property traps)
 * 4. beforeinput
 * 5. input (composed: true)
 * 6. change
 * 7. pointerup, mouseup
 * 8. blur
 *
 * @param {Element} element
 * @param {*} value
 */
export function setElementValue(element, value) {
  if (!element) return;
  const normalizedValue = typeof value === "string" ? value.replace(/\r\n/g, "\n") : value;

  // 1. Focus element
  if (typeof element.focus === "function") {
    try {
      element.focus();
    } catch {}
  }

  // 2. Dispatch pointerdown / mousedown
  if (typeof element.dispatchEvent === "function") {
    try {
      if (typeof PointerEvent !== "undefined") {
        element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      }
      if (typeof MouseEvent !== "undefined") {
        element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      }
    } catch {}
  }

  // 3. Locate prototype setter to bypass framework proxies
  setNativeValue(element, normalizedValue, "value");

  // 4. Dispatch beforeinput
  if (typeof element.dispatchEvent === "function") {
    try {
      if (typeof InputEvent !== "undefined") {
        element.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            inputType: "insertText",
            data: String(normalizedValue),
          })
        );
      }
    } catch {}

    // 5. Dispatch input event (Crucial for React 16+)
    try {
      const Ev =
        typeof Event !== "undefined"
          ? Event
          : function (t) {
              this.type = t;
            };
      element.dispatchEvent(new Ev("input", { bubbles: true, composed: true }));
    } catch {}

    // 6. Dispatch change event
    try {
      const Ev =
        typeof Event !== "undefined"
          ? Event
          : function (t) {
              this.type = t;
            };
      element.dispatchEvent(new Ev("change", { bubbles: true }));
    } catch {}

    // 7. Dispatch pointerup / mouseup
    try {
      if (typeof PointerEvent !== "undefined") {
        element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      }
      if (typeof MouseEvent !== "undefined") {
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      }
    } catch {}

    // 8. Dispatch blur / settle
    try {
      const Ev =
        typeof Event !== "undefined"
          ? Event
          : function (t) {
              this.type = t;
            };
      element.dispatchEvent(new Ev("blur", { bubbles: true }));
    } catch {}
  }
}
