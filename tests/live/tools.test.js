// @ts-check
// Tool behaviours not covered by the lane suites: the DOM-lane runtime per document, dialogs in
// owned and user tabs, keys, read, scroll, screenshots, uploads, network filters, and how the CDP
// lane survives detaches, worker restarts and daemon restarts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { freshPage, pageLog, refIn, sleep, startHarness } from "./harness.js";

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

const browserLink = () => /** @type {any} */ (h.daemon.browsers.connected()[0].link);
const attachedTabs = () => /** @type {import("../../src/daemon/cdp/lane.js").CdpLane} */ (h.daemon.cdp).attachmentsOf(h.daemon.browsers.connected()[0].instanceId);

/** Waits until the session's tab is rendered (a focused window can take a second). @param {string} s */
async function untilVisible(s) {
  for (let i = 0; i < 50; i++) {
    if ((await h.ok("evaluate", { function: "() => document.visibilityState" }, s)).value === "visible") return true;
    await sleep(100);
  }
  return false;
}

describe("DOM-lane runtime", () => {
  test("DOM-E01 / DOM-E02 one runtime per document: the first call works, refs live until the document goes", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    await h.ok("click", { target: "#native" }, s);
    const ref = refIn((await h.ok("snapshot", {}, s)).snapshot, 'button "Native button"');
    await h.ok("type", { target: "#name", text: "x" }, s);
    await h.ok("click", { target: ref }, s);
    assert.deepEqual((await pageLog(h, s)).filter((/** @type {string} */ l) => l.startsWith("native")), ["native trusted=false", "native trusted=false"]);
    await h.ok("navigate", { url: `${h.base}/page.html` }, s);
    assert.equal((await h.call("click", { target: ref }, s)).error.code, "REF_NOT_FOUND");
    await h.ok("click", { target: "#native" }, s);
    assert.deepEqual(await pageLog(h, s), ["native trusted=false"]);
  });

  test("DOM-E03 a page that deletes Node and breaks addEventListener does not disturb the runtime", async () => {
    const s = h.newSession();
    await freshPage(h, s, "hostile.html");
    assert.ok(refIn((await h.ok("snapshot", {}, s)).snapshot, 'button "Go"'));
    await h.ok("click", { target: "role=button[name=\"Go\"]" }, s);
    await h.ok("type", { target: "label=Field", text: "abc" }, s);
    assert.deepEqual(await pageLog(h, s), ["go", "field abc"]);
  });

  test("DOM-E05 / DLG-E06 an armed confirm is answered and logged; a user's tab keeps the real dialog", async () => {
    const s = h.newSession();
    await freshPage(h, s, "widgets.html");
    const r = await h.ok("click", { target: "#sure" }, s);
    assert.deepEqual(r.outcome.dialogs, [{ type: "confirm", message: "Sure?", answer: false }]);
    const user = await h.userTab(`${h.base}/widgets.html`);
    try {
      assert.equal(await user.evaluate("document.documentElement.dataset.bctlDialogPolicy ?? null"), null);
      const dialog = await user.dialogFrom("document.querySelector('#sure').click()");
      assert.deepEqual([dialog.type, dialog.message], ["confirm", "Sure?"]);
      assert.equal(await user.evaluate("document.documentElement.dataset.bctlDialogLog ?? null"), null);
    } finally {
      await user.close();
    }
  });

  test("DOM-E06 / EVAL-E06 userScripts off: USER_SCRIPTS_OFF on a strict-CSP page, trusted still evaluates", async () => {
    const s = h.newSession();
    await freshPage(h, s, "csp/page.html");
    await h.setUserScripts(false);
    try {
      const off = await h.call("evaluate", { function: "() => document.title" }, s);
      assert.equal(off.error?.code, "USER_SCRIPTS_OFF", JSON.stringify(off));
      assert.equal((await h.ok("evaluate", { function: "() => document.title", trusted: true }, s)).value, "Fixture page");
    } finally {
      await h.setUserScripts(true);
    }
    assert.equal((await h.ok("evaluate", { function: "() => document.title" }, s)).value, "Fixture page");
  });

  test("DOM-E07 snapshot, click, type and scroll in a background tab never attach the debugger", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    await h.ok("snapshot", {}, s);
    await h.ok("click", { target: "#native" }, s);
    await h.ok("type", { target: "#name", text: "quiet" }, s);
    await h.ok("scroll", { to: "bottom" }, s);
    assert.deepEqual(attachedTabs(), []);
    assert.deepEqual((await browserLink().request("debugger.list")).tabIds, []);
  });

  test("DOM-E08 a chrome:// page is PAGE_UNSCRIPTABLE", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    await h.call("navigate", { url: "chrome://settings" }, s);
    assert.equal((await h.call("snapshot", {}, s)).error?.code, "PAGE_UNSCRIPTABLE");
  });
});

