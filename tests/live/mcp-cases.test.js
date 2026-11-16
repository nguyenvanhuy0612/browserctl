// @ts-check
// playwright-mcp cases adopted under this project's IDs (form, evaluate, click, type and network
// specs in Playwright's tests/mcp): the same pages and the same expectations on our results.
import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { refIn, sleep, startHarness } from "./harness.js";
import { LANES, pwPage } from "./pw.js";

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
const open = (lane = "dom") => pwPage(h, h.newSession(), lane);
/** @param {ReturnType<typeof pwPage>} page @param {string} line */
const refOf = async (page, line) => /** @type {string} */ (refIn((await h.ok("snapshot", {}, page.session)).snapshot, line));

describe("fill_form", () => {
  test("FORM-E06 text, email, range, select and checkbox inside their labels", async () => {
    const page = open();
    await page.setContent(`<form>
      <label><input type="text" id="name" name="name" /> Name</label>
      <label><input type="email" id="email" name="email" /> Email</label>
      <label><input type="range" id="age" name="age" min="18" max="100" /> Age</label>
      <label><select id="country" name="country"><option value="">Choose a country</option><option value="us">United States</option><option value="uk">United Kingdom</option></select> Country</label>
      <label><input type="checkbox" name="subscribe" value="newsletter" /> Subscribe to newsletter</label></form>`);
    const r = await h.ok(
      "fill_form",
      {
        fields: [
          { target: "label=Name", value: "John Doe" },
          { target: "label=Email", value: "john@example.com" },
          { target: "label=Age", value: "25" },
          { target: "label=Country", value: "us" },
          { target: "label=Subscribe to newsletter", value: true },
        ],
      },
      page.session,
    );
    assert.equal(r.failed, null);
    assert.deepEqual(
      r.fields.map((/** @type {any} */ f) => f.value),
      ["John Doe", "john@example.com", "25", ["us"], true],
    );
  });
});

describe("evaluate", () => {
  test("EVAL-E10 title, an element's style by locator, objects, a cycle, an expression and an error", async () => {
    const page = open();
    await page.setContent(`<title>Title</title><div style="background-color: red">Hello</div>`);
    /** @param {object} params */
    const evaluate = (params) => h.call("evaluate", params, page.session);
    assert.equal((await evaluate({ function: "() => document.title" })).value, "Title");
    assert.equal((await evaluate({ function: "element => element.style.backgroundColor", target: "text=Hello" })).value, "red");
    assert.deepEqual((await evaluate({ function: "() => ({ title: document.title, n: 1 })" })).value, { title: "Title", n: 1 });
    assert.deepEqual((await evaluate({ function: "() => { const result = { name: 'x' }; result.self = result; return result; }" })).value, { name: "x", self: "[circular]" });
    assert.equal((await evaluate({ function: "(1+1)" })).value, 2);
    const error = await evaluate({ function: "() => { throw new Error('Oops'); }" });
    assert.equal(error.error.code, "EVAL_ERROR");
    assert.match(error.error.message, /Oops/);
  });
});

