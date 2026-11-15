// @ts-check
// DOM-lane tools against fixture pages in background tabs; no debugger anywhere.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { freshPage, pageLog, refIn, sleep, startHarness } from "./harness.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let h;

before(async () => {
  h = await startHarness();
});
after(async () => {
  await h?.close();
});




describe("tabs and navigate", () => {
  test("SES-E01 / TABS-E01 new tab is inactive, not grouped, current; user's tab unchanged", async () => {
    const s = h.newSession();
    const userTab = await h.activeTab();
    const r = await h.ok("tabs", { action: "new", url: `${h.base}/page.html` }, s);
    assert.equal(r.current, r.tab.tab);
    assert.equal(r.tab.title, "Fixture page");
    const active = await h.activeTab();
    assert.equal(active.tabId, userTab.tabId);
    const list = await h.ok("tabs", { action: "list" }, s);
    assert.ok(list.tabs.some((/** @type {any} */ t) => t.tab === r.tab.tab && t.mine && t.current));
  });

  test("TABS-E03 adopt a free tab, release it: owned, then free and still open", async () => {
    const owner = h.newSession();
    const tab = await freshPage(h, owner);
    await h.ok("tabs", { action: "release", tab }, owner);
    const s = h.newSession();
    await h.ok("tabs", { action: "adopt", tab }, s);
    assert.ok((await h.ok("tabs", { action: "list" }, s)).tabs.some((/** @type {any} */ t) => t.tab === tab && t.mine));
    await h.ok("tabs", { action: "release", tab }, s);
    const all = await h.ok("tabs", { action: "list", all: true }, s);
    const after = all.tabs.find((/** @type {any} */ t) => t.tab === tab);
    assert.ok(after, "still open");
    assert.equal(after.holder, null);
  });

  test("NAV-E01 navigate with no current tab opens one", async () => {
    const s = h.newSession();
    const r = await h.ok("navigate", { url: `${h.base}/other.html` }, s);
    assert.equal(r.title, "Other page");
    assert.equal(r.settled, true);
  });

  test("NAV-E02 back, forward, reload; NAV-U01 url and action together", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    await h.ok("navigate", { url: `${h.base}/other.html` }, s);
    assert.equal((await h.ok("navigate", { action: "back" }, s)).title, "Fixture page");
    assert.equal((await h.ok("navigate", { action: "forward" }, s)).title, "Other page");
    assert.equal((await h.ok("navigate", { action: "reload" }, s)).title, "Other page");
    const bad = await h.call("navigate", { url: "x", action: "back" }, s);
    assert.equal(bad.error.code, "INVALID_PARAMS");
  });

  test("NAV-E03 unreachable host", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const r = await h.call("navigate", { url: "http://127.0.0.1:9/" }, s);
    assert.equal(r.error?.code, "NAVIGATION_FAILED", JSON.stringify(r));
  });

  test("SES-U04 / TABS-E04 another session's tab is refused, adopt with force takes it", async () => {
    const a = h.newSession();
    const b = h.newSession();
    const tab = await freshPage(h, a);
    assert.equal((await h.call("snapshot", { tab }, b)).error.code, "TAB_NOT_OWNED");
    assert.equal((await h.call("tabs", { action: "adopt", tab }, b)).error.code, "TAB_NOT_OWNED");
    await h.ok("tabs", { action: "adopt", tab, force: true }, b);
    assert.equal((await h.call("snapshot", { tab }, a)).error.code, "TAB_NOT_OWNED");
  });

  test("TABS-E05 closing the current tab leaves no current tab", async () => {
    const s = h.newSession();
    const tab = await freshPage(h, s);
    const r = await h.ok("tabs", { action: "close", tab }, s);
    assert.equal(r.current, null);
    assert.equal((await h.call("click", { target: "#native" }, s)).error.code, "NO_TAB");
  });

  test("SES-E04 a session created with X-Browserctl-Close-Tabs closes the tabs it owns when it ends", async () => {
    const free = h.newSession();
    const adopted = await freshPage(h, free);
    await h.ok("tabs", { action: "release", tab: adopted }, free);
    const closing = h.newSession();
    const owned = (await h.ok("tabs", { action: "new", url: `${h.base}/page.html` }, closing, { "x-browserctl-close-tabs": "1" })).tab.tab;
    await h.ok("tabs", { action: "adopt", tab: adopted }, closing);
    const keeping = h.newSession();
    const kept = await freshPage(h, keeping);
    await h.endSession(closing);
    await h.endSession(keeping);
    const open = (await h.ok("tabs", { action: "list", all: true }, h.newSession())).tabs.map((/** @type {any} */ t) => t.tab);
    assert.ok(!open.includes(owned), "owned tab closed");
    assert.ok(open.includes(adopted), "adopted tab stays");
    assert.ok(open.includes(kept), "a session without the header keeps its tab");
  });

  test("API-E04 the MCP server with BROWSERCTL_CLOSE_TABS=1 closes its tabs on exit", async () => {
    /** @param {Record<string, string>} extra */
    const openTabThenExit = async (extra) => {
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "src/mcp/main.js")], env: { ...process.env, BROWSERCTL_PORT: String(h.port), ...extra } });
      const client = new Client({ name: "live-test", version: "1" });
      await client.connect(transport);
      const result = /** @type {any} */ (await client.callTool({ name: "tabs", arguments: { action: "new", url: `${h.base}/page.html` } }));
      const tab = JSON.parse(result.content[0].text).tab.tab;
      await client.close();
      return tab;
    };
    const closed = await openTabThenExit({ BROWSERCTL_CLOSE_TABS: "1" });
    const kept = await openTabThenExit({});
    let open = [];
    for (let i = 0; i < 20; i++) {
      open = (await h.ok("tabs", { action: "list", all: true }, h.newSession())).tabs.map((/** @type {any} */ t) => t.tab);
      if (!open.includes(closed)) break;
      await sleep(100);
    }
    assert.ok(!open.includes(closed), "closed on exit");
    assert.ok(open.includes(kept), "kept without the variable");
  });
});

