// End-to-end test runner for browserctl.
//
// Drives the LIVE stack (agent -> bridge -> extension -> Chrome) against a fixture page this
// script serves over http (a real origin, so localStorage and cross-origin iframes behave).
//
// Tab discipline is not negotiable and lives in harness.mjs: ONE long-lived tab, scratch tabs
// only through withScratchTab(), every tab on a ledger, groups ungrouped before anything is
// closed (Chrome syncs saved tab groups between machines), teardown on exit and on Ctrl-C, and
// verifyClean() failing the run if any of it leaked. Six orphaned tabs from earlier runs are
// what this replaced.
//
// Prereqs: bridge running (`browserctl start` or `npm start`) and the extension connected.
// Run:  node tests/e2e/run.mjs

import http from "node:http";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import {
  BRIDGE,
  cmd,
  cmdFailReply,
  cmdFail,
  assert,
  test,
  used,
  openMainTab,
  teardown,
  verifyClean,
  installReaper,
  report,
} from "./harness.mjs";

installReaper();
const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_RAW = readFileSync(join(HERE, "testpage.html"), "utf8");
const SECOND = "<!doctype html><title>second</title><h1 id=sec>Second Page</h1>";
// Inner document for the cross-origin iframe (served from a second origin/port).
const INNER = `<!doctype html><meta charset=utf-8><title>inner</title>
  <button id=ibtn onclick="this.textContent='Iframe Clicked'">Iframe Button</button>
  <input id=iinput placeholder="Iframe Input">`;

