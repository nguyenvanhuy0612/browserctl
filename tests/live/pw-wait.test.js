// @ts-check
// Playwright's waitForSelector cases adopted by ID (specs/tools/wait_for.md), through wait_for in
// the DOM lane, and playwright-mcp's wait.spec.ts. Sources: page-wait-for-selector-1.spec.ts.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { refIn, sleep, startHarness } from "./harness.js";
import { PwError, failsWith, pwPage } from "./pw.js";

/** @type {import("./harness.js").Harness} */
let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h?.close();
});

const EMPTY = () => `${h.base}/pw/empty.html`;
const open = () => pwPage(h, h.newSession(), "dom");
/** Playwright's addElement. @param {ReturnType<typeof pwPage>} page @param {string} tag */
const addElement = (page, tag) => page.evaluate((/** @type {string} */ t) => void document.body.appendChild(document.createElement(t)), tag);
/** The text of the element `target` matches. @param {ReturnType<typeof pwPage>} page @param {string} target */
const textOf = async (page, target) => (await h.ok("get", { target }, page.session)).value;
/** A wait_for call. @param {ReturnType<typeof pwPage>} page @param {object} params */
const waitFor = async (page, params) => {
  const r = await h.call("wait_for", params, page.session);
  if (!r.ok) throw new PwError(r.error);
  return r;
};

