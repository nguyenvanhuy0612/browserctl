// Content script: reads the DOM and performs DOM-level actions.
//
// `snapshot` builds a list of interactive elements, assigns each an index, and
// caches the index -> element mapping on the page so later click/type calls can
// resolve by index. The cache is valid until the page re-renders; agents should
// re-snapshot after navigation.

(() => {
  // Guard against double-injection (manifest content_script + programmatic inject).
  if (window.__browserctlLoaded) return;
  window.__browserctlLoaded = true;

  let indexedElements = []; // index -> Element

  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "[role=button]",
    "[role=link]",
    "[role=tab]",
    "[role=menuitem]",
    "[contenteditable=true]",
    "[onclick]",
  ].join(",");

  // Single source of truth for why an element is/isn't visible — isVisible() and
  // describe_element() both read this so the two never drift apart.
  function visibilityReason(el) {
    // Ordered most-specific cause first. A display:none element also has a zero-size
    // rect, so checking the rect first would report the symptom ("zero-size rect")
    // instead of the cause ("display:none") — and this string is what describe_element
    // and the action warnings show the caller, so the cause is what matters.
    const style = getComputedStyle(el);
    if (style.display === "none") return "display:none";
    if (style.visibility === "hidden") return "visibility:hidden";
    if (el.disabled) return "disabled";
    if (style.opacity === "0") return "opacity:0";
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return "zero-size rect";
    return null; // visible
  }

  function isVisible(el) {
    return visibilityReason(el) === null;
  }

  // Actionability check, in the spirit of Playwright's: say why an action probably won't
  // do what the caller expects, instead of reporting a bare success. Deliberately NOT a
  // blanket block — these handlers act via el.click() / the native value setter, which DO
  // fire handlers on a display:none or zero-size element, so refusing would remove
  // capability that currently works (custom checkboxes are a real example: a 0-size input
  // behind a styled label).
  //
  // The one hard stop is `disabled`: browsers suppress click events on a disabled form
  // control and ignore user input to it, so acting and reporting success would be a lie.
  function actionability(el) {
    const reason = visibilityReason(el);
    if (reason === null) return null;
    if (reason === "disabled") {
      throw new Error(
        "element is disabled — a click/type on it cannot take effect (browsers suppress " +
        "input to disabled controls). Enable it first, or act on the control that enables it."
      );
    }
    return reason; // caller surfaces this as a warning alongside its normal result
  }

  function elementText(el) {
    const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    if (text) return text.slice(0, 200);
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("value") ||
      ""
    ).slice(0, 200);
  }

  // Query helpers that pierce OPEN shadow roots (web components). iframes are a
  // separate document tree not reachable here; they are handled instead by the
  // manifest's all_frames injection (this script runs in every frame) + the
  // background worker aggregating per-frame results with frame-qualified refs.
  function deepQueryAll(selector, root = document) {
    const out = [];
    const visit = (node) => {
      try { for (const el of node.querySelectorAll(selector)) out.push(el); } catch { return; }
      for (const el of node.querySelectorAll("*")) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(root);
    return out;
  }
  function deepQuery(selector, root = document) {
    const direct = root.querySelector(selector);
    if (direct) return direct;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        const m = deepQuery(selector, el.shadowRoot);
        if (m) return m;
      }
    }
    return null;
  }

  // Set an input/textarea/select value through the PROTOTYPE's native setter so
  // frameworks that wrap the value property (React/Vue/Ember) observe the change
  // and don't revert it. React patches the instance's own setter to track edits;
  // calling the prototype setter is what its value-tracker keys off.
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const ownSetter = Object.getOwnPropertyDescriptor(el, "value") &&
      Object.getOwnPropertyDescriptor(el, "value").set;
    const protoSetter = Object.getOwnPropertyDescriptor(proto, "value") &&
      Object.getOwnPropertyDescriptor(proto, "value").set;
    if (protoSetter && ownSetter !== protoSetter) protoSetter.call(el, value);
    else if (protoSetter) protoSetter.call(el, value);
    else el.value = value;
  }

  function snapshot(params = {}) {
    const maxText = params.maxText ?? 4000;  // ?? so maxText:0 (elements only, no page text) is honoured
    const nodes = deepQueryAll(INTERACTIVE_SELECTOR).filter(isVisible);

    indexedElements = nodes;
    // Clear stamps from a prior snapshot so a stale index can't resolve to the wrong
    // element, then re-stamp so resolve() can recover a node after the cache goes stale.
    // Use the shadow-piercing query (matching the stamping below) so stale stamps on
    // shadow-DOM elements don't accumulate across snapshots.
    for (const el of deepQueryAll("[data-bctl-ref]")) el.removeAttribute("data-bctl-ref");
    nodes.forEach((el, index) => el.setAttribute("data-bctl-ref", String(index)));
    const elements = nodes.map((el, index) => {
      const item = { index, ref: getOrAssignRef(el), tag: el.tagName.toLowerCase(), text: elementText(el) };
      if (el.tagName === "A" && el.href) item.href = el.getAttribute("href");
      if (el.tagName === "INPUT") {
        item.type = el.type || "text";
        item.value = el.value || "";
        if (el.placeholder) item.placeholder = el.placeholder;
      }
      if (el.tagName === "TEXTAREA") item.value = el.value || "";
      return item;
    });

    return {
      url: location.href,
      title: document.title,
      elements,
      text: (document.body ? document.body.innerText : "").trim().replace(/\s+/g, " ").slice(0, maxText),
    };
  }

  function resolve(index) {
    // 1) Cached node, if still attached to the document.
    const cached = indexedElements[index];
    if (cached && cached.isConnected) return cached;
    // 2) Fall back to the stamped attribute, which survives minor DOM churn.
    const stamped = document.querySelector(`[data-bctl-ref="${index}"]`);
    if (stamped) return stamped;
    // 3) Nothing resolvable.
    if (!cached) throw new Error(`no element at index ${index} (snapshot first?)`);
    throw new Error(`element ${index} is stale (re-snapshot)`);
  }

  // --- Stable element refs (WeakRef) ---
  // Refs survive re-snapshots and don't mutate the DOM (unlike data-bctl-ref stamping).
  // read_page / find / snapshot hand out ref ids; click/type/etc. also accept them.
  let refCounter = 0;
  const refMap = {};                   // refId -> WeakRef<Element>
  const reverseRefMap = new WeakMap(); // Element -> refId

  function getOrAssignRef(el) {
    const existing = reverseRefMap.get(el);
    if (existing && refMap[existing] && refMap[existing].deref() === el) return existing;
    const ref = `ref_${++refCounter}`;
    refMap[ref] = new WeakRef(el);
    reverseRefMap.set(el, ref);
    return ref;
  }

  function resolveRef(refId) {
    const wr = refMap[refId];
    if (!wr) return null;
    const el = wr.deref();
    if (!el || !el.isConnected) { delete refMap[refId]; return null; }
    return el;
  }

  // Resolve a target from either a stable ref or a per-snapshot index.
  function resolveTarget({ index, ref } = {}) {
    if (ref !== undefined && ref !== null) {
      const el = resolveRef(ref);
      if (!el) throw new Error(`ref "${ref}" not found or stale (re-run read_page / snapshot)`);
      return el;
    }
    if (index !== undefined && index !== null) return resolve(index);
    throw new Error("action requires an 'index' or 'ref'");
  }

  // --- Accessibility-tree read (compact indented text) ---
  const TAG_ROLE = {
    a: "link", button: "button", select: "combobox", textarea: "textbox",
    h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
    img: "img", nav: "navigation", main: "main", header: "banner", footer: "contentinfo",
    form: "form", ul: "list", ol: "list", li: "listitem", table: "table",
    summary: "button", label: "label", option: "option",
  };
  const INTERACTIVE_ROLES = new Set([
    "link", "button", "textbox", "combobox", "checkbox", "radio", "slider",
    "searchbox", "tab", "menuitem", "switch", "option",
  ]);

  function roleOf(el) {
    const explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "submit" || t === "button" || t === "reset") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (t === "search") return "searchbox";
      if (t === "hidden") return null;
      return "textbox";
    }
    return TAG_ROLE[tag] || null;
  }

  function accessibleName(el) {
    const pick = (s) => (s ? String(s).trim().replace(/\s+/g, " ").slice(0, 100) : "");
    let n = pick(el.getAttribute && el.getAttribute("aria-label"));
    if (n) return n;
    const labelledby = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelledby) {
      const lbl = document.getElementById(labelledby.split(/\s+/)[0]);
      if (lbl) { n = pick(lbl.innerText); if (n) return n; }
    }
    n = pick(el.getAttribute && el.getAttribute("placeholder")); if (n) return n;
    n = pick(el.getAttribute && el.getAttribute("title")); if (n) return n;
    n = pick(el.getAttribute && el.getAttribute("alt")); if (n) return n;
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) { n = pick(lab.innerText); if (n) return n; }
    }
    if ("value" in el && el.value && String(el.value).length < 50) return pick(el.value);
    const txt = pick(el.innerText || el.textContent);
    if (txt.length >= 3) return txt;
    return "";
  }

  function read_page({ mode = "interactive", depth = 15, ref_id, maxChars = 50000 } = {}) {
    const root = ref_id ? resolveRef(ref_id) : document.body;
    if (ref_id && !root) throw new Error(`ref "${ref_id}" not found or stale; call read_page without ref_id`);
    if (!root) return { url: location.href, title: document.title, tree: "", truncated: false };
    const all = mode === "all";
    const lines = [];
    let size = 0;
    let truncated = false;

    function emit(line) {
      if (size + line.length + 1 > maxChars) { truncated = true; return false; }
      lines.push(line);
      size += line.length + 1;
      return true;
    }

    function walk(el, d) {
      if (truncated || d > depth) return;
      for (const child of el.children) {
        if (truncated) return;
        if (!all) {
          if (child.getAttribute && child.getAttribute("aria-hidden") === "true") continue;
          if (!isVisible(child)) continue;
        }
        const role = roleOf(child);
        const interactive = !!role && INTERACTIVE_ROLES.has(role);
        if (all || interactive || role === "heading") {
          const name = accessibleName(child);
          let line = "  ".repeat(d) + (role || child.tagName.toLowerCase());
          if (name) line += ` "${name}"`;
          if (interactive) line += ` [${getOrAssignRef(child)}]`;
          if (child.tagName === "INPUT") {
            const t = child.getAttribute("type"); if (t) line += ` type="${t}"`;
          }
          if (child.tagName === "SELECT") {
            const opts = Array.from(child.options)
              .map((o) => (o.selected ? `${o.text.trim()} (selected)` : o.text.trim()))
              .slice(0, 20);
            line += ` options=${JSON.stringify(opts)}`;
          }
          if (!emit(line)) return;
        }
        walk(child, d + 1);
        // Descend into an open shadow root so web-component internals appear in the tree.
        if (child.shadowRoot) walk(child.shadowRoot, d + 1);
      }
    }

    walk(root, 0);
    return {
      url: location.href,
      title: document.title,
      tree: lines.join("\n"),
      truncated,
      ...(truncated ? { note: "Output capped at maxChars. Reduce depth or pass a ref_id to focus a subtree." } : {}),
    };
  }

  function find({ query, max = 20 } = {}) {
    if (!query) throw new Error("find requires 'query'");
    const q = String(query).toLowerCase();
    const out = [];
    for (const el of deepQueryAll(INTERACTIVE_SELECTOR)) {
      if (!isVisible(el)) continue;
      const name = accessibleName(el);
      const hay = [
        name,
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.textContent,
      ].filter(Boolean).join(" ").toLowerCase();
      if (hay.includes(q)) {
        out.push({
          ref: getOrAssignRef(el),
          role: roleOf(el) || el.tagName.toLowerCase(),
          name,
          tag: el.tagName.toLowerCase(),
        });
        if (out.length >= max) break;
      }
    }
    return { count: out.length, matches: out };
  }

  // Block-level tags that bound a find_text "container" — text is flattened within one
  // of these (never across them), so a match can span an inline element boundary
  // (a name in its own <a>, followed by plain sibling text) without also merging
  // unrelated paragraphs/cells into one giant string.
  const BLOCK_TAGS = new Set([
    "DIV", "P", "LI", "TD", "TH", "SECTION", "ARTICLE", "ASIDE", "HEADER", "FOOTER",
    "MAIN", "NAV", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "DD", "DT",
    "FIGCAPTION", "PRE", "TABLE", "UL", "OL", "FORM", "BODY",
  ]);

  // Nearest block-level ancestor of el (walking up from el itself), memoized per call
  // since many text nodes share the same immediate parent. Tag-name check only — no
  // getComputedStyle — so this stays cheap even on a DOM with thousands of nodes.
  function blockContainerOf(el, cache) {
    if (cache.has(el)) return cache.get(el);
    let e = el;
    while (e !== document.body && e.parentElement && !BLOCK_TAGS.has(e.tagName)) {
      e = e.parentElement;
    }
    cache.set(el, e);
    return e;
  }

  // Rightmost segment index with start <= offset (binary search).
  function segmentIndexAt(segments, offset) {
    let lo = 0, hi = segments.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid].start <= offset) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // All segments whose text range overlaps [startOff, endOff).
  function segmentsInRange(segments, startOff, endOff) {
    const out = [];
    let i = segmentIndexAt(segments, startOff);
    while (i < segments.length && segments[i].start < endOff) { out.push(segments[i]); i++; }
    return out;
  }

  // Search full page TEXT (not just interactive elements) for a query, returning
  // matching snippets with surrounding context plus the nearest clickable/typeable
  // ancestor(s) — the "does this page contain X, and where" query. Deliberately
  // separate from `find`: widening find's INTERACTIVE_SELECTOR scope to "anything with
  // matching text" would flood its result set on content-heavy pages and defeat its
  // purpose (finding things to act on). find/snapshot stay "what can I click";
  // find_text is "what does the page say, and is it near something clickable".
  //
  // Matches within a text NODE'S nearest block-level container, not just one text node:
  // real pages routinely break a sentence across inline elements (a person's name in its
  // own <a>, followed by plain sibling text), and a per-node-only search misses those
  // entirely — confirmed empirically on a real page ("Kim Bình" + "recommends" in
  // separate nodes; querying the two together found nothing before this fix).
  function find_text({ query, regex = false, max = 20, contextChars = 80 } = {}) {
    if (!query) throw new Error("find_text requires 'query'");
    // Literal mode: escape regex metachars, then make whitespace tolerant (\s+) so a
    // match can span the raw whitespace/newlines of the source HTML without needing to
    // normalize (and therefore offset-remap) the flattened container text.
    const pattern = regex
      ? query
      : String(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const matcher = new RegExp(pattern, "gi");

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const tag = node.parentElement && node.parentElement.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    // Pass 1: group text nodes by nearest block-level container, building each
    // container's flattened raw text plus an offset -> node segment map.
    const containerCache = new Map();
    const containers = new Map(); // blockEl -> { flat, segments: [{start, node}] }
    let node;
    while ((node = walker.nextNode())) {
      const container = blockContainerOf(node.parentElement, containerCache);
      let rec = containers.get(container);
      if (!rec) { rec = { flat: "", segments: [] }; containers.set(container, rec); }
      rec.segments.push({ start: rec.flat.length, node });
      rec.flat += node.nodeValue;
    }

    // Pass 2: match within each container's flattened text.
    const matches = [];
    for (const { flat, segments } of containers.values()) {
      if (matches.length >= max) break;
      matcher.lastIndex = 0;
      let m;
      while ((m = matcher.exec(flat)) && matches.length < max) {
        const matchStart = m.index;
        const matchEnd = matchStart + m[0].length;
        const touched = segmentsInRange(segments, matchStart, matchEnd);
        const ancestors = [];
        const seenRefs = new Set();
        for (const seg of touched) {
          const parent = seg.node.parentElement;
          const ancestor = parent ? parent.closest(INTERACTIVE_SELECTOR) : null;
          if (!ancestor) continue;
          const ref = getOrAssignRef(ancestor);
          if (seenRefs.has(ref)) continue;
          seenRefs.add(ref);
          ancestors.push({ ref, tag: ancestor.tagName.toLowerCase(), text: elementText(ancestor) });
        }
        const start = Math.max(0, matchStart - contextChars);
        const end = Math.min(flat.length, matchEnd + contextChars);
        const snippet =
          (start > 0 ? "…" : "") +
          flat.slice(start, end).trim().replace(/\s+/g, " ") +
          (end < flat.length ? "…" : "");
        const startParent = segments[segmentIndexAt(segments, matchStart)].node.parentElement;
        const match = {
          snippet,
          visible: startParent ? isVisible(startParent) : false,
          nearestInteractive: ancestors[0] || null,
        };
        // Only present when the match spans 2+ distinct interactive ancestors (e.g. a
        // name-link followed by more linked text) — nearestInteractive alone stays the
        // common-case field so existing callers reading it don't need to change.
        if (ancestors.length > 1) match.spanInteractives = ancestors;
        matches.push(match);
        if (m.index === matcher.lastIndex) matcher.lastIndex++; // guard against zero-length match loops
      }
    }
    return { count: matches.length, matches };
  }

  function click({ index, ref }) {
    const el = resolveTarget({ index, ref });
    const warning = actionability(el);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    const out = { clicked: ref != null ? ref : index };
    if (warning) out.warning = `element is not visible (${warning}) — the handler was still invoked, but verify the effect`;
    return out;
  }

  function type({ index, ref, text, submit }) {
    const el = resolveTarget({ index, ref });
    const warning = actionability(el);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    const inputType = el.tagName === "INPUT" ? (el.type || "").toLowerCase() : "";
    if (inputType === "checkbox" || inputType === "radio") {
      // Setting .value on a checkbox/radio has no visible effect (it just changes the
      // submitted value, not the checked state) and reporting success would be
      // misleading — set .checked instead, interpreting text as a truthy string.
      el.checked = /^(true|1|yes|on|checked)$/i.test(String(text).trim());
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if ("value" in el) {
      setNativeValue(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      throw new Error("target element is not editable");
    }
    if (submit) {
      const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13 };
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
      if (el.form) el.form.requestSubmit?.();
    }
    const out = { typed: ref != null ? ref : index };
    if (warning) out.warning = `element is not visible (${warning}) — the action was still applied, but verify the effect`;
    return out;
  }

  function scroll({ direction = "down", amount = 600 }) {
    const delta = direction === "up" ? -amount : amount;
    window.scrollBy({ top: delta, behavior: "instant" in window ? "instant" : "auto" });
    return { scrolledY: window.scrollY };
  }

  function hover({ index, ref }) {
    const el = resolveTarget({ index, ref });
    const warning = actionability(el);
    el.scrollIntoView({ block: "center", inline: "center" });
    const opts = { bubbles: true, cancelable: true };
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mouseenter", opts));
    el.dispatchEvent(new MouseEvent("mousemove", opts));
    const out = { hovered: ref != null ? ref : index };
    if (warning) out.warning = `element is not visible (${warning}) — the action was still applied, but verify the effect`;
    return out;
  }

  function select_option({ index, ref, value, label }) {
    const el = resolveTarget({ index, ref });
    const warning = actionability(el);
    if (el.tagName !== "SELECT") throw new Error("target element is not a select");
    const which = ref != null ? `ref ${ref}` : `index ${index}`;
    let matched = null;
    if (value !== undefined) {
      matched = Array.from(el.options).find((opt) => opt.value === value) || null;
      if (!matched) throw new Error(`no option with value "${value}" in select (${which})`);
    } else if (label !== undefined) {
      matched = Array.from(el.options).find((opt) => opt.text.trim() === label) || null;
      if (!matched) throw new Error(`no option with label "${label}" in select (${which})`);
    } else {
      throw new Error("select_option requires value or label");
    }
    el.value = matched.value;
    matched.selected = true;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    const out = { selected: value !== undefined ? value : label };
    if (warning) out.warning = `element is not visible (${warning}) — the action was still applied, but verify the effect`;
    return out;
  }

  function press_key({ key, index, ref, modifiers }) {
    const target =
      index !== undefined || ref !== undefined
        ? resolveTarget({ index, ref })
        : document.activeElement || document.body;
    if (target.focus) target.focus();
    // Reflect modifiers on the synthetic event so a page's own shortcut handler (which
    // reads e.metaKey / e.ctrlKey / e.shiftKey / e.altKey) still fires. This is a
    // synthetic DOM event, so it does NOT drive native editing — Cmd+A will not select
    // text here. Native editing needs the CDP path, which requires a foreground tab.
    const set = new Set((modifiers || []).map((m) => String(m).toLowerCase()));
    const opts = {
      key,
      code: key,
      bubbles: true,
      cancelable: true,
      altKey: set.has("alt"),
      ctrlKey: set.has("control") || set.has("ctrl"),
      metaKey: set.has("meta") || set.has("command") || set.has("cmd"),
      shiftKey: set.has("shift"),
    };
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keypress", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
    if (key === "Enter" && target.form) target.form.requestSubmit?.();
    return { pressed: key, modifiers: modifiers || [], via: "dom" };
  }

  function wait_for({ selector, text, gone = false, timeoutMs = 8000 }) {
    if (selector === undefined && text === undefined) {
      throw new Error("wait_for requires selector or text");
    }
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        let present;
        if (selector !== undefined) {
          present = !!deepQuery(selector);
        } else {
          present = (document.body ? document.body.innerText : "").includes(text);
        }
        const satisfied = gone ? !present : present;
        if (satisfied) {
          resolve({ found: true, waitedMs: Date.now() - start });
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          reject(new Error(`wait_for timed out after ${timeoutMs}ms`));
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }

  // Wait until the page is loaded AND no CSS/JS animations are running. getAnimations()
  // catches transitions/animations that a load- or network-idle wait misses.
  function wait_settle({ timeoutMs = 10000 } = {}) {
    const start = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        const ready = document.readyState === "complete";
        const anims = document.getAnimations ? document.getAnimations().length === 0 : true;
        if ((ready && anims) || Date.now() - start >= timeoutMs) {
          resolve({ settled: ready && anims, readyState: document.readyState, waitedMs: Date.now() - start });
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  // Resolve an element by ref/index and return its viewport rect. Used by
  // element_screenshot so it can capture ref-addressed (and shadow-DOM) elements,
  // not just the data-bctl-ref index stamp that only snapshot sets.
  function element_rect({ index, ref } = {}) {
    const el = resolveTarget({ index, ref });
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  // Resolve an element by ref/index and dump everything useful for debugging why an
  // action failed or why an element wasn't visible/actionable — the archaeology an
  // agent (or a human) otherwise does by hand: attributes, rect, and a visibility
  // VERDICT WITH REASON (not just true/false) via the same check isVisible() uses.
  // Deliberately excludes the full computed-style dump (hundreds of properties, mostly
  // noise) — attributes + rect + visibility reason covers the real failure modes.
  function describe_element({ index, ref } = {}) {
    const el = resolveTarget({ index, ref });
    const attributes = {};
    for (const attr of el.attributes) attributes[attr.name] = attr.value;
    const r = el.getBoundingClientRect();
    const reason = visibilityReason(el);
    return {
      tag: el.tagName.toLowerCase(),
      text: elementText(el),
      attributes,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      visible: reason === null,
      visibilityReason: reason || "visible",
      matchesInteractiveSelector: el.matches(INTERACTIVE_SELECTOR),
    };
  }

  // Collapse 3+ consecutive repeats of an identical short unit (<=5 words, <=40 chars)
  // into "unit ×N" instead of deleting them. Targets visually-hidden accessible-label
  // spam (e.g. Facebook stamps a hidden "Facebook" label next to every avatar image;
  // innerText picks it up even though sighted users never see it, since it isn't
  // display:none, just visually clipped). Annotating rather than deleting keeps
  // legitimate short repeats readable (a QA results column of "PASS PASS PASS PASS"
  // becomes "PASS ×4", arguably clearer, not lossy).
  //
  // A single backreference regex (e.g. /((?:\S+ ){0,4}\S+)(?: \1){2,}/) looks tempting
  // but is WRONG here: its greedy quantifier locks onto the longest unit length that
  // still finds 2+ repeats and never backtracks to a shorter one just because it'd
  // cover more ground — on a run of N identical single-word tokens it can match a
  // 5-token "unit" repeated a few times and leave most of the run uncollapsed. Explicit
  // token comparison sidesteps that: for each position, try unit lengths 1..5 and keep
  // whichever finds the most total repeats (for a homogeneous run that's always the
  // 1-token unit, since more, smaller repeats beats fewer, larger ones).
  function collapseRepeatedRuns(text) {
    const tokens = text.split(" ");
    const out = [];
    let i = 0;
    while (i < tokens.length) {
      let bestUnitLen = 0;
      let bestRepeats = 1;
      for (let unitLen = 1; unitLen <= 5 && i + unitLen <= tokens.length; unitLen++) {
        const unit = tokens.slice(i, i + unitLen).join(" ");
        if (unit.length > 40) break; // guard: only short units, never paragraphs
        let repeats = 1;
        let j = i + unitLen;
        while (j + unitLen <= tokens.length && tokens.slice(j, j + unitLen).join(" ") === unit) {
          repeats++;
          j += unitLen;
        }
        if (repeats >= 3 && repeats > bestRepeats) {
          bestUnitLen = unitLen;
          bestRepeats = repeats;
        }
      }
      if (bestUnitLen > 0) {
        out.push(`${tokens.slice(i, i + bestUnitLen).join(" ")} ×${bestRepeats}`);
        i += bestUnitLen * bestRepeats;
      } else {
        out.push(tokens[i]);
        i++;
      }
    }
    return out.join(" ");
  }

  // A visible open dialog/modal, if any — picked by longest visible text among
  // candidates. Sites routinely overlay a lightbox (a comment thread, a cookie banner,
  // a "sign in to continue" prompt) on top of the still-present underlying page without
  // removing it from the DOM; confirmed on Facebook, opening a post's comment count link
  // renders a NEW `role="dialog"` on top while the feed stays mounted underneath. The
  // main/article candidate loop below never matches role="dialog" at all, so it falls
  // through to the longest text on the page — which is usually the now-stale underlying
  // content, not the modal the user/agent actually cares about.
  //
  // Longest-VISIBLE-text, not "last in document order": confirmed on the same Facebook
  // case that TWO role="dialog" elements can be present (a hidden utility dialog +/or a
  // nested inner dialog) — last-in-DOM only happens to work by append-order luck.
  // Filtering by rect size + computed visibility, then taking the longest text, handles
  // both "one is hidden" (contributes ~0 text) and "one nests the other" (the outer's
  // text is a superset, so longest is still correct) without a fragile z-index read.
  function visibleDialog() {
    const dialogs = document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]');
    let best = null, bestLen = 0;
    for (const d of dialogs) {
      const r = d.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) continue; // hidden or a trivial stub
      if (getComputedStyle(d).visibility === "hidden") continue;
      const len = (d.innerText || "").length;
      if (len > 200 && len > bestLen) { best = d; bestLen = len; } // 200: skip trivial toasts
    }
    return best;
  }

  function get_page_content({ maxChars = 8000 } = {}) {
    // Checked as an early-exit BEFORE the main/article logic, not folded into its
    // length-comparison loop: the underlying page's `main` is usually longer than the
    // modal's text, so adding the dialog into that same comparison would just recreate
    // the bug. A modal traps interaction — while one is open it effectively IS the page.
    let container = visibleDialog();
    let fromDialog = !!container;
    if (!container) container = document.querySelector("main") || document.querySelector("article");
    if (!container) {
      const candidates = Array.from(
        document.querySelectorAll("main,article,[role=main],#content,#main,.content")
      );
      for (const el of candidates) {
        const len = (el.innerText || "").length;
        if (!container || len > (container.innerText || "").length) container = el;
      }
    }
    if (!container) container = document.body;
    let text = ((container && container.innerText) || "").replace(/\s+/g, " ").trim();
    text = collapseRepeatedRuns(text);
    if (text.length > maxChars) text = text.slice(0, maxChars) + "...[truncated]";
    return { title: document.title, url: location.href, text, ...(fromDialog ? { source: "dialog" } : {}) };
  }

  // Selector-based actions. Indices are per-snapshot, so replay needs stable
  // CSS selectors instead.
  function click_selector({ selector }) {
    const el = deepQuery(selector);
    if (!el) throw new Error("no element matches " + selector);
    const warning = actionability(el);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    const out = { clicked: selector };
    if (warning) out.warning = `element is not visible (${warning}) — the action was still applied, but verify the effect`;
    return out;
  }

  function fill_selector({ selector, value }) {
    const el = deepQuery(selector);
    if (!el) throw new Error("no element matches " + selector);
    const warning = actionability(el);
    el.focus();
    if ("value" in el) {
      setNativeValue(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      throw new Error(selector + " is not editable");
    }
    const out = { filled: selector };
    if (warning) out.warning = `element is not visible (${warning}) — the action was still applied, but verify the effect`;
    return out;
  }

  // Web Storage actions. `area` selects localStorage (default) or sessionStorage.
  function pickStore(area) {
    return area === "session" ? sessionStorage : localStorage;
  }

  function storage_get({ area, key } = {}) {
    const store = pickStore(area);
    if (key !== undefined) {
      return { key, value: store.getItem(key) };
    }
    const items = {};
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      items[k] = store.getItem(k);
    }
    return { items };
  }

  function storage_set({ area, key, value } = {}) {
    if (key === undefined) throw new Error("storage_set requires key");
    pickStore(area).setItem(key, value);
    return { set: key };
  }

  function storage_remove({ area, key } = {}) {
    if (key === undefined) throw new Error("storage_remove requires key");
    pickStore(area).removeItem(key);
    return { removed: key };
  }

  function storage_clear({ area } = {}) {
    pickStore(area).clear();
    return { cleared: area || "local" };
  }

  // Recorder: captures user interactions and streams each step to the background
  // service worker. The content script does NOT accumulate steps locally; the
  // background script owns the recorded sequence.
  let recording = false;
  let recordRemovers = []; // cleanup functions to detach listeners

  // Build a reasonably robust unique CSS selector for an element.
  function cssSelector(el) {
    try {
      if (!el || !el.tagName) return "";
      // Prefer a unique id.
      if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) {
        return "#" + CSS.escape(el.id);
      }
      const segments = [];
      let node = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 5) {
        const tag = node.tagName.toLowerCase();
        // Stop and anchor at an ancestor with an id.
        if (node.id && document.querySelectorAll("#" + CSS.escape(node.id)).length === 1) {
          segments.unshift("#" + CSS.escape(node.id));
          return segments.join(" > ");
        }
        // nth-of-type among same-tag siblings.
        let nth = 1;
        let sib = node.previousElementSibling;
        while (sib) {
          if (sib.tagName === node.tagName) nth++;
          sib = sib.previousElementSibling;
        }
        segments.unshift(tag + ":nth-of-type(" + nth + ")");
        node = node.parentElement;
        depth++;
      }
      return segments.join(" > ");
    } catch (err) {
      return el && el.tagName ? el.tagName.toLowerCase() : "";
    }
  }

  function emitStep(step) {
    if (!recording) return;
    try {
      chrome.runtime.sendMessage({ __bctl_record_step: step });
    } catch (err) {
      // Ignore: background may not be listening; recording is best-effort.
    }
  }

  function onRecordClick(e) {
    if (!recording) return;
    emitStep({
      type: "click",
      selector: cssSelector(e.target),
      text: (e.target.innerText || "").slice(0, 40),
    });
  }

  function onRecordChange(e) {
    if (!recording) return;
    const t = e.target;
    if (!t || !t.tagName) return;
    const tag = t.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;
    emitStep({ type: "input", selector: cssSelector(t), value: t.value });
  }

  function record_start() {
    recording = true;
    // Capture-phase so we see events before page handlers can stop propagation.
    document.addEventListener("click", onRecordClick, true);
    document.addEventListener("change", onRecordChange, true);
    recordRemovers.push(() => document.removeEventListener("click", onRecordClick, true));
    recordRemovers.push(() => document.removeEventListener("change", onRecordChange, true));
    return { recording: true };
  }

  function record_stop() {
    recording = false;
    recordRemovers.forEach((remove) => {
      try {
        remove();
      } catch (err) {
        // Ignore detach failures.
      }
    });
    recordRemovers = [];
    return { recording: false };
  }

  const handlers = {
    snapshot,
    read_page,
    find,
    find_text,
    click,
    type,
    scroll,
    hover,
    select_option,
    press_key,
    wait_for,
    wait_settle,
    get_page_content,
    element_rect,
    describe_element,
    click_selector,
    fill_selector,
    storage_get,
    storage_set,
    storage_remove,
    storage_clear,
    record_start,
    record_stop,
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handler = handlers[msg.action];
    if (!handler) {
      sendResponse({ ok: false, error: `content: unknown action ${msg.action}` });
      return false;
    }
    // Handlers may be sync or async; normalize to a Promise so both work.
    Promise.resolve()
      .then(() => handler(msg.params || {}))
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // keep the message channel open for the async sendResponse
  });
})();
