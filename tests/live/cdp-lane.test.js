// @ts-check
// CDP lane: trusted input, background rendering, screenshots, response bodies, run, idle detach.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import { sleep, startHarness } from "./harness.js";

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h?.close();
});

/** @param {string} s */
async function freshPage(s, page = "page.html") {
  return (await h.ok("tabs", { action: "new", url: `${h.base}/${page}` }, s)).tab.tab;
}
/** @param {string} s */
const pageLog = async (s) => (await h.ok("evaluate", { function: "() => window.__log" }, s)).value;
const attachedTabs = () => /** @type {any} */ (h.daemon).cdp.attachmentsOf(h.daemon.browsers.connected()[0].instanceId);

describe("trusted actions", () => {
  test("CLICK-E09 a handler that needs isTrusted: DOM lane hints, trusted works", async () => {
    const s = h.newSession();
    await freshPage(s);
    const dom = await h.ok("click", { target: "#trustedonly" }, s);
    assert.match(dom.hint ?? "", /trusted: true/);
    const real = await h.ok("click", { target: "#trustedonly", trusted: true }, s);
    assert.equal(real.lane, "cdp");
    assert.equal(real.resolved.name, "Trusted only");
    assert.ok((await pageLog(s)).includes("trusted click"));
  });

  test("CLICK-E10 trusted window.open opens a tab owned by the session", async () => {
    const s = h.newSession();
    await freshPage(s);
    const r = await h.ok("click", { target: "#popup", trusted: true }, s);
    assert.equal(r.outcome.newTabs.length, 1, JSON.stringify(r.outcome));
  });

  test("HOV-E03 CSS :hover menu opens with trusted", async () => {
    const s = h.newSession();
    await freshPage(s);
    await h.ok("hover", { target: "#hovermenu", trusted: true }, s);
    const shown = await h.ok("evaluate", { function: "() => getComputedStyle(document.querySelector('#hovermenu .item')).display" }, s);
    assert.equal(shown.value, "block");
  });

  test("TYPE and fill_form through the CDP lane", async () => {
    const s = h.newSession();
    await freshPage(s);
    assert.equal((await h.ok("type", { target: "#tracked", text: "real", trusted: true }, s)).value, "real");
    const form = await h.ok("fill_form", { fields: [{ target: "#agree", value: true }, { target: "#color", value: "Green" }], trusted: true }, s);
    assert.equal(form.failed, null);
    assert.ok((await pageLog(s)).includes("tracked real"));
  });

  test("RLY-E02 / SES-E03 idle detach, then a trusted call re-attaches", async () => {
    const s = h.newSession();
    await freshPage(s);
    await h.ok("click", { target: "#native", trusted: true }, s);
    assert.equal(attachedTabs().length >= 1, true);
    await sleep(4500);
    assert.equal(attachedTabs().length, 0, JSON.stringify(attachedTabs()));
    await h.ok("click", { target: "#native", trusted: true }, s);
    assert.ok((await pageLog(s)).filter((/** @type {string} */ l) => l === "native trusted=true").length === 2);
  });
});

describe("background rendering", () => {
  test("SCR-E04 / SCR-E05 lazy list: DOM lane hints in a background tab, trusted loads more", async () => {
    const s = h.newSession();
    await freshPage(s, "lazy.html");
    const dom = await h.ok("scroll", { to: "bottom" }, s);
    assert.equal(dom.contentGrew, false);
    assert.match(dom.hint ?? "", /trusted/);
    const real = await h.ok("scroll", { direction: "down", amount: 5000, trusted: true }, s);
    assert.equal(real.lane, "cdp");
    assert.equal(real.contentGrew, true, JSON.stringify(real));
  });

  test("SHOT-E02 background tab screenshot through the CDP lane", async () => {
    const s = h.newSession();
    await freshPage(s);
    const r = await h.ok("take_screenshot", {}, s);
    assert.equal(r.lane, "cdp");
    assert.ok(fs.statSync(r.path).size > 5000 && r.width > 100, JSON.stringify(r));
    const el = await h.ok("take_screenshot", { target: "#native", format: "png" }, s);
    assert.ok(el.width > 10 && el.width < 400, JSON.stringify(el));
  });

  test("SHOT-E01 the active tab is captured without the debugger", async () => {
    const s = h.newSession();
    const tab = await freshPage(s);
    await h.ok("tabs", { action: "select", tab, focus: true }, s);
    await sleep(500);
    const r = await h.ok("take_screenshot", {}, s);
    assert.equal(r.lane, "dom", JSON.stringify(r));
    assert.ok(fs.statSync(r.path).size > 5000);
  });
});

