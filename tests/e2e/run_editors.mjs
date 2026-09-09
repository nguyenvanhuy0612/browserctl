// Every text-insertion path must put the text in EXACTLY ONCE, across editor
// architectures that differ in whether they handle the paste event and whether they
// commit synchronously.
//
// This exists because the bug it guards was invisible on every simple fixture and on
// Gmail: only Lexical, which preventDefaults and then commits asynchronously, doubled the
// text. A fix verified against one editor is not verified.
import http from "node:http";
import { readFileSync } from "node:fs";

const BRIDGE = "http://127.0.0.1:8765";
const post = (a, p = {}) => fetch(`${BRIDGE}/command`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: a, params: p }),
}).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));

const FIXTURE = new URL("./editors.html", import.meta.url).pathname;
const CASES = [
  ["plain contenteditable", "#plain"],
  ["preventDefault + async commit", "#smart"],
  ["preventDefault + sync commit", "#sync"],
  ["textarea", "#ta"],
  ["input", "#inp"],
];

const main = async () => {
  const health = await post("status");
  if (!health || health.ok === false) { console.log("SKIP: bridge not reachable"); process.exit(0); }

  const srv = http.createServer((_q, s) => {
    s.writeHead(200, { "content-type": "text/html" });
    s.end(readFileSync(FIXTURE));
  }).listen(0);
  const port = srv.address().port;

  const opened = (await post("new_tab", { url: `http://127.0.0.1:${port}/` })).result;
  const tabId = opened && opened.id;
  await new Promise((r) => setTimeout(r, 900));

  let fails = 0;
  for (const verb of ["paste", "type"]) {
    for (const [name, sel] of CASES) {
      const mark = `bctl-${verb}-${Math.random().toString(36).slice(2, 8)}`;
      await post(verb, { selector: sel, text: mark, tabId });
      await new Promise((r) => setTimeout(r, 250));   // let an async editor commit
      const r = await post("eval_js", { tabId, expression:
        `(function(){var e=document.querySelector(${JSON.stringify(sel)});
          var v=e.isContentEditable?(e.innerText||""):(e.value||"");
          return (v.match(new RegExp(${JSON.stringify(mark)},"g"))||[]).length;})()` });
      const n = r.ok ? r.result.value : "err";
      const ok = n === 1;
      if (!ok) fails++;
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${verb.padEnd(5)} ${name.padEnd(30)} occurrences=${n}`);
      await post("eval_js", { tabId, expression:
        `(function(){var e=document.querySelector(${JSON.stringify(sel)});
          if(e.isContentEditable)e.textContent="";else e.value="";return 1;})()` });
    }
  }

  // Activation must also happen exactly once. requestSubmit() is a fallback for forms
  // that only submit via their button, never an addition to the Enter key — press_key
  // used to do both, so a page that submits from its own keydown handler submitted twice.
  let submitChecks = 0;
  for (const [name, sel, counter] of [
    ["Enter, page handles it itself", "#i1", "n1"],
    ["Enter, form submits via button", "#i2", "n2"],
  ]) {
    submitChecks++;
    await post("click", { selector: sel, tabId });
    await post("press_key", { key: "Enter", selector: sel, tabId });
    await new Promise((r) => setTimeout(r, 250));
    const c = await post("eval_js", { tabId, expression: `window.${counter}` });
    const n = c.ok ? c.result.value : "err";
    const ok = n === 1;
    if (!ok) fails++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  submit ${name.padEnd(30)} submits=${n}`);
  }

  if (tabId != null) await post("close_tab", { id: tabId });
  srv.close();
  const total = CASES.length * 2 + submitChecks;
  console.log(`\n==== ${total - fails}/${total} checks passed ====`);
  process.exit(fails === 0 ? 0 : 1);
};
main();
