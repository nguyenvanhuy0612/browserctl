// Acceptance test suite for Milestone 4: Tools Domain Handlers Subsystem.
//
// Specifications:
// - docs/spec/03-tools-and-handlers.md
// - docs/spec/05-test-and-acceptance-matrix.md
//
// Verifies:
// 1. ToolRegistry Lifecycle & Profile Filtering (core, advanced, tabs, network).
// 2. ExecutionContext Contract ({ tabId, browserProfile, signal, driver, contentBridge }).
// 3. Schema & Parameter Validation (rejection with RpcError code -32602 INVALID_PARAMS).
// 4. Execution Pipeline & Abort Propagation (immediate stop with -32006 EXECUTION_ABORTED).
// 5. Domain Distribution Matrix (action, navigate, inspect, tabs, network, emulate, download, storage).
// 6. Agent Reading Budget Invariant (TC-PROTO-03: <= 20,200 chars).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { RpcError, RPC_ERRORS } from "../../extension/transport/errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, "../..");

// Dynamic imports of tools subsystem modules
let toolsRegistryModule = null;
let toolsContextModule = null;
let toolsIndexModule = null;

let actionModule = null;
let navigateModule = null;
let inspectModule = null;
let tabsModule = null;
let networkToolsModule = null;
let emulateToolsModule = null;
let downloadToolsModule = null;
let storageToolsModule = null;

try {
  toolsRegistryModule = await import("../../extension/tools/registry.js");
} catch {}
try {
  toolsContextModule = await import("../../extension/tools/context.js");
} catch {}
try {
  toolsIndexModule = await import("../../extension/tools/index.js");
} catch {}

try {
  actionModule = await import("../../extension/tools/action.js");
} catch {}
try {
  navigateModule = await import("../../extension/tools/navigate.js");
} catch {}
try {
  inspectModule = await import("../../extension/tools/inspect.js");
} catch {}
try {
  tabsModule = await import("../../extension/tools/tabs.js");
} catch {}
try {
  networkToolsModule = await import("../../extension/tools/network_tools.js");
} catch {}
try {
  emulateToolsModule = await import("../../extension/tools/emulate_tools.js");
} catch {}
try {
  downloadToolsModule = await import("../../extension/tools/download_tools.js");
} catch {}
try {
  storageToolsModule = await import("../../extension/tools/storage_tools.js");
} catch {}

const ToolRegistry =
  toolsRegistryModule?.ToolRegistry ||
  toolsIndexModule?.ToolRegistry ||
  toolsRegistryModule?.default ||
  toolsIndexModule?.default;

const ExecutionContext =
  toolsContextModule?.ExecutionContext ||
  toolsRegistryModule?.ExecutionContext ||
  toolsIndexModule?.ExecutionContext;

const createDefaultRegistry = toolsIndexModule?.createDefaultRegistry;

// Helper to create mock execution context
function createMockContext(overrides = {}) {
  const controller = new AbortController();
  const base = {
    tabId: 101,
    browserProfile: "core",
    signal: controller.signal,
    driver: {
      sendCdp: async () => ({}),
      evaluate: async () => ({}),
    },
    contentBridge: {
      sendContentMessage: async () => ({}),
    },
    resolveTabId: (target) => 101,
    ...overrides,
  };

  if (typeof ExecutionContext === "function") {
    return new ExecutionContext(base);
  }
  return base;
}

// =====================================================================================
// 1. ToolRegistry Lifecycle & Profile Filtering
// =====================================================================================

test("ToolRegistry: registers descriptors and retrieves them by name", () => {
  assert.ok(typeof ToolRegistry === "function", "ToolRegistry class must be exported");

  const registry = new ToolRegistry();
  const mockDescriptor = {
    name: "test_action_tool",
    profile: "core",
    description: "Performs a test action on target element",
    schema: {
      type: "object",
      properties: {
        target: { type: "string" },
      },
      required: ["target"],
    },
    handler: async (params, ctx) => ({ status: "ok", target: params.target }),
  };

  registry.register(mockDescriptor);

  assert.equal(registry.has("test_action_tool"), true);
  assert.equal(registry.has("nonexistent_tool"), false);

  const retrieved = registry.get("test_action_tool");
  assert.ok(retrieved != null);
  assert.equal(retrieved.name, "test_action_tool");
  assert.equal(retrieved.profile, "core");
  assert.equal(typeof retrieved.handler, "function");
});

