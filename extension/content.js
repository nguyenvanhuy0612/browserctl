// Content script: reads the DOM and performs DOM-level actions.
//
// `snapshot` builds a list of interactive elements, assigns each an index, and
// caches the index -> element mapping on the page so later click/type calls can
// resolve by index. The cache is valid until the page re-renders; agents should
// re-snapshot after navigation.

(() => {
  // Guard against double-injection (manifest content_script + programmatic inject).
  if (window.__aiBrowserControlLoaded) return;
  window.__aiBrowserControlLoaded = true;

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

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
      return false;
    }
    if (el.disabled) return false;
    return true;
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
    const maxText = params.maxText || 4000;
    const nodes = deepQueryAll(INTERACTIVE_SELECTOR).filter(isVisible);

    indexedElements = nodes;
    // Clear stamps from a prior snapshot so a stale index can't resolve to the wrong
    // element, then re-stamp so resolve() can recover a node after the cache goes stale.
    // Use the shadow-piercing query (matching the stamping below) so stale stamps on
    // shadow-DOM elements don't accumulate across snapshots.
    for (const el of deepQueryAll("[data-aibc-ref]")) el.removeAttribute("data-aibc-ref");
    nodes.forEach((el, index) => el.setAttribute("data-aibc-ref", String(index)));
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
    const stamped = document.querySelector(`[data-aibc-ref="${index}"]`);
    if (stamped) return stamped;
    // 3) Nothing resolvable.
    if (!cached) throw new Error(`no element at index ${index} (snapshot first?)`);
    throw new Error(`element ${index} is stale (re-snapshot)`);
  }

  // --- Stable element refs (WeakRef) ---
  // Refs survive re-snapshots and don't mutate the DOM (unlike data-aibc-ref stamping).
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

  function click({ index, ref }) {
    const el = resolveTarget({ index, ref });
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    return { clicked: ref != null ? ref : index };
  }

  function type({ index, ref, text, submit }) {
    const el = resolveTarget({ index, ref });
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
    return { typed: ref != null ? ref : index };
  }

  function scroll({ direction = "down", amount = 600 }) {
    const delta = direction === "up" ? -amount : amount;
    window.scrollBy({ top: delta, behavior: "instant" in window ? "instant" : "auto" });
    return { scrolledY: window.scrollY };
  }

  function hover({ index, ref }) {
    const el = resolveTarget({ index, ref });
    el.scrollIntoView({ block: "center", inline: "center" });
    const opts = { bubbles: true, cancelable: true };
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mouseenter", opts));
    el.dispatchEvent(new MouseEvent("mousemove", opts));
    return { hovered: ref != null ? ref : index };
  }

  function select_option({ index, ref, value, label }) {
    const el = resolveTarget({ index, ref });
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
    return { selected: value !== undefined ? value : label };
  }

  function press_key({ key, index, ref }) {
    const target =
      index !== undefined || ref !== undefined
        ? resolveTarget({ index, ref })
        : document.activeElement || document.body;
    if (target.focus) target.focus();
    const opts = { key, code: key, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keypress", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
    if (key === "Enter" && target.form) target.form.requestSubmit?.();
    return { pressed: key };
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
  // not just the data-aibc-ref index stamp that only snapshot sets.
  function element_rect({ index, ref } = {}) {
    const el = resolveTarget({ index, ref });
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  function get_page_content({ maxChars = 8000 } = {}) {
    let container = document.querySelector("main") || document.querySelector("article");
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
    if (text.length > maxChars) text = text.slice(0, maxChars) + "...[truncated]";
    return { title: document.title, url: location.href, text };
  }

  // Selector-based actions. Indices are per-snapshot, so replay needs stable
  // CSS selectors instead.
  function click_selector({ selector }) {
    const el = deepQuery(selector);
    if (!el) throw new Error("no element matches " + selector);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    return { clicked: selector };
  }

  function fill_selector({ selector, value }) {
    const el = deepQuery(selector);
    if (!el) throw new Error("no element matches " + selector);
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
    return { filled: selector };
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
      chrome.runtime.sendMessage({ __aibc_record_step: step });
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
