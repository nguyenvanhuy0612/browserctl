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

  // Every ARIA widget role a user can operate, not just the four that were here.
  //
  // The list used to carry `[role=menuitem]` alone, and a CSS attribute selector matches
  // exactly — so `menuitemradio` and `menuitemcheckbox` did not match. GitHub's sort
  // dropdown is built from `menuitemradio`, so an open, fully painted menu was absent
  // from the census entirely: an agent could see it in a screenshot, could not address
  // any item by ref, and fell back to eval_js with a querySelector loop. The same hole
  // hid every custom listbox (`option`), toggle (`switch`), tree and slider on any site.
  //
  // Roles are grouped by what the user does with them so the omissions are visible.
  const INTERACTIVE_SELECTOR = [
    // native
    "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary",
    "[contenteditable=true]", "[contenteditable='']", "[onclick]",
    // command widgets
    "[role=button]", "[role=link]", "[role=menuitem]", "[role=menuitemradio]",
    "[role=menuitemcheckbox]", "[role=tab]", "[role=treeitem]",
    // selection widgets
    "[role=option]", "[role=checkbox]", "[role=radio]", "[role=switch]",
    // input widgets
    "[role=combobox]", "[role=searchbox]", "[role=textbox]", "[role=slider]",
    "[role=spinbutton]",
  ].join(",");

  // Roles whose ARIA state is the point of the control — surfaced as fields so an agent
  // can filter on them instead of parsing them out of a text blob.
  const STATE_ATTRS = ["aria-selected", "aria-checked", "aria-expanded", "aria-current", "aria-pressed", "aria-disabled"];

  function createStructuredError(message, code, diagnostics = {}, recoveryHint = null) {
    const err = new Error(message);
    err.code = code;
    err.diagnostics = diagnostics;
    err.recoveryHint = recoveryHint;
    return err;
  }

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

  // Visually hidden, but genuinely operable.
  //
  // The standard accessible custom-checkbox/radio/toggle is a 1x1 `opacity: 0` input with
  // a visible <label> beside it: the label is what the user sees and clicks, the input is
  // the real control, and Chrome's accessibility tree names it. Booking.com's "I'm
  // travelling for work" is exactly this, and the plain visibility filter dropped it from
  // the census — the agent could not see or target a checkbox that a person operates
  // without a second thought.
  //
  // Narrow on purpose: only form controls, only when a visible label is actually
  // associated. An offscreen or display:none control stays hidden, as it should.
  function isOperableDespiteHidden(el) {
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") return false;
    const reason = visibilityReason(el);
    // display:none and visibility:hidden are removed from the a11y tree too — not this case.
    if (reason !== "opacity:0" && reason !== "zero-size rect") return false;
    let label = null;
    try {
      if (el.id) label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (!label && el.closest) label = el.closest("label");
    } catch { return false; }
    if (!label) return false;
    try {
      const r = label.getBoundingClientRect();
      const st = getComputedStyle(label);
      return r.width > 1 && r.height > 1 && st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
    } catch { return false; }
  }

  // Transparent but painted, named, and in the layout: the reveal-on-hover carousel arrow
  // and the reveal-on-focus skip link. Both are real controls a person uses — Booking's
  // carousel cannot be paged without them — and Chrome exposes both to assistive tech.
  // Excluding them meant an agent simply could not page a carousel.
  //
  // Bounded deliberately: opacity only (never display:none / visibility:hidden), a real
  // box, inside the layout horizontally, and it must have a name. An unnamed transparent
  // element is not something an agent could act on anyway.
  function isRevealable(el) {
    if (visibilityReason(el) !== "opacity:0") return false;
    let r;
    try { r = el.getBoundingClientRect(); } catch { return false; }
    if (r.width < 8 || r.height < 8) return false;
    if (r.right <= 0 || r.left >= window.innerWidth) return false;
    try { return !!fullElementText(el); } catch { return false; }
  }

  // The census filter: visible, operated through a visible label, or revealed on
  // hover/focus. Each non-visible case is marked in the row so the agent knows why the
  // element has no box of its own.
  function isCensusVisible(el) {
    return isVisible(el) || isOperableDespiteHidden(el) || isRevealable(el);
  }

  function isInViewport(el) {
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= 0 &&
      rect.top <= vh &&
      rect.right >= 0 &&
      rect.left <= vw
    );
  }

  // ---------------------------------------------------------------------------
  // Round-2 census helpers (F27, F28, F29, F30, F36, F39)
  // ---------------------------------------------------------------------------

  // Opaque analytics/session parameters. Dropping them costs an agent nothing — the
  // full href is still one `get_attribute href @ref` away — and on a real feed page
  // they were 22% of the whole snapshot payload (F36).
  const HREF_CAP = 100;
  const OPAQUE_VALUE_CHARS = 24;   // a value longer than this is a token, not a choice
  const KEPT_PARAMS = 2;

  // Drop query parameters an agent cannot act on, WITHOUT knowing the site.
  //
  // Two site-agnostic signals do the work: a value long enough to be a token/blob rather
  // than a human-chosen value, and the small set of tracking keys that are conventions
  // across the whole web (utm_*, *clid). Everything else is kept, newest-first, up to
  // two params. Measured on a real feed page, hrefs were 49% of the snapshot payload and
  // opaque tracking blobs alone were 22% — none of which any agent reads. The full href
  // is always one `get_attribute href @ref` away.
  const CONVENTIONAL_TRACKING = /^(utm_|_?ga(_|$)|_hs|mc_[ce]id$|vero_|s_kwcid$)|clid$|^ref(errer)?$/i;

  function shortHref(href) {
    if (!href) return href;
    let s = String(href);
    let hash = "";
    const hi = s.indexOf("#");
    if (hi >= 0) { hash = s.slice(hi); s = s.slice(0, hi); }
    let query = "";
    const qi = s.indexOf("?");
    if (qi >= 0) { query = s.slice(qi + 1); s = s.slice(0, qi); }

    let dropped = 0;
    if (query) {
      const kept = [];
      for (const part of query.split("&")) {
        if (!part) continue;
        const eq = part.indexOf("=");
        const key = (eq < 0 ? part : part.slice(0, eq)).replace(/\[\d+\]$/, "");
        const value = eq < 0 ? "" : part.slice(eq + 1);
        const opaque = value.length > OPAQUE_VALUE_CHARS;
        if (opaque || CONVENTIONAL_TRACKING.test(key)) { dropped++; continue; }
        if (kept.length < KEPT_PARAMS) kept.push(part); else dropped++;
      }
      if (kept.length) s += "?" + kept.join("&");
    }
    // A short hash is often the real destination (#section, #/route); a long one is state.
    if (hash && hash.length <= 24) s += hash;
    if (s.length > HREF_CAP) s = s.slice(0, HREF_CAP) + "\u2026";
    return dropped > 0 ? `${s} [+${dropped} params]` : s;
  }

  // Same normalisation, used to recognise that two anchors point at one destination (F28).
  function normalizedHref(href) {
    if (!href) return "";
    let s = String(href).split("#")[0];
    const qi = s.indexOf("?");
    if (qi < 0) return s;
    const base = s.slice(0, qi);
    const kept = [];
    for (const part of s.slice(qi + 1).split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      const key = (eq < 0 ? part : part.slice(0, eq)).replace(/\[\d+\]$/, "");
      const value = eq < 0 ? "" : part.slice(eq + 1);
      if (value.length > OPAQUE_VALUE_CHARS || CONVENTIONAL_TRACKING.test(key)) continue;
      kept.push(part);
    }
    return kept.length ? base + "?" + kept.sort().join("&") : base;
  }

  // Every visible dialog stacked above the document flow, whether or not it blocks the
  // page. findActiveModal answers "is the page blocked"; this answers "what is open",
  // which is the question an agent working inside a right-rail popover actually has (F27).
  function findOpenDialogs() {
    const out = [];
    let candidates;
    try {
      candidates = deepQueryAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [popover]');
    } catch { return out; }
    for (const d of candidates) {
      const panel = modalPanelOf(d);
      if (!panel) continue;
      const rect = panel.getBoundingClientRect();
      if (rect.width <= 80 || rect.height <= 40) continue;
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
      if (rect.right <= 0 || rect.left >= window.innerWidth) continue;
      let label = "";
      try {
        label = (d.getAttribute("aria-label") ||
          (d.querySelector("h1, h2, h3") || {}).innerText ||
          d.tagName.toLowerCase()).trim().replace(/\s+/g, " ").slice(0, 60);
      } catch { label = d.tagName.toLowerCase(); }
      out.push({
        label,
        tag: d.tagName.toLowerCase(),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        node: d,
      });
    }
    return out;
  }

  // Turn a set of withheld elements into a sentence about *what* is missing rather than
  // how many DOM nodes it is. An agent that has just produced a clean list of twelve
  // people cannot act on "12 elements offscreen"; it can act on "2 more Active contacts" (F30).
  function describeElements(els, limit) {
    const groups = new Map();
    for (const el of els) {
      let info;
      try { info = elementTextInfo(el); } catch { continue; }
      const tag = el.tagName ? el.tagName.toLowerCase() : "element";
      const key = info.text ? info.text.split(" ").slice(0, 4).join(" ").toLowerCase() : `<${tag}>`;
      const g = groups.get(key) || { count: 0, sample: info.text, tag };
      g.count++;
      groups.set(key, g);
    }
    return [...groups.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, limit || 3)
      .map((g) => {
        const what = g.sample
          ? `"${g.sample.slice(0, 44)}${g.sample.length > 44 ? "\u2026" : ""}"`
          : `unlabelled <${g.tag}>`;
        return g.count > 1 ? `${g.count}\u00d7 ${what}` : what;
      });
  }

  // A page's SHAPE, in one line, before any element list.
  //
  // Orientation was the slowest part of every probe: on a list page the census folds most
  // rows into "folded 186 additional content links", so an agent saw a nav bar and a
  // number and had to spend calls discovering that the page is a feed of 30 stories.
  // Volume is not structure. This reports the repeated groups, which is what tells an
  // agent whether it is looking at a list, a form, an article or an app shell.
  function summarizeStructure(nodes) {
    const byLandmark = new Map();
    for (const el of nodes) {
      const lm = getLandmark(el) || "body";
      byLandmark.set(lm, (byLandmark.get(lm) || 0) + 1);
    }

    // A repeated row: a container whose direct children repeat the same tag 4+ times and
    // which actually holds interactive elements. Structural, no site knowledge.
    const inNodes = new Set(nodes);
    const groups = new Map();
    for (const el of nodes) {
      let child = el;
      for (let up = 0; up < 6 && child && child.parentElement; up++) {
        const row = child.parentElement;
        const container = row.parentElement;
        if (!container) break;
        let same = 0;
        for (const sib of container.children) if (sib.tagName === row.tagName) same++;
        if (same >= 4) {
          const g = groups.get(container) || { rows: same, tag: row.tagName.toLowerCase(), members: new Set() };
          g.members.add(el);
          groups.set(container, g);
          break;
        }
        child = row;
      }
    }
    let best = null;
    for (const [container, g] of groups) {
      if (!best || g.members.size > best.g.members.size) best = { container, g };
    }

    const parts = [];
    for (const [lm, n] of [...byLandmark.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
      parts.push(`${lm} ${n}`);
    }
    const out = { regions: parts };
    if (best && best.g.members.size >= 4) {
      // What one row is made of, so "read the 3rd story's points" is expressible.
      const sample = [...best.g.members].slice(0, 12);
      const kinds = new Map();
      for (const el of sample) {
        const k = el.tagName.toLowerCase();
        kinds.set(k, (kinds.get(k) || 0) + 1);
      }
      out.repeated = {
        rows: best.g.rows,
        rowTag: best.g.tag,
        perRow: Math.max(1, Math.round(best.g.members.size / Math.max(1, best.g.rows))),
        kinds: [...kinds.keys()].slice(0, 4),
      };
    }
    const forms = nodes.filter((e) => ["input", "textarea", "select"].includes(e.tagName.toLowerCase())).length;
    if (forms) out.inputs = forms;
    return out;
  }

  // Controls that load content which is not in the DOM yet. `snapshot --all` cannot
  // reveal these rows because they do not exist until something is clicked (F39).
  // Must be a load-more PHRASE. A bare "show" is Hacker News' nav link to Show HN, and a
  // bare "view" or "load" is just as likely to be an ordinary control — matching those
  // put a wrong hint on the page every time, which is how a hint stops being read.
  const LOAD_MORE_RE = /^(see|show|view|load|browse)\s+(previous|more|all|older|newer|earlier|the rest)\b|^(load more|show more|view more|more results|older posts|newer posts)\b/i;

  // Three signals, in order of how site-agnostic they are:
  //   1. aria-expanded="false" — the platform's own "there is more behind this" flag.
  //   2. a control sitting at the end of a run of similar rows — structural, language-free.
  //   3. the English load-more vocabulary — a bonus, and the only locale-bound one, so it
  //      is never the sole basis for the hint.
  function hiddenContentHints(els) {
    const more = [];
    const tabs = [];
    const seen = new Set();
    const add = (el, t, why) => {
      // An unlabelled ref tells the agent nothing it can decide on, so it is noise here.
      if (!t) return;
      if (seen.has(t)) return;
      seen.add(t);
      more.push({ text: t.slice(0, 48), ref: getOrAssignRef(el), why });
    };

    // Signature of each element's nearest repeated-row shape, used for signal 2.
    const sigOf = (el) => {
      const p = el.parentElement;
      return p ? `${p.tagName}|${p.children.length}` : "";
    };
    const runCount = new Map();
    for (const el of els) {
      const sig = sigOf(el);
      if (sig) runCount.set(sig, (runCount.get(sig) || 0) + 1);
    }

    for (const el of els) {
      let info;
      try { info = elementTextInfo(el); } catch { continue; }
      const t = info.text;
      let expanded = null, role = null, selected = null;
      try {
        expanded = el.getAttribute("aria-expanded");
        role = el.getAttribute("role");
        selected = el.getAttribute("aria-selected");
      } catch {}

      // aria-expanded="false" on a menu/dropdown opener is ordinary collapsed UI, not
      // withheld list content. Reporting those made the hint noise on a GitHub issue list
      // ("Dismiss", "Sort by Newest") — and a hint an agent learns to skip is worse than
      // no hint. Only count it when nothing says it merely opens a menu.
      let hasPopup = null;
      try { hasPopup = el.getAttribute("aria-haspopup"); } catch {}
      const opensMenu = !!hasPopup || role === "menuitem" || role === "combobox";

      if (t && LOAD_MORE_RE.test(t)) add(el, t, "load-more label");
      else if (expanded === "false" && !opensMenu && t) add(el, t, "collapsed, aria-expanded=false");
      // Signal 3 needs a real load-more PHRASE, not merely a word that appears inside
      // one. Substring matching on /more|all|previous/ flagged the sidebar's "All" filter
      // and a "Back to previous page" link as withheld content — precisely the noise that
      // teaches an agent to ignore the hint.
      else if (t && t.length <= 24 && (runCount.get(sigOf(el)) || 0) >= 5 &&
               /^(more|older|newer|previous|next|\u2026|\.\.\.)$|^(see|show|view|load|browse)\s+\S/i.test(t)) {
        add(el, t, "control at the end of a repeated run");
      }

      if ((role === "tab" || selected === "true" || selected === "false") && t && t.length <= 28) {
        tabs.push({ text: t, ref: getOrAssignRef(el), selected: selected === "true" });
      }
    }
    return { more: more.slice(0, 4), tabs: tabs.slice(0, 6) };
  }

  // A scrollable region holding more than it shows: the other way content hides (F39).
  function overflowingRegions(root) {
    const out = [];
    let all;
    try { all = root.querySelectorAll("*"); } catch { return out; }
    for (const el of all) {
      if (el.scrollHeight > el.clientHeight + 80 && el.clientHeight > 120) {
        const style = window.getComputedStyle(el);
        if (/(auto|scroll)/.test(style.overflowY)) {
          out.push({ hidden: el.scrollHeight - el.clientHeight, ref: getOrAssignRef(el) });
          if (out.length >= 2) break;
        }
      }
    }
    return out;
  }

  function findActiveModal() {
    // Behaviour, not class names. The class-name heuristics this replaces
    // ([class*="modal"], [class*="drawer"], aside[aria-label], .fxs-blade-layout) both
    // over- and under-matched: a plain npm sidebar <aside> was announced on every
    // snapshot as an "Active Modal ... press Escape to close", and an agent then
    // refused to use dismiss at all for fear of breaking the page. CSS-in-JS obfuscation
    // makes class matching unreliable in the other direction too.
    const dialogs = deepQueryAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]');
    if (dialogs.length === 0) return null;

    const cx = Math.floor(window.innerWidth / 2);
    const cy = Math.floor(window.innerHeight / 2);
    const atCenter = document.elementFromPoint(cx, cy);

    for (const d of dialogs) {
      // A real <dialog> opened with showModal() says so itself.
      try { if (d.matches(":modal") && isVisible(d)) return d; } catch {}

      // Web Components render the actual panel inside their shadow root: every
      // <sl-dialog> host on the Shoelace docs measures 0x0 at opacity 0, open or closed,
      // so measuring the host tells you nothing. Measure what is painted instead.
      const panel = modalPanelOf(d);
      if (!panel) continue;
      const rect = panel.getBoundingClientRect();
      if (rect.width <= 80 || rect.height <= 40) continue;
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;

      // Blocking, by one of two observable signs: it owns the middle of the viewport, or
      // it is fixed/absolute and covers a large share of it. Requiring an observable
      // sign is also what stops a just-closed dialog from being reported while it
      // animates out — it may still be "visible", but it no longer covers anything.
      if (atCenter && composedContains(d, atCenter)) return d;
      const style = window.getComputedStyle(panel);
      if (style.position === "fixed" || style.position === "absolute") {
        const coverage = (rect.width * rect.height) / (window.innerWidth * window.innerHeight);
        if (coverage > 0.25) return d;
      }
    }
    return null;
  }

  // The painted panel of a dialog: the host itself when it has a box, otherwise the
  // largest visible element in its shadow root.
  function modalPanelOf(d) {
    if (!isVisible(d)) {
      // A 0x0 host with a painted shadow panel is normal for Web Components, so an
      // invisible host is only disqualifying when there is no shadow root to look into.
      if (!d.shadowRoot) return null;
    }
    const rect = d.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && isVisible(d)) return d;
    if (!d.shadowRoot) return null;
    let best = null;
    let bestArea = 0;
    let children;
    try { children = d.shadowRoot.querySelectorAll("*"); } catch { return null; }
    for (const el of children) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = el; }
    }
    return best;
  }

  function getLandmark(el) {
    let curr = el;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      if (curr.matches && (curr.matches('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'))) {
        return "modal";
      }
      const role = curr.getAttribute && curr.getAttribute("role");
      if (role === "banner" || curr.tagName === "HEADER") return "header";
      if (role === "navigation" || curr.tagName === "NAV") return "nav";
      if (role === "main" || curr.tagName === "MAIN") return "main";
      if (role === "contentinfo" || curr.tagName === "FOOTER") return "footer";
      if (role === "complementary" || curr.tagName === "ASIDE") return "aside";
      curr = curr.parentElement || (curr.getRootNode && curr.getRootNode().host);
    }
    return "main";
  }

  // Does `ancestor` contain `node` when shadow boundaries are followed? Walks up through
  // parentNode and, at the top of a shadow tree, through the host.
  function composedContains(ancestor, node) {
    if (!ancestor || !node) return false;
    let cur = node;
    for (let depth = 0; cur && depth < 200; depth++) {
      if (cur === ancestor) return true;
      // A ShadowRoot has no parentNode; its `host` is the way out of the shadow tree.
      // (getRootNode() on a ShadowRoot returns itself, so it cannot be used here.)
      cur = cur.parentNode || cur.host || null;
    }
    return false;
  }

  function checkElementCovered(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
    const topEl = document.elementFromPoint(x, y);
    if (!topEl) return null;
    // Node.contains() stops at shadow boundaries, and elementFromPoint retargets across
    // them, so a component's own host was being reported as an unrelated overlay
    // covering its own slotted button. Compare along the composed tree instead.
    if (topEl === el || composedContains(el, topEl) || composedContains(topEl, el)) return null;
    const topTag = topEl.tagName.toLowerCase();
    const topCls = topEl.className && typeof topEl.className === "string" ? "." + topEl.className.trim().split(/\s+/)[0] : "";
    return {
      covered: true,
      coveredBy: topTag + topCls,
      topRef: getOrAssignRef(topEl),
      x,
      y,
    };
  }

  function actionability(el) {
    const reason = visibilityReason(el);
    if (reason === null) return null;
    if (reason === "disabled") {
      throw createStructuredError(
        "element is disabled — a click/type on it cannot take effect (browsers suppress input to disabled controls). Enable it first, or act on the control that enables it.",
        "ELEMENT_DISABLED",
        { disabled: true },
        "Enable the element first or interact with the controlling field."
      );
    }
    return reason;
  }

  const TEXT_CAP = 200;

  // Returns the capped label plus how much was cut, so the census can tell an agent
  // that the rest is one `get text @ref` away instead of leaving it to guess (F35).
  function elementTextInfo(el) {
    const full = fullElementText(el);
    const text = full.slice(0, TEXT_CAP);
    return { text, truncatedBy: Math.max(0, full.length - text.length) };
  }

  // Callers include find(), whose "text-container" rung can hand back a node that is not
  // an Element — so every accessor here is guarded. An unguarded getAttribute took the
  // whole find() handler down, and the frame merge reported it as "no frame could handle
  // this", which reads like a permissions problem rather than a crash.
  // Elements whose text content is DATA, not a name: a <select>'s text is its option
  // list, so a country picker came back named "Vietnam Japan" instead of "Shipping
  // country". Same reasoning that keeps `value` out of the name chain.
  const TEXT_IS_CONTENT = new Set(["SELECT", "TEXTAREA", "OPTION", "PROGRESS", "METER"]);

  function fullElementText(el) {
    if (!el) return "";
    let text = "";
    try {
      if (!TEXT_IS_CONTENT.has(el.tagName)) {
        text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
      }
    } catch {}
    if (text) return text;
    if (typeof el.getAttribute !== "function") return "";
    let attr = "";
    try { attr = (el.getAttribute("aria-label") || "").trim(); } catch {}
    if (attr) return attr;

    // aria-labelledby, for ANY element — not just form controls.
    //
    // Measured against Chrome's own accessibility tree on real sites, this was the single
    // biggest source of anonymous controls: GitHub labels its icon buttons and links by
    // pointing at a hidden tooltip element, so `aria-label` is null and innerText is
    // empty. Six of six unnamed controls on github.com/login were this shape. It is the
    // second rule in the HTML-AAM name computation and was missing entirely.
    try {
      const ref = el.getAttribute("aria-labelledby");
      if (ref) {
        const t = ref.split(/\s+/)
          .map((id) => { try { return document.getElementById(id); } catch { return null; } })
          .filter(Boolean)
          .map((n) => (n.innerText || n.textContent || "").trim())
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (t) return t;
      }
    } catch {}

    // Name from content includes the alt text of descendant images. GitHub's avatar links
    // are `<a><img alt="@sindresorhus profile"></a>`: no text, no aria, and Chrome names
    // them from the img — so they arrived anonymous and indistinguishable from each other.
    try {
      const parts = [];
      const imgs = el.querySelectorAll ? el.querySelectorAll("img[alt], svg[aria-label], [role=img][aria-label]") : [];
      for (const n of imgs) {
        const t = (n.getAttribute("alt") || n.getAttribute("aria-label") || "").trim();
        if (t) parts.push(t);
        if (parts.length >= 2) break;
      }
      const joined = parts.join(" ").replace(/\s+/g, " ").trim();
      if (joined) return joined;
    } catch {}

    try {
      attr = (el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("placeholder") || "").trim();
    } catch {}
    if (attr) return attr;

    // A form control's name comes from its label, never from its value. `value` used to
    // sit in this chain, so `<input type="radio" value="on">` was NAMED "on" — every
    // radio in a group identical, and the label sitting right beside it ignored.
    try {
      const formLabel = controlLabelOf(el);
      if (formLabel) return formLabel;
    } catch {}

    // Only now, and only where the value really is the visible content of the control
    // (a button's caption, a submit's text) rather than a submitted token.
    try {
      const tag = el.tagName;
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "INPUT" && ["button", "submit", "reset"].includes(type)) {
        const v = (el.getAttribute("value") || "").trim();
        if (v) return v;
      }
    } catch {}
    try { return slotLabelOf(el) || ""; } catch { return ""; }
  }

  // The accessible name of a form control, in the order the HTML-AAM spec resolves it:
  // aria-labelledby, an explicit <label for>, a wrapping <label>, then — because custom
  // widgets routinely use none of those — the nearest ancestor that carries short,
  // distinct text.
  function controlLabelOf(el) {
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA" && !el.hasAttribute("role")) return "";
    const clean = (t) => String(t || "").trim().replace(/\s+/g, " ");

    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const parts = labelledby.split(/\s+/)
        .map((id) => { try { return document.getElementById(id); } catch { return null; } })
        .filter(Boolean)
        .map((n) => clean(n.innerText || n.textContent));
      const joined = clean(parts.join(" "));
      if (joined) return joined;
    }
    if (el.id) {
      try {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        const t = lab && clean(lab.innerText);
        if (t) return t;
      } catch {}
    }
    const wrapping = el.closest && el.closest("label");
    if (wrapping) {
      const t = clean(wrapping.innerText);
      if (t) return t;
    }
    // Walk out to the row. A label belongs to exactly ONE control, so the ancestor may
    // not contain any other interactive element — that test is what separates a row from
    // a container. Without it the walk climbed to a page-level wrapper and returned
    // "bctl Test Page go second Click Me 0 Apple Banana Cherry hover me no" as a
    // <select>'s name, which then matched other queries and sent hover to the wrong node.
    let node = el.parentElement;
    for (let up = 0; node && up < 5; node = node.parentElement, up++) {
      let controls;
      try { controls = node.querySelectorAll(INTERACTIVE_SELECTOR).length; } catch { break; }
      if (controls > 1) break;           // a container, not this control's row
      const t = clean(node.innerText || "");
      if (!t) continue;
      if (t.length > 60) break;          // a paragraph or a section, not a label
      return t;
    }
    return "";
  }

  function elementText(el) {
    const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    if (text) return text.slice(0, 200);
    const attr = (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("value") ||
      ""
    ).trim();
    if (attr) return attr.slice(0, 200);
    // A Web Component's inner control renders its label through a <slot>, so its own
    // innerText is empty and it appeared in snapshots as a nameless `<button>` — the
    // element an agent most needs to identify, listed without any way to identify it.
    // Pull the label back from the light DOM the slot projects.
    const slotted = slotLabelOf(el);
    return slotted ? slotted.slice(0, 200) : "";
  }

  function slotLabelOf(el) {
    let slots;
    try { slots = el.querySelectorAll ? el.querySelectorAll("slot") : []; } catch { return ""; }
    for (const slot of slots) {
      if (!slot.assignedNodes) continue;
      let nodes;
      try { nodes = slot.assignedNodes({ flatten: true }); } catch { continue; }
      const t = nodes
        .map((n) => (n.textContent || "").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (t) return t;
    }
    // The element may itself be inside a shadow root whose host carries the label.
    const root = el.getRootNode && el.getRootNode();
    if (root && root.host) {
      const hostText = (root.host.innerText || root.host.textContent || "").trim().replace(/\s+/g, " ");
      if (hostText) return hostText;
    }
    return "";
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
    const compact = !!params.compact;
    const scope = params.scope || "viewport"; // "viewport" (default) or "all"

    const allInteractives = deepQueryAll(INTERACTIVE_SELECTOR).filter(isCensusVisible);
    let nodes = scope === "viewport" ? allInteractives.filter(isInViewport) : allInteractives;

    // Graceful fallback: if viewport scope finds no interactive elements, provide first 40 visible
    if (scope === "viewport" && nodes.length === 0 && allInteractives.length > 0) {
      nodes = allInteractives.slice(0, 40);
    }

    // Reading order, not DOM order. A portal-rendered popover is appended at the end of
    // <body> and used to print after the page content it visually sits on top of, so ref
    // numbers ran backwards down the output (F31). Refs themselves are stable per element.
    try {
      const box = new Map();
      const landmarkFirstRow = new Map();
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        const row = Math.round((r.top + window.scrollY) / 24);
        const lm = getLandmark(el) || "";
        box.set(el, { row, left: Math.round(r.left), lm });
        if (!landmarkFirstRow.has(lm) || row < landmarkFirstRow.get(lm)) landmarkFirstRow.set(lm, row);
      }
      // Landmark blocks stay contiguous — interleaving them would repeat every
      // "[Navigation]" header and cost more than the ordering fix is worth — and inside
      // each block elements run in reading order, so a portal-rendered popover no longer
      // prints before the content it visually sits on top of.
      nodes = nodes.slice().sort((a, b) => {
        const A = box.get(a), B = box.get(b);
        if (A.lm !== B.lm) return landmarkFirstRow.get(A.lm) - landmarkFirstRow.get(B.lm);
        return A.row - B.row || A.left - B.left;
      });
    } catch {}

    indexedElements = nodes;
    // Clear stamps from a prior snapshot so a stale index can't resolve to the wrong
    // element, then re-stamp so resolve() can recover a node after the cache goes stale.
    // Use the shadow-piercing query (matching the stamping below) so stale stamps on
    // shadow-DOM elements don't accumulate across snapshots.
    for (const el of deepQueryAll("[data-bctl-ref]")) el.removeAttribute("data-bctl-ref");
    nodes.forEach((el, index) => el.setAttribute("data-bctl-ref", String(index)));

    const activeModal = findActiveModal();
    const openDialogs = findOpenDialogs();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    const scrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight || 1;
    const scrollPercent = Math.min(100, Math.round((scrollY / Math.max(1, scrollHeight - vh)) * 100));

    const elements = nodes.map((el, index) => {
      const ref = getOrAssignRef(el);
      const tag = el.tagName.toLowerCase();
      const info = elementTextInfo(el);
      const text = info.text;
      const landmark = getLandmark(el);
      const inVp = isInViewport(el);
      const item = { index, ref, tag, text, landmark, inViewport: inVp };
      if (info.truncatedBy > 0) item.textTruncatedBy = info.truncatedBy;
      // A control the user operates through its label, not directly. Clicking the ref
      // still works (the label forwards activation), but the agent should know why the
      // element has no visible box of its own.
      try {
        if (!isVisible(el)) {
          if (isOperableDespiteHidden(el)) item.viaLabel = true;
          else if (isRevealable(el)) item.revealOn = "hover/focus";
        }
      } catch {}
      // Role and ARIA state as fields. An agent asked "which of these is selected"
      // should be able to filter, not infer it from where a word sits in a label.
      try {
        const r = el.getAttribute("role");
        if (r) item.role = r;
        for (const a of STATE_ATTRS) {
          const v = el.getAttribute(a);
          if (v !== null && v !== "") (item.state || (item.state = {}))[a.replace("aria-", "")] = v;
        }
      } catch {}
      if (el.tagName === "A" && el.href) {
        item.href = el.getAttribute("href");
        item.hrefKey = normalizedHref(el.href);
      }
      if (el.tagName === "INPUT") {
        item.type = el.type || "text";
        item.value = el.value || "";
        if (el.placeholder) item.placeholder = el.placeholder;
      }
      if (el.tagName === "TEXTAREA") item.value = el.value || "";
      if (el.tagName === "SELECT") item.value = el.value || "";
      return item;
    });

    const offscreenCount = Math.max(0, allInteractives.length - nodes.length);

    const res = {
      url: location.href,
      title: document.title,
      scope,
      viewport: {
        width: window.innerWidth,
        height: vh,
        scrollY,
        scrollHeight,
        scrollPercent,
      },
      totalElementsCount: allInteractives.length,
      offscreenCount,
      pageState: {
        isBusy: false,
        hasActiveModal: !!activeModal,
        activeModalTag: activeModal ? activeModal.tagName.toLowerCase() : null,
        // Every dialog that is open, blocking or not. hasActiveModal stays the "is the
        // page blocked" answer; this is the "what am I working inside" answer (F27).
        openDialogs: openDialogs.map((d) => ({ label: d.label, tag: d.tag, width: d.width, height: d.height })),
      },
      elements,
      text: (document.body ? document.body.innerText : "").trim().replace(/\s+/g, " ").slice(0, maxText),
    };

    if (compact) {
      // Labels that collide with several others in the same census cannot be aimed at
      // ("open the menu for Mai Thu" is not expressible when eleven rows all read
      // "More"), so those get their row's distinguishing text appended (F29).
      const labelCounts = new Map();
      for (const e of elements) {
        if (!e.text || e.text.length > 24) continue;
        labelCounts.set(e.text, (labelCounts.get(e.text) || 0) + 1);
      }
      const rowContextOf = (e) => {
        if (!e.text || e.text.length > 24) return "";
        if ((labelCounts.get(e.text) || 0) < 3) return "";
        let node = indexedElements[e.index];
        for (let up = 0; node && up < 4; up++) {
          node = node.parentElement;
          if (!node) break;
          let cand;
          try { cand = node.querySelector("a, h1, h2, h3, h4, [role='heading']"); } catch { cand = null; }
          if (!cand) continue;
          let t = "";
          try { t = (cand.innerText || cand.getAttribute("aria-label") || "").trim().replace(/\s+/g, " "); } catch {}
          if (t && t !== e.text && t.length <= 60) return ` (row: "${t.slice(0, 40)}")`;
        }
        return "";
      };

      const formatDesc = (e) => {
        let desc = `[@${e.ref}] <${e.tag}>`;
        if (e.role && e.role !== "button" && e.role !== "link") desc += `[${e.role}]`;
        if (e.type) desc += `[type=${e.type}]`;
        if (e.state) {
          const on = Object.entries(e.state)
            .filter(([, v]) => v === "true" || v === "false" || v === "page" || v === "mixed")
            .map(([k, v]) => (v === "true" ? k : v === "false" ? "" : `${k}=${v}`))
            .filter(Boolean);
          if (on.length) desc += `[${on.join(",")}]`;
        }
        if (e.text) desc += ` "${e.text}"`;
        if (e.textTruncatedBy) desc += ` [+${e.textTruncatedBy} chars: get text @${e.ref}]`;
        if (e.viaLabel) desc += "[via label]";
        if (e.revealOn) desc += "[hidden until hover/focus]";
        if (e.text) desc += rowContextOf(e);
        if (e.placeholder) desc += ` (placeholder: "${e.placeholder}")`;
        if (e.value) desc += ` (value: "${e.value}")`;
        if (e.href) desc += ` -> ${shortHref(e.href)}`;
        return desc;
      };

      // One row, two anchors: sites routinely emit the same destination twice, once with
      // tracking parameters attached. Both were listed, doubling the census for that
      // region and leaving the agent to guess which ref was real (F28).
      const dupOf = new Map();
      const firstByKey = new Map();
      for (const e of elements) {
        if (!e.hrefKey || !e.text) continue;
        const key = e.hrefKey + "\u0000" + e.text;
        if (firstByKey.has(key)) dupOf.set(e.ref, firstByKey.get(key));
        else firstByKey.set(key, e.ref);
      }
      let duplicateCount = 0;

      let foldedCount = 0;
      const lines = [];

      // The shape of the page, before any element. This is the line an agent reads to
      // decide what KIND of thing it is looking at; without it, orientation on a list
      // page cost several exploratory calls.
      const shape = summarizeStructure(nodes);
      const shapeBits = [];
      if (shape.repeated) {
        const r = shape.repeated;
        shapeBits.push(`${r.rows} repeated <${r.rowTag}> rows (~${r.perRow} control${r.perRow > 1 ? "s" : ""} each: ${r.kinds.join(", ")})`);
      }
      if (shape.inputs) shapeBits.push(`${shape.inputs} input${shape.inputs > 1 ? "s" : ""}`);
      if (openDialogs.length) shapeBits.push(`${openDialogs.length} open dialog${openDialogs.length > 1 ? "s" : ""}`);
      // On a trivial page the brief says nothing the element list does not — printing
      // "[Structure: main 1]" above a single link is pure noise.
      if (shapeBits.length > 0 || nodes.length >= 8) {
        shapeBits.push(shape.regions.join(", "));
        lines.push(`[Structure: ${shapeBits.join(" · ")}]`);
      }
      if (activeModal) {
        const modalTitle = (activeModal.getAttribute("aria-label") || activeModal.querySelector("h1, h2, h3, [class*='title' i]")?.innerText || activeModal.tagName.toLowerCase()).trim().replace(/\s+/g, " ").slice(0, 80);
        lines.push(`[Active Modal/Drawer: ${modalTitle} — Press 'Escape' or use 'dismiss' to close]`);
      } else if (openDialogs.length > 0) {
        // Open but not blocking: a right-rail notifications popover owns the interaction
        // without covering the viewport centre, so the modal gate rightly ignores it —
        // and used to leave the agent nothing at all (F27).
        const d = openDialogs[0];
        const extra = openDialogs.length > 1 ? ` (+${openDialogs.length - 1} more open)` : "";
        lines.push(`[Open dialog: "${d.label}" ${d.width}x${d.height}, does not block the page${extra} — use 'dismiss' to close]`);
      }

      // Preserve key editable inputs and search fields at top of compact view
      const keyInputs = elements.filter((e) =>
        e.tag === "input" || e.tag === "textarea" || e.tag === "select"
      );
      if (keyInputs.length > 0) {
        lines.push("[Key Inputs & Search Fields]");
        for (const inp of keyInputs) {
          lines.push(`  ` + formatDesc(inp));
        }
      }

      let lastLandmark = null;
      let mainLinksCount = 0;
      const MAX_MAIN_LINKS = 12;

      let i = 0;
      while (i < elements.length) {
        const e = elements[i];
        if (e.landmark !== lastLandmark) {
          lastLandmark = e.landmark;
          if (e.landmark === "modal") lines.push(`[Active Modal / Dialog]`);
          else if (e.landmark === "header") lines.push(`[Header / Banner]`);
          else if (e.landmark === "nav") lines.push(`[Navigation]`);
        }

        // On dense pages (> 30 elements), fold excessive content links in main feed to protect token budget and avoid runner truncation
        if (elements.length > 30 && e.landmark === "main" && e.tag === "a") {
          mainLinksCount++;
          if (mainLinksCount > MAX_MAIN_LINKS) {
            let foldRunEnd = i;
            const foldedRefs = [];
            while (foldRunEnd < elements.length && elements[foldRunEnd].landmark === "main" && elements[foldRunEnd].tag === "a") {
              foldedRefs.push(`@${elements[foldRunEnd].ref}`);
              foldRunEnd++;
            }
            if (foldedRefs.length > 0) {
              foldedCount += foldedRefs.length;
              const sampleRefs = foldedRefs.slice(0, 5).join(", ") + (foldedRefs.length > 5 ? `, ... +${foldedRefs.length - 5} more` : "");
              // Name what went into the fold. "folded 186 additional content links" hid
              // the fact that the page is a list of stories, so an agent had to spend
              // calls rediscovering it.
              const foldedEls = elements.slice(i, foldRunEnd).map((x) => indexedElements[x.index]).filter(Boolean);
              const kinds = describeElements(foldedEls, 3);
              const what = kinds.length ? ` — ${kinds.join(", ")}` : "";
              lines.push(`  ... [folded ${foldedRefs.length} links${what} (refs: ${sampleRefs}). Use 'find <text>' to target one, or 'snapshot --all' to list them]`);
              i = foldRunEnd;
              continue;
            }
          }
        }

        // Check for repetitive runs (> 3 identical controls)
        const sig = `${e.tag}|${e.type || ""}|${e.text}|${e.placeholder || ""}`;
        let runEnd = i + 1;
        while (runEnd < elements.length) {
          const next = elements[runEnd];
          const nextSig = `${next.tag}|${next.type || ""}|${next.text}|${next.placeholder || ""}`;
          if (nextSig === sig && next.landmark === e.landmark) {
            runEnd++;
          } else {
            break;
          }
        }

        const runLen = runEnd - i;
        if (runLen > 3) {
          lines.push(`  ` + formatDesc(elements[i]));
          lines.push(`  ` + formatDesc(elements[i + 1]));
          const folded = runLen - 2;
          foldedCount += folded;
          const foldedRefs = elements.slice(i + 2, runEnd).map((x) => `@${x.ref}`).join(", ");
          lines.push(`  ... [folded ${folded} repetitive <${e.tag}> "${e.text}" (refs: ${foldedRefs})]`);
          i = runEnd;
        } else {
          if (dupOf.has(e.ref)) { duplicateCount++; i++; continue; }
          lines.push(`  ` + formatDesc(e));
          i++;
        }
      }

      lines.push("");
      lines.push("---");

      // What was withheld, in page terms. "46 elements offscreen" is a token-budget note
      // an agent cannot act on; naming the kind of thing that is missing turns it into a
      // correctness warning (F30, F38).
      if (scope === "viewport" && offscreenCount > 0) {
        const shown = new Set(nodes);
        const missing = allInteractives.filter((el) => !shown.has(el));
        const kinds = describeElements(missing, 3);
        const detail = kinds.length ? `, including ${kinds.join(", ")}` : "";
        lines.push(`[Notice: ${elements.length}/${allInteractives.length} elements visible in viewport. ${offscreenCount} offscreen${detail}. Call 'snapshot --all' to see them, or scroll down]`);
      }
      // 'all' used to say nothing at all about its own folding, so the mode an agent
      // escalates to for completeness was silently incomplete as well (F38).
      if (scope === "all" && foldedCount > 0) {
        lines.push(`[Notice: full-page scope, but ${foldedCount} repetitive elements are folded above. Their refs are listed inline; use 'find <text>' to target one]`);
      }
      if (duplicateCount > 0) {
        lines.push(`[Notice: ${duplicateCount} duplicate link${duplicateCount > 1 ? "s" : ""} suppressed (same destination and label as a row already listed)]`);
      }

      // Content that no scope setting can reveal, because it is not in the DOM yet (F39).
      const hints = hiddenContentHints(nodes);
      const regions = openDialogs.length ? overflowingRegions(openDialogs[0].node) : [];
      if (hints.more.length || hints.tabs.length || regions.length) {
        const bits = [];
        if (hints.more.length) bits.push(hints.more.map((h) => `"${h.text}" (@${h.ref})`).join(", "));
        if (hints.tabs.length) bits.push(`filter tabs: ${hints.tabs.map((t) => `"${t.text}"${t.selected ? " (selected)" : ""} (@${t.ref})`).join(", ")}`);
        if (regions.length) bits.push(`a scrollable region with ~${regions[0].hidden}px below the fold (@${regions[0].ref})`);
        lines.push(`[Possible hidden content: ${bits.join("; ")}. Lists like these load on demand — 'snapshot --all' will NOT reveal rows that are not in the DOM yet; click the control instead]`);
      }

      // Phrased by INTENT, not by tool name. An agent that has just read this census and
      // wants "the price" or "how many of these" has to map that want onto a tool; when
      // the mapping is not in front of it, a low-tier model reaches for eval_js and
      // hand-rolls the read, which costs far more tokens and loses every diagnostic.
      lines.push(`[Next: click/type @ref · read one value: get text @ref · one attribute: get attr @ref href · count: get count <css> · locate a control: find "label" · a value in plain text: find text "label" · more of the page: scroll down or snapshot --all]`);

      res.compactView = lines.join("\n");
      res.foldedCount = foldedCount;
    }

    return res;
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

  // For a custom element with an open shadow root, the first genuinely interactive node
  // inside it — that is where the component's own listener is bound.
  function shadowInteractiveTarget(el) {
    if (!el || !el.tagName || !el.tagName.includes("-") || !el.shadowRoot) return null;
    let inner;
    try { inner = el.shadowRoot.querySelector(INTERACTIVE_SELECTOR); } catch { return null; }
    if (!inner) return null;
    return isVisible(inner) ? inner : null;
  }

  // Counts mutations from BEFORE an action is dispatched. wait_settle's own observer
  // attaches after the event has already fired, so a handler that mutates the DOM
  // synchronously (the common case) was invisible to it and every such action reported
  // domMutated:false — a false "nothing happened" warning on a click that worked.
  function startMutationCounter() {
    let count = 0;
    let obs = null;
    try {
      obs = new MutationObserver((records) => { count += records.length; });
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    } catch {}
    return {
      stop() {
        try { if (obs) obs.disconnect(); } catch {}
        return count;
      },
    };
  }

  // What an action actually DID, as opposed to what was dispatched. Every silent
  // false-success we have seen (a click on a text container, a click on a custom-element
  // host whose real button lives in shadow DOM, an event the page had no listener for)
  // looks identical in the response without this. `measured:false` means autoSettle was
  // off, so absence of change here proves nothing.
  function buildEffect({ urlBefore, el, mutationCount, measured }) {
    return {
      measured: !!measured,
      domMutated: mutationCount > 0,
      mutationCount,
      urlChanged: location.href !== urlBefore,
      targetStillPresent: !!(el && el.isConnected),
    };
  }

  // Nodes matched only by the plain-text fallback of resolveTarget (step 4): they carry
  // the text an agent asked for, but nothing listens for a click on them.
  const textOnlyMatches = new WeakSet();

  // Nearest ancestor that actually responds to activation. Covers native controls plus
  // the hand-rolled ones (role/tabindex/onclick) that make up most of a modern SPA.
  function findInteractiveAncestor(el, maxDepth = 6) {
    let node = el;
    for (let depth = 0; node && depth < maxDepth; depth++) {
      if (node.matches && node.matches(INTERACTIVE_SELECTOR)) return node;
      const role = node.getAttribute && node.getAttribute("role");
      if (role && /^(button|link|menuitem|option|tab|checkbox|radio|switch|treeitem)$/i.test(role)) return node;
      const tabindex = node.getAttribute && node.getAttribute("tabindex");
      if (tabindex && tabindex !== "-1") return node;
      if (node.onclick) return node;
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
    }
    return null;
  }

  // What each ref was pointing at, kept as a plain string so it survives the element
  // being garbage-collected. SPA menus (YouTube, Facebook) re-render between a snapshot
  // and the click that follows it, and a stale ref used to be a dead end: "re-run
  // snapshot" with no way to say WHICH control was wanted. The label lets the error offer
  // the live element that carries the same name.
  const refLabels = Object.create(null);

  function getOrAssignRef(el) {
    const existing = reverseRefMap.get(el);
    if (existing && refMap[existing] && refMap[existing].deref() === el) return existing;
    const ref = `ref_${++refCounter}`;
    refMap[ref] = new WeakRef(el);
    reverseRefMap.set(el, ref);
    try {
      const label = fullElementText(el).slice(0, 80);
      if (label) refLabels[ref] = { label, tag: el.tagName.toLowerCase() };
    } catch {}
    return ref;
  }

  // The element that now carries the label a stale ref used to have. Exact match first,
  // then a diacritics/case-folded match, so a re-render that only changed casing or
  // re-encoded the text still resolves.
  function relocateByLabel(ref) {
    const remembered = refLabels[ref];
    if (!remembered) return null;
    let live;
    try { live = deepQueryAll(INTERACTIVE_SELECTOR).filter(isCensusVisible); } catch { return null; }
    const want = remembered.label;
    const wantFolded = foldText(want);
    let exact = null;
    let folded = null;
    for (const el of live) {
      let t;
      try { t = fullElementText(el).slice(0, 80); } catch { continue; }
      if (!t) continue;
      if (t === want && !exact) exact = el;
      else if (!folded && foldText(t) === wantFolded) folded = el;
    }
    const hit = exact || folded;
    if (!hit) return null;
    return { ref: getOrAssignRef(hit), label: want, exact: hit === exact };
  }

  function resolveRef(refId) {
    const wr = refMap[refId];
    if (!wr) return null;
    const el = wr.deref();
    if (!el || !el.isConnected) { delete refMap[refId]; return null; }
    return el;
  }

  // One text-matching ladder, shared by resolveTarget (act on the first hit) and find
  // (list them all). They used to disagree: find only ever looked at INTERACTIVE_SELECTOR,
  // so on a Web Components page it reported "0 matches" for a button that click(text=...)
  // then hit successfully — an agent would conclude the control did not exist.
  //
  // Rungs, in order of how confidently the hit can be acted on:
  //   interactive     native controls (button, a[href], input, ...)
  //   aria            ARIA widget roles, list items, labels, summary
  //   custom-element  Web Components (tag contains "-"), incl. inside shadow roots
  //   text-container  plain text only — readable, NOT clickable (see click())
  const ARIA_TEXT_SELECTOR = [
    '[role="button"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="tab"]',
    '[role="switch"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="treeitem"]',
    '[role="gridcell"]',
    '[role="row"]',
    '[tabindex="0"]',
    "li",
    "summary",
    "label",
  ].join(",");

  function textHaystack(el) {
    return [
      accessibleName(el),
      el.getAttribute && el.getAttribute("placeholder"),
      el.getAttribute && el.getAttribute("aria-label"),
      el.getAttribute && el.getAttribute("title"),
      elementText(el),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function matchesByText(text, { max = 20 } = {}) {
    const q = String(text).toLowerCase();
    const out = [];
    const seen = new Set();
    const consider = (el, step) => {
      if (out.length >= max || !el || seen.has(el)) return;
      seen.add(el);
      if (!isVisible(el)) return;
      if (!textHaystack(el).includes(q)) return;
      out.push({ el, step });
    };

    for (const el of deepQueryAll(INTERACTIVE_SELECTOR)) consider(el, "interactive");
    if (out.length >= max) return out;

    for (const el of deepQueryAll(ARIA_TEXT_SELECTOR)) consider(el, "aria");
    if (out.length >= max) return out;

    for (const el of deepQueryAll("*")) {
      if (el.tagName && el.tagName.includes("-")) consider(el, "custom-element");
    }
    if (out.length > 0) return out;

    // Last rung only when nothing actionable matched: the lowest container whose text is
    // close to the query, so reads still work. Prefer a real control above it if there is
    // one — a plain <span> is a read target, not a click target.
    const containers = deepQueryAll("span, p, h1, h2, h3, h4, h5, h6, b, strong, div").filter((el) => {
      if (!isVisible(el)) return false;
      const t = (el.innerText || el.textContent || "").trim();
      return t.toLowerCase().includes(q) && t.length <= text.length + 60;
    });
    if (containers.length > 0) {
      const container = containers[containers.length - 1];
      const interactiveAncestor = findInteractiveAncestor(container);
      if (interactiveAncestor) out.push({ el: interactiveAncestor, step: "interactive" });
      else out.push({ el: container, step: "text-container" });
    }
    return out;
  }

  // Resolve a target from stable ref, per-snapshot index, CSS selector, visible text, or placeholder.
  function resolveTarget({ index, ref, selector, text, placeholder } = {}) {
    if (selector) {
      const el = deepQuery(selector);
      if (!el) {
        throw createStructuredError(
          `no element matching selector "${selector}"`,
          "ELEMENT_NOT_FOUND",
          { selector },
          "Verify selector syntax or run snapshot to inspect page elements."
        );
      }
      return el;
    }
    if (text) {
      const found = matchesByText(text, { max: 1 });
      if (found.length === 0) {
        throw createStructuredError(
          `no element found with text matching "${text}"`,
          "ELEMENT_NOT_FOUND",
          { text },
          "Run snapshot --compact to inspect available visible element labels or use a CSS selector."
        );
      }
      const match = found[0].el;
      if (found[0].step === "text-container") textOnlyMatches.add(match);
      return match;
    }
    if (placeholder) {
      const match = deepQueryAll("input, textarea").find((el) => {
        if (!isVisible(el)) return false;
        const p = el.getAttribute("placeholder") || "";
        return p.toLowerCase().includes(placeholder.toLowerCase());
      });
      if (!match) {
        throw createStructuredError(
          `no input found with placeholder matching "${placeholder}"`,
          "ELEMENT_NOT_FOUND",
          { placeholder },
          "Run snapshot --compact to view available input placeholder attributes."
        );
      }
      return match;
    }

    if (ref !== undefined && ref !== null) {
      const el = resolveRef(ref);
      if (el) return el;

      const trimmed = String(ref).trim();
      const atMatch = trimmed.match(/^@?(?:e|ref_?)?(\d+)$/i);
      if (atMatch) {
        const num = parseInt(atMatch[1], 10);
        const refCandidate = resolveRef(`ref_${num}`);
        if (refCandidate) return refCandidate;

        // Deliberately NOTHING else — in particular NOT data-bctl-ref. Despite the
        // name, that attribute carries the 0-based snapshot INDEX, not the 1-based ref
        // number, so `[data-bctl-ref="N"]` for ref_N resolves to the element after the
        // intended one. Verified: with ref_4 stale, the stamped lookup returned "Echo"
        // (index 4) in place of "DELETE-ME" (ref_4 / index 3). Index resolution uses
        // the stamps correctly in resolve(); the ref namespace must not touch them.
        //
        // The rest of the old fallback chain tried snapshot index
        // `num`, then `num - 1`, then the num-th visible interactive element — but refs
        // are 1-based while indexedElements is 0-based, so a stale ref_N silently
        // resolved to the element AFTER the intended one and the action reported
        // success against the wrong target. A re-snapshot costs one cheap call; a
        // wrong click cannot be taken back.
      }
      // Callers pass "@ref_2", "ref_2" or "2"; the registry is keyed "ref_2".
      const canonical = atMatch ? `ref_${parseInt(atMatch[1], 10)}` : String(ref).trim().replace(/^@/, "");
      const moved = relocateByLabel(canonical);
      if (moved) {
        throw createStructuredError(
          `ref "${ref}" is stale — the page re-rendered. The control labelled "${moved.label}" is now @${moved.ref}${moved.exact ? "" : " (matched ignoring case/diacritics)"}; retry with that ref.`,
          "STALE_REF",
          { ref, relocatedTo: moved.ref, label: moved.label, exactLabelMatch: moved.exact },
          `Retry the same action with @${moved.ref}. No re-snapshot needed.`
        );
      }
      throw createStructuredError(
        `ref "${ref}" not found or stale (re-run read_page / snapshot)`,
        "STALE_REF",
        { ref, rememberedLabel: refLabels[canonical] ? refLabels[canonical].label : null },
        refLabels[canonical]
          ? `This ref pointed at "${refLabels[canonical].label}", which is no longer on the page. Call snapshot to see what replaced it, or find "${refLabels[canonical].label}".`
          : "The element referenced by this ref is no longer in the DOM or was detached. Call snapshot again to refresh refs."
      );
    }

    if (index !== undefined && index !== null) {
      return resolve(index);
    }

    throw new Error("action requires an 'index', 'ref', 'selector', 'text', or 'placeholder'");
  }

  // --- Accessibility-tree read (compact indented text) ---
  const TAG_ROLE = {
    a: "link", button: "button", select: "combobox", textarea: "textbox",
    h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
    img: "img", nav: "navigation", main: "main", header: "banner", footer: "contentinfo",
    form: "form", ul: "list", ol: "list", li: "listitem", table: "table",
    summary: "button", label: "label", option: "option",
  };
  // Kept in step with INTERACTIVE_SELECTOR above. It used to omit menuitemradio /
  // menuitemcheckbox / treeitem / spinbutton, so read_page listed a control that
  // snapshot did not, or the reverse — the two readers disagreed about what was on the
  // page, and an agent that happened to pick read_page could not see an open menu.
  const INTERACTIVE_ROLES = new Set([
    "link", "button", "textbox", "combobox", "checkbox", "radio", "slider",
    "searchbox", "tab", "menuitem", "menuitemradio", "menuitemcheckbox",
    "switch", "option", "treeitem", "spinbutton",
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
    const txt = TEXT_IS_CONTENT.has(el.tagName) ? "" : pick(el.innerText || el.textContent);
    if (txt.length >= 3) return txt;

    // Same resolution the census uses. read_page and find run through THIS function, so
    // leaving it out meant the F61 fix landed in snapshot only: the audience radios were
    // named in the census and still anonymous in the accessibility tree, and `find`
    // matched the surrounding TEXT rather than the control — reporting a hit that
    // click then refused as a text-container.
    try {
      const formLabel = controlLabelOf(el);
      if (formLabel) return pick(formLabel);
    } catch {}

    // `value` last, and only where it is the control's caption rather than a submitted
    // token — `<input type="radio" value="on">` is not named "on".
    try {
      const tag = el.tagName;
      const type = (el.getAttribute("type") || "").toLowerCase();
      const valueIsCaption = tag === "INPUT" && ["button", "submit", "reset"].includes(type);
      const valueIsContent = tag === "INPUT" && ["text", "search", "email", "url", "tel", "number", "password", ""].includes(type);
      if ((valueIsCaption || valueIsContent) && el.value && String(el.value).length < 50) return pick(el.value);
    } catch {}
    return "";
  }

  // depth used to default to 15. A React/Comet SPA nests its content 25-45 levels deep,
  // so the walk stopped before reaching anything and returned two headings with
  // `truncated: false` — telling the agent the page really was that empty (F33).
  function read_page({ mode = "interactive", depth = 60, ref_id, maxChars = 50000 } = {}) {
    const root = ref_id ? resolveRef(ref_id) : document.body;
    if (ref_id && !root) throw new Error(`ref "${ref_id}" not found or stale; call read_page without ref_id`);
    if (!root) return { url: location.href, title: document.title, tree: "", truncated: false };
    const all = mode === "all";
    const lines = [];
    let size = 0;
    let truncated = false;
    let depthClipped = false;
    let deepest = 0;
    // Script and style bodies are not accessibility nodes. mode='all' was emitting the
    // page's inline JSON payloads as tree rows — 55KB of noise on a real page (F33).
    const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META"]);

    function emit(line) {
      if (size + line.length + 1 > maxChars) { truncated = true; return false; }
      lines.push(line);
      size += line.length + 1;
      return true;
    }

    function walk(el, d) {
      if (truncated) return;
      if (d > depth) { if (el.children && el.children.length) depthClipped = true; return; }
      if (d > deepest) deepest = d;
      for (const child of el.children) {
        if (truncated) return;
        if (SKIP_TAGS.has(child.tagName)) continue;
        let listThis = true;
        if (!all) {
          if (child.getAttribute && child.getAttribute("aria-hidden") === "true") continue;
          const reason = visibilityReason(child);
          if (reason === "display:none" || reason === "visibility:hidden") continue;
          // A zero-size or fully transparent element is not necessarily an empty branch:
          // React portals mount dialogs, popovers and toasts inside a 0x0 wrapper whose
          // children are absolutely positioned and fully painted. Pruning the subtree on
          // the wrapper hid the entire open notifications panel from read_page while the
          // panel was on screen — the agent could see it in a screenshot and not in the
          // tree. Skip listing the wrapper, but keep walking into it.
          if (reason !== null) listThis = false;
        }
        const role = roleOf(child);
        const interactive = !!role && INTERACTIVE_ROLES.has(role);
        if (listThis && (all || interactive || role === "heading")) {
          const name = accessibleName(child);
          let line = "  ".repeat(d) + (role || child.tagName.toLowerCase());
          if (name) line += ` "${name}"`;
          // Same state fields the census carries, so the two readers agree.
          try {
            const st = STATE_ATTRS
              .map((a) => [a.replace("aria-", ""), child.getAttribute(a)])
              .filter(([, v]) => v === "true" || v === "mixed" || v === "page")
              .map(([k, v]) => (v === "true" ? k : `${k}=${v}`));
            if (st.length) line += ` [${st.join(",")}]`;
          } catch {}
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

    // The same three facts snapshot reports. Agents pick between the two readers freely,
    // so a warning that exists in only one of them is a warning that fires half the time:
    // three consecutive probe runs chose read_page and therefore saw none of this.
    const notices = [];
    try {
      // The same shape line the census leads with. Agents pick freely between the two
      // readers, and orientation must not depend on which one they happened to choose —
      // a probe that reached for read_page fell back to a 108 KB screenshot to work out
      // that the page was a list, which the census answers in one line.
      const visibleNow = deepQueryAll(INTERACTIVE_SELECTOR).filter(isCensusVisible);
      const shape = summarizeStructure(visibleNow);
      const bits = [];
      if (shape.repeated) bits.push(`${shape.repeated.rows} repeated <${shape.repeated.rowTag}> rows (~${shape.repeated.perRow} control${shape.repeated.perRow > 1 ? "s" : ""} each)`);
      if (shape.inputs) bits.push(`${shape.inputs} inputs`);
      if (bits.length || visibleNow.length >= 8) {
        bits.push(shape.regions.join(", "));
        notices.push(`Structure: ${bits.join(" · ")}`);
      }
    } catch {}
    try {
      const dialogs = findOpenDialogs();
      if (dialogs.length) {
        const d = dialogs[0];
        notices.push(`Open dialog: "${d.label}" ${d.width}x${d.height}${dialogs.length > 1 ? ` (+${dialogs.length - 1} more)` : ""} — its contents are included above.`);
      }
      const visible = deepQueryAll(INTERACTIVE_SELECTOR).filter(isCensusVisible);
      const hints = hiddenContentHints(visible);
      const regions = dialogs.length ? overflowingRegions(dialogs[0].node) : [];
      if (hints.more.length || regions.length) {
        const bits = [];
        if (hints.more.length) bits.push(hints.more.map((h) => `"${h.text}" (@${h.ref})`).join(", "));
        if (regions.length) bits.push(`a scrollable region with ~${regions[0].hidden}px below the fold (@${regions[0].ref})`);
        notices.push(`Possible hidden content: ${bits.join("; ")}. Lists like these load on demand — no depth or scope setting reveals rows that are not in the DOM yet; click the control instead.`);
      }
      if (hints.tabs.length) {
        notices.push(`Filter tabs present: ${hints.tabs.map((t) => `"${t.text}"${t.selected ? " (selected)" : ""} (@${t.ref})`).join(", ")} — the list you are reading may be one filtered view of several.`);
      }
    } catch {}

    const empty = lines.length === 0;
    return {
      url: location.href,
      title: document.title,
      tree: lines.join("\n"),
      truncated,
      depthUsed: depth,
      deepestReached: deepest,
      ...(notices.length ? { notices } : {}),
      // An empty-looking tree now says why it is empty instead of implying the page is.
      ...(depthClipped ? { depthClipped: true } : {}),
      ...(truncated ? { note: "Output capped at maxChars. Reduce depth or pass a ref_id to focus a subtree." } : {}),
      ...(depthClipped && !truncated
        ? { note: `Walk stopped at depth ${depth} with deeper nodes remaining, so most of this page is MISSING from the tree above — do not treat it as the page's contents. Re-call with depth 60 (the default), or use browser_snapshot, which has no depth limit and costs a fraction of a screenshot.` }
        : {}),
      ...(empty && !depthClipped
        ? { note: "No interactive elements or headings matched. Try mode='all', or browser_snapshot." }
        : {}),
    };
  }

  // NFD-fold: strip diacritics and case so "Vo Kim Dinh" can be recognised as a near miss
  // for "Võ Kim Đính". Used only to suggest, never to match (F34).
  function foldText(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d").replace(/Đ/g, "D")
      .toLowerCase()
      .trim();
  }

  function nearestLabels(query, limit) {
    const q = foldText(query);
    if (!q) return [];
    const out = [];
    const seen = new Set();
    let all;
    try { all = deepQueryAll(INTERACTIVE_SELECTOR).filter(isCensusVisible); } catch { return []; }
    for (const el of all) {
      let t;
      try { t = elementTextInfo(el).text; } catch { continue; }
      if (!t || seen.has(t)) continue;
      const f = foldText(t);
      if (!f) continue;
      // Same string once diacritics and case are removed, or one contains the other.
      if (f === q || f.includes(q) || q.includes(f)) {
        seen.add(t);
        out.push({ ref: getOrAssignRef(el), name: t.slice(0, 80), reason: f === q ? "diacritics/case only" : "substring after folding" });
        if (out.length >= (limit || 3)) break;
      }
    }
    return out;
  }

  // The most prominent interactive labels on the page, as the page words them. Ordered by
  // reading position so the header and primary nav come first, which is where a control
  // an agent is hunting for usually lives.
  function pageVocabulary(limit) {
    let els;
    // Visible, but NOT viewport-limited: the point is to show the page's words, and a
    // background window renders very little above the fold. Reading order keeps the
    // header and primary nav first, which is where a hunted-for control usually is.
    try { els = deepQueryAll(INTERACTIVE_SELECTOR).filter(isCensusVisible); } catch { return []; }
    const seen = new Set();
    const out = [];
    for (const el of els) {
      let t;
      try { t = elementTextInfo(el).text; } catch { continue; }
      if (!t || t.length > 40 || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= (limit || 12)) break;
    }
    return out;
  }

  function find({ query, max = 20 } = {}) {
    if (!query) throw new Error("find requires 'query'");
    const hits = matchesByText(query, { max });
    const out = hits.map(({ el, step }) => ({
      ref: getOrAssignRef(el),
      role: roleOf(el) || el.tagName.toLowerCase(),
      name: accessibleName(el),
      tag: el.tagName.toLowerCase(),
      // Which rung of the ladder found it. "text-container" means the text is there but
      // nothing listens for a click on it, so click() will refuse the ref by design.
      matchedBy: step,
      clickable: step !== "text-container",
      ...(() => {
        const cut = elementTextInfo(el).truncatedBy;
        return cut ? { truncatedBy: cut, fullTextVia: `get text @${getOrAssignRef(el)}` } : {};
      })(),
    }));
    if (out.length === 0) {
      // A bare `count: 0` cannot tell an agent whether the label is absent, spelled
      // differently, or out of scope. Four searches once missed by a single diacritic
      // and the agent concluded the matcher could not handle Vietnamese (F34).
      const nearest = nearestLabels(query, 3);
      return {
        count: 0,
        matches: [],
        searchedScope: "top frame, open Shadow DOM and iframes",
        ...(nearest.length ? { nearest } : {}),
        // Show the page's own vocabulary. A probe on a Vietnamese YouTube burned three
        // calls guessing "account", "profile", "studio" — the control it wanted was
        // labelled "Trình đơn tài khoản". No amount of fuzzy matching bridges that, but
        // one look at the actual labels does, and it costs a few dozen tokens.
        pageLabels: pageVocabulary(12),
        note: nearest.length
          ? "No exact match. 'nearest' lists labels that differ only by case/diacritics; 'pageLabels' shows what this page actually calls things."
          : "No exact match. 'pageLabels' shows what this page actually calls things — the label you want is probably there, in the page's own language. If not, it may be offscreen, in a closed shadow root, or not loaded yet.",
      };
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

    const acceptNode = (node) => {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const tag = node.parentElement && node.parentElement.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    };

    // A TreeWalker stops at shadow boundaries, so a document-only walk misses every
    // Web Component's text — while snapshot.text (innerText) and wait_for(text) DO see
    // it. That disagreement made a 0-match answer here indistinguishable from "absent"
    // on any component-based site. Collect the shadow roots and walk each of them too,
    // then report the scope actually searched so an empty result is self-qualifying.
    const roots = [];
    const collectRoots = (root) => {
      roots.push(root);
      let hosts;
      try { hosts = root.querySelectorAll("*"); } catch { return; }
      for (const el of hosts) if (el.shadowRoot) collectRoots(el.shadowRoot);
    };
    if (document.body) collectRoots(document.body);

    // Pass 1: group text nodes by nearest block-level container, building each
    // container's flattened raw text plus an offset -> node segment map.
    const containerCache = new Map();
    const containers = new Map(); // blockEl -> { flat, segments: [{start, node}] }
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode });
      let node;
      while ((node = walker.nextNode())) {
        const container = blockContainerOf(node.parentElement, containerCache);
        let rec = containers.get(container);
        if (!rec) { rec = { flat: "", segments: [] }; containers.set(container, rec); }
        rec.segments.push({ start: rec.flat.length, node });
        rec.flat += node.nodeValue;
      }
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
    return {
      count: matches.length,
      matches,
      // So an agent can tell "not on this page" from "not where I looked".
      searchedScope: { topFrame: true, shadowRoots: roots.length - 1, iframes: false },
    };
  }

  // Wait until DOM mutations stop, page is complete, and no CSS/JS animations are running.
  function wait_settle({ timeoutMs = 150 } = {}) {
    const start = Date.now();
    return new Promise((resolve) => {
      let timer = null;
      let observer = null;
      // The observer is already running for every action; counting what it sees is free
      // and turns "the action was dispatched" into "the page reacted" — the difference
      // an agent cannot otherwise tell without spending extra calls.
      let mutationCount = 0;
      const done = () => {
        if (observer) {
          try { observer.disconnect(); } catch {}
          observer = null;
        }
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        const ready = document.readyState === "complete";
        const anims = document.getAnimations ? document.getAnimations().length === 0 : true;
        resolve({
          settled: ready && anims,
          readyState: document.readyState,
          waitedMs: Date.now() - start,
          mutationCount,
        });
      };

      try {
        observer = new MutationObserver((records) => {
          mutationCount += records.length;
          if (timer) clearTimeout(timer);
          timer = setTimeout(done, 50);
        });
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      } catch {}

      setTimeout(done, timeoutMs);
    });
  }

  async function click({ index, ref, selector, text, autoSettle = true, settleMs = 150 } = {}) {
    const el = resolveTarget({ index, ref, selector, text });
    if (textOnlyMatches.has(el)) {
      const nearby = deepQueryAll(INTERACTIVE_SELECTOR)
        .filter(isVisible)
        .slice(0, 3)
        .map((cand) => `@${getOrAssignRef(cand)} (${cand.tagName.toLowerCase()}: ${elementText(cand).slice(0, 40)})`);
      throw createStructuredError(
        `"${text}" was found only as plain text inside <${el.tagName.toLowerCase()}>, which has no click handler — clicking it would do nothing`,
        "ELEMENT_NOT_INTERACTIVE",
        { text, tagName: el.tagName.toLowerCase(), ref: getOrAssignRef(el) },
        nearby.length > 0
          ? `Use get_text on @${getOrAssignRef(el)} to read it, or click a real control such as: ${nearby.join(", ")}`
          : `Use get_text on @${getOrAssignRef(el)} to read it. Run find_text to see the nearest interactive ancestor of this text.`
      );
    }
    const warning = actionability(el);
    const urlBefore = location.href;
    // A Web Component's listener lives on the <button> inside its shadow root, not on
    // the host. Dispatching to the host is accepted silently and does nothing — the
    // Shoelace dialog's own Close button reported success and stayed open. Descend to
    // the real control when there is one; fall back to the host otherwise.
    const eventTarget = shadowInteractiveTarget(el) || el;
    // For a control that carries its own state, "the DOM mutated" is not evidence the
    // intended thing happened: a Facebook audience radio produced 34 and then 320
    // mutations across eight attempts while the selection never committed, and every one
    // of those clicks reported success. Snapshot the control's own state and compare.
    const STATEFUL = ["aria-checked", "aria-selected", "aria-pressed", "aria-expanded"];
    const stateBefore = {};
    let isStateful = false;
    for (const a of STATEFUL) {
      try {
        const v = el.getAttribute(a);
        if (v !== null) { stateBefore[a] = v; isStateful = true; }
      } catch {}
    }

    el.scrollIntoView({ block: "center", inline: "center" });
    // AFTER the scroll, not before. The check hit-tests the element's centre, and
    // scrollIntoView moves it — so measuring first tested coordinates the click would
    // never use, and could report an overlay that scrolling had already resolved (or
    // miss one it had just slid under).
    const coveredInfo = checkElementCovered(el);
    const mutations = startMutationCounter();

    const rect = el.getBoundingClientRect();
    const clientX = Math.max(0, rect.left + rect.width / 2);
    const clientY = Math.max(0, rect.top + rect.height / 2);
    const eventOpts = { bubbles: true, cancelable: true, clientX, clientY, view: window };

    // Physical pointer / mouse sequence
    eventTarget.dispatchEvent(new PointerEvent("pointerover", eventOpts));
    eventTarget.dispatchEvent(new PointerEvent("pointerenter", eventOpts));
    eventTarget.dispatchEvent(new MouseEvent("mouseover", eventOpts));
    eventTarget.dispatchEvent(new MouseEvent("mouseenter", eventOpts));
    eventTarget.dispatchEvent(new PointerEvent("pointerdown", eventOpts));
    eventTarget.dispatchEvent(new MouseEvent("mousedown", eventOpts));
    try { eventTarget.focus(); } catch {}
    eventTarget.dispatchEvent(new PointerEvent("pointerup", eventOpts));
    eventTarget.dispatchEvent(new MouseEvent("mouseup", eventOpts));
    // Exactly ONE activation. A dispatched click event runs the element's activation
    // behavior (link navigation, checkbox toggle, form submit) just as el.click() does,
    // so calling both fired every page handler twice — double submits, double sends.
    // Keep the dispatched event, not el.click(), because only this one carries
    // clientX/clientY, which handlers that position menus or read coordinates rely on.
    eventTarget.dispatchEvent(new MouseEvent("click", eventOpts));

    let waitedMs = 0;
    if (autoSettle && settleMs > 0) {
      const settleRes = await wait_settle({ timeoutMs: settleMs });
      waitedMs = settleRes.waitedMs || 0;
    }
    const mutationCount = mutations.stop();
    const out = {
      clicked: ref != null ? ref : (selector || text || index),
      waitedMs,
      effect: buildEffect({ urlBefore, el, mutationCount, measured: autoSettle && settleMs > 0 }),
    };
    if (eventTarget !== el) {
      out.dispatchedTo = `<${eventTarget.tagName.toLowerCase()}> inside <${el.tagName.toLowerCase()}> shadow root`;
    }
    if (coveredInfo && coveredInfo.covered) {
      out.warning = `element is covered by <${coveredInfo.coveredBy}> (@${coveredInfo.topRef}) — click event dispatched, but overlay may have intercepted it`;
    } else if (warning) {
      out.warning = `element is not visible (${warning}) — the handler was still invoked, but verify the effect`;
    }
    // Did the control's own state move? This is the only check that distinguishes "the
    // page reacted" from "the thing I clicked is now selected".
    if (isStateful) {
      const changed = [];
      const unchanged = [];
      for (const a of Object.keys(stateBefore)) {
        let now = null;
        try { now = el.getAttribute(a); } catch {}
        (now !== stateBefore[a] ? changed : unchanged).push(`${a.replace("aria-", "")}: ${stateBefore[a]}${now !== stateBefore[a] ? ` -> ${now}` : ""}`);
      }
      out.effect.controlState = { changed, unchanged };
      if (changed.length === 0 && out.effect.domMutated) {
        out.warning =
          (out.warning ? out.warning + " — " : "") +
          `the page changed (${out.effect.mutationCount} mutations) but this control's own state did NOT (${unchanged.join(", ")}): the click landed somewhere, but the selection did not take. Re-read the control before assuming it is set.`;
      }
    }

    if (out.effect.measured && !out.effect.domMutated && !out.effect.urlChanged) {
      out.warning =
        (out.warning ? out.warning + " — " : "") +
        "the page did not change at all (0 mutations, same URL): treat this click as NOT confirmed and verify before continuing";
    }
    return out;
  }

  function insertIntoEditable(el, text, { paste = false } = {}) {
    el.focus();
    const inputType = el.tagName === "INPUT" ? (el.type || "").toLowerCase() : "";
    if (inputType === "checkbox" || inputType === "radio") {
      el.checked = /^(true|1|yes|on|checked)$/i.test(String(text).trim());
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    if (el.isContentEditable) {
      // For rich-text editors (ProseMirror, Tiptap, Quill, Lexical, Draft.js):
      // 1. Select all existing content so insertion acts cleanly
      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      } catch {}

      // Exactly ONE insertion path runs.
      //
      // This used to be `execCommand("insertText")` and then, when the caller asked for
      // paste semantics, a ClipboardEvent on top — `if (!inserted || paste)`. Both
      // succeed on a rich-text editor, so a pasted message landed in the box TWICE.
      // Same shape as the double-click defect (F1): two mechanisms that each do the whole
      // job, run one after the other.
      //
      // When paste semantics are asked for, the ClipboardEvent is the correct path (it is
      // what the editor's own paste handler listens for, and it preserves structure), so
      // it goes first and insertText becomes the fallback — not the other way round.
      const contentBefore = el.isContentEditable ? el.textContent : String(el.value ?? "");
      const changed = () => (el.isContentEditable ? el.textContent : String(el.value ?? "")) !== contentBefore;

      let inserted = false;

      // Whether the editor took the insertion, decided SYNCHRONOUSLY.
      //
      // Measuring `changed()` right after the dispatch is not enough: Lexical (Facebook's
      // composer) commits its paste asynchronously, so the content had not moved yet, the
      // fallback fired, and the text landed twice once Lexical's own handler caught up.
      // Gmail commits synchronously and looked fine — which is why a single editor is
      // never enough to test this against.
      //
      // `preventDefault()` on the paste event is the editor saying "I own this", and
      // dispatchEvent returns false when it was called. That is the signal, available
      // immediately, regardless of when the editor actually commits.
      const tryClipboardEvent = () => {
        try {
          const dt = new DataTransfer();
          dt.setData("text/plain", text);
          const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
          const notPrevented = el.dispatchEvent(ev);
          if (!notPrevented) return true;   // the editor handled it
        } catch { return false; }
        return changed();
      };
      // Likewise: execCommand returning true means the browser accepted and performed the
      // edit. Re-checking the DOM on top of that re-introduces the same async race.
      const tryInsertText = () => {
        try { return document.execCommand("insertText", false, text) === true; } catch { return false; }
      };

      if (paste) inserted = tryClipboardEvent() || tryInsertText();
      else inserted = tryInsertText() || tryClipboardEvent();

      // Hard fallback, keyed on whether the insertion ACTUALLY happened rather than on
      // the box looking empty. The old guard was `!el.textContent`: if a path reported
      // success but left the previous content in place, the box was non-empty, the
      // fallback was skipped, and paste returned ok having replaced nothing.
      if (!inserted && text) {
        try { el.textContent = text; } catch {}
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      // Let the caller check rather than trust: an editor that swallows every insertion
      // path is a real outcome, and silence about it is how a "successful" empty send
      // happens.
      return { textNow: String(el.textContent || "").slice(0, 200), inserted: inserted || !!text };
    }

    if ("value" in el) {
      setNativeValue(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    const candidateInputs = deepQueryAll("input:not([type=hidden]), textarea, [contenteditable=true]")
      .filter(isVisible)
      .slice(0, 3)
      .map((cand) => {
        const ref = getOrAssignRef(cand);
        const tag = cand.tagName.toLowerCase();
        const name = cand.name ? `[name="${cand.name}"]` : "";
        const ph = cand.placeholder ? `[placeholder="${cand.placeholder}"]` : "";
        return `@${ref} (${tag}${name}${ph})`;
      });
    const hint = candidateInputs.length > 0
      ? `Target <${el.tagName.toLowerCase()}> is not an editable field. Try editable inputs in viewport: ${candidateInputs.join(", ")}`
      : `Target <${el.tagName.toLowerCase()}> does not accept text input. Inspect snapshot --compact for input elements.`;

    throw createStructuredError(
      `target element is not editable (<${el.tagName.toLowerCase()}>)`,
      "ELEMENT_NOT_EDITABLE",
      { tagName: el.tagName.toLowerCase(), candidateInputs },
      hint
    );
  }

  async function type({ index, ref, selector, text = "", placeholder, submit, waitFor, autoSettle = true, settleMs = 100 } = {}) {
    const el = resolveTarget({ index, ref, selector, placeholder });
    const warning = actionability(el);
    const urlBefore = location.href;
    el.scrollIntoView({ block: "center", inline: "center" });
    const mutations = startMutationCounter();
    insertIntoEditable(el, text, { paste: false });
    if (submit) {
      const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13 };
      // requestSubmit() is a fallback for forms that only submit via their button, NOT
      // an addition to the Enter key. Pages that submit from their own keydown handler
      // would otherwise submit twice — the same double-activation bug as click.
      const form = el.form;
      let submittedByKey = false;
      const noteSubmit = () => { submittedByKey = true; };
      if (form) form.addEventListener("submit", noteSubmit, { capture: true });
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keypress", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
      if (form) {
        form.removeEventListener("submit", noteSubmit, { capture: true });
        if (!submittedByKey) form.requestSubmit?.();
      }
    }
    if (waitFor) {
      await wait_for({ selector: waitFor, timeoutMs: 5000 }).catch(() => {});
    }
    if (autoSettle && settleMs > 0) {
      await wait_settle({ timeoutMs: settleMs });
    }
    const typeMutations = mutations.stop();
    const out = {
      typed: ref != null ? ref : (selector || placeholder || index),
      effect: buildEffect({ urlBefore, el, mutationCount: typeMutations, measured: autoSettle && settleMs > 0 }),
    };
    if ("value" in el) out.effect.valueNow = String(el.value ?? "").slice(0, 200);
    // A contenteditable has no `value`, so callers had nothing to verify against — the
    // symmetric read-back for a rich-text editor.
    else if (el.isContentEditable) out.effect.textNow = String(el.textContent ?? "").slice(0, 200);
    if (warning) out.warning = `element is not visible (${warning}) — the action was still applied, but verify the effect`;
    return out;
  }

  async function paste({ index, ref, selector, text = "", placeholder, submit, waitFor, autoSettle = true, settleMs = 150 } = {}) {
    const el = resolveTarget({ index, ref, selector, placeholder });
    const warning = actionability(el);
    const urlBefore = location.href;
    el.scrollIntoView({ block: "center", inline: "center" });
    const mutations = startMutationCounter();
    insertIntoEditable(el, text, { paste: true });
    if (submit) {
      const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13 };
      // requestSubmit() is a fallback for forms that only submit via their button, NOT
      // an addition to the Enter key. Pages that submit from their own keydown handler
      // would otherwise submit twice — the same double-activation bug as click.
      const form = el.form;
      let submittedByKey = false;
      const noteSubmit = () => { submittedByKey = true; };
      if (form) form.addEventListener("submit", noteSubmit, { capture: true });
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keypress", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
      if (form) {
        form.removeEventListener("submit", noteSubmit, { capture: true });
        if (!submittedByKey) form.requestSubmit?.();
      }
    }
    if (waitFor) {
      await wait_for({ selector: waitFor, timeoutMs: 5000 }).catch(() => {});
    }
    if (autoSettle && settleMs > 0) {
      await wait_settle({ timeoutMs: settleMs });
    }
    const pasteMutations = mutations.stop();
    const out = {
      pasted: ref != null ? ref : (selector || placeholder || index),
      length: text.length,
      effect: buildEffect({ urlBefore, el, mutationCount: pasteMutations, measured: autoSettle && settleMs > 0 }),
    };
    if ("value" in el) out.effect.valueNow = String(el.value ?? "").slice(0, 200);
    // A contenteditable has no `value`, so callers had nothing to verify against — the
    // symmetric read-back for a rich-text editor.
    else if (el.isContentEditable) out.effect.textNow = String(el.textContent ?? "").slice(0, 200);
    if (warning) out.warning = `element is not visible (${warning}) — the action was still applied, but verify the effect`;
    return out;
  }

  function findScrollableContainer() {
    const active = findActiveModal();
    if (active) {
      if (active.scrollHeight > active.clientHeight + 10) return active;
      const innerScroll = active.querySelector('[style*="overflow"], [class*="content" i], [class*="body" i], [class*="scroll" i], [class*="pane" i]');
      if (innerScroll && innerScroll.scrollHeight > innerScroll.clientHeight + 10) return innerScroll;
    }

    const candidates = deepQueryAll('main, [role="main"], [role="region"], [role="grid"], [role="table"], div, section, article');
    let bestEl = null;
    let maxArea = 0;
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const sh = el.scrollHeight;
      const ch = el.clientHeight;
      if (sh <= ch + 15) continue;
      const style = window.getComputedStyle(el);
      const oy = style.overflowY;
      if (oy === "auto" || oy === "scroll" || oy === "overlay") {
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > maxArea) {
          maxArea = area;
          bestEl = el;
        }
      }
    }
    return bestEl;
  }

  function scroll({ direction = "down", amount = 600, ref, selector, index } = {}) {
    const isUp = direction === "up";
    const delta = isUp ? -amount : amount;

    // 1. Target explicitly specified
    if (ref !== undefined || selector !== undefined || index !== undefined) {
      const el = resolveTarget({ ref, selector, index });
      if (el) {
        if (el.tagName === "IFRAME") {
          try {
            el.contentWindow.scrollBy({ top: delta, behavior: "instant" in window ? "instant" : "auto" });
            return { scrolledY: el.contentWindow.scrollY, target: ref || selector || index };
          } catch {}
        }
        // A zero-delta success is indistinguishable from "scrolled but already at the
        // end". An agent that passed a heading expecting scroll-into-view gets told so.
        if (el.scrollHeight <= el.clientHeight + 2) {
          const ancestor = findScrollableContainer();
          throw createStructuredError(
            `<${el.tagName.toLowerCase()}> is not a scrollable container (scrollHeight ${el.scrollHeight} <= clientHeight ${el.clientHeight}) — nothing would move`,
            "SCROLL_TARGET_NOT_SCROLLABLE",
            { tagName: el.tagName.toLowerCase(), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
            ancestor
              ? `To scroll the region containing it, target @${getOrAssignRef(ancestor)} (<${ancestor.tagName.toLowerCase()}>). To bring this element into view instead, use scrollintoview.`
              : `Use scrollintoview to bring this element into view, or omit the target to scroll the page.`
          );
        }
        const prevTop = el.scrollTop;
        el.scrollBy({ top: delta, behavior: "instant" in window ? "instant" : "auto" });
        return {
          scrolledY: el.scrollTop,
          delta: el.scrollTop - prevTop,
          target: ref || selector || index,
          container: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "")
        };
      }
    }

    // 2. Check if root window can scroll
    const rootScrollable = document.scrollingElement && (document.scrollingElement.scrollHeight > window.innerHeight + 10);
    const prevY = window.scrollY;
    if (rootScrollable) {
      window.scrollBy({ top: delta, behavior: "instant" in window ? "instant" : "auto" });
      if (window.scrollY !== prevY) {
        return { scrolledY: window.scrollY, delta: window.scrollY - prevY };
      }
    }

    // 3. Fall back to finding nested scroll container (Azure blades, drawers, iframe body, etc.)
    const container = findScrollableContainer();
    if (container) {
      const prevTop = container.scrollTop;
      container.scrollBy({ top: delta, behavior: "instant" in window ? "instant" : "auto" });
      return {
        scrolledY: container.scrollTop,
        delta: container.scrollTop - prevTop,
        container: container.tagName.toLowerCase() + (container.id ? `#${container.id}` : "")
      };
    }

    window.scrollBy({ top: delta, behavior: "instant" in window ? "instant" : "auto" });
    return { scrolledY: window.scrollY, delta: window.scrollY - prevY };
  }

  async function dismiss_modal({ ref, selector } = {}) {
    const before = findActiveModal();

    // Verify rather than assert. The previous version returned {dismissed:true} for
    // every path, including "dispatched Escape at a page with no Escape handler and a
    // close button we did not recognise" — the modal stayed open and the agent was told
    // it had closed.
    const confirm = async (method, extra = {}) => {
      // Nothing was open, so nothing can be reported as dismissed. Without this the
      // "no modal" case satisfied the "modal is gone" check trivially and claimed
      // success for a no-op.
      if (!before) return null;
      await wait_settle({ timeoutMs: 200 });
      const stillThere = findActiveModal();
      if (!stillThere || stillThere !== before) {
        return { dismissed: true, method, ...extra };
      }
      return null;
    };

    if (ref || selector) {
      const el = resolveTarget({ ref, selector });
      if (el) {
        (shadowInteractiveTarget(el) || el).click();
        const ok = await confirm("target_click", { target: ref || selector });
        if (ok) return ok;
      }
    }

    const active = before;
    const tried = [];
    if (active) {
      const closeSelectors = [
        'button[aria-label*="close" i]',
        'button[aria-label*="dismiss" i]',
        'button[title*="close" i]',
        "[data-dismiss]",
        '[data-action="close"]',
        'button[class*="close" i]',
        'button[class*="dismiss" i]',
      ];
      const candidates = [];
      for (const sel of closeSelectors) {
        for (const el of deepQueryAll(sel, active)) candidates.push(el);
      }
      // Most close buttons are identified by their label, not by a class or aria
      // attribute — a plain <button id="close">Close</button> matched none of the old
      // selectors, which is why the old code always fell through to Escape.
      for (const el of deepQueryAll('button, [role="button"], a[href="#"]', active)) {
        const name = (accessibleName(el) || elementText(el) || "").trim();
        if (/^(close|dismiss|cancel|no,? thanks|×|✕|✖|x)$/i.test(name)) candidates.push(el);
      }
      for (const btn of candidates) {
        if (!isVisible(btn)) continue;
        tried.push(`@${getOrAssignRef(btn)} ("${(accessibleName(btn) || elementText(btn) || "").trim().slice(0, 30)}")`);
        (shadowInteractiveTarget(btn) || btn).click();
        const ok = await confirm("button_click", { buttonRef: getOrAssignRef(btn) });
        if (ok) return ok;
      }
    }

    // A native <dialog> opened with showModal() closes on Escape only for a TRUSTED key
    // event — the browser handles it, not the page. A dispatched KeyboardEvent never
    // closes one, so the most standard modal in HTML fell through to the error below on
    // every page that used one. close() is the element's own documented way out.
    if (active instanceof HTMLDialogElement && active.open) {
      active.close();
      const ok = await confirm("dialog_close");
      if (ok) return ok;
    }

    const target = document.activeElement || active || document.body;
    const evOpts = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
    for (const node of [target, window]) {
      node.dispatchEvent(new KeyboardEvent("keydown", evOpts));
      node.dispatchEvent(new KeyboardEvent("keyup", evOpts));
    }
    const ok = await confirm("escape_key");
    if (ok) return ok;

    if (!before) {
      return {
        dismissed: false,
        reason:
          "no active modal was detected on this page — nothing to dismiss. Escape was dispatched anyway in case an " +
          "overlay is open that modal detection does not recognise; run snapshot to check.",
      };
    }
    throw createStructuredError(
      "the modal is still open after trying its close buttons and the Escape key",
      "MODAL_NOT_DISMISSED",
      { closeButtonsTried: tried },
      tried.length > 0
        ? `Click one of these directly and check the result: ${tried.join(", ")}. Some dialogs only close via an explicit action inside them.`
        : "No close button was recognised inside the modal. Run snapshot to list its controls and click the right one by ref."
    );
  }

  async function hover({ index, ref, selector, text, autoSettle = true, settleMs = 50 } = {}) {
    const el = resolveTarget({ index, ref, selector, text });
    const warning = actionability(el);
    el.scrollIntoView({ block: "center", inline: "center" });
    const opts = { bubbles: true, cancelable: true };
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mouseenter", opts));
    el.dispatchEvent(new MouseEvent("mousemove", opts));
    if (autoSettle && settleMs > 0) {
      await wait_settle({ timeoutMs: settleMs });
    }
    const out = { hovered: ref != null ? ref : (selector || text || index) };
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
    // requestSubmit() is a FALLBACK for forms that only submit via their button, not an
    // addition to the Enter key. `type(submit: true)` already guards this; press_key did
    // not, so pressing Enter on a form whose own keydown handler submits fired the submit
    // twice — a double order, a double send. Same class as the double click (F1), and it
    // survived because nothing exercised Enter-on-a-form through press_key.
    const form = key === "Enter" ? target.form : null;
    let submittedByKey = false;
    const noteSubmit = () => { submittedByKey = true; };
    if (form) form.addEventListener("submit", noteSubmit, { capture: true });

    const keydownNotPrevented = target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keypress", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));

    if (form) {
      form.removeEventListener("submit", noteSubmit, { capture: true });
      // Only if the page did not already handle it, and did not deliberately swallow the
      // key (preventDefault on keydown is a page saying "I own Enter here").
      if (!submittedByKey && keydownNotPrevented) form.requestSubmit?.();
    }
    return {
      pressed: key,
      modifiers: modifiers || [],
      via: "dom",
      ...(form ? { submittedByPage: submittedByKey, keydownPrevented: !keydownNotPrevented } : {}),
    };
  }

  // Text matching is case- and whitespace-insensitive by default.
  //
  // It used to be a raw `includes`, so waiting for "weekly downloads" on a page showing
  // "Weekly Downloads" burned the full timeout and returned nothing an agent could act
  // on. Two separate probe runs lost ~15s that way, then carried on unsure whether the
  // page had loaded. Nobody waiting on page text means "in exactly this casing"; pass
  // caseSensitive: true if they do.
  const normalizeForMatch = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();

  function wait_for({ selector, text, gone = false, timeoutMs = 8000, caseSensitive = false }) {
    if (selector === undefined && text === undefined) {
      throw new Error("wait_for requires selector or text");
    }
    const start = Date.now();
    const needle = caseSensitive ? String(text ?? "") : normalizeForMatch(text);
    const bodyText = () => (document.body ? document.body.innerText : "");
    return new Promise((resolve, reject) => {
      const check = () => {
        let present;
        if (selector !== undefined) {
          present = !!deepQuery(selector);
        } else {
          present = (caseSensitive ? bodyText() : normalizeForMatch(bodyText())).includes(needle);
        }
        const satisfied = gone ? !present : present;
        if (satisfied) {
          resolve({ found: true, waitedMs: Date.now() - start });
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          // Say what the page actually looks like. A bare timeout leaves the agent
          // unable to tell "wrong string" from "page never loaded", and both of its
          // recovery moves (retry, or give up and read anyway) are wrong for one of them.
          const diag = { readyState: document.readyState, waitedMs: Date.now() - start };
          if (selector !== undefined) {
            diag.selectorMatches = 0;
            try { diag.selectorMatches = deepQueryAll(selector).length; } catch { diag.selectorInvalid = true; }
          } else if (!gone) {
            const body = bodyText();
            if (caseSensitive && normalizeForMatch(body).includes(normalizeForMatch(text))) {
              const at = normalizeForMatch(body).indexOf(normalizeForMatch(text));
              diag.presentInAnotherCase = body.replace(/\s+/g, " ").substr(at, String(text).length + 10);
            }
            // Longest leading fragment of the query that IS on the page, so the caller
            // can see where their expected string diverges from the real one.
            const hay = normalizeForMatch(body);
            let keep = 0;
            for (let n = needle.length; n >= 4; n--) {
              if (hay.includes(needle.slice(0, n))) { keep = n; break; }
            }
            if (keep > 0 && keep < needle.length) {
              const at = hay.indexOf(needle.slice(0, keep));
              diag.closestOnPage = body.replace(/\s+/g, " ").substr(Math.max(0, at), keep + 24);
            }
            diag.bodyChars = body.length;
          }
          const err = new Error(
            `wait_for timed out after ${timeoutMs}ms (readyState: ${document.readyState})` +
            (diag.presentInAnotherCase ? ` — the text IS present as "${diag.presentInAnotherCase}"` : "") +
            (diag.closestOnPage ? ` — closest text on page: "${diag.closestOnPage}"` : "") +
            (diag.bodyChars === 0 ? " — the page has no text yet, it is probably still loading" : "")
          );
          err.code = "WAIT_TIMEOUT";
          err.diagnostics = diag;
          err.recoveryHint = diag.bodyChars === 0
            ? "Use wait_settle, or snapshot directly — snapshot reports viewport state and does not need a guessed string."
            : "Prefer browser_snapshot or browser_find over guessing page text; both report what is actually there.";
          reject(err);
          return;
        }
        setTimeout(check, 100);
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
  function describe_element({ index, ref, selector, text, placeholder } = {}) {
    const el = resolveTarget({ index, ref, selector, text, placeholder });
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

  async function get_page_content({ maxChars = 8000 } = {}) {
    // If page is still hydrating or body is minimal while document is loading, wait briefly for settle
    const initialText = ((document.body && document.body.innerText) || "").trim();
    if (initialText.length < 80) {
      await wait_settle({ timeoutMs: 600 });
    }
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
    const res = { title: document.title, url: location.href, text, ...(fromDialog ? { source: "dialog" } : {}) };
    if (!fromDialog) {
      res.hint = "Prose text only. For interactive UI elements, notifications, unread badges, or app headers, proceed autonomously with browser_snapshot or browser_find.";
    }
    return res;
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
    insertIntoEditable(el, value, { paste: false });
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

  function get_property({ property, ref, index, selector, text, placeholder, attr } = {}) {
    if (property === "title") return { property: "title", value: document.title };
    if (property === "url") return { property: "url", value: location.href };

    // Counting is a question about the SET, so it must answer before anything tries to
    // resolve a single element. It used to fall through to resolveTarget first, so
    // "how many of these are there" returned ELEMENT_NOT_FOUND when the answer was zero —
    // an error where a valid answer existed, which an agent reads as a broken selector
    // and works around by writing eval_js.
    if (property === "count") {
      if (selector === undefined) return { property: "count", value: 1 };
      // deepQueryAll swallows selector errors and returns [], so an invalid selector
      // would report "0 matches" — indistinguishable from a valid selector that matched
      // nothing, and the agent would go on believing the page lacks the element.
      // Validate the syntax explicitly first.
      let invalid = false;
      try { document.createDocumentFragment().querySelector(selector); } catch { invalid = true; }
      let value = 0;
      if (!invalid) { try { value = deepQueryAll(selector).length; } catch { invalid = true; } }
      if (invalid) {
        const err = new Error(`'${selector}' is not a valid CSS selector`);
        err.code = "INVALID_SELECTOR";
        err.recoveryHint = "Roles from read_page (link, button, textbox) are ARIA roles, not CSS tags — use 'a', 'button', '[role=textbox]', or browser_find with the label instead.";
        throw err;
      }
      const out = { property: "count", value, selector };
      if (value === 0) {
        out.note = "0 matches. This is an answer, not a failure — the selector is valid and nothing on the page matches it. If you meant an ARIA role, CSS needs [role=...]; browser_find searches by label instead.";
      }
      return out;
    }

    const hasTarget = ref !== undefined || index !== undefined || selector !== undefined || text !== undefined || placeholder !== undefined;
    const el = hasTarget ? resolveTarget({ ref, index, selector, text, placeholder }) : document.documentElement;

    // A selector that matches several elements silently resolved to the first one:
    // selector="aside" returned the wrong <aside> of five, with nothing to suggest a
    // choice had been made.
    let matchCount;
    if (selector !== undefined) {
      try { matchCount = deepQueryAll(selector).length; } catch { matchCount = undefined; }
    }
    const withMatchCount = (out) => {
      if (matchCount !== undefined && matchCount > 1) {
        out.matchCount = matchCount;
        out.note = `selector matched ${matchCount} elements; this is the first — pass a more specific selector or a ref to choose another`;
      }
      return out;
    };

    switch (property) {
      case "text":
        return withMatchCount({ property: "text", value: (el.innerText || el.textContent || "").trim() });
      case "value":
        return { property: "value", value: el.value !== undefined ? el.value : (el.innerText || "") };
      case "html":
        return withMatchCount({ property: "html", value: el.outerHTML || "" });
      case "attr":
      case "attribute": {
        // `present` disambiguates the three cases an absent/empty attribute collapsed
        // into: missing, present-but-empty, and present with a value. Boolean
        // attributes like `open` are exactly this case, and the smart formatter used to
        // render the absent one as no output at all.
        const has = !!(attr && el.hasAttribute && el.hasAttribute(attr));
        const raw = has ? el.getAttribute(attr) : null;
        const out = { property: "attr", name: attr, present: has, value: raw };
        // A URL attribute is usually read to answer "where does this go", and the raw
        // value answers that only if it happens to be absolute. Reading href on a link
        // returned a bare "front", which the caller could not tell from a truncated or
        // wrong answer — so it re-derived the URL in eval_js to check. Resolving it here
        // is one property access and removes the doubt.
        if (has && raw && /^(href|src|action|poster|cite|formaction|data|srcset)$/i.test(attr)) {
          try {
            const abs = new URL(raw, document.baseURI).href;
            if (abs !== raw) out.resolved = abs;
          } catch {}
        }
        return withMatchCount(out);
      }
      case "box": {
        const r = el.getBoundingClientRect();
        return { property: "box", x: r.x, y: r.y, width: r.width, height: r.height };
      }
      case "count": // handled above, before target resolution
        return { property: "count", value: selector ? deepQueryAll(selector).length : 1 };
      default:
        throw new Error(`unknown property "${property}"`);
    }
  }

  function clear_input({ index, ref, selector, placeholder, autoSettle = true, settleMs = 100 } = {}) {
    const el = resolveTarget({ index, ref, selector, placeholder });
    const warning = actionability(el);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    if ("value" in el) {
      setNativeValue(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      throw new Error("target element is not editable");
    }
    const out = { cleared: ref != null ? ref : (selector || placeholder || index) };
    if (warning) out.warning = `element is not visible (${warning})`;
    return out;
  }

  function set_checked({ index, ref, selector, text, checked = true, autoSettle = true, settleMs = 100 } = {}) {
    const el = resolveTarget({ index, ref, selector, text });
    const warning = actionability(el);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.checked = !!checked;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    const out = { [checked ? "checked" : "unchecked"]: ref != null ? ref : (selector || text || index) };
    if (warning) out.warning = `element is not visible (${warning})`;
    return out;
  }

  function dblclick_element({ index, ref, selector, text } = {}) {
    const el = resolveTarget({ index, ref, selector, text });
    const warning = actionability(el);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    const out = { dblclicked: ref != null ? ref : (selector || text || index) };
    if (warning) out.warning = `element is not visible (${warning})`;
    return out;
  }

  function focus_element({ index, ref, selector, text, placeholder } = {}) {
    const el = resolveTarget({ index, ref, selector, text, placeholder });
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    return { focused: ref != null ? ref : (selector || placeholder || text || index) };
  }

  function scroll_into_view({ index, ref, selector, text, placeholder } = {}) {
    const el = resolveTarget({ index, ref, selector, text, placeholder });
    el.scrollIntoView({ block: "center", inline: "center" });
    return { scrolledIntoView: ref != null ? ref : (selector || placeholder || text || index) };
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
    get_property,
    paste,
    fill: type,
    clear: clear_input,
    check: (params) => set_checked({ ...params, checked: true }),
    uncheck: (params) => set_checked({ ...params, checked: false }),
    dblclick: dblclick_element,
    focus: focus_element,
    scrollintoview: scroll_into_view,
    dismiss: dismiss_modal,
    close_modal: dismiss_modal,
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
      .catch((err) => {
        const errorMsg = String(err && err.message ? err.message : err);
        const res = { ok: false, error: errorMsg };
        if (err && err.code) res.code = err.code;
        if (err && err.diagnostics) res.diagnostics = err.diagnostics;
        if (err && err.recoveryHint) res.recoveryHint = err.recoveryHint;
        sendResponse(res);
      });
    return true; // keep the message channel open for the async sendResponse
  });
})();
