// Multi-Frame Bridge and Element Namespacing for browserctl.
// Adheres strictly to docs/spec/00-architecture-overview.md and docs/spec/04-content-and-dom.md.

/**
 * Formats a frame-qualified element reference token (e.g. "@f2:e5").
 *
 * @param {number|string} frameId
 * @param {string} elId
 * @returns {string} Qualified token "@f<frameId>:<elId>"
 */
export function formatFrameElementId(frameId, elId) {
  if (frameId === 0 || !frameId) {
    return elId.startsWith("@") ? elId : "@" + elId;
  }
  const cleanEl = elId.replace(/^@/, "");
  return `@f${frameId}:${cleanEl}`;
}

/**
 * Discovers subframes in the current document context and extracts metadata.
 *
 * @param {Document} [doc]
 * @returns {Array<{ frameId: number|null, src: string, rect: object, name: string }>}
 */
export function getFrameDescriptors(doc = null) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || !targetDoc.querySelectorAll) return [];

  const iframes = Array.from(targetDoc.querySelectorAll("iframe, frame"));
  return iframes.map((el, index) => {
    let rect = { x: 0, y: 0, width: 0, height: 0 };
    if (typeof el.getBoundingClientRect === "function") {
      try {
        const b = el.getBoundingClientRect();
        rect = {
          x: Math.round(b.left),
          y: Math.round(b.top),
          width: Math.round(b.width),
          height: Math.round(b.height),
        };
      } catch {}
    }
    return {
      index,
      frameId: el.getAttribute("data-bctl-frame-id")
        ? Number(el.getAttribute("data-bctl-frame-id"))
        : null,
      src: el.src || el.getAttribute("src") || "",
      name: el.getAttribute("name") || el.id || "",
      rect,
    };
  });
}
