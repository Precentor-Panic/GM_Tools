import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — combat-planning/item-store.mjs (Phase 35 task 35.1,
 * §1 of review-ui/test/e2e/phase35-fixture.mjs). Per-world, one JSON file
 * per world (`<itemRoot>/<world>.json`); status gate mirrors bestiary-store.mjs
 * (default 'proposed'). See that module's own header comment for the full
 * reasoning.
 */

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-item-store-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_ITEM_DIR = join(scratchDir, "items");

const REPO_DEFAULT_ROOT = join(new URL("../../items", import.meta.url).pathname);
const before = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();

const WORLD = "item-store-test-world";

(async () => {
  const {
    itemRoot,
    saveItem,
    getItem,
    listItems,
    acceptItem,
    discardItem,
    updateItemFields,
    addItemTag,
    removeItemTag
  } = await import("../../combat-planning/item-store.mjs");

  test("directory isolation: itemRoot() honors GM_TOOLS_ITEM_DIR, never the repo's real default", () => {
    assert.equal(itemRoot(), process.env.GM_TOOLS_ITEM_DIR);
    assert.notEqual(itemRoot(), REPO_DEFAULT_ROOT);
  });

  test("listItems: [] for a world with no items yet -- not an error", () => {
    assert.deepEqual(listItems("a-totally-new-world"), []);
  });

  test("saveItem: creates an ItemRecord with kind:'item' FIXED, status defaults to 'proposed', tags defaults to []", () => {
    const item = saveItem(
      WORLD,
      { name: "Potion of Healing", type: "consumable", quantity: 3, description: "Regains 2d4+2 hp.", foundryItemRef: "Item.potion1" },
      { makeId: () => "it-1", now: "2026-08-08T00:00:00.000Z" }
    );
    assert.equal(item.id, "it-1");
    assert.equal(item.world, WORLD);
    assert.equal(item.kind, "item");
    assert.equal(item.status, "proposed");
    assert.deepEqual(item.tags, []);
    assert.equal(item.quantity, 3);
    assert.equal(item.createdAt, "2026-08-08T00:00:00.000Z");
  });

  test("getItem: round-trips a saved item by id", () => {
    const reread = getItem(WORLD, "it-1");
    assert.equal(reread.name, "Potion of Healing");
  });

  test("getItem: throws a clear error for an unknown itemId", () => {
    assert.throws(() => getItem(WORLD, "no-such-item"), /no-such-item/);
  });

  test("listItems: lists every item for the world, in creation order", () => {
    saveItem(WORLD, { name: "Bag of Holding", type: "equipment" }, { makeId: () => "it-2", now: "2026-08-08T00:01:00.000Z" });
    const items = listItems(WORLD);
    assert.deepEqual(items.map((i) => i.id), ["it-1", "it-2"]);
  });

  test("no write in this file leaked into the repo's real default items/ directory", () => {
    const after = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();
    const added = [...after].filter((f) => !before.has(f));
    assert.deepEqual(added, [], `this test run must not add new entries to ${REPO_DEFAULT_ROOT}, found: ${added}`);
  });

  // -------------------------------------------------------------------------
  // status gate / re-ingest update
  // -------------------------------------------------------------------------

  test("acceptItem: proposed -> accepted", () => {
    const updated = acceptItem(WORLD, "it-1");
    assert.equal(updated.status, "accepted");
  });

  test("discardItem: refuses to discard an already-accepted item", () => {
    assert.throws(() => discardItem(WORLD, "it-1"), /accepted/i);
  });

  test("discardItem: a still-'proposed' item discards cleanly", () => {
    const updated = discardItem(WORLD, "it-2");
    assert.equal(updated.status, "discarded");
  });

  test("updateItemFields: overwrites fields on a still-'proposed' item, preserving id/world/kind/foundryItemRef/status/createdAt", () => {
    const item = saveItem(WORLD, { name: "Rope", type: "loot", foundryItemRef: "Item.rope1" }, { makeId: () => "it-3", now: "2026-08-08T00:02:00.000Z" });
    const updated = updateItemFields(WORLD, item.id, { name: "Rope, Silk (50 feet)", quantity: 1, sourceText: "re-pulled" });
    assert.equal(updated.id, "it-3");
    assert.equal(updated.kind, "item");
    assert.equal(updated.foundryItemRef, "Item.rope1");
    assert.equal(updated.status, "proposed");
    assert.equal(updated.createdAt, "2026-08-08T00:02:00.000Z");
    assert.equal(updated.name, "Rope, Silk (50 feet)");
    assert.equal(updated.quantity, 1);
  });

  test("updateItemFields: NEVER silently overwrites an already-'accepted' item -- refuses with a clear error", () => {
    assert.throws(() => updateItemFields(WORLD, "it-1", { name: "Should Not Land" }), /accepted/i);
    const reread = getItem(WORLD, "it-1");
    assert.equal(reread.name, "Potion of Healing", "must still be the original value");
  });

  // -------------------------------------------------------------------------
  // tags (§4 wrapper)
  // -------------------------------------------------------------------------

  test("addItemTag/removeItemTag: wraps tags.mjs's addTag/removeTag with real persistence", () => {
    const tagged = addItemTag(WORLD, "it-3", "  loot  ");
    assert.deepEqual(tagged.tags, ["loot"], "tag is trimmed before persisting");
    const reread = getItem(WORLD, "it-3");
    assert.deepEqual(reread.tags, ["loot"], "persisted, not just returned in-memory");

    const untagged = removeItemTag(WORLD, "it-3", "loot");
    assert.deepEqual(untagged.tags, []);
  });

  test("addItemTag: throws a clear error for an unknown itemId (never silently no-ops at the store boundary)", () => {
    assert.throws(() => addItemTag(WORLD, "no-such-item", "x"), /no-such-item/);
  });

  console.log(`\n${passed} passed`);
})();

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