describe("dialogs", () => {
  test("DLG-E03 / DLG-E04 prompt gets promptText; an always policy survives a navigation", async () => {
    const s = h.newSession();
    await freshPage(h, s, "widgets.html");
    await h.ok("handle_dialog", { accept: true, promptText: "Ada", scope: "always" }, s);
    await h.ok("click", { target: "#ask" }, s);
    assert.deepEqual(await pageLog(h, s), ["name=Ada"]);
    await h.ok("navigate", { url: `${h.base}/widgets.html` }, s);
    await h.ok("click", { target: "#sure" }, s);
    assert.deepEqual(await pageLog(h, s), ["sure=true"]);
  });
});

describe("pointer and keys", () => {
  test("HOV-E04 hovering a disabled button shows its tooltip", async () => {
    const s = h.newSession();
    await freshPage(h, s, "widgets.html");
    await h.ok("hover", { target: "#save" }, s);
    assert.equal((await h.ok("get", { target: "#tip", what: "state" }, s)).value.visible, true);
  });

  test("KEY-E03 / KEY-E04 / KEY-E05 Escape closes a modal, a prevented Enter does not submit, ArrowDown moves a listbox", async () => {
    const s = h.newSession();
    await freshPage(h, s, "keys.html");
    await h.ok("press_key", { key: "Escape" }, s);
    assert.equal((await h.ok("evaluate", { function: "() => document.querySelector('#modal')" }, s)).value, null);
    const enter = await h.ok("press_key", { key: "Enter", target: "#guarded" }, s);
    assert.equal(enter.defaultAction, "prevented");
    assert.deepEqual(await pageLog(h, s), []);
    await h.ok("press_key", { key: "ArrowDown", target: "#listbox" }, s);
    assert.equal((await h.ok("get", { target: "role=option[selected]", what: "text" }, s)).value, "Banana");
  });
});

describe("navigation and waiting", () => {
  test("NAV-E05 a hash change and a pushState entry finish without a load wait", async () => {
    const s = h.newSession();
    await freshPage(h, s, "reactions.html");
    let started = Date.now();
    const hash = await h.ok("navigate", { url: `${h.base}/reactions.html#part` }, s);
    assert.equal(hash.urlChanged, true);
    assert.ok(Date.now() - started < 3000, `hash took ${Date.now() - started} ms`);
    await h.ok("click", { target: "#push" }, s);
    started = Date.now();
    const back = await h.ok("navigate", { action: "back" }, s);
    assert.match(back.url, /#part$/);
    assert.ok(Date.now() - started < 3000, `back took ${Date.now() - started} ms`);
  });

  test("WAIT-E02 a wait started before a navigation matches on the new page", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    await h.ok("evaluate", { function: "() => { setTimeout(() => { location.href = 'other.html'; }, 500); }" }, s);
    const r = await h.ok("wait_for", { text: "You arrived", timeout: 10 }, s);
    assert.equal(r.waited?.ok ?? r.ok, true);
    assert.equal((await h.ok("evaluate", { function: "() => document.title" }, s)).value, "Other page");
  });

  test("TABS-E02 select with focus shows the tab to the user", async () => {
    const s = h.newSession();
    const tab = await freshPage(h, s);
    await h.ok("tabs", { action: "select", tab, focus: true }, s);
    assert.equal((await h.activeTab()).tabId, tab);
  });
});