test("ToolRegistry: filters registered tools by profile (core, advanced, tabs, network)", () => {
  assert.ok(typeof ToolRegistry === "function", "ToolRegistry class must be exported");

  const registry = new ToolRegistry();

  registry.register({
    name: "tool_core_1",
    profile: "core",
    handler: async () => ({}),
  });
  registry.register({
    name: "tool_core_2",
    profile: "core",
    handler: async () => ({}),
  });
  registry.register({
    name: "tool_adv_1",
    profile: "advanced",
    handler: async () => ({}),
  });
  registry.register({
    name: "tool_tab_1",
    profile: "tabs",
    handler: async () => ({}),
  });
  registry.register({
    name: "tool_net_1",
    profile: "network",
    handler: async () => ({}),
  });

  const listFn = registry.list
    ? registry.list.bind(registry)
    : registry.filterByProfile.bind(registry);
  assert.ok(
    typeof listFn === "function",
    "ToolRegistry must provide list or filterByProfile method"
  );

  const coreTools = listFn("core");
  const advTools = listFn("advanced");
  const tabTools = listFn("tabs");
  const netTools = listFn("network");
  const allTools = listFn();

  const getNames = (tools) =>
    Array.isArray(tools) ? tools.map((t) => t.name || t) : Object.keys(tools);

  assert.deepEqual(getNames(coreTools).sort(), ["tool_core_1", "tool_core_2"]);
  assert.deepEqual(getNames(advTools).sort(), ["tool_adv_1"]);
  assert.deepEqual(getNames(tabTools).sort(), ["tool_tab_1"]);
  assert.deepEqual(getNames(netTools).sort(), ["tool_net_1"]);
  assert.equal(getNames(allTools).length, 5);
});

// =====================================================================================
// 2. ExecutionContext Contract
// =====================================================================================

test("ExecutionContext: preserves tabId, browserProfile, signal, driver, and contentBridge", () => {
  assert.ok(typeof ExecutionContext === "function", "ExecutionContext class must be exported");

  const controller = new AbortController();
  const mockDriver = { cdp: true };
  const mockBridge = { bridge: true };

  const ctx = new ExecutionContext({
    tabId: 55,
    browserProfile: "advanced",
    signal: controller.signal,
    driver: mockDriver,
    contentBridge: mockBridge,
  });

  assert.equal(ctx.tabId, 55);
  assert.equal(ctx.browserProfile, "advanced");
  assert.equal(ctx.signal, controller.signal);
  assert.equal(ctx.driver, mockDriver);
  assert.equal(ctx.contentBridge, mockBridge);
});

// =====================================================================================
// 3. Schema & Parameter Validation
// =====================================================================================

test("Validation: rejects with RpcError code -32602 (INVALID_PARAMS) on missing required params", async () => {
  assert.ok(typeof ToolRegistry === "function", "ToolRegistry class must be exported");

  const registry = new ToolRegistry();
  registry.register({
    name: "validated_tool",
    profile: "core",
    schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
      },
      required: ["selector", "text"],
    },
    handler: async (params) => ({ received: params }),
  });

  const ctx = createMockContext();

  // Missing 'text' parameter
  await assert.rejects(
    async () => {
      await registry.execute("validated_tool", { selector: "#submit-btn" }, ctx);
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, RPC_ERRORS.INVALID_PARAMS);
      assert.equal(err.code, -32602);
      return true;
    }
  );

  // Missing 'selector' parameter
  await assert.rejects(
    async () => {
      await registry.execute("validated_tool", { text: "hello" }, ctx);
    },
    (err) => {
      assert.equal(err.code, -32602);
      return true;
    }
  );
});

