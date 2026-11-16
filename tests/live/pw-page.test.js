// @ts-check
// Playwright's dialog, goto, wheel and screenshot cases adopted by ID (specs/tools/handle_dialog.md,
// navigate.md, scroll.md, take_screenshot.md), and playwright-mcp's dialogs.spec.ts and
// screenshot.spec.ts. Sources: page-dialog, page-goto, wheel and page-screenshot specs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { refIn, sleep, startHarness } from "./harness.js";
import { LANES, failsWith, pwPage } from "./pw.js";

/** @type {import("./harness.js").Harness} */
let h;
/** @type {string} */
let scratch;
before(async () => {
  h = await startHarness();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bctl-pw-page-"));
});
after(async () => {
  await h?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});
// each test opens its own tabs: close them so a long file does not pile tabs up
afterEach(() => h.closeTabs());

const EMPTY = () => `${h.base}/pw/empty.html`;
/** @param {"dom" | "cdp"} lane */
const open = (lane) => pwPage(h, h.newSession(), lane);
/** @param {ReturnType<typeof pwPage>} page @param {object} params */
const answer = (page, params) => h.ok("handle_dialog", params, page.session);

for (const lane of LANES) {
  describe(`dialogs, ${lane} lane`, () => {
    test(`DI-005 / DI-006 (${lane}) a prompt is accepted with text, or dismissed`, async () => {
      const page = open(lane);
      await page.goto(EMPTY());
      await answer(page, { accept: true, promptText: "answer!" });
      assert.equal(await page.evaluate(() => prompt("question?", "yes.")), "answer!");
      await answer(page, { accept: false });
      assert.equal(await page.evaluate(() => prompt("question?")), null);
    });

    test(`DI-007 / DI-008 (${lane}) a confirm is accepted or dismissed`, async () => {
      const page = open(lane);
      await page.goto(EMPTY());
      await answer(page, { accept: true });
      assert.equal(await page.evaluate(() => confirm("boolean?")), true);
      await answer(page, { accept: false });
      assert.equal(await page.evaluate(() => confirm("boolean?")), false);
    });

    test(`DI-010 / DI-011 (${lane}) a page that opens several alerts or confirms while loading still loads`, async () => {
      const page = open(lane);
      await page.goto(EMPTY());
      if (lane === "cdp") await page.evaluate("1"); // attach first, so the debugger sees the dialogs
      for (const call of ["alert('Please dismiss this dialog')", "confirm('Please confirm me?')"]) {
        await page.setContent(`<p>Hello World</p><script>${call}; ${call}; ${call};</script>`);
        assert.equal((await h.ok("get", { target: "p" }, page.session)).value, "Hello World");
      }
    });
  });
}

describe("dialogs, playwright-mcp dialogs.spec.ts", () => {
  test("DLG-E07 alerts, confirms and a prompt opened by clicks are reported with the answers given", async () => {
    const page = open("dom");
    await page.setContent(`<button onclick="alert('Alert')">Alert</button><button onclick="alert('Alert 1'); alert('Alert 2')">Two</button>
      <button onclick="window.__confirm = confirm('Confirm')">Confirm</button><button onclick="window.__prompt = prompt('Prompt')">Prompt</button>`);
    const snapshot = (await h.ok("snapshot", {}, page.session)).snapshot;
    /** @param {string} name */
    const click = async (name) => (await page.click(/** @type {string} */ (refIn(snapshot, `button "${name}"`)))).outcome.dialogs;
    assert.deepEqual(await click("Alert"), [{ type: "alert", message: "Alert", answer: true }]);
    assert.deepEqual(
      (await click("Two")).map((/** @type {any} */ d) => d.message),
      ["Alert 1", "Alert 2"],
    );
    await answer(page, { accept: true });
    assert.deepEqual(await click("Confirm"), [{ type: "confirm", message: "Confirm", answer: true }]);
    assert.equal(await page.evaluate("window.__confirm"), true);
    assert.deepEqual(await click("Confirm"), [{ type: "confirm", message: "Confirm", answer: false }]);
    await answer(page, { accept: true, promptText: "Answer" });
    assert.deepEqual(await click("Prompt"), [{ type: "prompt", message: "Prompt", answer: "Answer" }]);
    assert.equal(await page.evaluate("window.__prompt"), "Answer");
  });
});

