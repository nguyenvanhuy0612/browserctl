// @ts-check
// DOM-lane runtime: runs in the extension's isolated world of each frame, on top of Playwright's
// injected script (generated/pw-injected.js). Every operation returns {ok: true, ...} or
// {ok: false, code, message}; nothing throws out (specs/dom-lane.md). The daemon polls; nothing
// here waits on page timers, which are throttled in background tabs (specs/settle.md).
(() => {
  const g = /** @type {any} */ (globalThis);
  if (g.__bctlRuntime) return;

  const REF = /^(f\d+)?e\d+$/;
  const FOCUSABLE = "a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable]:not([contenteditable=false])";
  const MARK = "data-bctl-target";

  /** @type {{injected: any, frameId: number, refs: Map<string, WeakRef<Element>>, mutations: number, probe: string | null, ready: boolean}} */
  const state = { injected: null, frameId: 0, refs: new Map(), mutations: 0, probe: null, ready: false };

  class OpError extends Error {
    /** @param {string} code @param {string} message @param {object} [extra] */
    constructor(code, message, extra) {
      super(message);
      this.code = code;
      this.extra = extra;
    }
  }

  // ---------- setup ----------

  /** @param {number} frameId */
  function init(frameId) {
    if (state.ready) return { ok: true, frameId: state.frameId };
    const InjectedScript = g.__bctlInjectedScriptClass;
    state.injected = new InjectedScript(globalThis, {
      isUnderTest: false,
      sdkLanguage: "javascript",
      testIdAttributeName: "data-testid",
      stableRafCount: 1,
      browserName: "chromium",
      shouldPrependErrorPrefix: false,
      isUtilityWorld: true,
      customEngines: [],
      frameSeq: frameId,
    });
    state.frameId = frameId;
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.attributeName?.startsWith("data-bctl")) continue;
        state.mutations++;
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    addEventListener("message", (event) => {
      const data = event.data;
      if (data && typeof data === "object" && typeof data.__bctlProbe === "string" && event.source === parent) state.probe = data.__bctlProbe;
    });
    state.ready = true;
    return { ok: true, frameId };
  }

  // ---------- elements ----------

  /** @param {Element} element */
  function describe(element) {
    const utils = state.injected.utils;
    let name = "";
    try {
      name = utils.getElementAccessibleNameText(element, false) ?? "";
    } catch {
      name = "";
    }
    return {
      ref: /** @type {any} */ (element)._ariaRef?.ref ?? null,
      role: utils.getAriaRole(element) ?? element.localName,
      name: name.replace(/\s+/g, " ").trim().slice(0, 80),
    };
  }

  /** @param {Element} element */
  const preview = (element) => {
    const d = describe(element);
    return `${d.role} "${d.name}"${d.ref ? " " + d.ref : ""}`;
  };

  /** @param {string} target */
  function resolve(target) {
    if (typeof target !== "string" || !target) throw new OpError("INVALID_TARGET", "target must be a non-empty string");
    if (REF.test(target)) {
      const element = state.refs.get(target)?.deref();
      if (!element || !element.isConnected) throw new OpError("REF_NOT_FOUND", `${target} is not in this page any more`);
      return element;
    }
    let parsed;
    try {
      parsed = state.injected.parseSelector(target);
    } catch (error) {
      throw new OpError("INVALID_TARGET", String(/** @type {any} */ (error).message ?? error));
    }
    let all;
    try {
      all = state.injected.querySelectorAll(parsed, document);
    } catch (error) {
      throw new OpError("INVALID_TARGET", String(/** @type {any} */ (error).message ?? error));
    }
    if (all.length === 0) throw new OpError("TARGET_NOT_FOUND", `nothing matches ${target}`);
    if (all.length > 1) {
      throw new OpError("AMBIGUOUS_TARGET", `${target} matches ${all.length} elements`, {
        count: all.length,
        candidates: all.slice(0, 5).map(preview),
      });
    }
    return all[0];
  }

  /** @param {Element} element */
  function center(element) {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  /** @param {{x: number, y: number}} p */
  const inViewport = (p) => p.x >= 0 && p.y >= 0 && p.x < innerWidth && p.y < innerHeight;

  /** @param {Element} element @param {{enabled?: boolean}} [options] */
  function actionable(element, { enabled = true } = {}) {
    const injected = state.injected;
    if (!element.isConnected) throw new OpError("REF_NOT_FOUND", "the element left the page");
    if (injected.elementState(element, "visible", true).matches !== true) throw new OpError("TARGET_HIDDEN", preview(element));
    if (enabled && injected.elementState(element, "enabled", true).matches !== true) throw new OpError("TARGET_DISABLED", preview(element));
    if (injected.elementState(element, "non-inert", true).matches !== true) throw new OpError("TARGET_DISABLED", `${preview(element)} is inert`);
    let point = center(element);
    if (!inViewport(point)) {
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      point = center(element);
    }
    const hit = injected.expectHitTarget(point, element);
    if (hit !== "done") throw new OpError("TARGET_COVERED", hit?.hitTargetDescription ?? String(hit));
    return point;
  }

  const BUTTONS = { left: { button: 0, buttons: 1 }, middle: { button: 1, buttons: 4 }, right: { button: 2, buttons: 2 } };

  /** @param {string[]} modifiers */
  const modifierFlags = (modifiers = []) => ({
    altKey: modifiers.includes("Alt"),
    ctrlKey: modifiers.includes("Control"),
    metaKey: modifiers.includes("Meta"),
    shiftKey: modifiers.includes("Shift"),
  });

  /** @param {Element} element @param {{x: number, y: number}} point @param {object} base */
  function dispatcher(element, point, base) {
    /** @param {string} type @param {object} [extra] */
    return (type, extra = {}) =>
      state.injected.dispatchEvent(element, type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: point.x,
        clientY: point.y,
        screenX: point.x,
        screenY: point.y,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        ...base,
        ...extra,
      });
  }

  /** @param {Element} element */
  function focusIfFocusable(element) {
    const focusable = element.closest(FOCUSABLE);
    if (focusable instanceof HTMLElement || focusable instanceof SVGElement) focusable.focus({ preventScroll: true });
  }

  /** @param {Element} element @param {{x: number, y: number}} point */
  function hoverEvents(element, point, flags = {}) {
    const fire = dispatcher(element, point, { button: 0, buttons: 0, ...flags });
    fire("pointerover");
    fire("pointerenter", { bubbles: false });
    fire("mouseover");
    fire("mouseenter", { bubbles: false });
    fire("pointermove");
    fire("mousemove");
  }

  /** @param {{target: string, button?: "left" | "middle" | "right", doubleClick?: boolean, modifiers?: string[]}} params */
  function click({ target, button = "left", doubleClick = false, modifiers = [] }) {
    const element = resolve(target);
    const resolved = describe(element);
    const point = actionable(element);
    const flags = modifierFlags(modifiers);
    const { button: code, buttons } = BUTTONS[button];
    hoverEvents(element, point, flags);
    const fire = dispatcher(element, point, { button: code, ...flags });
    const presses = doubleClick ? 2 : 1;
    for (let detail = 1; detail <= presses; detail++) {
      fire("pointerdown", { buttons });
      fire("mousedown", { buttons, detail });
      if (detail === 1) focusIfFocusable(element);
      if (button === "right") fire("contextmenu", { buttons, detail });
      fire("pointerup", { buttons: 0 });
      fire("mouseup", { buttons: 0, detail });
      if (button === "left") fire("click", { buttons: 0, detail });
      if (button === "middle") fire("auxclick", { buttons: 0, detail });
    }
    if (doubleClick && button === "left") fire("dblclick", { buttons: 0, detail: 2 });
    return { resolved };
  }

  /** @param {{target: string}} params */
  function hover({ target }) {
    const element = resolve(target);
    const point = actionable(element, { enabled: false });
    hoverEvents(element, point);
    return { resolved: describe(element) };
  }

  // ---------- text entry ----------

  /** @param {Element} element */
  function readValue(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value;
    return /** @type {HTMLElement} */ (element).innerText ?? element.textContent ?? "";
  }

  /** @param {HTMLInputElement | HTMLTextAreaElement} element @param {string} value */
  function setNativeValue(element, value) {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    /** @type {any} */ (Object.getOwnPropertyDescriptor(proto, "value")).set.call(element, value);
  }

  /** @param {Element} element @param {string} inputType @param {string | null} data */
  function inputEvents(element, inputType, data, change = false) {
    element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data }));
    if (change) element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** @param {Element} element */
  function editableTarget(element) {
    const injected = state.injected;
    if (injected.elementState(element, "editable", true).matches !== true) throw new OpError("TARGET_NOT_EDITABLE", `${preview(element)} is read-only`);
    return injected.retarget(element, "follow-label");
  }

  /** @param {{target: string, value: string}} params */
  function fill({ target, value }) {
    const element = resolve(target);
    const resolved = describe(element);
    actionable(element);
    let result;
    try {
      result = state.injected.fill(element, value);
    } catch (error) {
      throw new OpError("TARGET_NOT_EDITABLE", String(/** @type {any} */ (error).message ?? error));
    }
    if (result === "error:notconnected") throw new OpError("REF_NOT_FOUND", "the element left the page");
    const editable = editableTarget(element);
    if (result === "done") return { resolved, value: readValue(editable), via: "value" };
    /** @type {HTMLElement} */ (editable).focus({ preventScroll: true });
    if (/** @type {HTMLElement} */ (editable).isContentEditable) {
      document.execCommand("selectAll");
      if (value === "") document.execCommand("delete");
      else document.execCommand("insertText", false, value);
      return { resolved, value: readValue(editable), via: "execCommand" };
    }
    const field = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (editable);
    field.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: value }));
    setNativeValue(field, value);
    inputEvents(field, "insertText", value, true);
    return { resolved, value: readValue(field), via: "setter" };
  }

  /** @param {Element} element @param {string} text */
  function insertText(element, text) {
    if (/** @type {HTMLElement} */ (element).isContentEditable) {
      document.execCommand("insertText", false, text);
      return;
    }
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;
    const allowed = element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType: "insertText", data: text }));
    if (!allowed) return;
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? element.value.length;
    setNativeValue(element, element.value.slice(0, start) + text + element.value.slice(end));
    try {
      element.setSelectionRange(start + text.length, start + text.length);
    } catch {
      // input types without selection (email, number)
    }
    inputEvents(element, "insertText", text);
  }

  /**
   * Key events with the browser's default action performed when the page did not prevent it,
   * since synthetic events have none (specs/tools/press_key.md).
   * @param {{target?: string, key: {key: string, code: string, keyCode: number, text: string, location: number}, modifiers?: string[]}} params
   */
  function press({ target, key, modifiers = [] }) {
    let element = target ? resolve(target) : document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    if (target) {
      actionable(element, { enabled: false });
      focusIfFocusable(element);
    }
    element = /** @type {Element} */ (document.activeElement && element.contains(document.activeElement) ? document.activeElement : element);
    const flags = modifierFlags(modifiers);
    const init = { bubbles: true, cancelable: true, composed: true, key: key.key, code: key.code, keyCode: key.keyCode, which: key.keyCode, location: key.location, repeat: false, ...flags };
    const focused = describe(element);
    const allowed = element.dispatchEvent(new KeyboardEvent("keydown", init));
    const typing = key.text && !flags.ctrlKey && !flags.metaKey && !flags.altKey;
    let defaultAction = null;
    if (!allowed) defaultAction = "prevented";
    else {
      if (typing) element.dispatchEvent(new KeyboardEvent("keypress", { ...init, charCode: key.text.charCodeAt(0) }));
      defaultAction = defaultKeyAction(element, key, flags, Boolean(typing));
    }
    element.dispatchEvent(new KeyboardEvent("keyup", init));
    return { focused, defaultAction };
  }

  /** @param {Element} element */
  const isTextField = (element) =>
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "reset", "file", "image", "range", "color"].includes(element.type)) ||
    /** @type {HTMLElement} */ (element).isContentEditable;

  /** @param {Element} element @param {{key: string, text: string}} key @param {ReturnType<typeof modifierFlags>} flags @param {boolean} typing */
  function defaultKeyAction(element, key, flags, typing) {
    const name = key.key;
    const text = isTextField(element);
    if (typing && text && name !== "Enter") {
      insertText(element, key.text);
      return "insertText";
    }
    if ((flags.ctrlKey || flags.metaKey) && name.toLowerCase() === "a") {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.select();
      else document.execCommand("selectAll");
      return "selectAll";
    }
    if (name === "Enter") {
      if (element instanceof HTMLTextAreaElement || /** @type {HTMLElement} */ (element).isContentEditable) {
        insertText(element, "\n");
        return "newline";
      }
      if (element instanceof HTMLInputElement && element.form) {
        element.form.requestSubmit();
        return "submit";
      }
      if (element.matches("button,a[href],[role=button],[role=link],summary,input[type=button],input[type=submit]")) {
        /** @type {HTMLElement} */ (element).click();
        return "click";
      }
      return null;
    }
    if (name === " " && element.matches("button,[role=button],[role=checkbox],[role=switch],input[type=checkbox],input[type=radio],summary")) {
      /** @type {HTMLElement} */ (element).click();
      return "click";
    }
    if (name === "Tab") {
      moveFocus(element, flags.shiftKey ? -1 : 1);
      return "focus";
    }
    if ((name === "Backspace" || name === "Delete") && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? element.value.length;
      const from = start !== end ? start : name === "Backspace" ? Math.max(0, start - 1) : start;
      const to = start !== end ? end : name === "Backspace" ? start : Math.min(element.value.length, end + 1);
      setNativeValue(element, element.value.slice(0, from) + element.value.slice(to));
      inputEvents(element, name === "Backspace" ? "deleteContentBackward" : "deleteContentForward", null);
      return "delete";
    }
    if (!text) {
      const scroller = scrollContainerFor(element);
      const page = scroller.clientHeight * 0.8;
      const amounts = { ArrowDown: 40, ArrowUp: -40, PageDown: page, PageUp: -page, " ": page };
      if (name in amounts) {
        scroller.scrollBy({ top: /** @type {any} */ (amounts)[name], behavior: "instant" });
        return "scroll";
      }
      if (name === "Home" || name === "End") {
        scroller.scrollTo({ top: name === "Home" ? 0 : scroller.scrollHeight, behavior: "instant" });
        return "scroll";
      }
    }
    return null;
  }

  /** @param {Element} from @param {number} step */
  function moveFocus(from, step) {
    const injected = state.injected;
    const candidates = [...document.querySelectorAll(FOCUSABLE)].filter(
      (e) =>
        /** @type {HTMLElement} */ (e).tabIndex >= 0 &&
        !(/** @type {any} */ (e).disabled) &&
        injected.elementState(e, "visible", true).matches === true,
    );
    const ordered = [
      ...candidates.filter((e) => /** @type {HTMLElement} */ (e).tabIndex > 0).sort((a, b) => /** @type {HTMLElement} */ (a).tabIndex - /** @type {HTMLElement} */ (b).tabIndex),
      ...candidates.filter((e) => /** @type {HTMLElement} */ (e).tabIndex === 0),
    ];
    if (!ordered.length) return;
    const index = ordered.indexOf(from);
    const next = ordered[(index + step + ordered.length) % ordered.length] ?? ordered[0];
    /** @type {HTMLElement} */ (next).focus();
  }

  /** @param {{target: string, chars: {key: string, code: string, keyCode: number, text: string, location: number}[]}} params */
  function typeChars({ target, chars }) {
    const element = resolve(target);
    actionable(element);
    const editable = editableTarget(element);
    /** @type {HTMLElement} */ (editable).focus({ preventScroll: true });
    for (const key of chars) press({ key });
    return { resolved: describe(element), value: readValue(editable) };
  }

  // ---------- form controls ----------

  /** @param {{target: string, values: string[]}} params */
  function select({ target, values }) {
    const element = resolve(target);
    actionable(element);
    const result = state.injected.selectOptions(element, values.map((v) => ({ valueOrLabel: v })));
    if (result === "error:optionsnotfound") throw new OpError("OPTION_NOT_FOUND", `no option ${JSON.stringify(values)} in ${preview(element)}`);
    if (result === "error:optionnotenabled") throw new OpError("TARGET_DISABLED", "the option is disabled");
    if (typeof result === "string") throw new OpError("TARGET_NOT_EDITABLE", result);
    return { resolved: describe(element), value: result };
  }

  /** @param {Element} element */
  function checkedState(element) {
    const state_ = state.injected.elementState(element, "checked", true);
    if (state_.received === "error:notcheckbox") throw new OpError("TARGET_NOT_EDITABLE", `${preview(element)} is not a checkbox, radio or switch`);
    return state_.matches === true;
  }

  /** @param {{target: string, checked: boolean}} params */
  function check({ target, checked }) {
    const element = resolve(target);
    if (checkedState(element) === checked) return { resolved: describe(element), value: checked };
    const role = state.injected.utils.getAriaRole(element);
    if (!checked && (role === "radio" || (element instanceof HTMLInputElement && element.type === "radio"))) {
      throw new OpError("INVALID_PARAMS", "a radio button cannot be unchecked; check another one");
    }
    click({ target });
    const now = checkedState(element);
    if (now !== checked) throw new OpError("TARGET_NOT_EDITABLE", `clicking ${preview(element)} did not change its state`);
    return { resolved: describe(element), value: now };
  }

  /** @param {{target: string, files: {name: string, mimeType: string, buffer: string, lastModifiedMs: number}[]}} params */
  function setFiles({ target, files }) {
    const element = resolve(target);
    const input =
      element instanceof HTMLInputElement && element.type === "file"
        ? element
        : (state.injected.retarget(element, "follow-label") instanceof HTMLInputElement && state.injected.retarget(element, "follow-label").type === "file"
            ? state.injected.retarget(element, "follow-label")
            : element.querySelector("input[type=file]"));
    if (!input) throw new OpError("NO_FILE_INPUT", `no file input at ${preview(element)}`);
    const error = state.injected.setInputFiles(input, files);
    if (typeof error === "string") throw new OpError("TARGET_NOT_EDITABLE", error);
    return { resolved: describe(element), files: [.../** @type {HTMLInputElement} */ (input).files ?? []].map((f) => ({ name: f.name, size: f.size, mimeType: f.type })) };
  }

  /** What kind of control a target is, for fill_form. @param {{target: string}} params */
  function kind({ target }) {
    const element = resolve(target);
    const retargeted = state.injected.retarget(element, "follow-label") ?? element;
    const role = state.injected.utils.getAriaRole(retargeted);
    if (retargeted instanceof HTMLSelectElement) return { kind: "select", multiple: retargeted.multiple };
    if (retargeted instanceof HTMLInputElement && (retargeted.type === "checkbox" || retargeted.type === "radio")) return { kind: "checkable" };
    if (["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role)) return { kind: "checkable" };
    if (retargeted instanceof HTMLInputElement && retargeted.type === "file") return { kind: "file" };
    return { kind: "text" };
  }

  /** @param {{target: string}} params */
  function findFileInput({ target }) {
    try {
      const element = resolve(target);
      const retargeted = state.injected.retarget(element, "follow-label");
      const input = element instanceof HTMLInputElement && element.type === "file" ? element : retargeted?.type === "file" ? retargeted : element.querySelector("input[type=file]");
      return { found: Boolean(input) };
    } catch (error) {
      throw error;
    }
  }

  // ---------- scrolling ----------

  /** @param {Element} element */
  function isScrollable(element) {
    const style = getComputedStyle(element);
    const y = element.scrollHeight > element.clientHeight + 1 && /(auto|scroll|overlay)/.test(style.overflowY);
    const x = element.scrollWidth > element.clientWidth + 1 && /(auto|scroll|overlay)/.test(style.overflowX);
    return y || x;
  }

  /** @param {Element | null} element */
  function scrollContainerFor(element) {
    for (let e = element; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      if (isScrollable(e)) return e;
    }
    return /** @type {Element} */ (document.scrollingElement ?? document.documentElement);
  }

  /** @param {{target?: string, direction?: "up" | "down" | "left" | "right", amount?: number, to?: "top" | "bottom"}} params */
  function scroll({ target, direction, amount, to }) {
    let container = /** @type {Element} */ (document.scrollingElement ?? document.documentElement);
    if (target) {
      const element = resolve(target);
      if (!direction && amount === undefined && !to && !isScrollable(element)) {
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        return { intoView: describe(element), before: null, after: null, atEnd: false, scrollHeight: container.scrollHeight };
      }
      container = isScrollable(element) ? element : scrollContainerFor(element);
    }
    const before = { x: container.scrollLeft, y: container.scrollTop };
    const dir = direction ?? "down";
    if (to) container.scrollTo({ top: to === "top" ? 0 : container.scrollHeight, behavior: "instant" });
    else {
      const vertical = dir === "up" || dir === "down";
      const size = vertical ? container.clientHeight : container.clientWidth;
      const step = (amount ?? size * 0.8) * (dir === "up" || dir === "left" ? -1 : 1);
      container.scrollBy({ top: vertical ? step : 0, left: vertical ? 0 : step, behavior: "instant" });
    }
    const after = { x: container.scrollLeft, y: container.scrollTop };
    const goingDown = to ? to === "bottom" : dir === "down";
    const atEnd =
      to === "top" || dir === "up"
        ? after.y <= 0
        : dir === "left"
          ? after.x <= 0
          : dir === "right" && !to
            ? after.x + container.clientWidth >= container.scrollWidth - 1
            : goingDown && after.y + container.clientHeight >= container.scrollHeight - 1;
    return { before, after, atEnd, scrollHeight: container.scrollHeight, container: container === document.scrollingElement ? "page" : describe(container) };
  }

  /** @param {{target?: string}} params */
  function scrollMetrics({ target }) {
    const container = target ? scrollContainerFor(resolve(target)) : /** @type {Element} */ (document.scrollingElement ?? document.documentElement);
    return { scrollHeight: container.scrollHeight, y: container.scrollTop };
  }

  // ---------- reading ----------

  /** @param {{target?: string, depth?: number}} params */
  function snapshot({ target, depth }) {
    const root = target ? resolve(target) : document.body ?? document.documentElement;
    const text = state.injected.ariaSnapshot(root, { mode: "ai", ...(depth ? { depth } : {}) });
    for (const [ref, info] of state.injected._lastAriaSnapshotForQuery?.info ?? []) state.refs.set(ref, new WeakRef(info.element));
    // Child frames learn which iframe element (by its ref) they are.
    const iframes = [];
    for (const frame of root.querySelectorAll("iframe,frame")) {
      const ref = /** @type {any} */ (frame)._ariaRef?.ref;
      if (!ref) continue;
      iframes.push(ref);
      try {
        /** @type {HTMLIFrameElement} */ (frame).contentWindow?.postMessage({ __bctlProbe: ref }, "*");
      } catch {
        // detached frame
      }
    }
    return { snapshot: text, iframes };
  }

  /** @param {{target?: string, main?: boolean, links?: boolean}} params */
  function read({ target, main = false, links = true }) {
    if (!target) snapshot({});
    let root = target ? resolve(target) : document.body;
    if (!target && main) {
      const articles = [...document.querySelectorAll("article")].sort((a, b) => b.textContent.length - a.textContent.length);
      root = document.querySelector("main,[role=main]") ?? articles[0] ?? document.body;
    }
    const utils = state.injected.utils;
    /** @type {string[]} */
    const out = [];
    /** @param {string} s */
    const inline = (s) => s.replace(/\s+/g, " ");
    /** @param {Element} e */
    const visible = (e) => utils.isElementVisible(e);
    /** @param {Element} e */
    const refOf = (e) => /** @type {any} */ (e)._ariaRef?.ref;

    /** @param {Node} node @returns {string} */
    function inlineText(node) {
      if (node.nodeType === Node.TEXT_NODE) return inline(node.nodeValue ?? "");
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const e = /** @type {Element} */ (node);
      if (!visible(e) && e.localName !== "br") return "";
      const tag = e.localName;
      if (tag === "br") return "\n";
      if (tag === "img") return e.getAttribute("alt") ? `![${inline(e.getAttribute("alt") ?? "")}]` : "";
      if (tag === "script" || tag === "style" || tag === "template") return "";
      const control = controlText(e);
      if (control) return control;
      const inner = [...e.childNodes].map(inlineText).join("");
      if (tag === "a" && links && /** @type {HTMLAnchorElement} */ (e).href) {
        const label = inner.trim();
        return label ? `[${label}](${/** @type {HTMLAnchorElement} */ (e).href})` : "";
      }
      return inner;
    }

    /** @param {Element} e */
    function controlText(e) {
      const role = utils.getAriaRole(e);
      const ref = refOf(e);
      const tag = e.localName;
      if (tag === "input" || tag === "textarea" || tag === "select" || role === "checkbox" || role === "switch" || role === "radio" || role === "button") {
        const d = describe(e);
        if (tag === "button" || role === "button" || /** @type {HTMLInputElement} */ (e).type === "submit" || /** @type {HTMLInputElement} */ (e).type === "button") {
          return `[button "${d.name}"${ref ? " " + ref : ""}]`;
        }
        if (role === "checkbox" || role === "switch" || role === "radio") {
          const on = state.injected.elementState(e, "checked", true).matches === true;
          return `[${role} "${d.name}"${ref ? " " + ref : ""}: ${on ? "checked" : "unchecked"}]`;
        }
        const value = /** @type {HTMLInputElement} */ (e).type === "password" ? "••••" : readValue(e);
        return `[${role ?? tag} "${d.name}"${ref ? " " + ref : ""}: ${inline(value)}]`;
      }
      return "";
    }

    /** @param {Element} table */
    function tableText(table) {
      const rows = [...table.querySelectorAll("tr")].filter((r) => r.closest("table") === table && visible(r));
      if (!rows.length) return "";
      const lines = rows.map((r) => "| " + [...r.children].map((c) => inlineText(c).trim().replace(/\|/g, "\\|")).join(" | ") + " |");
      const width = rows[0].children.length;
      lines.splice(1, 0, "|" + " --- |".repeat(Math.max(1, width)));
      return lines.join("\n");
    }

    const BLOCKS = new Set(["p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "form", "fieldset", "figure", "figcaption", "blockquote", "dl", "dt", "dd", "details", "summary", "li", "ul", "ol", "table", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "body", "iframe"]);

    /** @param {Element} e @param {number} listDepth */
    function block(e, listDepth) {
      if (!visible(e)) return;
      const tag = e.localName;
      if (/^h[1-6]$/.test(tag)) {
        out.push("#".repeat(Number(tag[1])) + " " + inlineText(e).trim());
        return;
      }
      if (tag === "table") {
        out.push(tableText(e));
        return;
      }
      if (tag === "pre") {
        out.push("```\n" + (e.textContent ?? "") + "\n```");
        return;
      }
      if (tag === "hr") {
        out.push("---");
        return;
      }
      if (tag === "iframe" || tag === "frame") {
        const ref = refOf(e);
        out.push(`[frame${ref ? " " + ref : ""}]`);
        return;
      }
      if (tag === "ul" || tag === "ol") {
        let n = 0;
        for (const child of e.children) {
          if (child.localName !== "li" || !visible(child)) continue;
          n++;
          const own = [...child.childNodes].filter((c) => !(c.nodeType === Node.ELEMENT_NODE && /^(ul|ol)$/.test(/** @type {Element} */ (c).localName)));
          const line = own.map(inlineText).join("").trim();
          out.push("  ".repeat(listDepth) + (tag === "ol" ? `${n}. ` : "- ") + line);
          for (const nested of child.children) if (/^(ul|ol)$/.test(nested.localName)) block(nested, listDepth + 1);
        }
        return;
      }
      // A block with only inline content becomes one paragraph; otherwise recurse.
      const hasBlockChild = [...e.children].some((c) => BLOCKS.has(c.localName));
      if (!hasBlockChild) {
        const text = inlineText(e).trim();
        if (text) out.push(text);
        return;
      }
      let pending = "";
      for (const child of e.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE && BLOCKS.has(/** @type {Element} */ (child).localName)) {
          if (pending.trim()) out.push(pending.trim());
          pending = "";
          block(/** @type {Element} */ (child), listDepth);
        } else pending += inlineText(child);
      }
      if (pending.trim()) out.push(pending.trim());
    }

    block(root, 0);
    const text = out.filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n");
    return { text };
  }

  /** @param {{text: string}} params */
  function findText({ text }) {
    const body = document.body;
    if (!body || !(body.innerText ?? "").includes(text)) return { found: false };
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if ((node.nodeValue ?? "").includes(text) && node.parentElement && state.injected.utils.isElementVisible(node.parentElement)) {
        return { found: true, element: describe(node.parentElement) };
      }
    }
    return { found: true, element: null };
  }

  /** @param {{target: string}} params */
  function elementStateOf({ target }) {
    let element;
    try {
      element = resolve(target);
    } catch (error) {
      if (/** @type {any} */ (error).code === "TARGET_NOT_FOUND" || /** @type {any} */ (error).code === "REF_NOT_FOUND") return { state: "detached" };
      throw error;
    }
    const visible = state.injected.elementState(element, "visible", true).matches === true;
    return { state: visible ? "visible" : "hidden", element: describe(element) };
  }

  // ---------- plumbing for other lanes ----------

  /** @param {{target: string}} params */
  function mark({ target }) {
    const element = resolve(target);
    const nonce = Math.random().toString(36).slice(2, 12);
    element.setAttribute(MARK, nonce);
    return { nonce, resolved: describe(element) };
  }

  /** @param {{nonce: string}} params */
  function unmark({ nonce }) {
    for (const element of document.querySelectorAll(`[${MARK}="${nonce}"]`)) element.removeAttribute(MARK);
    return {};
  }

  /** @param {{target: string}} params */
  function box({ target }) {
    const element = resolve(target);
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: devicePixelRatio, resolved: describe(element) };
  }

  function info() {
    return {
      url: location.href,
      title: document.title,
      visibility: document.visibilityState,
      frameId: state.frameId,
      mutations: state.mutations,
      probe: state.probe,
      scrollY,
    };
  }

  /** @param {{alert: string, confirm: string, prompt: string, promptText?: string, scope?: string}} policy */
  function armDialogs(policy) {
    document.documentElement.dataset.bctlDialogPolicy = JSON.stringify(policy);
    return { armed: true };
  }

  /** @param {{since?: number}} params */
  function dialogLog({ since = 0 }) {
    let log = [];
    try {
      log = JSON.parse(document.documentElement.dataset.bctlDialogLog ?? "[]");
    } catch {
      log = [];
    }
    return { dialogs: log.filter((/** @type {any} */ d) => d.seq > since) };
  }

  /** @param {{delta: number}} params */
  function historyGo({ delta }) {
    history.go(delta);
    return { length: history.length };
  }

  /** @type {Record<string, (params: any) => object>} */
  const ops = {
    historyGo,
    info,
    snapshot,
    read,
    click,
    hover,
    fill,
    typeChars,
    press,
    select,
    check,
    setFiles,
    findFileInput,
    kind,
    scroll,
    scrollMetrics,
    findText,
    elementState: elementStateOf,
    mark,
    unmark,
    box,
    armDialogs,
    dialogLog,
    actionable: ({ target, enabled }) => {
      const element = resolve(target);
      actionable(element, { enabled });
      return { resolved: describe(element) };
    },
  };

  g.__bctlRuntime = {
    get ready() {
      return state.ready;
    },
    init,
    /** @param {string} op @param {any[]} args */
    call(op, args) {
      const fn = ops[op];
      if (!fn) return { ok: false, code: "UNKNOWN_OP", message: op };
      try {
        return { ok: true, ...fn(args?.[0] ?? {}) };
      } catch (error) {
        const e = /** @type {any} */ (error);
        return { ok: false, code: e.code ?? "RUNTIME_ERROR", message: String(e.message ?? e).slice(0, 500), ...(e.extra ?? {}) };
      }
    },
  };
})();
