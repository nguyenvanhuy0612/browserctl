// @ts-check
// DOM-lane tools against fixture pages in background tabs; no debugger anywhere.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { sleep, startHarness } from "./harness.js";

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let h;
/** @type {any} */
let userTab;

before(async () => {
  h = await startHarness();
  userTab = await h.activeTab();
});
after(async () => {
  await h?.close();
});

/** @param {string} session */
async function freshPage(session, page = "page.html") {
  const r = await h.ok("tabs", { action: "new", url: `${h.base}/${page}` }, session);
  return r.tab.tab;
}

/** @param {string} snapshot @param {RegExp | string} line */
function refIn(snapshot, line) {
  const found = snapshot.split("\n").find((l) => (typeof line === "string" ? l.includes(line) : line.test(l)));
  return /\[ref=((?:f\d+)?e\d+)\]/.exec(found ?? "")?.[1];
}

/** @param {string} session */
async function pageLog(session) {
  return (await h.ok("evaluate", { function: "() => window.__log" }, session)).value;
}

describe("tabs and navigate", () => {
  test("SES-E01 / TABS-E01 new tab is inactive, grouped, current; user's tab unchanged", async () => {
    const s = h.newSession();
    const r = await h.ok("tabs", { action: "new", url: `${h.base}/page.html` }, s);
    assert.equal(r.current, r.tab.tab);
    assert.equal(r.tab.title, "Fixture page");
    const active = await h.activeTab();
    assert.equal(active.tabId, userTab.tabId);
    const list = await h.ok("tabs", { action: "list" }, s);
    assert.ok(list.tabs.some((/** @type {any} */ t) => t.tab === r.tab.tab && t.mine && t.current));
  });

  test("NAV-E01 navigate with no current tab opens one", async () => {
    const s = h.newSession();
    const r = await h.ok("navigate", { url: `${h.base}/other.html` }, s);
    assert.equal(r.title, "Other page");
    assert.equal(r.settled, true);
  });

  test("NAV-E02 back, forward, reload; NAV-U01 url and action together", async () => {
    const s = h.newSession();
    await freshPage(s);
    await h.ok("navigate", { url: `${h.base}/other.html` }, s);
    assert.equal((await h.ok("navigate", { action: "back" }, s)).title, "Fixture page");
    assert.equal((await h.ok("navigate", { action: "forward" }, s)).title, "Other page");
    assert.equal((await h.ok("navigate", { action: "reload" }, s)).title, "Other page");
    const bad = await h.call("navigate", { url: "x", action: "back" }, s);
    assert.equal(bad.error.code, "INVALID_PARAMS");
  });

  test("NAV-E03 unreachable host", async () => {
    const s = h.newSession();
    await freshPage(s);
    const r = await h.call("navigate", { url: "http://127.0.0.1:9/" }, s);
    assert.equal(r.error?.code, "NAVIGATION_FAILED", JSON.stringify(r));
  });

  test("SES-U04 / TABS-E04 another session's tab is refused, adopt with force takes it", async () => {
    const a = h.newSession();
    const b = h.newSession();
    const tab = await freshPage(a);
    assert.equal((await h.call("snapshot", { tab }, b)).error.code, "TAB_NOT_OWNED");
    assert.equal((await h.call("tabs", { action: "adopt", tab }, b)).error.code, "TAB_NOT_OWNED");
    await h.ok("tabs", { action: "adopt", tab, force: true }, b);
    assert.equal((await h.call("snapshot", { tab }, a)).error.code, "TAB_NOT_OWNED");
  });

  test("TABS-E05 closing the current tab leaves no current tab", async () => {
    const s = h.newSession();
    const tab = await freshPage(s);
    const r = await h.ok("tabs", { action: "close", tab }, s);
    assert.equal(r.current, null);
    assert.equal((await h.call("click", { target: "#native" }, s)).error.code, "NO_TAB");
  });
});

