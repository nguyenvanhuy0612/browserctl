// Unit & Acceptance tests for Extension Zero-Error & Boundary Containment Specification
// Adheres strictly to docs/spec/01-protocol-and-errors.md §7 and docs/spec/05-test-and-acceptance-matrix.md §2.4

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractFunction, extractConst } from "./source-slice.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BG_SRC = readFileSync(join(__dirname, "..", "..", "extension", "background.js"), "utf8");

test("TC-EXT-01: isRestrictedUrl correctly classifies restricted schemes", () => {
  const ctx = vm.createContext({
    URL,
    Set,
  });
  const restrictedProtocolsCode = extractConst(BG_SRC, "RESTRICTED_PROTOCOLS");
  const isRestrictedUrlCode = extractFunction(BG_SRC, "isRestrictedUrl");

  vm.runInContext(
    `${restrictedProtocolsCode}\n${isRestrictedUrlCode}\nglobalThis.__isRestrictedUrl = isRestrictedUrl;`,
    ctx
  );

  const isRestricted = ctx.__isRestrictedUrl;

  // Restricted schemes
  assert.equal(isRestricted("chrome://extensions"), true);
  assert.equal(isRestricted("chrome://settings/"), true);
  assert.equal(isRestricted("chrome-extension://agamchohpgmnoidpppbjpjghcagppmdo/popup.html"), true);
  assert.equal(isRestricted("devtools://devtools/bundled/inspector.html"), true);
  assert.equal(isRestricted("edge://settings"), true);
  assert.equal(isRestricted("brave://settings"), true);
  assert.equal(isRestricted("opera://startpage"), true);
  assert.equal(isRestricted("vivaldi://bookmarks"), true);
  assert.equal(isRestricted("view-source:https://example.com"), true);
  assert.equal(isRestricted("about:config"), true);
  assert.equal(isRestricted("about:net-internals"), true);

  // Allowed schemes
  assert.equal(isRestricted("https://example.com"), false);
  assert.equal(isRestricted("http://127.0.0.1:8080/app"), false);
  assert.equal(isRestricted("file:///Users/admin/test.html"), false);
  assert.equal(isRestricted("about:blank"), false);

  // Edge cases
  assert.equal(isRestricted(""), false);
  assert.equal(isRestricted(null), false);
  assert.equal(isRestricted(undefined), false);
  assert.equal(isRestricted(123), false);
  assert.equal(isRestricted("not a valid url at all"), false);
});

test("TC-EXT-02: safeSendTabMessage consumes lastError and prevents unhandled runtime errors", async () => {
  let callbackInvoked = false;
  let lastErrorChecked = false;

  const ctx = vm.createContext({
    Promise,
    Error,
    chrome: {
      runtime: {
        get lastError() {
          lastErrorChecked = true;
          return { message: "Could not establish connection. Receiving end does not exist." };
        },
      },
      tabs: {
        sendMessage(tabId, message, options, cb) {
          callbackInvoked = true;
          if (typeof options === "function") {
            cb = options;
          }
          cb(undefined);
        },
      },
    },
  });

  const safeSendTabMessageCode = extractFunction(BG_SRC, "safeSendTabMessage");
  vm.runInContext(
    `${safeSendTabMessageCode}\nglobalThis.__safeSendTabMessage = safeSendTabMessage;`,
    ctx
  );

  await assert.rejects(
    async () => {
      await ctx.__safeSendTabMessage(123, { action: "ping" }, { frameId: 0 });
    },
    (err) => {
      assert.equal(err.name, "ExtensionMessageError");
      assert.match(err.message, /Could not establish connection/);
      return true;
    }
  );

  assert.equal(callbackInvoked, true, "Callback form must be used");
  assert.equal(lastErrorChecked, true, "chrome.runtime.lastError must be accessed and checked");
});

test("TC-EXT-02b: safeSendTabMessage resolves successfully on normal response", async () => {
  const ctx = vm.createContext({
    Promise,
    Error,
    chrome: {
      runtime: {
        get lastError() {
          return null;
        },
      },
      tabs: {
        sendMessage(tabId, message, options, cb) {
          if (typeof options === "function") cb = options;
          cb({ ok: true, result: "mock_success" });
        },
      },
    },
  });

  const safeSendTabMessageCode = extractFunction(BG_SRC, "safeSendTabMessage");
  vm.runInContext(
    `${safeSendTabMessageCode}\nglobalThis.__safeSendTabMessage = safeSendTabMessage;`,
    ctx
  );

  const res = await ctx.__safeSendTabMessage(456, { action: "query" });
  assert.deepEqual(res, { ok: true, result: "mock_success" });
});

test("TC-EXT-03: wakeIfAsleep skips restricted URLs entirely", async () => {
  let pingSent = false;
  let scriptExecuted = false;

  const ctx = vm.createContext({
    URL,
    Set,
    Error,
    Promise,
    chrome: {
      runtime: { lastError: null },
      tabs: {
        sendMessage: () => {
          pingSent = true;
        },
      },
      scripting: {
        executeScript: () => {
          scriptExecuted = true;
        },
      },
    },
  });

  const restrictedProtocolsCode = extractConst(BG_SRC, "RESTRICTED_PROTOCOLS");
  const isRestrictedUrlCode = extractFunction(BG_SRC, "isRestrictedUrl");
  const wakeIfAsleepCode = extractFunction(BG_SRC, "wakeIfAsleep");

  vm.runInContext(
    `${restrictedProtocolsCode}\n${isRestrictedUrlCode}\n${wakeIfAsleepCode}\nglobalThis.__wakeIfAsleep = wakeIfAsleep;`,
    ctx
  );

  const restrictedTab = { id: 99, url: "chrome://extensions", status: "complete", active: false };
  await ctx.__wakeIfAsleep(restrictedTab);

  assert.equal(pingSent, false, "Must not ping restricted tab");
  assert.equal(scriptExecuted, false, "Must not execute script on restricted tab");
});