// ---- full command surface, for a coverage report at the end ----
// Derived from the MCP registry, never hand-maintained: a hardcoded list silently
// stopped counting 19 actions (fill, paste, find_text, the whole get_* family) and
// reported 59/61 against a surface that was really 80. The denominator is the thing
// that rots, so it is computed. `npm test` fails if this parse stops finding tools.
function protocolActions() {
  const src = readFileSync(new URL("../../mcp/index.js", import.meta.url), "utf8");
  const registered = [...src.matchAll(/\btool\(\s*"([a-z_0-9]+)"/g)].map((m) => m[1]);
  const aliasBlock = src.match(/const ACTION_ALIASES\s*=\s*\{([\s\S]*?)\n\};/);
  const aliases = aliasBlock
    ? [...aliasBlock[1].matchAll(/^\s*([a-z_0-9]+)\s*:/gm)].map((m) => m[1])
    : [];
  return [...new Set([...registered, ...aliases])].sort();
}

// Deliberately never exercised here, with the reason. Anything NOT listed and NOT called
// shows up as a coverage miss, which is the point.
const NOT_EXERCISED = {
  action: "the escape hatch; the actions it reaches are counted on their own",
  tabs: "an MCP-layer composite over new_tab/list_tabs/switch_tab/close_tab, each exercised here",
  take_screenshot: "alias for screenshot, exercised directly",
  file_upload: "alias for upload, exercised directly",
  evaluate: "alias for eval_js, exercised directly",
  get_content: "alias for get_page_content, exercised directly",
};

const ALL_ACTIONS = protocolActions();

let PORT;

// Find a ref for an element by matching snapshot/read_page text.
function refByText(snap, needle) {
  const el = (snap.elements || []).find((e) => (e.text || "").includes(needle));
  return el && el.ref;
}

async function main() {
  // second origin (different port) for a genuinely cross-origin iframe
  const originB = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(INNER);
  });
  await new Promise((r) => originB.listen(0, "127.0.0.1", r));
  const PORTB = originB.address().port;
  const iframeSrc = `http://127.0.0.1:${PORTB}/inner.html`;
  const PAGE = PAGE_RAW.replace("__IFRAME_SRC__", iframeSrc);

  // serve the main test page
  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url.startsWith("/index")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    } else if (req.url.startsWith("/second")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(SECOND);
    } else if (req.url.startsWith("/ping")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    } else {
      res.writeHead(404);
      res.end("no");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;
  const base = `http://127.0.0.1:${PORT}`;
  console.log(
    `test page served at ${base} (cross-origin iframe at ${iframeSrc})\nrunning against bridge ${BRIDGE}\n`
  );

  let tabId;
  try {
    // --- tab setup ---
    await test("new_tab opens the one tab this suite runs on", async () => {
      tabId = await openMainTab(base + "/");
      assert(tabId != null, "no tab id");
    });
    await cmd("wait_settle", {});
    await test("current_tab is the tab new_tab made this run's target", async () => {
      const r = await cmd("current_tab", {});
      assert(r.id === tabId, "the run's target is not the test tab");
      assert(/127\.0\.0\.1/.test(r.url), "wrong url");
    });
    await test("list_tabs includes test tab", async () => {
      const r = await cmd("list_tabs", {});
      assert(
        r.tabs.some((t) => t.id === tabId),
        "tab missing"
      );
    });

    // --- reads (incl. shadow DOM) ---
    let snap;
    await test("snapshot", async () => {
      snap = await cmd("snapshot", {});
      assert(snap.text.includes("bctl Test Page"), "body text missing");
      assert(snap.elements.length >= 5, "too few elements");
    });
    await test("snapshot pierces shadow DOM", async () => {
      assert(refByText(snap, "Shadow Button"), "shadow button not in snapshot");
    });
    await test("read_page", async () => {
      const r = await cmd("read_page", { mode: "interactive" });
      assert(/Click Me/.test(r.tree) && /ref_/.test(r.tree), "read_page tree missing button/ref");
    });
    await test("find (shadow)", async () => {
      const r = await cmd("find", { query: "Shadow Button" });
      assert(r.matches.length >= 1 && r.matches[0].ref, "find did not locate shadow button");
    });

    // --- the actions with no tool of their own (reached via browser_action) ---

    await test("an open dialog is reported, addressable, and dismissable", async () => {
      await cmd("click", { selector: "#dlgopen" });
      const snap = await cmd("snapshot", { compact: true, maxText: 0 });
      const line = (snap.compactView || "")
        .split("\n")
        .find((l) => /Active Modal|Open dialog/.test(l));
      assert(line, "an open <dialog> must be reported by the census");
      const ref = (line.match(/\(@(ref_\d+)\)/) || [])[1];
      assert(ref, `the dialog must carry a ref it can be read by: ${line}`);
      const body = await cmd("get_property", { ref, property: "text" });
      assert(
        /Dialog body text/.test(body.value),
        `reading the dialog by ref gave: ${JSON.stringify(body.value)}`
      );
      await cmd("dismiss", {});
      const open = await cmd("eval_js", { expression: "document.getElementById('dlg').open" });
      assert(open.value === false, "dismiss did not close the dialog");
    });

    // --- the element read, in every shape the surface offers ---
    await test("get_property: one element", async () => {
      const r = await cmd("get_property", { selector: "#title", property: "text" });
      assert(r.value === "bctl Test Page", `title text = ${JSON.stringify(r.value)}`);
    });

    await test("get_property: count is an answer, zero included", async () => {
      const hit = await cmd("get_property", { selector: "li.row", property: "count" });
      assert(hit.value === 3, `row count = ${hit.value}`);
      const miss = await cmd("get_property", { selector: "li.nope", property: "count" });
      assert(
        miss.value === 0 && /answer, not a failure/.test(miss.note || ""),
        "zero count must be an answer"
      );
    });

    // browser_extract and browser_fill_form were the two genuinely new tools of v2 and the
    // only two excused from this suite, which is backwards: the excuse said they were
    // MCP-layer composites, but both dispatch to a bridge action of the same name.
    await test("extract: reads every row, with a ref per row", async () => {
      const r = await cmd("extract", { selector: "li.row" });
      assert(r.count === 3 && r.extracted === 3, `count/extracted = ${r.count}/${r.extracted}`);
      assert(
        r.matches.every((m) => /^@?ref_/.test(m.ref || "")),
        "every row must carry its own ref"
      );
      assert(
        /Row One/.test(r.matches[0].value || r.matches[0].text || ""),
        `row 0 = ${JSON.stringify(r.matches[0])}`
      );
    });

    await test("extract: fields read inside the row, and URLs resolve absolutely", async () => {
      const r = await cmd("extract", {
        selector: "li.row",
        fields: { title: ".t", url: { selector: ".u", attr: "href" }, n: ".n" },
      });
      assert(r.fields.join(",") === "title,url,n", `fields = ${r.fields}`);
      assert(r.matches[0].title === "Row One", `title = ${r.matches[0].title}`);
      assert(r.matches[2].n === "33", `n = ${r.matches[2].n}`);
      assert(
        /^http:\/\/127\.0\.0\.1:\d+\/second\.html$/.test(r.matches[0].url),
        `relative href must come back absolute, got ${r.matches[0].url}`
      );
      assert(
        r.matches[1].url === "https://example.com/x",
        `absolute href changed: ${r.matches[1].url}`
      );
    });

    await test("extract: zero matches is an answer, not a failure", async () => {
      const r = await cmd("extract", { selector: "li.nonexistent-row" });
      assert(r.count === 0 && r.extracted === 0, `count = ${r.count}`);
      assert(
        /0 matches\. This is an answer, not a failure/.test(String(r.note || "")),
        `note = ${r.note}`
      );
    });

    await test("fill_form: several fields in one call, controlled input included", async () => {
      await cmd("clear", { selector: "#plain" });
      await cmd("clear", { selector: "#controlled" });
      await cmd("clear", { selector: "#area" });
      const r = await cmd("fill_form", {
        fields: [
          { target: "css=#plain", value: "batch-plain" },
          { target: "css=#controlled", value: "batch-controlled" },
          { target: "css=#area", value: "batch-notes", method: "paste" },
        ],
      });
      assert(r.filled.length === 3, `filled = ${r.filled.length}`);
      assert(
        r.filled.every((f) => f.resolved && f.resolved.by === "css"),
        "each filled field must report how its target resolved"
      );
      for (const [sel, want] of [
        ["#plain", "batch-plain"],
        ["#controlled", "batch-controlled"],
        ["#area", "batch-notes"],
      ]) {
        const v = await cmd("get_property", { selector: sel, property: "value" });
        assert(v.value === want, `${sel} = ${JSON.stringify(v.value)}, want ${want}`);
      }
    });

    // The description promises checkboxes and <select>s, not only text fields, so both are
    // asserted against the real DOM: 'true'/'false' sets a checkbox, a visible option text picks
    // that option.
    await test("fill_form: a checkbox and a <select> in the same call as a text field", async () => {
      const opt = await cmd("eval_js", {
        expression: "(()=>{const s=document.getElementById('sel');return s.options[s.options.length-1].text})()",
      });
      const r = await cmd("fill_form", {
        fields: [
          { target: "css=#plain", value: "with-controls" },
          { target: "css=#cbox", value: "true" },
          { target: "css=#sel", value: opt.value },
        ],
      });
      assert(r.filled.length === 3, `filled = ${r.filled.length}`);
      const st = await cmd("eval_js", {
        expression:
          "(()=>{const s=document.getElementById('sel');return [document.getElementById('cbox').checked,s.options[s.selectedIndex].text]})()",
      });
      assert(st.value[0] === true, `checkbox not checked: ${JSON.stringify(st.value)}`);
      assert(st.value[1] === opt.value, `select = ${JSON.stringify(st.value[1])}, want ${opt.value}`);
      await cmd("fill_form", { fields: [{ target: "css=#cbox", value: "false" }] });
      const off = await cmd("eval_js", { expression: "document.getElementById('cbox').checked" });
      assert(off.value === false, "value 'false' must uncheck the checkbox");
    });

    // The contract from the design: stop at the first failure, keep what was already
    // written, and name the index. Asserted against the real DOM, not the response shape.
    await test("fill_form: stops at the first bad field and keeps what it already wrote", async () => {
      await cmd("clear", { selector: "#plain" });
      await cmd("clear", { selector: "#area" });
      const err = await cmdFail("fill_form", {
        fields: [
          { target: "css=#plain", value: "written-before-the-failure" },
          { target: "css=#no-such-field", value: "never" },
          { target: "css=#area", value: "must-not-be-written" },
        ],
      });
      assert(/field index 1/.test(err), `the error must name the failing index, got: ${err}`);
      const before = await cmd("get_property", { selector: "#plain", property: "value" });
      assert(
        before.value === "written-before-the-failure",
        `field 0 must survive, got ${JSON.stringify(before.value)}`
      );
      const after = await cmd("get_property", { selector: "#area", property: "value" });
      assert(
        after.value === "",
        `field 2 must not be written after the stop, got ${JSON.stringify(after.value)}`
      );
    });

    // --- cross-origin iframe (all_frames + frame-qualified refs) ---
    await test("get_page_content", async () => {
      const r = await cmd("get_page_content", {});
      assert(r.text.includes("bctl Test Page"), "content missing");
    });
    await test("wait_for selector", async () => {
      await cmd("wait_for", { selector: "#title" });
    });

    // --- interactions ---
    await test("click by ref + effect", async () => {
      const ref = refByText(snap, "Click Me");
      assert(ref, "no button ref");
      await cmd("click", { ref });
      const v = await cmd("eval_js", { expression: "window.__clicked||0" });
      assert(v.value === 1, `click had no effect (clicked=${v.value})`);
    });
    // A checkbox's checked is a property, not an attribute: the click changes no DOM, and the
    // effect has to count the property flip as the control's own state change.
    await test("click a checkbox: get_property checked reads true, and no warning", async () => {
      await cmd("eval_js", { expression: "document.getElementById('cbox').checked = false; 1" });
      const r = await cmd("click", { target: "css=#cbox" });
      assert(!r.warning, `a checkbox click that checked it must not warn: ${r.warning}`);
      assert(
        (r.effect.controlState?.changed || []).includes("checked: false -> true"),
        `controlState must name the flip: ${JSON.stringify(r.effect.controlState)}`
      );
      const v = await cmd("get_property", { target: "css=#cbox", property: "checked" });
      assert(v.value === true, `checked read back: ${JSON.stringify(v)}`);
      const msg = await cmdFail("get_property", { target: "css=#title", property: "checked" });
      assert(/checkbox or radio/.test(msg), `checked on a non-checkbox must be refused: ${msg}`);
    });
    // Only the browser process can mint a File, so upload is the one capability a page's own
    // JavaScript cannot fake — and the input is hidden behind a styled label on nearly every
    // real upload UI, which is the part that has to work.
    const uploadFiles = [1, 2].map((n) => join(tmpdir(), `bctl-e2e-upload-${Date.now()}-${n}.txt`));
    writeFileSync(uploadFiles[0], "e2e upload probe\n");
    writeFileSync(uploadFiles[1], "second\n");
    await test("upload walks from the styled label to the hidden input", async () => {
      const r = await cmd("upload", { files: [uploadFiles[0]], text: "Choose file" });
      assert(r.count === 1, `expected 1 file attached, got ${r.count}`);
      assert(r.files[0] === basename(uploadFiles[0]), `wrong file attached: ${r.files[0]}`);
      assert(
        /label/.test(r.input.matchedBy),
        `must resolve through the label, got: ${r.input.matchedBy}`
      );
      assert(r.input.hidden === true, "the fixture's input is display:none, and that is normal");
      // The page's own change handler is the real proof: the file is in the DOM, not just in
      // a CDP call that returned.
      const shown = await cmd("get_property", { selector: "#filename", property: "text" });
      assert(
        shown.value.startsWith(basename(uploadFiles[0])),
        `page did not see the file: ${shown.value}`
      );
    });
    rmSync(uploadFiles[0], { force: true });
    rmSync(uploadFiles[1], { force: true });

    // A click takes its coordinates from the element's box, so clicking one that is still
    // sliding dispatches at where it was a moment ago. Playwright refuses to click until the
    // box stops; we click, and say the box was moving. Both regimes must report it: a visible
    // tab by sampling the rect across frames, a hidden one (no frames are delivered there, but
    // the animation timeline still advances) by reading the running animation.
    await test("click shadow button by ref + effect", async () => {
      const ref = refByText(snap, "Shadow Button");
      assert(ref, "no shadow button ref");
      await cmd("click", { ref });
      const v = await cmd("eval_js", { expression: "window.__shadowClicked||0" });
      assert(v.value === 1, `shadow click had no effect (clicked=${v.value})`);
    });
    await test("type into plain input", async () => {
      const ref =
        refByText(snap, "Plain input") ||
        (snap.elements.find((e) => e.type === "text" && e.placeholder === "Plain input") || {}).ref;
      await cmd("type", {
        ref: ref || (await cmd("find", { query: "Plain" })).matches[0].ref,
        text: "hello",
      });
      const v = await cmd("eval_js", { expression: "document.getElementById('plain').value" });
      assert(v.value === "hello", `plain value = ${JSON.stringify(v.value)}`);
    });
    await test("type survives React-like controlled input (native setter)", async () => {
      const ref = (await cmd("find", { query: "Controlled" })).matches[0].ref;
      await cmd("type", { ref, text: "world" });
      const v = await cmd("eval_js", { expression: "document.getElementById('controlled').value" });
      assert(
        v.value === "world",
        `controlled input reverted (value=${JSON.stringify(v.value)}) — native setter fix regressed`
      );
    });
    await test("snapshot: a viewport snapshot's text is the text on screen, 'all' is the page's", async () => {
      await cmd("eval_js", {
        expression: `(()=>{
          const on=document.createElement('div'); on.id='vt-on'; on.textContent='ONSCREEN-MARKER';
          on.style.cssText='position:fixed;top:4px;left:4px;z-index:9';
          const off=document.createElement('div'); off.id='vt-off'; off.textContent='OFFSCREEN-MARKER';
          off.style.cssText='position:absolute;top:20000px;left:0';
          const hid=document.createElement('div'); hid.id='vt-hid'; hid.textContent='HIDDEN-MARKER';
          hid.style.cssText='position:fixed;top:30px;left:4px;visibility:hidden';
          document.body.append(on,off,hid); return true;
        })()`,
      });
      try {
        const vp = await cmd("snapshot", { scope: "viewport", compact: true });
        assert(vp.text.includes("ONSCREEN-MARKER"), "viewport text lost the text on screen");
        assert(!vp.text.includes("OFFSCREEN-MARKER"), "viewport text carries text below the fold");
        assert(!vp.text.includes("HIDDEN-MARKER"), "viewport text carries hidden text");
        const all = await cmd("snapshot", { scope: "all", compact: true });
        assert(all.text.includes("OFFSCREEN-MARKER"), "scope 'all' must keep the whole page's text");
        const none = await cmd("snapshot", { scope: "viewport", compact: true, maxText: 0 });
        assert(none.text === "", `maxText 0 must give no text: ${JSON.stringify(none.text)}`);
      } finally {
        await cmd("eval_js", {
          expression: "['vt-on','vt-off','vt-hid'].forEach(id=>document.getElementById(id)?.remove()), true",
        });
      }
    });

    // Text with no control around it. A card whose click handler is attached with
    // addEventListener, as React and Vue attach theirs, shows only a pointer cursor; a click on
    // its text must reach that handler. Text with nothing clickable around it is refused, and the
    // hint names the control nearest to it, not the first controls on the page.
    await test("click: text inside a pointer-cursor card reaches the card's listener", async () => {
      await cmd("eval_js", {
        expression: `(()=>{
          const card=document.createElement('div'); card.id='pc-card'; card.style.cursor='pointer';
          card.innerHTML='<div><span>Open card QZX</span></div>';
          card.addEventListener('click',()=>{window.__cardClicked=(window.__cardClicked||0)+1;card.dataset.opened='1';});
          const lone=document.createElement('p'); lone.id='pc-lone'; lone.textContent='Lonely text WVY';
          const near=document.createElement('button'); near.id='pc-near'; near.textContent='Near button';
          document.body.prepend(card, lone, near); window.__cardClicked=0; return true;
        })()`,
      });
      try {
        const r = await cmd("click", { target: "Open card QZX" });
        const n = await cmd("eval_js", { expression: "window.__cardClicked" });
        assert(n.value === 1, `the card's listener ran ${n.value} times`);
        assert(
          r.resolved?.clickableAncestor?.via === "cursor:pointer",
          `the result must say where the click affordance came from: ${JSON.stringify(r.resolved)}`
        );
        const raw = await cmdFailReply("click", { target: "Lonely text WVY" });
        assert(!raw.ok && /plain text/.test(raw.error), `plain text must still be refused: ${JSON.stringify(raw)}`);
        assert(/Near button/.test(raw.recoveryHint || ""), `the hint must name the nearest control: ${raw.recoveryHint}`);
      } finally {
        await cmd("eval_js", {
          expression: "['pc-card','pc-lone','pc-near'].forEach(id=>document.getElementById(id)?.remove()), true",
        });
      }
    });

    // An overlay over the target: the dispatched click still reaches the target, and the
    // warning names the overlay's ref as the thing to close, not a vague "may have intercepted".
    await test("click: a covered target is clicked, and the warning names the overlay to close", async () => {
      await cmd("eval_js", {
        expression: `(()=>{
          const b=document.createElement('button'); b.id='cv-btn'; b.textContent='Covered target';
          b.style.cssText='position:fixed;top:200px;left:200px;width:160px;height:40px;z-index:5';
          b.addEventListener('click',()=>{window.__cv=(window.__cv||0)+1;});
          const o=document.createElement('div'); o.id='cv-ov';
          o.style.cssText='position:fixed;top:180px;left:180px;width:220px;height:80px;z-index:6;background:rgba(0,0,0,.3)';
          document.body.append(b,o); window.__cv=0; return true;
        })()`,
      });
      try {
        const r = await cmd("click", { target: "#cv-btn" });
        const n = await cmd("eval_js", { expression: "window.__cv" });
        assert(n.value === 1, `the covered button's listener ran ${n.value} times`);
        assert(/covered at its centre by <div> \(@ref_\d+\)/.test(r.warning || ""), `warning: ${r.warning}`);
        assert(/close or answer @ref_\d+ first/.test(r.warning), `the warning must name what to close: ${r.warning}`);
        assert(!/may have intercepted/.test(r.warning), "the old vague wording is back");
      } finally {
        await cmd("eval_js", { expression: "['cv-btn','cv-ov'].forEach(id=>document.getElementById(id)?.remove()), true" });
      }
    });

    // Autocomplete fields. The widgets are built per test and removed after it, so nothing else
    // on the fixture page sees them. Options arrive 120 ms after the input event, the way a
    // suggestion request answers, and type must wait for them rather than report none.
    const buildAutocomplete = (id, { controls, delayMs = 120, staticOption = false } = {}) =>
      cmd("eval_js", {
        expression: `(()=>{
          const box=document.createElement('div'); box.id='${id}';
          box.innerHTML='<input id="${id}-in" role="combobox" aria-autocomplete="list" placeholder="${id} city"'+
            (${controls} ? ' aria-controls="${id}-list"' : '')+'><ul id="${id}-list" role="listbox"></ul>'+
            (${staticOption} ? '<div role="listbox"><div role="option">Always here</div></div>' : '');
          document.body.prepend(box);
          const input=box.querySelector('input'), list=box.querySelector('ul');
          input.addEventListener('input',()=>setTimeout(()=>{
            if (${delayMs} < 0) return;
            list.innerHTML=['Zurich','Zug','Zermatt'].filter(c=>c.toLowerCase().startsWith(input.value.toLowerCase()))
              .map(c=>'<li role="option" onclick="document.getElementById(\\'${id}-in\\').value=this.textContent">'+c+'</li>').join('');
          }, Math.max(0, ${delayMs})));
          return true;
        })()`,
      });
    const removeAutocomplete = (id) =>
      cmd("eval_js", { expression: `document.getElementById('${id}')?.remove(), true` });

    await test("type into an autocomplete field returns the suggestions it opened", async () => {
      await buildAutocomplete("ac1", { controls: true });
      try {
        const r = await cmd("fill", { target: "#ac1-in", text: "Z" });
        const s = r.effect.suggestions;
        assert(Array.isArray(s), `no suggestions on an autocomplete field: ${JSON.stringify(r.effect)}`);
        assert(
          s.map((o) => o.text).join(",") === "Zurich,Zug,Zermatt",
          `suggestions = ${JSON.stringify(s)}`
        );
        assert(s.every((o) => /^(f\d+:)?ref_\d+$/.test(o.ref)), `each suggestion needs a ref: ${JSON.stringify(s)}`);
        await cmd("click", { target: "@" + s[1].ref });
        const v = await cmd("eval_js", { expression: "document.getElementById('ac1-in').value" });
        assert(v.value === "Zug", `clicking the suggestion ref did not pick it (value=${JSON.stringify(v.value)})`);
      } finally {
        await removeAutocomplete("ac1");
      }
    });
    await test("type: suggestions without aria-controls are the options the text produced", async () => {
      await buildAutocomplete("ac2", { controls: false, staticOption: true });
      try {
        const r = await cmd("fill", { target: "#ac2-in", text: "Zu" });
        const texts = (r.effect.suggestions || []).map((o) => o.text);
        assert(texts.join(",") === "Zurich,Zug", `a listbox already on the page leaked in: ${JSON.stringify(texts)}`);
      } finally {
        await removeAutocomplete("ac2");
      }
    });
    await test("type: an autocomplete with nothing to offer answers an empty list, bounded", async () => {
      await buildAutocomplete("ac3", { controls: true, delayMs: -1 });
      try {
        const t0 = Date.now();
        const r = await cmd("fill", { target: "#ac3-in", text: "Q" });
        const ms = Date.now() - t0;
        assert(
          Array.isArray(r.effect.suggestions) && r.effect.suggestions.length === 0,
          `expected an empty list: ${JSON.stringify(r.effect.suggestions)}`
        );
        assert(ms < 2000, `waiting for suggestions that never come took ${ms} ms`);
      } finally {
        await removeAutocomplete("ac3");
      }
    });
    await test("type: a plain field and a submitted one carry no suggestions", async () => {
      const plain = await cmd("fill", { target: "#plain", text: "x" });
      assert(!("suggestions" in plain.effect), `plain input: ${JSON.stringify(plain.effect)}`);
      await buildAutocomplete("ac4", { controls: true });
      try {
        const r = await cmd("fill", { target: "#ac4-in", text: "Z", submit: true });
        assert(!("suggestions" in r.effect), `submit:true still waited for suggestions: ${JSON.stringify(r.effect)}`);
      } finally {
        await removeAutocomplete("ac4");
      }
    });
    // A native <dialog> is the standard modal, and it is the case dismiss used to fail:
    // showModal() closes on Escape only for a TRUSTED event, so the dispatched one never
    // worked. Leave nothing open — a modal blocks input to the page behind it.
    const openDialog = () =>
      cmd("eval_js", {
        expression:
          "(()=>{let d=document.getElementById('e2edlg');if(!d){d=document.createElement('dialog');" +
          "d.id='e2edlg';d.textContent='e2e modal';document.body.appendChild(d);}" +
          "if(!d.open)d.showModal();return d.open;})()",
      });
    const dialogOpen = async () =>
      (await cmd("eval_js", { expression: "!!(document.getElementById('e2edlg')||{}).open" }))
        .value;
    const closeDialog = () =>
      cmd("eval_js", {
        expression:
          "(()=>{const d=document.getElementById('e2edlg');if(d&&d.open)d.close();return true;})()",
      });

    for (const verb of ["dismiss", "dismiss_modal"]) {
      await test(`${verb} closes a native <dialog>`, async () => {
        try {
          assert((await openDialog()).value === true, "fixture dialog did not open");
          await cmd(verb, {});
          assert((await dialogOpen()) === false, `dialog still open after ${verb}`);
        } finally {
          await closeDialog();
        }
      });
    }
    await test("select_option by value", async () => {
      const ref =
        (await cmd("find", { query: "Banana" })).matches[0]?.ref ||
        (await cmd("snapshot", {})).elements.find((e) => e.tag === "select")?.ref;
      await cmd("select_option", { ref, value: "b" });
      const v = await cmd("eval_js", { expression: "document.getElementById('sel').value" });
      assert(v.value === "b", `select value=${JSON.stringify(v.value)}`);
    });
    await test("hover", async () => {
      const ref = (await cmd("find", { query: "hover me" })).matches[0].ref;
      await cmd("hover", { ref });
      const v = await cmd("eval_js", {
        expression: "document.getElementById('hovered').textContent",
      });
      assert(v.value === "yes", "hover had no effect");
    });
    await test("press_key Escape on input (no throw)", async () => {
      const ref = (await cmd("find", { query: "Plain" })).matches[0].ref;
      await cmd("press_key", { ref, key: "Escape" });
    });
    await test("scroll", async () => {
      await cmd("scroll", { direction: "down", amount: 200 });
    });

    // --- storage ---

    // eval_js answers from two different engines depending on whether a debugger happens to be

    // --- CDP-backed ---
    await test("eval_js compute", async () => {
      const r = await cmd("eval_js", { expression: "6*7" });
      assert(r.value === 42, "eval math wrong");
    });
    // --- CDP synthetic input: guard always, real behaviour only when opted in ---
    // The guards are asserted against a dedicated tab that is deliberately left in the
    // BACKGROUND, addressed by explicit tabId. Asserting them against the main test tab
    // instead would make them order-dependent: any earlier test that foregrounds the tab
    // (E2E_FOREGROUND=1 below) would silently invalidate them — the exact class of
    // order-dependence that hid the original bug.
    // ================= the fixture's adversarial half =================
    // Every check below exists because the old fixture was too tidy to fail on: one control
    // per label, nothing stacked, nothing that moves. A page that cannot be got wrong cannot
    // prove the resolver gets it right.

    await test("noise: one label on three controls is refused, with candidates", async () => {
      const err = await cmdFail("click", { target: "Save" });
      assert(/ambiguous/i.test(err), `expected AMBIGUOUS_TARGET, got: ${err}`);
      assert(
        /3 elements|3 candidates|matched 3/i.test(err),
        `the refusal must say how many it found: ${err}`
      );
    });

    await test("noise: the unique longer label still resolves", async () => {
      const r = await cmd("click", { target: "Save Draft" });
      assert(
        r.resolved && r.resolved.by === "text-exact",
        `resolved = ${JSON.stringify(r.resolved)}`
      );
      assert(r.resolved.matchCount === 1, `matchCount = ${r.resolved.matchCount}`);
    });

    // The §2.2 correction, against a real browser: these words are valid type selectors AND
    // visible labels. The button must win; the landmark is only reachable when no text matches.
    for (const word of ["search", "menu", "output", "time"]) {
      await test(`landmark: "${word}" resolves to the control, not the <${word}> element`, async () => {
        const r = await cmd("click", { target: word });
        assert(r.resolved, `no resolved block: ${JSON.stringify(r)}`);
        assert(
          r.resolved.tag === "button",
          `"${word}" resolved to <${r.resolved.tag}>, not the button`
        );
        assert(
          /text-exact|text-substring/.test(r.resolved.by),
          `resolved by ${r.resolved.by}, expected visible text`
        );
      });
    }

    // "details" is the harder case: <summary>details</summary> and <button>details</button>
    // share the label exactly, so there is no right answer and the resolver must say so.
    await test('landmark: "details" collides with a real label and is refused, not guessed', async () => {
      const err = await cmdFail("click", { target: "details" });
      assert(/ambiguous/i.test(err), `expected AMBIGUOUS_TARGET, got: ${err}`);
      assert(/<summary>|summary/i.test(err), `the candidates must name the landmark too: ${err}`);
    });

    // Step 5 (substring text) outranks step 6 (bare tag), by design: "dialog" is inside the
    // label "Open dialog", and a word the user can see beats a word only the DOM knows.
    await test("landmark: visible substring text still outranks a bare tag name", async () => {
      const r = await cmd("get_property", { target: "dialog", property: "attr", attr: "id" });
      assert(
        r.value === "dlgopen",
        `expected the labelled control, got ${JSON.stringify(r.value)}`
      );
    });

    // The six rows of the state matrix are unusable in six different ways, and the contract
    // differs per row: display:none still acts and WARNS (losing that capability was a
    // regression once), disabled is refused outright.
    await test("state: the visible control acts, display:none acts with a warning", async () => {
      const ok = await cmd("click", { target: "css=#st-visible" });
      assert(ok.resolved, "the visible control must act");
      const hidden = await cmd("click", { target: "css=#st-display" });
      assert(
        /display:\s*none/i.test(hidden.warning || ""),
        `expected a display:none warning, got: ${JSON.stringify(hidden)}`
      );
    });

    await test("dynamic: a ref into a re-rendered subtree is refused, not silently re-pointed", async () => {
      const before = (await cmd("find", { query: "Dynamic Button" })).matches[0];
      assert(before && before.ref, "no ref for the dynamic button");
      await cmd("click", { target: "css=#rerender" });
      await cmd("wait_settle", {});
      const err = await cmdFail("get_property", { target: before.ref, property: "text" });
      assert(/stale|not found|re-render/i.test(err), `expected a stale-ref refusal, got: ${err}`);
      const after = await cmd("get_property", { target: "css=#dyn-btn", property: "text" });
      assert(/v2/.test(after.value), `the zone did not re-render: ${after.value}`);
    });

    await test("dynamic: wait_for sees a toast arrive and wait_for gone sees it leave", async () => {
      // The fixture's toast lives 900ms by default, and a click returns only after the DOM
      // settles — long enough that the toast can be gone before the first wait starts. Give
      // it a window this suite can observe rather than racing it.
      await cmd("eval_js", { expression: "window.__toastMs = 4000" });
      await cmd("click", { target: "Raise Toast" });
      await cmd("wait_for", { text: "Saved successfully", timeoutMs: 3000 });
      await cmd("eval_js", {
        expression: "document.getElementById('toast').classList.remove('up')",
      });
      await cmd("wait_for", { selector: "#toast.up", gone: true, timeoutMs: 4000 });
      const cls = await cmd("get_property", {
        target: "css=#toast",
        property: "attr",
        attr: "class",
      });
      assert(!/up/.test(String(cls.value || "")), `toast still up: ${cls.value}`);
    });

    // --- previously untested commands ---

    // The suite's tab is opened in the background, so this is a background capture: it runs
    // under focus emulation (the only way Edge paints a hidden tab), answers promptly, and
    // leaves the tab hidden and in the background.
    await test("screenshot (viewport)", async () => {
      const before = (await cmd("list_tabs", {})).tabs.find((t) => t.id === tabId);
      const t0 = Date.now();
      const r = await cmd("screenshot", {});
      const ms = Date.now() - t0;
      assert(/^data:image\/(jpeg|png);base64,/.test(r.dataUrl), "no image");
      if (before && !before.active) {
        assert(ms < 2000, `a background capture took ${ms} ms`);
        const after = (await cmd("list_tabs", {})).tabs.find((t) => t.id === tabId);
        assert(after && !after.active, "the capture brought the tab to the front");
        const vis = await cmd("eval_js", { expression: "document.visibilityState" });
        assert(vis.value === "hidden", `the page is ${vis.value} after the capture`);
      }
    });

    // --- light network capture ---

    // --- navigation + hardened waitForComplete ---
    await test("navigate + go_back + go_forward", async () => {
      // Self-contained: build the history this needs instead of inheriting it from whatever
      // ran before.
      await cmd("navigate", { url: base + "/" });
      await cmd("wait_settle", {});
      const n = await cmd("navigate", { url: base + "/second.html" });
      assert(/second\.html/.test(n.url), `navigate url=${n.url}`);
      await cmd("go_back", {});
      await cmd("wait_settle", {});
      const c1 = await cmd("current_tab", {});
      assert(!/second/.test(c1.url), `go_back url=${c1.url}`);
      await cmd("go_forward", {});
      await cmd("wait_settle", {});
      const c2 = await cmd("current_tab", {});
      assert(/second/.test(c2.url), `go_forward url=${c2.url}`);
    });
    await test("reload", async () => {
      await cmd("reload", {});
    });

    // --- recorder ---

    // --- switch_tab without focus (no window raise) ---

    // --- teardown of CDP ---

    // --- v0.5 additions ---
  } finally {
    // Ungroup, then close, then prove it. The ledger in the harness owns every tab this run
    // touched, including one a failing test never reached the end of.
    await teardown();
    await test("cleanup leaves no tab and no synced group behind", async () => {
      await verifyClean(`127.0.0.1:${PORT}`);
    });
    server.close();
    originB.close();
  }

  // ---- report ----
  const failedCount = report();

  const untested = ALL_ACTIONS.filter((a) => !used.has(a) && !NOT_EXERCISED[a]);
  const excused = ALL_ACTIONS.filter((a) => NOT_EXERCISED[a]);
  console.log(
    `\nCommand coverage: ${ALL_ACTIONS.length - untested.length - excused.length}/${ALL_ACTIONS.length} exercised, ${excused.length} excused, ${untested.length} missed`
  );
  if (untested.length)
    console.log(
      "not covered by this suite, by design — it checks the core loop, not every action: " +
        untested.join(", ")
    );
  for (const a of excused) console.log(`  excused  ${a} — ${NOT_EXERCISED[a]}`);

  process.exit(failedCount ? 1 : 0);
}

main().catch((e) => {
  console.error("runner crashed:", e);
  process.exit(2);
});