describe("navigate", () => {
  test("NA-001 / NA-006 / NA-021 should go to a page, also cross-process", async () => {
    const page = open("dom");
    assert.equal((await page.goto(EMPTY())).url, EMPTY());
    const cross = `${h.crossOrigin}/pw/empty.html`;
    const r = await page.goto(cross);
    assert.equal(r.url, cross);
    assert.equal(r.settled, true);
  });

  test("NA-014 should go to anchors on the same page", async () => {
    const page = open("dom");
    await page.goto(EMPTY());
    for (const anchor of ["#foo", "#bar"]) assert.equal((await page.goto(`${EMPTY()}${anchor}`)).url, `${EMPTY()}${anchor}`);
  });

  test("NA-015 should follow redirects", async () => {
    const page = open("dom");
    const second = `${h.base}/redirect?to=${encodeURIComponent(EMPTY())}`;
    const r = await page.goto(`${h.base}/redirect?to=${encodeURIComponent(second)}`);
    assert.equal(r.url, EMPTY());
  });

  test("NA-016 should go to about:blank", async () => {
    const page = open("dom");
    await page.goto(EMPTY());
    assert.equal((await page.goto("about:blank")).url, "about:blank");
  });

  test("NA-023 / NA-024 / NA-029 a bad URL, a bad certificate and a refused connection are NAVIGATION_FAILED with Chrome's error", async () => {
    const page = open("dom");
    await page.goto(EMPTY());
    for (const [url, error] of [
      ["asdfasdf", /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/],
      [`${h.secureBase}/pw/empty.html`, /ERR_CERT/],
      ["http://localhost:44123/non-existing-url", /ERR_CONNECTION_REFUSED/],
    ]) {
      const failed = await failsWith(page.goto(/** @type {string} */ (url)), "NAVIGATION_FAILED");
      assert.match(failed.message, /** @type {RegExp} */ (error), String(url));
    }
  });
});