test("TC-EXT-04: toContent rejects with POLICY_RESTRICTION on restricted URL", async () => {
  const ctx = vm.createContext({
    URL,
    Set,
    Error,
    Promise,
    RPC_ERRORS: { POLICY_RESTRICTION: -32008 },
    RpcError: class RpcError extends Error {
      constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data;
      }
    },
    targetTab: async () => ({ id: 101, url: "chrome://settings/" }),
    wakeIfAsleep: async () => {},
    confirmNothingHappened: async (res) => res,
  });

  const restrictedProtocolsCode = extractConst(BG_SRC, "RESTRICTED_PROTOCOLS");
  const isRestrictedUrlCode = extractFunction(BG_SRC, "isRestrictedUrl");
  const toContentCode = extractFunction(BG_SRC, "toContent");

  vm.runInContext(
    `${restrictedProtocolsCode}\n${isRestrictedUrlCode}\n${toContentCode}\nglobalThis.__toContent = toContent;`,
    ctx
  );

  await assert.rejects(
    async () => {
      await ctx.__toContent("click", { target: "@e1" });
    },
    (err) => {
      assert.equal(err.code, -32008);
      assert.equal(err.data.reason, "POLICY_RESTRICTION");
      assert.match(err.message, /restricted browser page/);
      return true;
    }
  );
});

test("TC-EXT-05: handleCdpAction and handleNetAction reject with POLICY_RESTRICTION on restricted URL", async () => {
  const ctx = vm.createContext({
    URL,
    Set,
    Error,
    Promise,
    RPC_ERRORS: { POLICY_RESTRICTION: -32008 },
    RpcError: class RpcError extends Error {
      constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data;
      }
    },
    targetTab: async () => ({ id: 102, url: "devtools://devtools/bundled/inspector.html" }),
  });

  const restrictedProtocolsCode = extractConst(BG_SRC, "RESTRICTED_PROTOCOLS");
  const isRestrictedUrlCode = extractFunction(BG_SRC, "isRestrictedUrl");
  const handleCdpActionCode = extractFunction(BG_SRC, "handleCdpAction");
  const handleNetActionCode = extractFunction(BG_SRC, "handleNetAction");

  vm.runInContext(
    `${restrictedProtocolsCode}\n${isRestrictedUrlCode}\n${handleCdpActionCode}\n${handleNetActionCode}\nglobalThis.__handleCdpAction = handleCdpAction;\nglobalThis.__handleNetAction = handleNetAction;`,
    ctx
  );

  await assert.rejects(
    async () => {
      await ctx.__handleCdpAction("capture_screenshot", {});
    },
    (err) => {
      assert.equal(err.code, -32008);
      assert.equal(err.data.reason, "POLICY_RESTRICTION");
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await ctx.__handleNetAction("network_get_log", {});
    },
    (err) => {
      assert.equal(err.code, -32008);
      assert.equal(err.data.reason, "POLICY_RESTRICTION");
      return true;
    }
  );
});

test("TC-EXT-06: isBridgeReachable checks daemon status and absorbs failures cleanly", async () => {
  const BG_SRC_UPDATED = readFileSync(join(__dirname, "..", "..", "extension", "background.js"), "utf8");
  const isBridgeReachableCode = extractFunction(BG_SRC_UPDATED, "isBridgeReachable");

  // Subtest 1: Bridge is up (fetch succeeds with 200)
  const ctxSuccess = vm.createContext({
    URL,
    Promise,
    fetch: async (url) => {
      assert.match(url, /http:\/\/127\.0\.0\.1:8765\/status/);
      return { ok: true, status: 200 };
    },
  });
  vm.runInContext(
    `${isBridgeReachableCode}\nglobalThis.__isBridgeReachable = isBridgeReachable;`,
    ctxSuccess
  );
  const up = await ctxSuccess.__isBridgeReachable("ws://127.0.0.1:8765/extension");
  assert.equal(up, true, "Returns true when bridge responds ok");

  // Subtest 2: Bridge is down (fetch throws TypeError: Failed to fetch)
  const ctxFailure = vm.createContext({
    URL,
    Promise,
    fetch: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  vm.runInContext(
    `${isBridgeReachableCode}\nglobalThis.__isBridgeReachable = isBridgeReachable;`,
    ctxFailure
  );
  const down = await ctxFailure.__isBridgeReachable("ws://127.0.0.1:8765/extension");
  assert.equal(down, false, "Returns false cleanly without throwing when bridge is offline");

  // Subtest 3: Fallback when fetch is not available in environment
  const ctxNoFetch = vm.createContext({
    URL,
    Promise,
  });
  vm.runInContext(
    `${isBridgeReachableCode}\nglobalThis.__isBridgeReachable = isBridgeReachable;`,
    ctxNoFetch
  );
  const noFetch = await ctxNoFetch.__isBridgeReachable("ws://127.0.0.1:8765/extension");
  assert.equal(noFetch, true, "Gracefully falls back to true if fetch is unavailable");
});
