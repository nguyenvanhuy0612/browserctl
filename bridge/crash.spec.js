import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFaultLog } from "./crash.js";

describe("bridge/crash.js (Colocated Unit Spec)", () => {
  it("a log with no fault reports null", () => {
    assert.equal(createFaultLog().snapshot(), null);
  });

  it("record: counts faults and reports the latest message and time", () => {
    let clock = 1000;
    const log = createFaultLog({ now: () => clock });
    log.record(new Error("first"));
    clock = 2000;
    log.record(new Error("second"));
    assert.deepEqual(log.snapshot(), {
      count: 2,
      lastAt: new Date(2000).toISOString(),
      lastError: "second",
    });
  });

  it("record: a non-Error value is reported as its string form", () => {
    const log = createFaultLog();
    log.record("boom");
    assert.equal(log.snapshot().lastError, "boom");
    log.record(undefined);
    assert.equal(log.snapshot().lastError, "undefined");
  });

  it("record: an object whose toString throws does not throw", () => {
    const log = createFaultLog();
    const hostile = {
      toString() {
        throw new Error("no");
      },
    };
    assert.doesNotThrow(() => log.record(hostile));
    assert.equal(log.snapshot().count, 1);
    assert.equal(typeof log.snapshot().lastError, "string");
  });

  it("record: the message is a single line, control characters removed, clamped to 200 chars", () => {
    const log = createFaultLog();
    log.record(new Error("a\nb\u0000c" + "x".repeat(500)));
    const msg = log.snapshot().lastError;
    assert.ok(!/[\u0000-\u001f\u007f]/.test(msg));
    assert.equal(msg.length, 200);
    assert.ok(msg.startsWith("abc"));
  });
});