for (const lane of LANES) {
  describe(`click, ${lane} lane`, () => {
    test(`CLICK-E12 (${lane}) click, double, right, modifiers, testid and an id that looks like a ref`, async () => {
      const page = open(lane);
      await page.setContent(`<title>Title</title><button data-testid="submit">Submit</button><button id="z2l9e43l3">Lookalike</button><div id="div"></div>
        <script>const log = (t) => (document.getElementById('div').textContent = t);
        const button = document.querySelector('button');
        button.addEventListener('click', (e) => log('click ctrlKey:' + e.ctrlKey + ' metaKey:' + e.metaKey + ' shiftKey:' + e.shiftKey + ' altKey:' + e.altKey));
        button.addEventListener('dblclick', () => log('dblclick'));
        button.addEventListener('contextmenu', (e) => { e.preventDefault(); log('contextmenu'); });
        document.getElementById('z2l9e43l3').addEventListener('click', () => log('lookalike'));</script>`);
      const submit = await refOf(page, 'button "Submit"');
      const seen = () => page.evaluate("document.getElementById('div').textContent");
      await page.click(submit);
      assert.equal(await seen(), "click ctrlKey:false metaKey:false shiftKey:false altKey:false");
      await page.dblclick(submit);
      assert.equal(await seen(), "dblclick");
      await page.click(submit, { button: "right" });
      assert.equal(await seen(), "contextmenu");
      // a real Control+click on macOS is a context click (the OS makes it one), so the CDP lane checks Control elsewhere only
      const controlClicks = lane === "dom" || process.platform !== "darwin";
      for (const [modifiers, flags] of [
        ...(controlClicks ? [[["Control"], "ctrlKey:true metaKey:false shiftKey:false altKey:false"]] : []),
        [["Shift"], "ctrlKey:false metaKey:false shiftKey:true altKey:false"],
        [["Shift", "Alt"], "ctrlKey:false metaKey:false shiftKey:true altKey:true"],
      ]) {
        await page.click(submit, { modifiers: /** @type {string[]} */ (modifiers) });
        assert.equal(await seen(), `click ${flags}`);
      }
      await page.evaluate("document.getElementById('div').textContent = ''");
      await page.click("testid=submit");
      assert.equal(await seen(), "click ctrlKey:false metaKey:false shiftKey:false altKey:false");
      await page.click("#z2l9e43l3");
      assert.equal(await seen(), "lookalike");
    });
  });
}

describe("type", () => {
  test("TYPE-E06 submit sends Enter with the value; slowly sends one keydown per character; no submit sends none", async () => {
    const page = open();
    await page.setContent(`<input type="text"><script>window.__log = []; document.querySelector('input').addEventListener('keydown', (e) => window.__log.push(e.key + ':' + e.target.value));</script>`);
    const input = await refOf(page, "textbox");
    assert.equal((await h.ok("type", { target: input, text: "Hi!", submit: true }, page.session)).value, "Hi!");
    assert.deepEqual(await page.evaluate("window.__log"), ["Enter:Hi!"]);
    await page.evaluate("window.__log = []");
    await h.ok("type", { target: input, text: "Hi!", slowly: true }, page.session);
    assert.deepEqual(await page.evaluate("window.__log"), ["H:", "i:H", "!:Hi"]);
    await page.evaluate("window.__log = []");
    assert.equal((await h.ok("type", { target: input, text: "Bye" }, page.session)).value, "Bye");
    assert.deepEqual(await page.evaluate("window.__log"), []);
  });
});

describe("network_requests", () => {
  test("NET-E05 a click's fetch and a 404, filters, an invalid regex, stable ids, details and a failed request", async () => {
    const page = open();
    await page.setContent(`<button onclick="fetch('/pw/empty.html')">Click me</button><img src="/pw/image.png">`);
    await page.click(await refOf(page, 'button "Click me"'));
    await sleep(300);
    /** @param {object} [params] */
    const list = async (params = {}) => (await h.ok("network_requests", params, page.session)).requests;
    const all = await list();
    const fetched = all.find((/** @type {any} */ r) => r.url.endsWith("/pw/empty.html"));
    const missing = all.find((/** @type {any} */ r) => r.url.endsWith("/pw/image.png"));
    assert.equal(fetched?.status, 200, JSON.stringify(all));
    assert.equal(missing?.status, 404);
    assert.deepEqual((await list({ filter: "empty.html" })).map((/** @type {any} */ r) => r.id), [fetched.id]);
    assert.equal((await h.call("network_requests", { filter: "/[invalid(/" }, page.session)).error.code, "INVALID_PARAMS");
    await page.evaluate("fetch('/pw/empty.html?again')");
    await sleep(300);
    assert.equal((await list()).find((/** @type {any} */ r) => r.id === fetched.id)?.url, fetched.url, "the id stays with its request");
    const details = await h.ok("network_requests", { id: fetched.id }, page.session);
    assert.equal(details.request?.status ?? details.status, 200, JSON.stringify(details));
    await page.evaluate("fetch('http://127.0.0.1:9/refused').catch(() => {})");
    await sleep(500);
    const failed = (await list()).filter((/** @type {any} */ r) => r.url.includes("127.0.0.1:9/refused"));
    assert.equal(failed.length, 1, JSON.stringify(failed));
    const failedDetails = await h.ok("network_requests", { id: failed[0].id }, page.session);
    assert.match(JSON.stringify(failedDetails), /ERR_/);
  });
});
