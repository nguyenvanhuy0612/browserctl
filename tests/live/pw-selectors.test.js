// @ts-check
// Playwright's selector-engine and ai-snapshot cases adopted by ID (specs/targets.md,
// specs/tools/snapshot.md): each engine once through this project's runtime in the extension, and
// the snapshot features the compaction relies on. Sources: selectors-*.spec.ts and
// page-aria-snapshot-ai.spec.ts in Playwright's tests/page.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { refIn, sleep, startHarness } from "./harness.js";
import { pwPage } from "./pw.js";

/** @type {import("./harness.js").Harness} */
let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h?.close();
});

const open = () => pwPage(h, h.newSession(), "dom");

/**
 * What a selector matches, as outerHTML (Playwright's `$$eval(els => els.map(e => e.outerHTML))`);
 * nothing matched is an empty list.
 * @param {ReturnType<typeof pwPage>} page @param {string} selector @param {"html" | "text"} [what]
 */
async function matches(page, selector, what = "html") {
  const r = await h.call("get", { target: selector, what, all: true, timeout: 0 }, page.session);
  if (!r.ok && r.error.code === "TARGET_NOT_FOUND") return [];
  assert.ok(r.ok, `${selector}: ${JSON.stringify(r.error)}`);
  return r.items.map((/** @type {any} */ i) => i.value);
}
/** @param {ReturnType<typeof pwPage>} page @param {string} selector */
const textOf = async (page, selector) => (await matches(page, selector, "text"))[0];

