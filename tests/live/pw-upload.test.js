// @ts-check
// Playwright's setInputFiles cases adopted by ID (specs/tools/file_upload.md), through file_upload.
// Source: page-set-input-files.spec.ts in Playwright's tests/page, and playwright-mcp files.spec.ts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, describe, test } from "node:test";
import { refIn, startHarness } from "./harness.js";
import { failsWith, pwPage } from "./pw.js";

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/pw");
/** @param {string} name */
const asset = (name) => path.join(ASSETS, name);

/** @type {import("./harness.js").Harness} */
let h;
/** @type {string} */
let scratch;
before(async () => {
  h = await startHarness();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bctl-pw-upload-"));
});
after(async () => {
  await h?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});
// each test opens its own tabs: close them so a long file does not pile tabs up
afterEach(() => h.closeTabs());

const open = () => pwPage(h, h.newSession(), "dom");
/** The text of the input's first file, read in the page. @param {ReturnType<typeof pwPage>} page @param {string} selector */
const firstFileText = (page, selector) => page.$eval(selector, (/** @type {HTMLInputElement} */ input) => /** @type {FileList} */ (input.files)[0].text());
/** Records input and change on the target. @param {ReturnType<typeof pwPage>} page @param {string} selector */
const recordEvents = (page, selector) =>
  page.$eval(selector, (/** @type {HTMLInputElement} */ input) => {
    /** @type {any} */ (window).__events = [];
    for (const type of ["input", "change"]) input.addEventListener(type, () => /** @type {any} */ (window).__events.push(type));
  });

