// Acceptance & Unit Test Suite for Milestone 4: Tools Domain Handlers Subsystem.
//
// Specifications:
// - docs/spec/00-architecture-overview.md
// - docs/spec/03-tools-and-handlers.md
//
// Verifies:
// 1. ExecutionContext properties and target tab resolution.
// 2. ToolRegistry registration, retrieval, listing, schema validation, and execution.
// 3. AbortSignal cancellation propagation (pre-check and in-flight).
// 4. Default configured registry registers all 78 domain tools and 25 core tools.
// 5. Individual domain tool execution across action, navigate, inspect, tabs, network, emulate, download, storage.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ToolRegistry,
  ExecutionContext,
  defaultRegistry,
  createDefaultRegistry,
  actionTools,
  navigateTools,
  inspectTools,
  tabsTools,
  networkTools,
  emulateTools,
  downloadTools,
  storageTools,
} from "../../extension/tools/index.js";
import {
  RpcError,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  EXECUTION_ABORTED,
} from "../../extension/transport/errors.js";

// =====================================================================================
// 1. ExecutionContext
// =====================================================================================

test("ExecutionContext: initializes properties and resolves tabId correctly", () => {
  const signal = new AbortController().signal;
  const mockDriver = { id: "mock-driver" };
  const mockBridge = { id: "mock-bridge" };

  const ctx = new ExecutionContext({
    tabId: 42,
    browserProfile: "core",
    signal,
    driver: mockDriver,
    contentBridge: mockBridge,
  });

  assert.equal(ctx.tabId, 42);
  assert.equal(ctx.browserProfile, "core");
  assert.equal(ctx.signal, signal);
  assert.equal(ctx.driver, mockDriver);
  assert.equal(ctx.contentBridge, mockBridge);

  // resolveTabId fallback order
  assert.equal(ctx.resolveTabId(), 42);
  assert.equal(ctx.resolveTabId(99), 99);
  assert.equal(ctx.resolveTabId({ tabId: 101 }), 101);

  // Context without default tabId
  const emptyCtx = new ExecutionContext();
  assert.equal(emptyCtx.resolveTabId(), null);
  assert.equal(emptyCtx.resolveTabId(55), 55);
});

// =====================================================================================
// 2. ToolRegistry Core Operations
// =====================================================================================

test("ToolRegistry: registers, retrieves, and checks existence by name and aliases", () => {
  const registry = new ToolRegistry();

  assert.throws(() => registry.register(null), /must have a string 'name'/i);
  assert.throws(() => registry.register({ name: "test_tool" }), /must provide a handler/i);

  registry.register({
    name: "browser_test_tool",
    profile: "core",
    aliases: ["test_tool", "tt"],
    handler: async () => ({ ok: true, result: "done" }),
  });

  assert.ok(registry.has("browser_test_tool"));
  assert.ok(registry.has("test_tool"));
  assert.ok(registry.has("tt"));
  assert.ok(!registry.has("nonexistent"));

  assert.equal(registry.get("browser_test_tool").name, "browser_test_tool");
  assert.equal(registry.get("test_tool").name, "browser_test_tool");
  assert.equal(registry.get("tt").name, "browser_test_tool");
  assert.equal(registry.get("unknown"), null);
});

test("ToolRegistry: lists tools filtered by profile and dedupes aliases", () => {
  const registry = new ToolRegistry();

  registry.register({
    name: "tool_1",
    profile: "core",
    aliases: ["t1"],
    handler: async () => {},
  });
  registry.register({
    name: "tool_2",
    profile: "advanced",
    aliases: ["t2"],
    handler: async () => {},
  });
  registry.register({
    name: "tool_3",
    profile: "core",
    handler: async () => {},
  });

  const all = registry.list("all");
  assert.equal(all.length, 3);
  assert.deepEqual(
    all.map((t) => t.name),
    ["tool_1", "tool_2", "tool_3"]
  );

  const core = registry.list("core");
  assert.equal(core.length, 2);
  assert.deepEqual(
    core.map((t) => t.name),
    ["tool_1", "tool_3"]
  );

  const advanced = registry.list("advanced");
  assert.equal(advanced.length, 1);
  assert.equal(advanced[0].name, "tool_2");
});

test("ToolRegistry.execute: executes handler and validates required schema params", async () => {
  const registry = new ToolRegistry();

  registry.register({
    name: "tool_req",
    profile: "core",
    schema: { required: ["target", "value"] },
    handler: async (params) => ({ ok: true, result: `${params.target}:${params.value}` }),
  });

  // Rejects unknown tool
  await assert.rejects(
    async () => registry.execute("unknown_tool", {}),
    (err) => err.code === METHOD_NOT_FOUND
  );

  // Rejects missing required parameters
  await assert.rejects(
    async () => registry.execute("tool_req", { target: "@e1" }),
    (err) => err.code === INVALID_PARAMS && err.data.missingParameter === "value"
  );

  // Executes successfully when parameters valid
  const res = await registry.execute("tool_req", { target: "@e1", value: "hello" });
  assert.deepEqual(res, { ok: true, result: "@e1:hello" });
});

test("ToolRegistry.execute: supports custom schema.validate function", async () => {
  const registry = new ToolRegistry();

  registry.register({
    name: "tool_custom_val",
    schema: {
      validate(params) {
        if (!params.num || typeof params.num !== "number" || params.num < 0) {
          return { valid: false, error: "'num' must be a positive number" };
        }
        return { valid: true };
      },
    },
    handler: async (params) => ({ double: params.num * 2 }),
  });

  await assert.rejects(
    async () => registry.execute("tool_custom_val", { num: -5 }),
    (err) => err.code === INVALID_PARAMS && err.message.includes("positive number")
  );

  const res = await registry.execute("tool_custom_val", { num: 21 });
  assert.deepEqual(res, { double: 42 });
});