describe("wait_for", () => {
  test("WA-027 an unknown option is refused and the valid ones are named", async () => {
    const page = open();
    await page.goto(EMPTY());
    const error = await failsWith(waitFor(page, { target: "*", waitFor: "attached" }), "INVALID_PARAMS");
    assert.match(error.message, /waitFor/);
    const r = await h.call("wait_for", { target: "*", waitFor: "attached" }, page.session);
    assert.match(r.error.hint, /state/);
  });

  test("WA-029 / WA-035 an existing node resolves at once; an added node resolves the wait", async () => {
    const page = open();
    await page.goto(EMPTY());
    await addElement(page, "div");
    const now = await waitFor(page, { target: "div", state: "attached" });
    assert.ok(now.waitedMs < 500);
    await page.goto(EMPTY());
    const watchdog = waitFor(page, { target: "div", state: "attached" });
    await addElement(page, "br");
    await addElement(page, "div");
    assert.equal((await watchdog).matched.role, "div");
  });

  test("WA-030 / WA-031 / WA-032 waits inside an element's subtree resolve, wait and time out", async () => {
    const page = open();
    await page.setContent(`<span>extra</span><div><span>target</span></div>`);
    await waitFor(page, { target: "div >> span", state: "attached" });
    assert.equal(await textOf(page, "div >> span"), "target");
    await page.setContent(`<div></div>`);
    const watchdog = waitFor(page, { target: "div >> span", state: "attached" });
    await sleep(300);
    await page.$eval("div", (/** @type {Element} */ div) => (div.innerHTML = "<span>target</span>"));
    await watchdog;
    assert.equal(await textOf(page, "div >> span"), "target");
    await page.setContent(`<div></div>`);
    await failsWith(waitFor(page, { target: "div >> span", timeout: 0.1 }), "TIMEOUT");
  });

  test("WA-034 waiting works when the page removed MutationObserver", async () => {
    const page = open();
    await page.goto(EMPTY());
    await page.evaluate(() => delete (/** @type {any} */ (window).MutationObserver));
    const watchdog = waitFor(page, { target: ".zombo" });
    await page.evaluate(() => (document.body.innerHTML = "<div class='zombo'>anything</div>"));
    await watchdog;
    assert.equal(await textOf(page, ".zombo"), "anything");
  });

  test("WA-036 a timeout waiting for visible names the hidden element last seen", async () => {
    const page = open();
    await page.goto(EMPTY());
    const watchdog = waitFor(page, { target: "div", timeout: 1.5 });
    await page.evaluate(() => {
      const div = document.createElement("div");
      div.className = "foo bar";
      div.id = "mydiv";
      div.setAttribute("style", "display: none");
      div.textContent = "abcdefghijklmnopqrstuvwyxz";
      document.body.appendChild(div);
    });
    const error = await failsWith(watchdog, "TIMEOUT");
    assert.match(error.message, /last seen: hidden /);
  });

  test("WA-037 a timeout waiting for hidden names the visible element last seen", async () => {
    const page = open();
    await page.goto(EMPTY());
    await page.evaluate(() => {
      const div = document.createElement("div");
      div.id = "mydiv";
      div.textContent = "hello";
      document.body.appendChild(div);
    });
    const error = await failsWith(waitFor(page, { target: "div", state: "hidden", timeout: 1 }), "TIMEOUT");
    assert.match(error.message, /last seen: visible div/);
  });

  test("WA-038 a click whose selector matches two buttons lists both", async () => {
    const page = open();
    await page.setContent(`<button style="display: none; position: absolute; top: 0px; left: 0px; width: 100%;">Reset</button><button>Reset</button>`);
    const r = await h.call("click", { target: "text=Reset", timeout: 1 }, page.session);
    assert.equal(r.error.code, "AMBIGUOUS_TARGET");
    assert.equal(r.error.candidates.length, 2);
  });

  test("WA-039 / WA-040 nodes added in a shadow root or through innerHTML resolve the wait", async () => {
    const page = open();
    await page.goto(EMPTY());
    const shadow = waitFor(page, { target: "span" });
    await page.evaluate(() => {
      const div = document.createElement("div");
      div.attachShadow({ mode: "open" });
      document.body.appendChild(div);
    });
    await sleep(100);
    await page.evaluate(() => {
      const span = document.createElement("span");
      span.textContent = "Hello from shadow";
      document.querySelector("div")?.shadowRoot?.appendChild(span);
    });
    await shadow;
    assert.equal(await textOf(page, "span"), "Hello from shadow");
    await page.goto(EMPTY());
    const inner = waitFor(page, { target: "h3 div", state: "attached" });
    await addElement(page, "span");
    await page.evaluate(() => (/** @type {Element} */ (document.querySelector("span")).innerHTML = "<h3><div></div></h3>"));
    await inner;
  });

  test("WA-041 a selector waits in the main frame only", async () => {
    const page = open();
    await page.goto(EMPTY());
    await page.evaluate((/** @type {string} */ src) => new Promise((resolve) => {
      const frame = document.createElement("iframe");
      frame.src = src;
      frame.onload = () => resolve(true);
      document.body.appendChild(frame);
    }), EMPTY());
    const watchdog = waitFor(page, { target: "div", state: "attached", timeout: 5 });
    await page.evaluate(() => void /** @type {HTMLIFrameElement} */ (document.querySelector("iframe")).contentDocument?.body.appendChild(document.createElement("div")));
    await sleep(500);
    await addElement(page, "div");
    const r = await watchdog;
    assert.ok(r.waitedMs >= 450, `matched only when the main frame had a div (${r.waitedMs} ms)`);
  });
});

describe("wait_for, playwright-mcp wait.spec.ts", () => {
  const PAGE = `<script>function update() { setTimeout(() => { document.querySelector('div').textContent = 'Text to appear'; }, 1000); }</script>
    <body><button onclick="update()">Click me</button><div>Text to disappear</div></body>`;

  test("WAIT-E04 / WAIT-E05 text that appears and text that goes after a click", async () => {
    for (const condition of [{ text: "Text to appear" }, { textGone: "Text to disappear" }]) {
      const page = open();
      await page.setContent(PAGE);
      await page.click(/** @type {string} */ (refIn((await h.ok("snapshot", {}, page.session)).snapshot, 'button "Click me"')));
      await waitFor(page, condition);
      assert.match((await h.ok("snapshot", {}, page.session)).snapshot, /Text to appear/);
    }
  });

  test("WAIT-E06 time waits that long, and more than 60 s is refused", async () => {
    const page = open();
    await page.setContent("<div>Hello World</div>");
    const started = Date.now();
    const r = await waitFor(page, { time: 1 });
    assert.ok(Date.now() - started >= 950 && r.waitedMs >= 950);
    await failsWith(waitFor(page, { time: 70 }), "INVALID_PARAMS");
  });
});
