// Architectural Invariants Test Suite
// Verifies the core software engineering specifications:
// 1. Stabilization FSM (wait_settle):
//    - Immediate 50ms initial quiet check (no starvation on quiet pages).
//    - Infinite running animations (spinners/pulsing SVG) do not block settling.
//    - Returns structured SettleReport without unhandled exceptions.
// 2. Deterministic Element Resolution Pipeline (resolveTarget):
//    - Filters out disconnected & hidden/zero-box elements before declaring ambiguity.
//    - Prioritizes in-viewport elements over off-screen elements.
//    - Throws AMBIGUOUS_TARGET with candidate refs only when true ambiguity exists.
// 3. Hierarchical Timing Budget:
//    - computeTransportTimeout strictly enforces: OuterWatchdog = ActionBudget + GRACE_SLACK (5000ms).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

import {
  computeTransportTimeout,
  DEFAULT_ACTION_BUDGET_MS,
  TRANSPORT_GRACE_SLACK_MS,
} from "../../extension/transport/dispatcher.js";
import { RpcError } from "../../extension/transport/errors.js";
import { extractFunction } from "./source-slice.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTENT_JS_RAW = readFileSync(join(HERE, "../../extension/content.js"), "utf8");

// =============================================================================
// 1. Hierarchical Timing Budget Invariants
// =============================================================================

test("Timing Budget: computeTransportTimeout adds 5,000ms grace slack to action timeout", () => {
  assert.equal(computeTransportTimeout({ timeoutMs: 3000 }), 3000 + TRANSPORT_GRACE_SLACK_MS);
  assert.equal(computeTransportTimeout({ timeoutMs: 8000 }), 8000 + TRANSPORT_GRACE_SLACK_MS);
  assert.equal(computeTransportTimeout({ timeout: 10000 }), 10000 + TRANSPORT_GRACE_SLACK_MS);
});

test("Timing Budget: computeTransportTimeout falls back to 60,000ms default when absent or invalid", () => {
  assert.equal(computeTransportTimeout({}), DEFAULT_ACTION_BUDGET_MS);
  assert.equal(computeTransportTimeout(null), DEFAULT_ACTION_BUDGET_MS);
  assert.equal(computeTransportTimeout({ timeoutMs: 0 }), DEFAULT_ACTION_BUDGET_MS);
  assert.equal(computeTransportTimeout({ timeoutMs: -100 }), DEFAULT_ACTION_BUDGET_MS);
  assert.equal(computeTransportTimeout({ timeoutMs: "abc" }), DEFAULT_ACTION_BUDGET_MS);
});

// =============================================================================
// 2. Stabilization FSM Invariants (wait_settle)
// =============================================================================

test("Stabilization FSM: wait_settle resolves within ~50ms on quiet page without waiting for max timeout", async () => {
  // Extract wait_settle and isFiniteRunningAnimation
  const fnSettle = extractFunction(CONTENT_JS_RAW, "wait_settle");
  const fnAnim = extractFunction(CONTENT_JS_RAW, "isFiniteRunningAnimation");

  let observerDisconnected = false;
  class MockMutationObserver {
    constructor(cb) {
      this.cb = cb;
    }
    observe() {}
    disconnect() {
      observerDisconnected = true;
    }
  }

  const sandbox = {
    setTimeout,
    clearTimeout,
    Date,
    Math,
    document: {
      readyState: "complete",
      documentElement: {},
      getAnimations: () => [],
    },
    MutationObserver: MockMutationObserver,
  };

  const script = new vm.Script(`
    ${fnAnim}
    ${fnSettle}
    globalThis.__testSettle = wait_settle;
  `);

  const ctx = vm.createContext(sandbox);
  script.runInContext(ctx);

  const start = Date.now();
  // Request wait_settle with a long 5000ms budget
  const res = await sandbox.__testSettle({ timeoutMs: 5000 });
  const duration = Date.now() - start;

  assert.ok(duration < 250, `Quiet page must resolve quickly (took ${duration}ms, expected <250ms)`);
  assert.equal(res.settled, true);
  assert.equal(res.reason, "quiet");
  assert.equal(res.readyState, "complete");
  assert.equal(res.activeAnimations, 0);
  assert.ok(observerDisconnected, "MutationObserver must be disconnected upon settle");
});

test("Stabilization FSM: infinite running animations do not block settling", async () => {
  const fnSettle = extractFunction(CONTENT_JS_RAW, "wait_settle");
  const fnAnim = extractFunction(CONTENT_JS_RAW, "isFiniteRunningAnimation");

  class MockMutationObserver {
    observe() {}
    disconnect() {}
  }

  // Simulate infinite CSS animation (SVG spinner or keyframe pulse)
  const infiniteAnimation = {
    playState: "running",
    playbackRate: 1,
    effect: {
      getTiming: () => ({ iterations: Infinity }),
    },
  };

  const sandbox = {
    setTimeout,
    clearTimeout,
    Date,
    Math,
    document: {
      readyState: "complete",
      documentElement: {},
      getAnimations: () => [infiniteAnimation],
    },
    MutationObserver: MockMutationObserver,
  };

  const script = new vm.Script(`
    ${fnAnim}
    ${fnSettle}
    globalThis.__testSettle = wait_settle;
  `);

  const ctx = vm.createContext(sandbox);
  script.runInContext(ctx);

  const start = Date.now();
  const res = await sandbox.__testSettle({ timeoutMs: 2000 });
  const duration = Date.now() - start;

  assert.ok(duration < 250, `Infinite animation must not block settling (took ${duration}ms)`);
  assert.equal(res.settled, true, "Page must be considered settled despite infinite background animations");
  assert.equal(res.activeAnimations, 0, "Infinite animations must be excluded from active count");
  assert.equal(res.reason, "quiet");
});