test("Validation: rejects with RpcError code -32602 (INVALID_PARAMS) on invalid parameter types", async () => {
  assert.ok(typeof ToolRegistry === "function", "ToolRegistry class must be exported");

  const registry = new ToolRegistry();
  registry.register({
    name: "type_checked_tool",
    profile: "core",
    schema: {
      type: "object",
      properties: {
        count: { type: "number" },
      },
      required: ["count"],
    },
    handler: async (params) => ({ result: params.count * 2 }),
  });

  const ctx = createMockContext();

  // String passed instead of number
  await assert.rejects(
    async () => {
      await registry.execute("type_checked_tool", { count: "not-a-number" }, ctx);
    },
    (err) => {
      assert.equal(err.code, -32602);
      return true;
    }
  );
});

// =====================================================================================
// 4. Execution Pipeline & Abort Propagation
// =====================================================================================

test("Execution: executes handler successfully and passes parameters and context", async () => {
  assert.ok(typeof ToolRegistry === "function", "ToolRegistry class must be exported");

  const registry = new ToolRegistry();
  let receivedParams = null;
  let receivedCtx = null;

  registry.register({
    name: "echo_tool",
    profile: "core",
    schema: {
      type: "object",
      properties: {
        msg: { type: "string" },
      },
    },
    handler: async (params, ctx) => {
      receivedParams = params;
      receivedCtx = ctx;
      return { echo: params.msg, tab: ctx.tabId };
    },
  });

  const ctx = createMockContext({ tabId: 777 });
  const result = await registry.execute("echo_tool", { msg: "ping" }, ctx);

  assert.deepEqual(result, { echo: "ping", tab: 777 });
  assert.equal(receivedParams.msg, "ping");
  assert.equal(receivedCtx.tabId, 777);
});

test("Execution: pre-aborted signal stops execution immediately and rejects with code -32006 (EXECUTION_ABORTED)", async () => {
  assert.ok(typeof ToolRegistry === "function", "ToolRegistry class must be exported");

  const registry = new ToolRegistry();
  let handlerInvoked = false;

  registry.register({
    name: "abortable_tool",
    profile: "core",
    handler: async () => {
      handlerInvoked = true;
      return { status: "ran" };
    },
  });

  const controller = new AbortController();
  controller.abort(); // Pre-aborted

  const ctx = createMockContext({ signal: controller.signal });

  await assert.rejects(
    async () => {
      await registry.execute("abortable_tool", {}, ctx);
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, RPC_ERRORS.EXECUTION_ABORTED);
      assert.equal(err.code, -32006);
      return true;
    }
  );

  assert.equal(handlerInvoked, false, "Handler must not run when signal is pre-aborted");
});

test("Execution: mid-flight abort interrupts long-running handler and rejects with code -32006 (EXECUTION_ABORTED)", async () => {
  assert.ok(typeof ToolRegistry === "function", "ToolRegistry class must be exported");

  const registry = new ToolRegistry();

  registry.register({
    name: "async_long_tool",
    profile: "core",
    handler: async (params, ctx) => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve({ status: "finished" });
        }, 1000);

        if (ctx.signal) {
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            const err = new RpcError(RPC_ERRORS.EXECUTION_ABORTED, "Operation aborted");
            reject(err);
          });
        }
      });
    },
  });

  const controller = new AbortController();
  const ctx = createMockContext({ signal: controller.signal });

  const executionPromise = registry.execute("async_long_tool", {}, ctx);

  // Trigger mid-flight abort after 20ms
  setTimeout(() => {
    controller.abort();
  }, 20);

  await assert.rejects(
    async () => {
      await executionPromise;
    },
    (err) => {
      assert.equal(err.code, RPC_ERRORS.EXECUTION_ABORTED);
      assert.equal(err.code, -32006);
      return true;
    }
  );
});

// =====================================================================================
// 5. Domain Distribution Matrix
// =====================================================================================

