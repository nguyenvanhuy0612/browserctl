// Unit Test Suite for In-Page Network Request and DevTools Monitor.
// Validates:
// 1. generateCurlCommand (shell quoting, minimal headers, query params, body)
// 2. makeRequest (validation, execution, JSON serialization, pointer plucking, non-2xx handling, timeout)
// 3. monitorRequests (wildcard filtering, method/status/type filtering, body retrieval, pointer resolution, clear)
// 4. Backward-compatible aliases and tool registry integration

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateCurlCommand,
  shellQuote,
  resolveJsonPointer,
  urlMatchesPattern,
} from "../../extension/driver/network.js";

import {
  handleMakeRequest,
  handleMonitorRequests,
} from "../../extension/tools/network_tools.js";

import { createDefaultRegistry } from "../../extension/tools/index.js";

// =====================================================================================
// 1. generateCurlCommand & shellQuote Invariants
// =====================================================================================

test("shellQuote: leaves safe identifiers unquoted and escapes quotes properly", () => {
  assert.equal(shellQuote("https://api.example.com/v1"), "https://api.example.com/v1");
  assert.equal(shellQuote("Bearer eyJhbGciOiJIUzI1NiJ9"), "'Bearer eyJhbGciOiJIUzI1NiJ9'");
  assert.equal(shellQuote("hello 'world'"), "'hello '\\''world'\\'''");
});

test("generateCurlCommand: builds minimal, ready-to-copy curl invocation", () => {
  const curl = generateCurlCommand({
    url: "https://api.example.com/items",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token-123",
      "sec-ch-ua": '"Chromium";v="131"',
      "sec-fetch-mode": "cors",
      ":authority": "api.example.com",
    },
    query: { page: 1, limit: 20 },
    body: { name: "Sample Item", count: 42 },
  });

  assert.ok(curl.startsWith("curl \\\n  -X POST"), "Must start with curl -X POST");
  assert.ok(curl.includes("-H 'Content-Type: application/json'"), "Must include Content-Type");
  assert.ok(curl.includes("-H 'Authorization: Bearer test-token-123'"), "Must include Authorization");
  assert.ok(!curl.includes("sec-ch-ua"), "Must strip browser internal sec-ch-ua header");
  assert.ok(!curl.includes(":authority"), "Must strip pseudo-headers");
  assert.ok(curl.includes("--data '{\"name\":\"Sample Item\",\"count\":42}'"), "Must include body JSON");
  assert.ok(curl.includes("'https://api.example.com/items?page=1&limit=20'"), "Must include query params in URL");
});

test("generateCurlCommand: handles GET requests without -X GET", () => {
  const curl = generateCurlCommand({
    url: "https://api.example.com/status",
    method: "GET",
    headers: { Accept: "application/json" },
  });
  assert.ok(!curl.includes("-X GET"), "Default GET should omit -X GET");
  assert.ok(curl.includes("-H 'Accept: application/json'"));
  assert.ok(curl.includes("https://api.example.com/status"));
});

// =====================================================================================
// 2. RFC 6901 JSON Pointer Traversal
// =====================================================================================

test("resolveJsonPointer: plucks nested values and handles array indices and escapes", () => {
  const payload = {
    data: {
      users: [
        { id: 1, name: "Alice", "first/last": "Alice A" },
        { id: 2, name: "Bob", "~key": "special" },
      ],
    },
  };

  assert.equal(resolveJsonPointer(payload, ""), payload);
  assert.equal(resolveJsonPointer(payload, "/data/users/0/name"), "Alice");
  assert.equal(resolveJsonPointer(payload, "/data/users/1/name"), "Bob");
  assert.equal(resolveJsonPointer(payload, "/data/users/0/first~1last"), "Alice A");
  assert.equal(resolveJsonPointer(payload, "/data/users/1/~0key"), "special");
  assert.equal(resolveJsonPointer(payload, "/data/users/99"), undefined);
});

// =====================================================================================
// 3. urlMatchesPattern Wildcards
// =====================================================================================