test("Stabilization FSM: finite running animations keep activeAnimations > 0 and indicate unsettled state", async () => {
  const fnSettle = extractFunction(CONTENT_JS_RAW, "wait_settle");
  const fnAnim = extractFunction(CONTENT_JS_RAW, "isFiniteRunningAnimation");

  class MockMutationObserver {
    observe() {}
    disconnect() {}
  }

  // Simulate finite transition (e.g. 300ms user menu slide)
  const finiteAnimation = {
    playState: "running",
    playbackRate: 1,
    effect: {
      getTiming: () => ({ iterations: 1 }),
    },
  };

  const sandbox = {
    setTimeout,
    clearTimeout,
    Date,
    Math,
    document: {
      readyState: "complete",
      documentElement: {},
      getAnimations: () => [finiteAnimation],
    },
    MutationObserver: MockMutationObserver,
  };

  const script = new vm.Script(`
    ${fnAnim}
    ${fnSettle}
    globalThis.__testSettle = wait_settle;
  `);

  const ctx = vm.createContext(sandbox);
  script.runInContext(ctx);

  const res = await sandbox.__testSettle({ timeoutMs: 60 });
  assert.equal(res.settled, false, "Finite running animation must keep page in unsettled state");
  assert.equal(res.activeAnimations, 1, "Finite animation must be included in activeAnimations");
  assert.equal(res.reason, "deadline");
});

// =============================================================================
// 3. Deterministic Element Resolution Pipeline (resolveTarget)
// =============================================================================

test("Resolution Pipeline: resolves visible element when dual candidates exist and one is hidden (Wikipedia pattern)", () => {
  // Setup two candidates matching input[name='search']:
  // 1. Mobile drawer input (hidden: display: none, width: 0, height: 0)
  // 2. Desktop header input (visible: 200x30 in viewport)
  const mobileInput = {
    tagName: "INPUT",
    isConnected: true,
    offsetWidth: 0,
    offsetHeight: 0,
    style: { display: "none" },
    getBoundingClientRect: () => ({ top: -100, bottom: -70, left: 0, right: 0, width: 0, height: 0 }),
    getAttribute: (attr) => (attr === "name" ? "search" : null),
    innerText: "",
    __ref: "e57",
  };

  const desktopInput = {
    tagName: "INPUT",
    isConnected: true,
    offsetWidth: 200,
    offsetHeight: 30,
    style: { display: "block" },
    getBoundingClientRect: () => ({ top: 10, bottom: 40, left: 10, right: 210, width: 200, height: 30 }),
    getAttribute: (attr) => (attr === "name" ? "search" : null),
    innerText: "Search Wikipedia",
    __ref: "e73",
  };

  // Mock isVisible helper
  const isVisible = (el) => el.style?.display !== "none" && el.getBoundingClientRect().width > 0;

  const fnResolve = extractFunction(CONTENT_JS_RAW, "resolveTarget");
  const fnCandidate = extractFunction(CONTENT_JS_RAW, "makeCandidate");

  const sandbox = {
    String,
    parseInt,
    isNaN,
    window: { innerHeight: 800, innerWidth: 1200 },
    document: { documentElement: { clientHeight: 800, clientWidth: 1200 } },
    isValidCss: () => true,
    deepQueryAll: (sel) => (sel === "input[name='search']" ? [mobileInput, desktopInput] : []),
    isVisible,
    elementText: (el) => el.innerText || "",
    accessibleName: () => "",
    getOrAssignRef: (el) => el.__ref.replace(/^e/, ""),
    ambiguityError: (target, candidates, reason) => {
      const err = new Error(`ambiguous target: ${candidates.length}`);
      err.code = "AMBIGUOUS_TARGET";
      throw err;
    },
  };

  const script = new vm.Script(`
    let lastTextOnlyMatch = null;
    ${fnCandidate}
    ${fnResolve}
    globalThis.__resolveTarget = resolveTarget;
  `);

  const ctx = vm.createContext(sandbox);
  script.runInContext(ctx);

  // Must deterministically resolve the visible desktop input without throwing AMBIGUOUS_TARGET
  const resolved = sandbox.__resolveTarget({ target: "input[name='search']" });
  assert.equal(resolved, desktopInput, "Pipeline must filter out hidden element and pick visible candidate");
  assert.equal(resolved._resolved.by, "css");
  assert.equal(resolved._resolved.matchCount, 1);
});

