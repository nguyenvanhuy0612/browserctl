import { test } from "node:test";
import assert from "node:assert/strict";
import { swallow, noteSwallowed } from "../../extension/util.js";

function captureDebug(fn) {
  const calls = [];
  const orig = console.debug;
  console.debug = (...args) => calls.push(args);
  try {
    fn();
  } finally {
    console.debug = orig;
  }
  return calls;
}

test("swallow returns a handler that logs the tag and message once", () => {
  const handler = swallow("cdp.test");
  assert.equal(typeof handler, "function");
  const calls = captureDebug(() => handler(new Error("boom")));
  assert.deepEqual(calls, [["[browserctl] swallowed", "cdp.test", "boom"]]);
});

test("noteSwallowed logs the same shape", () => {
  const calls = captureDebug(() => noteSwallowed("bg.test", new Error("bang")));
  assert.deepEqual(calls, [["[browserctl] swallowed", "bg.test", "bang"]]);
});

test("a non-Error rejection value is logged as its string form", () => {
  const calls = captureDebug(() => {
    swallow("t")("plain");
    swallow("t")(undefined);
    swallow("t")(null);
  });
  assert.deepEqual(
    calls.map((c) => c[2]),
    ["plain", "undefined", "null"]
  );
});

test("neither helper throws on a value whose toString throws", () => {
  const hostile = {
    toString() {
      throw new Error("no");
    },
  };
  const calls = captureDebug(() => {
    assert.doesNotThrow(() => swallow("t")(hostile));
    assert.doesNotThrow(() => noteSwallowed("t", hostile));
  });
  assert.equal(calls.length, 2);
});

test("swallow works as a promise catch handler and resolves the chain", async () => {
  let result;
  const orig = console.debug;
  console.debug = () => {};
  try {
    result = await Promise.reject(new Error("x")).catch(swallow("t"));
  } finally {
    console.debug = orig;
  }
  assert.equal(result, undefined);
});