describe("settle", () => {
  const done = async (/** @type {string} */ s) => (await h.ok("evaluate", { function: "() => [...document.querySelectorAll('.done')].map((e) => e.textContent)" }, s)).value;

  test("SET-E01 a click that changes nothing returns quickly with domChanged false", async () => {
    const s = h.newSession();
    await freshPage(h, s, "reactions.html");
    const started = Date.now();
    const r = await h.ok("click", { target: "#nothing" }, s);
    assert.ok(Date.now() - started < 1200, `took ${Date.now() - started} ms`);
    assert.equal(r.outcome.domChanged, false);
    assert.equal(r.outcome.settled, true);
  });

  test("SET-E02 / SET-E06 a reaction from a 0 ms timer and a spinner-then-content chain are waited for, background and foreground", async () => {
    for (const focus of [false, true]) {
      const s = h.newSession();
      const tab = await freshPage(h, s, "reactions.html");
      if (focus) await h.ok("tabs", { action: "select", tab, focus: true }, s);
      const later = await h.ok("click", { target: "#t0" }, s);
      assert.equal(later.outcome.domChanged, true);
      const chain = await h.ok("click", { target: "#chain" }, s);
      assert.equal(chain.outcome.settled, true);
      assert.deepEqual(await done(s), ["done t0", "done spinner", "done chain"], `focus: ${focus}`);
    }
  });

  test("SET-E03 / CLICK-E08 a ticker that never stops returns at 3 s with settled false", async () => {
    const s = h.newSession();
    await freshPage(h, s, "reactions.html");
    const started = Date.now();
    const r = await h.ok("click", { target: "#ticker" }, s);
    const took = Date.now() - started;
    assert.equal(r.outcome.settled, false);
    assert.ok(took >= 2900 && took < 4500, `took ${took} ms`);
  });

  test("SET-E04 a link to a page the server delays 2 s waits for it", async () => {
    const s = h.newSession();
    await freshPage(h, s, "reactions.html");
    const r = await h.ok("click", { target: "#slowlink" }, s);
    assert.equal(r.outcome.urlChanged, true);
    assert.equal(r.outcome.title, "Other page");
    assert.equal(r.outcome.settled, true);
  });

  test("SET-E05 a pushState navigation reports the new URL without a load wait", async () => {
    const s = h.newSession();
    await freshPage(h, s, "reactions.html");
    const started = Date.now();
    const r = await h.ok("click", { target: "#push" }, s);
    assert.equal(r.outcome.urlChanged, true);
    assert.match(r.outcome.url, /#pushed$/);
    assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  });

  test("SET-E07 a reaction 700 ms later needs wait on the action", async () => {
    const s = h.newSession();
    await freshPage(h, s, "reactions.html");
    await h.ok("click", { target: "#t700" }, s);
    assert.deepEqual(await done(s), []);
    await freshPage(h, s, "reactions.html");
    const r = await h.ok("click", { target: "#t700", wait: { text: "done t700" } }, s);
    assert.equal(r.waited.ok, true);
    assert.ok(r.waited.waitedMs > 0, "the wait did the waiting");
    assert.deepEqual(await done(s), ["done t700"]);
  });
});

describe("blocked pages", () => {
  test("DOM-E09 an alert opened while loading in the focused tab: TIMEOUT with the page-blocked hint", async () => {
    const s = h.newSession();
    const tab = await freshPage(h, s);
    await h.ok("tabs", { action: "select", tab, focus: true }, s);
    await h.call("navigate", { url: `${h.base}/early-alert.html` }, s);
    const r = await h.call("snapshot", {}, s);
    assert.equal(r.error?.code, "TIMEOUT", JSON.stringify(r));
    assert.match(r.error.hint, /dialog only the user can answer/);
    await h.ok("tabs", { action: "close", tab }, s);
    const open = (await h.ok("tabs", { action: "list", all: true }, s)).tabs.map((/** @type {any} */ t) => t.tab);
    assert.ok(!open.includes(tab));
  });
});

describe("snapshot and read", () => {
  test("SNAP-E01 / SNAP-E04 cursor:pointer div has a ref; background tab, no debugger", async () => {
    const s = h.newSession();
    await freshPage(h, s);
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
    await freshPage(h, s);
    const first = (await h.ok("snapshot", {}, s)).snapshot;
    const native = refIn(first, 'button "Native button"');
    const list = refIn(first, /- list/);
    const partial = await h.ok("snapshot", { target: list }, s);
    assert.ok(!partial.snapshot.includes("Native button"));
    const again = (await h.ok("snapshot", {}, s)).snapshot;
    assert.equal(refIn(again, 'button "Native button"'), native);
    await h.ok("click", { target: native }, s);
    assert.ok((await pageLog(h, s)).includes("native trusted=false"));
  });

  test("SNAP-E03 / TGT-E04 same-origin and cross-origin frames nest with frame refs", async () => {
    const s = h.newSession();
    await freshPage(h, s, "frames.html");
    await sleep(500);
    const r = await h.ok("snapshot", {}, s);
    const childButtons = r.snapshot.split("\n").filter((/** @type {string} */ l) => l.includes('button "Child button"'));
    assert.equal(childButtons.length, 2, r.snapshot);
    const frameRefs = childButtons.map((/** @type {string} */ l) => /\[ref=(f\d+e\d+)\]/.exec(l)?.[1]);
    assert.ok(frameRefs.every(Boolean) && frameRefs[0] !== frameRefs[1], r.snapshot);
    const clicked = await h.ok("click", { target: frameRefs[1] }, s);
    assert.equal(clicked.resolved.name, "Child button");
  });

  test("SNAP-E06 an iframe inside an open shadow root nests with a frame ref", async () => {
    const s = h.newSession();
    await freshPage(h, s, "shadow-frame.html");
    await sleep(500);
    const r = await h.ok("snapshot", {}, s);
    const lines = r.snapshot.split("\n").filter((/** @type {string} */ l) => l.includes('button "Child button"'));
    assert.equal(lines.length, 1, r.snapshot);
    const ref = /\[ref=(f\d+e\d+)\]/.exec(lines[0])?.[1];
    assert.ok(ref, r.snapshot);
    assert.equal((await h.ok("click", { target: ref }, s)).resolved.name, "Child button");
  });

  test("SNAP-E07 facts: empty, type, near, value, ctx; every annotated ref acts", async () => {
    const s = h.newSession();
    await freshPage(h, s, "facts.html");
    const r = await h.ok("snapshot", {}, s);
    const line = (/** @type {string} */ part) => r.snapshot.split("\n").find((/** @type {string} */ l) => l.includes(part)) ?? "";
    assert.match(line('textbox "First name"'), /\[empty\]/, r.snapshot);
    assert.doesNotMatch(line('textbox "Last name"'), /\[empty\]/, r.snapshot);
    assert.match(line('textbox "Email"'), /\[type=email\] \[empty\]/, r.snapshot);
    assert.match(line("- combobox"), /\[near="State and City"\]/, r.snapshot);
    assert.match(line('slider "Volume"'), /\[value=40\]/, r.snapshot);
    assert.match(line('progressbar "Upload"'), /\[value=30\]/, r.snapshot);
    const replies = r.snapshot.split("\n").filter((/** @type {string} */ l) => l.includes('button "Reply"'));
    assert.equal(replies.length, 2, r.snapshot);
    assert.match(replies[0], /\[ctx="First post title"\]/);
    assert.match(replies[1], /\[ctx="Second post title"\]/);
    await h.ok("fill_form", { fields: [{ target: refIn(r.snapshot, 'textbox "First name"'), value: "Ann" }, { target: refIn(r.snapshot, "- combobox"), value: "Hanoi" }] }, s);
    await h.ok("click", { target: refIn(replies[1], "Reply") }, s);
    assert.deepEqual(await pageLog(h, s), ["reply second"]);
    const again = await h.ok("snapshot", {}, s);
    assert.doesNotMatch(again.snapshot.split("\n").find((/** @type {string} */ l) => l.includes('textbox "First name"')) ?? "", /\[empty\]/);
  });

  test("SNAP-E11 ctx of look-alike buttons outside items: the closest heading before each, other components' shadow headings ignored", async () => {
    const s = h.newSession();
    await freshPage(h, s, "ctx.html");
    const r = await h.ok("snapshot", {}, s);
    const edits = r.snapshot.split("\n").filter((/** @type {string} */ l) => l.includes('button "Edit"'));
    assert.equal(edits.length, 2, r.snapshot);
    assert.match(edits[0], /\[ctx="Section A"\]/, r.snapshot);
    assert.match(edits[1], /\[ctx="Section B"\]/, r.snapshot);
  });

  test("SNAP-E12 ctx of look-alike buttons inside a component: the heading before them in its shadow root", async () => {
    const s = h.newSession();
    await freshPage(h, s, "ctx-shadow.html");
    const r = await h.ok("snapshot", {}, s);
    const edits = r.snapshot.split("\n").filter((/** @type {string} */ l) => l.includes('button "Edit"'));
    assert.equal(edits.length, 2, r.snapshot);
    assert.match(edits[0], /\[ctx="Shadow A"\]/, r.snapshot);
    assert.match(edits[1], /\[ctx="Shadow B"\]/, r.snapshot);
  });

  test("SNAP-E02 / SNAP-E05 snapshot of a ref's subtree; open shadow root content with refs that act", async () => {
    const s = h.newSession();
    await freshPage(h, s, "targets.html");
    const all = await h.ok("snapshot", {}, s);
    assert.ok(all.snapshot.includes("Shadow text"), all.snapshot);
    await h.ok("click", { target: refIn(all.snapshot, 'button "Shadow button"') }, s);
    const part = await h.ok("snapshot", { target: refIn(all.snapshot, 'region "Part"') }, s);
    assert.ok(part.snapshot.includes('button "Inside button"') && !part.snapshot.includes("Same"), part.snapshot);
    await h.ok("click", { target: refIn(part.snapshot, 'button "Inside button"') }, s);
    assert.deepEqual(await pageLog(h, s), ["shadow", "inside"]);
  });

  test("TGT-E02 / TGT-E03 / TGT-E06 refs die with navigation and with their element; ambiguity lists the matches", async () => {
    const s = h.newSession();
    await freshPage(h, s, "targets.html");
    const snap = (await h.ok("snapshot", {}, s)).snapshot;
    const old = refIn(snap, 'button "Replace me"');
    await h.ok("click", { target: "#replace" }, s);
    assert.equal((await h.call("click", { target: old }, s)).error.code, "REF_NOT_FOUND");
    assert.deepEqual(await pageLog(h, s), [], "the new identical button was not clicked");
    const many = (await h.call("click", { target: 'role=button[name="Same"]', timeout: 0 }, s)).error;
    assert.equal(many.code, "AMBIGUOUS_TARGET");
    assert.equal(many.count, 3);
    assert.equal(many.candidates.length, 3);
    const inside = refIn(snap, 'button "Inside button"');
    await h.ok("navigate", { url: `${h.base}/other.html` }, s);
    assert.equal((await h.call("click", { target: inside }, s)).error.code, "REF_NOT_FOUND");
  });

  test("TYPE-E04 / FORM-E04 / FORM-E05 masked field, missing option, custom switch", async () => {
    const s = h.newSession();
    await freshPage(h, s, "targets.html");
    assert.equal((await h.ok("type", { target: "#phone", text: "1234567890" }, s)).value, "(123) 456-7890");
    const missing = await h.ok("fill_form", { fields: [{ target: "#size", value: "Huge" }], timeout: 0.5 }, s);
    assert.equal(missing.failed?.error.code, "OPTION_NOT_FOUND");
    const sw = await h.ok("fill_form", { fields: [{ target: "#dark", value: true }] }, s);
    assert.equal(sw.failed, null);
    assert.equal((await h.ok("get", { target: "#dark", what: "value" }, s)).value, true);
  });

  test("SNAP-E08 a full-screen overlay is a modal; a fixed app shell is not; the modal's button acts", async () => {
    const s = h.newSession();
    await freshPage(h, s, "overlay.html");
    const r = await h.ok("snapshot", {}, s);
    assert.ok(r.modal, JSON.stringify(r.modal));
    assert.match(r.snapshot.split("\n")[0], /^- \(a modal layer covers the page, starting at \[ref=e\d+\]; act inside it or close it first\)$/, r.snapshot);
    assert.ok(r.snapshot.includes(`[ref=${r.modal.ref}] [modal]`), r.snapshot);
    await h.ok("click", { target: refIn(r.snapshot, 'button "Accept all"') }, s);
    const after = await h.ok("snapshot", {}, s);
    assert.equal(after.modal, null, after.snapshot);
    await freshPage(h, s, "shell.html");
    const shell = await h.ok("snapshot", {}, s);
    assert.equal(shell.modal, null, shell.snapshot);
    assert.doesNotMatch(shell.snapshot, /modal/);
    await freshPage(h, s, "overlay2.html");
    const backdrop = await h.ok("snapshot", {}, s);
    assert.match(backdrop.snapshot.split("\n")[0], /^- \(a modal dialog "Welcome" covers the page, starting at \[ref=e\d+\]/, backdrop.snapshot);
  });

  test("SNAP-E09 a page that renders after a slow request is waited for", async () => {
    const s = h.newSession();
    await h.ok("navigate", { url: `${h.base}/late.html` }, s);
    const r = await h.ok("snapshot", {}, s);
    assert.ok(r.snapshot.includes('button "Loaded content"'), r.snapshot);
    assert.equal(r.ready, true, JSON.stringify(r.readiness));
    assert.ok(r.readiness.waitedMs >= 200, JSON.stringify(r.readiness));
    assert.ok(!r.snapshot.startsWith("- (page not ready"), r.snapshot);
  });

  test("SNAP-E10 a link in a closed menu is marked hidden, gets a ref once the menu opens", async () => {
    const s = h.newSession();
    await freshPage(h, s, "menu.html");
    const r = await h.ok("snapshot", {}, s);
    assert.match(r.snapshot, /- link "Edit" \[hidden\]/, r.snapshot);
    await h.ok("click", { target: refIn(r.snapshot, 'button "Menu"') }, s);
    const open = await h.ok("snapshot", {}, s);
    const edit = refIn(open.snapshot, 'link "Edit"');
    assert.ok(edit, open.snapshot);
    await h.ok("click", { target: edit }, s);
    assert.deepEqual(await pageLog(h, s), ["edit"]);
  });

  test("READ-E02 / READ-E03 / READ-E01 full table across slices, hidden text absent, main only", async () => {
    const s = h.newSession();
    await freshPage(h, s, "table.html");
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
    await freshPage(h, s, "frames.html");
    await sleep(500);
    const r = await h.ok("read", {}, s);
    assert.equal(r.text.split("Child text here").length - 1, 2, r.text);
  });
});

describe("acting", () => {
  test("CLICK-E01 / CLICK-E02 synthetic clicks in a background tab; user's tab unchanged", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const userTab = await h.activeTab();
    const native = await h.ok("click", { target: "#native" }, s);
    assert.equal(native.lane, "dom");
    assert.equal(native.resolved.by, "selector");
    assert.equal(native.resolved.name, "Native button");
    await h.ok("click", { target: "text=Open conversation" }, s);
    const log = await pageLog(h, s);
    assert.ok(log.includes("native trusted=false") && log.includes("fake"), String(log));
    assert.equal((await h.activeTab()).tabId, userTab.tabId);
  });

  test("CLICK-E11 errors: covered, disabled, ambiguous, unknown ref, bad selector", async () => {
    const s = h.newSession();
    await freshPage(h, s);
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
    await freshPage(h, s);
    const snap = (await h.ok("snapshot", {}, s)).snapshot;
    const link = refIn(snap, 'link "Go to other"');
    const r = await h.ok("click", { target: link }, s);
    assert.equal(r.outcome.urlChanged, true);
    assert.equal(r.outcome.title, "Other page");
    assert.equal(r.outcome.settled, true);
    assert.equal((await h.call("click", { target: link }, s)).error.code, "REF_NOT_FOUND");
  });

  test("CLICK-E04 target=_blank opens a tab owned by the session, in the background, also while another session's tab is active", async () => {
    for (const otherActive of [false, true]) {
      if (otherActive) {
        const other = h.newSession();
        const tab = await freshPage(h, other);
        await h.ok("tabs", { action: "select", tab, focus: true }, other);
      }
      const before = await h.activeTab();
      const s = h.newSession();
      await freshPage(h, s);
      const r = await h.ok("click", { target: "#blank" }, s);
      assert.equal(r.outcome.newTabs.length, 1, JSON.stringify(r.outcome));
      const list = await h.ok("tabs", { action: "list" }, s);
      assert.ok(list.tabs.some((/** @type {any} */ t) => t.tab === r.outcome.newTabs[0].tab && t.mine));
      assert.equal((await h.activeTab()).tabId, before.tabId, "the user's view did not change");
    }
  });

  test("CLICK-E05 / DLG-E01 / DLG-E02 confirm dismissed by default, accepted once after handle_dialog", async () => {
    const s = h.newSession();
    await freshPage(h, s);
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
    await freshPage(h, s);
    const r = await h.ok("click", { target: "#popup" }, s);
    assert.equal(r.outcome.newTabs.length, 0);
    assert.ok((await pageLog(h, s)).includes("popup=false"));
  });

  test("HOV-E01 / HOV-E02 script menu opens, CSS :hover menu does not and hints trusted", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const js = await h.ok("hover", { target: "#jsmenu" }, s);
    assert.equal(js.outcome.domChanged, true);
    const css = await h.ok("hover", { target: "#hovermenu" }, s);
    assert.match(css.hint ?? "", /trusted/);
  });

  test("TYPE-E01 / TYPE-E03 / DOM-E04 tracked input, contenteditable, submit", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    assert.equal((await h.ok("type", { target: "#tracked", text: "abc" }, s)).value, "abc");
    assert.equal((await h.ok("type", { target: "#editor", text: "xyz" }, s)).value, "xyz");
    await h.ok("type", { target: "#query", text: "hello", submit: true }, s);
    const log = await pageLog(h, s);
    assert.ok(log.includes("tracked abc") && log.includes("editor xyz") && log.includes("submitted hello"), String(log));
  });

  test("TYPE-E05 / FORM-E03 an editor that renders a microtask later; value before submit", async () => {
    const s = h.newSession();
    await freshPage(h, s, "editors.html");
    const text = 'Draft <b>&amp; "q" \'s\' é 你好 😀 \\ / | ~';
    assert.equal((await h.ok("type", { target: "#lex", text }, s)).value, text);
    const form = await h.ok("fill_form", { fields: [{ target: "#lex", value: "second" }] }, s);
    assert.equal(form.fields[0].value, "second");
    assert.equal((await h.ok("type", { target: "#q", text: "hello", submit: true }, s)).value, "hello");
    assert.deepEqual(await pageLog(h, s), ["submitted hello"]);
  });

  test("TYPE-E02 slowly types key by key", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const r = await h.ok("type", { target: "#name", text: "ab", slowly: true }, s);
    assert.equal(r.value, "ab");
    const log = await pageLog(h, s);
    assert.ok(log.includes("name a") && log.includes("name ab"), String(log));
  });

  test("FORM-E01 / FORM-E02 / FORM-U01 fill_form sets text, checkbox, select; stops at the failing field", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const r = await h.ok("fill_form", { fields: [{ target: "#name", value: "Ann" }, { target: "#agree", value: true }, { target: "#color", value: "Green" }] }, s);
    assert.equal(r.failed, null);
    assert.deepEqual(r.fields.map((/** @type {any} */ f) => f.value), ["Ann", true, ["g"]]);
    const bad = await h.ok("fill_form", { fields: [{ target: "#name", value: "Bob" }, { target: "#agree", value: "yes" }] }, s);
    assert.equal(bad.failed.index, 1);
    assert.equal(bad.failed.error.code, "INVALID_PARAMS");
  });

  test("KEY-E01 / KEY-E02 Enter submits, Tab moves focus", async () => {
    const s = h.newSession();
    await freshPage(h, s);
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
    await freshPage(h, s, "table.html");
    const down = await h.ok("scroll", { direction: "down" }, s);
    assert.ok(down.after.y > down.before.y);
    const bottom = await h.ok("scroll", { to: "bottom" }, s);
    assert.equal(bottom.atEnd, true);
    const top = await h.ok("scroll", { to: "top" }, s);
    assert.equal(top.after.y, 0);
  });

  test("UP-E01 / UP-E04 upload through the DOM lane; missing file refused", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    const file = new URL("../fixtures/other.html", import.meta.url).pathname;
    const r = await h.ok("file_upload", { target: "#file", paths: [file] }, s);
    assert.equal(r.lane, "dom");
    assert.equal(r.files[0].name, "other.html");
    assert.ok((await pageLog(h, s)).some((/** @type {string} */ l) => l.startsWith("files other.html:")));
    assert.equal((await h.call("file_upload", { target: "#file", paths: ["/no/such/file"] }, s)).error.code, "FILE_NOT_FOUND");
  });
});