describe("upload", () => {
  test("IF-001 / IF-012 should upload a file, also one with spaces in its name", async () => {
    const page = open();
    for (const name of ["file-to-upload.txt", "file to upload.txt"]) {
      await page.goto(`${h.base}/pw/input/fileupload.html`);
      await page.setInputFiles("input[type=file]", [asset(name)]);
      assert.equal(await page.$eval("input[type=file]", (/** @type {HTMLInputElement} */ input) => input.files?.[0].name), name);
      assert.equal(await firstFileText(page, "input[type=file]"), "contents of the file");
    }
  });

  test("IF-009 should upload a 200 MB file through the CDP lane", async () => {
    const page = open();
    await page.goto(`${h.base}/pw/input/fileupload.html`);
    const file = path.join(scratch, "200MB.zip");
    fs.writeFileSync(file, Buffer.alloc(200 * 1024 * 1024, "A"));
    await recordEvents(page, 'input[type="file"]');
    const r = await h.ok("file_upload", { target: 'input[type="file"]', paths: [file], timeout: 30 }, page.session);
    assert.equal(r.lane, "cdp");
    assert.deepEqual(r.files.map((/** @type {any} */ f) => [f.name, f.size]), [["200MB.zip", 200 * 1024 * 1024]]);
    assert.deepEqual(await page.evaluate("window.__events"), ["input", "change"]);
    fs.rmSync(file);
  });

  test("IF-010 should refuse a file that does not exist", async () => {
    const page = open();
    await page.goto(`${h.base}/pw/input/fileupload.html`);
    const error = await failsWith(page.setInputFiles("input[type=file]", [path.join(scratch, "i actually do not exist.txt")]), "FILE_NOT_FOUND");
    assert.match(error.message, /i actually do not exist\.txt/);
  });

  test("IF-013 / IF-015 should set a file, also on a page with a strict CSP", async () => {
    const page = open();
    for (const url of [h.content("<input type=file>"), `${h.base}/csp/pw/input/fileupload.html`]) {
      await page.goto(url);
      await page.setInputFiles("input[type=file]", [asset("file-to-upload.txt")]);
      assert.deepEqual(await page.$eval("input[type=file]", (/** @type {HTMLInputElement} */ input) => [input.files?.length, input.files?.[0].name]), [1, "file-to-upload.txt"]);
    }
  });

  test("IF-016 should give the page the MIME type of each file", async () => {
    const page = open();
    await page.setContent(`<form><input type="file" name="file1"><input type="file" name="file2"></form>`);
    await page.setInputFiles("input[name=file1]", [asset("file-to-upload.txt")]);
    await page.setInputFiles("input[name=file2]", [asset("pptr.png")]);
    const types = await page.evaluate(() => [...document.querySelectorAll("input")].map((i) => [i.files?.[0].name, i.files?.[0].type]));
    assert.deepEqual(types, [
      ["file-to-upload.txt", "text/plain"],
      ["pptr.png", "image/png"],
    ]);
  });

  test("IF-018 / IF-020 should emit input and change, also when the files change a second time", async () => {
    const page = open();
    await page.setContent(`<input type=file multiple=true/>`);
    await recordEvents(page, "input");
    await page.setInputFiles("input", [asset("file-to-upload.txt")]);
    assert.deepEqual(await page.evaluate("window.__events"), ["input", "change"]);
    await page.evaluate("window.__events.length = 0");
    await page.setInputFiles("input", [asset("pptr.png")]);
    assert.equal(await page.$eval("input", (/** @type {HTMLInputElement} */ input) => input.files?.[0].name), "pptr.png");
    assert.deepEqual(await page.evaluate("window.__events"), ["input", "change"]);
  });

  test("IF-019 input event is composed and crosses the shadow boundary", async () => {
    const page = open();
    await page.setContent(`<body><script>const div = document.createElement('div'); const shadowRoot = div.attachShadow({mode: 'open'});
      shadowRoot.innerHTML = '<input type=file></input>'; document.body.appendChild(div);</script></body>`);
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.firedBodyEvents = [];
      w.firedEvents = [];
      const input = /** @type {Element} */ (document.querySelector("div")?.shadowRoot?.querySelector("input"));
      for (const event of ["input", "change"]) {
        document.body.addEventListener(event, (e) => w.firedBodyEvents.push(`${e.type}:${e.composed}`), false);
        input.addEventListener(event, (e) => w.firedEvents.push(`${e.type}:${e.composed}`), false);
      }
    });
    await page.setInputFiles("input", [asset("file-to-upload.txt")]);
    assert.deepEqual(await page.evaluate("window.firedEvents"), ["input:true", "change:false"]);
    assert.deepEqual(await page.evaluate("window.firedBodyEvents"), ["input:true"]);
  });

  test("IF-021 should preserve the lastModified timestamp", async () => {
    const page = open();
    await page.setContent(`<input type=file multiple=true/>`);
    const files = ["file-to-upload.txt", "file-to-upload-2.txt"];
    await page.setInputFiles("input", files.map(asset));
    const seen = await page.$eval("input", (/** @type {HTMLInputElement} */ input) => [...(input.files ?? [])].map((f) => [f.name, f.lastModified]));
    assert.deepEqual(seen.map((/** @type {any[]} */ f) => f[0]), files);
    files.forEach((f, i) => assert.ok(Math.abs(seen[i][1] - Math.round(fs.statSync(asset(f)).mtimeMs)) <= 1000, f));
  });

  test("IF-022 should store an uploaded file in IndexedDB", async () => {
    const page = open();
    await page.goto(`${h.base}/pw/input/fileupload.html`);
    await page.setInputFiles("input[type=file]", [asset("file-to-upload.txt")]);
    const stored = await page.$eval("input[type=file]", async (/** @type {HTMLInputElement} */ input) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("file-upload");
        request.onupgradeneeded = () => request.result.createObjectStore("files");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const file = await new Promise((resolve, reject) => {
        const transaction = /** @type {IDBDatabase} */ (db).transaction("files", "readwrite");
        const store = transaction.objectStore("files");
        store.put(/** @type {FileList} */ (input.files)[0], "file");
        const request = store.get("file");
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error);
      });
      /** @type {IDBDatabase} */ (db).close();
      return { name: /** @type {File} */ (file).name, text: await /** @type {File} */ (file).text() };
    });
    assert.deepEqual(stored, { name: "file-to-upload.txt", text: "contents of the file" });
  });

  test("UP-E05 the input by its snapshot ref; a missing path, then a real one", async () => {
    const page = open();
    await page.setContent(`<input type="file" /><button>Button</button>`);
    const ref = /** @type {string} */ (refIn((await h.ok("snapshot", {}, page.session)).snapshot, 'button "Choose File"'));
    assert.ok(ref);
    await failsWith(page.setInputFiles(ref, [path.join(scratch, "missing.txt")]), "FILE_NOT_FOUND");
    const real = path.join(scratch, "retry.txt");
    fs.writeFileSync(real, "retry");
    const r = await page.setInputFiles(ref, [real]);
    assert.deepEqual(r.files.map((/** @type {any} */ f) => f.name), ["retry.txt"]);
  });
});