describe("snapshot and read", () => {
  test("SNAP-E01 / SNAP-E04 cursor:pointer div has a ref; background tab, no debugger", async () => {
    const s = h.newSession();
    await freshPage(s);
    const r = await h.ok("snapshot", {}, s);
    assert.equal(r.lane, "dom");
    assert.equal(r.background, true);
    assert.ok(refIn(r.snapshot, "Open conversation"), r.snapshot);
    assert.ok(refIn(r.snapshot, 'button "Native button"'));
    assert.ok(r.folded > 0, "50 list items folded");
    assert.deepEqual(h.daemon.browsers.connected()[0].link && (await /** @type {any} */ (h.daemon.browsers.connected()[0].link).request("debugger.list")).tabIds, []);
  });

  test("TGT-E01 / TGT-E07 refs are stable and survive a partial snapshot", async () => {
    const s = h.newSession();
    await freshPage(s);
    const first = (await h.ok("snapshot", {}, s)).snapshot;
    const native = refIn(first, 'button "Native button"');
    const list = refIn(first, /- list/);
    const partial = await h.ok("snapshot", { target: list }, s);
    assert.ok(!partial.snapshot.includes("Native button"));
    const again = (await h.ok("snapshot", {}, s)).snapshot;
    assert.equal(refIn(again, 'button "Native button"'), native);
    await h.ok("click", { target: native }, s);
    assert.ok((await pageLog(s)).includes("native trusted=false"));
  });

  test("SNAP-E03 / TGT-E04 same-origin and cross-origin frames nest with frame refs", async () => {
    const s = h.newSession();
    await freshPage(s, "frames.html");
    await sleep(500);
    const r = await h.ok("snapshot", {}, s);
    const childButtons = r.snapshot.split("\n").filter((/** @type {string} */ l) => l.includes('button "Child button"'));
    assert.equal(childButtons.length, 2, r.snapshot);
    const frameRefs = childButtons.map((/** @type {string} */ l) => /\[ref=(f\d+e\d+)\]/.exec(l)?.[1]);
    assert.ok(frameRefs.every(Boolean) && frameRefs[0] !== frameRefs[1], r.snapshot);
    const clicked = await h.ok("click", { target: frameRefs[1] }, s);
    assert.equal(clicked.resolved.name, "Child button");
  });

  test("READ-E02 / READ-E03 / READ-E01 full table across slices, hidden text absent, main only", async () => {
    const s = h.newSession();
    await freshPage(s, "table.html");
    let offset = 0;
    let text = "";
    for (let i = 0; i < 20; i++) {
      const r = await h.ok("read", { main: true, offset, maxChars: 2000 }, s);
      text += r.text;
      if (r.nextOffset === null) break;
      offset = r.nextOffset;
    }
    assert.ok(text.includes("| Row 1 | 10 |") && text.includes("| Row 300 | 3000 |"), text.slice(0, 300));
    assert.ok(!text.includes("Hidden secret text"));
    assert.ok(!text.includes("Nav link") && !text.includes("Footer text"));
  });

  test("READ-E04 frame text appears where the frame is", async () => {
    const s = h.newSession();
    await freshPage(s, "frames.html");
    await sleep(500);
    const r = await h.ok("read", {}, s);
    assert.equal(r.text.split("Child text here").length - 1, 2, r.text);
  });
});