test("Domain Distribution: modules exist and export expected tool descriptors", () => {
  const domainModules = [
    { mod: actionModule, name: "action.js", expected: ["browser_click", "browser_type"] },
    {
      mod: navigateModule,
      name: "navigate.js",
      expected: ["browser_navigate", "browser_wait_for"],
    },
    { mod: inspectModule, name: "inspect.js", expected: ["browser_snapshot", "browser_find"] },
    { mod: tabsModule, name: "tabs.js", expected: ["browser_tabs"] },
    { mod: networkToolsModule, name: "network_tools.js", expected: ["get_network_request"] },
    { mod: emulateToolsModule, name: "emulate_tools.js", expected: ["browser_emulate"] },
    { mod: downloadToolsModule, name: "download_tools.js", expected: ["browser_download"] },
    {
      mod: storageToolsModule,
      name: "storage_tools.js",
      expected: ["cookies_get", "local_storage_get"],
    },
  ];

  for (const { mod, name, expected } of domainModules) {
    assert.ok(mod != null, `Module extension/tools/${name} must be created and loadable`);
    const tools =
      mod.tools ||
      mod.actionTools ||
      mod.navigateTools ||
      mod.inspectTools ||
      mod.tabsTools ||
      mod.networkTools ||
      mod.emulateTools ||
      mod.downloadTools ||
      mod.storageTools ||
      mod.default ||
      Object.values(mod).find(Array.isArray) ||
      mod;
    const toolNames = Array.isArray(tools)
      ? tools.flatMap((t) => [t.name, ...(t.aliases || [])])
      : Object.keys(tools);

    for (const exp of expected) {
      assert.ok(toolNames.includes(exp), `extension/tools/${name} must include tool '${exp}'`);
    }
  }
});

test("Domain Distribution: createDefaultRegistry instantiates and registers tools across all domains", () => {
  if (typeof createDefaultRegistry === "function") {
    const reg = createDefaultRegistry();
    assert.ok(reg instanceof ToolRegistry);
    assert.ok(reg.list().length >= 25);
    assert.ok(reg.has("browser_click"));
    assert.ok(reg.has("browser_navigate"));
    assert.ok(reg.has("browser_snapshot"));
    assert.ok(reg.has("browser_tabs"));
  }
});

// =====================================================================================
// 6. Agent Reading Budget Invariant (TC-PROTO-03)
// =====================================================================================

test("TC-PROTO-03: Consolidated core profile tool descriptions and schemas <= 20,200 characters", () => {
  const AGENT_TEXT_BUDGET = 20200;

  // Run isolated child process to inspect MCP server core registrations without keeping stdio open
  const script = `
    process.env.BROWSERCTL_MCP_PROFILE = "all";
    const mcp = await import("./mcp/index.js");
    const TOOLS = mcp.server._registeredTools;
    const CORE = mcp.TOOL_CATEGORIES?.core || [];
    let descChars = 0;
    let paramChars = 0;
    for (const name of CORE) {
      const t = TOOLS[name];
      if (!t) continue;
      descChars += (t.description || "").length;
      for (const k of Object.keys(t.inputSchema?.shape || {})) {
        paramChars += (t.inputSchema.shape[k]?.description || "").length;
      }
    }
    const src = (await import("node:fs")).readFileSync("mcp/index.js", "utf8");
    const iStart = src.indexOf("const INSTRUCTIONS = \\\`");
    const instructions = src.slice(iStart, src.indexOf("\\\`;", iStart));
    const total = descChars + paramChars + instructions.length;
    console.log(JSON.stringify({ total, descChars, paramChars, instructionsLength: instructions.length, coreCount: CORE.length }));
    process.exit(0);
  `;

  const res = spawnSync("node", ["-e", script], {
    cwd: ROOT_DIR,
    input: "",
    encoding: "utf8",
  });

  assert.equal(res.status, 0, `Script failed with error: ${res.stderr}`);

  const data = JSON.parse(res.stdout.trim());
  assert.equal(data.coreCount, 19, "Must have exactly 19 core tools registered");
  assert.equal(data.total, 13515, "Baseline reading budget invariant must match 13,515 chars");
  assert.ok(
    data.total <= AGENT_TEXT_BUDGET,
    `Core profile reading size ${data.total} exceeds ${AGENT_TEXT_BUDGET} character budget`
  );
});
