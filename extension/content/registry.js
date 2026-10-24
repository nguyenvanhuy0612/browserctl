// Element Registry and @e Indexer for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/04-content-and-dom.md.

const refToElement = new Map();
const elementToRef = new WeakMap();
let counter = 0;

/**
 * Normalizes an element reference token, enforcing @e indexing.
 * Strictly forbids deprecated @ref format.
 *
 * @param {string} ref
 * @returns {string} Normalized token (e.g. "@e12")
 */
function normalizeRef(ref) {
  if (!ref) return "";
  const s = String(ref).trim();
  if (s.startsWith("@ref") || s.startsWith("ref_") || s.startsWith("ref")) {
    throw new Error(
      `Invalid element reference '${ref}': deprecated @ref format is forbidden; use @e indexing`
    );
  }
  if (s.startsWith("@e")) return s;
  if (s.startsWith("e") && /^\d+$/.test(s.slice(1))) return "@" + s;
  if (/^\d+$/.test(s)) return "@e" + s;
  return s.startsWith("@") ? s : "@" + s;
}

/**
 * Registers an interactive DOM element and assigns a sequential @e token.
 *
 * @param {Element} el - DOM element to register.
 * @returns {string} Assigned or existing token (e.g. "@e1").
 */
export function registerElement(el) {
  if (!el || typeof el !== "object") return null;
  if (elementToRef.has(el)) {
    return elementToRef.get(el);
  }
  const token = `@e${++counter}`;
  elementToRef.set(el, token);
  refToElement.set(token, el);
  // Also store without '@' for flexible lookup
  refToElement.set(token.slice(1), el);
  return token;
}

/**
 * Retrieves a registered DOM element by its @e token.
 *
 * @param {string} ref - Token e.g. "@e1" or "e1".
 * @returns {Element|null} The registered DOM element or null.
 */
export function getElement(ref) {
  if (!ref) return null;
  const s = String(ref).trim();
  if (s.startsWith("@ref") || s.startsWith("ref_")) {
    throw new Error(
      `Invalid element reference '${ref}': deprecated @ref format is forbidden; use @e indexing`
    );
  }
  if (refToElement.has(s)) {
    return refToElement.get(s);
  }
  const normalized = normalizeRef(s);
  return refToElement.get(normalized) || refToElement.get(normalized.slice(1)) || null;
}

/**
 * Checks whether an element token is currently registered.
 *
 * @param {string} ref
 * @returns {boolean}
 */
export function hasElement(ref) {
  return getElement(ref) != null;
}

/**
 * Gets the token already assigned to an element without creating a new one.
 *
 * @param {Element} el
 * @returns {string|null}
 */
export function getRef(el) {
  return elementToRef.get(el) || null;
}

/**
 * Clears the registry and resets the counter.
 */
export function clearRegistry() {
  refToElement.clear();
  counter = 0;
}

/**
 * Resolves a target string, parameter object, or DOM Element to an element.
 * Throws if the target uses the deprecated @ref prefix.
 *
 * @param {string|object|Element} target
 * @returns {Element|null}
 */
export function resolveTarget(target) {
  if (!target) return null;
  if (typeof target === "object") {
    if (target.nodeType === 1) return target;
    if (target.target) return resolveTarget(target.target);
    if (target.ref) return resolveTarget(target.ref);
    if (target.selector && typeof document !== "undefined") {
      return document.querySelector(target.selector);
    }
  }
  const s = String(target).trim();
  if (s.startsWith("@ref") || s.startsWith("ref_")) {
    throw new Error(
      `Invalid element reference '${s}': deprecated @ref format is forbidden; use @e indexing`
    );
  }
  return getElement(s);
}

export const getOrAssignRef = registerElement;
export const resetRegistry = clearRegistry;
