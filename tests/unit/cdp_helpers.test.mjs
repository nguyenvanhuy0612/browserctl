// Behavioural tests for CDP helper routines and handleCdp actions in extension/cdp.js.
//
// cdp.js is an ES module that attaches chrome.* event listeners upon import.
// We provide a stubbed chrome API environment on globalThis prior to importing cdp.js,
// allowing tests to mock CDP commands, inspect calls, and test json pointer traversal,
// emulation presets, and wheel event dispatch.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const cdpCalls = [];
let mockResponses = new Map();
let tabState = { active: true, windowId: 1 };
let windowState = { focused: true };

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

const { resolveJsonPointer, handleCdp, setLastCaptureScale } = await import(
  "../../extension/cdp.js"
);

const TAB_ID = 101;

beforeEach(async () => {
  cdpCalls.length = 0;
  mockResponses.clear();
  tabState = { active: true, windowId: 1 };
  windowState = { focused: true };
  setLastCaptureScale(TAB_ID, 1);
  // Ensure session is attached and initialized
  await handleCdp("cdp_attach", {}, TAB_ID);
  cdpCalls.length = 0;
});

// =====================================================================================
// 1. resolveJsonPointer — RFC 6901 JSON pointer navigation & unescaping
// =====================================================================================

test("resolveJsonPointer: root pointer '' and '/' returns whole object", () => {
  const data = { a: 1, b: [2, 3], c: { d: "hello" } };
  assert.equal(resolveJsonPointer(data, ""), data);
  assert.equal(resolveJsonPointer(data, "/"), data);
  assert.equal(resolveJsonPointer(data, null), data);
  assert.equal(resolveJsonPointer(data, undefined), data);
});

test("resolveJsonPointer: path navigation traverses nested objects and arrays", () => {
  const data = {
    data: {
      messages: [
        { id: 1, content: "first message" },
        { id: 2, content: "second message" },
      ],
      meta: { total: 2 },
    },
  };
  assert.equal(resolveJsonPointer(data, "/data/messages/0/content"), "first message");
  assert.equal(resolveJsonPointer(data, "/data/messages/1/id"), 2);
  assert.equal(resolveJsonPointer(data, "/data/meta/total"), 2);
});

test("resolveJsonPointer: unescapes ~1 as '/' and ~0 as '~'", () => {
  const data = {
    "a/b": {
      "c~d": "unescaped match",
    },
    "~1": "literal ~1 key",
    "/0": "literal /0 key",
  };
  // ~1 represents '/'
  // ~0 represents '~'
  assert.equal(resolveJsonPointer(data, "/a~1b/c~0d"), "unescaped match");
  // ~01 represents '~1'
  assert.equal(resolveJsonPointer(data, "/~01"), "literal ~1 key");
  // ~10 represents '/0'
  assert.equal(resolveJsonPointer(data, "/~10"), "literal /0 key");
});

test("resolveJsonPointer: array index lookup and bounds checks return undefined", () => {
  const data = {
    items: ["zero", "one", "two"],
  };
  assert.equal(resolveJsonPointer(data, "/items/1"), "one");
  // Out of bounds index
  assert.equal(resolveJsonPointer(data, "/items/99"), undefined);
  // Negative index
  assert.equal(resolveJsonPointer(data, "/items/-1"), undefined);
  // Non-numeric index on array
  assert.equal(resolveJsonPointer(data, "/items/invalid"), undefined);
});

test("resolveJsonPointer: missing properties and navigating into primitives return undefined", () => {
  const data = {
    user: {
      name: "Alice",
      age: 30,
    },
    nullField: null,
  };
  assert.equal(resolveJsonPointer(data, "/user/missing"), undefined);
  assert.equal(resolveJsonPointer(data, "/user/name/subprop"), undefined);
  assert.equal(resolveJsonPointer(data, "/nullField/prop"), undefined);
  assert.equal(resolveJsonPointer(data, "/nonexistent/sub"), undefined);
});

test("resolveJsonPointer: throws Error when non-empty pointer does not start with '/'", () => {
  const data = { user: { name: "Alice" } };
  assert.throws(
    () => resolveJsonPointer(data, "user/name"),
    /JSON pointer must start with '\/' \(got: user\/name\)/
  );
  assert.throws(
    () => resolveJsonPointer(data, "invalid"),
    /JSON pointer must start with '\/' \(got: invalid\)/
  );
});

// =====================================================================================
// 2. handleCdp('get_response_body') with pointer parameter
// =====================================================================================

