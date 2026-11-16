// @ts-check
// Playwright's keyboard cases adopted by ID (specs/tools/press_key.md), through press_key and
// type with slowly, in the DOM lane and with trusted: true. Source: page-keyboard.spec.ts.
import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { refIn, sleep, startHarness } from "./harness.js";
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

const PREFIX = () => `${h.base}/pw`;
/** @param {"dom" | "cdp"} lane */
const open = (lane) => pwPage(h, h.newSession(), lane);
/** keyboard.html's log of key events since the last read. @param {ReturnType<typeof pwPage>} page */
const getResult = (page) => page.evaluate("getResult()");
/** @param {ReturnType<typeof pwPage>} page @param {string} selector @param {string} text */
const typeSlowly = (page, selector, text) => h.ok("type", { target: selector, text, slowly: true, ...(page.lane === "cdp" && { trusted: true }) }, page.session);

for (const lane of LANES) {
  describe(`keyboard, ${lane} lane`, () => {
    test(`KB-003 (${lane}) should send a character with press, and not when keydown is cancelled`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/textarea.html`);
      await page.press("textarea", "a");
      assert.equal(await page.evaluate(() => document.querySelector("textarea")?.value), "a");
      await page.evaluate(() => window.addEventListener("keydown", (e) => e.preventDefault(), true));
      await page.press("textarea", "b");
      assert.equal(await page.evaluate(() => document.querySelector("textarea")?.value), "a");
    });

    test(`KB-009 (${lane}) should report shiftKey, altKey and ctrlKey with their own key events`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/keyboard.html`);
      for (const modifier of ["Shift", "Alt", "Control"]) {
        await page.press("textarea", `${modifier}+!`);
        const keypress = modifier === "Shift" ? [`Keypress: ! Digit1 STANDARD 33 [${modifier}]`] : [];
        assert.equal(
          await getResult(page),
          [`Keydown: ${modifier} ${modifier}Left LEFT [${modifier}]`, `Keydown: ! Digit1 STANDARD [${modifier}]`, ...keypress, `Keyup: ! Digit1 STANDARD [${modifier}]`, `Keyup: ${modifier} ${modifier}Left LEFT []`].join("\n"),
          modifier,
        );
      }
    });

    test(`KB-010 (${lane}) should report multiple modifiers`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/keyboard.html`);
      await page.press("textarea", "Control+Alt+;");
      assert.equal(
        await getResult(page),
        ["Keydown: Control ControlLeft LEFT [Control]", "Keydown: Alt AltLeft LEFT [Alt Control]", "Keydown: ; Semicolon STANDARD [Alt Control]", "Keyup: ; Semicolon STANDARD [Alt Control]", "Keyup: Alt AltLeft LEFT [Control]", "Keyup: Control ControlLeft LEFT []"].join("\n"),
      );
    });

    test(`KB-013 (${lane}) should not type cancelled keys`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/textarea.html`);
      await page.evaluate(() =>
        window.addEventListener(
          "keydown",
          (event) => {
            event.stopPropagation();
            event.stopImmediatePropagation();
            if (event.key === "l" || event.key === "o") event.preventDefault();
          },
          false,
        ),
      );
      await typeSlowly(page, "textarea", "Hello World!");
      assert.equal(await page.$eval("textarea", (/** @type {HTMLTextAreaElement} */ t) => t.value), "He Wrd!");
    });

    test(`KB-014 / KB-015 / KB-016 / KB-017 (${lane}) should press plus, shift plus and plus-separated modifiers`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/keyboard.html`);
      await page.press("textarea", "+");
      assert.equal(await getResult(page), ["Keydown: + Equal STANDARD []", "Keypress: + Equal STANDARD 43 []", "Keyup: + Equal STANDARD []"].join("\n"));
      await page.press("textarea", "Shift++");
      assert.equal(await getResult(page), ["Keydown: Shift ShiftLeft LEFT [Shift]", "Keydown: + Equal STANDARD [Shift]", "Keypress: + Equal STANDARD 43 [Shift]", "Keyup: + Equal STANDARD [Shift]", "Keyup: Shift ShiftLeft LEFT []"].join("\n"));
      await page.press("textarea", "Shift+~");
      assert.equal(await getResult(page), ["Keydown: Shift ShiftLeft LEFT [Shift]", "Keydown: ~ Backquote STANDARD [Shift]", "Keypress: ~ Backquote STANDARD 126 [Shift]", "Keyup: ~ Backquote STANDARD [Shift]", "Keyup: Shift ShiftLeft LEFT []"].join("\n"));
      await page.press("textarea", "Control+Shift+~");
      assert.equal(
        await getResult(page),
        ["Keydown: Control ControlLeft LEFT [Control]", "Keydown: Shift ShiftLeft LEFT [Control Shift]", "Keydown: ~ Backquote STANDARD [Control Shift]", "Keyup: ~ Backquote STANDARD [Control Shift]", "Keyup: Shift ShiftLeft LEFT [Control]", "Keyup: Control ControlLeft LEFT []"].join("\n"),
      );
    });

    test(`KB-025 (${lane}) should press Enter, NumpadEnter, \\n and \\r into a textarea`, async () => {
      const page = open(lane);
      await page.setContent(`<textarea></textarea><script>window.__last = null; document.querySelector('textarea').addEventListener('keydown', (e) => { window.__last = { key: e.key, code: e.code }; });</script>`);
      for (const [key, expectedKey, expectedCode] of [
        ["Enter", "Enter", "Enter"],
        ["NumpadEnter", "Enter", "NumpadEnter"],
        ["\n", "Enter", "Enter"],
        ["\r", "Enter", "Enter"],
      ]) {
        await page.press("textarea", key);
        assert.deepEqual(await page.evaluate("window.__last"), { key: expectedKey, code: expectedCode }, JSON.stringify(key));
        assert.equal(await page.$eval("textarea", (/** @type {HTMLTextAreaElement} */ t) => t.value), "\n", JSON.stringify(key));
        await page.$eval("textarea", (/** @type {HTMLTextAreaElement} */ t) => (t.value = ""));
      }
    });

    test(`KB-027 (${lane}) should refuse unknown keys`, async () => {
      const page = open(lane);
      await page.setContent("<input>");
      for (const key of ["NotARealKey", "ё", "😊"]) await failsWith(page.keyboard.press(key), "INVALID_PARAMS");
    });

    test(`KB-030 (${lane}) should handle selectAll`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/textarea.html`);
      await typeSlowly(page, "textarea", "some text");
      await page.press("textarea", "ControlOrMeta+a");
      await page.keyboard.press("Backspace");
      assert.equal(await page.$eval("textarea", (/** @type {HTMLTextAreaElement} */ t) => t.value), "");
    });

    test(`KB-038 (${lane}) should scroll with PageDown`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/scrollable.html`);
      await page.keyboard.press("PageDown");
      for (let i = 0; i < 20 && !((await page.evaluate("scrollY")) > 0); i++) await sleep(100);
      assert.ok((await page.evaluate("scrollY")) > 0);
    });

    test(`KB-041 (${lane}) should click a focused button when Space is pressed`, async () => {
      const page = open(lane);
      await page.setContent(`<button type="button">a11y</button><script>window.__clicked = false; document.querySelector('button').addEventListener('click', () => (window.__clicked = true));</script>`);
      await page.press("button", "Space");
      assert.equal(await page.evaluate("window.__clicked"), true);
    });

    test(`KEY-E06 (${lane}) a key without target goes to the textbox focused by a click`, async () => {
      const page = open(lane);
      await page.setContent("<input type=text>");
      const ref = /** @type {string} */ (refIn((await h.ok("snapshot", {}, page.session)).snapshot, "textbox"));
      await page.click(ref);
      await page.keyboard.press("h");
      assert.match((await h.ok("snapshot", {}, page.session)).snapshot, /textbox .*\[ref=e\d+\]: h/);
    });
  });
}

describe("keyboard, CDP lane only", () => {
  test("KB-002 arrows move the caret inside a textarea and Shift+arrows select", async () => {
    const page = open("cdp");
    await page.goto(`${PREFIX()}/input/textarea.html`);
    await typeSlowly(page, "textarea", "Hello World!");
    for (let i = 0; i < "World!".length; i++) await page.keyboard.press("ArrowLeft");
    await h.ok("press_key", { key: "i", trusted: true }, page.session);
    for (const ch of "nserted ") await h.ok("press_key", { key: ch === " " ? "Space" : ch, trusted: true }, page.session);
    assert.equal(await page.evaluate(() => document.querySelector("textarea")?.value), "Hello inserted World!");
    for (let i = 0; i < "inserted ".length; i++) await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Backspace");
    assert.equal(await page.evaluate(() => document.querySelector("textarea")?.value), "Hello World!");
  });
});

describe("key aliases in the CDP lane", () => {
  test("KEY-E07 Esc and Ctrl+a reach Playwright as Escape and Control+a", async () => {
    const page = open("cdp");
    await page.goto(`${h.base}/keys.html`);
    await page.keyboard.press("Esc");
    assert.equal(await page.evaluate(() => document.querySelector("#modal")), null);
    await typeSlowly(page, "#guarded", "abc");
    await page.press("#guarded", process.platform === "darwin" ? "Cmd+a" : "Ctrl+a");
    assert.deepEqual(await page.$eval("#guarded", (/** @type {HTMLInputElement} */ i) => [i.selectionStart, i.selectionEnd]), [0, 3]);
  });
});