describe("wheel (scroll, trusted)", () => {
  /** Records the last wheel event on `selector`. @param {ReturnType<typeof pwPage>} page @param {string} selector */
  const listenForWheelEvents = (page, selector) =>
    page.$eval(selector, (/** @type {Element} */ element) =>
      element.addEventListener(
        "wheel",
        (event) => {
          const e = /** @type {WheelEvent} */ (event);
          /** @type {any} */ (window).lastEvent = { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey };
        },
        { passive: false },
      ),
    );
  /** @param {ReturnType<typeof pwPage>} page @param {object} params */
  const wheel = (page, params) => h.ok("scroll", { ...params, trusted: true }, page.session);
  const NO_MODIFIERS = { deltaMode: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
  /** @param {ReturnType<typeof pwPage>} page @param {string} expression */
  const until = async (page, expression) => {
    for (let i = 0; i < 30 && !(await page.evaluate(expression)); i++) await sleep(100);
    return page.evaluate(expression);
  };

  test("MO-017 / MO-018 should dispatch wheel events, also after a popup was opened", async () => {
    const page = open("cdp");
    await page.setContent(`<div style="width: 5000px; height: 5000px;"></div>`);
    await listenForWheelEvents(page, "div");
    await wheel(page, { direction: "down", amount: 100 });
    assert.equal(await until(page, "window.scrollY === 100"), true);
    assert.deepEqual(await page.evaluate("window.lastEvent"), { deltaX: 0, deltaY: 100, ...NO_MODIFIERS });
    await h.ok("evaluate", { function: "() => { window.open(''); }", trusted: true }, page.session);
    await wheel(page, { direction: "down", amount: 100 });
    assert.equal(await until(page, "window.scrollY === 200"), true);
  });

  test("MO-019 should dispatch a wheel event on an svg element", async () => {
    const page = open("cdp");
    await page.setContent(`<body><svg class="scroll-box"></svg></body><style>.scroll-box { position: absolute; top: 0px; left: 0px; background-color: brown; width: 200px; height: 200px; }</style>`);
    await listenForWheelEvents(page, "svg");
    await wheel(page, { target: "svg", direction: "down", amount: 100 });
    assert.equal(await until(page, "!!window.lastEvent"), true);
    assert.deepEqual(await page.evaluate("window.lastEvent"), { deltaX: 0, deltaY: 100, ...NO_MODIFIERS });
  });

  test("MO-020 should scroll when nobody is listening", async () => {
    const page = open("cdp");
    await page.goto(`${h.base}/pw/input/scrollable.html`);
    await wheel(page, { direction: "down", amount: 100 });
    assert.equal(await until(page, "window.scrollY === 100"), true);
  });

  test("MO-022 should scroll horizontally", async () => {
    const page = open("cdp");
    await page.setContent(`<div style="width: 5000px; height: 5000px;"></div>`);
    await listenForWheelEvents(page, "div");
    await wheel(page, { direction: "right", amount: 100 });
    assert.deepEqual(await page.evaluate("window.lastEvent"), { deltaX: 100, deltaY: 0, ...NO_MODIFIERS });
    assert.equal(await until(page, "window.scrollX === 100"), true);
  });

  test("MO-023 a cancelled wheel event does not scroll", async () => {
    const page = open("cdp");
    await page.setContent(`<div style="width: 5000px; height: 5000px;"></div>`);
    await listenForWheelEvents(page, "div");
    await page.evaluate(() => document.querySelector("div")?.addEventListener("wheel", (e) => e.preventDefault()));
    await wheel(page, { direction: "down", amount: 100 });
    assert.equal(await until(page, "!!window.lastEvent"), true);
    assert.equal(await page.evaluate("window.scrollY"), 0);
  });
});

describe("screenshots", () => {
  /** @param {string} file */
  const isPng = (file) => fs.readFileSync(file).subarray(1, 4).toString() === "PNG";
  /** @param {string} file */
  const isJpeg = (file) => fs.readFileSync(file)[0] === 0xff && fs.readFileSync(file)[1] === 0xd8;
  /** @param {ReturnType<typeof pwPage>} page @param {object} params */
  const shot = (page, params) => h.ok("take_screenshot", params, page.session);
  /** @param {ReturnType<typeof pwPage>} page */
  const viewport = (page) => page.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio, document.documentElement.scrollHeight * devicePixelRatio]);

  test("SS-001 / SS-029 the viewport, saved to a .png path", async () => {
    const page = open("cdp");
    await page.goto(`${h.base}/pw/grid.html`);
    const file = path.join(scratch, "screenshot.png");
    const r = await shot(page, { path: file });
    const [width, height] = await viewport(page);
    assert.equal(r.lane, "cdp");
    assert.deepEqual([r.width, r.height], [width, height]);
    assert.ok(isPng(file) && r.bytes > 5000);
  });

  test("SS-011 a full page is taller than the viewport", async () => {
    const page = open("cdp");
    await page.goto(`${h.base}/pw/grid.html`);
    await page.evaluate(() => (document.body.style.height = "3000px"));
    const r = await shot(page, { fullPage: true, format: "png" });
    const [, height, full] = await viewport(page);
    assert.ok(r.height > height && Math.abs(r.height - full) <= 2, JSON.stringify({ r, height, full }));
  });

  test("SS-023 a canvas is captured", async () => {
    const page = open("cdp");
    await page.goto(`${h.base}/pw/screenshots/canvas.html`);
    const r = await shot(page, { format: "png" });
    assert.ok(r.bytes > 1000);
  });

  test("SS-027 screenshots while the page navigates in a loop succeed or fail cleanly", async () => {
    const page = open("cdp");
    await page.goto(`${h.base}/pw/redirectloop1.html`);
    for (let i = 0; i < 10; i++) {
      const r = await h.call("take_screenshot", { fullPage: true }, page.session);
      assert.ok(r.ok || ["TIMEOUT", "TAB_CLOSED", "INTERNAL_ERROR", "REF_NOT_FOUND"].includes(r.error.code), JSON.stringify(r.error));
    }
  });

  test("SS-031 a .jpg or .JPG path gives a JPEG", async () => {
    const page = open("cdp");
    await page.goto(EMPTY());
    for (const name of ["screenshot.jpg", "screenshot.JPG"]) {
      const file = path.join(scratch, name);
      const r = await shot(page, { path: file });
      assert.equal(r.mimeType, "image/jpeg");
      assert.ok(isJpeg(file), name);
    }
    assert.equal((await h.call("take_screenshot", { path: path.join(scratch, "x.jpg"), format: "png" }, page.session)).error.code, "INVALID_PARAMS");
  });

  test("SHOT-E05 viewport, element, nested path, full page, element with full page, dimensions", async () => {
    const page = open("cdp");
    await page.setContent(`<button style="width: 120px; height: 40px">Hello</button><div style="height: 2000px"></div>`);
    const element = await shot(page, { target: /** @type {string} */ (refIn((await h.ok("snapshot", {}, page.session)).snapshot, 'button "Hello"')), format: "png" });
    const ratio = await page.evaluate("devicePixelRatio");
    assert.deepEqual([element.width, element.height], [120 * ratio, 40 * ratio]);
    const nested = path.join(scratch, "sub/dir/output.png");
    await shot(page, { path: nested });
    assert.ok(isPng(nested));
    const full = await shot(page, { fullPage: true });
    assert.ok(full.height > (await viewport(page))[1]);
    assert.equal((await h.call("take_screenshot", { fullPage: true, target: "button" }, page.session)).error.code, "INVALID_PARAMS");
  });
});