describe("locators, get and common action parameters", () => {
  /** @param {string} s @param {string} tool @param {object} params */
  const fails = async (s, tool, params) => (await h.call(tool, params, s)).error;

  test("TGT-E08 every locator form resolves and acts in the DOM lane", async () => {
    const s = h.newSession();
    await freshPage(h, s, "locators.html");
    const text = async (/** @type {string} */ target) => (await h.ok("get", { target }, s)).value;
    const value = async (/** @type {string} */ target) => (await h.ok("get", { target, what: "value" }, s)).value;
    assert.equal(await text("id=save"), "Save");
    assert.equal(await text("#save"), "Save");
    assert.equal(await text('role=button[name="Save"]'), "Save");
    assert.equal(await text("text=Docs"), "Docs");
    assert.equal(await text('xpath=//a[@id="doc"]'), "Docs");
    assert.equal(await text("#items li >> nth=2"), "three");
    assert.equal(await value("name=email"), "a@b.c");
    assert.equal(await value("label=Email"), "a@b.c");
    assert.equal(await value('label="Email"'), "a@b.c");
    assert.equal((await h.ok("get", { target: "placeholder=search", what: "attribute", name: "id" }, s)).value, "q");
    for (const target of ["id=save", "testid=submit-btn", "alt=Company logo", "title=Close dialog"]) await h.ok("click", { target }, s);
    assert.deepEqual(await pageLog(h, s), ["save", "submit", "logo", "close"]);
    const bad = await fails(s, "click", { target: "label=Nope", timeout: 0 });
    assert.equal(bad.code, "TARGET_NOT_FOUND");
    assert.match(bad.message, /label=Nope/, "message names the locator as written");
  });

  test("GET-E01 / GET-E02 / GET-E03 values, attributes, properties, html and hidden text", async () => {
    const s = h.newSession();
    await freshPage(h, s, "locators.html");
    const get = async (/** @type {object} */ params) => (await h.ok("get", params, s)).value;
    assert.equal(await get({ target: "#one", what: "value" }), "g");
    assert.deepEqual(await get({ target: "#many", what: "value" }), ["a", "c"]);
    assert.equal(await get({ target: "#agree", what: "value" }), true);
    assert.equal(await get({ target: "#sw", what: "value" }), true);
    assert.equal(await get({ target: "#doc", what: "attribute", name: "href" }), "/docs/page");
    assert.equal(await get({ target: "#doc", what: "attribute", name: "nope" }), null);
    assert.equal(await get({ target: "#doc", what: "property", name: "dataset.id" }), "42");
    assert.equal(await get({ target: "#bad", what: "property", name: "validity.valid" }), false);
    assert.equal(await get({ target: "#bad", what: "property", name: "validity" }), "[object ValidityState]");
    assert.equal(await get({ target: "#hidden" }), "Secret text");
    const note = await h.ok("get", { target: "#note", what: "value", maxChars: 100 }, s);
    assert.equal(note.value.length, 100);
    assert.ok(note.cut > 0);
    const html = await h.ok("get", { target: "#long", what: "html", maxChars: 100 }, s);
    assert.equal(html.value.length, 100);
    assert.ok(html.cut > 0);
  });

  test("GET-E04 / GET-E05 / GET-E07 state, box, all matches, frame ref", async () => {
    const s = h.newSession();
    await freshPage(h, s, "locators.html");
    const off = (await h.ok("get", { target: "#off", what: "state" }, s)).value;
    assert.equal(off.enabled, false);
    assert.equal(off.visible, true);
    assert.equal((await h.ok("get", { target: "#agree", what: "state" }, s)).value.checked, true);
    assert.equal((await h.ok("get", { target: "#far", what: "state" }, s)).value.inViewport, false);
    const box = (await h.ok("get", { target: "#save", what: "box" }, s)).value;
    assert.ok(box.width > 0 && box.inViewport, JSON.stringify(box));
    const all = await h.ok("get", { target: "css=#items li", all: true }, s);
    assert.equal(all.count, 12);
    assert.equal(all.items[11].value, "twelve");
    assert.equal((await fails(s, "get", { target: "css=#items li", timeout: 0 })).code, "AMBIGUOUS_TARGET");
    await sleep(500);
    const snap = await h.ok("snapshot", {}, s);
    const child = /\[ref=(f\d+e\d+)\]/.exec(snap.snapshot.split("\n").find((/** @type {string} */ l) => l.includes('button "Child button"')) ?? "")?.[1];
    assert.ok(child, snap.snapshot);
    assert.equal((await h.ok("get", { target: child }, s)).value, "Child button");
  });

  test("ACT-E01 / ACT-E02 wait after a click: met, and timed out without failing the click", async () => {
    const s = h.newSession();
    await freshPage(h, s, "actions.html");
    const met = await h.ok("click", { target: "#show", wait: { text: "Shown later" } }, s);
    assert.equal(met.waited.ok, true, JSON.stringify(met.waited));
    const missed = await h.ok("click", { target: "#show", wait: { text: "never there", timeout: 0.5 } }, s);
    assert.equal(missed.waited.ok, false);
    assert.match(missed.hint, /action ran, but the wait condition did not hold/);
    assert.equal((await h.ok("click", { target: "#show" }, s)).waited, null);
  });

  test("ACT-E03 / GET-E06 timeout: short fails fast, long waits for the element", async () => {
    const s = h.newSession();
    await freshPage(h, s, "actions.html");
    await h.ok("click", { target: "#spawn" }, s);
    const started = Date.now();
    const quick = await fails(s, "click", { target: "#late", timeout: 0.3 });
    assert.equal(quick.code, "TARGET_NOT_FOUND");
    assert.match(quick.message, /gave up after 0\.3 s; raise timeout to wait longer/);
    assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
    await h.ok("click", { target: "#late", timeout: 5 }, s);
    assert.deepEqual(await pageLog(h, s), ["late"]);
    await freshPage(h, s, "actions.html");
    await h.ok("click", { target: "#spawn" }, s);
    assert.equal((await h.call("get", { target: "#late", timeout: 0 }, s)).error?.code, "TARGET_NOT_FOUND", "absent when the wait begins");
    assert.equal((await h.ok("get", { target: "#late", timeout: 6 }, s)).value, "Late button");
  });

  test("ACT-E04 scroll: none refuses an element outside the viewport, center scrolls it to the middle", async () => {
    const s = h.newSession();
    await freshPage(h, s, "actions.html");
    assert.equal((await fails(s, "click", { target: "#far", scroll: "none" })).code, "TARGET_OUTSIDE_VIEWPORT");
    assert.deepEqual(await pageLog(h, s), []);
    await h.ok("click", { target: "#far", scroll: "center" }, s);
    assert.deepEqual(await pageLog(h, s), ["far"]);
    assert.equal((await h.ok("get", { target: "#far", what: "state" }, s)).value.inViewport, true);
  });

  test("ACT-E07 fill_form with a failing field does not wait", async () => {
    const s = h.newSession();
    await freshPage(h, s, "locators.html");
    const started = Date.now();
    const r = await h.ok("fill_form", { fields: [{ target: "#q", value: "x" }, { target: "#nope", value: "y" }], timeout: 0.3, wait: { text: "never there", timeout: 5 } }, s);
    assert.equal(r.failed.index, 1);
    assert.equal(r.waited, null);
    assert.ok(Date.now() - started < 4000, `${Date.now() - started} ms`);
  });

  test("ACT-E06 navigate with wait", async () => {
    const s = h.newSession();
    const r = await h.ok("navigate", { url: `${h.base}/late.html`, wait: { text: "Loaded content" } }, s);
    assert.equal(r.waited.ok, true, JSON.stringify(r.waited));
  });
});

