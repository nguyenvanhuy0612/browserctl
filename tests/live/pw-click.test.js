// @ts-check
// Playwright's click cases adopted by ID (specs/tools/click.md, specs/settle.md), each run in the
// DOM lane and with trusted: true unless the spec names one lane. Sources: page-click*.spec.ts and
// locator-click.spec.ts in Playwright's tests/page.
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
/** Playwright's giveItAChanceToClick: let a pending click try a few times. */
const giveItAChanceToClick = () => sleep(400);

/** @param {"dom" | "cdp"} lane */
const open = (lane) => pwPage(h, h.newSession(), lane);

/** Reads the page's console.log lines, captured from now on. @param {ReturnType<typeof pwPage>} page */
async function captureConsole(page) {
  await page.evaluate(() => {
    /** @type {any} */ (window).__messages = [];
    const log = console.log;
    console.log = (...args) => {
      /** @type {any} */ (window).__messages.push(args.join(" "));
      log(...args);
    };
  });
  return () => page.evaluate("window.__messages");
}

/** Adds an iframe and waits for it to load. @param {ReturnType<typeof pwPage>} page @param {string} url */
const attachFrame = (page, url) =>
  page.evaluate(
    (/** @type {string} */ src) =>
      new Promise((resolve) => {
        const frame = document.createElement("iframe");
        frame.src = src;
        frame.onload = () => resolve(true);
        document.body.appendChild(frame);
      }),
    url,
  );

/** The ref of the first snapshot line matching `line`, frames included. @param {ReturnType<typeof pwPage>} page @param {string} line */
async function refOf(page, line) {
  const snapshot = (await h.ok("snapshot", {}, page.session)).snapshot;
  const ref = refIn(snapshot, line);
  assert.ok(ref, `${line} not in\n${snapshot}`);
  return /** @type {string} */ (ref);
}

