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
    if (rect.width === 0 && rect.height === 0) return false;
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

  function snapshot(params = {}) {
    const maxText = params.maxText || 4000;
    const nodes = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter(isVisible);

    indexedElements = nodes;
    // Stamp each indexed node so resolve() can recover it after the cache goes stale.
    nodes.forEach((el, index) => el.setAttribute("data-aibc-ref", String(index)));
    const elements = nodes.map((el, index) => {
      const item = { index, tag: el.tagName.toLowerCase(), text: elementText(el) };
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

  function click({ index }) {
    const el = resolve(index);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    return { clicked: index };
  }

  function type({ index, text, submit }) {
    const el = resolve(index);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    if ("value" in el) {
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      throw new Error(`element ${index} is not editable`);
    }
    if (submit) {
      const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13 };
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
      if (el.form) el.form.requestSubmit?.();
    }
    return { typed: index };
  }

  function scroll({ direction = "down", amount = 600 }) {
    const delta = direction === "up" ? -amount : amount;
    window.scrollBy({ top: delta, behavior: "instant" in window ? "instant" : "auto" });
    return { scrolledY: window.scrollY };
  }

  function hover({ index }) {
    const el = resolve(index);
    el.scrollIntoView({ block: "center", inline: "center" });
    const opts = { bubbles: true, cancelable: true };
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mouseenter", opts));
    el.dispatchEvent(new MouseEvent("mousemove", opts));
    return { hovered: index };
  }

  function select_option({ index, value, label }) {
    const el = resolve(index);
    if (el.tagName !== "SELECT") throw new Error(`element ${index} is not a select`);
    let matched = null;
    if (value !== undefined) {
      matched = Array.from(el.options).find((opt) => opt.value === value) || null;
      if (!matched) throw new Error(`no option with value "${value}" in select ${index}`);
    } else if (label !== undefined) {
      matched = Array.from(el.options).find((opt) => opt.text.trim() === label) || null;
      if (!matched) throw new Error(`no option with label "${label}" in select ${index}`);
    } else {
      throw new Error("select_option requires value or label");
    }
    el.value = matched.value;
    matched.selected = true;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { selected: value !== undefined ? value : label };
  }

  function press_key({ key, index }) {
    const target = index !== undefined ? resolve(index) : document.activeElement || document.body;
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
          present = !!document.querySelector(selector);
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
    const el = document.querySelector(selector);
    if (!el) throw new Error("no element matches " + selector);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    return { clicked: selector };
  }

  function fill_selector({ selector, value }) {
    const el = document.querySelector(selector);
    if (!el) throw new Error("no element matches " + selector);
    el.focus();
    if ("value" in el) {
      el.value = value;
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
    click,
    type,
    scroll,
    hover,
    select_option,
    press_key,
    wait_for,
    get_page_content,
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