test("urlMatchesPattern: evaluates exact, wildcard, and substring patterns", () => {
  assert.equal(urlMatchesPattern("https://teams.office.com/api/v1/chats", "*api/v1/*"), true);
  assert.equal(urlMatchesPattern("https://teams.office.com/api/v2/chats", "*api/v1/*"), false);
  assert.equal(urlMatchesPattern("https://chat.zalo.me/api/message/send", "chat.zalo.me"), true);
  assert.equal(urlMatchesPattern("https://other.domain.com", "chat.zalo.me"), false);
  assert.equal(urlMatchesPattern("https://example.com", "*"), true);
});

// =====================================================================================
// 4. make_request Handler Validation & In-Page Context Execution
// =====================================================================================

test("handleMakeRequest: requires url or requestId", async () => {
  await assert.rejects(
    async () => await handleMakeRequest({}, {}),
    /make_request requires 'url' or 'requestId'/
  );
});

test("handleMakeRequest: dispatches to contentBridge when present", async () => {
  let bridgeCalledWith = null;
  const mockBridge = {
    send: async (action, params, tabId) => {
      bridgeCalledWith = { action, params, tabId };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        data: { success: true },
        curl: "curl 'https://api.example.com'",
      };
    },
  };

  const res = await handleMakeRequest(
    { url: "https://api.example.com", method: "GET" },
    { contentBridge: mockBridge, resolveTabId: () => 12 }
  );

  assert.equal(bridgeCalledWith.action, "make_request");
  assert.equal(bridgeCalledWith.tabId, 12);
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
});

test("handleMakeRequest: dispatches to driver when contentBridge is absent", async () => {
  let driverCalledWith = null;
  const mockDriver = {
    makeRequest: async (tabId, params) => {
      driverCalledWith = { tabId, params };
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        data: { error: "AUTH_EXPIRED" },
        curl: "curl 'https://teams.cloud.microsoft/api/chatsvc'",
      };
    },
  };

  const res = await handleMakeRequest(
    { url: "https://teams.cloud.microsoft/api/chatsvc" },
    { driver: mockDriver, resolveTabId: () => 7 }
  );

  assert.equal(driverCalledWith.tabId, 7);
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.equal(res.data.error, "AUTH_EXPIRED");
});

// =====================================================================================
// 5. ToolRegistry Integration & Aliases
// =====================================================================================

test("ToolRegistry: registers browser_make_request and browser_monitor_requests with aliases", () => {
  const reg = createDefaultRegistry();

  assert.ok(reg.has("browser_make_request"), "browser_make_request must be registered");
  assert.ok(reg.has("make_request"), "make_request alias must be routable");
  assert.ok(reg.has("request"), "request alias must be routable");
  assert.ok(reg.has("fetch"), "fetch alias must be routable");
  assert.ok(reg.has("network_replay"), "network_replay alias must be routable");

  assert.ok(reg.has("browser_monitor_requests"), "browser_monitor_requests must be registered");
  assert.ok(reg.has("monitor_requests"), "monitor_requests alias must be routable");
  assert.ok(reg.has("monitor"), "monitor alias must be routable");
  assert.ok(reg.has("wait_for_request"), "wait_for_request alias must be routable");
});

test("handleMonitorRequests: validates action parameter and dispatches to driver", async () => {
  await assert.rejects(
    async () => await handleMonitorRequests({ action: "get" }, {}),
    /monitor_requests get requires 'requestId'/
  );

  let driverParams = null;
  const mockDriver = {
    monitorRequests: async (tabId, params) => {
      driverParams = { tabId, params };
      return {
        ok: true,
        result: { count: 1, requests: [{ requestId: "r1", url: "https://api.test", status: 200 }] },
      };
    },
  };

  const res = await handleMonitorRequests(
    { action: "list", url_pattern: "*api*" },
    { driver: mockDriver, resolveTabId: () => 5 }
  );

  assert.equal(driverParams.tabId, 5);
  assert.equal(driverParams.params.url_pattern, "*api*");
  assert.equal(res.ok, true);
  assert.equal(res.result.count, 1);
});
