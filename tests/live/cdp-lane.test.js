// @ts-check
// CDP lane: trusted input, background rendering, screenshots, response bodies, run, idle detach.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, afterEach, before, describe, test } from "node:test";
import { freshPage, pageLog, sleep, startHarness } from "./harness.js";

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let h;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h?.close();
});
// each test opens its own tabs: close them so a long file does not pile tabs up
afterEach(() => h.closeTabs());

const attachedTabs = () => /** @type {import("../../src/daemon/cdp/lane.js").CdpLane} */ (h.daemon.cdp).attachmentsOf(h.daemon.browsers.connected()[0].instanceId);

describe("trusted actions", () => {
  test("CLICK-E09 a handler that needs isTrusted: DOM lane hints, trusted works", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const dom = await h.ok("click", { target: "#trustedonly" }, s);
    assert.match(dom.hint ?? "", /trusted: true/);
    const real = await h.ok("click", { target: "#trustedonly", trusted: true }, s);
    assert.equal(real.lane, "cdp");
    assert.equal(real.resolved.name, "Trusted only");
    assert.ok((await pageLog(h, s)).includes("trusted click"));
  });

  test("CLICK-E10 trusted window.open opens a tab owned by the session", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const r = await h.ok("click", { target: "#popup", trusted: true }, s);
    assert.equal(r.outcome.newTabs.length, 1, JSON.stringify(r.outcome));
  });

  test("HOV-E03 CSS :hover menu opens with trusted", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    await h.ok("hover", { target: "#hovermenu", trusted: true }, s);
    const shown = await h.ok("evaluate", { function: "() => getComputedStyle(document.querySelector('#hovermenu .item')).display" }, s);
    assert.equal(shown.value, "block");
  });

  test("RLY-E01 trusted click, type, fill_form and screenshot in a background tab; the user's tab stays", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const userTab = await h.activeTab();
    await h.ok("click", { target: "#native", trusted: true }, s);
    assert.equal((await h.ok("type", { target: "#tracked", text: "real", trusted: true }, s)).value, "real");
    const form = await h.ok("fill_form", { fields: [{ target: "#agree", value: true }, { target: "#color", value: "Green" }], trusted: true }, s);
    assert.equal(form.failed, null);
    assert.equal((await h.ok("take_screenshot", {}, s)).lane, "cdp");
    const log = await pageLog(h, s);
    assert.ok(log.includes("native trusted=true") && log.includes("tracked real"), String(log));
    assert.equal((await h.activeTab()).tabId, userTab.tabId);
  });

  test("RLY-E02 / SES-E03 idle detach, then a trusted call re-attaches", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    await h.ok("click", { target: "#native", trusted: true }, s);
    assert.equal(attachedTabs().length >= 1, true);
    await sleep(4500);
    assert.equal(attachedTabs().length, 0, JSON.stringify(attachedTabs()));
    await h.ok("click", { target: "#native", trusted: true }, s);
    assert.ok((await pageLog(h, s)).filter((/** @type {string} */ l) => l === "native trusted=true").length === 2);
  });

  test("RLY-E05 the first trusted click after attaching a background tab lands", async () => {
    const s = h.newSession();
    await freshPage(h, s, "canvas.html");
    await h.ok("click", { target: "#c", trusted: true }, s);
    assert.deepEqual(await pageLog(h, s), ["canvas 100,50 trusted=true"]);
  });

  test("RLY-E06 run sees the main world after the daemon's Playwright attached the tab", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    await h.ok("evaluate", { function: "() => 1", trusted: true }, s);
    assert.equal((await h.ok("run", { code: "return await page.evaluate(() => 1 + 1);", timeout: 10 }, s)).value, 2);
  });
});