for (const lane of LANES) {
  describe(`click, ${lane} lane`, () => {
    test(`CL-001 (${lane}) should click the button`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/button.html`);
      await page.click("button");
      assert.equal(await page.evaluate("result"), "Clicked");
    });

    test(`CL-004 (${lane}) should click svg`, async () => {
      const page = open(lane);
      await page.setContent(`<svg height="100" width="100"><circle onclick="window.__CLICKED=42" cx="50" cy="50" r="40" stroke="black" stroke-width="3" fill="red" /></svg>`);
      await page.click("circle");
      assert.equal(await page.evaluate("__CLICKED"), 42);
    });

    test(`CL-006 (${lane}) should click on a span with an inline element inside`, async () => {
      const page = open(lane);
      await page.setContent(`<style>span::before { content: 'q'; }</style><span onclick='window.CLICKED=42'></span>`);
      await page.click("span");
      assert.equal(await page.evaluate("CLICKED"), 42);
    });

    test(`CL-007..CL-012 (${lane}) should click aligned, half-aligned and unaligned 1x1 divs`, async () => {
      const page = open(lane);
      for (const margin of ["", "margin-left: 20.5px; margin-top: 11.5px;", "margin-left: 20.23px; margin-top: 11.65px;", "margin-left: 20.68px; margin-top: 11.13px;", "margin-left: 20.68px; margin-top: 11.52px;", "margin-left: 20.15px; margin-top: 11.24px;"]) {
        await page.setContent(`<div style="${margin} width: 1px; height: 1px;" onclick="window.__clicked = true"></div>`);
        await page.click("div");
        assert.equal(await page.evaluate("window.__clicked"), true, margin || "aligned");
      }
    });

    test(`CL-013 / CL-014 (${lane}) should click the button after a same-origin and a cross-origin navigation`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/button.html`);
      await page.click("button");
      await page.goto(`${PREFIX()}/input/button.html`);
      await page.click("button");
      assert.equal(await page.evaluate("result"), "Clicked");
      await page.goto(`${h.crossOrigin}/pw/input/button.html`);
      await page.click("button");
      assert.equal(await page.evaluate("result"), "Clicked");
    });

    test(`CL-017 (${lane}) should click offscreen buttons`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/offscreenbuttons.html`);
      const messages = await captureConsole(page);
      for (let i = 0; i < 11; ++i) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.click(`#btn${i}`);
      }
      assert.deepEqual(await messages(), Array.from({ length: 11 }, (_, i) => `button #${i} clicked`));
    });

    test(`CL-020 / CL-021 / CL-022 (${lane}) should wait for display:none, visibility:hidden and a hidden parent to be gone`, async () => {
      for (const [hide, show] of [
        ["b.style.display = 'none'", "b.style.display = 'block'"],
        ["b.style.visibility = 'hidden'", "b.style.visibility = 'visible'"],
        ["b.parentElement.style.display = 'none'", "b.parentElement.style.display = 'block'"],
      ]) {
        const page = open(lane);
        await page.goto(`${PREFIX()}/input/button.html`);
        await page.evaluate(`(() => { const b = document.querySelector('button'); ${hide}; })()`);
        let done = false;
        const clicked = page.click("button", { timeout: 0 }).then(() => (done = true));
        await giveItAChanceToClick();
        assert.equal(await page.evaluate("result"), "Was not clicked");
        assert.equal(done, false);
        await page.evaluate(`(() => { const b = document.querySelector('button'); ${show}; })()`);
        await clicked;
        assert.equal(await page.evaluate("result"), "Clicked");
      }
    });

    test(`CL-023 (${lane}) should click wrapped links`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/wrappedlink.html`);
      await page.click("a");
      assert.equal(await page.evaluate("__clicked"), true);
    });

    test(`CL-024 (${lane}) should click on checkbox input and toggle`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/checkbox.html`);
      assert.equal(await page.evaluate(() => /** @type {any} */ (window).result.check), null);
      await page.click("input#agree");
      assert.equal(await page.evaluate(() => /** @type {any} */ (window).result.check), true);
      const events = (await page.evaluate(() => /** @type {any} */ (window).result.events)).filter((/** @type {string} */ e) => e !== "mouseout" && e !== "mouseleave");
      assert.deepEqual(events, ["mouseover", "mouseenter", "mousemove", "mousedown", "mouseup", "click", "input", "change"]);
      await page.click("input#agree");
      assert.equal(await page.evaluate(() => /** @type {any} */ (window).result.check), false);
    });

    test(`CL-025 (${lane}) should click on checkbox label and toggle`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/checkbox.html`);
      await page.click('label[for="agree"]');
      assert.equal(await page.evaluate(() => /** @type {any} */ (window).result.check), true);
      assert.deepEqual(await page.evaluate(() => /** @type {any} */ (window).result.events), ["click", "input", "change"]);
      await page.click('label[for="agree"]');
      assert.equal(await page.evaluate(() => /** @type {any} */ (window).result.check), false);
    });

    test(`CL-026 (${lane}) should scroll and click the button`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/scrollable.html`);
      await page.click("#button-5");
      assert.equal(await page.evaluate(() => document.querySelector("#button-5")?.textContent), "clicked");
      await page.click("#button-80");
      assert.equal(await page.evaluate(() => document.querySelector("#button-80")?.textContent), "clicked");
    });

    test(`CL-028 (${lane}) should double click the button`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/button.html`);
      await page.evaluate(() => {
        /** @type {any} */ (window).double = false;
        document.querySelector("button")?.addEventListener("dblclick", () => (/** @type {any} */ (window).double = true));
      });
      await page.dblclick("button");
      assert.equal(await page.evaluate("double"), true);
      assert.equal(await page.evaluate("result"), "Clicked");
    });

    test(`CL-029 (${lane}) should click a partially obscured button`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/button.html`);
      await page.evaluate(() => {
        const button = /** @type {HTMLElement} */ (document.querySelector("button"));
        button.textContent = "Some really long text that will go offscreen";
        button.style.position = "absolute";
        button.style.left = "368px";
      });
      await page.click("button");
      assert.equal(await page.evaluate("result"), "Clicked");
    });

    test(`CL-030 (${lane}) should click a rotated button`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/rotatedButton.html`);
      await page.click("button");
      assert.equal(await page.evaluate("result"), "Clicked");
    });

    test(`CL-031 (${lane}) should fire contextmenu event on right click`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/scrollable.html`);
      await page.click("#button-8", { button: "right" });
      assert.equal(await page.evaluate(() => document.querySelector("#button-8")?.textContent), "context menu");
    });

    test(`CL-032 (${lane}) should click links which cause navigation`, async () => {
      const page = open(lane);
      await page.setContent(`<a href="${PREFIX()}/empty.html">empty.html</a>`);
      const r = await page.click("a");
      assert.equal(r.outcome.urlChanged, true);
    });

    test(`CL-034 (${lane}) should click the button inside an iframe`, async () => {
      const page = open(lane);
      await page.setContent('<div style="width:100px;height:100px">spacer</div>');
      await attachFrame(page, `${PREFIX()}/input/button.html`);
      await page.click(await refOf(page, 'button "Click target"'));
      assert.equal(await page.evaluate(() => /** @type {any} */ (document.querySelector("iframe")?.contentWindow)?.result), "Clicked");
    });

    test(`CL-036 (${lane}) should click the button behind sticky header`, async () => {
      const page = open(lane);
      await page.setContent(`<style>* { padding: 0; margin: 0; } li { height: 80px; border: 1px solid black; } ol { padding-top: 160px; }
        div.fixed { position: fixed; z-index: 1001; width: 100%; background: red; height: 160px; }</style>
        <div class=fixed></div><ol>${Array.from({ length: 20 }, (_, i) => (i === 8 ? `<li id=target onclick="window.__clicked = true">hi9</li>` : `<li id=li${i + 1}>hi${i + 1}</li>`)).join("")}</ol>`);
      // put the target right under the sticky header, as Playwright's 240 px viewport does
      await page.evaluate(() => {
        const target = /** @type {HTMLElement} */ (document.querySelector("#target"));
        window.scrollTo(0, target.offsetTop - 100);
      });
      await page.click("#target");
      assert.equal(await page.evaluate("window.__clicked"), true);
    });

    test(`CL-037 (${lane}) should click the button behind position:absolute header`, async () => {
      const page = open(lane);
      await page.setContent(`<style>* { padding: 0; margin: 0; } li { height: 80px; border: 1px solid black; } ol { height: 100vh; overflow: scroll; padding-top: 160px; }
        body { position: relative; } div.fixed { position: absolute; top: 0; z-index: 1001; width: 100%; background: red; height: 160px; }</style>
        <ol>${Array.from({ length: 30 }, (_, i) => (i === 8 ? `<li id=target onclick="window.__clicked = true">hi9</li>` : `<li>hi${i + 1}</li>`)).join("")}</ol><div class=fixed>Overlay</div>`);
      await page.evaluate(() => {
        const target = /** @type {HTMLElement} */ (document.querySelector("#target"));
        document.querySelector("ol")?.scrollTo({ top: target.offsetTop, behavior: "instant" });
      });
      await page.click("#target");
      assert.equal(await page.evaluate("window.__clicked"), true);
    });

    /** button.html with a 400x20 blocker over the button. @param {ReturnType<typeof pwPage>} page */
    const blockButton = (page, inner = false) =>
      page.evaluate((/** @type {boolean} */ withInner) => {
        document.body.style.position = "relative";
        const blocker = document.createElement("div");
        blocker.id = "blocker";
        Object.assign(blocker.style, { position: "absolute", width: "400px", height: "20px", left: "0", top: "0" });
        document.body.appendChild(blocker);
        if (withInner) {
          const child = document.createElement("div");
          child.id = "inner";
          Object.assign(child.style, { position: "absolute", left: "0", top: "0", right: "0", bottom: "0" });
          blocker.appendChild(child);
        }
      }, inner);

    test(`CL-048 / CL-117 (${lane}) an obscured button is not clicked: TARGET_COVERED names the blocker`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/button.html`);
      await blockButton(page);
      const error = await failsWith(page.click("button", { timeout: 1000 }), "TARGET_COVERED");
      assert.match(error.message, /blocker/);
      assert.equal(await page.evaluate("result"), "Was not clicked");
    });

    test(`CL-119 (${lane}) should report the element of the covering subtree`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/button.html`);
      await blockButton(page, true);
      const error = await failsWith(page.click("button", { timeout: 1000 }), "TARGET_COVERED");
      assert.match(error.message, /inner|blocker/);
    });

    test(`CL-049 / CL-050 / CL-052 / CL-053 / CL-055 / CL-056 (${lane}) should wait for enabled, non-inert and pointer-events`, async () => {
      for (const [html, enable, target] of /** @type {const} */ ([
      ['<button onclick="window.__CLICKED=true;" disabled><span>Click target</span></button>', "document.querySelector('button').removeAttribute('disabled')", "text=Click target"],
      ['<div inert id=container><button onclick="window.__CLICKED=true;"><span>Click target</span></button></div>', "document.getElementById('container').removeAttribute('inert')", "text=Click target"],
      ['<input onclick="window.__CLICKED=true;" disabled>', "document.querySelector('input').removeAttribute('disabled')", "input"],
      [
        "<select disabled><option selected>Hello</option></select><script>document.querySelector('select').addEventListener('mousedown', event => { window.__CLICKED=true; event.preventDefault(); });</script>",
        "document.querySelector('select').removeAttribute('disabled')",
        "select",
      ],
      ['<button onclick="window.__CLICKED=true" style="pointer-events:none"><span>Click target</span></button>', "document.querySelector('button').style.removeProperty('pointer-events')", "text=Click target"],
      ['<label onclick="window.__CLICKED=true" style="pointer-events:none"><span>Click target</span></label>', "document.querySelector('label').style.removeProperty('pointer-events')", "text=Click target"],
      ])) {
        const page = open(lane);
        await page.setContent(html);
        let done = false;
        const clicked = page.click(target, { timeout: 0 }).then(() => (done = true));
        await giveItAChanceToClick();
        assert.equal(await page.evaluate("window.__CLICKED"), null);
        assert.equal(done, false);
        await page.evaluate(enable);
        await clicked;
        assert.equal(await page.evaluate("window.__CLICKED"), true, html);
      }
    });

    test(`CL-057 (${lane}) should update modifiers correctly`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/input/button.html`);
      await page.click("button", { modifiers: ["Shift"] });
      assert.equal(await page.evaluate("shiftKey"), true);
      await page.click("button", { modifiers: [] });
      assert.equal(await page.evaluate("shiftKey"), false);
    });

    test(`CL-058 (${lane}) should click an offscreen element when scroll-behavior is smooth`, async () => {
      const page = open(lane);
      await page.setContent(`<div style="border: 1px solid black; height: 500px; overflow: auto; width: 500px; scroll-behavior: smooth">
        <button style="margin-top: 2000px" onClick="window.clicked = true">hi</button></div>`);
      await page.click("button");
      assert.equal(await page.evaluate("window.clicked"), true);
    });

    test(`CL-066 (${lane}) should click zero-sized input by label`, async () => {
      const page = open(lane);
      await page.setContent(`<label>Click me <input onclick="window.__clicked=true" style="width:0;height:0;padding:0;margin:0;border:0;"></label>`);
      await page.click("text=Click me");
      assert.equal(await page.evaluate("window.__clicked"), true);
    });

    test(`CL-071 / CL-072 / CL-073 (${lane}) should climb up to [role=button], an anchor and [role=link]`, async () => {
      const page = open(lane);
      await page.setContent(`<div role=button onclick="window.__ONE=true;"><div style="pointer-events:none"><span><div>Click target</div></span></div></div>
        <a href="#" onclick="window.__TWO=true" id="outer"><div id="intermediate"><div id="inner" style="pointer-events: none">Inner</div></div></a>
        <div role=link onclick="window.__THREE=true"><div id="inner3" style="pointer-events: none">Inner3</div></div>`);
      await page.click("text=Click target");
      await page.click("#inner");
      await page.click("#inner3");
      assert.deepEqual(await page.evaluate("[window.__ONE, window.__TWO, window.__THREE]"), [true, true, true]);
    });

    test(`CL-074 / CL-077 (${lane}) should click in a bordered iframe and in a transformed one`, async () => {
      for (const transform of ["", "transform: translate(100px, 100px) scale(1.2) rotate3d(1, 1, 1, 25deg);"]) {
        const page = open(lane);
        await page.setContent(`<style>body, html, iframe { margin: 0; padding: 0; border: none; box-sizing: border-box; }
          iframe { border: 4px solid black; background: gray; margin-left: 33px; margin-top: 24px; width: 400px; height: 400px; ${transform} }</style>
          <iframe srcdoc="<style>body, html { margin: 0; padding: 0; } div { margin-left: 10px; margin-top: 20px; width: 2px; height: 2px; }</style>
          <div role=button>Target</div><script>document.querySelector('div').addEventListener('click', () => window.top._clicked = true);</script>"></iframe>`);
        await sleep(300);
        // role=button gives the 2 px div its own snapshot ref; elements in frames are reached by frame refs
        await page.click(await refOf(page, 'button "Target"'));
        assert.equal(await page.evaluate("window._clicked"), true, transform || "border");
      }
    });

    test(`CL-083 / CL-084 (${lane}) right click fires mousedown, contextmenu, mouseup in order; a left click after it works`, async () => {
      const page = open(lane);
      await page.setContent(`<button id="target">Click me</button>
        <script>window.__events = []; for (const t of ['mousedown', 'mouseup', 'contextmenu']) document.addEventListener(t, (e) => window.__events.push(e.type));
        document.querySelector('button').addEventListener('click', (e) => e.target.textContent = 'Clicked!');</script>`);
      await page.click('role=button[name="Click me"]', { button: "right" });
      assert.deepEqual(await page.evaluate("window.__events"), ["mousedown", "contextmenu", "mouseup"]);
      await page.click("role=button");
      assert.equal(await page.evaluate(() => document.querySelector("button")?.textContent), "Clicked!");
    });

    test(`CL-087 / CL-088 (${lane}) should click into a shadow root with a slotted div, and the shadow host`, async () => {
      const page = open(lane);
      await page.setContent(`<my-button><template shadowrootmode="open"><button><slot></slot></button></template><div>Foo</div></my-button>
        <script>window.__clicks = 0; document.querySelector('my-button').addEventListener('click', () => window.__clicks++);</script>`);
      await page.click('role=button[name="Foo"]');
      await page.click("my-button");
      assert.equal(await page.evaluate("window.__clicks"), 2);
    });

    test(`CL-094 (${lane}) should not hit scroll bar`, async () => {
      const page = open(lane);
      await page.setContent(`<style>.categories { width: 180px; display: flex; overflow-x: scroll; } button { flex: none; height: 28px; }</style>
        <div class="categories">${["One", "Two", "Three", "Story", "More", "Items", "Here"].map((n) => `<button onclick="window.__clicked='${n}'">${n}</button>`).join("")}</div>`);
      await page.click("text=Story", { timeout: 2000 });
      assert.equal(await page.evaluate("window.__clicked"), "Story");
    });

    test(`CL-095 / CL-096 / CL-097 (${lane}) should scroll into view display:contents with text and with a child (CL-097 is CL-095 without position)`, async () => {
      for (const body of [
        `<div>Example text, and button here: <button style="display: contents" onclick="window._clicked=true;">click me</button></div>`,
        `Example text, and button here: <button style="display: contents" onclick="window._clicked=true;"><div>click me</div></button>`,
      ]) {
        const page = open(lane);
        await page.setContent(`<div style="background:red;height:2000px">filler</div>${body}`);
        await page.click("text=click me", { timeout: 5000 });
        assert.equal(await page.evaluate("window._clicked"), true);
      }
    });

    test(`CL-099 (${lane}) should scroll into view span element`, async () => {
      const page = open(lane);
      await page.setContent(`<div id=big style="height: 10000px;"></div><span id=small>foo</span>`);
      await h.ok("scroll", { target: "#small", ...(lane === "cdp" && { trusted: true }) }, page.session);
      assert.ok((await page.evaluate(() => window.scrollY)) > 9000);
    });

    test(`CL-106 (${lane}) a click that opens an alert reports it instead of hanging`, async () => {
      const page = open(lane);
      await page.setContent(`<div onclick='window.alert(123)'>Click me</div>`);
      const r = await page.click("div", { timeout: 3000 });
      assert.deepEqual(r.outcome.dialogs, [{ type: "alert", message: "123", answer: true }]);
    });

    test(`CL-107 (${lane}) should not retarget when element changes on hover`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/react.html`);
      await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.renderComponent(w.e("div", {}, [w.e(w.MyButton, { name: "button1", renameOnHover: true }), w.e(w.MyButton, { name: "button2" })]));
      });
      await page.click("text=button1");
      assert.equal(await page.evaluate("window.button1"), true);
      assert.equal(await page.evaluate("window.button2"), null);
    });

    test(`CL-108 (${lane}) should not retarget when element is recycled on hover`, async () => {
      const page = open(lane);
      await page.goto(`${PREFIX()}/react.html`);
      await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        const shuffle = () => w.renderComponent(w.e("div", {}, [w.e(w.MyButton, { name: "button2" }), w.e(w.MyButton, { name: "button1" })]));
        w.renderComponent(w.e("div", {}, [w.e(w.MyButton, { name: "button1", onHover: shuffle }), w.e(w.MyButton, { name: "button2" })]));
      });
      await page.click("text=button1");
      assert.equal(await page.evaluate("window.button1"), null);
      assert.equal(await page.evaluate("window.button2"), true);
    });

    test(`CL-111 / CL-112 (${lane}) should time out waiting for a button to be enabled and an element to become non-inert`, async () => {
      for (const html of ['<button onclick="window.__CLICKED=true;" disabled><span>Click target</span></button>', '<div inert><button onclick="window.__CLICKED=true;">Click target</button></div>']) {
        const page = open(lane);
        await page.setContent(html);
        const started = Date.now();
        const error = await failsWith(page.click("text=Click target", { timeout: 1500 }), "TARGET_DISABLED");
        assert.ok(Date.now() - started >= 1400, "waited for the timeout");
        if (lane === "dom") assert.match(error.message, /gave up after 1\.5 s/);
        assert.equal(await page.evaluate("window.__CLICKED"), null);
      }
    });

    test(`CL-114 / CL-115 (${lane}) should time out waiting for display:none and visibility:hidden to be gone`, async () => {
      for (const hide of ["b.style.display = 'none'", "b.style.visibility = 'hidden'"]) {
        const page = open(lane);
        await page.goto(`${PREFIX()}/input/button.html`);
        await page.evaluate(`(() => { const b = document.querySelector('button'); ${hide}; })()`);
        await failsWith(page.click("button", { timeout: 1500 }), "TARGET_HIDDEN");
      }
    });

    test(`LO-055 / LO-056 (${lane}) should click if the target is removed in pointerup or pointerdown`, async () => {
      const page = open(lane);
      for (const event of ["pointerup", "pointerdown"]) {
        await page.setContent(`<button id=clickme>Clickable</button>`);
        await page.$eval("#clickme", (/** @type {Element} */ element, /** @type {string} */ type) => element.addEventListener(type, () => element.remove(), false), event);
        await page.click("#clickme");
      }
    });
  });
}

describe("click, DOM lane only", () => {
  test("CL-005 / CL-065 should click when the page removed window.Node or corrupted innerWidth", async () => {
    const page = open("dom");
    await page.goto(`${PREFIX()}/input/button.html`);
    await page.evaluate(() => {
      delete (/** @type {any} */ (window).Node);
      Object.defineProperty(window, "innerWidth", { value: 0 });
    });
    await page.click("button");
    assert.equal(await page.evaluate("result"), "Clicked");
  });
});

describe("navigation and frames during a click (settle.md)", () => {
  test("CL-067 / CL-068 a navigation while the click waits does not hang: the click lands on the new page or fails cleanly", async () => {
    const page = open("dom");
    await page.goto(`${PREFIX()}/input/button.html`);
    await page.evaluate(() => (/** @type {HTMLElement} */ (document.querySelector("button")).style.display = "none"));
    const clicking = page.click("button", { timeout: 5 * 1000 }).then(
      () => "clicked",
      (/** @type {any} */ e) => e.code,
    );
    await sleep(300);
    await page.goto(`${PREFIX()}/input/button.html`);
    const result = await clicking;
    assert.ok(["clicked", "TARGET_HIDDEN", "TARGET_NOT_FOUND", "REF_NOT_FOUND"].includes(result), String(result));
  });

  test("CL-069 / CL-076 a frame removed while a click waits in it fails the click without hanging; the tab stays usable", async () => {
    const page = open("dom");
    await page.setContent(`<iframe srcdoc="<button disabled>Click</button>"></iframe>`);
    await sleep(300);
    const button = await refOf(page, 'button "Click"');
    await page.evaluate(() => setTimeout(() => document.querySelector("iframe")?.remove(), 500));
    const started = Date.now();
    const error = await page.click(button, { timeout: 5000 }).then(
      () => null,
      (/** @type {any} */ e) => e,
    );
    assert.ok(error, "the click cannot land in a removed frame");
    assert.ok(Date.now() - started < 6000, `took ${Date.now() - started} ms`);
    await page.setContent("<button onclick='window.__ok = true'>After</button>");
    await page.click("button");
    assert.equal(await page.evaluate("window.__ok"), true);
  });
});