describe("waiting and evaluate", () => {
  test("WAIT-E01 / WAIT-E03 text appears in a background tab; timeout reports last state", async () => {
    const s = h.newSession();
    await freshPage(h, s, "delayed.html");
    await h.ok("click", { target: "#later" }, s);
    const r = await h.ok("wait_for", { text: "Appeared", timeout: 5 }, s);
    assert.ok(r.waitedMs < 4000, String(r.waitedMs));
    const never = await h.call("wait_for", { text: "Never there", timeout: 0.5 }, s);
    assert.equal(never.error.code, "TIMEOUT");
  });

  test("EVAL-E01 / EVAL-E02 / EVAL-E04 / EVAL-E07 values, element argument, errors, page globals", async () => {
    const s = h.newSession();
    await freshPage(h, s);
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
    await freshPage(h, s, "csp/page.html");
    assert.equal((await h.ok("evaluate", { function: "() => document.title + ' ' + (1 + 1)" }, s)).value, "Fixture page 2");
  });

  test("EVAL-E09 page globals named like the wrapper's variables are the page's", async () => {
    const s = h.newSession();
    await freshPage(h, s);
    await h.ok("evaluate", { function: "() => { window.result = 'r'; window.value = 'v'; window.element = 'e'; window.mark = 'm'; window.input = 'i'; }" }, s);
    for (const trusted of [false, true]) {
      assert.deepEqual((await h.ok("evaluate", { function: "() => [result, value, element, mark, input]", trusted }, s)).value, ["r", "v", "e", "m", "i"]);
      assert.deepEqual((await h.ok("evaluate", { function: "[result, value]", trusted }, s)).value, ["r", "v"]);
      assert.equal((await h.ok("evaluate", { function: "(el) => [el.id, result]", target: "#native", trusted }, s)).value.join(), "native,r");
    }
  });

  test("NET-E01 / NET-E03 requests listed without the debugger; body needs capture", async () => {
    const s = h.newSession();
    await freshPage(h, s);
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
