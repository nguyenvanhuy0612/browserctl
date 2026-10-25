import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TABLESS_ACTIONS, ID_ACTIONS, READ_ACTIONS, isRead, tabOf, tabChoices } from "./routing.js";

describe("bridge/routing.js (Colocated Unit Spec)", () => {
  describe("Action Sets", () => {
    it("TABLESS_ACTIONS: contains browser-level lifecycle commands", () => {
      assert.ok(TABLESS_ACTIONS.has("new_tab"));
      assert.ok(TABLESS_ACTIONS.has("list_tabs"));
      assert.ok(TABLESS_ACTIONS.has("focus_window"));
      assert.ok(!TABLESS_ACTIONS.has("click"));
    });

    it("ID_ACTIONS: contains tab actions addressing via id", () => {
      assert.ok(ID_ACTIONS.has("switch_tab"));
      assert.ok(ID_ACTIONS.has("close_tab"));
      assert.ok(ID_ACTIONS.has("group_tab"));
      assert.ok(ID_ACTIONS.has("ungroup_tab"));
      assert.ok(!ID_ACTIONS.has("click"));
    });

    it("READ_ACTIONS: contains pure read operations without debugger attachment", () => {
      assert.ok(READ_ACTIONS.has("snapshot"));
      assert.ok(READ_ACTIONS.has("read_page"));
      assert.ok(READ_ACTIONS.has("get_text"));
      assert.ok(READ_ACTIONS.has("find"));
      // Mutating actions must NOT be classified as read
      assert.ok(!READ_ACTIONS.has("click"));
      assert.ok(!READ_ACTIONS.has("type"));
      assert.ok(!READ_ACTIONS.has("press_key"));
    });
  });

  describe("isRead()", () => {
    it("returns true for listed read actions without clear flag", () => {
      assert.equal(isRead("snapshot"), true);
      assert.equal(isRead("read_page", {}), true);
      assert.equal(isRead("get_text", { target: "@e1" }), true);
    });

    it("returns false if clear parameter is explicitly true", () => {
      assert.equal(isRead("storage_get", { clear: true }), false);
      assert.equal(isRead("get_console_logs", { clear: true }), false);
    });

    it("returns false for non-read or mutating actions", () => {
      assert.equal(isRead("click", {}), false);
      assert.equal(isRead("navigate", { url: "https://example.com" }), false);
      assert.equal(isRead("unknown_action"), false);
    });

    it("handles null/undefined params gracefully", () => {
      assert.equal(isRead("snapshot", null), true);
      assert.equal(isRead("snapshot", undefined), true);
      assert.equal(isRead("click", null), false);
    });
  });

  describe("tabOf()", () => {
    it("extracts integer tabId for standard actions", () => {
      assert.equal(tabOf("click", { tabId: 105 }), 105);
      assert.equal(tabOf("snapshot", { tabId: 0 }), 0); // tabId 0 is valid integer
    });

    it("extracts id (falling back to tabId) for ID_ACTIONS", () => {
      assert.equal(tabOf("switch_tab", { id: 42 }), 42);
      assert.equal(tabOf("close_tab", { tabId: 99 }), 99);
      // id takes precedence over tabId for ID_ACTIONS
      assert.equal(tabOf("switch_tab", { id: 1, tabId: 2 }), 1);
    });

    it("ignores id parameter for standard non-ID actions", () => {
      assert.equal(tabOf("click", { id: 50 }), null);
      assert.equal(tabOf("click", { id: 50, tabId: 60 }), 60);
    });

    it("rejects non-integer, NaN, or string values", () => {
      assert.equal(tabOf("click", { tabId: "12" }), null);
      assert.equal(tabOf("click", { tabId: 12.34 }), null);
      assert.equal(tabOf("click", { tabId: NaN }), null);
      assert.equal(tabOf("click", { tabId: null }), null);
      assert.equal(tabOf("click", undefined), null);
    });
  });

  describe("tabChoices()", () => {
    it("formats tab list with browser, id, title and url", () => {
      const tabs = [
        { browser: "chrome-1", id: 10, title: "Google", url: "https://google.com" },
        {
          browser: "chrome-1",
          id: 11,
          title: "GitHub",
          url: "https://github.com",
          heldBy: "session-a",
        },
      ];

      const text = tabChoices(tabs);
      assert.ok(text.includes('chrome-1 tab 10 "Google" https://google.com'));
      assert.ok(text.includes('chrome-1 tab 11 "GitHub" https://github.com [held by session-a]'));
    });

    it("truncates title at 50 chars and url at 80 chars", () => {
      const longTitle = "A".repeat(100);
      const longUrl = "http://example.com/" + "B".repeat(100);
      const tabs = [{ browser: "chrome", id: 1, title: longTitle, url: longUrl }];

      const text = tabChoices(tabs);
      assert.ok(text.includes("A".repeat(50)));
      assert.ok(!text.includes("A".repeat(51)));
      assert.ok(!text.includes(longTitle));
    });

    it("limits output to max lines and reports remaining count", () => {
      const tabs = Array.from({ length: 5 }, (_, i) => ({
        browser: "chrome",
        id: i + 1,
        title: `Tab ${i + 1}`,
        url: `http://tab${i + 1}.com`,
      }));

      const text = tabChoices(tabs, 3);
      const lines = text.split("\n");
      assert.equal(lines.length, 4); // 3 lines + 1 footer line
      assert.equal(lines[3], "(2 more tabs)");
    });

    it("handles empty tab list", () => {
      assert.equal(tabChoices([]), "");
    });
  });
});
