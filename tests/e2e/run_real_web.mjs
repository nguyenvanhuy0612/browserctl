// Real-World Web Comprehensive E2E Test Suite
// Executes browserctl commands directly against real public websites across diverse architectures:
// 1. Wikipedia (Semantic MediaWiki, search suggestions, table extraction)
// 2. Hacker News (Table-driven lightweight layout, story extraction)
// 3. GitHub (Complex web components, responsive emulation, network inspection)
// 4. MDN Web Docs (Rich technical prose, a11y tree, performance audit)
// 5. Facebook (Obfuscated React DOM, event listeners, dynamic overlays)
// 6. YouTube (Shadow DOM, web components, video search, Studio upload selector)
// 7. HTTPBin (Multi-input form automation: text, radio, checkbox, select)

import { join, dirname } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { BRIDGE, cmd, assert, test, openMainTab, withScratchTab, teardown, report } from "./harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\n======================================================`);
  console.log(`Starting Real-World Web E2E Test Suite against bridge ${BRIDGE}`);
  console.log(`======================================================\n`);

  let mainTabId = null;

  try {
    // -------------------------------------------------------------------------
    // Scenario 1: Wikipedia — Navigation, Search, Extraction, and PDF
    // -------------------------------------------------------------------------
    console.log("--- Scenario 1: Wikipedia (Semantic MediaWiki) ---");

    await test("Wikipedia: Navigate to English home and wait settle", async () => {
      mainTabId = await openMainTab("https://en.wikipedia.org/wiki/Main_Page");
      await cmd("wait_settle", { timeoutMs: 10000 });
      const cur = await cmd("current_tab", {});
      assert(cur.url.includes("wikipedia.org"), `URL mismatch: ${cur.url}`);
    });

    await test("Wikipedia: Snapshot and element census", async () => {
      const snap = await cmd("snapshot", { compact: true });
      assert(snap.census && snap.census.includes("Wikipedia"), "snapshot must contain Wikipedia header");
      assert(snap.census.includes("@e"), "must report numbered element refs");
    });

    await test("Wikipedia: Search suggestion lookup via type", async () => {
      // Find search input
      const searchRes = await cmd("type", {
        target: "input[name='search']",
        text: "Ada Lovelace",
      });
      assert(typeof searchRes.typed === "string", "type must succeed");
      await sleep(500); // Allow suggestion dropdown to fetch
    });

    await test("Wikipedia: Navigate to article and extract infobox", async () => {
      await cmd("press_key", { key: "Enter" });
      await cmd("wait_settle", { timeoutMs: 12000 });
      const snap = await cmd("snapshot", { scope: "viewport", compact: true });
      assert(snap.census.toLowerCase().includes("lovelace"), "must land on Ada Lovelace article");

      // Extract section headings
      const headings = await cmd("extract", {
        selector: "h2",
        fields: { title: "text" },
      });
      assert(Array.isArray(headings.matches) && headings.matches.length > 0, "must extract article headings");
    });

    await test("Wikipedia: Print article to PDF base64", async () => {
      await cmd("cdp_attach", {});
      const pdf = await cmd("print_pdf", {});
      assert(typeof pdf.base64 === "string" && pdf.base64.length > 1000, "print_pdf must produce valid base64");
    });

    // -------------------------------------------------------------------------
    // Scenario 2: Hacker News — Minimal Table DOM & Tabular Extraction
    // -------------------------------------------------------------------------
    console.log("\n--- Scenario 2: Hacker News (Table Layout & Data Extraction) ---");

    await test("Hacker News: Navigate and extract top stories", async () => {
      await cmd("navigate", { url: "https://news.ycombinator.com" });
      await cmd("wait_settle", { timeoutMs: 8000 });

      const stories = await cmd("extract", {
        selector: "tr.athing",
        fields: {
          title: ".titleline > a",
          url: { selector: ".titleline > a", attr: "href" },
        },
        max: 5,
      });
      assert(Array.isArray(stories.matches) && stories.matches.length >= 3, "must extract at least 3 stories");
      assert(stories.matches[0].title, "story must have title");
      assert(stories.matches[0].url?.startsWith("http"), "story must have absolute link");
    });

    await test("Hacker News: Find navigation links and inspect properties", async () => {
      const findRes = await cmd("find", { query: "new" });
      assert(findRes.matches && findRes.matches.length > 0, "find must locate 'new' link");

      const prop = await cmd("get_property", {
        selector: "a[href='newest']",
        property: "attr",
        attribute: "href",
      });
      assert(prop.value === "newest", `attribute must equal 'newest', got ${prop.value}`);
    });

    // -------------------------------------------------------------------------
    // Scenario 3: GitHub — Complex Components, Mobile Emulation & Network
    // -------------------------------------------------------------------------
    console.log("\n--- Scenario 3: GitHub (Web Components, Network, Emulation) ---");

    await test("GitHub: Navigate, attach CDP, and capture network activity", async () => {
      await cmd("navigate", { url: "https://github.com" });
      await cmd("cdp_attach", {});
      await cmd("wait_settle", { timeoutMs: 12000 });

      const net = await cmd("get_network_requests", {});
      assert(Array.isArray(net.requests) && net.requests.length > 0, "network requests must be logged");

      const har = await cmd("export_har", { bodies: false });
      assert(har.log && Array.isArray(har.log.entries), "har log must contain network entries");
    });

    await test("GitHub: Mobile device emulation (iPhone 14) and viewport screenshot", async () => {
      const emu = await cmd("emulate", { device: "iphone-14", colorScheme: "dark" });
      assert(emu.ok !== false, "emulate must succeed");

      const ss = await cmd("screenshot", {});
      assert(/^data:image\/(jpeg|png);base64,/.test(ss.dataUrl), "screenshot must return data URL");

      // Reset emulation
      await cmd("emulate", { clear: true });
    });

    // -------------------------------------------------------------------------
    // Scenario 4: MDN Web Docs — Semantic Prose, Accessibility & Audit
    // -------------------------------------------------------------------------
    console.log("\n--- Scenario 4: MDN Web Docs (Prose, A11y, Performance Audit) ---");

    await test("MDN: Navigate to HTML documentation", async () => {
      await cmd("navigate", { url: "https://developer.mozilla.org/en-US/docs/Web/HTML" });
      await cmd("wait_settle", { timeoutMs: 12000 });
      const title = await cmd("get_property", { selector: "h1", property: "text" });
      assert(title.value?.toLowerCase().includes("html"), `title must mention HTML, got ${title.value}`);
    });

    await test("MDN: Extract clean readable document text via get_page_content", async () => {
      const content = await cmd("get_page_content", {});
      assert(typeof content.text === "string" && content.text.length > 200, "page content must return long prose");
    });

    await test("MDN: Accessibility tree inspection via a11y_snapshot", async () => {
      const a11y = await cmd("a11y_snapshot", { max: 50 });
      assert(Array.isArray(a11y.nodes) && a11y.nodes.length > 0, "a11y snapshot must return node hierarchy");
    });

    await test("MDN: Performance and DOM structure audit", async () => {
      await cmd("cdp_attach", {});
      const auditRes = await cmd("audit", {});
      assert(auditRes.performance != null, "audit must return performance metrics");
    });

    // -------------------------------------------------------------------------
    // Scenario 5: HTTPBin — Real Multi-Input HTML Form Submission
    // -------------------------------------------------------------------------
    console.log("\n--- Scenario 5: HTTPBin (Form Fill, Controls, Multi-Type Inputs) ---");

    await test("HTTPBin: Navigate to form page and fill complex controls", async () => {
      await cmd("navigate", { url: "https://httpbin.org/forms/post" });
      await cmd("wait_settle", { timeoutMs: 8000 });

      // Batch fill inputs, radio, checkboxes
      await cmd("fill_form", {
        fields: [
          { target: "input[name='custname']", value: "QA Automation Test" },
          { target: "input[name='custtel']", value: "0123456789" },
          { target: "input[name='custemail']", value: "qa@example.com" },
          { target: "input[name='size'][value='medium']", value: true },
          { target: "input[name='topping'][value='bacon']", value: true },
          { target: "input[name='topping'][value='cheese']", value: true },
          { target: "textarea[name='comments']", value: "Automated test delivery via browserctl" },
        ],
      });

      // Verify fields held their values
      const nameVal = await cmd("get_property", { selector: "input[name='custname']", property: "value" });
      assert(nameVal.value === "QA Automation Test", `unexpected name: ${nameVal.value}`);

      const baconVal = await cmd("get_property", {
        selector: "input[name='topping'][value='bacon']",
        property: "checked",
      });
      assert(baconVal.value === true, "bacon checkbox must be checked");
    });

    await test("HTTPBin: Submit form and verify server POST response", async () => {
      await cmd("click", { target: "button" });
      await cmd("wait_settle", { timeoutMs: 8000 });

      const bodyText = await cmd("get_page_content", {});
      assert(bodyText.text.includes("QA Automation Test"), "response must contain submitted customer name");
      assert(bodyText.text.includes("bacon"), "response must contain submitted topping");
    });

    // -------------------------------------------------------------------------
    // Scenario 6: Facebook — React Virtual DOM & Overlays
    // -------------------------------------------------------------------------
    console.log("\n--- Scenario 6: Facebook (Complex React DOM & Overlays) ---");

    await test("Facebook: Navigate to login/feed portal and snapshot elements", async () => {
      await cmd("navigate", { url: "https://www.facebook.com" });
      await cmd("wait_settle", { timeoutMs: 10000 });

      const snap = await cmd("snapshot", { compact: true });
      assert(snap.census && snap.census.toLowerCase().includes("facebook"), "snapshot must contain Facebook brand");
      assert(snap.census.includes("@e"), "Facebook must report interactive controls with refs");
    });

    await test("Facebook: Type query safely and verify controlled input handlers", async () => {
      const targetInput = "input[placeholder*='Search Facebook'], input[type='search'], input[name='email']";
      const typeRes = await cmd("type", { target: targetInput, text: "Technology news" });
      assert(typeof typeRes.typed === "string", "type must succeed on Facebook input");

      const desc = await cmd("describe_element", { target: targetInput });
      assert(desc.tag === "input", "control must be an input");
    });

    // -------------------------------------------------------------------------
    // Scenario 7: YouTube — Web Components & Studio Upload Flow
    // -------------------------------------------------------------------------
    console.log("\n--- Scenario 7: YouTube (Web Components, Shadow DOM, Search) ---");

    await test("YouTube: Navigate to home, search, and inspect video items", async () => {
      await cmd("navigate", { url: "https://www.youtube.com" });
      await cmd("wait_settle", { timeoutMs: 12000 });

      // Find search bar
      const searchRes = await cmd("type", { target: "input[name='search_query']", text: "Software Testing E2E" });
      assert(typeof searchRes.typed === "string", "type into search query must succeed");

      await cmd("press_key", { key: "Enter" });
      await cmd("wait_settle", { timeoutMs: 12000 });

      const snap = await cmd("snapshot", { scope: "viewport", compact: true });
      assert(snap.census.includes("@e"), "search results must have numbered element refs");
    });

    await test("YouTube Studio: Upload dialog file attachment attempt", async () => {
      await cmd("navigate", { url: "https://studio.youtube.com/channel/UCAkRJASth1nUkx534TIDV6A/videos/upload" });
      await cmd("wait_settle", { timeoutMs: 15000 });

      const snap = await cmd("snapshot", { compact: true });
      if (snap.census.includes("Chọn tệp") || snap.census.includes("Select files")) {
        const sampleVideo = join(process.cwd(), "temp", "sample_test_video.mp4");
        if (!existsSync(sampleVideo)) {
          mkdirSync(dirname(sampleVideo), { recursive: true });
          writeFileSync(sampleVideo, Buffer.alloc(1024));
        }
        const upRes = await cmd("upload", { file: sampleVideo });
        assert(upRes.attached === true || upRes.ok !== false, "file must attach to hidden input");

        await sleep(1500);
        // Safely dismiss dialog without publishing
        await cmd("dismiss", {});
      } else {
        console.log("  (YouTube Studio upload dialog skipped: authentication redirect)");
      }
    });

  } finally {
    console.log("\nCleaning up main test tab...");
    await teardown();
  }

  report();
}

main().catch((err) => {
  console.error("FATAL real-world web test error:", err);
  process.exit(1);
});
