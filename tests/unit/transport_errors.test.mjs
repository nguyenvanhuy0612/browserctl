// Acceptance test suite for Milestone 1: Transport & Errors Subsystem.
//
// Specifications:
// - docs/spec/01-protocol-and-errors.md
// - docs/spec/05-test-and-acceptance-matrix.md (TC-PROTO-01 through TC-PROTO-04)
//
// Verifies:
// 1. RpcError and RPC_ERRORS code mapping and JSON-RPC 2.0 serialization.
// 2. executeWithAbort lifecycle, timeout handling, explicit cancellation,
//    global cancellation, and in-flight map leak prevention.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { RpcError, RPC_ERRORS } from "../../extension/transport/errors.js";
import {
  executeWithAbort,
  abortRequest,
  abortAll,
  inFlightRequests,
} from "../../extension/transport/dispatcher.js";

beforeEach(() => {
  if (typeof abortAll === "function") {
    abortAll("cleanup beforeEach");
  }
  if (inFlightRequests && typeof inFlightRequests.clear === "function") {
    inFlightRequests.clear();
  }
});

// =====================================================================================
// 1. Error Codes and Taxonomy (TC-PROTO-02)
// =====================================================================================

test("TC-PROTO-02: RPC_ERRORS defines all standard JSON-RPC 2.0 error codes (-32700 to -32603)", () => {
  assert.equal(RPC_ERRORS.PARSE_ERROR, -32700);
  assert.equal(RPC_ERRORS.INVALID_REQUEST, -32600);
  assert.equal(RPC_ERRORS.METHOD_NOT_FOUND, -32601);
  assert.equal(RPC_ERRORS.INVALID_PARAMS, -32602);
  assert.equal(RPC_ERRORS.INTERNAL_ERROR, -32603);
});

test("TC-PROTO-02: RPC_ERRORS defines all application error codes (-32001 to -32010)", () => {
  assert.equal(RPC_ERRORS.TARGET_NOT_FOUND, -32001);
  assert.equal(RPC_ERRORS.ELEMENT_NOT_FOUND, -32002);
  assert.equal(RPC_ERRORS.ELEMENT_NOT_INTERACTABLE, -32003);
  assert.equal(RPC_ERRORS.NAVIGATION_TIMEOUT, -32004);
  assert.equal(RPC_ERRORS.CDP_ATTACH_FAILED, -32005);
  assert.equal(RPC_ERRORS.EXECUTION_ABORTED, -32006);
  assert.equal(RPC_ERRORS.DOWNLOAD_FAILED, -32007);
  assert.equal(RPC_ERRORS.POLICY_RESTRICTION, -32008);
  assert.equal(RPC_ERRORS.BUDGET_EXCEEDED, -32009);
  assert.equal(RPC_ERRORS.NETWORK_REPLAY_FAILED, -32010);
});

// =====================================================================================
// 2. RpcError Class Contract and JSON-RPC 2.0 Framing (TC-PROTO-01 & TC-PROTO-02)
// =====================================================================================

test("TC-PROTO-01: RpcError sets name, code, message, and default data properties", () => {
  const err = new RpcError(-32002, "Element @e14 not found");

  assert.ok(err instanceof Error);
  assert.ok(err instanceof RpcError);
  assert.equal(err.name, "RpcError");
  assert.equal(err.code, -32002);
  assert.equal(err.message, "Element @e14 not found");
  assert.deepEqual(err.data, {
    reason: "UNKNOWN_ERROR",
    retriable: false,
    details: null,
  });
});

test("TC-PROTO-01: RpcError preserves custom data options (reason, retriable, details)", () => {
  const customData = {
    reason: "ELEMENT_NOT_FOUND",
    retriable: true,
    details: "Detached from DOM",
    target: "@e14",
  };
  const err = new RpcError(-32002, "Element detached", customData);

  assert.equal(err.code, -32002);
  assert.equal(err.data.reason, "ELEMENT_NOT_FOUND");
  assert.equal(err.data.retriable, true);
  assert.equal(err.data.details, "Detached from DOM");
});

test("TC-PROTO-01: RpcError.toJSON() complies with JSON-RPC 2.0 error object framing", () => {
  const err = new RpcError(-32002, "Element not found", {
    reason: "ELEMENT_NOT_FOUND",
    retriable: false,
    details: "Node detached",
  });

  const json = err.toJSON();
  assert.deepEqual(json, {
    code: -32002,
    message: "Element not found",
    data: {
      reason: "ELEMENT_NOT_FOUND",
      retriable: false,
      details: "Node detached",
    },
  });

  // Verify full JSON.stringify wire representation
  const serialized = JSON.stringify(err);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.code, -32002);
  assert.equal(parsed.message, "Element not found");
  assert.equal(parsed.data.reason, "ELEMENT_NOT_FOUND");
});

test("TC-PROTO-02: RpcError.fromError() unwraps existing RpcError directly", () => {
  const original = new RpcError(-32001, "Target tab gone", { reason: "TARGET_NOT_FOUND" });
  const result = RpcError.fromError(original);

  assert.equal(result, original);
  assert.equal(result.code, -32001);
});

