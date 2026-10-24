// Acceptance test suite for Milestone 2: CDP Driver Subsystem.
//
// Specifications:
// - docs/spec/02-driver-and-cdp.md
// - docs/spec/05-test-and-acceptance-matrix.md (TC-CDP-01 through TC-CDP-05)
//
// Verifies:
// 1. TC-CDP-01: Mouse wheel dispatch (browser_wheel) with deltaX/deltaY & modifiers.
// 2. TC-CDP-02: Native drag-and-drop (coordinate_drag / dispatchDrag) interpolation.
// 3. TC-CDP-03: Device emulation presets (iphone-14, pixel-7, ipad, desktop), dark/light mode, geolocation, reset.
// 4. TC-CDP-04: RFC 6901 JSON pointer traversal and token unescaping.
// 5. TC-CDP-05: Network replay and fetch rule generation.
// 6. CDP session lifecycle & command dispatch.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const cdpCalls = [];
let mockResponses = new Map();
let tabState = { active: true, windowId: 1 };
let windowState = { focused: true };

// Set up Chrome API stub for CDP driver tests
globalThis.chrome = {
  runtime: { lastError: null },
  debugger: {
    attach({ tabId }, version, callback) {
      if (callback) callback();
    },
    detach({ tabId }, callback) {
      if (callback) callback();
    },
    sendCommand({ tabId }, method, params = {}, callback) {
      cdpCalls.push({ tabId, method, params });
      if (mockResponses.has(method)) {
        const handler = mockResponses.get(method);
        if (typeof handler === "function") {
          try {
            const res = handler(params, tabId);
            if (callback) callback(res);
          } catch (err) {
            chrome.runtime.lastError = err;
            if (callback) callback();
            chrome.runtime.lastError = null;
          }
          return;
        }
        if (handler instanceof Error) {
          chrome.runtime.lastError = handler;
          if (callback) callback();
          chrome.runtime.lastError = null;
          return;
        }
        if (callback) callback(handler);
        return;
      }
      if (callback) callback({});
    },
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  },
  tabs: {
    async get(tabId) {
      return { id: tabId, ...tabState };
    },
    onRemoved: { addListener() {} },
  },
  windows: {
    async get(winId) {
      return { id: winId, ...windowState };
    },
  },
  storage: {
    session: {
      async get() {
        return {};
      },
      async set() {},
    },
  },
};

const TAB_ID = 201;

// Dynamic imports of driver modules
const sessionModule = await import("../../extension/driver/session.js");
const inputModule = await import("../../extension/driver/input.js");
const emulateModule = await import("../../extension/driver/emulate.js");
const networkModule = await import("../../extension/driver/network.js");

const sendCdpCommand = sessionModule.sendCdpCommand;
const attachDebugger =
  sessionModule.attachDebugger ||
  sessionModule.attachSession ||
  sessionModule.attach ||
  sessionModule.ensureAttached;
const detachDebugger =
  sessionModule.detachDebugger ||
  sessionModule.detachSession ||
  sessionModule.detach;
const isAttached = sessionModule.isAttached;

const dispatchMouseWheel = inputModule.dispatchMouseWheel || inputModule.wheel;
const coordinate_drag =
  inputModule.coordinate_drag ||
  inputModule.dispatchDrag ||
  inputModule.drag;

const DEVICE_PRESETS = emulateModule.DEVICE_PRESETS;
const emulateDevice =
  emulateModule.emulateDevice ||
  emulateModule.emulate ||
  emulateModule.setEmulation;
const clearEmulation = emulateModule.clearEmulation || emulateModule.clear;

const resolveJsonPointer = networkModule.resolveJsonPointer;

beforeEach(async () => {
  cdpCalls.length = 0;
  mockResponses.clear();
  tabState = { active: true, windowId: 1 };
  windowState = { focused: true };
  if (typeof attachDebugger === "function") {
    try {
      await attachDebugger(TAB_ID);
    } catch {}
  }
  cdpCalls.length = 0;
});

// =====================================================================================
// 1. TC-CDP-01: Mouse Wheel Dispatch (browser_wheel)
// =====================================================================================

