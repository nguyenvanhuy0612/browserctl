// MAIN world, document_start, every frame. Replaces alert/confirm/prompt; inert (calls the
// originals) until the daemon arms a policy on this document through the DOM-lane runtime, so pages
// the agent does not own keep their real dialogs. The policy and the log travel as attributes on
// <html>, the only channel between the isolated and the MAIN world (specs/dom-lane.md).
(() => {
  const original = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
  const root = () => document.documentElement;
  const policy = () => {
    try {
      return JSON.parse(root()?.dataset.bctlDialogPolicy ?? "null");
    } catch {
      return null;
    }
  };
  let seq = 0;
  const record = (entry) => {
    let log = [];
    try {
      log = JSON.parse(root().dataset.bctlDialogLog ?? "[]");
    } catch {
      log = [];
    }
    seq = Math.max(seq, ...log.map((d) => d.seq ?? 0)) + 1;
    log.push({ ...entry, seq, at: Date.now() });
    root().dataset.bctlDialogLog = JSON.stringify(log.slice(-20));
  };
  const once = (p) => {
    if (p.scope === "next") root().dataset.bctlDialogPolicy = JSON.stringify({ alert: "accept", confirm: "dismiss", prompt: "dismiss", scope: "always" });
  };
  window.alert = function alert(message) {
    const p = policy();
    if (!p) return original.alert.call(window, message);
    record({ type: "alert", message: String(message ?? ""), answer: true });
    once(p);
  };
  window.confirm = function confirm(message) {
    const p = policy();
    if (!p) return original.confirm.call(window, message);
    const answer = p.confirm === "accept";
    record({ type: "confirm", message: String(message ?? ""), answer });
    once(p);
    return answer;
  };
  window.prompt = function prompt(message, defaultValue) {
    const p = policy();
    if (!p) return original.prompt.call(window, message, defaultValue);
    const answer = p.prompt === "accept" ? (p.promptText ?? String(defaultValue ?? "")) : null;
    record({ type: "prompt", message: String(message ?? ""), answer });
    once(p);
    return answer;
  };

  // beforeunload never asks in an armed document: Chrome holds a background tab's "Leave site?"
  // until the user activates the tab, and the page answers nothing meanwhile. The page's handlers
  // still run (specs/dom-lane.md).
  const preventDefault = Event.prototype.preventDefault;
  Object.defineProperty(BeforeUnloadEvent.prototype, "preventDefault", {
    configurable: true,
    writable: true,
    value: function preventDefault_() {
      if (!policy()) preventDefault.call(this);
    },
  });
  const returnValue = Object.getOwnPropertyDescriptor(BeforeUnloadEvent.prototype, "returnValue");
  if (returnValue?.set) {
    Object.defineProperty(BeforeUnloadEvent.prototype, "returnValue", {
      ...returnValue,
      set(value) {
        if (!policy()) returnValue.set.call(this, value);
      },
    });
  }
  const owner = Object.getOwnPropertyDescriptor(window, "onbeforeunload") ? window : Window.prototype;
  const handler = Object.getOwnPropertyDescriptor(owner, "onbeforeunload");
  if (handler?.set && handler.get) {
    let assigned = null;
    let installed = null;
    const assign = (fn) => {
      assigned = typeof fn === "function" ? fn : null;
      installed =
        assigned &&
        function onbeforeunload(event) {
          const value = assigned.call(this, event);
          return policy() ? undefined : value;
        };
      handler.set.call(window, installed);
    };
    Object.defineProperty(owner, "onbeforeunload", { ...handler, get: () => assigned, set: assign });
    // document.body.onbeforeunload and <frameset> forward to the window's handler
    for (const proto of [HTMLBodyElement.prototype, HTMLFrameSetElement.prototype]) {
      const own = Object.getOwnPropertyDescriptor(proto, "onbeforeunload");
      if (own) Object.defineProperty(proto, "onbeforeunload", { ...own, get: () => assigned, set: assign });
    }
    // <body onbeforeunload="..."> compiles into the window's handler without a setter call
    document.addEventListener("DOMContentLoaded", () => {
      const current = handler.get.call(window);
      if (current && current !== installed) assign(current);
    });
  }
})();
