import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOwners } from "./owners.js";

describe("bridge/owners.js (Colocated Unit Spec)", () => {
  it("initial state: returns empty owners list for any tabId", () => {
    const owners = createOwners();
    assert.deepEqual(owners.ownersOf(101), []);
    assert.deepEqual(owners.ownersOf(0), []);
  });

  it("add: associates a tabId with a browser alias", () => {
    const owners = createOwners();
    owners.add("chrome-default", 42);

    assert.deepEqual(owners.ownersOf(42), ["chrome-default"]);
    assert.deepEqual(owners.ownersOf(99), []);
  });

  it("add: supports multiple tabs under the same browser alias", () => {
    const owners = createOwners();
    owners.add("chrome-default", 1);
    owners.add("chrome-default", 2);

    assert.deepEqual(owners.ownersOf(1), ["chrome-default"]);
    assert.deepEqual(owners.ownersOf(2), ["chrome-default"]);
  });

  it("add: is idempotent when adding duplicate tabId to the same alias", () => {
    const owners = createOwners();
    owners.add("chrome-default", 10);
    owners.add("chrome-default", 10);

    assert.deepEqual(owners.ownersOf(10), ["chrome-default"]);
  });

  it("multi-browser: tracks multiple browser instances owning the same tabId", () => {
    const owners = createOwners();
    owners.add("chrome-1", 777);
    owners.add("chrome-2", 777);

    const result = owners.ownersOf(777);
    assert.equal(result.length, 2);
    assert.ok(result.includes("chrome-1"));
    assert.ok(result.includes("chrome-2"));
  });

  it("noteListing: replaces previous tab set entirely for an alias", () => {
    const owners = createOwners();
    owners.add("chrome-work", 10);
    owners.add("chrome-work", 20);

    // Full listing update replacing old tabs with a new set
    owners.noteListing("chrome-work", [30, 40]);

    assert.deepEqual(owners.ownersOf(10), []);
    assert.deepEqual(owners.ownersOf(20), []);
    assert.deepEqual(owners.ownersOf(30), ["chrome-work"]);
    assert.deepEqual(owners.ownersOf(40), ["chrome-work"]);
  });

  it("noteListing: handles empty tab array clearing all ownership for that alias", () => {
    const owners = createOwners();
    owners.add("chrome-temp", 100);
    owners.noteListing("chrome-temp", []);

    assert.deepEqual(owners.ownersOf(100), []);
  });

  it("remove: disassociates a tabId from a specific browser alias", () => {
    const owners = createOwners();
    owners.add("chrome-a", 50);
    owners.add("chrome-b", 50);

    owners.remove("chrome-a", 50);

    assert.deepEqual(owners.ownersOf(50), ["chrome-b"]);
  });

  it("remove: safe no-op when removing non-existent tabId or unknown alias", () => {
    const owners = createOwners();
    owners.add("chrome-a", 1);

    // Should not throw or corrupt state
    assert.doesNotThrow(() => owners.remove("unknown-alias", 1));
    assert.doesNotThrow(() => owners.remove("chrome-a", 9999));
    assert.deepEqual(owners.ownersOf(1), ["chrome-a"]);
  });

  it("isolation: independent instances maintain distinct ownership state", () => {
    const instanceA = createOwners();
    const instanceB = createOwners();

    instanceA.add("chrome-1", 123);
    assert.deepEqual(instanceA.ownersOf(123), ["chrome-1"]);
    assert.deepEqual(instanceB.ownersOf(123), []);
  });
});