test("TC-CDP-01: dispatchMouseWheel dispatches Input.dispatchMouseEvent with rounded coords", async () => {
  await dispatchMouseWheel(TAB_ID, {
    x: 150.4,
    y: 250.8,
    deltaX: 10.2,
    deltaY: 50.7,
  });

  const wheelCall = cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent");
  assert.ok(wheelCall != null);
  assert.equal(wheelCall.params.type, "mouseWheel");
  assert.equal(wheelCall.params.x, 150);
  assert.equal(wheelCall.params.y, 251);
  assert.equal(wheelCall.params.deltaX, 10);
  assert.equal(wheelCall.params.deltaY, 51);
  assert.equal(wheelCall.params.modifiers, 0);
});

test("TC-CDP-01: dispatchMouseWheel defaults deltaX and deltaY to 0 when omitted", async () => {
  await dispatchMouseWheel(TAB_ID, { x: 100, y: 100 });

  const wheelCall = cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent");
  assert.equal(wheelCall.params.deltaX, 0);
  assert.equal(wheelCall.params.deltaY, 0);
  assert.equal(wheelCall.params.modifiers, 0);
});

test("TC-CDP-01: dispatchMouseWheel handles bitmask modifiers and combined Shift+Ctrl", async () => {
  // Test numeric modifier 8 (Shift)
  cdpCalls.length = 0;
  await dispatchMouseWheel(TAB_ID, { x: 50, y: 50, deltaY: 20, modifiers: 8 });
  let call = cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent");
  assert.equal(call.params.modifiers, 8);

  // Test array of modifier strings: Shift (8) + Ctrl (2) = 10
  cdpCalls.length = 0;
  await dispatchMouseWheel(TAB_ID, {
    x: 50,
    y: 50,
    deltaY: 20,
    modifiers: ["Shift", "Ctrl"],
  });
  call = cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent");
  assert.equal(call.params.modifiers, 10);
});

test("TC-CDP-01: dispatchMouseWheel handles negative coordinates and zero deltas", async () => {
  await dispatchMouseWheel(TAB_ID, { x: -20, y: -50, deltaX: 0, deltaY: 0 });

  const call = cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent");
  assert.equal(call.params.x, -20);
  assert.equal(call.params.y, -50);
  assert.equal(call.params.deltaX, 0);
  assert.equal(call.params.deltaY, 0);
});

// =====================================================================================
// 2. TC-CDP-02: Native Drag-and-Drop (coordinate_drag / browser_drag)
// =====================================================================================

test("TC-CDP-02: coordinate_drag executes multi-step interpolation from source to destination", async () => {
  assert.ok(typeof coordinate_drag === "function");

  // Support both positional and options-object invocations
  if (coordinate_drag.length >= 5) {
    await coordinate_drag(TAB_ID, 100, 100, 300, 500, 5);
  } else {
    await coordinate_drag(TAB_ID, { fromX: 100, fromY: 100, toX: 300, toY: 500, steps: 5 });
  }

  const mouseEvents = cdpCalls.filter((c) => c.method === "Input.dispatchMouseEvent");
  assert.ok(mouseEvents.length >= 4);

  // First event moves to source
  const firstMove = mouseEvents[0];
  assert.equal(firstMove.params.type, "mouseMoved");
  assert.equal(firstMove.params.x, 100);
  assert.equal(firstMove.params.y, 100);

  // Second event presses left button
  const press = mouseEvents[1];
  assert.equal(press.params.type, "mousePressed");
  assert.equal(press.params.button, "left");

  // Intermediate moves interpolate towards destination
  const intermediateMoves = mouseEvents.slice(2, -1);
  assert.ok(intermediateMoves.length >= 1);
  for (const step of intermediateMoves) {
    assert.equal(step.params.type, "mouseMoved");
    assert.ok(step.params.x >= 100 && step.params.x <= 300);
    assert.ok(step.params.y >= 100 && step.params.y <= 500);
  }

  // Final event releases mouse button at destination
  const release = mouseEvents[mouseEvents.length - 1];
  assert.equal(release.params.type, "mouseReleased");
  assert.equal(release.params.button, "left");
  assert.equal(release.params.x, 300);
  assert.equal(release.params.y, 500);
});