test("Resolution Pipeline: resolves in-viewport element when both candidates are visible but one is off-screen", () => {
  // Offscreen candidate (e.g. footer button)
  const offscreenBtn = {
    tagName: "BUTTON",
    isConnected: true,
    offsetWidth: 100,
    offsetHeight: 30,
    style: { display: "block" },
    getBoundingClientRect: () => ({ top: 2500, bottom: 2530, left: 50, right: 150, width: 100, height: 30 }),
    innerText: "Submit",
    __ref: "e101",
  };

  // In-viewport candidate (e.g. main form button)
  const inViewBtn = {
    tagName: "BUTTON",
    isConnected: true,
    offsetWidth: 100,
    offsetHeight: 30,
    style: { display: "block" },
    getBoundingClientRect: () => ({ top: 150, bottom: 180, left: 50, right: 150, width: 100, height: 30 }),
    innerText: "Submit",
    __ref: "e102",
  };

  const isVisible = (el) => el.getBoundingClientRect().width > 0;

  const fnResolve = extractFunction(CONTENT_JS_RAW, "resolveTarget");
  const fnCandidate = extractFunction(CONTENT_JS_RAW, "makeCandidate");

  const sandbox = {
    String,
    parseInt,
    isNaN,
    window: { innerHeight: 800, innerWidth: 1200 },
    document: { documentElement: { clientHeight: 800, clientWidth: 1200 } },
    isValidCss: () => true,
    deepQueryAll: (sel) => (sel === ".btn-submit" ? [offscreenBtn, inViewBtn] : []),
    isVisible,
    elementText: (el) => el.innerText || "",
    accessibleName: () => "",
    getOrAssignRef: (el) => el.__ref.replace(/^e/, ""),
    ambiguityError: (target, candidates, reason) => {
      const err = new Error(`ambiguous target: ${candidates.length}`);
      err.code = "AMBIGUOUS_TARGET";
      throw err;
    },
  };

  const script = new vm.Script(`
    let lastTextOnlyMatch = null;
    ${fnCandidate}
    ${fnResolve}
    globalThis.__resolveTarget = resolveTarget;
  `);

  const ctx = vm.createContext(sandbox);
  script.runInContext(ctx);

  const resolved = sandbox.__resolveTarget({ target: ".btn-submit" });
  assert.equal(resolved, inViewBtn, "Pipeline must rank in-viewport candidate higher than off-screen candidate");
  assert.equal(resolved._resolved.by, "css-viewport-priority");
});

test("Resolution Pipeline: throws AMBIGUOUS_TARGET when multiple candidates are equally visible and in-viewport", () => {
  // Two visible buttons on screen with identical selector
  const btnA = {
    tagName: "BUTTON",
    isConnected: true,
    offsetWidth: 100,
    offsetHeight: 30,
    style: { display: "block" },
    getBoundingClientRect: () => ({ top: 100, bottom: 130, left: 50, right: 150, width: 100, height: 30 }),
    innerText: "Option A",
    __ref: "e10",
  };

  const btnB = {
    tagName: "BUTTON",
    isConnected: true,
    offsetWidth: 100,
    offsetHeight: 30,
    style: { display: "block" },
    getBoundingClientRect: () => ({ top: 100, bottom: 130, left: 200, right: 300, width: 100, height: 30 }),
    innerText: "Option B",
    __ref: "e11",
  };

  const isVisible = (el) => el.getBoundingClientRect().width > 0;

  const fnResolve = extractFunction(CONTENT_JS_RAW, "resolveTarget");
  const fnCandidate = extractFunction(CONTENT_JS_RAW, "makeCandidate");

  let thrownError = null;
  const sandbox = {
    String,
    parseInt,
    isNaN,
    window: { innerHeight: 800, innerWidth: 1200 },
    document: { documentElement: { clientHeight: 800, clientWidth: 1200 } },
    isValidCss: () => true,
    deepQueryAll: (sel) => (sel === ".option-btn" ? [btnA, btnB] : []),
    isVisible,
    elementText: (el) => el.innerText || "",
    accessibleName: () => "",
    getOrAssignRef: (el) => el.__ref.replace(/^e/, ""),
    ambiguityError: (target, candidates, reason) => {
      const err = new Error(`ambiguous target: ${candidates.length}`);
      err.code = "AMBIGUOUS_TARGET";
      err.candidates = candidates;
      thrownError = err;
      throw err;
    },
  };

  const script = new vm.Script(`
    let lastTextOnlyMatch = null;
    ${fnCandidate}
    ${fnResolve}
    globalThis.__resolveTarget = resolveTarget;
  `);

  const ctx = vm.createContext(sandbox);
  script.runInContext(ctx);

  assert.throws(
    () => sandbox.__resolveTarget({ target: ".option-btn" }),
    /ambiguous target/
  );
  assert.equal(thrownError.code, "AMBIGUOUS_TARGET");
  assert.equal(thrownError.candidates.length, 2);
  assert.equal(thrownError.candidates[0].ref, "@10");
  assert.equal(thrownError.candidates[1].ref, "@11");
});
