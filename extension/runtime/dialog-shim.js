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
})();