test("TC-PROTO-02: RpcError.fromError() wraps standard JS Error into INTERNAL_ERROR (-32603)", () => {
  const nativeErr = new TypeError("Cannot read properties of undefined");
  const rpcErr = RpcError.fromError(nativeErr);

  assert.ok(rpcErr instanceof RpcError);
  assert.equal(rpcErr.code, RPC_ERRORS.INTERNAL_ERROR);
  assert.equal(rpcErr.message, "Cannot read properties of undefined");
  assert.equal(rpcErr.data.reason, "INTERNAL_ERROR");
  assert.equal(rpcErr.data.retriable, false);
  assert.ok(typeof rpcErr.data.details === "string" || rpcErr.data.details === null);
});

test("TC-PROTO-02: RpcError.fromError() handles non-Error objects or empty messages", () => {
  const emptyErr = new Error();
  const rpcErr1 = RpcError.fromError(emptyErr);
  assert.equal(rpcErr1.code, -32603);
  assert.ok(rpcErr1.message.length > 0);

  const stringErr = RpcError.fromError("raw string rejection");
  assert.equal(stringErr.code, -32603);
  assert.match(stringErr.message, /raw string rejection|Internal server error/);
});

// =====================================================================================
// 3. Dispatcher Execution, Timeout, and Lifecycle (TC-PROTO-04)
// =====================================================================================

test("TC-PROTO-04: executeWithAbort resolves successfully when handler completes before deadline", async () => {
  const res = await executeWithAbort("req-success-1", 500, async (signal) => {
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
    return { ok: true, data: "done" };
  });

  assert.deepEqual(res, { ok: true, data: "done" });
  assert.equal(inFlightRequests.size, 0);
});

test("TC-PROTO-04: executeWithAbort propagates handler rejection and cleans up inFlight map", async () => {
  await assert.rejects(
    async () => {
      await executeWithAbort("req-fail-1", 500, async () => {
        throw new RpcError(-32001, "Target missing", { reason: "TARGET_NOT_FOUND" });
      });
    },
    (err) => err instanceof RpcError && err.code === -32001
  );

  assert.equal(inFlightRequests.size, 0);
});

test("TC-PROTO-04: executeWithAbort aborts signal and rejects with timeout error upon deadline", async () => {
  let signalReceived = null;

  await assert.rejects(
    async () => {
      await executeWithAbort("req-timeout-1", 50, async (signal) => {
        signalReceived = signal;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return "unreachable";
      });
    },
    (err) => {
      assert.ok(err instanceof RpcError || err.name === "AbortError" || err instanceof Error);
      return true;
    }
  );

  assert.ok(signalReceived != null);
  assert.equal(signalReceived.aborted, true);
  assert.equal(inFlightRequests.size, 0);
});

test("TC-PROTO-04: abortRequest explicitly cancels pending in-flight request", async () => {
  let abortEventFired = false;

  const promise = executeWithAbort("req-cancel-1", 2000, async (signal) => {
    signal.addEventListener("abort", () => {
      abortEventFired = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return "completed";
  });

  // Ensure request is registered in inFlight map
  assert.equal(inFlightRequests.size, 1);
  assert.ok(inFlightRequests.has("req-cancel-1"));

  // Yield to allow handler to start and attach its abort listener
  await new Promise((resolve) => setImmediate(resolve));

  const cancelled = abortRequest("req-cancel-1", "user cancelled");
  assert.equal(cancelled, true);

  await assert.rejects(
    async () => {
      await promise;
    },
    (err) => {
      if (err instanceof RpcError) {
        assert.equal(err.code, RPC_ERRORS.EXECUTION_ABORTED);
      }
      return true;
    }
  );

  assert.equal(abortEventFired, true);
  assert.equal(inFlightRequests.size, 0);
});

test("TC-PROTO-04: abortRequest is idempotent and returns false for unknown id", () => {
  assert.equal(abortRequest("non-existent-req-id"), false);
});

test("TC-PROTO-04: abortAll cancels all concurrent in-flight requests", async () => {
  const abortedSignals = [];

  const p1 = executeWithAbort("req-multi-1", 2000, async (signal) => {
    signal.addEventListener("abort", () => abortedSignals.push("req-multi-1"));
    await new Promise((r) => setTimeout(r, 1000));
  });

  const p2 = executeWithAbort("req-multi-2", 2000, async (signal) => {
    signal.addEventListener("abort", () => abortedSignals.push("req-multi-2"));
    await new Promise((r) => setTimeout(r, 1000));
  });

  assert.equal(inFlightRequests.size, 2);

  // Yield to allow handlers to start and attach listeners
  await new Promise((resolve) => setImmediate(resolve));

  const count = abortAll("WebSocket closed");
  assert.equal(count, 2);

  await Promise.allSettled([p1, p2]);

  assert.equal(abortedSignals.length, 2);
  assert.ok(abortedSignals.includes("req-multi-1"));
  assert.ok(abortedSignals.includes("req-multi-2"));
  assert.equal(inFlightRequests.size, 0);
});

test("TC-PROTO-04: inFlightRequests map does not leak across repeated successful & failing requests", async () => {
  for (let i = 0; i < 10; i++) {
    const id = `req-loop-${i}`;
    if (i % 2 === 0) {
      await executeWithAbort(id, 200, async () => "ok");
    } else {
      await assert.rejects(async () => {
        await executeWithAbort(id, 200, async () => {
          throw new Error("fail");
        });
      });
    }
  }

  assert.equal(inFlightRequests.size, 0);
});
