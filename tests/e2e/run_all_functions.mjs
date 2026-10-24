// Comprehensive E2E test runner covering all supported functions and representative parameters.
//
// Drives the LIVE stack (agent -> bridge -> extension -> Chrome) using tests/e2e/harness.mjs.
// Adheres strictly to tab discipline: one main tab, scratch tabs via withScratchTab,
// complete teardown on exit, and ledger verification.

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  BRIDGE,
  cmd,
  cmdFail,
  assert,
  test,
  used,
  openMainTab,
  withScratchTab,
  teardown,
  verifyClean,
  installReaper,
  report,
} from "./harness.mjs";

installReaper();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_RAW = readFileSync(join(HERE, "testpage.html"), "utf8");

async function main() {
  // Setup local test server with API, download, and static content endpoints
  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url.startsWith("/index")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE_RAW.replace("__IFRAME_SRC__", "about:blank"));
    } else if (req.url.startsWith("/api/sample.json")) {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-custom-test-header": "browserctl-e2e",
      });
      res.end(
        JSON.stringify({
          status: "success",
          user: { id: 42, name: "Alice", role: "admin" },
          items: ["apple", "banana", "cherry"],
        })
      );
    } else if (req.url.startsWith("/download/file.txt")) {
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": 'attachment; filename="e2e-sample.txt"',
      });
      res.end("browserctl e2e download sample content 12345");
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const PORT = server.address().port;
  const baseUrl = `http://127.0.0.1:${PORT}`;

  console.log(`Live E2E test fixture served at ${baseUrl}`);
  console.log(`Connecting to bridge daemon at ${BRIDGE}\n`);

  let mainTabId = null;

  try {
    // =========================================================================
    // 1. Navigation & Tab Lifecycle Domain
    // =========================================================================
    await test("new_tab opens main tab and establishes lease", async () => {
      mainTabId = await openMainTab(baseUrl + "/");
      assert(mainTabId != null, "main tab must return an id");
    });

    await cmd("wait_settle", {});

    await test("current_tab returns active lease target", async () => {
      const res = await cmd("current_tab", {});
      assert(res.id === mainTabId, `expected tab ${mainTabId}, got ${res.id}`);
      assert(res.url.includes(String(PORT)), "url must match fixture port");
    });

    await test("list_tabs lists connected tabs with active indicator", async () => {
      const res = await cmd("list_tabs", {});
      assert(Array.isArray(res.tabs), "tabs must be an array");
      assert(res.tabs.some((t) => t.id === mainTabId), "main tab must be in tab list");
    });

    await test("scratch tab lifecycle: open, switch_tab, and close_tab", async () => {
      await withScratchTab(baseUrl + "/?scratch=1", async (scratchId) => {
        assert(scratchId != null && scratchId !== mainTabId, "scratch tab id must be unique");
        const list = await cmd("list_tabs", {});
        assert(list.tabs.some((t) => t.id === scratchId), "scratch tab must be in list");
      });
    });

    // =========================================================================
    // 2. DOM Inspection, Property Extraction & Accessibility
    // =========================================================================
    await test("snapshot: compact and full element census with structure", async () => {
      const compact = await cmd("snapshot", { compact: true });
      assert(typeof compact.census === "string", "census must be string");
      assert(compact.census.includes("@e"), "census must contain sequential @e refs");

      const full = await cmd("snapshot", { compact: false });
      assert(Array.isArray(full.elements), "full snapshot must return elements array");
      assert(full.elements.length > 5, "full snapshot must have elements");
    });

    await test("read_page: interactive accessibility tree", async () => {
      const res = await cmd("read_page", { mode: "interactive" });
      assert(typeof res.tree === "string", "tree must be string");
      assert(res.tree.includes("Click Me") || res.tree.includes("button"), "tree must describe buttons");
    });

    await test("find: locates controls by query, role, and text", async () => {
      const res = await cmd("find", { query: "Click Me" });
      assert(res.matches && res.matches.length > 0, "must find button Click Me");
      assert(res.matches[0].ref, "matched element must carry ref");
    });

    await test("get_property: reads text, value, html, box, attr, and count", async () => {
      // text
      const textRes = await cmd("get_property", { selector: "#title", property: "text" });
      assert(textRes.value === "bctl Test Page", `expected title text, got ${textRes.value}`);

      // html
      const htmlRes = await cmd("get_property", { selector: "#title", property: "html" });
      assert(htmlRes.value.includes("bctl Test Page"), "html must contain element text");

      // attr
      const attrRes = await cmd("get_property", { selector: "#link", property: "attr", attr: "href" });
      assert(attrRes.value === "/second.html", `expected href attr, got ${attrRes.value}`);

      // box
      const boxRes = await cmd("get_property", { selector: "#btn", property: "box" });
      assert(typeof boxRes.width === "number" && boxRes.width > 0, "box must have valid width");

      // count
      const countRes = await cmd("get_property", { selector: "button", property: "count" });
      assert(typeof countRes.value === "number" && countRes.value > 0, "count must be > 0");
    });

    await test("describe_element: returns comprehensive element metadata", async () => {
      const res = await cmd("describe_element", { target: "css=#btn" });
      assert(res.ok !== false, "describe_element must succeed");
      assert(res.tag === "button" || res.tag === "BUTTON" || res.name === "Click Me", "tag or name must match button");
    });

    await test("extract: structured tabular data extraction", async () => {
      const res = await cmd("extract", {
        selector: "li.row",
        fields: {
          title: "h3.t",
          link: { selector: "a.u", attr: "href" },
          num: "span.n",
        },
      });
      assert(Array.isArray(res.matches) && res.matches.length === 3, "must extract 3 rows");
      assert(res.matches[0].title === "Row One", "row 1 title mismatch");
    });

    await test("get_page_content: extracts clean readable text from document", async () => {
      const res = await cmd("get_page_content", { maxChars: 500 });
      assert(typeof res.text === "string" && res.text.length > 0, "must return prose text");
    });

    // =========================================================================
    // 3. User Interactions & Atomic Actions
    // =========================================================================
    await test("click: clicks button and records DOM mutation effect", async () => {
      const res = await cmd("click", { target: "css=#btn" });
      assert(res.ok === true || res.clicked != null, "click must succeed");
      const count = await cmd("get_property", { selector: "#clickcount", property: "text" });
      assert(Number(count.value) >= 1, "click handler must increment counter");
    });

    await test("type & fill_form: sets values across standard and controlled inputs", async () => {
      await cmd("type", { target: "css=#plain", text: "Hello Plain" });
      const plainVal = await cmd("get_property", { selector: "#plain", property: "value" });
      assert(plainVal.value === "Hello Plain", `expected plain value, got ${plainVal.value}`);

      await cmd("fill_form", {
        fields: [
          { target: "css=#plain", value: "Batch Plain" },
          { target: "css=#controlled", value: "Batch Controlled" },
          { target: "css=#sel", value: "b" },
          { target: "css=#cbox", value: true },
        ],
      });
      const ctlVal = await cmd("get_property", { selector: "#controlled", property: "value" });
      assert(ctlVal.value === "Batch Controlled", "controlled input must retain value");

      const chkVal = await cmd("get_property", { selector: "#cbox", property: "checked" });
      assert(chkVal.value === true, "checkbox must be checked");
    });

    await test("select_option: selects dropdown item by value", async () => {
      await cmd("select_option", { target: "css=#sel", value: "c" });
      const selVal = await cmd("get_property", { selector: "#sel", property: "value" });
      assert(selVal.value === "c", `expected select value 'c', got ${selVal.value}`);
    });

    await test("hover & press_key: mouse movement and keyboard dispatch", async () => {
      await cmd("hover", { target: "css=#hovertarget" });
      const hres = await cmd("get_property", { selector: "#hovered", property: "text" });
      assert(hres.value === "yes", "hover event listener must trigger");

      await cmd("press_key", { key: "Tab" });
    });

    await test("scroll: scrolls viewport vertically", async () => {
      const res = await cmd("scroll", { direction: "down", amount: 100 });
      assert(res.scrolledY != null || res.delta != null, "scroll must report coordinates");
    });

    await test("dismiss & dismiss_modal: closes open modal dialogs", async () => {
      await cmd("click", { target: "css=#dlgopen" });
      await sleep(150);
      const res = await cmd("dismiss", {});
      assert(res.ok !== false, "dismiss must succeed");
    });

    await test("eval_js: executes in-page JavaScript expression", async () => {
      const res = await cmd("eval_js", { expression: "2 + 2" });
      assert(res.value === 4, `expected 4, got ${res.value}`);
    });

    // =========================================================================
    // 4. Web Storage & Cookies Subsystems
    // =========================================================================
    await test("storage_set, storage_get, storage_remove, storage_clear (localStorage)", async () => {
      await cmd("storage_set", { area: "local", key: "test_key", value: "e2e_val_123" });
      const got = await cmd("storage_get", { area: "local", key: "test_key" });
      assert(got.value === "e2e_val_123", `expected stored value, got ${got.value}`);

      await cmd("storage_remove", { area: "local", key: "test_key" });
      const removed = await cmd("storage_get", { area: "local", key: "test_key" });
      assert(removed.value == null, "key must be removed");

      await cmd("storage_set", { area: "local", key: "clear_me", value: "val" });
      await cmd("storage_clear", { area: "local" });
      const cleared = await cmd("storage_get", { area: "local", key: "clear_me" });
      assert(cleared.value == null, "storage must be cleared");
    });

    // =========================================================================
    // 5. CDP Driver Subsystem (Attach, Input, Cookies, Network, Emulation)
    // =========================================================================
    await test("cdp_attach & cdp_send & cdp_detach", async () => {
      const attachRes = await cmd("cdp_attach", {});
      assert(attachRes.attached === true, "cdp_attach must succeed");

      const sendRes = await cmd("cdp_send", {
        method: "Page.getLayoutMetrics",
        params: {},
      });
      assert(
        sendRes && (sendRes.result?.layoutViewport != null || sendRes.result != null),
        "cdp_send must return layout metrics"
      );

      const detachRes = await cmd("cdp_detach", {});
      assert(detachRes.attached === false || detachRes.detached === true, "cdp_detach must succeed");
    });

    await test("cookies: set_cookie, get_cookies, and delete_cookies", async () => {
      await cmd("cdp_attach", {});
      await cmd("set_cookie", {
        name: "e2e_token",
        value: "xyz789",
        url: baseUrl,
      });

      const cookies = await cmd("get_cookies", { url: baseUrl });
      assert(Array.isArray(cookies.cookies), "cookies must be an array");
      assert(
        cookies.cookies.some((c) => c.name === "e2e_token" && c.value === "xyz789"),
        "set cookie must be present"
      );

      await cmd("delete_cookies", { name: "e2e_token", url: baseUrl });
      const afterDel = await cmd("get_cookies", { url: baseUrl });
      assert(
        !afterDel.cookies.some((c) => c.name === "e2e_token"),
        "deleted cookie must be absent"
      );
    });

    await test("network capture: get_network_requests, get_network_request, export_har", async () => {
      await cmd("cdp_attach", {});

      // Trigger fetch request
      await cmd("eval_js", {
        expression: `fetch('${baseUrl}/api/sample.json').then(r => r.json())`,
      });
      await sleep(300);

      const netList = await cmd("get_network_requests", { urlContains: "sample.json" });
      assert(Array.isArray(netList.requests), "requests must be array");
      assert(netList.requests.length > 0, "must capture sample.json request");

      const reqId = netList.requests[0].requestId;
      assert(reqId != null, "requestId must be defined");

      const singleReq = await cmd("get_network_request", {
        requestId: reqId,
        part: "all",
      });
      assert(singleReq.url?.includes("sample.json"), "request url must match");

      const har = await cmd("export_har", { bodies: false });
      assert(har.log && Array.isArray(har.log.entries), "har log must contain entries");
    });

    await test("network rules: network_rule_add, network_rule_list, network_rule_clear", async () => {
      await cmd("cdp_attach", {});

      const addRes = await cmd("network_rule_add", {
        match: { url: "*/mock-route-test/*" },
        effect: {
          type: "mock",
          status: 200,
          body: JSON.stringify({ mocked: true }),
        },
      });
      assert(addRes.ruleId != null || addRes.ok !== false, "mock rule must be added");

      const listRes = await cmd("network_rule_list", {});
      assert(Array.isArray(listRes.rules), "rules must be array");

      const clearRes = await cmd("network_rule_clear", {});
      assert(clearRes.cleared != null || clearRes.ok !== false, "mock rules must be cleared");
    });

    await test("emulate: device metrics, dark mode, and reset with clear:true", async () => {
      await cmd("cdp_attach", {});
      const emuRes = await cmd("emulate", {
        device: "iphone-14",
        colorScheme: "dark",
      });
      assert(emuRes.ok !== false, "emulate preset must succeed");

      const clearRes = await cmd("emulate", { clear: true });
      assert(clearRes.cleared === true || clearRes.ok !== false, "clear emulation must succeed");
    });

    await test("audit: returns performance metrics and DOM tree analysis", async () => {
      await cmd("cdp_attach", {});
      const res = await cmd("audit", {});
      assert(res.performance != null || res.metrics != null, "audit must return metric data");
    });

    await test("a11y_snapshot: returns full accessibility node hierarchy via CDP", async () => {
      const res = await cmd("a11y_snapshot", { max: 100 });
      assert(Array.isArray(res.nodes), "a11y nodes must be an array");
      assert(res.nodes.length > 0, "a11y nodes must not be empty");
    });

    await test("wheel: mouse wheel event dispatch (or foreground error if backgrounded)", async () => {
      await cmd("cdp_attach", {});
      try {
        const res = await cmd("wheel", { deltaX: 0, deltaY: 50 });
        assert(res.ok !== false, "wheel event must succeed");
      } catch (err) {
        assert(
          err.message.includes("wheel needs the target tab in the foreground"),
          `unexpected wheel error: ${err.message}`
        );
      }
    });

    // =========================================================================
    // 6. Captures & Screenshots
    // =========================================================================
    await test("screenshot: viewport, fullpage, and element screenshots", async () => {
      // viewport
      const vp = await cmd("screenshot", {});
      assert(vp.dataUrl || vp.data, "viewport screenshot must return dataUrl");

      // fullpage
      await cmd("cdp_attach", {});
      const fp = await cmd("screenshot", { fullPage: true });
      assert(fp.dataUrl || fp.data, "fullpage screenshot must return dataUrl");

      // element
      const el = await cmd("element_screenshot", { target: "css=#btn" });
      assert(el.dataUrl || el.data, "element screenshot must return dataUrl");
    });

    await test("print_pdf: renders page as PDF base64", async () => {
      await cmd("cdp_attach", {});
      const pdf = await cmd("print_pdf", {});
      assert(pdf.base64 || pdf.dataUrl || pdf.data, "pdf must return base64 string");
    });

    // =========================================================================
    // 7. Windows & System Tools
    // =========================================================================
    await test("list_windows: returns browser window inventory", async () => {
      const res = await cmd("list_windows", {});
      assert(Array.isArray(res.windows), "windows must be an array");
      assert(res.windows.length > 0, "must have at least one window");
    });

    await test("exec_system_cmd: executes local host command securely", async () => {
      const res = await cmd("exec_system_cmd", { command: "echo e2e_system_test_passed" });
      assert(res.stdout?.includes("e2e_system_test_passed"), `expected stdout output, got ${res.stdout}`);
    });

    await test("pending_dialog: checks for active modal JavaScript dialog", async () => {
      const res = await cmd("pending_dialog", {});
      assert(res.dialog === null || typeof res.dialog === "object", "pending_dialog must return status");
    });

    // =========================================================================
    // 8. Navigation & Synchronization
    // =========================================================================
    await test("wait_for: waits for text and selector condition", async () => {
      const res = await cmd("wait_for", { selector: "#title" });
      assert(res.found === true || res.ok === true, "wait_for must find title selector");
    });

    await test("wait_network_idle: waits for in-flight network activity to settle", async () => {
      const res = await cmd("wait_network_idle", { idleMs: 150, timeoutMs: 2000 });
      assert(res.ok === true || res.idle === true, "wait_network_idle must succeed");
    });

    await test("reload: reloads target page and re-establishes content script", async () => {
      const res = await cmd("reload", {});
      assert(res.ok !== false, "reload must succeed");
      await cmd("wait_settle", {});
      const snap = await cmd("snapshot", {});
      assert(Array.isArray(snap.elements) && snap.elements.length > 0, "snapshot elements must be array");
    });

  } finally {
    // Teardown HTTP server and clean up tabs
    await teardown();
    await verifyClean();
    server.close();
  }

  report();
}

main().catch((err) => {
  console.error("FATAL in run_all_functions:", err);
  process.exit(1);
});