describe("network and evaluate", () => {
  test("NET-E04 response bodies with captureBodies", async () => {
    const s = h.newSession();
    await freshPage(s);
    await h.ok("network_requests", { captureBodies: true }, s);
    await h.ok("evaluate", { function: "async () => (await fetch('/other.html')).status" }, s);
    await sleep(500);
    const list = await h.ok("network_requests", { filter: "other.html" }, s);
    const detail = await h.ok("network_requests", { id: list.requests[0].id, body: true }, s);
    assert.match(detail.request.body, /Other page/);
    assert.equal(detail.capturingBodies, true);
    await h.ok("network_requests", { captureBodies: false }, s);
  });

  test("EVAL with trusted through Playwright", async () => {
    const s = h.newSession();
    await freshPage(s);
    assert.equal((await h.ok("evaluate", { function: "() => document.title", trusted: true }, s)).value, "Fixture page");
    assert.equal((await h.ok("evaluate", { function: "(el) => el.id", target: "#native", trusted: true }, s)).value, "native");
  });
});

describe("run", () => {
  test("RUN-E01 / RUN-E02 value and persistent state", async () => {
    const s = h.newSession();
    await freshPage(s);
    assert.equal((await h.ok("run", { code: "return await page.title();" }, s)).value, "Fixture page");
    await h.ok("run", { code: "state.n = (state.n ?? 0) + 1; return state.n;" }, s);
    assert.equal((await h.ok("run", { code: "state.n = (state.n ?? 0) + 1; return state.n;" }, s)).value, 2);
    const logged = await h.ok("run", { code: "console.log('hi', 1); return null;" }, s);
    assert.deepEqual(logged.console, ["hi 1"]);
  });

  test("RUN-E04 error names the line", async () => {
    const s = h.newSession();
    await freshPage(s);
    const r = await h.call("run", { code: "const a = 1;\nconst b = 2;\nthrow new Error('bad line');" }, s);
    assert.equal(r.error.code, "EVAL_ERROR");
    assert.match(r.error.message, /bad line/);
  });

  test("RUN-E05 a synchronous loop is killed, the daemon keeps answering, state starts over", async () => {
    const s = h.newSession();
    await freshPage(s);
    await h.ok("run", { code: "state.kept = true; return 1;" }, s);
    const loop = h.call("run", { code: "while (true) {}", timeout: 2 }, s);
    await sleep(500);
    const meanwhile = await h.ok("status", {}, s);
    assert.ok(meanwhile.browsers.length === 1);
    const r = await loop;
    assert.equal(r.error.code, "TIMEOUT");
    assert.equal((await h.ok("run", { code: "return state.kept ?? false;" }, s)).value, false);
  });

  test("RUN-E06 context.newPage joins the session", async () => {
    const s = h.newSession();
    await freshPage(s);
    await h.ok("run", { code: "const p = await context.newPage(); await p.goto(page.url().replace('page.html', 'other.html')); return p.url();" }, s);
    const list = await h.ok("tabs", { action: "list" }, s);
    assert.ok(list.tabs.some((/** @type {any} */ t) => t.mine && t.url.endsWith("other.html")), JSON.stringify(list.tabs));
  });
});

describe("popup", () => {
  test("UI-E01 / UI-E02 popup shows connection, alias, user scripts and attachments", async () => {
    const s = h.newSession();
    await freshPage(s);
    const idle = await h.popupText();
    assert.match(idle, /Connection\s+Connected/);
    assert.match(idle, new RegExp(`Alias\\s+${h.daemon.browsers.connected()[0].alias}`));
    assert.match(idle, /Allow User Scripts\s+On/);
    await h.ok("click", { target: "#native", trusted: true }, s);
    assert.match(await h.popupText(), /Attached to 1 tab/);
  });
});

describe("health", () => {
  test("API-E01 / UI-E03 Errors page empty after CDP-lane work and the popup", async () => {
    assert.deepEqual(await h.extensionErrors(), []);
  });
});