describe("beforeunload", () => {
  /** A page that asks before unloading, touched with real input so Chrome would ask. @param {string} s */
  async function guardedPage(s, page = "unload.html") {
    await freshPage(h, s, page);
    await h.ok("click", { target: "#touch", trusted: true }, s);
  }
  const handlersRan = async (/** @type {string} */ s) => (await h.ok("evaluate", { function: "() => sessionStorage.getItem('unloadHandlers')" }, s)).value;

  test("NAV-E04 navigate leaves pages whose beforeunload handlers ask, in each way a page sets them", async () => {
    for (const [page, handlers] of [
      ["unload.html", "listener property "],
      ["unload-attr.html", "attribute "],
      ["unload-prop.html", "body property "],
    ]) {
      const s = h.newSession();
      await guardedPage(s, page);
      await sleep(4500); // idle detach (3 s in the harness): the shim, not the debugger, must handle it
      const started = Date.now();
      const r = await h.ok("navigate", { url: `${h.base}/other.html` }, s);
      assert.equal(r.title, "Other page", page);
      assert.equal(r.settled, true);
      assert.ok(Date.now() - started < 5000, `${page} took ${Date.now() - started} ms`);
      assert.equal(await handlersRan(s), handlers, page);
    }
  });

  test("DLG-E05 a DOM-lane link click leaves the page after the debugger detached", async () => {
    const s = h.newSession();
    await guardedPage(s);
    await sleep(4500); // idle detach (3 s in the harness)
    const r = await h.ok("click", { target: "#away" }, s);
    assert.equal(r.outcome.urlChanged, true);
    assert.equal(r.outcome.title, "Other page");
  });
});

describe("background rendering", () => {
  test("SCR-E04 / SCR-E05 lazy list: DOM lane hints in a background tab, trusted loads more", async () => {
    const s = h.newSession();
    await freshPage(h, s, "lazy.html");
    const dom = await h.ok("scroll", { to: "bottom" }, s);
    assert.equal(dom.contentGrew, false);
    assert.match(dom.hint ?? "", /trusted/);
    const real = await h.ok("scroll", { direction: "down", amount: 5000, trusted: true }, s);
    assert.equal(real.lane, "cdp");
    assert.equal(real.contentGrew, true, JSON.stringify(real));
  });

  test("SHOT-E02 background tab screenshot through the CDP lane", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const r = await h.ok("take_screenshot", {}, s);
    assert.equal(r.lane, "cdp");
    assert.ok(fs.statSync(r.path).size > 5000 && r.width > 100, JSON.stringify(r));
    const el = await h.ok("take_screenshot", { target: "#native", format: "png" }, s);
    assert.ok(el.width > 10 && el.width < 400, JSON.stringify(el));
  });

  test("SHOT-E01 the active tab is captured without the debugger", async (t) => {
    const s = h.newSession();
    const tab = await freshPage(h, s);
    await h.ok("tabs", { action: "select", tab, focus: true }, s);
    // the window takes 0.5 to 1.5 s to become visible after activation
    const visible = async () => (await h.ok("evaluate", { function: "() => document.visibilityState" }, s)).value === "visible";
    let shown = await visible();
    for (let i = 0; i < 50 && !shown; i++) shown = (await sleep(100), await visible());
    if (!shown) {
      t.skip("the tab never became visible: the screen is locked or the window cannot be shown, so no DOM-lane capture is possible");
      return;
    }
    const r = await h.ok("take_screenshot", {}, s);
    assert.equal(r.lane, "dom", JSON.stringify(r));
    assert.ok(fs.statSync(r.path).size > 5000);
  });
});

describe("network and evaluate", () => {
  test("NET-E04 response bodies with captureBodies", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    await h.ok("network_requests", { captureBodies: true }, s);
    await h.ok("evaluate", { function: "async () => { await new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = '/pw/pptr.png'; }); return (await fetch('/other.html')).status; }" }, s);
    await sleep(500);
    const list = await h.ok("network_requests", { filter: "other.html" }, s);
    const detail = await h.ok("network_requests", { id: list.requests[0].id, body: true }, s);
    assert.match(detail.request.body, /Other page/);
    const image = await h.ok("network_requests", { filter: "pptr.png" }, s);
    assert.equal((await h.call("network_requests", { id: image.requests[0].id, body: true }, s)).error.code, "BODY_UNAVAILABLE");
    assert.equal(detail.capturingBodies, true);
    await h.ok("network_requests", { captureBodies: false }, s);
  });

  test("EVAL-E08 evaluate with trusted through Playwright", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    assert.equal((await h.ok("evaluate", { function: "() => document.title", trusted: true }, s)).value, "Fixture page");
    assert.equal((await h.ok("evaluate", { function: "(el) => el.id", target: "#native", trusted: true }, s)).value, "native");
  });
});