describe("acting", () => {
  test("CLICK-E01 / CLICK-E02 synthetic clicks in a background tab; user's tab unchanged", async () => {
    const s = h.newSession();
    await freshPage(s);
    const native = await h.ok("click", { target: "#native" }, s);
    assert.equal(native.lane, "dom");
    assert.equal(native.resolved.by, "selector");
    assert.equal(native.resolved.name, "Native button");
    await h.ok("click", { target: "text=Open conversation" }, s);
    const log = await pageLog(s);
    assert.ok(log.includes("native trusted=false") && log.includes("fake"), String(log));
    assert.equal((await h.activeTab()).tabId, userTab.tabId);
  });

  test("CLICK errors: covered, disabled, ambiguous, unknown ref, bad selector", async () => {
    const s = h.newSession();
    await freshPage(s);
    const covered = await h.call("click", { target: "#covered" }, s);
    assert.equal(covered.error.code, "TARGET_COVERED");
    assert.match(covered.error.message, /overlay/);
    assert.equal((await h.call("click", { target: "#disabled" }, s)).error.code, "TARGET_DISABLED");
    const ambiguous = await h.call("click", { target: "role=button" }, s);
    assert.equal(ambiguous.error.code, "AMBIGUOUS_TARGET");
    assert.ok(ambiguous.error.candidates.length === 5);
    assert.equal((await h.call("click", { target: "e9999" }, s)).error.code, "REF_NOT_FOUND");
    assert.equal((await h.call("click", { target: "role=button[name=" }, s)).error.code, "INVALID_TARGET");
  });

  test("CLICK-E03 / CLICK-E07 link navigation settles; old refs then fail", async () => {
    const s = h.newSession();
    await freshPage(s);
    const snap = (await h.ok("snapshot", {}, s)).snapshot;
    const link = refIn(snap, 'link "Go to other"');
    const r = await h.ok("click", { target: link }, s);
    assert.equal(r.outcome.urlChanged, true);
    assert.equal(r.outcome.title, "Other page");
    assert.equal(r.outcome.settled, true);
    assert.equal((await h.call("click", { target: link }, s)).error.code, "REF_NOT_FOUND");
  });

  test("CLICK-E04 target=_blank opens a tab owned by the session", async () => {
    const s = h.newSession();
    await freshPage(s);
    const r = await h.ok("click", { target: "#blank" }, s);
    assert.equal(r.outcome.newTabs.length, 1, JSON.stringify(r.outcome));
    const list = await h.ok("tabs", { action: "list" }, s);
    assert.ok(list.tabs.some((/** @type {any} */ t) => t.tab === r.outcome.newTabs[0].tab && t.mine));
  });

  test("CLICK-E05 / DLG-E01 / DLG-E02 confirm dismissed by default, accepted once after handle_dialog", async () => {
    const s = h.newSession();
    await freshPage(s);
    const first = await h.ok("click", { target: "#ask" }, s);
    assert.deepEqual(first.outcome.dialogs, [{ type: "confirm", message: "Delete this?", answer: false }]);
    await h.ok("handle_dialog", { accept: true }, s);
    const second = await h.ok("click", { target: "#ask" }, s);
    assert.equal(second.outcome.dialogs[0].answer, true);
    const third = await h.ok("click", { target: "#ask" }, s);
    assert.equal(third.outcome.dialogs[0].answer, false, "scope next reverts");
  });

  test("CLICK-E10 window.open is blocked in the DOM lane and the hint says trusted", async () => {
    const s = h.newSession();
    await freshPage(s);
    const r = await h.ok("click", { target: "#popup" }, s);
    assert.equal(r.outcome.newTabs.length, 0);
    assert.ok((await pageLog(s)).includes("popup=false"));
  });

  test("HOV-E01 / HOV-E02 script menu opens, CSS :hover menu does not and hints trusted", async () => {
    const s = h.newSession();
    await freshPage(s);
    const js = await h.ok("hover", { target: "#jsmenu" }, s);
    assert.equal(js.outcome.domChanged, true);
    const css = await h.ok("hover", { target: "#hovermenu" }, s);
    assert.match(css.hint ?? "", /trusted/);
  });

  test("TYPE-E01 / TYPE-E03 tracked input, contenteditable, submit", async () => {
    const s = h.newSession();
    await freshPage(s);
    assert.equal((await h.ok("type", { target: "#tracked", text: "abc" }, s)).value, "abc");
    assert.equal((await h.ok("type", { target: "#editor", text: "xyz" }, s)).value, "xyz");
    await h.ok("type", { target: "#query", text: "hello", submit: true }, s);
    const log = await pageLog(s);
    assert.ok(log.includes("tracked abc") && log.includes("editor xyz") && log.includes("submitted hello"), String(log));
  });

  test("TYPE-E02 slowly types key by key", async () => {
    const s = h.newSession();
    await freshPage(s);
    const r = await h.ok("type", { target: "#name", text: "ab", slowly: true }, s);
    assert.equal(r.value, "ab");
    const log = await pageLog(s);
    assert.ok(log.includes("name a") && log.includes("name ab"), String(log));
  });

  test("FORM-E01 / FORM-E02 / FORM-U01 fill_form sets text, checkbox, select; stops at the failing field", async () => {
    const s = h.newSession();
    await freshPage(s);
    const r = await h.ok("fill_form", { fields: [{ target: "#name", value: "Ann" }, { target: "#agree", value: true }, { target: "#color", value: "Green" }] }, s);
    assert.equal(r.failed, null);
    assert.deepEqual(r.fields.map((/** @type {any} */ f) => f.value), ["Ann", true, ["g"]]);
    const bad = await h.ok("fill_form", { fields: [{ target: "#name", value: "Bob" }, { target: "#agree", value: "yes" }] }, s);
    assert.equal(bad.failed.index, 1);
    assert.equal(bad.failed.error.code, "INVALID_PARAMS");
  });

  test("KEY-E01 / KEY-E02 Enter submits, Tab moves focus", async () => {
    const s = h.newSession();
    await freshPage(s);
    await h.ok("type", { target: "#query", text: "q1" }, s);
    const enter = await h.ok("press_key", { key: "Enter", target: "#query" }, s);
    assert.equal(enter.defaultAction, "submit");
    await h.ok("click", { target: "#name" }, s);
    const tab = await h.ok("press_key", { key: "Tab" }, s);
    assert.equal(tab.defaultAction, "focus");
    const focused = await h.ok("evaluate", { function: "() => document.activeElement.id" }, s);
    assert.equal(focused.value, "tracked");
    assert.equal((await h.call("press_key", { key: "Foo" }, s)).error.code, "INVALID_PARAMS");
  });

  test("SCR-E01 / SCR-E06 scroll page and bring into view", async () => {
    const s = h.newSession();
    await freshPage(s, "table.html");
    const down = await h.ok("scroll", { direction: "down" }, s);
    assert.ok(down.after.y > down.before.y);
    const bottom = await h.ok("scroll", { to: "bottom" }, s);
    assert.equal(bottom.atEnd, true);
    const top = await h.ok("scroll", { to: "top" }, s);
    assert.equal(top.after.y, 0);
  });

  test("UP-E01 / UP-E04 upload through the DOM lane; missing file refused", async () => {
    const s = h.newSession();
    await freshPage(s);
    const file = new URL("../fixtures/other.html", import.meta.url).pathname;
    const r = await h.ok("file_upload", { target: "#file", paths: [file] }, s);
    assert.equal(r.lane, "dom");
    assert.equal(r.files[0].name, "other.html");
    assert.ok((await pageLog(s)).some((/** @type {string} */ l) => l.startsWith("files other.html:")));
    assert.equal((await h.call("file_upload", { target: "#file", paths: ["/no/such/file"] }, s)).error.code, "FILE_NOT_FOUND");
  });
});

