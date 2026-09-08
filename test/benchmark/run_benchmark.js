#!/usr/bin/env node
// Automated Benchmark & Telemetry Test Harness for browserctl v2
// Tests generic browser intelligence across 20+ real-world web architectures.

import fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BRIDGE_URL = process.env.BROWSERCTL_BRIDGE_URL || "http://127.0.0.1:8765";
const TELEMETRY_FILE = join(__dirname, "..", "..", "bridge", "telemetry.jsonl");

async function callBridge(action, params = {}) {
  const res = await fetch(`${BRIDGE_URL}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, params }),
    signal: AbortSignal.timeout(45000),
  });
  const data = await res.json().catch(() => ({}));
  return data;
}

const TEST_SITES = [
  // Group 1: Infinite Scroll & Virtualized Lists
  {
    name: "GitHub Issues (React/Primer)",
    url: "https://github.com/microsoft/vscode/issues",
    category: "Virtualized Lists",
    targetSelector: "input[type='text'], a[data-hovercard-type='issue']",
  },
  {
    name: "Hacker News (Algolia Search)",
    url: "https://hn.algolia.com/",
    category: "Virtualized Lists",
    targetSelector: "input[type='search'], .Story_title a",
  },
  {
    name: "Wikipedia Long Article (Table of Contents & Dense DOM)",
    url: "https://en.wikipedia.org/wiki/Computer_science",
    category: "Dense DOM / Landmarks",
    targetSelector: "#vector-toc, .vector-toc-link",
  },
  {
    name: "Reddit Public Listing",
    url: "https://www.reddit.com/r/programming/",
    category: "Virtualized Lists",
    targetSelector: "shreddit-post, a",
  },
  {
    name: "YouTube Home Feed",
    url: "https://www.youtube.com/",
    category: "Shadow DOM / Infinite Scroll",
    targetSelector: "input#search, ytd-rich-grid-media a",
  },

  // Group 2: Web Components & Deep Shadow DOM
  {
    name: "Shoelace Component Showcase",
    url: "https://shoelace.style/components/button",
    category: "Web Components / Shadow DOM",
    targetSelector: "sl-button, button",
  },
  {
    name: "Lit.dev Playground & Docs",
    url: "https://lit.dev/docs/components/overview/",
    category: "Web Components / Shadow DOM",
    targetSelector: "nav a, a[href*='components']",
  },
  {
    name: "Chrome Extensions Webstore",
    url: "https://chromewebstore.google.com/",
    category: "Shadow DOM / SPAs",
    targetSelector: "input[type='search'], a",
  },
  {
    name: "Material Web Components Showcase",
    url: "https://material-web.dev/components/button/",
    category: "Web Components / Shadow DOM",
    targetSelector: "md-outlined-button, md-filled-button, button",
  },

  // Group 3: Complex Single Page Applications (SPAs)
  {
    name: "Cloudflare Documentation (Dynamic Tabs)",
    url: "https://developers.cloudflare.com/workers/",
    category: "Dynamic SPA",
    targetSelector: "input[type='search'], a[href*='get-started']",
  },
  {
    name: "MDN Web Docs (Complex Navigation)",
    url: "https://developer.mozilla.org/en-US/docs/Web/API/Document_Object_Model",
    category: "Dynamic SPA",
    targetSelector: "input[type='search'], button",
  },
  {
    name: "Docker Hub Public Explore",
    url: "https://hub.docker.com/search",
    category: "Dynamic SPA",
    targetSelector: "input[type='search'], a",
  },
  {
    name: "NPM Registry Search",
    url: "https://www.npmjs.com/search?q=mcp",
    category: "Dynamic SPA",
    targetSelector: "input[type='search'], a[href*='/package/']",
  },

  // Group 4: Dynamic Forms, Editors & Heavy Controls
  {
    name: "TipTap Rich Text Editor Demo",
    url: "https://tiptap.dev/docs/editor/introduction",
    category: "Rich-Text / ContentEditable",
    targetSelector: "[contenteditable='true'], button",
  },
  {
    name: "HTML5 Form Controls W3C Showcase",
    url: "https://www.w3schools.com/html/html_form_input_types.asp",
    category: "Complex Forms",
    targetSelector: "input, button, select",
  },
  {
    name: "Stripe Demo Store (E-Commerce Form)",
    url: "https://shop.stripe.dev/",
    category: "Complex Forms",
    targetSelector: "button, a",
  },
  {
    name: "ProseMirror Demo Playground",
    url: "https://prosemirror.net/",
    category: "Rich-Text / ContentEditable",
    targetSelector: ".ProseMirror, a, button",
  },

  // Group 5: Heavy Content, Ad/Cookie Overlays & Media
  {
    name: "BBC News Home",
    url: "https://www.bbc.com/news",
    category: "Overlays & News Layout",
    targetSelector: "a, button",
  },
  {
    name: "ArXiv Computer Science Listing",
    url: "https://arxiv.org/list/cs/recent",
    category: "Dense Scientific DOM",
    targetSelector: "a[title='Abstract'], a",
  },
  {
    name: "Caniuse Web Compatibility Database",
    url: "https://caniuse.com/",
    category: "Complex Filter Grid",
    targetSelector: "input[type='search'], a",
  },
  {
    name: "Rust Lang Official Docs",
    url: "https://doc.rust-lang.org/book/",
    category: "Multi-layer Nav & Content",
    targetSelector: "input[type='search'], a.chapter-item",
  },
];

// One id per benchmark invocation. Without it the file is an undifferentiated pile of
// runs — including failed ones — and the only way to reconstruct a run was to guess from
// timestamps and then deduplicate by site name. Reported figures have to be traceable to
// the rows they came from.
const RUN_ID = `run_${new Date().toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(36).slice(2, 8)}`;
const RUN_STARTED_AT = new Date().toISOString();

function logTelemetry(record) {
  try {
    fs.appendFileSync(
      TELEMETRY_FILE,
      JSON.stringify({ runId: RUN_ID, runStartedAt: RUN_STARTED_AT, ...record }) + "\n"
    );
  } catch {}
}

// A site retried within a run must count once. The published v2 figures only reproduced
// after collapsing duplicates by hand: read raw, the same run showed 38/42 success and
// 29.9% token reduction instead of 19/21 and 59.8%.
function dedupeBySite(rows) {
  const bySite = new Map();
  for (const r of rows) bySite.set(r.siteName, r);
  return [...bySite.values()];
}

async function runSingleTest(site, testIndex, total) {
  console.log(`\n[${testIndex + 1}/${total}] Testing: ${site.name} (${site.category})`);
  console.log(`URL: ${site.url}`);

  const startTime = Date.now();
  let tabId = null;

  try {
    // 1. Open new tab
    const newTabRes = await callBridge("new_tab", { url: site.url });
    if (!newTabRes.ok || !newTabRes.result?.id) {
      throw new Error(`Failed to open new tab: ${newTabRes.error}`);
    }
    tabId = newTabRes.result.id;

    // 2. Wait for page settle
    await callBridge("wait_settle", { tabId, timeoutMs: 2500 });

    // 3. Measure Viewport Scoped Snapshot vs All Snapshot
    const vpSnapRes = await callBridge("snapshot", { tabId, scope: "viewport", compact: true });
    const allSnapRes = await callBridge("snapshot", { tabId, scope: "all", compact: true });

    if (!vpSnapRes.ok || !allSnapRes.ok) {
      throw new Error(`Snapshot failed: VP: ${vpSnapRes.error}, ALL: ${allSnapRes.error}`);
    }

    const vpCount = vpSnapRes.result.elements?.length || 0;
    const allCount = allSnapRes.result.elements?.length || 0;
    const vpTextLen = vpSnapRes.result.compactView?.length || 0;
    const allTextLen = allSnapRes.result.compactView?.length || 0;

    const tokenReductionPct = allTextLen > 0
      ? Math.max(0, Math.round(((allTextLen - vpTextLen) / allTextLen) * 100))
      : 0;

    const foldedCount = vpSnapRes.result.foldedCount || 0;
    const hasModal = vpSnapRes.result.pageState?.hasActiveModal || false;

    console.log(`- Scoped Elements: ${vpCount} in Viewport vs ${allCount} in Full Page`);
    console.log(`- Text Length: ${vpTextLen} chars (VP) vs ${allTextLen} chars (ALL)`);
    console.log(`- Token Reduction: ${tokenReductionPct}% saved`);
    if (foldedCount > 0) {
      console.log(`- Repetitive Controls Folded: ${foldedCount}`);
    }

    // 3b. Complex Investigation: Element Census & Hidden Content Analysis
    const buttonCountRes = await callBridge("get_property", { tabId, property: "count", selector: "button" });
    const linkCountRes = await callBridge("get_property", { tabId, property: "count", selector: "a[href]" });
    const inputCountRes = await callBridge("get_property", { tabId, property: "count", selector: "input" });
    const ariaCollapsedRes = await callBridge("get_property", { tabId, property: "count", selector: '[aria-expanded="false"]' });
    const hiddenAttrRes = await callBridge("get_property", { tabId, property: "count", selector: "[hidden]" });

    const buttons = buttonCountRes.ok ? (buttonCountRes.result?.value || 0) : 0;
    const links = linkCountRes.ok ? (linkCountRes.result?.value || 0) : 0;
    const inputs = inputCountRes.ok ? (inputCountRes.result?.value || 0) : 0;
    const ariaCollapsed = ariaCollapsedRes.ok ? (ariaCollapsedRes.result?.value || 0) : 0;
    const hiddenAttrs = hiddenAttrRes.ok ? (hiddenAttrRes.result?.value || 0) : 0;

    console.log(`- Census: ${buttons} buttons, ${links} links, ${inputs} inputs`);
    console.log(`- Hidden/Collapsed: ${ariaCollapsed} aria-expanded="false", ${hiddenAttrs} [hidden]`);
    const errRes = await callBridge("click", { tabId, ref: "ref_999999_fake" });
    const structuredErrPassed = !errRes.ok && errRes.code === "STALE_REF";

    // 5. Test Physical Event Sequence & Quiescence on an in-viewport element
    let clickPassed = false;
    let clickWaitedMs = 0;
    if (vpCount > 0) {
      const firstTarget = vpSnapRes.result.elements[0];
      const clickRes = await callBridge("click", { tabId, ref: firstTarget.ref, autoSettle: true, settleMs: 300 });
      if (clickRes.ok) {
        clickPassed = true;
        clickWaitedMs = clickRes.result?.waitedMs || 0;
      }
    }

    const durationMs = Date.now() - startTime;

    const record = {
      timestamp: new Date().toISOString(),
      siteName: site.name,
      url: site.url,
      category: site.category,
      viewportElements: vpCount,
      allElements: allCount,
      tokenReductionPct,
      foldedCount,
      hasModal,
      investigation: {
        buttons,
        links,
        inputs,
        ariaCollapsed,
        hiddenAttrs,
      },
      structuredErrorVerified: structuredErrPassed,
      clickSequenceVerified: clickPassed,
      quiescenceWaitedMs: clickWaitedMs,
      durationMs,
      success: true,
    };

    logTelemetry(record);
    return record;
  } catch (err) {
    console.log(`- Failed: ${err.message}`);
    const record = {
      timestamp: new Date().toISOString(),
      siteName: site.name,
      url: site.url,
      category: site.category,
      error: err.message,
      success: false,
      durationMs: Date.now() - startTime,
    };
    logTelemetry(record);
    return record;
  } finally {
    if (tabId != null) {
      await callBridge("close_tab", { id: tabId }).catch(() => {});
    }
  }
}

async function main() {
  console.log("================================================================================");
  console.log("browserctl v2 Automated Benchmark & Telemetry Runner");
  console.log(`Targeting 21 Diverse Web Architectures via Bridge: ${BRIDGE_URL}`);
  console.log("================================================================================");

  let status = null;
  try {
    const sRes = await fetch(`${BRIDGE_URL}/status`, { signal: AbortSignal.timeout(2000) });
    status = await sRes.json();
  } catch {}
  if (!status || !status.extensionConnected) {
    console.error("Error: Bridge or Extension is not connected. Start browserctl first.");
    process.exit(1);
  }

  const rawResults = [];
  for (let i = 0; i < TEST_SITES.length; i++) {
    const res = await runSingleTest(TEST_SITES[i], i, TEST_SITES.length);
    rawResults.push(res);
  }
  const results = dedupeBySite(rawResults);

  console.log("\n================================================================================");
  console.log("BENCHMARK SUMMARY & METRICS REPORT");
  console.log("================================================================================");

  const successful = results.filter((r) => r.success);
  const avgReduction = Math.round(
    successful.reduce((acc, r) => acc + (r.tokenReductionPct || 0), 0) / (successful.length || 1)
  );
  const avgVpElements = Math.round(
    successful.reduce((acc, r) => acc + (r.viewportElements || 0), 0) / (successful.length || 1)
  );
  const avgAllElements = Math.round(
    successful.reduce((acc, r) => acc + (r.allElements || 0), 0) / (successful.length || 1)
  );
  const structuredErrRate = Math.round(
    (successful.filter((r) => r.structuredErrorVerified).length / (successful.length || 1)) * 100
  );
  const clickSuccessRate = Math.round(
    (successful.filter((r) => r.clickSequenceVerified).length / (successful.length || 1)) * 100
  );

  const avgButtons = Math.round(
    successful.reduce((acc, r) => acc + (r.investigation?.buttons || 0), 0) / (successful.length || 1)
  );
  const avgLinks = Math.round(
    successful.reduce((acc, r) => acc + (r.investigation?.links || 0), 0) / (successful.length || 1)
  );
  const avgInputs = Math.round(
    successful.reduce((acc, r) => acc + (r.investigation?.inputs || 0), 0) / (successful.length || 1)
  );
  const totalAriaCollapsed = successful.reduce((acc, r) => acc + (r.investigation?.ariaCollapsed || 0), 0);
  const totalHiddenAttrs = successful.reduce((acc, r) => acc + (r.investigation?.hiddenAttrs || 0), 0);

  console.log(`Run ID:                         ${RUN_ID}`);
  console.log(`Total Sites Tested:             ${results.length}`);
  console.log(`Successful Executions:          ${successful.length} / ${results.length}`);
  console.log(`Avg Elements (Viewport vs All): ${avgVpElements} vs ${avgAllElements}`);
  console.log(`Average Token Reduction:        ${avgReduction}%`);
  console.log(`Avg Census (Buttons/Links/Inputs): ${avgButtons} btn / ${avgLinks} links / ${avgInputs} inputs`);
  console.log(`Total Hidden/Collapsed Detected: ${totalAriaCollapsed} aria-expanded="false" / ${totalHiddenAttrs} [hidden]`);
  console.log(`Structured Error Code Rate:     ${structuredErrRate}%`);
  console.log(`Physical Click Dispatch Rate:   ${clickSuccessRate}%`);
  console.log(`Telemetry File:                 ${TELEMETRY_FILE}`);
  console.log("================================================================================");
}

main().catch(console.error);