test("get_response_body: extracts JSON slice directly when pointer is provided", async () => {
  const jsonPayload = {
    data: {
      viewer: {
        id: "usr_42",
        name: "Test Engineer",
        roles: ["admin", "tester"],
      },
    },
  };
  mockResponses.set("Network.getResponseBody", {
    body: JSON.stringify(jsonPayload),
    base64Encoded: false,
  });

  const res = await handleCdp(
    "get_response_body",
    { requestId: "req-999", pointer: "/data/viewer/roles/1" },
    TAB_ID
  );

  assert.equal(res.ok, true);
  assert.deepEqual(res.result, {
    requestId: "req-999",
    pointer: "/data/viewer/roles/1",
    value: "tester",
    found: true,
  });
});

test("get_response_body: returns found:false with value:undefined when pointer does not match", async () => {
  const jsonPayload = {
    status: "ok",
    items: [],
  };
  mockResponses.set("Network.getResponseBody", {
    body: JSON.stringify(jsonPayload),
    base64Encoded: false,
  });

  const res = await handleCdp(
    "get_response_body",
    { requestId: "req-100", pointer: "/items/5" },
    TAB_ID
  );

  assert.equal(res.ok, true);
  assert.deepEqual(res.result, {
    requestId: "req-100",
    pointer: "/items/5",
    value: undefined,
    found: false,
  });
});

test("get_response_body: throws if requestId is missing", async () => {
  await assert.rejects(
    () => handleCdp("get_response_body", {}, TAB_ID),
    /get_response_body requires 'requestId'/
  );
});

test("get_response_body: throws when pointer is queried on base64Encoded response", async () => {
  mockResponses.set("Network.getResponseBody", {
    body: "aW1hZ2UtZGF0YQ==",
    base64Encoded: true,
  });

  await assert.rejects(
    () => handleCdp("get_response_body", { requestId: "req-b64", pointer: "/data" }, TAB_ID),
    /cannot query JSON pointer on base64-encoded response/
  );
});

test("get_response_body: throws when pointer is queried on non-JSON response body", async () => {
  mockResponses.set("Network.getResponseBody", {
    body: "<html><body>Not JSON</body></html>",
    base64Encoded: false,
  });

  await assert.rejects(
    () => handleCdp("get_response_body", { requestId: "req-html", pointer: "/body" }, TAB_ID),
    /response body is not valid JSON; cannot query pointer/
  );
});

test("get_response_body: throws descriptive error when body is unavailable or evicted", async () => {
  mockResponses.set("Network.getResponseBody", new Error("No data found for given requestId"));

  await assert.rejects(
    () => handleCdp("get_response_body", { requestId: "req-evicted" }, TAB_ID),
    /response body unavailable for req-evicted/
  );
});

// =====================================================================================
// 3. handleCdp('emulate') — presets and parameter overrides
// =====================================================================================