describe("read and scroll", () => {
  test("READ-E05 / READ-E06 / READ-E07 refs in the text act, field values show, no debugger", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    await h.ok("type", { target: "#name", text: "Grace" }, s);
    const text = (await h.ok("read", {}, s)).text;
    assert.match(text, /\[textbox "Name" e\d+: Grace\]/);
    const ref = /\[button "Native button" (e\d+)\]/.exec(text)?.[1];
    assert.ok(ref, text.slice(0, 500));
    await h.ok("click", { target: ref }, s);
    assert.ok((await pageLog(h, s)).includes("native trusted=false"));
    assert.deepEqual(attachedTabs(), []);
  });

  test("SCR-E02 a scrollable div scrolls by ref and the page stays", async () => {
    const s = h.newSession();
    await freshPage(h, s, "widgets.html");
    const ref = refIn((await h.ok("snapshot", {}, s)).snapshot, "Scroll box");
    const r = await h.ok("scroll", { target: ref, direction: "down", amount: 200 }, s);
    assert.equal(r.after.y, 200);
    assert.equal((await h.ok("evaluate", { function: "() => scrollY" }, s)).value, 0);
  });

  test("SCR-E03 an infinite list in the foreground grows through the DOM lane", async (t) => {
    const s = h.newSession();
    const tab = await freshPage(h, s, "lazy.html");
    await h.ok("tabs", { action: "select", tab, focus: true }, s);
    if (!(await untilVisible(s))) return t.skip("the tab never became visible (screen locked)");
    const r = await h.ok("scroll", { to: "bottom" }, s);
    assert.equal(r.lane, "dom");
    assert.equal(r.contentGrew, true, JSON.stringify(r));
  });
});

