(() => {
  if (window.__browserctlLoaded) return;
  window.__browserctlLoaded = true;

  let indexedElements = [];
  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "summary",
    "[contenteditable=true]",
    "[contenteditable='']",
    "[onclick]",
    "[role=button]",
    "[role=link]",
    "[role=menuitem]",
    "[role=menuitemradio]",
    "[role=menuitemcheckbox]",
    "[role=tab]",
    "[role=treeitem]",
    "[role=option]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=switch]",
    "[role=combobox]",
    "[role=searchbox]",
    "[role=textbox]",
    "[role=slider]",
    "[role=spinbutton]",
  ].join(",");

  const STATE_ATTRS = [
    "aria-selected",
    "aria-checked",
    "aria-expanded",
    "aria-current",
    "aria-pressed",
    "aria-disabled",
  ];

  function createStructuredError(message, code, diagnostics = {}, recoveryHint = null) {
    const err = new Error(message);
    err.code = code;
    err.diagnostics = diagnostics;
    err.recoveryHint = recoveryHint;
    return err;
  }

  function visibilityReason(el) {
    const style = getComputedStyle(el);
    if (style.display === "none") return "display:none";
    if (style.visibility === "hidden") return "visibility:hidden";
    if (el.disabled) return "disabled";
    if (style.opacity === "0") return "opacity:0";
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return "zero-size rect";
    return null;
  }

  function isVisible(el) {
    return visibilityReason(el) === null;
  }

  function isOperableDespiteHidden(el) {
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") return false;
    const reason = visibilityReason(el);
    if (reason !== "opacity:0" && reason !== "zero-size rect") return false;
    let label = null;
    try {
      if (el.id) label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (!label && el.closest) label = el.closest("label");
    } catch {
      return false;
    }
    if (!label) return false;
    try {
      const r = label.getBoundingClientRect();
      const st = getComputedStyle(label);
      return (
        r.width > 1 &&
        r.height > 1 &&
        st.display !== "none" &&
        st.visibility !== "hidden" &&
        st.opacity !== "0"
      );
    } catch {
      return false;
    }
  }

  function isRevealable(el) {
    if (visibilityReason(el) !== "opacity:0") return false;
    let r;
    try {
      r = el.getBoundingClientRect();
    } catch {
      return false;
    }
    if (r.width < 8 || r.height < 8) return false;
    if (r.right <= 0 || r.left >= window.innerWidth) return false;
    try {
      return !!fullElementText(el);
    } catch {
      return false;
    }
  }

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

  const HREF_CAP = 100;
  const OPAQUE_VALUE_CHARS = 24;
  const KEPT_PARAMS = 2;

  const CONVENTIONAL_TRACKING =
    /^(utm_|_?ga(_|$)|_hs|mc_[ce]id$|vero_|s_kwcid$)|clid$|^ref(errer)?$/i;

  function shortHref(href) {
    if (!href) return href;
    let s = String(href);
    let hash = "";
    const hi = s.indexOf("#");
    if (hi >= 0) {
      hash = s.slice(hi);
      s = s.slice(0, hi);
    }
    let query = "";
    const qi = s.indexOf("?");
    if (qi >= 0) {
      query = s.slice(qi + 1);
      s = s.slice(0, qi);
    }

    let dropped = 0;
    if (query) {
      const kept = [];
      for (const part of query.split("&")) {
        if (!part) continue;
        const eq = part.indexOf("=");
        const key = (eq < 0 ? part : part.slice(0, eq)).replace(/\[\d+\]$/, "");
        const value = eq < 0 ? "" : part.slice(eq + 1);
        const opaque = value.length > OPAQUE_VALUE_CHARS;
        if (opaque || CONVENTIONAL_TRACKING.test(key)) {
          dropped++;
          continue;
        }
        if (kept.length < KEPT_PARAMS) kept.push(part);
        else dropped++;
      }
      if (kept.length) s += "?" + kept.join("&");
    }
    if (hash && hash.length <= 24) s += hash;
    if (s.length > HREF_CAP) s = s.slice(0, HREF_CAP) + "\u2026";
    return dropped > 0 ? `${s} [+${dropped} params]` : s;
  }

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

  function findOpenDialogs() {
    const out = [];
    let candidates;
    try {
      candidates = deepQueryAll(
        'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [popover]'
      );
    } catch {
      return out;
    }
    for (const d of candidates) {
      const panel = modalPanelOf(d);
      if (!panel) continue;
      const rect = panel.getBoundingClientRect();
      if (rect.width <= 80 || rect.height <= 40) continue;
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
      if (rect.right <= 0 || rect.left >= window.innerWidth) continue;
      let label = "";
      try {
        label = fromPage(
          d.getAttribute("aria-label") ||
            (d.querySelector("h1, h2, h3") || {}).innerText ||
            d.tagName.toLowerCase()
        )
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 60);
      } catch {
        label = d.tagName.toLowerCase();
      }
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

  function describeElements(els, limit) {
    const groups = new Map();
    for (const el of els) {
      let info;
      try {
        info = elementTextInfo(el);
      } catch {
        continue;
      }
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

  function summarizeStructure(nodes) {
    const byLandmark = new Map();
    const byRegion = new Map();
    for (const el of nodes) {
      const lm = getLandmark(el) || "body";
      byLandmark.set(lm, (byLandmark.get(lm) || 0) + 1);
      const node = getLandmarkNode(el) || null;
      const cur = byRegion.get(node);
      if (cur) cur.n++;
      else byRegion.set(node, { lm, n: 1 });
    }

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
          const g = groups.get(container) || {
            rows: same,
            tag: row.tagName.toLowerCase(),
            members: new Set(),
          };
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
    const typeTotals = new Map();
    for (const [, info] of byRegion) typeTotals.set(info.lm, (typeTotals.get(info.lm) || 0) + 1);
    for (const [node, info] of [...byRegion.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 4)) {
      const name = typeTotals.get(info.lm) > 1 ? regionName(node) : "";
      const label = name ? `${info.lm} "${name}"` : info.lm;
      parts.push(node ? `${label} ${info.n} (@${getOrAssignRef(node)})` : `${label} ${info.n}`);
    }
    const out = { regions: parts };
    if (best && best.g.members.size >= 4) {
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
    const forms = nodes.filter((e) =>
      ["input", "textarea", "select"].includes(e.tagName.toLowerCase())
    ).length;
    if (forms) out.inputs = forms;
    return out;
  }

  // prettier-ignore
  const LOAD_MORE_RE = /^(see|show|view|load|browse)\s+(previous|more|all|older|newer|earlier|the rest)\b|^(load more|show more|view more|more results|older posts|newer posts)\b/i;

  function hiddenContentHints(els) {
    const more = [];
    const tabs = [];
    const seen = new Set();
    const add = (el, t, why) => {
      if (!t) return;
      if (seen.has(t)) return;
      seen.add(t);
      more.push({ text: t.slice(0, 48), ref: getOrAssignRef(el), why });
    };

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
      try {
        info = elementTextInfo(el);
      } catch {
        continue;
      }
      const t = info.text;
      let expanded = null,
        role = null,
        selected = null;
      try {
        expanded = el.getAttribute("aria-expanded");
        role = el.getAttribute("role");
        selected = el.getAttribute("aria-selected");
      } catch {}

      let hasPopup = null;
      try {
        hasPopup = el.getAttribute("aria-haspopup");
      } catch {}
      const opensMenu = !!hasPopup || role === "menuitem" || role === "combobox";

      if (t && LOAD_MORE_RE.test(t)) add(el, t, "load-more label");
      else if (expanded === "false" && !opensMenu && t)
        add(el, t, "collapsed, aria-expanded=false");
      else if (
        (runCount.get(sigOf(el)) || 0) >= 5 &&
        t &&
        t.length <= 24 &&
        /^(more|older|newer|previous|next|\u2026|\.\.\.)$|^(see|show|view|load|browse)\s+\S/i.test(
          t
        )
      ) {
        add(el, t, "control at the end of a repeated run");
      }

      if ((role === "tab" || selected === "true" || selected === "false") && t && t.length <= 28) {
        tabs.push({ text: t, ref: getOrAssignRef(el), selected: selected === "true" });
      }
    }
    return { more: more.slice(0, 4), tabs: tabs.slice(0, 6) };
  }

  function overflowingRegions(root) {
    const out = [];
    let all;
    try {
      all = root.querySelectorAll("*");
    } catch {
      return out;
    }
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
    const dialogs = deepQueryAll(
      'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'
    );
    if (dialogs.length === 0) return null;

    const cx = Math.floor(window.innerWidth / 2);
    const cy = Math.floor(window.innerHeight / 2);
    const atCenter = document.elementFromPoint(cx, cy);

    for (const d of dialogs) {
      try {
        if (d.matches(":modal") && isVisible(d)) return d;
      } catch {}

      const panel = modalPanelOf(d);
      if (!panel) continue;
      const rect = panel.getBoundingClientRect();
      if (rect.width <= 80 || rect.height <= 40) continue;
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;

      if (atCenter && composedContains(d, atCenter)) return d;
      const style = window.getComputedStyle(panel);
      if (style.position === "fixed" || style.position === "absolute") {
        const coverage = (rect.width * rect.height) / (window.innerWidth * window.innerHeight);
        if (coverage > 0.25) return d;
      }
    }
    return null;
  }

  function modalPanelOf(d) {
    if (!isVisible(d)) {
      if (!d.shadowRoot) return null;
    }
    const rect = d.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && isVisible(d)) return d;
    if (!d.shadowRoot) return null;
    let best = null;
    let bestArea = 0;
    let children;
    try {
      children = d.shadowRoot.querySelectorAll("*");
    } catch {
      return null;
    }
    for (const el of children) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return best;
  }

  function getLandmark(el) {
    let curr = el;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      if (
        curr.matches &&
        curr.matches('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')
      ) {
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

  // A region's name is what it declares: aria-label, then aria-labelledby, then nothing. Not
  // accessibleName(), whose innerText rung would name a region after its own contents, and not
  // the first heading inside it, for the same reason. An unnamed region prints without a name.
  function regionName(node) {
    if (!node || !node.getAttribute) return "";
    const clean = (s) => (s ? String(s).trim().replace(/\s+/g, " ").slice(0, 40) : "");
    const direct = clean(node.getAttribute("aria-label"));
    if (direct) return direct;
    const by = node.getAttribute("aria-labelledby");
    if (by) {
      const lbl = document.getElementById(by.split(/\s+/)[0]);
      const t = lbl && clean(lbl.innerText);
      if (t) return t;
    }
    return "";
  }

  function getLandmarkNode(el) {
    let curr = el;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      if (
        curr.matches &&
        curr.matches('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')
      )
        return curr;
      const role = curr.getAttribute && curr.getAttribute("role");
      const t = curr.tagName;
      if (
        role === "banner" ||
        t === "HEADER" ||
        role === "navigation" ||
        t === "NAV" ||
        role === "main" ||
        t === "MAIN" ||
        role === "contentinfo" ||
        t === "FOOTER" ||
        role === "complementary" ||
        t === "ASIDE"
      )
        return curr;
      curr = curr.parentElement || (curr.getRootNode && curr.getRootNode().host);
    }
    return document.body || null;
  }

  function composedContains(ancestor, node) {
    if (!ancestor || !node) return false;
    let cur = node;
    for (let depth = 0; cur && depth < 200; depth++) {
      if (cur === ancestor) return true;
      cur = cur.parentNode || cur.host || null;
    }
    return false;
  }

  const GEOMETRY_PROPS =
    /^(transform|translate|rotate|scale|left|top|right|bottom|inset|width|height|margin|padding|border.*width|font-size|gap|flex-basis)/;

  function runningMotion(el) {
    let list = [];
    try {
      list = document.getAnimations ? document.getAnimations() : [];
    } catch {}
    let worst = null;
    for (const a of list) {
      if (a.playState !== "running") continue;
      const target = a.effect && a.effect.target;
      if (!target) continue;
      if (!(target === el || composedContains(target, el) || composedContains(el, target)))
        continue;
      let movesBox = false;
      try {
        for (const kf of a.effect.getKeyframes()) {
          for (const prop of Object.keys(kf)) {
            if (GEOMETRY_PROPS.test(prop.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()))) {
              movesBox = true;
              break;
            }
          }
          if (movesBox) break;
        }
      } catch {
        movesBox = true;
      }
      if (!movesBox) continue;
      let remaining = Infinity;
      try {
        const dur = a.effect.getComputedTiming().activeDuration;
        const now = typeof a.currentTime === "number" ? a.currentTime : 0;
        if (Number.isFinite(dur)) remaining = Math.max(0, dur - now);
      } catch {}
      if (!worst || remaining > worst.remaining) worst = { remaining };
    }
    return worst;
  }

  async function waitForStableRect(el, { maxMs = 300 } = {}) {
    if (document.visibilityState !== "visible") {
      const motion = runningMotion(el);
      if (!motion) return { moved: false };
      if (motion.remaining > maxMs)
        return { moved: true, settled: false, waitedMs: 0, via: "animation" };
      const start = Date.now();
      await new Promise((r) => setTimeout(r, Math.ceil(motion.remaining) + 16));
      return {
        moved: true,
        settled: !runningMotion(el),
        waitedMs: Date.now() - start,
        via: "animation",
      };
    }
    const box = () => {
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    };
    const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 0.05);
    const frame = () =>
      new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        requestAnimationFrame(finish);
        setTimeout(finish, 50);
      });
    const start = Date.now();
    let prev = box();
    let frames = 0;
    let settled = false;
    while (Date.now() - start < maxMs) {
      await frame();
      frames++;
      const now = box();
      if (same(prev, now)) {
        settled = true;
        break;
      }
      prev = now;
    }
    const waitedMs = Date.now() - start;
    if (settled && frames <= 1) return { moved: false };
    return { moved: true, settled, waitedMs, via: "rect" };
  }

  function checkElementCovered(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
    const topEl = document.elementFromPoint(x, y);
    if (!topEl) return null;
    if (topEl === el || composedContains(el, topEl) || composedContains(topEl, el)) return null;
    const topTag = topEl.tagName.toLowerCase();
    const topCls =
      topEl.className && typeof topEl.className === "string"
        ? "." + topEl.className.trim().split(/\s+/)[0]
        : "";
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

  function fromPage(s) {
    return s;
  }

  function elementTextInfo(el) {
    const full = fullElementText(el);
    const text = full.slice(0, TEXT_CAP);
    return { text: fromPage(text), truncatedBy: Math.max(0, full.length - text.length) };
  }

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
    try {
      attr = (el.getAttribute("aria-label") || "").trim();
    } catch {}
    if (attr) return attr;

    try {
      const ref = el.getAttribute("aria-labelledby");
      if (ref) {
        const t = ref
          .split(/\s+/)
          .map((id) => {
            try {
              return document.getElementById(id);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .map((n) => (n.innerText || n.textContent || "").trim())
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (t) return t;
      }
    } catch {}

    try {
      const parts = [];
      const imgs = el.querySelectorAll
        ? el.querySelectorAll("img[alt], svg[aria-label], [role=img][aria-label]")
        : [];
      for (const n of imgs) {
        const t = (n.getAttribute("alt") || n.getAttribute("aria-label") || "").trim();
        if (t) parts.push(t);
        if (parts.length >= 2) break;
      }
      const joined = parts.join(" ").replace(/\s+/g, " ").trim();
      if (joined) return joined;
    } catch {}

    try {
      attr = (
        el.getAttribute("title") ||
        el.getAttribute("alt") ||
        el.getAttribute("placeholder") ||
        ""
      ).trim();
    } catch {}
    if (attr) return attr;

    try {
      const formLabel = controlLabelOf(el);
      if (formLabel) return formLabel;
    } catch {}

    try {
      const tag = el.tagName;
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "INPUT" && ["button", "submit", "reset"].includes(type)) {
        const v = (el.getAttribute("value") || "").trim();
        if (v) return v;
      }
    } catch {}
    try {
      return slotLabelOf(el) || "";
    } catch {
      return "";
    }
  }

  function controlLabelOf(el) {
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA" && !el.hasAttribute("role"))
      return "";
    const clean = (t) =>
      String(t || "")
        .trim()
        .replace(/\s+/g, " ");

    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const parts = labelledby
        .split(/\s+/)
        .map((id) => {
          try {
            return document.getElementById(id);
          } catch {
            return null;
          }
        })
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
    let node = el.parentElement;
    for (let up = 0; node && up < 5; node = node.parentElement, up++) {
      let controls;
      try {
        controls = node.querySelectorAll(INTERACTIVE_SELECTOR).length;
      } catch {
        break;
      }
      if (controls > 1) break;
      const t = clean(node.innerText || "");
      if (!t) continue;
      if (t.length > 60) break;
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
    const slotted = slotLabelOf(el);
    return slotted ? slotted.slice(0, 200) : "";
  }

  function slotLabelOf(el) {
    let slots;
    try {
      slots = el.querySelectorAll ? el.querySelectorAll("slot") : [];
    } catch {
      return "";
    }
    for (const slot of slots) {
      if (!slot.assignedNodes) continue;
      let nodes;
      try {
        nodes = slot.assignedNodes({ flatten: true });
      } catch {
        continue;
      }
      const t = nodes
        .map((n) => (n.textContent || "").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (t) return t;
    }
    const root = el.getRootNode && el.getRootNode();
    if (root && root.host) {
      const hostText = (root.host.innerText || root.host.textContent || "")
        .trim()
        .replace(/\s+/g, " ");
      if (hostText) return hostText;
    }
    return "";
  }

  function deepQueryAll(selector, root = document) {
    const out = [];
    const visit = (node) => {
      try {
        for (const el of node.querySelectorAll(selector)) out.push(el);
      } catch {
        return;
      }
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

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const ownSetter =
      Object.getOwnPropertyDescriptor(el, "value") &&
      Object.getOwnPropertyDescriptor(el, "value").set;
    const protoSetter =
      Object.getOwnPropertyDescriptor(proto, "value") &&
      Object.getOwnPropertyDescriptor(proto, "value").set;
    if (protoSetter && ownSetter !== protoSetter) protoSetter.call(el, value);
    else if (protoSetter) protoSetter.call(el, value);
    else el.value = value;
  }

  function snapshot(params = {}) {
    const maxText = params.maxText ?? 4000;
    const compact = !!params.compact;
    const scope = params.scope || "viewport";
    const limit =
      Number.isFinite(params.limit) && params.limit > 0 ? Math.floor(params.limit) : 200;
    const offset =
      Number.isFinite(params.cursor) && params.cursor > 0 ? Math.floor(params.cursor) : 0;

    const allInteractives = deepQueryAll(INTERACTIVE_SELECTOR).filter(isCensusVisible);
    let nodes = scope === "viewport" ? allInteractives.filter(isInViewport) : allInteractives;

    if (scope === "viewport" && nodes.length === 0 && allInteractives.length > 0) {
      nodes = allInteractives.slice(0, 40);
    }

    try {
      const box = new Map();
      const landmarkFirstRow = new Map();
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        const row = Math.round((r.top + window.scrollY) / 24);
        const lm = getLandmark(el) || "";
        box.set(el, { row, left: Math.round(r.left), lm });
        if (!landmarkFirstRow.has(lm) || row < landmarkFirstRow.get(lm))
          landmarkFirstRow.set(lm, row);
      }
      nodes = nodes.slice().sort((a, b) => {
        const A = box.get(a),
          B = box.get(b);
        if (A.lm !== B.lm) return landmarkFirstRow.get(A.lm) - landmarkFirstRow.get(B.lm);
        return A.row - B.row || A.left - B.left;
      });
    } catch {}

    indexedElements = nodes;
    for (const el of deepQueryAll("[data-bctl-ref]")) el.removeAttribute("data-bctl-ref");
    nodes.forEach((el, index) => el.setAttribute("data-bctl-ref", String(index)));

    const activeModal = findActiveModal();
    const openDialogs = findOpenDialogs();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    const scrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight || 1;
    const scrollPercent = Math.min(
      100,
      Math.round((scrollY / Math.max(1, scrollHeight - vh)) * 100)
    );

    const pagedNodes = nodes.slice(offset, offset + limit);
    const regionsByType = new Map();
    for (const el of pagedNodes) {
      const lm = getLandmark(el);
      const node = getLandmarkNode(el) || null;
      if (!regionsByType.has(lm)) regionsByType.set(lm, new Set());
      regionsByType.get(lm).add(node);
    }
    const multiRegionTypes = new Set(
      [...regionsByType.entries()].filter(([, set]) => set.size > 1).map(([lm]) => lm)
    );
    const elements = pagedNodes.map((el, i) => {
      const index = offset + i;
      const ref = getOrAssignRef(el);
      const tag = el.tagName.toLowerCase();
      const info = elementTextInfo(el);
      const text = info.text;
      const landmark = getLandmark(el);
      const regionNode = getLandmarkNode(el);
      const region = multiRegionTypes.has(landmark) ? regionName(regionNode) : "";
      const inVp = isInViewport(el);
      const item = { index, ref, tag, text, landmark, inViewport: inVp };
      if (region) item.region = region;
      if (info.truncatedBy > 0) item.textTruncatedBy = info.truncatedBy;
      try {
        if (!isVisible(el)) {
          if (isOperableDespiteHidden(el)) item.viaLabel = true;
          else if (isRevealable(el)) item.revealOn = "hover/focus";
        }
      } catch {}
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
      window: { offset, shown: elements.length, inScope: nodes.length },
      ...(offset + elements.length < nodes.length ? { next: offset + elements.length } : {}),
      pageState: {
        isBusy: false,
        hasActiveModal: !!activeModal,
        activeModalTag: activeModal ? activeModal.tagName.toLowerCase() : null,
        openDialogs: openDialogs.map((d) => ({
          label: d.label,
          tag: d.tag,
          width: d.width,
          height: d.height,
          ref: getOrAssignRef(d.node),
        })),
      },
      elements,
      text: fromPage(
        (document.body ? document.body.innerText : "").trim().replace(/\s+/g, " ")
      ).slice(0, maxText),
    };

    if (compact) {
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
          try {
            cand = node.querySelector("a, h1, h2, h3, h4, [role='heading']");
          } catch {
            cand = null;
          }
          if (!cand) continue;
          let t = "";
          try {
            t = (cand.innerText || cand.getAttribute("aria-label") || "")
              .trim()
              .replace(/\s+/g, " ");
          } catch {}
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
      let structureSummary = "";
      const lines = [];

      const shape = summarizeStructure(nodes);
      const shapeBits = [];
      if (shape.repeated) {
        const r = shape.repeated;
        shapeBits.push(
          `${r.rows} repeated <${r.rowTag}> rows (~${r.perRow} control${r.perRow > 1 ? "s" : ""} each: ${r.kinds.join(", ")})`
        );
      }
      if (shape.inputs) shapeBits.push(`${shape.inputs} input${shape.inputs > 1 ? "s" : ""}`);
      if (openDialogs.length)
        shapeBits.push(`${openDialogs.length} open dialog${openDialogs.length > 1 ? "s" : ""}`);
      if (shapeBits.length > 0 || nodes.length >= 8) {
        shapeBits.push(shape.regions.join(", "));
        structureSummary = shapeBits.join(" · ");
      }
      if (activeModal) {
        const modalTitle = fromPage(
          (
            activeModal.getAttribute("aria-label") ||
            activeModal.querySelector("h1, h2, h3, [class*='title' i]")?.innerText ||
            activeModal.tagName.toLowerCase()
          )
            .trim()
            .replace(/\s+/g, " ")
        ).slice(0, 80);
        const modalRef = getOrAssignRef(activeModal);
        lines.push(
          `[Active Modal/Drawer: ${modalTitle} (@${modalRef}) — read it with 'get text @${modalRef}'; close it with 'dismiss' (Escape, or its own close control)]`
        );
      } else if (openDialogs.length > 0) {
        const d = openDialogs[0];
        const extra = openDialogs.length > 1 ? ` (+${openDialogs.length - 1} more open)` : "";
        const dialogRef = getOrAssignRef(d.node);
        lines.push(
          `[Open dialog: "${d.label}" ${d.width}x${d.height} (@${dialogRef}), does not block the page${extra} — read it with 'get text @${dialogRef}'; close it with 'dismiss']`
        );
      }

      const keyInputs = elements.filter(
        (e) => e.tag === "input" || e.tag === "textarea" || e.tag === "select"
      );
      if (keyInputs.length > 0) {
        lines.push("[Key Inputs & Search Fields]");
        for (const inp of keyInputs) {
          lines.push(`  ` + formatDesc(inp));
        }
      }

      let lastLandmark = null;
      let lastRegion = null;
      let mainLinksCount = 0;
      const MAX_MAIN_LINKS = 12;

      let i = 0;
      while (i < elements.length) {
        const e = elements[i];
        if (e.landmark !== lastLandmark || e.region !== lastRegion) {
          lastLandmark = e.landmark;
          lastRegion = e.region;
          const named = e.region ? ` \u2014 ${e.region}` : "";
          if (e.landmark === "modal") lines.push(`[Active Modal / Dialog${named}]`);
          else if (e.landmark === "header") lines.push(`[Header / Banner${named}]`);
          else if (e.landmark === "nav") lines.push(`[Navigation${named}]`);
        }

        if (elements.length > 30 && e.landmark === "main" && e.tag === "a") {
          mainLinksCount++;
          if (mainLinksCount > MAX_MAIN_LINKS) {
            let foldRunEnd = i;
            const foldedRefs = [];
            while (
              foldRunEnd < elements.length &&
              elements[foldRunEnd].landmark === "main" &&
              elements[foldRunEnd].tag === "a"
            ) {
              foldedRefs.push(`@${elements[foldRunEnd].ref}`);
              foldRunEnd++;
            }
            if (foldedRefs.length > 0) {
              foldedCount += foldedRefs.length;
              const sampleRefs =
                foldedRefs.slice(0, 5).join(", ") +
                (foldedRefs.length > 5 ? `, ... +${foldedRefs.length - 5} more` : "");
              const foldedEls = elements
                .slice(i, foldRunEnd)
                .map((x) => indexedElements[x.index])
                .filter(Boolean);
              const kinds = describeElements(foldedEls, 3);
              const what = kinds.length ? ` — ${kinds.join(", ")}` : "";
              lines.push(
                `  ... [folded ${foldedRefs.length} links${what} (refs: ${sampleRefs}). Use 'find <text>' to target one, or 'snapshot --all' to list them]`
              );
              i = foldRunEnd;
              continue;
            }
          }
        }

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
          const foldedRefs = elements
            .slice(i + 2, runEnd)
            .map((x) => `@${x.ref}`)
            .join(", ");
          lines.push(
            `  ... [folded ${folded} repetitive <${e.tag}> "${e.text}" (refs: ${foldedRefs})]`
          );
          i = runEnd;
        } else {
          if (dupOf.has(e.ref)) {
            duplicateCount++;
            i++;
            continue;
          }
          lines.push(`  ` + formatDesc(e));
          i++;
        }
      }

      res.census = lines.join("\n");
      res.foldedCount = foldedCount;
      res.duplicateCount = duplicateCount;
      if (structureSummary) res.structure = structureSummary;
    }

    const hints = hiddenContentHints(nodes);
    const regions = openDialogs.length ? overflowingRegions(openDialogs[0].node) : [];
    const hiddenContent = [
      ...hints.more.map((x) => ({ kind: "load-more", text: x.text, ref: x.ref })),
      ...hints.tabs.map((x) => ({ kind: "tab", text: x.text, ref: x.ref, selected: !!x.selected })),
      ...regions.map((r) => ({ kind: "scrollable-region", hiddenPx: r.hidden, ref: r.ref })),
    ];
    if (hiddenContent.length) res.hiddenContent = hiddenContent;

    return res;
  }

  function resolve(index) {
    const cached = indexedElements[index];
    if (cached && cached.isConnected) return cached;
    const stamped = document.querySelector(`[data-bctl-ref="${index}"]`);
    if (stamped) return stamped;
    if (!cached) throw new Error(`no element at index ${index} (snapshot first?)`);
    throw new Error(`element ${index} is stale (re-snapshot)`);
  }

  let refCounter = 0;
  const refMap = {};
  const reverseRefMap = new WeakMap();
  function shadowInteractiveTarget(el) {
    if (!el || !el.tagName || !el.tagName.includes("-") || !el.shadowRoot) return null;
    let inner;
    try {
      inner = el.shadowRoot.querySelector(INTERACTIVE_SELECTOR);
    } catch {
      return null;
    }
    if (!inner) return null;
    return isVisible(inner) ? inner : null;
  }

  function startMutationCounter() {
    let count = 0;
    let obs = null;
    try {
      obs = new MutationObserver((records) => {
        count += records.length;
      });
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    } catch {}
    return {
      stop() {
        try {
          if (obs) obs.disconnect();
        } catch {}
        return count;
      },
    };
  }

  function buildEffect({ urlBefore, el, mutationCount, measured }) {
    return {
      measured: !!measured,
      domMutated: mutationCount > 0,
      mutationCount,
      urlChanged: location.href !== urlBefore,
      targetStillPresent: !!(el && el.isConnected),
    };
  }

  const textOnlyMatches = new WeakSet();

  function findInteractiveAncestor(el, maxDepth = 6) {
    let node = el;
    for (let depth = 0; node && depth < maxDepth; depth++) {
      if (node.matches && node.matches(INTERACTIVE_SELECTOR)) return node;
      const role = node.getAttribute && node.getAttribute("role");
      if (role && /^(button|link|menuitem|option|tab|checkbox|radio|switch|treeitem)$/i.test(role))
        return node;
      const tabindex = node.getAttribute && node.getAttribute("tabindex");
      if (tabindex && tabindex !== "-1") return node;
      if (node.onclick) return node;
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
    }
    return null;
  }

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

  function relocateByLabel(ref) {
    const remembered = refLabels[ref];
    if (!remembered) return null;
    let live;
    try {
      live = deepQueryAll(INTERACTIVE_SELECTOR).filter(isCensusVisible);
    } catch {
      return null;
    }
    const want = remembered.label;
    const wantFolded = foldText(want);
    let exact = null;
    let folded = null;
    for (const el of live) {
      let t;
      try {
        t = fullElementText(el).slice(0, 80);
      } catch {
        continue;
      }
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
    if (!el || !el.isConnected) {
      delete refMap[refId];
      return null;
    }
    return el;
  }

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

    const containers = deepQueryAll("span, p, h1, h2, h3, h4, h5, h6, b, strong, div").filter(
      (el) => {
        if (!isVisible(el)) return false;
        const t = (el.innerText || el.textContent || "").trim();
        return t.toLowerCase().includes(q) && t.length <= text.length + 60;
      }
    );
    if (containers.length > 0) {
      const container = containers[containers.length - 1];
      const interactiveAncestor = findInteractiveAncestor(container);
      if (interactiveAncestor) out.push({ el: interactiveAncestor, step: "interactive" });
      else out.push({ el: container, step: "text-container" });
    }
    return out;
  }

  function isValidCss(selector) {
    if (typeof selector !== "string" || !selector.trim()) return false;
    try {
      document.createDocumentFragment().querySelector(selector);
      return true;
    } catch {
      return false;
    }
  }

  function makeCandidate(el) {
    return {
      ref: "@" + getOrAssignRef(el),
      tag: (el.tagName || "").toLowerCase(),
      label: elementText(el).slice(0, 50).trim(),
    };
  }

  function ambiguityError(target, candidates, reason) {
    const list = candidates
      .slice(0, 5)
      .map((c) => `${c.ref} <${c.tag}> "${c.label}"`)
      .join(", ");
    throw createStructuredError(
      `ambiguous target "${target}" matched ${candidates.length} elements (${reason}): ${list}. Disambiguate with a ref, prefix (css=, text=, placeholder=), or a more specific string.`,
      "AMBIGUOUS_TARGET",
      { target, count: candidates.length, candidates: candidates.slice(0, 5) },
      "Disambiguate with a ref (@ref_...), prefix (css=, text=, placeholder=), or a narrower string."
    );
  }

  // `ref`, `selector`, `text`, `placeholder` and `index` are accepted here and folded into a
  // single target string. The MCP surface does not offer them — the CLI does, where a human
  // types `--selector` — so this branch is load-bearing for the terminal and invisible to agents.
  function resolveTarget({ target, index, ref, selector, text, placeholder } = {}) {
    const rawTarget =
      target !== undefined && target !== null
        ? target
        : ref !== undefined && ref !== null
          ? String(ref)
          : selector !== undefined && selector !== null
            ? selector.startsWith("css=")
              ? selector
              : `css=${selector}`
            : text !== undefined && text !== null
              ? text.startsWith("text=")
                ? text
                : `text=${text}`
              : placeholder !== undefined && placeholder !== null
                ? placeholder.startsWith("placeholder=")
                  ? placeholder
                  : `placeholder=${placeholder}`
                : index !== undefined && index !== null
                  ? index
                  : null;

    if (rawTarget === null) {
      throw new Error(
        "this action needs a 'target': a ref '@ref_1', a CSS selector, the control's visible text, or a snapshot index"
      );
    }

    if (typeof rawTarget === "number") {
      const el = resolve(rawTarget);
      if (!el) {
        throw createStructuredError(
          `no element at snapshot index ${rawTarget}`,
          "ELEMENT_NOT_FOUND",
          { index: rawTarget },
          "Run snapshot to refresh elements and valid indices."
        );
      }
      el._resolved = {
        by: "index",
        ref: "@" + getOrAssignRef(el),
        tag: el.tagName.toLowerCase(),
        label: elementText(el).slice(0, 50).trim(),
        matchCount: 1,
      };
      return el;
    }

    const tStr = String(rawTarget).trim();

    if (tStr.startsWith("index=")) {
      const idxStr = tStr.slice(6).trim();
      const idx = parseInt(idxStr, 10);
      if (isNaN(idx)) {
        throw createStructuredError(`invalid index target '${tStr}'`, "INVALID_TARGET", {
          target: tStr,
        });
      }
      const el = resolve(idx);
      if (!el) {
        throw createStructuredError(
          `no element at snapshot index ${idx}`,
          "ELEMENT_NOT_FOUND",
          { index: idx },
          "Run snapshot to refresh elements and valid indices."
        );
      }
      el._resolved = {
        by: "index",
        ref: "@" + getOrAssignRef(el),
        tag: el.tagName.toLowerCase(),
        label: elementText(el).slice(0, 50).trim(),
        matchCount: 1,
      };
      return el;
    }

    if (tStr.startsWith("css=")) {
      const sel = tStr.slice(4);
      if (!isValidCss(sel)) {
        throw createStructuredError(`'${sel}' is not a valid CSS selector`, "INVALID_SELECTOR", {
          selector: sel,
        });
      }
      const matches = deepQueryAll(sel);
      if (matches.length === 0) {
        throw createStructuredError(
          `no element matching selector "${sel}"`,
          "ELEMENT_NOT_FOUND",
          { selector: sel },
          "Verify selector syntax or run snapshot to inspect page elements."
        );
      }
      const el = matches[0];
      el._resolved = {
        by: "css",
        ref: "@" + getOrAssignRef(el),
        tag: el.tagName.toLowerCase(),
        label: elementText(el).slice(0, 50).trim(),
        matchCount: matches.length,
      };
      return el;
    }

    if (tStr.startsWith("text=")) {
      const q = tStr.slice(5).trim();
      const qLower = q.toLowerCase();
      const interactive = deepQueryAll(INTERACTIVE_SELECTOR)
        .concat(deepQueryAll(ARIA_TEXT_SELECTOR))
        .filter(isVisible);
      const exactMatches = [...new Set(interactive)].filter((el) => {
        const txt = elementText(el).trim().toLowerCase();
        const acc = accessibleName(el).trim().toLowerCase();
        return txt === qLower || acc === qLower;
      });
      if (exactMatches.length > 1) {
        ambiguityError(tStr, exactMatches.map(makeCandidate), "exact text match");
      }
      if (exactMatches.length === 1) {
        const el = exactMatches[0];
        el._resolved = {
          by: "text-exact",
          ref: "@" + getOrAssignRef(el),
          tag: el.tagName.toLowerCase(),
          label: elementText(el).slice(0, 50).trim(),
          matchCount: 1,
        };
        return el;
      }
      const sub = matchesByText(q, { max: 20 });
      if (sub.length > 1) {
        ambiguityError(
          tStr,
          sub.map((m) => makeCandidate(m.el)),
          "text substring match"
        );
      }
      if (sub.length === 1) {
        const el = sub[0].el;
        if (sub[0].step === "text-container") textOnlyMatches.add(el);
        el._resolved = {
          by: "text-substring",
          ref: "@" + getOrAssignRef(el),
          tag: el.tagName.toLowerCase(),
          label: elementText(el).slice(0, 50).trim(),
          matchCount: 1,
        };
        return el;
      }
      throw createStructuredError(
        `no element found with text matching "${q}"`,
        "ELEMENT_NOT_FOUND",
        { text: q },
        "Run snapshot --compact to inspect available visible element labels or use a CSS selector."
      );
    }

    if (tStr.startsWith("placeholder=")) {
      const ph = tStr.slice(12).trim().toLowerCase();
      const phMatches = deepQueryAll("input, textarea").filter((el) => {
        if (!isVisible(el)) return false;
        const p = (el.getAttribute("placeholder") || "").toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        return p.includes(ph) || aria.includes(ph);
      });
      if (phMatches.length > 1) {
        ambiguityError(tStr, phMatches.map(makeCandidate), "placeholder match");
      }
      if (phMatches.length === 1) {
        const el = phMatches[0];
        el._resolved = {
          by: "placeholder",
          ref: "@" + getOrAssignRef(el),
          tag: el.tagName.toLowerCase(),
          label: elementText(el).slice(0, 50).trim(),
          matchCount: 1,
        };
        return el;
      }
      throw createStructuredError(
        `no input found with placeholder matching "${ph}"`,
        "ELEMENT_NOT_FOUND",
        { placeholder: ph },
        "Run snapshot --compact to view available input placeholder attributes."
      );
    }

    const refMatch = tStr.match(/^@?(ref_\d+|e\d+)$/i);
    if (refMatch) {
      const canonicalRef = tStr.replace(/^@/, "");
      let el = resolveRef(canonicalRef);
      if (!el && /^e\d+$/i.test(canonicalRef)) {
        el = resolveRef(`ref_${canonicalRef.slice(1)}`);
      }
      if (el) {
        el._resolved = {
          by: "ref",
          ref: "@" + getOrAssignRef(el),
          tag: el.tagName.toLowerCase(),
          label: elementText(el).slice(0, 50).trim(),
          matchCount: 1,
        };
        return el;
      }

      const atMatch = tStr.match(/^@?(?:ref_|e)(\d+)$/i);
      // prettier-ignore
      const canonical = atMatch ? `ref_${parseInt(atMatch[1], 10)}` : String(tStr).trim().replace(/^@/, "");
      const moved = relocateByLabel(canonical);
      if (moved) {
        throw createStructuredError(
          `ref "${tStr}" is stale — the page re-rendered. The control labelled "${moved.label}" is now @${moved.ref}${moved.exact ? "" : " (matched ignoring case/diacritics)"}; retry with that ref.`,
          "STALE_REF",
          { ref: tStr, relocatedTo: moved.ref, label: moved.label, exactLabelMatch: moved.exact },
          `Retry the same action with @${moved.ref}. No re-snapshot needed.`
        );
      }
      throw createStructuredError(
        `ref "${tStr}" not found or stale (re-run read_page / snapshot)`,
        "STALE_REF",
        { ref: tStr, rememberedLabel: refLabels[canonical] ? refLabels[canonical].label : null },
        refLabels[canonical]
          ? `This ref pointed at "${refLabels[canonical].label}", which is no longer on the page. Call snapshot to see what replaced it, or find "${refLabels[canonical].label}".`
          : "The element referenced by this ref is no longer in the DOM or was detached. Call snapshot again to refresh refs."
      );
    }

    const hasCssSyntax = /[#.\[\]>+~:]|\s/.test(tStr);
    if (hasCssSyntax && isValidCss(tStr)) {
      const cssMatches = deepQueryAll(tStr);
      if (cssMatches.length > 1) {
        ambiguityError(tStr, cssMatches.map(makeCandidate), "CSS selector match");
      }
      if (cssMatches.length === 1) {
        const el = cssMatches[0];
        el._resolved = {
          by: "css",
          ref: "@" + getOrAssignRef(el),
          tag: el.tagName.toLowerCase(),
          label: elementText(el).slice(0, 50).trim(),
          matchCount: 1,
        };
        return el;
      }
    }

    const tLower = tStr.toLowerCase();
    const interactive = deepQueryAll(INTERACTIVE_SELECTOR)
      .concat(deepQueryAll(ARIA_TEXT_SELECTOR))
      .filter(isVisible);
    const exactMatches = [...new Set(interactive)].filter((el) => {
      const txt = elementText(el).trim().toLowerCase();
      const acc = accessibleName(el).trim().toLowerCase();
      return txt === tLower || acc === tLower;
    });
    if (exactMatches.length > 1) {
      ambiguityError(tStr, exactMatches.map(makeCandidate), "exact visible text match");
    }
    if (exactMatches.length === 1) {
      const el = exactMatches[0];
      el._resolved = {
        by: "text-exact",
        ref: "@" + getOrAssignRef(el),
        tag: el.tagName.toLowerCase(),
        label: elementText(el).slice(0, 50).trim(),
        matchCount: 1,
      };
      return el;
    }

    const phMatches = [...new Set(deepQueryAll("input, textarea, [aria-label]"))].filter((el) => {
      if (!isVisible(el)) return false;
      const p = (el.getAttribute("placeholder") || "").trim().toLowerCase();
      const a = (el.getAttribute("aria-label") || "").trim().toLowerCase();
      return p === tLower || a === tLower;
    });
    if (phMatches.length > 1) {
      ambiguityError(tStr, phMatches.map(makeCandidate), "exact placeholder / aria-label match");
    }
    if (phMatches.length === 1) {
      const el = phMatches[0];
      el._resolved = {
        by: "placeholder",
        ref: "@" + getOrAssignRef(el),
        tag: el.tagName.toLowerCase(),
        label: elementText(el).slice(0, 50).trim(),
        matchCount: 1,
      };
      return el;
    }

    const sub = matchesByText(tStr, { max: 20 });
    if (sub.length > 1) {
      ambiguityError(
        tStr,
        sub.map((m) => makeCandidate(m.el)),
        "text substring match"
      );
    }
    if (sub.length === 1) {
      const el = sub[0].el;
      if (sub[0].step === "text-container") textOnlyMatches.add(el);
      el._resolved = {
        by: "text-substring",
        ref: "@" + getOrAssignRef(el),
        tag: el.tagName.toLowerCase(),
        label: elementText(el).slice(0, 50).trim(),
        matchCount: 1,
      };
      return el;
    }

    if (!hasCssSyntax && isValidCss(tStr)) {
      const cssMatches = deepQueryAll(tStr);
      if (cssMatches.length > 1) {
        ambiguityError(tStr, cssMatches.map(makeCandidate), "CSS type selector match");
      }
      if (cssMatches.length === 1) {
        const el = cssMatches[0];
        el._resolved = {
          by: "css",
          ref: "@" + getOrAssignRef(el),
          tag: el.tagName.toLowerCase(),
          label: elementText(el).slice(0, 50).trim(),
          matchCount: 1,
        };
        return el;
      }
    }

    throw createStructuredError(
      `no element matching "${tStr}"`,
      "ELEMENT_NOT_FOUND",
      { target: tStr },
      /^\d+$/.test(tStr)
        ? `If you meant snapshot index ${tStr}, pass target: ${tStr} (number) or target: "index=${tStr}".`
        : "Run snapshot to inspect available visible elements or use an explicit prefix (css=, text=, placeholder=, index=)."
    );
  }

  const TAG_ROLE = {
    a: "link",
    button: "button",
    select: "combobox",
    textarea: "textbox",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    img: "img",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    form: "form",
    ul: "list",
    ol: "list",
    li: "listitem",
    table: "table",
    summary: "button",
    label: "label",
    option: "option",
  };
  const INTERACTIVE_ROLES = new Set([
    "link",
    "button",
    "textbox",
    "combobox",
    "checkbox",
    "radio",
    "slider",
    "searchbox",
    "tab",
    "menuitem",
    "menuitemradio",
    "menuitemcheckbox",
    "switch",
    "option",
    "treeitem",
    "spinbutton",
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
    const pick = (s) => (s ? fromPage(String(s).trim().replace(/\s+/g, " ")).slice(0, 100) : "");
    let n = pick(el.getAttribute && el.getAttribute("aria-label"));
    if (n) return n;
    const labelledby = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelledby) {
      const lbl = document.getElementById(labelledby.split(/\s+/)[0]);
      if (lbl) {
        n = pick(lbl.innerText);
        if (n) return n;
      }
    }
    n = pick(el.getAttribute && el.getAttribute("placeholder"));
    if (n) return n;
    n = pick(el.getAttribute && el.getAttribute("title"));
    if (n) return n;
    n = pick(el.getAttribute && el.getAttribute("alt"));
    if (n) return n;
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) {
        n = pick(lab.innerText);
        if (n) return n;
      }
    }
    const txt = TEXT_IS_CONTENT.has(el.tagName) ? "" : pick(el.innerText || el.textContent);
    if (txt.length >= 3) return txt;

    try {
      const formLabel = controlLabelOf(el);
      if (formLabel) return pick(formLabel);
    } catch {}

    try {
      const tag = el.tagName;
      const type = (el.getAttribute("type") || "").toLowerCase();
      const valueIsCaption = tag === "INPUT" && ["button", "submit", "reset"].includes(type);
      const valueIsContent =
        tag === "INPUT" &&
        ["text", "search", "email", "url", "tel", "number", "password", ""].includes(type);
      if ((valueIsCaption || valueIsContent) && el.value && String(el.value).length < 50)
        return pick(el.value);
    } catch {}
    return "";
  }

  function read_page({ mode = "interactive", depth = 60, ref_id, maxChars = 50000 } = {}) {
    const root = ref_id ? resolveRef(ref_id) : document.body;
    if (ref_id && !root)
      throw new Error(`ref "${ref_id}" not found or stale; call read_page without ref_id`);
    if (!root) return { url: location.href, title: document.title, tree: "", truncated: false };
    const all = mode === "all";
    const lines = [];
    let size = 0;
    let truncated = false;
    let depthClipped = false;
    let deepest = 0;
    const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META"]);

    function emit(line) {
      if (size + line.length + 1 > maxChars) {
        truncated = true;
        return false;
      }
      lines.push(line);
      size += line.length + 1;
      return true;
    }

    function walk(el, d) {
      if (truncated) return;
      if (d > depth) {
        if (el.children && el.children.length) depthClipped = true;
        return;
      }
      if (d > deepest) deepest = d;
      for (const child of el.children) {
        if (truncated) return;
        if (SKIP_TAGS.has(child.tagName)) continue;
        let listThis = true;
        if (!all) {
          if (child.getAttribute && child.getAttribute("aria-hidden") === "true") continue;
          const reason = visibilityReason(child);
          if (reason === "display:none" || reason === "visibility:hidden") continue;
          if (reason !== null) listThis = false;
        }
        const role = roleOf(child);
        const interactive = !!role && INTERACTIVE_ROLES.has(role);
        if (listThis && (all || interactive || role === "heading")) {
          const name = accessibleName(child);
          let line = "  ".repeat(d) + (role || child.tagName.toLowerCase());
          if (name) line += ` "${name}"`;
          try {
            const st = STATE_ATTRS.map((a) => [a.replace("aria-", ""), child.getAttribute(a)])
              .filter(([, v]) => v === "true" || v === "mixed" || v === "page")
              .map(([k, v]) => (v === "true" ? k : `${k}=${v}`));
            if (st.length) line += ` [${st.join(",")}]`;
          } catch {}
          if (interactive) line += ` [${getOrAssignRef(child)}]`;
          if (child.tagName === "INPUT") {
            const t = child.getAttribute("type");
            if (t) line += ` type="${t}"`;
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
        if (child.shadowRoot) walk(child.shadowRoot, d + 1);
      }
    }

    walk(root, 0);

    const notices = [];
    try {
      const visibleNow = deepQueryAll(INTERACTIVE_SELECTOR).filter(isCensusVisible);
      const shape = summarizeStructure(visibleNow);
      const bits = [];
      if (shape.repeated)
        bits.push(
          `${shape.repeated.rows} repeated <${shape.repeated.rowTag}> rows (~${shape.repeated.perRow} control${shape.repeated.perRow > 1 ? "s" : ""} each)`
        );
      if (shape.inputs) bits.push(`${shape.inputs} inputs`);
      if (bits.length || visibleNow.length >= 8) {
        bits.push(shape.regions.join(", "));
        notices.push(`[Structure: ${bits.join(" · ")}]`);
      }
    } catch {}
    try {
      const dialogs = findOpenDialogs();
      if (dialogs.length) {
        const d = dialogs[0];
        notices.push(
          `Open dialog: "${d.label}" ${d.width}x${d.height}${dialogs.length > 1 ? ` (+${dialogs.length - 1} more)` : ""} — its contents are included above.`
        );
      }
      const visible = deepQueryAll(INTERACTIVE_SELECTOR).filter(isCensusVisible);
      const hints = hiddenContentHints(visible);
      const regions = dialogs.length ? overflowingRegions(dialogs[0].node) : [];
      if (hints.more.length || regions.length) {
        const bits = [];
        if (hints.more.length)
          bits.push(hints.more.map((h) => `"${h.text}" (@${h.ref})`).join(", "));
        if (regions.length)
          bits.push(
            `a scrollable region with ~${regions[0].hidden}px below the fold (@${regions[0].ref})`
          );
        notices.push(
          `Possible hidden content: ${bits.join("; ")}. Lists like these load on demand — no depth or scope setting reveals rows that are not in the DOM yet; click the control instead.`
        );
      }
      if (hints.tabs.length) {
        notices.push(
          `Filter tabs present: ${hints.tabs.map((t) => `"${t.text}"${t.selected ? " (selected)" : ""} (@${t.ref})`).join(", ")} — the list you are reading may be one filtered view of several.`
        );
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
      ...(depthClipped ? { depthClipped: true } : {}),
      ...(truncated
        ? { note: "Output capped at maxChars. Reduce depth or pass a ref_id to focus a subtree." }
        : {}),
      ...(depthClipped && !truncated
        ? {
            note: `Walk stopped at depth ${depth} with deeper nodes remaining, so most of this page is MISSING from the tree above — do not treat it as the page's contents. Re-call with depth 60 (the default), or use browser_snapshot, which has no depth limit and costs a fraction of a screenshot.`,
          }
        : {}),
      ...(empty && !depthClipped
        ? {
            note: "No interactive elements or headings matched. Try mode='all', or browser_snapshot.",
          }
        : {}),
    };
  }

  function foldText(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .toLowerCase()
      .trim();
  }

  function nearestLabels(query, limit) {
    const q = foldText(query);
    if (!q) return [];
    const out = [];
    const seen = new Set();
    let all;
    try {
      all = deepQueryAll(INTERACTIVE_SELECTOR).filter(isCensusVisible);
    } catch {
      return [];
    }
    for (const el of all) {
      let t;
      try {
        t = elementTextInfo(el).text;
      } catch {
        continue;
      }
      if (!t || seen.has(t)) continue;
      const f = foldText(t);
      if (!f) continue;
      if (f === q || f.includes(q) || q.includes(f)) {
        seen.add(t);
        out.push({
          ref: getOrAssignRef(el),
          name: t.slice(0, 80),
          reason: f === q ? "diacritics/case only" : "substring after folding",
        });
        if (out.length >= (limit || 3)) break;
      }
    }
    return out;
  }

  function pageVocabulary(limit) {
    let els;
    try {
      els = deepQueryAll(INTERACTIVE_SELECTOR).filter(isCensusVisible);
    } catch {
      return [];
    }
    const seen = new Set();
    const out = [];
    for (const el of els) {
      let t;
      try {
        t = elementTextInfo(el).text;
      } catch {
        continue;
      }
      if (!t || t.length > 40 || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= (limit || 12)) break;
    }
    return out;
  }

  function find({ query, selector, max = 20 } = {}) {
    if (!query && !selector) throw new Error("find requires 'query' or 'selector'");
    if (selector) {
      let els;
      try {
        els = deepQueryAll(selector);
      } catch {
        return {
          count: 0,
          matches: [],
          searchedScope: "top frame, open Shadow DOM and iframes",
          note: `'${selector}' is not a valid CSS selector.`,
        };
      }
      const visible = els.filter((el) => isVisible(el));
      const chosen = (visible.length ? visible : els).slice(0, max);
      const out = chosen.map((el) => ({
        ref: getOrAssignRef(el),
        role: roleOf(el) || el.tagName.toLowerCase(),
        name: accessibleName(el),
        tag: el.tagName.toLowerCase(),
        matchedBy: "selector",
        clickable: (() => {
          try {
            return el.matches(INTERACTIVE_SELECTOR);
          } catch {
            return false;
          }
        })(),
        ...(() => {
          const cut = elementTextInfo(el).truncatedBy;
          return cut ? { truncatedBy: cut, fullTextVia: `get text @${getOrAssignRef(el)}` } : {};
        })(),
      }));
      if (out.length === 0) {
        return {
          count: 0,
          matches: [],
          searchedScope: "top frame, open Shadow DOM and iframes",
          note: "No element matched that CSS selector. It may not have rendered yet, or it may live in a closed shadow root.",
        };
      }
      return {
        count: out.length,
        matches: out,
        ...(visible.length && els.length > visible.length
          ? {
              note: `${els.length - visible.length} further match(es) are hidden and are not listed.`,
            }
          : {}),
        ...(visible.length === 0
          ? { note: "Every match is currently hidden; refs are still returned." }
          : {}),
      };
    }
    const hits = matchesByText(query, { max });
    const out = hits.map(({ el, step }) => ({
      ref: getOrAssignRef(el),
      role: roleOf(el) || el.tagName.toLowerCase(),
      name: accessibleName(el),
      tag: el.tagName.toLowerCase(),
      matchedBy: step,
      clickable: step !== "text-container",
      ...(() => {
        const cut = elementTextInfo(el).truncatedBy;
        return cut ? { truncatedBy: cut, fullTextVia: `get text @${getOrAssignRef(el)}` } : {};
      })(),
    }));
    if (out.length === 0) {
      const nearest = nearestLabels(query, 3);
      return {
        count: 0,
        matches: [],
        searchedScope: "top frame, open Shadow DOM and iframes",
        ...(nearest.length ? { nearest } : {}),
        pageLabels: pageVocabulary(12),
        note: nearest.length
          ? "No exact match. 'nearest' lists labels that differ only by case/diacritics; 'pageLabels' shows what this page actually calls things."
          : "No exact match. 'pageLabels' shows what this page actually calls things — the label you want is probably there, in the page's own language. If not, it may be offscreen, in a closed shadow root, or not loaded yet.",
      };
    }
    return { count: out.length, matches: out };
  }

  const BLOCK_TAGS = new Set([
    "DIV",
    "P",
    "LI",
    "TD",
    "TH",
    "SECTION",
    "ARTICLE",
    "ASIDE",
    "HEADER",
    "FOOTER",
    "MAIN",
    "NAV",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "BLOCKQUOTE",
    "DD",
    "DT",
    "FIGCAPTION",
    "PRE",
    "TABLE",
    "UL",
    "OL",
    "FORM",
    "BODY",
  ]);

  function blockContainerOf(el, cache) {
    if (cache.has(el)) return cache.get(el);
    let e = el;
    while (e !== document.body && e.parentElement && !BLOCK_TAGS.has(e.tagName)) {
      e = e.parentElement;
    }
    cache.set(el, e);
    return e;
  }

  function segmentIndexAt(segments, offset) {
    let lo = 0,
      hi = segments.length - 1,
      ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid].start <= offset) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  function segmentsInRange(segments, startOff, endOff) {
    const out = [];
    let i = segmentIndexAt(segments, startOff);
    while (i < segments.length && segments[i].start < endOff) {
      out.push(segments[i]);
      i++;
    }
    return out;
  }

  function find_text({ query, regex = false, max = 20, contextChars = 80 } = {}) {
    if (!query) throw new Error("find_text requires 'query'");
    const pattern = regex
      ? query
      : String(query)
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\s+/g, "\\s+");
    const matcher = new RegExp(pattern, "gi");

    const acceptNode = (node) => {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const tag = node.parentElement && node.parentElement.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT")
        return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    };

    const roots = [];
    const collectRoots = (root) => {
      roots.push(root);
      let hosts;
      try {
        hosts = root.querySelectorAll("*");
      } catch {
        return;
      }
      for (const el of hosts) if (el.shadowRoot) collectRoots(el.shadowRoot);
    };
    if (document.body) collectRoots(document.body);

    const containerCache = new Map();
    const containers = new Map();
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode });
      let node;
      while ((node = walker.nextNode())) {
        const container = blockContainerOf(node.parentElement, containerCache);
        let rec = containers.get(container);
        if (!rec) {
          rec = { flat: "", segments: [] };
          containers.set(container, rec);
        }
        rec.segments.push({ start: rec.flat.length, node });
        rec.flat += node.nodeValue;
      }
    }

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
        if (ancestors.length > 1) match.spanInteractives = ancestors;
        matches.push(match);
        if (m.index === matcher.lastIndex) matcher.lastIndex++;
      }
    }
    return {
      count: matches.length,
      matches,
      searchedScope: { topFrame: true, shadowRoots: roots.length - 1, iframes: false },
    };
  }

  function wait_settle({ timeoutMs = 150 } = {}) {
    const start = Date.now();
    return new Promise((resolve) => {
      let timer = null;
      let observer = null;
      let mutationCount = 0;
      const done = () => {
        if (observer) {
          try {
            observer.disconnect();
          } catch {}
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

  async function click({
    target,
    index,
    ref,
    selector,
    text,
    doubleClick = false,
    button = "left",
    waitFor,
    autoSettle = true,
    settleMs = 150,
  } = {}) {
    const el = resolveTarget({ target, index, ref, selector, text });
    if (textOnlyMatches.has(el)) {
      const nearby = deepQueryAll(INTERACTIVE_SELECTOR)
        .filter(isVisible)
        .slice(0, 3)
        .map(
          (cand) =>
            `@${getOrAssignRef(cand)} (${cand.tagName.toLowerCase()}: ${elementText(cand).slice(0, 40)})`
        );
      throw createStructuredError(
        `"${text || target}" was found only as plain text inside <${el.tagName.toLowerCase()}>, which has no click handler — clicking it would do nothing`,
        "ELEMENT_NOT_INTERACTIVE",
        { text: text || target, tagName: el.tagName.toLowerCase(), ref: getOrAssignRef(el) },
        nearby.length > 0
          ? `Use get_text on @${getOrAssignRef(el)} to read it, or click a real control such as: ${nearby.join(", ")}`
          : `Use get_text on @${getOrAssignRef(el)} to read it. Run find_text to see the nearest interactive ancestor of this text.`
      );
    }
    const warning = actionability(el);
    const urlBefore = location.href;
    const eventTarget = shadowInteractiveTarget(el) || el;
    const STATEFUL = ["aria-checked", "aria-selected", "aria-pressed", "aria-expanded"];
    const stateBefore = {};
    let isStateful = false;
    for (const a of STATEFUL) {
      try {
        const v = el.getAttribute(a);
        if (v !== null) {
          stateBefore[a] = v;
          isStateful = true;
        }
      } catch {}
    }

    el.scrollIntoView({ block: "center", inline: "center" });
    const stability = await waitForStableRect(el);
    const coveredInfo = checkElementCovered(el);
    const mutations = startMutationCounter();

    const rect = el.getBoundingClientRect();
    const clientX = Math.max(0, rect.left + rect.width / 2);
    const clientY = Math.max(0, rect.top + rect.height / 2);
    const buttonNum = button === "right" ? 2 : button === "middle" ? 1 : 0;
    const eventOpts = {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      view: window,
      button: buttonNum,
      buttons: buttonNum === 2 ? 2 : buttonNum === 1 ? 4 : 1,
    };

    eventTarget.dispatchEvent(new PointerEvent("pointerover", eventOpts));
    eventTarget.dispatchEvent(new PointerEvent("pointerenter", eventOpts));
    eventTarget.dispatchEvent(new MouseEvent("mouseover", eventOpts));
    eventTarget.dispatchEvent(new MouseEvent("mouseenter", eventOpts));
    eventTarget.dispatchEvent(new PointerEvent("pointerdown", eventOpts));
    eventTarget.dispatchEvent(new MouseEvent("mousedown", eventOpts));
    try {
      eventTarget.focus();
    } catch {}
    eventTarget.dispatchEvent(new PointerEvent("pointerup", eventOpts));
    eventTarget.dispatchEvent(new MouseEvent("mouseup", eventOpts));
    if (button === "right") {
      eventTarget.dispatchEvent(new MouseEvent("contextmenu", eventOpts));
    } else {
      eventTarget.dispatchEvent(new MouseEvent("click", eventOpts));
      if (doubleClick) {
        eventTarget.dispatchEvent(new PointerEvent("pointerdown", eventOpts));
        eventTarget.dispatchEvent(new MouseEvent("mousedown", eventOpts));
        eventTarget.dispatchEvent(new PointerEvent("pointerup", eventOpts));
        eventTarget.dispatchEvent(new MouseEvent("mouseup", eventOpts));
        eventTarget.dispatchEvent(new MouseEvent("click", eventOpts));
        eventTarget.dispatchEvent(new MouseEvent("dblclick", eventOpts));
      }
    }

    if (waitFor) {
      await wait_for({ selector: waitFor, timeoutMs: 5000 }).catch(() => {});
    }

    let waitedMs = 0;
    if (autoSettle && settleMs > 0) {
      const settleRes = await wait_settle({ timeoutMs: settleMs });
      waitedMs = settleRes.waitedMs || 0;
    }
    const mutationCount = mutations.stop();
    const out = {
      clicked: target != null ? target : ref != null ? ref : selector || text || index,
      waitedMs,
      effect: buildEffect({ urlBefore, el, mutationCount, measured: autoSettle && settleMs > 0 }),
      resolved: el._resolved,
    };
    if (eventTarget !== el) {
      out.dispatchedTo = `<${eventTarget.tagName.toLowerCase()}> inside <${el.tagName.toLowerCase()}> shadow root`;
    }
    const addWarning = (w) => {
      out.warning = out.warning ? `${out.warning} — ${w}` : w;
    };
    if (stability.moved) {
      out.effect.stabilized = { waitedMs: stability.waitedMs, settled: stability.settled };
      if (!stability.settled) {
        addWarning(
          (stability.via === "animation"
            ? "the element was still moving when it was clicked (an animation that moves its box is still running)"
            : `the element was still moving when it was clicked (its box kept changing for ${stability.waitedMs}ms)`) +
            ": the coordinates this click used may already be stale. If nothing happened, wait for the animation " +
            '(browser_wait_for {for: "settle"}) and click again'
        );
      }
    }
    if (coveredInfo && coveredInfo.covered) {
      addWarning(
        `element is covered by <${coveredInfo.coveredBy}> (@${coveredInfo.topRef}) — click event dispatched, but overlay may have intercepted it`
      );
    } else if (warning) {
      addWarning(
        `element is not visible (${warning}) — the handler was still invoked, but verify the effect`
      );
    }
    if (isStateful) {
      const changed = [];
      const unchanged = [];
      for (const a of Object.keys(stateBefore)) {
        let now = null;
        try {
          now = el.getAttribute(a);
        } catch {}
        (now !== stateBefore[a] ? changed : unchanged).push(
          `${a.replace("aria-", "")}: ${stateBefore[a]}${now !== stateBefore[a] ? ` -> ${now}` : ""}`
        );
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
      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      } catch {}

      const contentBefore = el.isContentEditable ? el.textContent : String(el.value ?? "");
      const changed = () =>
        (el.isContentEditable ? el.textContent : String(el.value ?? "")) !== contentBefore;

      let inserted = false;

      const tryClipboardEvent = () => {
        try {
          const dt = new DataTransfer();
          dt.setData("text/plain", text);
          const ev = new ClipboardEvent("paste", {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
          });
          const notPrevented = el.dispatchEvent(ev);
          if (!notPrevented) return true;
        } catch {
          return false;
        }
        return changed();
      };
      const tryInsertText = () => {
        try {
          return document.execCommand("insertText", false, text) === true;
        } catch {
          return false;
        }
      };

      if (paste) inserted = tryClipboardEvent() || tryInsertText();
      else inserted = tryInsertText() || tryClipboardEvent();

      if (!inserted && text) {
        try {
          el.textContent = text;
        } catch {}
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { textNow: String(el.textContent || "").slice(0, 200), inserted: inserted || !!text };
    }

    if ("value" in el) {
      setNativeValue(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    const candidateInputs = deepQueryAll(
      "input:not([type=hidden]), textarea, [contenteditable=true]"
    )
      .filter(isVisible)
      .slice(0, 3)
      .map((cand) => {
        const ref = getOrAssignRef(cand);
        const tag = cand.tagName.toLowerCase();
        const name = cand.name ? `[name="${cand.name}"]` : "";
        const ph = cand.placeholder ? `[placeholder="${cand.placeholder}"]` : "";
        return `@${ref} (${tag}${name}${ph})`;
      });
    const hint =
      candidateInputs.length > 0
        ? `Target <${el.tagName.toLowerCase()}> is not an editable field. Try editable inputs in viewport: ${candidateInputs.join(", ")}`
        : `Target <${el.tagName.toLowerCase()}> does not accept text input. Inspect snapshot --compact for input elements.`;

    throw createStructuredError(
      `target element is not editable (<${el.tagName.toLowerCase()}>)`,
      "ELEMENT_NOT_EDITABLE",
      { tagName: el.tagName.toLowerCase(), candidateInputs },
      hint
    );
  }

  async function type({
    target,
    index,
    ref,
    selector,
    text = "",
    placeholder,
    method = "set",
    submit,
    waitFor,
    autoSettle = true,
    settleMs = 100,
  } = {}) {
    const el = resolveTarget({ target, index, ref, selector, placeholder });
    const warning = actionability(el);
    const urlBefore = location.href;
    el.scrollIntoView({ block: "center", inline: "center" });
    const mutations = startMutationCounter();
    insertIntoEditable(el, text, { paste: method === "paste" });
    if (submit) {
      const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13 };
      const form = el.form;
      let submittedByKey = false;
      const noteSubmit = () => {
        submittedByKey = true;
      };
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
      typed: target != null ? target : ref != null ? ref : selector || placeholder || index,
      effect: buildEffect({
        urlBefore,
        el,
        mutationCount: typeMutations,
        measured: autoSettle && settleMs > 0,
      }),
      resolved: el._resolved,
    };
    if ("value" in el) out.effect.valueNow = String(el.value ?? "").slice(0, 200);
    else if (el.isContentEditable) out.effect.textNow = String(el.textContent ?? "").slice(0, 200);
    if (warning)
      out.warning = `element is not visible (${warning}) — the action was still applied, but verify the effect`;
    return out;
  }

  async function paste({
    target,
    index,
    ref,
    selector,
    text = "",
    placeholder,
    submit,
    waitFor,
    autoSettle = true,
    settleMs = 150,
  } = {}) {
    const el = resolveTarget({ target, index, ref, selector, placeholder });
    const warning = actionability(el);
    const urlBefore = location.href;
    el.scrollIntoView({ block: "center", inline: "center" });
    const mutations = startMutationCounter();
    insertIntoEditable(el, text, { paste: true });
    if (submit) {
      const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13 };
      const form = el.form;
      let submittedByKey = false;
      const noteSubmit = () => {
        submittedByKey = true;
      };
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
      pasted: target != null ? target : ref != null ? ref : selector || placeholder || index,
      length: text.length,
      effect: buildEffect({
        urlBefore,
        el,
        mutationCount: pasteMutations,
        measured: autoSettle && settleMs > 0,
      }),
      resolved: el._resolved,
    };
    if ("value" in el) out.effect.valueNow = String(el.value ?? "").slice(0, 200);
    else if (el.isContentEditable) out.effect.textNow = String(el.textContent ?? "").slice(0, 200);
    if (warning)
      out.warning = `element is not visible (${warning}) — the action was still applied, but verify the effect`;
    return out;
  }

  function findScrollableContainer() {
    const active = findActiveModal();
    if (active) {
      if (active.scrollHeight > active.clientHeight + 10) return active;
      const innerScroll = active.querySelector(
        '[style*="overflow"], [class*="content" i], [class*="body" i], [class*="scroll" i], [class*="pane" i]'
      );
      if (innerScroll && innerScroll.scrollHeight > innerScroll.clientHeight + 10)
        return innerScroll;
    }

    const candidates = deepQueryAll(
      'main, [role="main"], [role="region"], [role="grid"], [role="table"], div, section, article'
    );
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

  function scroll({ direction = "down", amount = 400, target, ref, selector, index } = {}) {
    const isUp = direction === "up";
    const isLeft = direction === "left";
    const isRight = direction === "right";
    const delta = isUp ? -amount : amount;

    if (
      target !== undefined ||
      ref !== undefined ||
      selector !== undefined ||
      index !== undefined
    ) {
      const el = resolveTarget({ target, ref, selector, index });
      if (el) {
        if (el.tagName === "IFRAME") {
          try {
            el.contentWindow.scrollBy({
              top: isLeft || isRight ? 0 : delta,
              left: isLeft ? -amount : isRight ? amount : 0,
              behavior: "instant" in window ? "instant" : "auto",
            });
            return {
              scrolledY: el.contentWindow.scrollY,
              target: target || ref || selector || index,
              resolved: el._resolved,
            };
          } catch {}
        }
        if (el.scrollHeight <= el.clientHeight + 2 && el.scrollWidth <= el.clientWidth + 2) {
          const ancestor = findScrollableContainer();
          throw createStructuredError(
            `<${el.tagName.toLowerCase()}> is not a scrollable container (scrollHeight ${el.scrollHeight} <= clientHeight ${el.clientHeight}) — nothing would move`,
            "SCROLL_TARGET_NOT_SCROLLABLE",
            {
              tagName: el.tagName.toLowerCase(),
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
            },
            ancestor
              ? `To scroll the region containing it, target @${getOrAssignRef(ancestor)} (<${ancestor.tagName.toLowerCase()}>). To bring this element into view instead, use scrollintoview.`
              : `Use scrollintoview to bring this element into view, or omit the target to scroll the page.`
          );
        }
        const prevTop = el.scrollTop;
        const prevLeft = el.scrollLeft;
        if (isLeft || isRight) {
          el.scrollBy({
            left: isLeft ? -amount : amount,
            behavior: "instant" in window ? "instant" : "auto",
          });
        } else {
          el.scrollBy({ top: delta, behavior: "instant" in window ? "instant" : "auto" });
        }
        return {
          scrolledY: el.scrollTop,
          scrolledX: el.scrollLeft,
          delta: isLeft || isRight ? el.scrollLeft - prevLeft : el.scrollTop - prevTop,
          target: target || ref || selector || index,
          container: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ""),
          resolved: el._resolved,
        };
      }
    }

    const rootScrollable =
      document.scrollingElement && document.scrollingElement.scrollHeight > window.innerHeight + 10;
    const prevY = window.scrollY;
    const prevX = window.scrollX;
    if (isLeft || isRight) {
      window.scrollBy({
        left: isLeft ? -amount : amount,
        behavior: "instant" in window ? "instant" : "auto",
      });
      return { scrolledX: window.scrollX, delta: window.scrollX - prevX };
    }

    if (rootScrollable) {
      window.scrollBy({ top: delta, behavior: "instant" in window ? "instant" : "auto" });
      if (window.scrollY !== prevY) {
        return { scrolledY: window.scrollY, delta: window.scrollY - prevY };
      }
    }

    const container = findScrollableContainer();
    if (container) {
      const prevTop = container.scrollTop;
      container.scrollBy({ top: delta, behavior: "instant" in window ? "instant" : "auto" });
      return {
        scrolledY: container.scrollTop,
        delta: container.scrollTop - prevTop,
        container: container.tagName.toLowerCase() + (container.id ? `#${container.id}` : ""),
      };
    }

    window.scrollBy({ top: delta, behavior: "instant" in window ? "instant" : "auto" });
    return { scrolledY: window.scrollY, delta: window.scrollY - prevY };
  }

  async function dismiss_modal({ ref, selector } = {}) {
    const before = findActiveModal();

    const confirm = async (method, extra = {}) => {
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
      for (const el of deepQueryAll('button, [role="button"], a[href="#"]', active)) {
        const name = (accessibleName(el) || elementText(el) || "").trim();
        if (/^(close|dismiss|cancel|no,? thanks|×|✕|✖|x)$/i.test(name)) candidates.push(el);
      }
      for (const btn of candidates) {
        if (!isVisible(btn)) continue;
        tried.push(
          `@${getOrAssignRef(btn)} ("${(accessibleName(btn) || elementText(btn) || "").trim().slice(0, 30)}")`
        );
        (shadowInteractiveTarget(btn) || btn).click();
        const ok = await confirm("button_click", { buttonRef: getOrAssignRef(btn) });
        if (ok) return ok;
      }
    }

    if (active instanceof HTMLDialogElement && active.open) {
      active.close();
      const ok = await confirm("dialog_close");
      if (ok) return ok;
    }

    const target = document.activeElement || active || document.body;
    const evOpts = {
      key: "Escape",
      code: "Escape",
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true,
    };
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

  async function hover({
    target,
    index,
    ref,
    selector,
    text,
    autoSettle = true,
    settleMs = 50,
  } = {}) {
    const el = resolveTarget({ target, index, ref, selector, text });
    const warning = actionability(el);
    el.scrollIntoView({ block: "center", inline: "center" });
    const opts = { bubbles: true, cancelable: true };
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mouseenter", opts));
    el.dispatchEvent(new MouseEvent("mousemove", opts));
    if (autoSettle && settleMs > 0) {
      await wait_settle({ timeoutMs: settleMs });
    }
    const out = { hovered: ref != null ? ref : selector || text || index };
    if (warning)
      out.warning = `element is not visible (${warning}) — the action was still applied, but verify the effect`;
    return out;
  }

  function select_option({
    target,
    index,
    ref,
    selector,
    values,
    value,
    label,
    option,
    autoSettle: _autoSettle = true,
    settleMs: _settleMs = 100,
  } = {}) {
    const el = resolveTarget({ target, index, ref, selector });
    const warning = actionability(el);
    if (el.tagName !== "SELECT") throw new Error("target element is not a select");
    const which =
      target != null
        ? `target ${target}`
        : ref != null
          ? `ref ${ref}`
          : selector != null
            ? `selector ${selector}`
            : `index ${index}`;
    const optionsOf = () =>
      Array.from(el.options).map((o) => `${o.text.trim()} (value=${o.value})`);

    const vals = Array.isArray(values)
      ? values
      : value !== undefined
        ? [value]
        : option !== undefined
          ? [option]
          : label !== undefined
            ? [label]
            : [];

    if (vals.length === 0) {
      throw new Error(
        "select_option requires 'values' (array of strings) or 'value'/'option'/'label'"
      );
    }

    const matchedOptions = [];
    for (const v of vals) {
      const vStr = String(v).trim();
      const m =
        Array.from(el.options).find((opt) => opt.value === vStr) ||
        Array.from(el.options).find((opt) => opt.text.trim() === vStr) ||
        null;
      if (!m) {
        throw new Error(
          `no option matching "${v}" in select (${which}) — available: ${optionsOf().join(", ") || "(none)"}`
        );
      }
      matchedOptions.push(m);
    }

    if (el.multiple) {
      for (const opt of Array.from(el.options)) opt.selected = false;
      for (const m of matchedOptions) m.selected = true;
    } else {
      const chosen = matchedOptions[0];
      el.value = chosen.value;
      chosen.selected = true;
    }

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    const out = {
      selected: values !== undefined ? vals : vals[0],
      resolved: el._resolved,
    };
    if (warning)
      out.warning = `element is not visible (${warning}) — the action was still applied, but verify the effect`;
    return out;
  }

  function press_key({ key, target: targetInput, index, ref, modifiers }) {
    const target =
      targetInput !== undefined || index !== undefined || ref !== undefined
        ? resolveTarget({ target: targetInput, index, ref })
        : document.activeElement || document.body;
    if (target.focus) target.focus();
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
    const form = key === "Enter" ? target.form : null;
    let submittedByKey = false;
    const noteSubmit = () => {
      submittedByKey = true;
    };
    if (form) form.addEventListener("submit", noteSubmit, { capture: true });

    const keydownNotPrevented = target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keypress", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));

    if (form) {
      form.removeEventListener("submit", noteSubmit, { capture: true });
      if (!submittedByKey && keydownNotPrevented) form.requestSubmit?.();
    }
    return {
      pressed: key,
      modifiers: modifiers || [],
      via: "dom",
      ...(target._resolved ? { resolved: target._resolved } : {}),
      ...(form ? { submittedByPage: submittedByKey, keydownPrevented: !keydownNotPrevented } : {}),
    };
  }

  const normalizeForMatch = (s) =>
    String(s == null ? "" : s)
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

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
          const diag = { readyState: document.readyState, waitedMs: Date.now() - start };
          if (selector !== undefined) {
            diag.selectorMatches = 0;
            try {
              diag.selectorMatches = deepQueryAll(selector).length;
            } catch {
              diag.selectorInvalid = true;
            }
          } else if (!gone) {
            const body = bodyText();
            if (caseSensitive && normalizeForMatch(body).includes(normalizeForMatch(text))) {
              const at = normalizeForMatch(body).indexOf(normalizeForMatch(text));
              diag.presentInAnotherCase = body
                .replace(/\s+/g, " ")
                .substr(at, String(text).length + 10);
            }
            const hay = normalizeForMatch(body);
            let keep = 0;
            for (let n = needle.length; n >= 4; n--) {
              if (hay.includes(needle.slice(0, n))) {
                keep = n;
                break;
              }
            }
            if (keep > 0 && keep < needle.length) {
              const at = hay.indexOf(needle.slice(0, keep));
              diag.closestOnPage = body.replace(/\s+/g, " ").substr(Math.max(0, at), keep + 24);
            }
            diag.bodyChars = body.length;
          }
          const err = new Error(
            `wait_for timed out after ${timeoutMs}ms (readyState: ${document.readyState})` +
              (diag.presentInAnotherCase
                ? ` — the text IS present as "${diag.presentInAnotherCase}"`
                : "") +
              (diag.closestOnPage ? ` — closest text on page: "${diag.closestOnPage}"` : "") +
              (diag.bodyChars === 0
                ? " — the page has no text yet, it is probably still loading"
                : "")
          );
          err.code = "WAIT_TIMEOUT";
          err.diagnostics = diag;
          err.recoveryHint =
            diag.bodyChars === 0
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

  function upload_mark({ target, index, ref, selector, text, placeholder } = {}) {
    const isFileInput = (e) =>
      e && e.tagName === "INPUT" && (e.type || "").toLowerCase() === "file";
    const named =
      target != null ||
      index != null ||
      ref != null ||
      selector != null ||
      text != null ||
      placeholder != null;
    const all = deepQueryAll('input[type="file"]');
    let input = null;
    let matchedBy = "";
    let resolved = null;

    if (named) {
      const el = resolveTarget({ target, index, ref, selector, text, placeholder });
      resolved = el._resolved;
      if (isFileInput(el)) {
        input = el;
        matchedBy = "the element itself";
      } else {
        const inside = all.filter((i) => composedContains(el, i));
        if (inside.length === 1) {
          input = inside[0];
          matchedBy = "a file input inside the target";
        } else if (inside.length > 1) {
          throw createStructuredError(
            `the target contains ${inside.length} file inputs`,
            "AMBIGUOUS_TARGET",
            { count: inside.length },
            "Name the input itself — browser_find({selector: 'input[type=file]'}) returns a ref for each."
          );
        } else {
          const forId = el.getAttribute && el.getAttribute("for");
          const byFor = forId ? document.getElementById(forId) : null;
          const label = el.closest ? el.closest("label") : null;
          const byLabel = label && label.control ? label.control : null;
          if (isFileInput(byFor)) {
            input = byFor;
            matchedBy = "the input this label points at";
          } else if (isFileInput(byLabel)) {
            input = byLabel;
            matchedBy = "the input this label wraps";
          }
        }
      }
    }

    if (!input && all.length === 1) {
      input = all[0];
      matchedBy = named
        ? "the page's only file input (the named target was not one)"
        : "the page's only file input";
    }

    if (!input) {
      throw createStructuredError(
        all.length === 0
          ? "no <input type=file> on this page"
          : `${all.length} file inputs on this page and the target did not name one`,
        "ELEMENT_NOT_FOUND",
        { fileInputs: all.length },
        all.length === 0
          ? "The page may open its file picker from JavaScript, which no tool can answer — check for a hidden input first with browser_find({selector: 'input[type=file]'})."
          : "Name one: browser_find({selector: 'input[type=file]'}) returns a ref for each."
      );
    }

    for (const e of deepQueryAll("[data-bctl-upload]")) e.removeAttribute("data-bctl-upload");
    input.setAttribute("data-bctl-upload", "1");
    return {
      matchedBy,
      ref: getOrAssignRef(input),
      name: input.name || null,
      accept: input.accept || null,
      multiple: !!input.multiple,
      hidden: !isVisible(input),
      resolved: input._resolved || resolved,
    };
  }

  function element_rect({ index, ref } = {}) {
    const el = resolveTarget({ index, ref });
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

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

  function collapseRepeatedRuns(text) {
    const tokens = text.split(" ");
    const out = [];
    let i = 0;
    while (i < tokens.length) {
      let bestUnitLen = 0;
      let bestRepeats = 1;
      for (let unitLen = 1; unitLen <= 5 && i + unitLen <= tokens.length; unitLen++) {
        const unit = tokens.slice(i, i + unitLen).join(" ");
        if (unit.length > 40) break;
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

  function visibleDialog() {
    const dialogs = document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]');
    let best = null,
      bestLen = 0;
    for (const d of dialogs) {
      const r = d.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) continue;
      if (getComputedStyle(d).visibility === "hidden") continue;
      const len = (d.innerText || "").length;
      if (len > 200 && len > bestLen) {
        best = d;
        bestLen = len;
      }
    }
    return best;
  }

  async function get_page_content({ maxChars = 8000 } = {}) {
    const initialText = ((document.body && document.body.innerText) || "").trim();
    if (initialText.length < 80) {
      await wait_settle({ timeoutMs: 600 });
    }
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
    const res = {
      title: document.title,
      url: location.href,
      text,
      ...(fromDialog ? { source: "dialog" } : {}),
    };
    if (!fromDialog) {
      res.hint =
        "Prose text only. For interactive UI elements, notifications, unread badges, or app headers, proceed autonomously with browser_snapshot or browser_find.";
    }
    return res;
  }

  function click_selector({ selector }) {
    const el = deepQuery(selector);
    if (!el) throw new Error("no element matches " + selector);
    const warning = actionability(el);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.click();
    const out = { clicked: selector };
    if (warning)
      out.warning = `element is not visible (${warning}) — the action was still applied, but verify the effect`;
    return out;
  }

  function fill_selector({ selector, value }) {
    const el = deepQuery(selector);
    if (!el) throw new Error("no element matches " + selector);
    const warning = actionability(el);
    insertIntoEditable(el, value, { paste: false });
    const out = { filled: selector };
    if (warning)
      out.warning = `element is not visible (${warning}) — the action was still applied, but verify the effect`;
    return out;
  }

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

  let recording = false;
  let recordRemovers = [];
  function cssSelector(el) {
    try {
      if (!el || !el.tagName) return "";
      if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) {
        return "#" + CSS.escape(el.id);
      }
      const segments = [];
      let node = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 5) {
        const tag = node.tagName.toLowerCase();
        if (node.id && document.querySelectorAll("#" + CSS.escape(node.id)).length === 1) {
          segments.unshift("#" + CSS.escape(node.id));
          return segments.join(" > ");
        }
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
    } catch (_err) {
      return el && el.tagName ? el.tagName.toLowerCase() : "";
    }
  }

  function emitStep(step) {
    if (!recording) return;
    try {
      chrome.runtime.sendMessage({ __bctl_record_step: step });
    } catch (_err) {}
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
      } catch (_err) {}
    });
    recordRemovers = [];
    return { recording: false };
  }

  function extract({ selector, fields, max = 50 } = {}) {
    if (!selector) {
      throw new Error("extract requires a row 'selector' (e.g. 'table tbody tr' or 'li.result')");
    }
    if (!isValidCss(selector)) {
      const err = new Error(`'${selector}' is not a valid CSS selector`);
      err.code = "INVALID_SELECTOR";
      throw err;
    }
    const els = deepQueryAll(selector);
    const capped = els.slice(0, Math.max(1, max));
    const fieldSpecs =
      fields && typeof fields === "object" && !Array.isArray(fields) ? fields : null;
    const missingByField = new Map();

    const matches = capped.map((node) => {
      const row = { ref: "@" + getOrAssignRef(node) };
      if (!fieldSpecs) {
        return { ...row, ...readOneProperty(node, "text") };
      }
      for (const [name, spec] of Object.entries(fieldSpecs)) {
        const f = typeof spec === "string" ? { selector: spec } : spec || {};
        const targetNode = f.selector ? deepQuery(f.selector, node) : node;
        if (!targetNode) {
          row[name] = null;
          missingByField.set(name, (missingByField.get(name) || 0) + 1);
          continue;
        }
        const read = readOneProperty(targetNode, f.property || (f.attr ? "attr" : "text"), f.attr);
        if (read.resolved !== undefined) row[name] = read.resolved;
        else if (read.value !== undefined) row[name] = read.value;
        else {
          const { property: _p, name: _n, ...rest } = read;
          row[name] = rest;
        }
      }
      return row;
    });

    const res = {
      selector,
      count: els.length,
      extracted: matches.length,
      matches,
    };
    if (fieldSpecs) res.fields = Object.keys(fieldSpecs);
    const notes = [];
    if (fieldSpecs && missingByField.size) {
      notes.push(
        `no match inside the row for: ${[...missingByField].map(([n, c]) => `${n} (${c}/${capped.length} rows)`).join(", ")}. Field selectors resolve INSIDE each row — a value that sits in a SIBLING of the row is not reachable this way.`
      );
    }
    if (els.length > capped.length) {
      notes.push(
        `${els.length} elements matched; the first ${capped.length} are listed. Raise 'max' or narrow the selector.`
      );
    }
    if (els.length === 0) {
      notes.push(
        "0 matches. This is an answer, not a failure — the selector is valid and nothing on the page matches it."
      );
    }
    if (notes.length) res.note = notes.length === 1 ? notes[0] : notes;
    return res;
  }

  async function fill_form({ fields = [], submitTarget, autoSettle = true, settleMs = 150 } = {}) {
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new Error("fill_form requires 'fields' (array of {target, value, method?})");
    }
    const urlBefore = location.href;
    const mutations = startMutationCounter();
    const filled = [];

    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!f || !f.target) {
        const mutationCount = mutations.stop();
        throw createStructuredError(
          `fill_form field at index ${i} missing 'target'`,
          "FILL_FORM_PARTIAL_FAILURE",
          {
            failedIndex: i,
            filled,
            effect: buildEffect({ urlBefore, mutationCount, measured: true }),
          },
          "Each field must specify a 'target' and 'value'."
        );
      }
      try {
        const el = resolveTarget({ target: f.target });
        const method = f.method || "set";
        insertIntoEditable(el, f.value ?? "", { paste: method === "paste" });
        filled.push({
          index: i,
          target: f.target,
          value: f.value,
          resolved: el._resolved,
        });
      } catch (err) {
        const mutationCount = mutations.stop();
        throw createStructuredError(
          `fill_form failed at field index ${i} (${f.target}): ${err.message}`,
          "FILL_FORM_PARTIAL_FAILURE",
          {
            failedIndex: i,
            filled,
            effect: buildEffect({ urlBefore, mutationCount, measured: true }),
          },
          "Fix the target of the failed field and retry remaining fields."
        );
      }
    }

    let submitResult = null;
    if (submitTarget) {
      try {
        submitResult = await click({ target: submitTarget, autoSettle: false });
      } catch (err) {
        const mutationCount = mutations.stop();
        throw createStructuredError(
          `fill_form filled ${filled.length} fields, but submitTarget failed: ${err.message}`,
          "FILL_FORM_PARTIAL_FAILURE",
          {
            failedIndex: -1,
            filled,
            submitError: err.message,
            effect: buildEffect({ urlBefore, mutationCount, measured: true }),
          },
          "Fields were entered. Verify submitTarget and click it with browser_click."
        );
      }
    }

    if (autoSettle && settleMs > 0) {
      await wait_settle({ timeoutMs: settleMs });
    }
    const mutationCount = mutations.stop();
    return {
      filled,
      ...(submitResult ? { submitResult } : {}),
      effect: buildEffect({
        urlBefore,
        mutationCount,
        measured: autoSettle && settleMs > 0,
      }),
    };
  }

  function get_property({
    target,
    property,
    ref,
    index,
    selector,
    text,
    placeholder,
    attr,
    all,
    max = 50,
    fields,
  } = {}) {
    if (property === "title") return { property: "title", value: document.title };
    if (property === "url") return { property: "url", value: location.href };

    if (property === "count") {
      const sel =
        selector ||
        (typeof target === "string" && target.startsWith("css=") ? target.slice(4) : target);
      if (sel === undefined) return { property: "count", value: 1 };
      if (!isValidCss(sel)) {
        const err = new Error(`'${sel}' is not a valid CSS selector`);
        err.code = "INVALID_SELECTOR";
        err.recoveryHint =
          "Roles from read_page (link, button, textbox) are ARIA roles, not CSS tags — use 'a', 'button', '[role=textbox]', or browser_find with the label instead.";
        throw err;
      }
      let value = 0;
      try {
        value = deepQueryAll(sel).length;
      } catch {
        const err = new Error(`'${sel}' is not a valid CSS selector`);
        err.code = "INVALID_SELECTOR";
        throw err;
      }
      const out = { property: "count", value, selector: sel };
      if (value === 0) {
        out.note =
          "0 matches. This is an answer, not a failure — the selector is valid and nothing on the page matches it. If you meant an ARIA role, CSS needs [role=...]; browser_find searches by label instead.";
      }
      return out;
    }

    if (fields && !all) {
      throw new Error(
        "'fields' reads several values per ROW, so it needs all:true and a row 'selector' (e.g. selector:'li.result', fields:{title:'h3', url:{selector:'a', attr:'href'}})"
      );
    }
    if (all) {
      const sel =
        selector ||
        (typeof target === "string" && target.startsWith("css=") ? target.slice(4) : target);
      if (sel === undefined) {
        throw new Error(
          "'all' reads every match of a CSS 'selector' — pass one (a ref or index is a single element by definition)"
        );
      }
      let invalid = false;
      try {
        document.createDocumentFragment().querySelector(sel);
      } catch {
        invalid = true;
      }
      if (invalid) {
        const err = new Error(`'${sel}' is not a valid CSS selector`);
        err.code = "INVALID_SELECTOR";
        throw err;
      }
      const els = deepQueryAll(sel);
      const prop = property || "text";
      const capped = els.slice(0, Math.max(1, max));

      const fieldSpecs =
        fields && typeof fields === "object" && !Array.isArray(fields) ? fields : null;
      const missingByField = new Map();
      const matches = capped.map((node) => {
        if (!fieldSpecs) return { ref: getOrAssignRef(node), ...readOneProperty(node, prop, attr) };
        const row = { ref: getOrAssignRef(node) };
        for (const [name, spec] of Object.entries(fieldSpecs)) {
          const f = typeof spec === "string" ? { selector: spec } : spec || {};
          const targetNode = f.selector ? deepQuery(f.selector, node) : node;
          if (!targetNode) {
            row[name] = null;
            missingByField.set(name, (missingByField.get(name) || 0) + 1);
            continue;
          }
          const read = readOneProperty(
            targetNode,
            f.property || (f.attr ? "attr" : "text"),
            f.attr
          );
          if (read.resolved !== undefined) row[name] = read.resolved;
          else if (read.value !== undefined) row[name] = read.value;
          else {
            const { property: _p, name: _n, ...rest } = read;
            row[name] = rest;
          }
        }
        return row;
      });
      const res = {
        property: fieldSpecs ? undefined : prop,
        all: true,
        selector: sel,
        count: els.length,
        matches,
      };
      const notes = [];
      if (fieldSpecs) {
        res.fields = Object.keys(fieldSpecs);
        if (missingByField.size) {
          notes.push(
            `no match inside the row for: ${[...missingByField].map(([n, c]) => `${n} (${c}/${capped.length} rows)`).join(", ")}. ` +
              `Field selectors resolve INSIDE each row — a value that sits in a SIBLING of the row (a separate <tr>, the next <div>) ` +
              `is not reachable this way; read it with its own selector in a second call.`
          );
        }
      }
      if (els.length > capped.length) {
        notes.push(
          `${els.length} elements matched; the first ${capped.length} are listed. Raise 'max' or narrow the selector.`
        );
      }
      if (els.length === 0) {
        notes.push(
          "0 matches. This is an answer, not a failure — the selector is valid and nothing on the page matches it."
        );
      }
      if (notes.length) res.note = notes.length === 1 ? notes[0] : notes;
      return res;
    }

    const hasTarget =
      target !== undefined ||
      ref !== undefined ||
      index !== undefined ||
      selector !== undefined ||
      text !== undefined ||
      placeholder !== undefined;
    const el = hasTarget
      ? resolveTarget({ target, ref, index, selector, text, placeholder })
      : document.documentElement;

    let matchCount;
    if (selector !== undefined) {
      try {
        matchCount = deepQueryAll(selector).length;
      } catch {
        matchCount = undefined;
      }
    }
    const withMatchCount = (out) => {
      if (matchCount !== undefined && matchCount > 1) {
        out.matchCount = matchCount;
        out.note = `selector matched ${matchCount} elements; this is the first — pass a more specific selector or a ref to choose another`;
      }
      return out;
    };

    const out = readOneProperty(el, property || "text", attr);
    if (el._resolved) out.resolved = el._resolved;
    return MATCH_COUNTED.has(property || "text") ? withMatchCount(out) : out;
  }

  const MATCH_COUNTED = new Set(["text", "html", "attr", "attribute"]);

  function readOneProperty(el, property, attr) {
    switch (property) {
      case "text":
        return { property: "text", value: fromPage((el.innerText || el.textContent || "").trim()) };
      case "value":
        return {
          property: "value",
          value: fromPage(el.value !== undefined ? el.value : el.innerText || ""),
        };
      case "html":
        return { property: "html", value: fromPage(el.outerHTML || "") };
      case "attr":
      case "attribute": {
        const has = !!(attr && el.hasAttribute && el.hasAttribute(attr));
        const raw = has ? el.getAttribute(attr) : null;
        const attrOut = { property: "attr", name: attr, present: has, value: raw };
        if (has && raw && /^(href|src|action|poster|cite|formaction|data|srcset)$/i.test(attr)) {
          try {
            const abs = new URL(raw, document.baseURI).href;
            if (abs !== raw) attrOut.resolved = abs;
          } catch {}
        }
        return attrOut;
      }
      case "box": {
        const r = el.getBoundingClientRect();
        return { property: "box", x: r.x, y: r.y, width: r.width, height: r.height };
      }
      default:
        throw new Error(`unknown property "${property}"`);
    }
  }

  function clear_input({
    index,
    ref,
    selector,
    placeholder,
    autoSettle: _autoSettle = true,
    settleMs: _settleMs = 100,
  } = {}) {
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
    const out = { cleared: ref != null ? ref : selector || placeholder || index };
    if (warning) out.warning = `element is not visible (${warning})`;
    return out;
  }

  function set_checked({
    index,
    ref,
    selector,
    text,
    checked = true,
    autoSettle: _autoSettle = true,
    settleMs: _settleMs = 100,
  } = {}) {
    const el = resolveTarget({ index, ref, selector, text });
    const warning = actionability(el);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.checked = !!checked;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    const out = {
      [checked ? "checked" : "unchecked"]: ref != null ? ref : selector || text || index,
    };
    if (warning) out.warning = `element is not visible (${warning})`;
    return out;
  }

  function dblclick_element({ index, ref, selector, text } = {}) {
    const el = resolveTarget({ index, ref, selector, text });
    const warning = actionability(el);
    el.scrollIntoView({ block: "center", inline: "center" });
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    const out = { dblclicked: ref != null ? ref : selector || text || index };
    if (warning) out.warning = `element is not visible (${warning})`;
    return out;
  }

  function focus_element({ index, ref, selector, text, placeholder } = {}) {
    const el = resolveTarget({ index, ref, selector, text, placeholder });
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    return { focused: ref != null ? ref : selector || placeholder || text || index };
  }

  function scroll_into_view({ index, ref, selector, text, placeholder } = {}) {
    const el = resolveTarget({ index, ref, selector, text, placeholder });
    el.scrollIntoView({ block: "center", inline: "center" });
    return { scrolledIntoView: ref != null ? ref : selector || placeholder || text || index };
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
    upload_mark,
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
    extract,
    fill_form,
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
    return true;
  });
})();
