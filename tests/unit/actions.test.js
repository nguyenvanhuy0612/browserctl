// @ts-check
// Locator rewriting (specs/targets.md) and the common action parameters (specs/actions.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry } from "../../src/daemon/registry.js";
import { toSelector } from "../../src/daemon/targets.js";
import { checkWait } from "../../src/daemon/tools/common.js";
import { tools } from "../../src/daemon/tools/index.js";

test("TGT-U01 / TGT-U02 refs and Playwright selectors pass through unchanged", () => {
  for (const t of ["e5", "f12e3", "text=e5", "#e5", "e5x", "button", "css=div >> nth=1", "xpath=//button[2]", "//button", "id=save", "role=button[name=\"Save\"]", "data-testid=x"]) {
    assert.equal(toSelector(t), t);
  }
});

test("TGT-U03 friendly locator forms become Playwright selectors, also inside chains", () => {
  assert.equal(toSelector("name=email"), 'css=[name="email"]');
  assert.equal(toSelector("label=Email"), 'internal:label="Email"i');
  assert.equal(toSelector('label="Email"'), 'internal:label="Email"s');
  assert.equal(toSelector("placeholder=Search"), 'internal:attr=[placeholder="Search"i]');
  assert.equal(toSelector("testid=submit"), 'internal:testid=[data-testid="submit"s]');
  assert.equal(toSelector("alt=Logo"), 'internal:attr=[alt="Logo"i]');
  assert.equal(toSelector("title=Close"), 'internal:attr=[title="Close"i]');
  assert.equal(toSelector('name=a"b'), 'css=[name="a\\"b"]');
  assert.equal(toSelector("css=form >> label=Email >> nth=0"), 'css=form >> internal:label="Email"i >> nth=0');
  assert.equal(toSelector("form>>label=Email"), 'form>>internal:label="Email"i');
  assert.equal(toSelector('text="a >> b"'), 'text="a >> b"');
  assert.equal(toSelector('label="a >> b"'), 'internal:label="a >> b"s');
});

test("ACT-U01 wait needs exactly one condition; timeout and scroll are bounded", () => {
  assert.throws(() => checkWait({ text: "a", url: "b" }), /exactly one/);
  assert.throws(() => checkWait({ timeout: 3 }), /exactly one/);
  assert.doesNotThrow(() => checkWait({ text: "a" }));
  assert.doesNotThrow(() => checkWait(undefined));
  const registry = new Registry(tools);
  const bad = [
    { target: "e1", timeout: 61 },
    { target: "e1", scroll: "top" },
    { target: "e1", wait: { text: "x", bogus: 1 } },
    { target: "e1", wait: { text: "" } },
  ];
  for (const params of bad) assert.throws(() => registry.validate("click", params), (/** @type {any} */ e) => e.code === "INVALID_PARAMS", JSON.stringify(params));
  const ok = /** @type {any} */ (registry.validate("click", { target: "label=Email", wait: { text: "Saved" } }));
  assert.equal(ok.timeout, 5);
  assert.equal(ok.scroll, "auto");
  assert.equal(ok.wait.timeout, 10);
  for (const name of ["click", "hover", "type", "fill_form", "press_key", "scroll", "file_upload", "navigate"]) {
    assert.ok(registry.get(name).inputSchema.properties.wait, `${name} has wait`);
  }
});

test("GET-U01 name is required for attribute and property, refused otherwise", async () => {
  const get = tools.find((t) => t.name === "get");
  assert.ok(get);
  const daemon = /** @type {any} */ (new Proxy({}, { get: () => { throw new Error("the page must not be called"); } }));
  const session = /** @type {any} */ ({});
  const base = { target: "e1", all: false, maxChars: 5000, timeout: 5 };
  await assert.rejects(get.handler({ ...base, what: "attribute" }, { daemon, session }), (/** @type {any} */ e) => e.code === "INVALID_PARAMS");
  await assert.rejects(get.handler({ ...base, what: "text", name: "href" }, { daemon, session }), (/** @type {any} */ e) => e.code === "INVALID_PARAMS");
});