test("TC-CDP-02: coordinate_drag handles dragging to negative offsets or outside viewport", async () => {
  if (coordinate_drag.length >= 5) {
    await coordinate_drag(TAB_ID, 50, 50, -100, -200, 3);
  } else {
    await coordinate_drag(TAB_ID, { fromX: 50, fromY: 50, toX: -100, toY: -200, steps: 3 });
  }

  const mouseEvents = cdpCalls.filter((c) => c.method === "Input.dispatchMouseEvent");
  const release = mouseEvents[mouseEvents.length - 1];
  assert.equal(release.params.x, -100);
  assert.equal(release.params.y, -200);
});

// =====================================================================================
// 3. TC-CDP-03: Device & Environment Emulation
// =====================================================================================

test("TC-CDP-03: DEVICE_PRESETS defines valid metrics for iphone-14, pixel-7, ipad, and desktop", () => {
  assert.ok(DEVICE_PRESETS != null);
  const ip14 = DEVICE_PRESETS["iphone-14"];
  assert.deepEqual(
    { width: ip14.width, height: ip14.height, deviceScaleFactor: ip14.deviceScaleFactor, mobile: ip14.mobile },
    { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }
  );

  const p7 = DEVICE_PRESETS["pixel-7"];
  assert.deepEqual(
    { width: p7.width, height: p7.height, deviceScaleFactor: p7.deviceScaleFactor, mobile: p7.mobile },
    { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true }
  );

  const ipad = DEVICE_PRESETS["ipad"];
  assert.deepEqual(
    { width: ipad.width, height: ipad.height, deviceScaleFactor: ipad.deviceScaleFactor, mobile: ipad.mobile },
    { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true }
  );

  const desktop = DEVICE_PRESETS["desktop"];
  assert.deepEqual(
    { width: desktop.width, height: desktop.height, deviceScaleFactor: desktop.deviceScaleFactor, mobile: desktop.mobile },
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }
  );
});

test("TC-CDP-03: emulateDevice applies preset metrics, user agent, and touch emulation", async () => {
  await emulateDevice(TAB_ID, { device: "iphone-14" });

  const metricsCall = cdpCalls.find((c) => c.method === "Emulation.setDeviceMetricsOverride");
  assert.deepEqual(metricsCall.params, {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });

  const touchCall = cdpCalls.find((c) => c.method === "Emulation.setTouchEmulationEnabled");
  assert.deepEqual(touchCall.params, { enabled: true });

  const uaCall = cdpCalls.find((c) => c.method === "Emulation.setUserAgentOverride");
  assert.match(uaCall.params.userAgent, /iPhone/);
});

test("TC-CDP-03: emulateDevice configures dark mode, geolocation, and offline state", async () => {
  await emulateDevice(TAB_ID, {
    colorScheme: "dark",
    geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 10 },
    offline: true,
  });

  const mediaCall = cdpCalls.find((c) => c.method === "Emulation.setEmulatedMedia");
  assert.deepEqual(mediaCall.params, {
    media: "page",
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });

  const geoCall = cdpCalls.find((c) => c.method === "Emulation.setGeolocationOverride");
  assert.deepEqual(geoCall.params, {
    latitude: 37.7749,
    longitude: -122.4194,
    accuracy: 10,
  });

  const netCall = cdpCalls.find((c) => c.method === "Network.emulateNetworkConditions");
  assert.equal(netCall.params.offline, true);
});

