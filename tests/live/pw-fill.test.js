// @ts-check
// Playwright's fill cases adopted by ID (specs/tools/type.md): `type`, in the DOM lane and with
// trusted: true. Sources: page-fill.spec.ts and page-keyboard.spec.ts in Playwright's tests/page.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { sleep, startHarness } from "./harness.js";
import { LANES, failsWith, pwPage } from "./pw.js";

/** @type {import("./harness.js").Harness} */
let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h?.close();
});

const PREFIX = () => `${h.base}/pw`;
/** Playwright's giveItAChanceToFill. */
const giveItAChanceToFill = () => sleep(400);
/** @param {"dom" | "cdp"} lane */
const open = (lane) => pwPage(h, h.newSession(), lane);
/** @param {ReturnType<typeof pwPage>} page @param {string} selector */
const valueOf = (page, selector) => page.$eval(selector, (/** @type {HTMLInputElement} */ e) => e.value);

const COMPOSED_TYPES = { color: "#aaaaaa", date: "2020-03-02", time: "13:15", "datetime-local": "2020-03-02T13:15:30", month: "2020-03", range: "42", week: "2020-W50" };

for (const lane of LANES) {
  describe(`fill, ${lane} lane`, () => {
    test(`FI-001 / FI-002 (${lane}) should fill a textarea and an input`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/textarea.html`);
      await page.fill("textarea", "some value");
      assert.equal(await page.evaluate("window.result"), "some value");
      await page.fill("input", "other value");
      assert.equal(await page.evaluate("window.result"), "other value");
    });

    test(`FI-004 (${lane}) should fill different input types`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/textarea.html`);
      for (const type of ["password", "search", "tel", "text", "url", "invalid-type"]) {
        await page.$eval("input", (/** @type {Element} */ input, /** @type {string} */ t) => input.setAttribute("type", t), type);
        await page.fill("input", `text ${type}`);
        assert.equal(await page.evaluate("window.result"), `text ${type}`);
      }
    });

    test(`FI-005 (${lane}) should fill range input`, async () => {
      const page = open(lane);
      await page.setContent("<input type=range min=0 max=100 value=50>");
      await page.fill("input", "42");
      assert.equal(await valueOf(page, "input"), "42");
      for (const [value, expected] of /** @type {const} */ ([["42.0", 42], ["1e1", 10]])) {
        await page.fill("input", value);
        assert.equal(await page.$eval("input", (/** @type {HTMLInputElement} */ e) => e.valueAsNumber), expected);
      }
    });

    test(`FI-006 / FI-007 (${lane}) should fill color input, case-insensitively`, async () => {
      const page = open(lane);
      await page.setContent('<input type=color value="#e66465">');
      await page.fill("input", "#aaaaaa");
      assert.equal(await valueOf(page, "input"), "#aaaaaa");
      await page.fill("input", "#AbCd00");
      assert.equal(await valueOf(page, "input"), "#abcd00");
    });

    test(`FI-009 (${lane}) input event is composed and crosses the shadow boundary`, async () => {
      const page = open(lane);
      for (const [type, value] of Object.entries(COMPOSED_TYPES)) {
        await page.setContent(`<body><script>const div = document.createElement('div'); const shadowRoot = div.attachShadow({mode: 'open'});
          shadowRoot.innerHTML = '<input type=${type}></input>'; document.body.appendChild(div);</script></body>`);
        await page.evaluate(() => {
          const w = /** @type {any} */ (window);
          w.firedBodyEvents = [];
          w.firedEvents = [];
          const input = /** @type {Element} */ (document.querySelector("div")?.shadowRoot?.querySelector("input"));
          for (const event of ["input", "change"]) {
            document.body.addEventListener(event, (e) => w.firedBodyEvents.push(`${e.type}:${e.composed}`), false);
            input.addEventListener(event, (e) => w.firedEvents.push(`${e.type}:${e.composed}`), false);
          }
        });
        await page.fill("input", value);
        assert.deepEqual(await page.evaluate("window.firedEvents"), ["input:true", "change:false"], type);
        assert.deepEqual(await page.evaluate("window.firedBodyEvents"), ["input:true"], type);
      }
    });

    test(`FI-010 / FI-011 / FI-012 / FI-013 (${lane}) should fill time, month, week and datetime-local inputs`, async () => {
      const page = open(lane);
      for (const [type, value, expected] of [
        ["time", "13:15", "13:15"],
        ["month", "2020-07", "2020-07"],
        ["week", "2020-W50", "2020-W50"],
        ["datetime-local", "2020-03-02T05:15", "2020-03-02T05:15"],
        ["datetime-local", "2020-03-02T06:20:00", "2020-03-02T06:20"],
      ]) {
        await page.setContent(`<input type=${type}>`);
        await page.fill("input", value);
        assert.equal(await valueOf(page, "input"), expected, type);
      }
    });

    test(`FI-014 / FI-015 (${lane}) should fill contenteditable, also with new lines`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/textarea.html`);
      await page.fill("div[contenteditable]", "some value");
      assert.equal(await page.$eval("div[contenteditable]", (/** @type {HTMLElement} */ div) => div.textContent), "some value");
      await page.setContent(`<div contenteditable="true"></div>`);
      await page.fill("div[contenteditable]", "John\nDoe");
      assert.equal(await page.$eval("div[contenteditable]", (/** @type {HTMLElement} */ div) => div.innerText), "John\nDoe");
    });

    test(`FI-016 (${lane}) should not double-fill a contenteditable with a beforeinput handler`, async () => {
      const page = open(lane);
      await page.setContent(`<div id="editor" contenteditable="true"></div>
        <script>const editor = document.getElementById('editor'); editor.addEventListener('beforeinput', (event) => { event.preventDefault(); editor.textContent = event.data; });</script>`);
      await page.fill("#editor", "Playwright");
      assert.equal(await page.$eval("#editor", (/** @type {HTMLElement} */ e) => e.textContent), "Playwright");
    });

    test(`FI-017 (${lane}) should fill elements with existing value and selection`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/textarea.html`);
      await page.$eval("input", (/** @type {HTMLInputElement} */ input) => (input.value = "value one"));
      await page.fill("input", "another value");
      assert.equal(await page.evaluate("window.result"), "another value");
      await page.$eval("input", (/** @type {HTMLInputElement} */ input) => {
        input.selectionStart = 1;
        input.selectionEnd = 2;
      });
      await page.fill("input", "maybe this one");
      assert.equal(await page.evaluate("window.result"), "maybe this one");
      await page.$eval("div[contenteditable]", (/** @type {HTMLElement} */ div) => {
        div.innerHTML = "some text <span>some more text<span> and even more text";
        const range = document.createRange();
        range.selectNodeContents(/** @type {Node} */ (div.querySelector("span")));
        const selection = /** @type {Selection} */ (window.getSelection());
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await page.fill("div[contenteditable]", "replace with this");
      assert.equal(await page.$eval("div[contenteditable]", (/** @type {HTMLElement} */ div) => div.textContent), "replace with this");
    });

    test(`FI-020 / FI-021 / FI-022 (${lane}) should retry on a disabled, a readonly and an invisible element`, async () => {
      for (const [selector, block, unblock] of [
        ["input", "i.disabled = true", "i.disabled = false"],
        ["textarea", "i.readOnly = true", "i.readOnly = false"],
        ["input", "i.style.display = 'none'", "i.style.display = 'inline'"],
      ]) {
        const page = open(lane);
        await page.goto(`${PREFIX()}/input/textarea.html`);
        await page.evaluate(`(() => { const i = document.querySelector('${selector}'); ${block}; })()`);
        let done = false;
        const filled = page.fill(selector, "some value", { timeout: 0 }).then(() => (done = true));
        await giveItAChanceToFill();
        assert.equal(done, false, block);
        assert.equal(await page.evaluate("window.result"), "");
        await page.evaluate(`(() => { const i = document.querySelector('${selector}'); ${unblock}; })()`);
        await filled;
        assert.equal(await page.evaluate("window.result"), "some value", block);
      }
    });

    test(`FI-023 / FI-024 (${lane}) should fill the body and a fixed position input`, async () => {
      const page = open(lane);
      await page.setContent(`<body contentEditable="true"></body>`);
      await page.fill("body", "some value");
      assert.equal(await page.evaluate(() => document.body.textContent), "some value");
      await page.setContent(`<input style='position: fixed;' />`);
      await page.fill("input", "some value");
      assert.equal(await valueOf(page, "input"), "some value");
    });

    test(`FI-026 / FI-027 / FI-028 (${lane}) should fill input[type=number] with a number, an exponent and nothing`, async () => {
      const page = open(lane);
      await page.setContent(`<input id="input" type="number" value="123"></input>`);
      for (const value of ["42", "-10e5", ""]) {
        await page.fill("input", value);
        assert.equal(await page.evaluate("window.input.value"), value);
      }
    });

    test(`FI-029 (${lane}) should not fill text into input[type=number]`, async () => {
      const page = open(lane);
      await page.setContent(`<input id="input" type="number"></input>`);
      const error = await failsWith(page.fill("input", "abc", { timeout: 1000 }), "TARGET_NOT_EDITABLE");
      assert.match(error.message, /number/);
    });

    test(`FI-030 / FI-032 (${lane}) should clear with an empty string; back-to-back fills keep both`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/textarea.html`);
      await page.fill("input", "some value");
      assert.equal(await page.evaluate("window.result"), "some value");
      await page.fill("input", "");
      assert.equal(await page.evaluate("window.result"), "");
      await page.setContent(`<input id="one"></input><input id="two"></input>`);
      await page.fill("id=one", "first value");
      await page.fill("id=two", "second value");
      assert.deepEqual([await valueOf(page, "id=one"), await valueOf(page, "id=two")], ["first value", "second value"]);
    });

    test(`FI-031 (${lane}) should not throw when fill causes navigation`, async () => {
      const page = open(lane);
      await page.setContent("<input type=date>");
      await page.$eval("input", (/** @type {HTMLInputElement} */ input, /** @type {string} */ to) => input.addEventListener("input", () => (window.location.href = to)), `${PREFIX()}/empty.html`);
      await page.fill("input", "2020-03-02");
      for (let i = 0; i < 30 && !(await page.url()).includes("empty.html"); i++) await sleep(100);
      assert.match(await page.url(), /empty\.html/);
    });

    test(`FI-033 (${lane}) should fill a contenteditable whose focus handler collapses the selection`, async () => {
      const page = open(lane);
      await page.setContent(`<div contenteditable="true">initial text</div>
        <script>const editor = document.querySelector('[contenteditable]'); editor.addEventListener('focus', () => { const selection = window.getSelection(); if (selection.rangeCount > 0) selection.collapseToEnd(); });</script>`);
      await page.fill("div[contenteditable]", "some value");
      assert.equal(await page.$eval("div[contenteditable]", (/** @type {HTMLElement} */ div) => div.textContent), "some value");
    });

    test(`FI-034 / FI-036 (${lane}) should retry on an inert element, and time out with TARGET_DISABLED`, async () => {
      const page = open(lane);
      await page.setContent(`<div inert id=container><input id=target></div><input id=outside>`);
      await page.$eval("#outside", (/** @type {HTMLElement} */ e) => e.focus());
      let done = false;
      const filled = page.fill("#target", "some value", { timeout: 0 }).then(() => (done = true));
      await giveItAChanceToFill();
      assert.equal(done, false);
      assert.deepEqual([await valueOf(page, "#target"), await valueOf(page, "#outside")], ["", ""]);
      await page.$eval("#container", (/** @type {Element} */ e) => e.removeAttribute("inert"));
      await filled;
      assert.deepEqual([await valueOf(page, "#target"), await valueOf(page, "#outside")], ["some value", ""]);
      await page.setContent(`<div inert><input></div>`);
      await failsWith(page.fill("input", "some value", { timeout: 1000 }), "TARGET_DISABLED");
    });

    test(`KB-001 (${lane}) should type into a textarea key by key`, async () => {
      const page = open(lane);
      await page.setContent("<textarea></textarea>");
      const text = "Hello world. I am the text that was typed!";
      await h.ok("type", { target: "textarea", text, slowly: true, ...(lane === "cdp" && { trusted: true }) }, page.session);
      assert.equal(await valueOf(page, "textarea"), text);
    });

    test(`KB-007 (${lane}) typing a character emits keydown, keypress, textInput, input, keyup`, async () => {
      const page = open(lane);
      await page.setContent(`<input><script>window.__events = []; for (const type of ['keydown', 'keypress', 'textInput', 'input', 'keyup']) document.querySelector('input').addEventListener(type, () => window.__events.push(type));</script>`);
      await h.ok("type", { target: "input", text: "f", slowly: true, ...(lane === "cdp" && { trusted: true }) }, page.session);
      assert.deepEqual(await page.evaluate("window.__events"), ["keydown", "keypress", "textInput", "input", "keyup"]);
    });
  });
}
