// @ts-check
// Playwright's selectOption cases adopted by ID (specs/tools/fill_form.md): fill_form with an
// option value or label, in the DOM lane and with trusted: true. Source: page-select-option.spec.ts.
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

const SELECT = () => `${h.base}/pw/input/select.html`;
/** Playwright's giveItAChanceToResolve. */
const giveItAChanceToResolve = () => sleep(400);
/** @param {"dom" | "cdp"} lane */
const open = (lane) => pwPage(h, h.newSession(), lane);
/** @param {ReturnType<typeof pwPage>} page */
const events = async (page) => [await page.evaluate("window.result.onInput"), await page.evaluate("window.result.onChange")];
/** @param {ReturnType<typeof pwPage>} page */
const addScarlet = (page) =>
  page.$eval("select", (/** @type {HTMLSelectElement} */ select) => {
    const option = document.createElement("option");
    option.value = "scarlet";
    option.textContent = "Scarlet";
    select.appendChild(option);
  });
/** @param {ReturnType<typeof pwPage>} page */
const selectValue = (page) => page.$eval("select", (/** @type {HTMLSelectElement} */ s) => s.value);

/** A select that hydrates later, as in SO-030..SO-033. @param {string} body @param {string} hydrate */
const hydrating = (body, hydrate) => `${body}<script>function hydrate() { ${hydrate} }</script>`;