describe("run", () => {
  test("RUN-E01 / RUN-E02 value and persistent state", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    assert.equal((await h.ok("run", { code: "return await page.title();" }, s)).value, "Fixture page");
    await h.ok("run", { code: "state.n = (state.n ?? 0) + 1; return state.n;" }, s);
    assert.equal((await h.ok("run", { code: "state.n = (state.n ?? 0) + 1; return state.n;" }, s)).value, 2);
    const logged = await h.ok("run", { code: "console.log('hi', 1); return null;" }, s);
    assert.deepEqual(logged.console, ["hi 1"]);
  });

  test("RUN-E03 page.mouse.click by coordinates on a canvas", async () => {
    const s = h.newSession();
    await freshPage(h, s, "canvas.html");
    await h.ok("run", { code: "await page.mouse.click(60, 50);" }, s);
    assert.deepEqual(await pageLog(h, s), ["canvas 10,10 trusted=true"]);
  });

  test("RUN-E04 error names the line", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const r = await h.call("run", { code: "const a = 1;\nconst b = 2;\nthrow new Error('bad line');" }, s);
    assert.equal(r.error.code, "EVAL_ERROR");
    assert.match(r.error.message, /bad line \(line 3 of code\)/);
  });

  test("RUN-E05 a synchronous loop is killed, the daemon keeps answering, state starts over", async () => {
    const s = h.newSession();
    await freshPage(h, s);
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
    await freshPage(h, s);
    await h.ok("run", { code: "const p = await context.newPage(); await p.goto(page.url().replace('page.html', 'other.html')); return p.url();" }, s);
    const list = await h.ok("tabs", { action: "list" }, s);
    const opened = list.tabs.find((/** @type {any} */ t) => t.mine && t.url.endsWith("other.html"));
    assert.ok(opened, JSON.stringify(list.tabs));
    assert.equal(opened.active, false);
  });

  test("RLY-E07 waitForLoadState resolves on a loaded tab, every time", async () => {
    for (let i = 0; i < 8; i++) {
      const s = h.newSession();
      await freshPage(h, s);
      const code = "for (const state of ['domcontentloaded', 'load']) await page.waitForLoadState(state, { timeout: 3000 }); return 'loaded';";
      assert.equal((await h.ok("run", { code, timeout: 10 }, s)).value, "loaded", `run ${i}`);
      await h.closeTabs();
    }
  });

  test("RUN-E12 a tab the page opens is the worker's popup", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const code = `await page.evaluate((u) => { const a = document.createElement("a"); a.href = u; a.target = "_blank"; a.id = "pop"; a.textContent = "pop"; document.body.prepend(a); }, ${JSON.stringify(`${h.base}/other.html`)});
const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 5000 }), page.click("#pop")]);
await popup.waitForLoadState("domcontentloaded");
return { url: popup.url(), pages: context.pages().length };`;
    const r = await h.ok("run", { code, timeout: 20 }, s);
    assert.match(r.value.url, /other\.html$/);
    assert.equal(r.value.pages, 2);
  });

  test("RUN-E13 state and the worker stay across the session's tabs; page is the call's tab", async () => {
    const s = h.newSession();
    const a = await freshPage(h, s);
    const b = await freshPage(h, s, "other.html");
    await h.ok("run", { code: "state.from = page.url(); return null;", tab: a }, s);
    const r = await h.ok("run", { code: "return [state.from, page.url()];", tab: b }, s);
    assert.match(r.value[0], /page\.html$/);
    assert.match(r.value[1], /other\.html$/);
    assert.match((await h.ok("run", { code: "return page.url();", tab: a }, s)).value, /page\.html$/);
  });

  test("RUN-E14 after the extension reconnects run starts a new worker", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    await h.ok("run", { code: "state.n = 1; return 1;" }, s);
    await h.stopServiceWorker();
    for (let i = 0; i < 350 && h.daemon.browsers.connected().length === 0; i++) await sleep(100);
    await sleep(500);
    const r = await h.ok("run", { code: "return [state.n ?? null, page.url()];", timeout: 20 }, s);
    assert.equal(r.value[0], null);
    assert.match(r.value[1], /page\.html$/);
  });

  // RUN-E07 to RUN-E11 adopt playwright-mcp's run-code.spec.ts cases.
  test("RUN-E07 role click, then return an object", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const r = await h.ok("run", { code: 'await page.getByRole("button", { name: "Native button" }).click(); return { message: "Hello, world!" };' }, s);
    assert.deepEqual(r.value, { message: "Hello, world!" });
    assert.ok((await pageLog(h, s)).includes("native trusted=true"));
  });

  test("RUN-E08 require is not defined", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const r = await h.call("run", { code: "require('fs');" }, s);
    assert.equal(r.error.code, "EVAL_ERROR");
    assert.match(r.error.message, /require is not defined/);
  });

  test("RUN-E09 benign globals", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const code = "return { setTimeout: typeof setTimeout, URL: typeof URL, fetch: typeof fetch, Buffer: typeof Buffer, crypto: typeof crypto, AbortController: typeof AbortController, TextEncoder: typeof TextEncoder, require: typeof require };";
    const r = await h.ok("run", { code }, s);
    assert.deepEqual(r.value, { setTimeout: "function", URL: "function", fetch: "function", Buffer: "function", crypto: "object", AbortController: "function", TextEncoder: "function", require: "undefined" });
  });

  test("RUN-E10 delayed route with setTimeout", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const code = `await page.route("**/api/slow", async (route) => {
      await new Promise((r) => setTimeout(r, 100));
      await route.fulfill({ body: JSON.stringify({ path: new URL(route.request().url()).pathname }) });
    });
    return await page.evaluate(async () => (await fetch("/api/slow")).json());`;
    assert.deepEqual((await h.ok("run", { code }, s)).value, { path: "/api/slow" });
  });

  test("RUN-E11 errors from route handlers and listeners keep the worker", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    await h.ok("run", { code: "state.kept = true;" }, s);
    const route = await h.call("run", { code: "await page.route('**/route-throws.json', async () => { throw new Error('route handler failed'); }); return await page.evaluate(async () => (await fetch('/route-throws.json')).text());", timeout: 10 }, s);
    assert.equal(route.error?.code, "EVAL_ERROR", JSON.stringify(route));
    assert.match(route.error.message, /uncaught in a listener or route handler: .*route handler failed/);
    await h.ok("tabs", { action: "list" }, s);

    await h.ok("run", { code: "await page.unrouteAll(); page.once('requestfinished', () => { throw new TypeError('page listener failed'); });" }, s);
    const during = await h.call("run", { code: "await Promise.all([page.waitForEvent('requestfinished'), page.evaluate(() => fetch('/other.html').then((r) => r.text()))]); await page.waitForTimeout(100);" }, s);
    assert.match(during.error?.message ?? "", /page listener failed/, JSON.stringify(during));

    await h.ok("run", { code: "setTimeout(() => { throw new Error('late failure'); }, 50);" }, s);
    await sleep(200);
    const next = await h.ok("run", { code: "return state.kept;" }, s);
    assert.equal(next.value, true);
    assert.deepEqual(next.console, ["uncaught: Error: late failure"]);
  });
});

