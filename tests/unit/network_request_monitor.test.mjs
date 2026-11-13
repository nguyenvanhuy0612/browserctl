// Unit Test Suite for Network driver helpers.
// Validates:
// 1. generateCurlCommand (shell quoting, minimal headers, query params, body)
// 2. resolveJsonPointer (RFC 6901 JSON pointer traversal)
// 3. urlMatchesPattern (wildcard, exact, substring matching)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateCurlCommand,
  shellQuote,
  resolveJsonPointer,
  urlMatchesPattern,
} from "../../extension/driver/network.js";

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