test("emulate: configures iphone-14 device metrics, touch, and userAgent", async () => {
  const res = await handleCdp("emulate", { device: "iphone-14" }, TAB_ID);

  assert.equal(res.ok, true);
  assert.equal(res.result.emulating.device, "iphone-14");
  assert.equal(res.result.emulating.touch, true);
  assert.deepEqual(res.result.emulating.viewport, {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });

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

test("emulate: configures pixel-7 device metrics, touch, and userAgent", async () => {
  const res = await handleCdp("emulate", { device: "pixel-7" }, TAB_ID);

  assert.equal(res.ok, true);
  assert.equal(res.result.emulating.device, "pixel-7");
  assert.equal(res.result.emulating.touch, true);
  assert.deepEqual(res.result.emulating.viewport, {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
  });

  const metricsCall = cdpCalls.find((c) => c.method === "Emulation.setDeviceMetricsOverride");
  assert.deepEqual(metricsCall.params, {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
  });

  const uaCall = cdpCalls.find((c) => c.method === "Emulation.setUserAgentOverride");
  assert.match(uaCall.params.userAgent, /Pixel 7/);
});

test("emulate: configures desktop preset with mobile:false and touch:false", async () => {
  const res = await handleCdp("emulate", { device: "desktop" }, TAB_ID);

  assert.equal(res.ok, true);
  assert.equal(res.result.emulating.device, "desktop");
  assert.equal(res.result.emulating.touch, false);
  assert.deepEqual(res.result.emulating.viewport, {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const touchCall = cdpCalls.find((c) => c.method === "Emulation.setTouchEmulationEnabled");
  assert.deepEqual(touchCall.params, { enabled: false });
});

test("emulate: clear:true resets overrides, touch, user agent, media, and network", async () => {
  const res = await handleCdp("emulate", { clear: true }, TAB_ID);

  assert.equal(res.ok, true);
  assert.deepEqual(res.result, { cleared: true });

  const calledMethods = cdpCalls.map((c) => c.method);
  assert.ok(calledMethods.includes("Emulation.clearDeviceMetricsOverride"));
  assert.ok(calledMethods.includes("Emulation.setUserAgentOverride"));
  assert.ok(calledMethods.includes("Emulation.setTouchEmulationEnabled"));
  assert.ok(calledMethods.includes("Emulation.setEmulatedMedia"));
  assert.ok(calledMethods.includes("Emulation.clearGeolocationOverride"));
  assert.ok(calledMethods.includes("Network.emulateNetworkConditions"));

  const netCall = cdpCalls.find((c) => c.method === "Network.emulateNetworkConditions");
  assert.deepEqual(netCall.params, {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
});

test("emulate: applies colorScheme, geolocation, and offline overrides", async () => {
  const res = await handleCdp(
    "emulate",
    {
      colorScheme: "dark",
      geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
      offline: true,
    },
    TAB_ID
  );

  assert.equal(res.ok, true);
  assert.equal(res.result.emulating.colorScheme, "dark");
  assert.equal(res.result.emulating.geolocation, true);
  assert.equal(res.result.emulating.offline, true);

  const mediaCall = cdpCalls.find((c) => c.method === "Emulation.setEmulatedMedia");
  assert.deepEqual(mediaCall.params, {
    media: "page",
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });

  const geoCall = cdpCalls.find((c) => c.method === "Emulation.setGeolocationOverride");
  assert.deepEqual(geoCall.params, {
    latitude: 37.7749,
    longitude: -122.4194,
    accuracy: 5,
  });

  const netCall = cdpCalls.find((c) => c.method === "Network.emulateNetworkConditions");
  assert.equal(netCall.params.offline, true);
});

// =====================================================================================
// 4. handleCdp('wheel') — scrolling and modifier bitmasks
// =====================================================================================

test("wheel: dispatches mouseWheel event with deltaX and deltaY", async () => {
  const res = await handleCdp("wheel", { x: 120, y: 240, deltaX: 15, deltaY: 75 }, TAB_ID);

  assert.equal(res.ok, true);
  assert.deepEqual(res.result, {
    scrolled: { x: 120, y: 240, deltaX: 15, deltaY: 75 },
  });

  const wheelCall = cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent");
  assert.deepEqual(wheelCall.params, {
    type: "mouseWheel",
    x: 120,
    y: 240,
    deltaX: 15,
    deltaY: 75,
    modifiers: 0,
  });
});

test("wheel: combines modifier bits for shift, ctrl, alt, meta", async () => {
  // Test shift (8)
  cdpCalls.length = 0;
  await handleCdp("wheel", { deltaY: 10, modifiers: ["shift"] }, TAB_ID);
  let wheelCall = cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent");
  assert.equal(wheelCall.params.modifiers, 8);

  // Test ctrl (2) + alt (1) = 3
  cdpCalls.length = 0;
  await handleCdp("wheel", { deltaY: 10, modifiers: ["ctrl", "alt"] }, TAB_ID);
  wheelCall = cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent");
  assert.equal(wheelCall.params.modifiers, 3);

  // Test meta (4) + shift (8) = 12
  cdpCalls.length = 0;
  await handleCdp("wheel", { deltaY: 10, modifiers: ["meta", "shift"] }, TAB_ID);
  wheelCall = cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent");
  assert.equal(wheelCall.params.modifiers, 12);
});

test("wheel: divides coordinates by last capture scale", async () => {
  setLastCaptureScale(TAB_ID, 2);
  const res = await handleCdp("wheel", { x: 300, y: 400, deltaY: 50 }, TAB_ID);

  assert.equal(res.ok, true);
  assert.equal(res.result.scrolled.x, 150);
  assert.equal(res.result.scrolled.y, 200);

  const wheelCall = cdpCalls.find((c) => c.method === "Input.dispatchMouseEvent");
  assert.equal(wheelCall.params.x, 150);
  assert.equal(wheelCall.params.y, 200);
});

test("wheel: refuses synthetic input when tab is backgrounded", async () => {
  tabState = { active: false, windowId: 1 };

  await assert.rejects(
    () => handleCdp("wheel", { deltaY: 50 }, TAB_ID),
    /wheel needs the target tab in the foreground/
  );
});