describe("waiting and evaluate", () => {
  test("WAIT-E01 / WAIT-E03 text appears in a background tab; timeout reports last state", async () => {
    const s = h.newSession();
    await freshPage(s, "delayed.html");
    await h.ok("click", { target: "#later" }, s);
    const r = await h.ok("wait_for", { text: "Appeared", timeout: 5 }, s);
    assert.ok(r.waitedMs < 4000, String(r.waitedMs));
    const never = await h.call("wait_for", { text: "Never there", timeout: 0.5 }, s);
    assert.equal(never.error.code, "TIMEOUT");
  });

  test("EVAL-E01 / EVAL-E02 / EVAL-E04 / EVAL-E07 values, element argument, errors, page globals", async () => {
    const s = h.newSession();
    await freshPage(s);
    assert.equal((await h.ok("evaluate", { function: "() => document.title" }, s)).value, "Fixture page");
    assert.equal((await h.ok("evaluate", { function: "document.title" }, s)).value, "Fixture page");
    assert.equal((await h.ok("evaluate", { function: "(el) => el.textContent", target: "#native" }, s)).value, "Native button");
    assert.equal((await h.ok("evaluate", { function: "() => window.__app.name" }, s)).value, "fixture-app");
    assert.equal((await h.ok("evaluate", { function: "async () => { await new Promise(r => setTimeout(r, 300)); return 7; }" }, s)).value, 7);
    const thrown = await h.call("evaluate", { function: "() => { throw new Error('boom'); }" }, s);
    assert.equal(thrown.error.code, "EVAL_ERROR");
    assert.match(thrown.error.message, /boom/);
    const node = await h.ok("evaluate", { function: "() => document.body" }, s);
    assert.equal(node.type, "node");
  });

  test("EVAL-E05 strict CSP page works through userScripts", async () => {
    const s = h.newSession();
    await freshPage(s, "csp/page.html");
    assert.equal((await h.ok("evaluate", { function: "() => document.title + ' ' + (1 + 1)" }, s)).value, "Fixture page 2");
  });

  test("NET-E01 / NET-E03 requests listed without the debugger; body needs capture", async () => {
    const s = h.newSession();
    await freshPage(s);
    await h.ok("evaluate", { function: "async () => { await fetch('/other.html'); await fetch('/child.html'); return 1; }" }, s);
    await sleep(300);
    const r = await h.ok("network_requests", { types: ["xhr"] }, s);
    assert.equal(r.lane, "dom");
    assert.deepEqual(r.requests.map((/** @type {any} */ q) => q.url.split("/").pop()).sort(), ["child.html", "other.html"]);
    assert.equal(r.requests[0].status, 200);
    assert.equal((await h.call("network_requests", { id: r.requests[0].id, body: true }, s)).error.code, "BODY_UNAVAILABLE");
  });
});

describe("extension health", () => {
  test("API-E01 the extension's Errors page stays empty", async () => {
    assert.deepEqual(await h.extensionErrors(), []);
  });
});