describe("selector engines", () => {
  test("SE-002 / SE-041 css and text pierce open shadow roots", async () => {
    const page = open();
    await page.goto(`${h.base}/pw/deep-shadow.html`);
    assert.equal(await textOf(page, "css=span >> nth=0"), "Hello from root1");
    assert.equal(await textOf(page, "css=#target"), "Hello from root2");
    assert.equal(await textOf(page, "css=div div #target"), "Hello from root2");
    assert.deepEqual(await matches(page, "css=div div div #target"), []);
    assert.equal(await textOf(page, "text=root3"), "Hello from root3");
    assert.equal(await textOf(page, "#root1 >> text=from root3"), "Hello from root3");
    assert.deepEqual(await matches(page, "text:light=root2"), []);
  });

  test("SE-003 css > combinator with any spacing", async () => {
    const page = open();
    await page.setContent(`<div foo="bar" bar="baz"><span></span></div>`);
    for (const selector of [`div[foo="bar"] > span`, `div[foo="bar"]> span`, `div[foo="bar"] >span`, `div[foo="bar"]>span`, `div[foo="bar"][bar="baz"]   >    span`]) {
      assert.deepEqual(await matches(page, selector), ["<span></span>"], selector);
    }
  });

  test("SE-022 css :has", async () => {
    const page = open();
    await page.setContent(`<section><span></span><div></div></section><section><br></section>`);
    assert.equal((await matches(page, "section:has(span, div)")).length, 1);
    assert.equal((await matches(page, "section:has(br)")).length, 1);
    assert.equal((await matches(page, "section:has(span, br)")).length, 2);
  });

  test("SE-028 / SE-037 / SE-038 text: substring and case-insensitive unquoted, exact quoted, regex", async () => {
    const page = open();
    await page.setContent(`<div>yo</div><div>ya</div><div>\nye  </div><div>textwithsubstring</div>`);
    assert.deepEqual(await matches(page, "text=ya"), ["<div>ya</div>"]);
    assert.deepEqual(await matches(page, `text="ya"`), ["<div>ya</div>"]);
    assert.deepEqual(await matches(page, "text=/^[ay]+$/"), ["<div>ya</div>"]);
    assert.deepEqual(await matches(page, "text=yA"), ["<div>ya</div>"]);
    assert.deepEqual(await matches(page, `text="yA"`), []);
    assert.deepEqual(await matches(page, "text=with"), ["<div>textwithsubstring</div>"]);
    assert.deepEqual(await matches(page, `text="with"`), []);
  });

  test("SE-050 / SE-059 / SE-060 role: detection, hidden filtered, names", async () => {
    const page = open();
    await page.setContent(`<button>Hello</button><select multiple="" size="2"></select><select></select><h3>Heading</h3><div role="dialog">I am a dialog</div>
      <button hidden>Gone</button><button style="display:none">Never</button>
      <div role="button" aria-label=" Hallo "></div>`);
    assert.deepEqual(await matches(page, "role=listbox"), [`<select multiple="" size="2"></select>`]);
    assert.deepEqual(await matches(page, "role=combobox"), ["<select></select>"]);
    assert.deepEqual(await matches(page, "role=heading"), ["<h3>Heading</h3>"]);
    assert.deepEqual(await matches(page, "role=menuitem"), []);
    assert.deepEqual(await matches(page, "role=button", "text"), ["Hello", ""]);
    assert.equal((await matches(page, "role=button[include-hidden]")).length, 4);
    assert.deepEqual(await matches(page, `role=button[name="Hallo"]`), [`<div role="button" aria-label=" Hallo "></div>`]);
    assert.deepEqual(await matches(page, `role=button[name=/^H[ae]llo$/]`, "text"), ["Hello", ""]);
  });

  test("SE-071 / SE-077 / SE-084 / SE-087 / SE-088 / SE-089 testid=, label=, placeholder=, alt=, title=", async () => {
    const page = open();
    await page.setContent(`<div><div data-testid="Hello">Hello world</div><label for=target>Name</label><input id=target type=text>
      <input id=aria aria-label="Surname"><input placeholder='Hello'><input placeholder='Hello World'>
      <input alt='Hello'><input alt='Hello World'><input title='Hello'><input title='Hello World'></div>`);
    assert.equal(await textOf(page, "testid=Hello"), "Hello world");
    assert.deepEqual(await matches(page, "testid=hello"), [], "testid= is exact");
    assert.equal((await matches(page, "label=Name", "html"))[0], `<input id="target" type="text">`);
    assert.equal((await matches(page, "label=Surname", "html"))[0], `<input id="aria" aria-label="Surname">`);
    for (const engine of ["placeholder", "alt", "title"]) {
      assert.equal((await matches(page, `${engine}=hello`)).length, 2, `${engine}= substring, any case`);
      assert.equal((await matches(page, `${engine}="Hello"`)).length, 1, `${engine}="" exact`);
    }
  });

  test("SE-135 / SE-136 / SE-139 :visible, visible= and nth=", async () => {
    const page = open();
    await page.setContent(`<section><div id=target1></div><div id=target2></div></section>`);
    assert.deepEqual(await matches(page, "div:visible"), []);
    assert.deepEqual(await matches(page, "div >> visible=true"), []);
    const appearing = h.call("wait_for", { target: "div >> visible=true", state: "attached", timeout: 5 }, page.session);
    await page.$eval("#target2", (/** @type {Element} */ div) => (div.textContent = "Now visible"));
    assert.equal((await appearing).ok, true);
    assert.deepEqual(await matches(page, "div:visible"), [`<div id="target2">Now visible</div>`]);
    assert.deepEqual(await matches(page, "div >> nth=0"), [`<div id="target1"></div>`]);
    assert.deepEqual(await matches(page, "section > div >> nth=1"), [`<div id="target2">Now visible</div>`]);
    assert.deepEqual(await matches(page, "div >> nth=2"), []);
  });

  test("SE-143 / SE-144 xpath, relative in a chain, and with a pipe", async () => {
    const page = open();
    await page.setContent(`<span class="find-me" id=target1>1</span><div><span class="find-me" id=target2>2</span></div>`);
    assert.deepEqual(await matches(page, `//*[@class="find-me"]`, "text"), ["1", "2"]);
    assert.deepEqual(await matches(page, `div >> xpath=./*[@class="find-me"]`, "text"), ["2"]);
    assert.deepEqual(await matches(page, `//*[@id="target1"] | //*[@id="target2"]`, "text"), ["1", "2"]);
  });
});