describe("screenshots, uploads, network", () => {
  test("SHOT-E03 / SHOT-E04 an element crop in the DOM lane matches its box; three captures in a second all succeed", async (t) => {
    const s = h.newSession();
    const tab = await freshPage(h, s);
    await h.ok("tabs", { action: "select", tab, focus: true }, s);
    if (!(await untilVisible(s))) return t.skip("the tab never became visible (screen locked)");
    const ref = refIn((await h.ok("snapshot", {}, s)).snapshot, 'button "Native button"');
    const box = (await h.ok("get", { target: ref, what: "box" }, s)).value;
    const ratio = (await h.ok("evaluate", { function: "() => devicePixelRatio" }, s)).value;
    const shot = await h.ok("take_screenshot", { target: ref, format: "png" }, s);
    assert.equal(shot.lane, "dom");
    assert.ok(Math.abs(shot.width - box.width * ratio) <= 2 && Math.abs(shot.height - box.height * ratio) <= 2, JSON.stringify({ shot, box, ratio }));
    const started = Date.now();
    const burst = await Promise.all([1, 2, 3].map(() => h.call("take_screenshot", {}, s)));
    assert.ok(burst.every((r) => r.ok && r.lane === "dom"), JSON.stringify(burst.map((r) => r.error ?? r.lane)));
    assert.ok(Date.now() - started < 3000);
  });

  test("UP-E02 / UP-E03 a custom chooser button and a 40 MB file go through the CDP lane", async () => {
    const s = h.newSession();
    await freshPage(h, s, "widgets.html");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bctl-upload-"));
    try {
      const small = path.join(dir, "note.txt");
      fs.writeFileSync(small, "hello");
      const custom = await h.ok("file_upload", { target: "#pick", paths: [small] }, s);
      assert.equal(custom.lane, "cdp");
      assert.deepEqual(custom.files.map((/** @type {any} */ f) => f.name), ["note.txt"]);
      const big = path.join(dir, "big.bin");
      fs.writeFileSync(big, Buffer.alloc(40 * 1024 * 1024));
      const large = await h.ok("file_upload", { target: "#hidden-file", paths: [big], timeout: 10 }, s);
      assert.equal(large.lane, "cdp");
      assert.equal(large.files[0].size, 40 * 1024 * 1024);
      assert.ok((await pageLog(h, s)).includes(`files big.bin:${40 * 1024 * 1024}`));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("NET-E02 filter, types and since pick the right requests", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    await h.ok("evaluate", { function: "async () => { await fetch('/other.html'); await fetch('/child.html'); return 1; }" }, s);
    await sleep(300);
    const all = (await h.ok("network_requests", {}, s)).requests;
    const doc = all.find((/** @type {any} */ r) => r.type === "document");
    assert.ok(doc, JSON.stringify(all));
    assert.deepEqual((await h.ok("network_requests", { filter: "child" }, s)).requests.map((/** @type {any} */ r) => r.url.split("/").pop()), ["child.html"]);
    assert.deepEqual((await h.ok("network_requests", { filter: "/other\\.html$/" }, s)).requests.length, 1);
    assert.ok((await h.ok("network_requests", { types: ["document"] }, s)).requests.every((/** @type {any} */ r) => r.type === "document"));
    const newer = (await h.ok("network_requests", { since: doc.id }, s)).requests;
    assert.ok(newer.length >= 2 && newer.every((/** @type {any} */ r) => r.id > doc.id), JSON.stringify(newer));
  });

  test("STAT-E01 network capture pins the attachment and status shows it", async () => {
    const s = h.newSession();
    const tab = await freshPage(h, s);
    await h.ok("network_requests", { captureBodies: true }, s);
    try {
      const status = await h.ok("status", {}, s);
      const entry = status.browsers[0].attached.find((/** @type {any} */ a) => a.tab === tab);
      assert.deepEqual(entry?.pins, ["network"], JSON.stringify(status.browsers[0].attached));
    } finally {
      await h.ok("network_requests", { captureBodies: false }, s);
    }
  });
});

describe("CDP lane lifecycle", () => {
  test("EVAL-E03 an async function that resolves after 1 s in a background tab is awaited", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const r = await h.ok("evaluate", { function: "() => new Promise((r) => setTimeout(() => r('later'), 1000))" }, s);
    assert.equal(r.value, "later");
  });

  test("CLICK-E06 after an idle detach, a ref taken before it still clicks with trusted", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const ref = refIn((await h.ok("snapshot", {}, s)).snapshot, 'button "Native button"');
    await h.ok("click", { target: ref, trusted: true }, s);
    await sleep(4500);
    assert.deepEqual(attachedTabs(), []);
    await h.ok("click", { target: ref, trusted: true }, s);
    assert.deepEqual(await pageLog(h, s), ["native trusted=true", "native trusted=true"]);
  });

  test("RLY-E03 a stopped service worker reconnects and the next trusted call attaches again", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    await h.ok("click", { target: "#native", trusted: true }, s);
    await h.stopServiceWorker();
    for (let i = 0; i < 350 && h.daemon.browsers.connected().length === 0; i++) await sleep(100);
    await sleep(500);
    assert.equal(h.daemon.browsers.connected().length, 1);
    await h.ok("click", { target: "#native", trusted: true }, s);
    assert.deepEqual(await pageLog(h, s), ["native trusted=true", "native trusted=true"]);
  });

  test("RLY-E04 / SES-E02 a daemon that dies with a tab attached: the new daemon detaches it on reconnect", async () => {
    const s = h.newSession();
    const tab = await freshPage(h, s);
    await h.ok("click", { target: "#native", trusted: true }, s);
    assert.ok((await browserLink().request("debugger.list")).tabIds.includes(tab));
    await h.restartDaemon();
    let attached = [tab];
    for (let i = 0; i < 30 && attached.includes(tab); i++) {
      await sleep(100);
      attached = (await browserLink().request("debugger.list")).tabIds;
    }
    assert.ok(!attached.includes(tab), "stale attachment detached");
  });
});