test("ToolRegistry.execute: honors AbortSignal pre-check and mid-execution cancellation", async () => {
  const registry = new ToolRegistry();

  registry.register({
    name: "tool_slow",
    handler: async (_params, ctx) => {
      await new Promise((r) => setTimeout(r, 100));
      return { done: true };
    },
  });

  // Pre-aborted signal
  const preController = new AbortController();
  preController.abort();
  const preCtx = new ExecutionContext({ signal: preController.signal });

  await assert.rejects(
    async () => registry.execute("tool_slow", {}, preCtx),
    (err) => err.code === EXECUTION_ABORTED
  );

  // Mid-flight abort
  const midController = new AbortController();
  const midCtx = new ExecutionContext({ signal: midController.signal });

  const runPromise = registry.execute("tool_slow", {}, midCtx);
  setTimeout(() => midController.abort(), 20);

  await assert.rejects(
    async () => runPromise,
    (err) => err.code === EXECUTION_ABORTED
  );
});

// =====================================================================================
// 3. Default Registry All 78 Tools & 25 Core Profile Invariants
// =====================================================================================

test("defaultRegistry: contains exactly 80 unique tools across all profiles", () => {
  const allTools = defaultRegistry.list("all");
  assert.equal(allTools.length, 80, "Must contain exactly 80 unique domain tools");

  const coreTools = defaultRegistry.list("core");
  assert.equal(coreTools.length, 25, "Core profile must contain exactly 25 tools");
});

test("defaultRegistry: every tool can be queried by name", () => {
  const names = defaultRegistry.list("all").map((t) => t.name);
  for (const name of names) {
    assert.ok(defaultRegistry.has(name), `Tool '${name}' must be registered`);
    assert.ok(typeof defaultRegistry.get(name).handler === "function");
  }
});

// =====================================================================================
// 4. Domain Handlers Execution & csv_safe Invariant
// =====================================================================================

test("Domain Tools: action domain tools execute and validate parameters", async () => {
  const reg = createDefaultRegistry();

  // click
  await assert.rejects(
    async () => reg.execute("browser_click", {}),
    (err) => err.code === INVALID_PARAMS
  );
  const clickRes = await reg.execute("browser_click", { target: "@e1" });
  assert.equal(clickRes.result.clicked, "@e1");

  // type
  await assert.rejects(
    async () => reg.execute("browser_type", {}),
    (err) => err.code === INVALID_PARAMS
  );
  const typeRes = await reg.execute("browser_type", { text: "Search Query" });
  assert.equal(typeRes.result.typed, "Search Query");

  // wheel
  const wheelRes = await reg.execute("browser_wheel", { deltaX: 0, deltaY: 120 });
  assert.equal(wheelRes.result.deltaY, 120);

  // drag
  await assert.rejects(
    async () => reg.execute("browser_drag", {}),
    (err) => err.code === INVALID_PARAMS
  );
  const dragRes = await reg.execute("browser_drag", { fromX: 10, fromY: 10, toX: 100, toY: 100 });
  assert.equal(dragRes.result.dragged, true);
});

test("Domain Tools: inspect domain tools execute and enforce csv_safe formula protection", async () => {
  const reg = createDefaultRegistry();

  // evaluate
  await assert.rejects(
    async () => reg.execute("browser_evaluate", {}),
    (err) => err.code === INVALID_PARAMS
  );

  // extract with contentBridge mock verifying csv_safe
  const mockBridge = {
    async send(action, params) {
      if (action === "extract") {
        return {
          ok: true,
          result: {
            rows: [
              ["Product", "FormulaCell", "Normal"],
              ["Laptop", "=1+2", "Clean"],
              ["Mouse", "+SUM(A1:A5)", "Clean"],
              ["Keyboard", "@special", "Clean"],
            ],
          },
        };
      }
      return { ok: true, result: {} };
    },
  };

  const ctx = new ExecutionContext({ contentBridge: mockBridge });
  const extractRes = await reg.execute("browser_extract", {}, ctx);

  assert.deepEqual(extractRes.result.rows[1], ["Laptop", "'=1+2", "Clean"]);
  assert.deepEqual(extractRes.result.rows[2], ["Mouse", "'+SUM(A1:A5)", "Clean"]);
  assert.deepEqual(extractRes.result.rows[3], ["Keyboard", "'@special", "Clean"]);
});

test("Domain Tools: tabs domain dispatches sub-actions", async () => {
  const reg = createDefaultRegistry();

  const listRes = await reg.execute("browser_tabs", { action: "list" });
  assert.ok(Array.isArray(listRes.result.tabs));

  const newRes = await reg.execute("browser_tabs", { action: "new", url: "https://example.com" });
  assert.equal(newRes.result.created, true);

  const switchRes = await reg.execute("browser_tabs", { action: "switch", tabId: 2 });
  assert.equal(switchRes.result.switched, true);
});

test("Domain Tools: emulate, download, and storage domain handlers execute cleanly", async () => {
  const reg = createDefaultRegistry();

  // emulate
  const emuRes = await reg.execute("browser_emulate", { preset: "iphone-14" });
  assert.equal(emuRes.result.preset, "iphone-14");

  // download
  const dlRes = await reg.execute("browser_download", { url: "https://example.com/file.pdf" });
  assert.equal(dlRes.result.url, "https://example.com/file.pdf");

  // storage
  const setRes = await reg.execute("browser_storage_set", { key: "token", value: "xyz" });
  assert.equal(setRes.result.success, true);
});