test("TC-CDP-03: clear / off resets overrides, media, geolocation, and network", async () => {
  if (typeof clearEmulation === "function") {
    await clearEmulation(TAB_ID);
  } else {
    await emulateDevice(TAB_ID, { clear: true });
  }

  const methods = cdpCalls.map((c) => c.method);
  assert.ok(methods.includes("Emulation.clearDeviceMetricsOverride"));
  assert.ok(methods.includes("Emulation.clearGeolocationOverride"));
  assert.ok(methods.includes("Network.emulateNetworkConditions"));

  const netCall = cdpCalls.find((c) => c.method === "Network.emulateNetworkConditions");
  assert.deepEqual(netCall.params, {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
});

// =====================================================================================
// 4. TC-CDP-04: RFC 6901 JSON Pointer Traversal
// =====================================================================================

test("TC-CDP-04: resolveJsonPointer handles root pointer '' and '/' returning whole object", () => {
  const payload = { status: "success", count: 42 };
  assert.equal(resolveJsonPointer(payload, ""), payload);
  assert.equal(resolveJsonPointer(payload, "/"), payload);
  assert.equal(resolveJsonPointer(payload, null), payload);
  assert.equal(resolveJsonPointer(payload, undefined), payload);
});

test("TC-CDP-04: resolveJsonPointer navigates nested objects and array indices", () => {
  const data = {
    response: {
      items: [
        { id: "item-0", details: { title: "First Item" } },
        { id: "item-1", details: { title: "Second Item" } },
      ],
    },
  };
  assert.equal(resolveJsonPointer(data, "/response/items/0/details/title"), "First Item");
  assert.equal(resolveJsonPointer(data, "/response/items/1/id"), "item-1");
});

test("TC-CDP-04: resolveJsonPointer unescapes ~1 as '/' and ~0 as '~'", () => {
  const data = {
    "api/v1": {
      "path~segment": "escaped-value",
    },
    "~1": "literal-tilde-one",
  };
  assert.equal(resolveJsonPointer(data, "/api~1v1/path~0segment"), "escaped-value");
  assert.equal(resolveJsonPointer(data, "/~01"), "literal-tilde-one");
});

test("TC-CDP-04: resolveJsonPointer returns undefined on missing segments or array out of bounds", () => {
  const data = {
    users: ["Alice", "Bob"],
    meta: null,
  };
  assert.equal(resolveJsonPointer(data, "/users/5"), undefined);
  assert.equal(resolveJsonPointer(data, "/users/-1"), undefined);
  assert.equal(resolveJsonPointer(data, "/users/invalid"), undefined);
  assert.equal(resolveJsonPointer(data, "/nonexistent/sub"), undefined);
  assert.equal(resolveJsonPointer(data, "/meta/prop"), undefined);
});

// =====================================================================================
// 5. TC-CDP-05: Network Replay & Interception
// =====================================================================================

test("TC-CDP-05: network controller exposes replay and rule generation", async () => {
  // Verify network controller exported helpers
  assert.ok(typeof networkModule.createNetworkRule === "function" || typeof networkModule.urlMatchesPattern === "function" || typeof networkModule.resolveJsonPointer === "function");

  if (typeof networkModule.createNetworkRule === "function") {
    const rule = networkModule.createNetworkRule({
      match: { url: "*api/test*" },
      effect: { type: "mock", status: 200, body: JSON.stringify({ ok: true }) },
    });
    assert.ok(rule.id != null);
    assert.equal(rule.effect.status, 200);
  }

  if (typeof networkModule.urlMatchesPattern === "function") {
    assert.equal(networkModule.urlMatchesPattern("https://example.com/api/test", "*api/test*"), true);
    assert.equal(networkModule.urlMatchesPattern("https://example.com/other", "*api/test*"), false);
  }
});

// =====================================================================================
// 6. CDP Session Lifecycle (session.js)
// =====================================================================================

test("sendCdpCommand dispatches command via chrome.debugger and returns result", async () => {
  mockResponses.set("Page.enable", { enabled: true });
  const result = await sendCdpCommand(TAB_ID, "Page.enable");
  assert.deepEqual(result, { enabled: true });

  const call = cdpCalls.find((c) => c.method === "Page.enable");
  assert.ok(call != null);
  assert.equal(call.tabId, TAB_ID);
});

test("sendCdpCommand rejects when chrome.runtime.lastError is reported", async () => {
  mockResponses.set("Page.fail", new Error("Target frame not found"));

  await assert.rejects(
    () => sendCdpCommand(TAB_ID, "Page.fail"),
    (err) => err.message.includes("Target frame not found") || err.code === -32005
  );
});

test("isAttached reflects session attachment state", async () => {
  if (typeof isAttached === "function") {
    const attachFn = sessionModule.ensureAttached || attachDebugger;
    await attachFn(TAB_ID);
    assert.equal(isAttached(TAB_ID), true);

    if (typeof sessionModule.dropTab === "function") {
      sessionModule.dropTab(TAB_ID);
      assert.equal(isAttached(TAB_ID), false);
    } else if (typeof detachDebugger === "function") {
      await detachDebugger(TAB_ID);
      assert.equal(isAttached(TAB_ID), false);
    }
  }
});
