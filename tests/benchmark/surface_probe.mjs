// §9 baseline probe: the same intents, expressed the way each version wants them, scored on
// what an agent actually pays — calls spent, and whether the answer was right, wrong, or refused.
//
// Two things are measured and they are not the same thing:
//
//   CALLS      how many bridge round-trips an intent costs. Fewer is better only if the answer
//              is right, which is why it is never reported alone.
//   OUTCOME    right / refused-with-help / WRONG. A wrong answer that looks successful is the
//              expensive failure: the agent proceeds on it. A refusal that names the candidates
//              costs one more call and nothing else.
//
// Run it against a v0.7.1 bridge and against a v0.8.0 bridge and diff the two reports. The
// extension must be the matching build — reload it between runs, or the numbers are fiction.
//
//   node tests/benchmark/surface_probe.mjs > /tmp/probe-<version>.json

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CLIENT = { session: `benchmark-${process.pid}`, source: "benchmark" };

const BRIDGE = process.env.BROWSERCTL_BRIDGE_URL || "http://127.0.0.1:8765";
const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(HERE, "..", "e2e", "testpage.html"), "utf8").replace(
  "__IFRAME_SRC__",
  "about:blank"
);

let calls = 0;
async function cmd(action, params = {}) {
  calls++;
  const res = await fetch(`${BRIDGE}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, params, client: CLIENT }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.error || "failed");
  return data.result;
}

// Each intent is a thing a person would ask for, plus a verdict function that says what actually
// came back. Both versions are given their own best shot: the v2 form is tried first and the
// v0.7 form is the fallback, so a version is never scored on syntax it does not have.
const INTENTS = [
  {
    id: "label-unique",
    what: 'click the control labelled "Save Draft"',
    async run() {
      try {
        return await cmd("click", { target: "Save Draft" });
      } catch {
        return await cmd("click", { text: "Save Draft" });
      }
    },
    verdict: async (r, err) => {
      if (err) return "refused";
      const id = await idOfLastClick();
      return id === "save-draft" ? "right" : `WRONG (hit ${id})`;
    },
  },
  {
    id: "label-ambiguous",
    what: 'click "Save", which three different controls carry',
    async run() {
      try {
        return await cmd("click", { target: "Save" });
      } catch (e) {
        if (/ambiguous/i.test(e.message)) throw e;
        return await cmd("click", { text: "Save" });
      }
    },
    verdict: async (r, err) => {
      if (err) return /ambiguous/i.test(err) ? "refused-with-candidates" : "refused";
      const id = await idOfLastClick();
      return `WRONG (silently picked ${id} of 3)`;
    },
  },
  {
    id: "landmark-collision",
    what: 'click "search", which is both a button label and an HTML5 landmark',
    async run() {
      try {
        return await cmd("click", { target: "search" });
      } catch {
        return await cmd("click", { text: "search" });
      }
    },
    verdict: async (r, err) => {
      if (err) return "refused";
      const id = await idOfLastClick();
      return id === "btn-search" ? "right" : `WRONG (hit ${id})`;
    },
  },
  {
    id: "rows-structured",
    what: "read the three rows as title/url/number",
    async run() {
      try {
        return await cmd("extract", {
          selector: "li.row",
          fields: { title: ".t", url: { selector: ".u", attr: "href" }, n: ".n" },
        });
      } catch {
        return await cmd("get_property", {
          selector: "li.row",
          all: true,
          fields: { title: ".t", url: { selector: ".u", attr: "href" }, n: ".n" },
        });
      }
    },
    verdict: async (r, err) =>
      err ? "refused" : (r.matches || []).length === 3 ? "right" : `WRONG (${(r.matches || []).length} rows)`,
  },
  {
    id: "count",
    what: "count the rows",
    async run() {
      try {
        return await cmd("get_property", { target: "li.row", property: "count" });
      } catch {
        return await cmd("get_property", { selector: "li.row", property: "count" });
      }
    },
    verdict: async (r, err) => (err ? "refused" : r.value === 3 ? "right" : `WRONG (${r.value})`),
  },
  {
    id: "form-3-fields",
    what: "fill three fields and submit",
    async run() {
      try {
        return await cmd("fill_form", {
          fields: [
            { target: "css=#plain", value: "a" },
            { target: "css=#controlled", value: "b" },
            { target: "css=#area", value: "c" },
          ],
        });
      } catch {
        await cmd("fill", { selector: "#plain", text: "a" });
        await cmd("fill", { selector: "#controlled", text: "b" });
        return await cmd("fill", { selector: "#area", text: "c" });
      }
    },
    verdict: async (r, err) => {
      if (err) return "refused";
      const v = await cmd("eval_js", {
        expression:
          "document.getElementById('plain').value+document.getElementById('controlled').value+document.getElementById('area').value",
      });
      return v.value === "abc" ? "right" : `WRONG (${JSON.stringify(v.value)})`;
    },
  },
  {
    id: "confirm-dialog",
    what: "click Delete Record and agree to the confirm() it raises",
    async run() {
      return await cmd("click", { target: "css=#confirmbtn", onDialog: "accept" });
    },
    verdict: async (r, err) => {
      if (err) return /dialog/i.test(err) ? "refused" : "refused";
      const v = await cmd("get_property", { selector: "#dialogresult", property: "text" });
      return v.value === "confirmed" ? "right" : `WRONG (${JSON.stringify(v.value)})`;
    },
  },
];

async function idOfLastClick() {
  const v = await cmd("eval_js", { expression: "window.__lastClickId || 'none'" });
  return v.value;
}

async function main() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      PAGE.replace(
        "</body>",
        "<script>document.addEventListener('click',(e)=>{const t=e.target.closest('[id]');window.__lastClickId=t?t.id:'none';},true);</script></body>"
      )
    );
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;

  const version = await cmd("status", {}).then(
    (s) => s.version || "unknown",
    () => "unknown"
  );
  const tab = await cmd("new_tab", { url: `http://127.0.0.1:${port}/` });
  await cmd("wait_settle", {});
  try {
    await cmd("cdp_attach", {});
  } catch {
    /* 0.7.1 needs it too, but a failure here only affects the dialog intent */
  }

  const rows = [];
  for (const intent of INTENTS) {
    const before = calls;
    let r = null;
    let err = null;
    try {
      r = await intent.run();
    } catch (e) {
      err = e.message;
    }
    const spent = calls - before;
    let outcome;
    try {
      outcome = await intent.verdict(r, err);
    } catch (e) {
      outcome = `verdict failed: ${e.message}`;
    }
    rows.push({ id: intent.id, what: intent.what, calls: spent, outcome, error: err });
    await cmd("eval_js", { expression: "window.__lastClickId=null" }).catch(() => {});
  }

  try {
    await cmd("ungroup_tab", { id: tab.id });
  } catch {
    /* not grouped */
  }
  await cmd("close_tab", { id: tab.id }).catch(() => {});
  srv.close();

  const wrong = rows.filter((r) => /^WRONG/.test(r.outcome)).length;
  const right = rows.filter((r) => r.outcome === "right").length;
  console.log(
    JSON.stringify(
      {
        version,
        intents: rows.length,
        right,
        refused: rows.length - right - wrong,
        wrong,
        totalCalls: rows.reduce((n, r) => n + r.calls, 0),
        rows,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error("probe crashed:", e.message);
  process.exit(2);
});
