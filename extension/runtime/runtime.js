// @ts-check
// DOM-lane runtime: runs in the extension's isolated world of each frame, on top of Playwright's
// injected script (generated/pw-injected.js). Every operation returns {ok: true, ...} or
// {ok: false, code, message}; nothing throws out (specs/dom-lane.md). The daemon polls; nothing
// here waits on page timers, which are throttled in background tabs (specs/settle.md).
(() => {
  const g = /** @type {any} */ (globalThis);
  if (g.__bctlRuntime) return;

  // Closed shadow roots, through the extension's chrome.dom, as `shadowRoot` in this isolated world
  // only: Playwright's engines and this runtime walk them like open ones; the page sees nothing.
  // Only custom elements are asked: asking for every element cost 30% of a large snapshot
  // (specs/dom-lane.md).
  const openOrClosed = g.chrome?.dom?.openOrClosedShadowRoot;
  const nativeShadowRoot = Object.getOwnPropertyDescriptor(Element.prototype, "shadowRoot")?.get;
  if (openOrClosed && nativeShadowRoot) {
    Object.defineProperty(Element.prototype, "shadowRoot", {
      configurable: true,
      get() {
        const open = nativeShadowRoot.call(this);
        if (open || !this.localName.includes("-")) return open;
        try {
          return openOrClosed(this);
        } catch {
          return null;
        }
      },
    });
  }

  const REF = /^(f\d+)?e\d+$/;
  const FOCUSABLE = "a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable]:not([contenteditable=false])";
  const MARK = "data-bctl-target";

  /** @type {{injected: any, frameId: number, refs: Map<string, WeakRef<Element>>, mutations: number, content: number, structure: number, probe: string | null, ready: boolean}} */
  const state = { injected: null, frameId: 0, refs: new Map(), mutations: 0, content: 0, structure: 0, probe: null, ready: false };

  class OpError extends Error {
    /** @param {string} code @param {string} message @param {object} [extra] */
    constructor(code, message, extra) {
      super(message);
      this.code = code;
      this.extra = extra;
    }
  }

  // ---------- setup ----------

  /**
   * @param {number} frameId
   * @param {number} refBase the tab's highest ref number so far: this document numbers after it (specs/targets.md)
   */
  function init(frameId, refBase = 0) {
    if (state.ready) return { ok: true, frameId: state.frameId };
    g.__bctlRefCounter.raise(refBase);
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
        // content: nodes and text, what settle waits on; structure: nodes, what hydration does
        // (specs/settle.md, tools/snapshot.md). Attribute churn counts in neither.
        if (record.type !== "attributes") state.content++;
        if (record.type === "childList") state.structure++;
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    addEventListener("message", (event) => {
      const data = event.data;
      if (data && typeof data === "object" && typeof data.__bctlProbe === "string" && event.source === parent) state.probe = data.__bctlProbe;
    });
    state.ready = true;
    return { ok: true, frameId };
  }

  /** @typedef {{key: string, code: string, keyCode: number, text: string, location: number}} KeyDescription */

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

  /** Every element a selector matches (a ref gives one). @param {string} target @returns {Element[]} */
  function resolveAll(target) {
    if (typeof target !== "string" || !target) throw new OpError("INVALID_TARGET", "target must be a non-empty string");
    if (REF.test(target)) return [resolve(target)];
    try {
      return state.injected.querySelectorAll(state.injected.parseSelector(target), document);
    } catch (error) {
      throw new OpError("INVALID_TARGET", String(/** @type {any} */ (error).message ?? error));
    }
  }

  /** One element, strictly: a ref, or a selector that matches exactly one. @param {string} target */
  function resolve(target) {
    if (typeof target === "string" && REF.test(target)) {
      const element = state.refs.get(target)?.deref();
      if (!element || !element.isConnected) throw new OpError("REF_NOT_FOUND", `${target} is not in this page any more`);
      return element;
    }
    const all = resolveAll(target);
    if (all.length === 0) throw new OpError("TARGET_NOT_FOUND", `nothing matches ${target}`);
    if (all.length > 1) {
      throw new OpError("AMBIGUOUS_TARGET", `${target} matches ${all.length} elements`, {
        count: all.length,
        candidates: all.slice(0, 5).map(preview),
      });
    }
    return all[0];
  }

  /**
   * Where a pointer action lands: the centre of the element's first box, so a link that wraps is
   * hit on its first line, or of its contents' first box for an element without boxes of its own
   * (display: contents) (specs/tools/click.md).
   * @param {Element} element
   */
  function clickPoint(element) {
    let rects = [...element.getClientRects()];
    if (!rects.length) {
      const range = document.createRange();
      range.selectNodeContents(element);
      rects = [...range.getClientRects()];
    }
    const box = rects.find((r) => r.width > 0 && r.height > 0) ?? rects[0] ?? element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }

  /** @param {{x: number, y: number}} p */
  const inViewport = (p) => p.x >= 0 && p.y >= 0 && p.x < innerWidth && p.y < innerHeight;

  /**
   * Scrolls an element into view; one without boxes of its own (display: contents) through its
   * first descendant that has boxes, or its parent.
   * @param {Element} element @param {ScrollLogicalPosition} align
   */
  function scrollToElement(element, align) {
    const box = element.getClientRects().length ? element : ([...element.querySelectorAll("*")].find((e) => e.getClientRects().length) ?? element.parentElement ?? element);
    box.scrollIntoView({ block: align, inline: align, behavior: "instant" });
  }

  // A retry after a failed check scrolls with the next alignment, as Playwright does, so an
  // element under a sticky header comes out from under it (specs/tools/click.md).
  /** @type {ScrollLogicalPosition[]} */
  const RETRY_ALIGNMENTS = ["end", "center", "start"];

  /**
   * One actionability check (the daemon polls). Returns the element that pointer events go to:
   * the target, or for text inside a control, the control (Playwright's "button-link" retarget).
   * @param {Element} element
   * @param {{enabled?: boolean, scroll?: "auto" | "center" | "none", attempt?: number}} [options]
   * @returns {{point: {x: number, y: number}, element: Element}}
   */
  function actionable(element, { enabled = true, scroll = "auto", attempt = 1 } = {}) {
    const injected = state.injected;
    if (!element.isConnected) throw new OpError("REF_NOT_FOUND", "the element left the page");
    if (injected.elementState(element, "visible", true).matches !== true) throw new OpError("TARGET_HIDDEN", preview(element));
    if (enabled && injected.elementState(element, "enabled", true).matches !== true) throw new OpError("TARGET_DISABLED", preview(element));
    if (injected.elementState(element, "non-inert", true).matches !== true) throw new OpError("TARGET_DISABLED", `${preview(element)} is inert`);
    let point = clickPoint(element);
    if (scroll === "center" || (scroll === "auto" && !inViewport(point))) {
      scrollToElement(element, "center");
      point = clickPoint(element);
    } else if (scroll === "auto" && attempt > 1) {
      scrollToElement(element, RETRY_ALIGNMENTS[(attempt - 2) % RETRY_ALIGNMENTS.length]);
      point = clickPoint(element);
    } else if (scroll === "none" && !inViewport(point)) {
      throw new OpError("TARGET_OUTSIDE_VIEWPORT", `${preview(element)} is outside the viewport`);
    }
    const receiver = injected.retarget(element, "button-link") ?? element;
    const hit = injected.expectHitTarget(point, receiver);
    if (hit !== "done") throw new OpError("TARGET_COVERED", hit?.hitTargetDescription ?? String(hit));
    return { point, element: deepestAt(point, receiver) };
  }

  /**
   * The element a real pointer would hit at `point` (through open shadow roots), when it is the
   * receiver or inside it; otherwise the receiver.
   * @param {{x: number, y: number}} point @param {Element} receiver
   */
  function deepestAt(point, receiver) {
    let hit = document.elementFromPoint(point.x, point.y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(point.x, point.y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    for (let node = hit; node; node = /** @type {any} */ (node).assignedSlot ?? node.parentElement ?? /** @type {any} */ (node.getRootNode()).host) {
      if (node === receiver) return /** @type {Element} */ (hit);
    }
    return receiver;
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

  /** @param {{target: string, button?: "left" | "middle" | "right", doubleClick?: boolean, modifiers?: string[], scroll?: "auto" | "center" | "none", attempt?: number}} params */
  function click({ target, ...options }) {
    const element = resolve(target);
    clickElement(element, options);
    return { resolved: describe(element) };
  }

  /**
   * @param {Element} target
   * @param {{button?: "left" | "middle" | "right", doubleClick?: boolean, modifiers?: string[], scroll?: "auto" | "center" | "none", attempt?: number}} options
   */
  function clickElement(target, { button = "left", doubleClick = false, modifiers = [], scroll = "auto", attempt = 1 }) {
    const { point, element } = actionable(target, { scroll, attempt });
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
  }

  /** @param {{target: string, scroll?: "auto" | "center" | "none", attempt?: number}} params */
  function hover({ target, scroll = "auto", attempt = 1 }) {
    const hovered = resolve(target);
    const { point, element } = actionable(hovered, { enabled: false, scroll, attempt });
    hoverEvents(element, point);
    return { resolved: describe(hovered) };
  }

  // ---------- text entry ----------

  // Elements typed into, for the second read of editors that render later (specs/tools/type.md, step 6).
  /** @type {Map<string, WeakRef<Element>>} */
  const typedInto = new Map();

  /** A token for a second read of a contenteditable field, or null for other fields. @param {Element} element */
  function readBackToken(element) {
    if (!(/** @type {HTMLElement} */ (element).isContentEditable)) return null;
    const token = Math.random().toString(36).slice(2, 12);
    if (typedInto.size > 50) typedInto.clear();
    typedInto.set(token, new WeakRef(element));
    return token;
  }

  /** @param {{token: string}} params */
  function readBack({ token }) {
    const element = typedInto.get(token)?.deref();
    typedInto.delete(token);
    if (!element || !element.isConnected) throw new OpError("REF_NOT_FOUND", "the editor replaced the field");
    return { value: readValue(element) };
  }

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

  /** @param {{target: string, value: string, scroll?: "auto" | "center" | "none", attempt?: number}} params */
  function fill({ target, value, scroll = "auto", attempt = 1 }) {
    const element = resolve(target);
    const resolved = describe(element);
    actionable(element, { scroll, attempt });
    let result;
    try {
      result = state.injected.fill(element, value);
    } catch (error) {
      throw new OpError("TARGET_NOT_EDITABLE", String(/** @type {any} */ (error).message ?? error));
    }
    if (result === "error:notconnected") throw new OpError("REF_NOT_FOUND", "the element left the page");
    const editable = editableTarget(element);
    if (result === "done") return { resolved, value: readValue(editable), via: "value" };
    // clearing a field that is already empty sends no events (specs/tools/type.md, step 3)
    if (value === "" && readValue(editable) === "") return { resolved, value: "", via: "none" };
    /** @type {HTMLElement} */ (editable).focus({ preventScroll: true });
    if (/** @type {HTMLElement} */ (editable).isContentEditable) {
      document.execCommand("selectAll");
      if (value === "") document.execCommand("delete");
      else document.execCommand("insertText", false, value);
      return { resolved, value: readValue(editable), via: "execCommand", readBack: readBackToken(editable) };
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
   * @param {{target?: string, key: KeyDescription, modifierKeys?: KeyDescription[]}} params
   */
  function press({ target, key, modifierKeys = [] }) {
    let element = target ? resolve(target) : document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    if (target) {
      actionable(element, { enabled: false });
      focusIfFocusable(element);
    }
    element = /** @type {Element} */ (document.activeElement && element.contains(document.activeElement) ? document.activeElement : element);
    const focused = describe(element);
    /** @param {string} type @param {KeyDescription} k @param {string[]} held */
    const keyEvent = (type, k, held, extra = {}) =>
      element.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode, location: k.location, repeat: false, ...modifierFlags(held), ...extra }));
    const modifiers = modifierKeys.map((m) => m.key);
    modifierKeys.forEach((m, i) => keyEvent("keydown", m, modifiers.slice(0, i + 1)));
    const flags = modifierFlags(modifiers);
    const allowed = keyEvent("keydown", key, modifiers);
    const typing = key.text && !flags.ctrlKey && !flags.metaKey && !flags.altKey;
    let defaultAction = null;
    if (!allowed) defaultAction = "prevented";
    else {
      if (typing) keyEvent("keypress", key, modifiers, { charCode: key.text.charCodeAt(0) });
      defaultAction = defaultKeyAction(element, key, flags, Boolean(typing));
    }
    keyEvent("keyup", key, modifiers);
    for (let i = modifierKeys.length - 1; i >= 0; i--) keyEvent("keyup", modifierKeys[i], modifiers.slice(0, i));
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
      // Chrome's legacy text event comes first; React's onBeforeInput listens to it, and cancelling it cancels the insertion.
      const textInput = /** @type {any} */ (document.createEvent("TextEvent"));
      textInput.initTextEvent("textInput", true, true, window, key.text);
      if (!element.dispatchEvent(textInput)) return "prevented";
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
    return { resolved: describe(element), value: readValue(editable), readBack: readBackToken(editable) };
  }

  // ---------- form controls ----------

  /** @param {{target: string, values: string[], scroll?: "auto" | "center" | "none", attempt?: number}} params */
  function select({ target, values, scroll = "auto", attempt = 1 }) {
    const element = resolve(target);
    actionable(element, { scroll, attempt });
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

  /**
   * The element a check clicks: the control of a label target when it is visible, so a link inside
   * the label is not followed; otherwise the target (specs/tools/fill_form.md).
   * @param {Element} element
   */
  function checkReceiver(element) {
    const control = state.injected.retarget(element, "follow-label");
    return control && control !== element && state.injected.elementState(control, "visible", true).matches === true ? control : element;
  }

  /** @param {{target: string, checked: boolean, scroll?: "auto" | "center" | "none", attempt?: number}} params */
  function check({ target, checked, scroll = "auto", attempt = 1 }) {
    const element = resolve(target);
    if (checkedState(element) === checked) return { resolved: describe(element), value: checked };
    clickElement(checkReceiver(element), { scroll, attempt });
    const now = checkedState(element);
    if (now !== checked) throw new OpError("TARGET_NOT_EDITABLE", `clicking ${preview(element)} did not change its state`);
    return { resolved: describe(element), value: now };
  }

  /** The file input of a target: itself, the control of its label, or one inside it. @param {Element} element */
  function fileInputOf(element) {
    if (element instanceof HTMLInputElement && element.type === "file") return element;
    const control = state.injected.retarget(element, "follow-label");
    if (control instanceof HTMLInputElement && control.type === "file") return control;
    return element.querySelector("input[type=file]");
  }

  /** @param {{target: string, files: {name: string, mimeType: string, buffer: string, lastModifiedMs: number}[]}} params */
  function setFiles({ target, files }) {
    const element = resolve(target);
    const input = fileInputOf(element);
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
    if ((retargeted instanceof HTMLInputElement && (retargeted.type === "checkbox" || retargeted.type === "radio")) || CHECKABLE_ROLES.includes(role ?? "")) {
      return {
        kind: "checkable",
        nativeRadio: retargeted instanceof HTMLInputElement && retargeted.type === "radio",
        checked: checkedState(element),
        viaControl: checkReceiver(element) !== element,
      };
    }
    if (retargeted instanceof HTMLInputElement && retargeted.type === "file") return { kind: "file" };
    return { kind: "text" };
  }

  /** @param {{target: string}} params */
  function findFileInput({ target }) {
    return { found: Boolean(fileInputOf(resolve(target))) };
  }

  // Roles that carry aria-checked, as Playwright's kAriaCheckedRoles.
  const CHECKABLE_ROLES = ["checkbox", "menuitemcheckbox", "option", "radio", "switch", "menuitemradio", "treeitem"];

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

  /**
   * Like querySelectorAll, but also inside open shadow roots (web components keep embedded frames there).
   * @param {ParentNode} root @param {string} selector @returns {Element[]}
   */
  function deepQueryAll(root, selector) {
    /** @type {Element[]} */
    const found = [...root.querySelectorAll(selector)];
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) found.push(...deepQueryAll(el.shadowRoot, selector));
    return found;
  }

  // ---------- snapshot facts (specs/tools/snapshot.md, step 4) ----------

  const INTERACTIVE = new Set(["link", "button", "menuitem", "tab", "checkbox", "radio", "switch", "option", "textbox", "combobox", "slider", "spinbutton", "searchbox"]);
  const TYPED = new Set(["email", "password", "number", "tel", "url", "date", "time", "datetime-local", "month", "week", "color"]);
  const NO_VALUE_TYPES = new Set(["checkbox", "radio", "file", "submit", "button", "reset", "image", "color", "range", "hidden"]);
  const VALUED = new Set(["slider", "spinbutton", "progressbar", "meter", "scrollbar"]);
  const MAX_TEXT_FACTS = 300;
  const FIELDS = new Set(["textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton"]);

  /** Fact text: one line, no quotes or braces, at most `max` characters. @param {string} text @param {number} max */
  function factText(text, max) {
    const clean = text.replace(/\s+/g, " ").replace(/["'`{}]/g, "").replace(/:(\s|$)/g, " -$1").replace(/\s#/g, " ").trim();
    return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
  }

  /** @param {Element | null} e */
  const isVisible = (e) => !!e && state.injected.utils.isElementVisible(e);

  /**
   * Visible text nodes under `root` with at least `letters` letters, in document order, skipping `skip`.
   * @param {Element} root @param {number} letters @param {Element | null} skip @param {boolean} last
   */
  function visibleText(root, letters, skip, last) {
    if ((root.textContent ?? "").length > 20000) return "";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const pattern = new RegExp(`(\\p{L}.*){${letters}}`, "u");
    let found = "";
    for (let node = walker.nextNode(), seen = 0; node && seen < 400; node = walker.nextNode(), seen++) {
      const parent = node.parentElement;
      if (!parent || (skip && skip.contains(parent))) continue;
      const text = (node.nodeValue ?? "").trim();
      if (!pattern.test(text) || !isVisible(parent)) continue;
      found = text;
      if (!last) break;
    }
    return found;
  }

  /** The closest visible text before an unnamed control. @param {Element} element */
  function nearText(element) {
    /** @type {Element | null} */
    let node = element;
    for (let up = 0; up < 4 && node && node !== document.body; up++, node = node.parentElement) {
      let sibling = node.previousElementSibling;
      for (let n = 0; sibling && n < 3; n++, sibling = sibling.previousElementSibling) {
        const text = visibleText(sibling, 2, null, true);
        if (text) return factText(text, 60);
      }
    }
    return "";
  }

  const HEADINGS = "h1,h2,h3,h4,h5,h6,[role=heading]";
  const ITEMS = "article,li,tr,section,fieldset,[role=article],[role=listitem],[role=row],[role=comment],[role=region],[role=group]";

  /** First visible text under `box` with 3 letters, outside `element`, other than `name`. @param {Element} box @param {Element} element @param {string} name */
  function firstText(box, element, name) {
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(), seen = 0; node && seen < 400; node = walker.nextNode(), seen++) {
      const parent = node.parentElement;
      const text = (node.nodeValue ?? "").trim();
      if (!parent || element.contains(parent) || text === name || !/(\p{L}.*){3}/u.test(text) || !isVisible(parent)) continue;
      return text;
    }
    return "";
  }

  /**
   * The closest heading before `element`: previous siblings (and what they hold) from the nearest
   * one, then up through ancestors, and from the top of a shadow root on to its host. Headings
   * inside other components' shadow roots are not seen (querySelectorAll does not enter them).
   * @param {Element} element
   */
  function headingBefore(element) {
    /** @type {Element | null} */
    let node = element;
    for (let steps = 0; node && node !== document.body && steps < 2000; steps++) {
      for (let sibling = node.previousElementSibling; sibling && steps < 2000; sibling = sibling.previousElementSibling, steps++) {
        if (sibling.matches(HEADINGS)) return sibling;
        const inside = sibling.querySelectorAll(HEADINGS);
        if (inside.length) return inside[inside.length - 1];
      }
      const root = node.getRootNode();
      node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }
    return null;
  }

  /**
   * What tells one of several look-alike controls apart: "in heading" for a heading's anchor; else
   * the first text of the closest item-like container (article, row, list item, section) that holds
   * only this one of them; else of the highest such ancestor; else the closest heading before it.
   * @param {Element} element @param {Element[]} alike @param {string} name
   */
  function contextText(element, alike, name) {
    if (element.closest(HEADINGS)) return "in heading";
    /** @type {Element | null} */
    let own = null;
    /** @type {Element | null} */
    let item = null;
    for (let e = element.parentElement, up = 0; e && e !== document.body && up < 10; e = e.parentElement, up++) {
      if (alike.some((other) => other !== element && e.contains(other))) break;
      own = e;
      if (!item && e.matches(ITEMS)) item = e;
    }
    for (const box of [item, own]) {
      const text = box ? firstText(box, element, name) : "";
      if (text) return factText(text, 50);
    }
    const before = headingBefore(element);
    const heading = before ? (before.textContent ?? "").trim() : "";
    return heading ? factText(heading, 50) : "";
  }

  /** The element that blocks the rest of the page, or null. */
  function findModal() {
    const dialogs = deepQueryAll(document, "dialog").filter((d) => /** @type {HTMLDialogElement} */ (d).open && d.matches(":modal"));
    if (dialogs.length) return dialogs[dialogs.length - 1];
    const marked = deepQueryAll(document, '[aria-modal="true"]').filter(isVisible);
    if (marked.length) return marked[marked.length - 1];
    const total = document.getElementsByTagName("*").length;
    for (let e = document.elementFromPoint(innerWidth / 2, innerHeight / 2); e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const style = getComputedStyle(e);
      if (style.position !== "fixed" || style.pointerEvents === "none") continue;
      const rect = e.getBoundingClientRect();
      if (rect.width < innerWidth * 0.6 || rect.height < innerHeight * 0.6) continue;
      if (!e.querySelector("dialog,[role=dialog],[role=alertdialog],input,textarea,select,button,[role=button],iframe")) continue;
      if (e.getElementsByTagName("*").length * 2 >= total) continue;
      return e;
    }
    return null;
  }

  /**
   * Facts per ref, refless interactive nodes in tree order, and the modal layer.
   * @param {any} tree Playwright's aria tree of the last snapshot @param {string} text its rendering
   */
  function snapshotFacts(tree, text) {
    const listed = new Set([...text.matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)].map((m) => m[1]));
    /** @type {Record<string, string[]>} */
    const facts = {};
    /** @param {string} ref @param {string} fact */
    const add = (ref, fact) => (facts[ref] ??= []).push(fact);
    /** @type {Map<string, {element: Element, ref: string}[]>} */
    const alike = new Map();
    let textFacts = 0;
    for (const [ref, { element }] of tree.info) {
      const role = element._ariaRef?.role ?? "";
      const name = element._ariaRef?.name ?? "";
      if (element instanceof HTMLInputElement) {
        if (TYPED.has(element.type)) add(ref, `[type=${element.type}]`);
        if (!NO_VALUE_TYPES.has(element.type) && element.value === "") add(ref, "[empty]");
      } else if (element instanceof HTMLTextAreaElement) {
        if (element.value === "") add(ref, "[empty]");
      } else if (/** @type {HTMLElement} */ (element).isContentEditable && ["textbox", "searchbox", "combobox"].includes(role) && !(element.textContent ?? "").trim()) {
        add(ref, "[empty]");
      }
      if (VALUED.has(role) && !(element instanceof HTMLInputElement)) {
        const native = element instanceof HTMLProgressElement || element instanceof HTMLMeterElement ? String(element.value) : null;
        const value = element.getAttribute("aria-valuetext") ?? element.getAttribute("aria-valuenow") ?? native;
        if (value) add(ref, `[value=${factText(value, 30)}]`);
      }
      if (!INTERACTIVE.has(role)) continue;
      if (!name) {
        if (FIELDS.has(role) && textFacts < MAX_TEXT_FACTS) {
          const near = nearText(element);
          if (near) add(ref, `[near="${near}"]`), textFacts++;
        }
      } else {
        const key = role + "\u0000" + name;
        alike.set(key, [...(alike.get(key) ?? []), { element, ref }]);
      }
    }
    for (const [key, members] of alike) {
      if (members.length < 2) continue;
      const name = key.split("\u0000")[1];
      const elements = members.map((m) => m.element);
      for (const { element, ref } of members) {
        if (textFacts >= MAX_TEXT_FACTS) break;
        const ctx = contextText(element, elements, name);
        if (ctx) add(ref, `[ctx="${ctx}"]`), textFacts++;
      }
    }
    /** @type {{role: string, name: string, reason: string}[]} */
    const refless = [];
    /** @param {any} node */
    const walk = (node) => {
      for (const child of node.children ?? []) {
        if (typeof child === "string") continue;
        if (!child.ref && INTERACTIVE.has(child.role)) refless.push({ role: child.role, name: child.name ?? "", reason: child.box?.visible === false ? "[hidden]" : "[no-pointer-events]" });
        walk(child);
      }
    };
    walk(tree.root);
    /** @type {{ref: string | null, role: string, name: string} | null} */
    let modal = null;
    const layer = findModal();
    if (layer) {
      // the layer itself is often an unnamed wrapper Playwright leaves out; point at its first listed element
      let ref = null;
      for (const [r, { element }] of tree.info) {
        if ((element === layer || layer.contains(element)) && listed.has(r)) {
          ref = r;
          break;
        }
      }
      // an unnamed backdrop around a dialog: name the dialog
      const inner = ref ? tree.info.get(ref)?.element : null;
      const named = state.injected.utils.getAriaRole(layer) ? layer : inner && ["dialog", "alertdialog"].includes(state.injected.utils.getAriaRole(inner)) ? inner : null;
      const d = named ? describe(named) : { role: "layer", name: describe(layer).name };
      modal = { ref, role: d.role, name: d.name };
      if (ref) add(ref, "[modal]");
    }
    return { facts, refless, modal };
  }

  /**
   * Visible canvases big enough to hold content (not icons), for the snapshot's notice line
   * (specs/tools/snapshot.md).
   */
  function drawnAreas() {
    const sizes = deepQueryAll(document, "canvas")
      .filter((c) => state.injected.utils.isElementVisible(c))
      .map((c) => c.getBoundingClientRect())
      .filter((r) => r.width >= 100 && r.height >= 50)
      .sort((a, b) => b.width * b.height - a.width * a.height);
    return sizes.length ? { count: sizes.length, largest: `${Math.round(sizes[0].width)}x${Math.round(sizes[0].height)}` } : null;
  }

  /** @param {{target?: string, depth?: number}} params */
  function snapshot({ target, depth }) {
    const root = target ? resolve(target) : document.body ?? document.documentElement;
    // Chrome's PDF viewer is another extension's page: nothing of the PDF is in this document
    const pdf = document.contentType === "application/pdf";
    const text = state.injected.ariaSnapshot(root, { mode: "ai", ...(depth ? { depth } : {}) });
    const tree = state.injected._lastAriaSnapshotForQuery;
    for (const [ref, info] of tree?.info ?? []) state.refs.set(ref, new WeakRef(info.element));
    // Child frames learn which iframe element (by its ref) they are.
    const iframes = [];
    for (const frame of deepQueryAll(root, "iframe,frame")) {
      const ref = /** @type {any} */ (frame)._ariaRef?.ref;
      if (!ref) continue;
      iframes.push(ref);
      try {
        /** @type {HTMLIFrameElement} */ (frame).contentWindow?.postMessage({ __bctlProbe: ref }, "*");
      } catch {
        // detached frame
      }
    }
    /** @type {{facts: Record<string, string[]>, refless: {role: string, name: string, reason: string}[], modal: {ref: string | null, role: string, name: string} | null}} */
    let extra = { facts: {}, refless: [], modal: null };
    try {
      if (tree) extra = snapshotFacts(tree, text);
    } catch {
      // facts are extra; the snapshot itself stands without them
    }
    return { snapshot: text, iframes, ...extra, pdf, canvas: target ? null : drawnAreas() };
  }

  /** @param {{target?: string, main?: boolean, links?: boolean}} params */
  function read({ target, main = false, links = true }) {
    if (document.contentType === "application/pdf") return { text: "", pdf: true };
    if (!target) snapshot({});
    const body = document.body ?? document.documentElement;
    let root = target ? resolve(target) : body;
    if (!target && main) {
      const articles = [...document.querySelectorAll("article")].sort((a, b) => b.textContent.length - a.textContent.length);
      root = document.querySelector("main,[role=main]") ?? articles[0] ?? body;
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
    /**
     * The nodes that render inside `e`: a host's shadow tree, a slot's assigned nodes (its own
     * children when nothing is assigned), else its children (specs/tools/read.md).
     * @param {Element} e @returns {Node[]}
     */
    const rendered = (e) => {
      if (e.shadowRoot) return [...e.shadowRoot.childNodes];
      if (e instanceof HTMLSlotElement) {
        const assigned = e.assignedNodes({ flatten: true });
        if (assigned.length) return assigned;
      }
      return [...e.childNodes];
    };
    /** @param {Element} e */
    const renderedElements = (e) => /** @type {Element[]} */ (rendered(e).filter((n) => n.nodeType === Node.ELEMENT_NODE));

    /** @param {Node} node @returns {string} */
    function inlineText(node) {
      if (node.nodeType === Node.TEXT_NODE) return inline(node.nodeValue ?? "");
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const e = /** @type {Element} */ (node);
      // a slot has no box (display: contents); the nodes it shows are checked themselves
      if (!visible(e) && e.localName !== "br" && !(e instanceof HTMLSlotElement)) return "";
      const tag = e.localName;
      if (tag === "br") return "\n";
      if (tag === "img") return e.getAttribute("alt") ? `![${inline(e.getAttribute("alt") ?? "")}]` : "";
      if (tag === "script" || tag === "style" || tag === "template") return "";
      const control = controlText(e);
      if (control) return control;
      const inner = rendered(e).map(inlineText).join("");
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

    /** A block of its own, or a component whose shadow tree holds blocks. @param {Element} e @returns {boolean} */
    const isBlock = (e) => BLOCKS.has(e.localName) || Boolean(e.shadowRoot && renderedElements(e).some(isBlock));

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
        for (const child of renderedElements(e)) {
          if (child.localName !== "li" || !visible(child)) continue;
          n++;
          const own = rendered(child).filter((c) => !(c.nodeType === Node.ELEMENT_NODE && /^(ul|ol)$/.test(/** @type {Element} */ (c).localName)));
          const line = own.map(inlineText).join("").trim();
          out.push("  ".repeat(listDepth) + (tag === "ol" ? `${n}. ` : "- ") + line);
          for (const nested of renderedElements(child)) if (/^(ul|ol)$/.test(nested.localName)) block(nested, listDepth + 1);
        }
        return;
      }
      // A block with only inline content becomes one paragraph; otherwise recurse.
      const hasBlockChild = renderedElements(e).some(isBlock);
      if (!hasBlockChild) {
        const text = inlineText(e).trim();
        if (text) out.push(text);
        return;
      }
      let pending = "";
      for (const child of rendered(e)) {
        if (child.nodeType === Node.ELEMENT_NODE && isBlock(/** @type {Element} */ (child))) {
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

  // ---------- get (specs/tools/get.md) ----------

  /** @param {Element} element @param {string} what @param {string | undefined} name @param {number} maxChars */
  function readOne(element, what, name, maxChars) {
    /** @param {string} text */
    const capped = (text) => (text.length > maxChars ? { value: text.slice(0, maxChars), cut: text.length - maxChars } : { value: text, cut: 0 });
    const injected = state.injected;
    if (what === "text") {
      const rendered = isVisible(element) ? /** @type {HTMLElement} */ (element).innerText : null;
      return capped(rendered ?? element.textContent ?? "");
    }
    if (what === "html") return capped(element.outerHTML);
    if (what === "attribute") return { value: element.getAttribute(/** @type {string} */ (name)), cut: 0 };
    if (what === "property") {
      /** @type {any} */
      let value = element;
      for (const step of /** @type {string} */ (name).split(".")) {
        if (value === null || value === undefined) break;
        value = value[step];
      }
      if (value === undefined || typeof value === "function") value = null;
      else if (value !== null && typeof value === "object") {
        // plain objects and arrays as JSON; DOM objects (validity, classList, elements) as their toString()
        const plain = Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
        try {
          value = plain ? JSON.parse(JSON.stringify(value)) : String(value);
        } catch {
          value = String(value);
        }
      }
      return { value, cut: 0 };
    }
    if (what === "value") {
      if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) return { value: element.checked, cut: 0 };
      if (element instanceof HTMLSelectElement) {
        const chosen = [...element.selectedOptions].map((o) => o.value);
        return { value: element.multiple ? chosen : (chosen[0] ?? null), cut: 0 };
      }
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return { value: element.value, cut: 0 };
      if (/** @type {HTMLElement} */ (element).isContentEditable) return capped(/** @type {HTMLElement} */ (element).innerText);
      const role = injected.utils.getAriaRole(element);
      if (["checkbox", "radio", "switch"].includes(role)) return { value: element.getAttribute("aria-checked") === "true", cut: 0 };
      return { value: null, cut: 0 };
    }
    const rect = element.getBoundingClientRect();
    const inView = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    if (what === "box") return { value: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, inViewport: inView }, cut: 0 };
    // state
    // Playwright throws for states that do not apply (checked on a button, editable on a div)
    /** @param {string} s @returns {boolean | null} */
    const flag = (s) => {
      try {
        const r = injected.elementState(element, s, true);
        return typeof r.received === "string" && r.received.startsWith("error:") ? null : r.matches === true;
      } catch {
        return null;
      }
    };
    return {
      value: {
        visible: flag("visible") === true,
        enabled: flag("enabled") === true,
        editable: flag("editable") === true,
        checked: flag("checked"),
        focused: document.activeElement === element,
        inViewport: inView,
      },
      cut: 0,
    };
  }

  /** @param {{target: string, what?: string, name?: string, all?: boolean, maxChars?: number}} params */
  function get({ target, what = "text", name, all = false, maxChars = 5000 }) {
    const elements = resolveAll(target);
    if (elements.length === 0) throw new OpError("TARGET_NOT_FOUND", `nothing matches ${target}`);
    if (!all) {
      if (elements.length > 1) {
        throw new OpError("AMBIGUOUS_TARGET", `${target} matches ${elements.length} elements`, { count: elements.length, candidates: elements.slice(0, 5).map(preview) });
      }
      return { resolved: describe(elements[0]), ...readOne(elements[0], what, name, maxChars) };
    }
    return {
      count: elements.length,
      items: elements.slice(0, 100).map((e) => ({ resolved: describe(e), ...readOne(e, what, name, maxChars) })),
    };
  }

  // ---------- plumbing for other lanes ----------

  /** @param {{target: string, control?: boolean}} params control: mark the label's control (fill_form) */
  function mark({ target, control = false }) {
    const element = control ? checkReceiver(resolve(target)) : resolve(target);
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
      readyState: document.readyState,
      age: Math.round(performance.now()),
      frameId: state.frameId,
      mutations: state.mutations,
      content: state.content,
      structure: state.structure,
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
    get,
    readBack,
    elementState: elementStateOf,
    mark,
    unmark,
    box,
    armDialogs,
    dialogLog,
    resolve: (/** @type {{target: string}} */ { target }) => ({ resolved: describe(resolve(target)) }),
  };

  g.__bctlRuntime = {
    get ready() {
      return state.ready;
    },
    init,
    /**
     * Every answer carries the ref counter (`refHigh`), which the extension records for the tab
     * and strips (specs/dom-lane.md).
     * @param {string} op @param {any[]} args
     */
    call(op, args) {
      const fn = ops[op];
      let answer;
      if (!fn) answer = { ok: false, code: "UNKNOWN_OP", message: op };
      else {
        try {
          answer = { ok: true, ...fn(args?.[0] ?? {}) };
        } catch (error) {
          const e = /** @type {any} */ (error);
          answer = { ok: false, code: e.code ?? "RUNTIME_ERROR", message: String(e.message ?? e).slice(0, 500), ...(e.extra ?? {}) };
        }
      }
      return { ...answer, refHigh: g.__bctlRefCounter.get() };
    },
  };
})();
