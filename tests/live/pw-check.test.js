// @ts-check
// Playwright's check cases adopted by ID (specs/tools/fill_form.md): fill_form with a boolean value,
// in the DOM lane and with trusted: true. Source: page-check.spec.ts in Playwright's tests/page.
import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { startHarness } from "./harness.js";
import { LANES, failsWith, pwPage } from "./pw.js";

/** @type {import("./harness.js").Harness} */
let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h?.close();
});
// each test opens its own tabs: close them so a long file does not pile tabs up
afterEach(() => h.closeTabs());

/** @param {"dom" | "cdp"} lane */
const open = (lane) => pwPage(h, h.newSession(), lane);

const ARIA_CHECKABLE = ["checkbox", "menuitemcheckbox", "option", "radio", "switch", "menuitemradio", "treeitem"];

for (const lane of LANES) {
  describe(`check, ${lane} lane`, () => {
    test(`CH-001 / CH-002 (${lane}) should check the box, and leave a checked box checked`, async () => {
      const page = open(lane);
      await page.setContent(`<input id='checkbox' type='checkbox'></input>`);
      await page.check("input");
      assert.equal(await page.evaluate("window.checkbox.checked"), true);
      await page.check("input");
      assert.equal(await page.evaluate("window.checkbox.checked"), true);
    });

    test(`CH-003 / CH-004 (${lane}) should uncheck the box, and leave an unchecked box unchecked`, async () => {
      const page = open(lane);
      await page.setContent(`<input id='checkbox' type='checkbox' checked></input>`);
      await page.uncheck("input");
      assert.equal(await page.evaluate("window.checkbox.checked"), false);
      await page.uncheck("input");
      assert.equal(await page.evaluate("window.checkbox.checked"), false);
    });

    test(`CH-005 (${lane}) should check radio`, async () => {
      const page = open(lane);
      await page.setContent(`<input type='radio'>one</input><input id='two' type='radio'>two</input><input type='radio'>three</input>`);
      await page.check("#two");
      assert.equal(await page.evaluate("window.two.checked"), true);
    });

    test(`CH-006 / CH-007 (${lane}) should check and uncheck radio by aria role`, async () => {
      const page = open(lane);
      await page.setContent(`<div role='radio' id='checkbox'>CHECKBOX</div><script>checkbox.addEventListener('click', () => checkbox.setAttribute('aria-checked', 'true'));</script>`);
      await page.check("div");
      assert.equal(await page.evaluate("window.checkbox.getAttribute('aria-checked')"), "true");
      await page.setContent(`<div role='radio' id='checkbox' aria-checked="true">CHECKBOX</div><script>checkbox.addEventListener('click', () => checkbox.setAttribute('aria-checked', 'false'));</script>`);
      await page.uncheck("div");
      assert.equal(await page.evaluate("window.checkbox.getAttribute('aria-checked')"), "false");
    });

    test(`CH-008 / CH-009 (${lane}) should check and uncheck every aria-checked role`, async () => {
      const page = open(lane);
      for (const role of ARIA_CHECKABLE) {
        await page.setContent(`<div role='${role}' id='checkbox'>CHECKBOX</div><script>checkbox.addEventListener('click', () => checkbox.setAttribute('aria-checked', 'true'));</script>`);
        await page.check("div");
        assert.equal(await page.evaluate("window.checkbox.getAttribute('aria-checked')"), "true", role);
        await page.setContent(`<div role='${role}' id='checkbox' aria-checked="true">CHECKBOX</div><script>checkbox.addEventListener('click', () => checkbox.setAttribute('aria-checked', 'false'));</script>`);
        await page.uncheck("div");
        assert.equal(await page.evaluate("window.checkbox.getAttribute('aria-checked')"), "false", role);
      }
    });

    test(`CH-010 / CH-011 (${lane}) should refuse an element that is not a checkbox`, async () => {
      const page = open(lane);
      for (const html of [`<div>Check me</div>`, `<div role=button>Check me</div>`]) {
        await page.setContent(html);
        const error = await failsWith(page.check("div"), "INVALID_PARAMS");
        assert.match(error.message, /not a checkbox|does not take a boolean|boolean/i);
      }
    });

    test(`CH-012 (${lane}) should check the box inside a button`, async () => {
      const page = open(lane);
      await page.setContent(`<div role='button'><input type='checkbox'></div>`);
      await page.check("input");
      assert.equal(await page.$eval("input", (/** @type {HTMLInputElement} */ input) => input.checked), true);
    });

    test(`CH-013 (${lane}) should check through a label that also holds a link, without following the link`, async () => {
      const page = open(lane);
      await page.setContent(`<input id='checkbox' type='checkbox' style='width: 5px; height: 5px;'>
        <label for='checkbox'><a href="${h.base}/pw/empty.html">I am a long link that goes away so that nothing good will happen if you click on me</a> Click me</label>`);
      const r = await page.check("text=Click me");
      assert.equal(r.outcome.urlChanged, false);
      assert.equal(await page.$eval("input", (/** @type {HTMLInputElement} */ input) => input.checked), true);
    });

    test(`CH-016 (${lane}) should check and uncheck with setChecked`, async () => {
      const page = open(lane);
      await page.setContent(`<input id='checkbox' type='checkbox'></input>`);
      await page.setChecked("input", true);
      assert.equal(await page.evaluate("window.checkbox.checked"), true);
      await page.setChecked("input", false);
      assert.equal(await page.evaluate("window.checkbox.checked"), false);
    });

    test(`CH-017 (${lane}) should refuse to uncheck a radio button`, async () => {
      const page = open(lane);
      await page.setContent(`<input type='radio' name='test' checked id='radio'>`);
      const error = await failsWith(page.uncheck("#radio"), "INVALID_PARAMS");
      assert.match(error.message, /radio/);
    });
  });
}