for (const lane of LANES) {
  describe(`select, ${lane} lane`, () => {
    test(`SO-001 / SO-002 (${lane}) should select a single option by value`, async () => {
      const page = open(lane);
      await page.goto(SELECT());
      await page.selectOption("select", "blue");
      assert.deepEqual(await events(page), [["blue"], ["blue"]]);
    });

    test(`SO-003 / SO-004 / SO-005 (${lane}) should fall back to the label, also with html whitespace`, async () => {
      const page = open(lane);
      for (const [label, value] of [
        ["Blue", "blue"],
        ["Indigo", "indigo"],
        ["HTML", "html"],
      ]) {
        await page.goto(SELECT());
        await page.selectOption("select", label);
        assert.deepEqual(await events(page), [[value], [value]], label);
      }
    });

    test(`SO-010 / SO-023 (${lane}) a list for a select without multiple is refused`, async () => {
      const page = open(lane);
      await page.goto(SELECT());
      await failsWith(page.selectOption("select", ["blue", "green", "red"]), "INVALID_PARAMS");
      await failsWith(page.selectOption("select", []), "INVALID_PARAMS");
    });

    test(`SO-011 (${lane}) should not throw when select causes navigation`, async () => {
      const page = open(lane);
      await page.goto(SELECT());
      await page.$eval("select", (/** @type {HTMLSelectElement} */ select, /** @type {string} */ to) => select.addEventListener("input", () => (window.location.href = to)), `${h.base}/pw/empty.html`);
      await page.selectOption("select", "blue");
      for (let i = 0; i < 30 && !(await page.url()).includes("empty.html"); i++) await sleep(100);
      assert.match(await page.url(), /empty\.html/);
    });

    test(`SO-012 / SO-022 (${lane}) should select multiple options, and deselect all with an empty list`, async () => {
      const page = open(lane);
      await page.goto(SELECT());
      await page.evaluate("window.makeMultiple()");
      await page.selectOption("select", ["blue", "green", "red"]);
      assert.deepEqual(await events(page), [
        ["blue", "green", "red"],
        ["blue", "green", "red"],
      ]);
      await page.selectOption("select", []);
      assert.equal(await page.$eval("select", (/** @type {HTMLSelectElement} */ s) => [...s.options].every((o) => !o.selected)), true);
    });

    test(`SO-014 / SO-025 (${lane}) events bubble, also when the page redefined Event`, async () => {
      const page = open(lane);
      await page.goto(SELECT());
      await page.evaluate("window.Event = null");
      await page.selectOption("select", "blue");
      assert.deepEqual(await events(page), [["blue"], ["blue"]]);
      assert.deepEqual([await page.evaluate("window.result.onBubblingInput"), await page.evaluate("window.result.onBubblingChange")], [["blue"], ["blue"]]);
    });

    test(`SO-026 / SO-028 (${lane}) should wait for options to be present`, async () => {
      const page = open(lane);
      for (const multiple of [false, true]) {
        await page.goto(SELECT());
        if (multiple) await page.evaluate("window.makeMultiple()");
        let didSelect = false;
        const selecting = page.selectOption("select", multiple ? ["green", "scarlet"] : "scarlet", { timeout: 10000 }).then((r) => ((didSelect = true), r));
        await giveItAChanceToResolve();
        assert.equal(didSelect, false);
        await addScarlet(page);
        const r = await selecting;
        assert.deepEqual(r.fields[0].value, multiple ? ["green", "scarlet"] : ["scarlet"]);
      }
    });

    test(`SO-029 (${lane}) input event is composed and crosses the shadow boundary`, async () => {
      const page = open(lane);
      await page.setContent(`<body><script>const div = document.createElement('div'); const shadowRoot = div.attachShadow({mode: 'open'});
        shadowRoot.innerHTML = '<select><option value="black">Black</option><option value="blue">Blue</option></select>'; document.body.appendChild(div);</script></body>`);
      await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.firedBodyEvents = [];
        w.firedEvents = [];
        const select = /** @type {Element} */ (document.querySelector("div")?.shadowRoot?.querySelector("select"));
        for (const event of ["input", "change"]) {
          document.body.addEventListener(event, (e) => w.firedBodyEvents.push(`${e.type}:${e.composed}`), false);
          select.addEventListener(event, (e) => w.firedEvents.push(`${e.type}:${e.composed}`), false);
        }
      });
      await page.selectOption("select", "blue");
      assert.deepEqual(await page.evaluate("window.firedEvents"), ["input:true", "change:false"]);
      assert.deepEqual(await page.evaluate("window.firedBodyEvents"), ["input:true"]);
    });

    test(`SO-030 / SO-033 (${lane}) should wait for the select to be enabled, or swapped for an enabled one`, async () => {
      const page = open(lane);
      const disabled = `<select disabled><option>one</option><option>two</option></select>`;
      for (const hydrate of [
        "const select = document.querySelector('select'); select.removeAttribute('disabled'); select.addEventListener('change', () => { window.result = select.value; });",
        "document.querySelector('select').remove(); const s = document.createElement('select'); for (const t of ['one', 'two']) { const o = document.createElement('option'); o.textContent = t; s.appendChild(o); } document.body.appendChild(s); s.addEventListener('change', () => { window.result = s.value; });",
      ]) {
        await page.setContent(hydrating(disabled, hydrate));
        const selecting = page.selectOption("select", "two", { timeout: 10000 });
        await sleep(1000);
        await page.evaluate("hydrate()");
        await selecting;
        assert.equal(await page.evaluate("window.result"), "two");
        assert.equal(await selectValue(page), "two");
      }
    });

    test(`SO-031 / SO-032 (${lane}) should wait for an option or its optgroup to be enabled`, async () => {
      const page = open(lane);
      for (const [body, hydrate] of [
        [`<select><option>one</option><option disabled id=myoption>two</option></select>`, "document.querySelector('#myoption').removeAttribute('disabled');"],
        [`<select><option>one</option><optgroup label="Group" disabled id=mygroup><option>two</option></optgroup></select>`, "document.querySelector('#mygroup').removeAttribute('disabled');"],
      ]) {
        await page.setContent(hydrating(body, `${hydrate} const select = document.querySelector('select'); select.addEventListener('change', () => { window.result = select.value; });`));
        await failsWith(page.selectOption("select", "two", { timeout: 1000 }), "TARGET_DISABLED");
        const selecting = page.selectOption("select", "two", { timeout: 10000 });
        await sleep(1000);
        await page.evaluate("hydrate()");
        await selecting;
        assert.equal(await page.evaluate("window.result"), "two");
      }
    });

    test(`SO-034 (${lane}) should wait for the select to become non-inert, and time out with TARGET_DISABLED`, async () => {
      const page = open(lane);
      await page.setContent(`<div inert id=container><select><option>one</option><option>two</option></select></div>`);
      let done = false;
      const selecting = page.selectOption("select", "two", { timeout: 10000 }).then(() => (done = true));
      await giveItAChanceToResolve();
      assert.equal(done, false);
      assert.equal(await selectValue(page), "one");
      await page.evaluate(() => document.getElementById("container")?.removeAttribute("inert"));
      await selecting;
      assert.equal(await selectValue(page), "two");
      await page.evaluate(() => document.getElementById("container")?.setAttribute("inert", ""));
      await failsWith(page.selectOption("select", "one", { timeout: 1000 }), "TARGET_DISABLED");
    });
  });
}