describe("ai snapshot", () => {
  /** @param {ReturnType<typeof pwPage>} page @param {object} [params] */
  const snapshot = async (page, params = {}) => /** @type {string} */ ((await h.ok("snapshot", { full: true, ...params }, page.session)).snapshot);
  /** The snapshot's line for `text`. @param {string} snap @param {string} text */
  const line = (snap, text) => snap.split("\n").find((l) => l.includes(text)) ?? "";

  test("AR-048 refs are generated; a renamed element gets a new one, the others keep theirs", async () => {
    const page = open();
    await page.setContent(`<button>One</button><button>Two</button><button>Three</button>`);
    const first = await snapshot(page);
    const [one, two] = [refIn(first, 'button "One"'), refIn(first, 'button "Two"')];
    assert.ok(one && two);
    await page.$eval("text=Two", (/** @type {HTMLElement} */ e) => (e.textContent = "Not Two"));
    const second = await snapshot(page);
    assert.equal(refIn(second, 'button "One"'), one);
    assert.notEqual(refIn(second, 'button "Not Two"'), two);
  });

  test("AR-055 elements that take no pointer events get no ref", async () => {
    const page = open();
    await page.setContent(`<button style="pointer-events: none">no-ref</button><div style="pointer-events: none"><button style="pointer-events: auto">with-ref</button></div>
      <div style="pointer-events: auto"><div style="pointer-events: none"><button>no-ref too</button></div></div>`);
    const snap = await snapshot(page);
    assert.doesNotMatch(line(snap, '"no-ref"'), /\[ref=/);
    assert.doesNotMatch(line(snap, '"no-ref too"'), /\[ref=/);
    assert.match(line(snap, '"with-ref"'), /\[ref=e\d+\]/);
  });

  test("AR-065 a nameless image is left out unless it is clickable", async () => {
    const page = open();
    const gif = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";
    await page.setContent(`<img src="${gif}"><img alt="A cat" src="${gif}"><img style="cursor: pointer" src="${gif}">`);
    const imgs = (await snapshot(page)).split("\n").filter((l) => l.includes("img"));
    assert.equal(imgs.length, 2, imgs.join("\n"));
    assert.match(imgs[0], /img "A cat" \[ref=e\d+\]/);
    assert.match(imgs[1], /img \[ref=e\d+\] \[cursor=pointer\]/);
  });

  test("AR-076 visible children of hidden elements are shown, hidden ones are not", async () => {
    const page = open();
    await page.setContent(`<div style="visibility: hidden"><div style="visibility: visible"><button>Visible</button></div>
      <div><div style="visibility: visible"><button style="visibility: hidden">Hidden</button></div><button>Hidden</button></div></div>`);
    const snap = await snapshot(page);
    assert.match(snap, /button "Visible" \[ref=e\d+\]/);
    assert.doesNotMatch(snap, /"Hidden"/);
  });

  test("AR-077 the focused element is marked active in a focused tab", async (t) => {
    const page = open();
    await page.setContent(`<button id="btn1">Button 1</button><button id="btn2" autofocus>Button 2</button>`);
    // [active] needs a focused document, as in Playwright's runs: show the tab
    const { current } = await h.ok("tabs", { action: "list" }, page.session);
    await h.ok("tabs", { action: "select", tab: current, focus: true }, page.session);
    let focused = false;
    for (let i = 0; i < 50 && !focused; i++) focused = (await page.evaluate("document.hasFocus() && document.activeElement?.id === 'btn2'")) || (await sleep(100), false);
    if (!focused) return t.skip("the browser window never got OS focus (another app is in front, or the screen is locked)");
    assert.match(line(await snapshot(page), '"Button 2"'), /\[active\]/);
  });

  test("AR-090 depth cuts the tree", async () => {
    const page = open();
    await page.setContent(`<ul><li>item1</li><li><ul id=target><li>item2</li><li><ul><li>item3</li></ul></li></ul></li></ul>`);
    const shallow = await snapshot(page, { depth: 2 });
    assert.match(shallow, /item1/);
    assert.doesNotMatch(shallow, /item3/);
    assert.match(await snapshot(page), /item3/);
  });

  test("AR-091 aria-hidden content is annotated, not dropped", async () => {
    const page = open();
    await page.setContent(`<h2>Visible heading</h2><div aria-hidden="true"><h1>Hidden heading</h1><p>Hidden content</p></div><h2>After hidden</h2>`);
    const snap = await snapshot(page);
    assert.match(snap, /\[aria-hidden\]/);
    assert.match(snap, /Hidden content/);
  });
});