describe("targets in the CDP lane", () => {
  test("TGT-E05 a ref and a frame ref acted on with trusted: true; markers removed", async () => {
    const s = h.newSession();
    await freshPage(h, s, "frames.html");
    await sleep(500);
    const snap = (await h.ok("snapshot", {}, s)).snapshot;
    const childRef = /\[ref=(f\d+e\d+)\]/.exec(snap.split("\n").find((/** @type {string} */ l) => l.includes('button "Child button"')) ?? "")?.[1];
    assert.ok(childRef, snap);
    const r = await h.ok("click", { target: childRef, trusted: true }, s);
    assert.equal(r.lane, "cdp");
    assert.equal(r.resolved.name, "Child button");
    assert.equal((await h.ok("get", { target: childRef, what: "attribute", name: "data-bctl-target" }, s)).value, null);
    await freshPage(h, s, "page.html");
    const page = (await h.ok("snapshot", {}, s)).snapshot;
    const native = /\[ref=(e\d+)\]/.exec(page.split("\n").find((/** @type {string} */ l) => l.includes('button "Native button"')) ?? "")?.[1];
    assert.ok(native);
    await h.ok("click", { target: native, trusted: true }, s);
    assert.ok((await pageLog(h, s)).some((/** @type {string} */ e) => e.startsWith("native")));
    assert.equal((await h.ok("evaluate", { function: "() => document.querySelectorAll('[data-bctl-target]').length" }, s)).value, 0);
  });
});

describe("common action parameters, trusted", () => {
  test("ACT-E05 / TGT-E08 trusted: locators, wait, scroll none and center", async () => {
    const s = h.newSession();
    await freshPage(h, s, "locators.html");
    await h.ok("click", { target: "testid=submit-btn", trusted: true }, s);
    await h.ok("click", { target: "title=Close dialog", trusted: true }, s);
    const typed = await h.ok("type", { target: "label=Email", text: "x@y.z", trusted: true }, s);
    assert.equal(typed.value, "x@y.z");
    assert.deepEqual(await pageLog(h, s), ["submit", "close"]);
    await freshPage(h, s, "actions.html");
    const met = await h.ok("click", { target: "#show", trusted: true, wait: { text: "Shown later" } }, s);
    assert.equal(met.waited.ok, true);
    const none = await h.call("click", { target: "#far", trusted: true, scroll: "none" }, s);
    assert.equal(none.error?.code, "TARGET_OUTSIDE_VIEWPORT", JSON.stringify(none));
    await h.ok("click", { target: "#far", trusted: true, scroll: "center" }, s);
    assert.deepEqual(await pageLog(h, s), ["far"]);
    /** @param {Promise<any>} call */
    const fast = async (call) => {
      const started = Date.now();
      const r = await Promise.race([call, sleep(8000).then(() => ({ hung: true }))]);
      return { r, ms: Date.now() - started };
    };
    await freshPage(h, s, "actions.html");
    const covered = await fast(h.call("click", { target: "#covered", trusted: true, timeout: 0 }, s));
    assert.ok(covered.ms < 3000 && covered.r.ok === false, `timeout 0: ${covered.ms} ms ${JSON.stringify(covered.r).slice(0, 200)}`);
    const upload = await fast(h.call("file_upload", { target: "#nochooser", paths: [new URL(import.meta.url).pathname], timeout: 0.5 }, s));
    assert.ok(upload.ms < 3000 && upload.r.ok === false, `upload: ${upload.ms} ms ${JSON.stringify(upload.r).slice(0, 200)}`);
  });
});

describe("popup", () => {
  test("UI-E01 / UI-E02 popup shows connection, alias, user scripts and attachments", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const idle = await h.popupText();
    assert.match(idle, /Connection\s+Connected/);
    assert.match(idle, new RegExp(`Alias\\s+${h.daemon.browsers.connected()[0].alias}`));
    assert.match(idle, /Allow User Scripts\s+On/);
    // tabs of earlier tests stay attached until the harness's 3 s idle detach: wait them out
    for (let i = 0; i < 60 && (await h.ok("status", {}, s)).browsers[0].attached.length; i++) await sleep(100);
    await h.ok("click", { target: "#native", trusted: true }, s);
    assert.match(await h.popupText(), /Attached to 1 tab/);
  });
});

describe("health", () => {
  test("API-E01 / UI-E03 Errors page empty after CDP-lane work and the popup", async () => {
    assert.deepEqual(await h.extensionErrors(), []);
  });
});
