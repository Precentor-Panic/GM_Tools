import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

/**
 * CONTRACT UNDER TEST — wf-mcp-server/lib/foundry-item-push-ops.mjs's
 * pushItemToFoundry / pushBestiaryEntryToFoundry ("Aureus to the Table" B2
 * task G7). End-to-end against real (scratch-isolated) item-store.mjs /
 * bestiary-store.mjs stores + the real ops-channel writer + a real (fixture)
 * Plutonium data dir, no live Foundry — a background timer simulates the
 * Foundry-side watcher, same fake-watcher pattern as
 * foundry-push-ops.test.mjs / scene-lifecycle-ops.test.mjs.
 */
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-foundry-item-push-ops-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_ITEM_DIR = join(scratchDir, "items");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
const dataDir = join(scratchDir, "foundrydata");

const {
  pushItemToFoundry, pushBestiaryEntryToFoundry,
  reconcilePendingItemResults, reconcilePendingBestiaryResults,
  parsePlutoniumProvenance, buildLostechUpdatePatch, composeHandAuthoredCreateItemData
} = await import("../lib/foundry-item-push-ops.mjs");
const { foundryOpsPath, foundryResultsPath } = await import("../lib/snapshot.mjs");
const { saveItem, getItem, setItemPushOverrides } = await import("../../combat-planning/item-store.mjs");
const { saveBestiaryEntry, getBestiaryEntry } = await import("../../combat-planning/bestiary-store.mjs");

function seedFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
}

/** Arms a one-shot fake watcher: after `delayMs`, writes `result(s)` to the results file then clears the ops file to "[]". */
function armFakeWatcher(world, results, delayMs = 20) {
  const opsPath = foundryOpsPath(dataDir, world);
  const resultsPath = foundryResultsPath(dataDir, world);
  return setTimeout(() => {
    seedFile(resultsPath, Array.isArray(results) ? results : [results]);
    writeFileSync(opsPath, "[]", "utf8");
  }, delayMs);
}

/**
 * A RECURRING fake watcher (setInterval, not one-shot) that computes its
 * response from whatever ops batch is currently on disk -- needed for the
 * two-phase lostech flow, which makes TWO SEQUENTIAL writeFoundryOps calls
 * (the second batch doesn't exist yet when the first is written, so a
 * one-shot timer would only ever answer the first one). Returns the
 * interval id -- callers must clearInterval() once done.
 */
function armRespondingWatcher(world, respond, intervalMs = 15) {
  const opsPath = foundryOpsPath(dataDir, world);
  const resultsPath = foundryResultsPath(dataDir, world);
  return setInterval(() => {
    if (!existsSync(opsPath)) return;
    let ops;
    try {
      ops = JSON.parse(readFileSync(opsPath, "utf8"));
    } catch {
      return; // mid-write -- try again next tick
    }
    if (!Array.isArray(ops) || !ops.length) return;
    seedFile(resultsPath, respond(ops));
    writeFileSync(opsPath, "[]", "utf8");
  }, intervalMs);
}

// --- fixture Plutonium data --------------------------------------------------
const itemsDir = join(dataDir, "modules", "plutonium", "data");
mkdirSync(itemsDir, { recursive: true });
const BAG_OF_HOLDING = { name: "Bag of Holding", source: "DMG", page: 155, type: "WAND", rarity: "uncommon", entries: ["A bag."] };
const WAND_OF_SCRYING = { name: "Wand of Scrying", source: "XGE", page: 143, type: "W", rarity: "rare", reqAttune: true, entries: ["Peer far."] };
writeFileSync(join(itemsDir, "items.json"), JSON.stringify({ item: [BAG_OF_HOLDING, WAND_OF_SCRYING] }), "utf8");
writeFileSync(join(itemsDir, "items-base.json"), JSON.stringify({ baseitem: [] }), "utf8");

const bestiaryDir = join(itemsDir, "bestiary");
mkdirSync(bestiaryDir, { recursive: true });
const GOBLIN = { name: "Goblin", source: "MM", page: 166, cr: "1/4", type: "humanoid", ac: [15], hp: { average: 7, formula: "2d6" } };
// A partial-override _copy record that STILL has its own cr (so normalizeMonster
// keeps it in the index) -- pushBestiaryEntryToFoundry must refuse it anyway.
const GOBLIN_COPY_SHELL = { name: "Goblin Reprint", source: "MM", cr: "1/4", _copy: { name: "Goblin", source: "MM" } };
writeFileSync(join(bestiaryDir, "bestiary-mm.json"), JSON.stringify({ monster: [GOBLIN, GOBLIN_COPY_SHELL] }), "utf8");

// ===========================================================================
// Pure helpers
// ===========================================================================

await test("parsePlutoniumProvenance: recovers source from the stamped provenance line, with and without a page", () => {
  assert.equal(parsePlutoniumProvenance("DMG p155 via Plutonium"), "DMG");
  assert.equal(parsePlutoniumProvenance("DMG via Plutonium"), "DMG");
  assert.equal(parsePlutoniumProvenance("hand-authored"), null);
  assert.equal(parsePlutoniumProvenance(null), null);
});

await test("buildLostechUpdatePatch: recharges:false -> recovery:[]; recharges omitted -> no recovery key; null when nothing to patch", () => {
  assert.deepEqual(buildLostechUpdatePatch({ usesValue: 1, usesMax: 1, recharges: false }), { "system.uses": { value: 1, max: 1, recovery: [] } });
  assert.deepEqual(buildLostechUpdatePatch({ usesValue: 1, usesMax: 2 }), { "system.uses": { value: 1, max: 2 } });
  assert.deepEqual(buildLostechUpdatePatch({ displayName: "Renamed" }), { name: "Renamed" });
  assert.equal(buildLostechUpdatePatch({ descriptionNote: "only a note" }), null);
});

await test("composeHandAuthoredCreateItemData: folds overrides in directly, type flips to consumable when uses are set", () => {
  const item = { name: "Plain Rope", description: "50 feet of rope.", pushOverrides: null };
  const bare = composeHandAuthoredCreateItemData(item);
  assert.equal(bare.type, "loot");
  assert.equal(bare.system.description.value, "<p>50 feet of rope.</p>");
  assert.equal(bare.system.uses, undefined);

  const withUses = composeHandAuthoredCreateItemData({ ...item, pushOverrides: { usesValue: 1, usesMax: 3, recharges: false, displayName: "Rope of Scarcity" } });
  assert.equal(withUses.name, "Rope of Scarcity");
  assert.equal(withUses.type, "consumable");
  assert.deepEqual(withUses.system.uses, { value: 1, max: 3, recovery: [] });
});

await test("composeHandAuthoredCreateItemData: escapes description HTML", () => {
  const data = composeHandAuthoredCreateItemData({ name: "x", description: "<script>alert(1)</script> & \"quoted\"", pushOverrides: null });
  assert.doesNotMatch(data.system.description.value, /<script>/);
  assert.match(data.system.description.value, /&lt;script&gt;/);
  assert.match(data.system.description.value, /&amp;/);
});

// ===========================================================================
// pushItemToFoundry — Plutonium-sourced path
// ===========================================================================

await test("pushItemToFoundry: Plutonium-sourced item composes import_via_plutonium with the VERBATIM raw entry", async () => {
  const WORLD = "item-push-plutonium-world";
  const item = saveItem(WORLD, { name: "Bag of Holding", sourceText: "DMG p155 via Plutonium", status: "accepted" });

  // No watcher armed -- we want the "queued" (not-yet-confirmed) path here.
  const result = await pushItemToFoundry(dataDir, WORLD, item.id, {}, { pollMs: 5, timeoutMs: 20 });
  assert.equal(result.status, "queued");
  const ops = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, "import_via_plutonium");
  assert.deepEqual(ops[0].data.entry, BAG_OF_HOLDING);
  assert.equal(ops[0].data.kind, "item");
  assert.equal(ops[0].data.actorUuid, undefined);
  writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8"); // clear the queued batch so later tests in this world aren't blocked
});

await test("pushItemToFoundry: actorUuid composes into the import op and lands the item in that actor's inventory", async () => {
  const WORLD = "item-push-actor-world";
  const item = saveItem(WORLD, { name: "Bag of Holding", sourceText: "DMG p155 via Plutonium", status: "accepted" });

  let capturedOp = null;
  const timer = armRespondingWatcher(WORLD, (ops) => {
    capturedOp = ops[0];
    return [{ opId: ops[0].opId, ok: true, foundryUuid: "Item.bag2" }];
  }, 15);
  const result = await pushItemToFoundry(dataDir, WORLD, item.id, { actorUuid: "Actor.hero1" }, { pollMs: 5, timeoutMs: 200 });
  clearTimeout(timer);
  assert.equal(result.ok, true);
  assert.equal(result.foundryUuid, "Item.bag2");
  assert.equal(capturedOp.data.actorUuid, "Actor.hero1");
  assert.equal(getItem(WORLD, item.id).foundryItemRef, "Item.bag2");
});

await test("pushItemToFoundry: confirmed ok:true writes foundryItemRef; ok:false leaves it null", async () => {
  const WORLD = "item-push-ok-fail-world";
  const okItem = saveItem(WORLD, { name: "Bag of Holding", sourceText: "DMG p155 via Plutonium", status: "accepted" });
  let timer = armFakeWatcher(WORLD, { opId: "op_ok", ok: true, foundryUuid: "Item.ok1" }, 15);
  const okResult = await pushItemToFoundry(dataDir, WORLD, okItem.id, {}, { pollMs: 5, timeoutMs: 200, makeOpId: () => "op_ok" });
  clearTimeout(timer);
  assert.equal(okResult.ok, true);
  assert.equal(getItem(WORLD, okItem.id).foundryItemRef, "Item.ok1");

  const failItem = saveItem(WORLD, { name: "Wand of Scrying", sourceText: "XGE p143 via Plutonium", status: "accepted" });
  timer = armFakeWatcher(WORLD, { opId: "op_fail", ok: false, error: "Plutonium api missing" }, 15);
  const failResult = await pushItemToFoundry(dataDir, WORLD, failItem.id, {}, { pollMs: 5, timeoutMs: 200, makeOpId: () => "op_fail" });
  clearTimeout(timer);
  assert.equal(failResult.ok, false);
  assert.match(failResult.error, /Plutonium api missing/);
  assert.equal(getItem(WORLD, failItem.id).foundryItemRef, null, "a failed op must never write a ref");
});

await test("pushItemToFoundry: unknown Plutonium record (dataset changed) throws a clear error", async () => {
  const WORLD = "item-push-missing-record-world";
  const item = saveItem(WORLD, { name: "Nonexistent Trinket", sourceText: "DMG p999 via Plutonium", status: "accepted" });
  await assert.rejects(
    () => pushItemToFoundry(dataDir, WORLD, item.id, {}, { pollMs: 5, timeoutMs: 20 }),
    /no longer available/
  );
});

await test("pushItemToFoundry: refuses a row that already has a foundryItemRef", async () => {
  const WORLD = "item-push-already-pushed-world";
  const item = saveItem(WORLD, { name: "Already There", foundryItemRef: "Item.existing", status: "accepted" });
  await assert.rejects(
    () => pushItemToFoundry(dataDir, WORLD, item.id, {}, { pollMs: 5, timeoutMs: 20 }),
    /already in Foundry/
  );
});

// ===========================================================================
// pushItemToFoundry — the LOSTECH two-phase flow
// ===========================================================================

await test("lostech flow: overrides on a Plutonium-sourced row compose import_via_plutonium THEN update_item, in one push call", async () => {
  const WORLD = "item-push-lostech-world";
  let item = saveItem(WORLD, { name: "Bag of Holding", sourceText: "DMG p155 via Plutonium", status: "accepted" });
  item = setItemPushOverrides(WORLD, item.id, { displayName: "Necklace of Fireballs (one bead)", usesValue: 1, usesMax: 1, recharges: false });

  let capturedOps = [];
  const timer = armRespondingWatcher(WORLD, (ops) => {
    capturedOps = capturedOps.concat(ops);
    // The import op always comes first in a fresh batch; respond to whichever op(s) just landed.
    return ops.map((op) => op.kind === "import_via_plutonium"
      ? { opId: op.opId, ok: true, foundryUuid: "Item.lostech1" }
      : { opId: op.opId, ok: true, foundryUuid: op.data.itemUuid });
  }, 15);

  const result = await pushItemToFoundry(dataDir, WORLD, item.id, {}, { pollMs: 5, timeoutMs: 500 });
  clearTimeout(timer);

  assert.equal(result.status, "applied");
  assert.equal(result.ok, true);
  assert.equal(result.foundryUuid, "Item.lostech1");
  assert.equal(capturedOps.length, 2, "two SEQUENTIAL writeFoundryOps calls -- two separate ops batches, not one batch of two");
  assert.equal(capturedOps[0].kind, "import_via_plutonium");
  assert.deepEqual(capturedOps[0].data.entry, BAG_OF_HOLDING);
  assert.equal(capturedOps[1].kind, "update_item");
  assert.equal(capturedOps[1].data.itemUuid, "Item.lostech1");
  assert.deepEqual(capturedOps[1].data.patch, {
    name: "Necklace of Fireballs (one bead)",
    "system.uses": { value: 1, max: 1, recovery: [] }
  });
  assert.equal(getItem(WORLD, item.id).foundryItemRef, "Item.lostech1");
});

await test("lostech flow: recharges omitted -> the update patch carries NO recovery key (Plutonium's own recovery survives)", async () => {
  const WORLD = "item-push-lostech-recharge-world";
  let item = saveItem(WORLD, { name: "Wand of Scrying", sourceText: "XGE p143 via Plutonium", status: "accepted" });
  item = setItemPushOverrides(WORLD, item.id, { usesValue: 2, usesMax: 7 }); // recharges omitted -- TRUE lostech, still recharges

  let updatePatch = null;
  const timer = armRespondingWatcher(WORLD, (ops) => ops.map((op) => {
    if (op.kind === "update_item") updatePatch = op.data.patch;
    return op.kind === "import_via_plutonium"
      ? { opId: op.opId, ok: true, foundryUuid: "Item.wand1" }
      : { opId: op.opId, ok: true, foundryUuid: op.data.itemUuid };
  }), 15);

  const result = await pushItemToFoundry(dataDir, WORLD, item.id, {}, { pollMs: 5, timeoutMs: 500 });
  clearTimeout(timer);
  assert.equal(result.ok, true);
  assert.deepEqual(updatePatch, { "system.uses": { value: 2, max: 7 } });
  assert.ok(!("recovery" in updatePatch["system.uses"]), "no recovery key at all when recharges is omitted");
});

await test("lostech flow: import succeeds but the update patch fails -> NO ref written (documented orphan-risk case)", async () => {
  const WORLD = "item-push-lostech-update-fail-world";
  let item = saveItem(WORLD, { name: "Bag of Holding", sourceText: "DMG p155 via Plutonium", status: "accepted" });
  item = setItemPushOverrides(WORLD, item.id, { usesValue: 1, usesMax: 1, recharges: false });

  const timer = armRespondingWatcher(WORLD, (ops) => ops.map((op) => op.kind === "import_via_plutonium"
    ? { opId: op.opId, ok: true, foundryUuid: "Item.orphan1" }
    : { opId: op.opId, ok: false, error: "whitelist violation" }
  ), 15);

  const result = await pushItemToFoundry(dataDir, WORLD, item.id, {}, { pollMs: 5, timeoutMs: 500 });
  clearTimeout(timer);
  assert.equal(result.status, "applied");
  assert.equal(result.ok, false);
  assert.equal(result.importedUuid, "Item.orphan1");
  assert.match(result.error, /Import succeeded/);
  assert.equal(getItem(WORLD, item.id).foundryItemRef, null, "no ref -- the whole two-phase flow only confirms on FINAL ok");
});

// ===========================================================================
// pushItemToFoundry — hand-authored path
// ===========================================================================

await test("hand-authored item (no Plutonium provenance) pushes a single create_item op with overrides folded in", async () => {
  const WORLD = "item-push-hand-authored-world";
  let item = saveItem(WORLD, { name: "Dry Wand of Scrying", description: "A cracked wand.", status: "accepted" });
  item = setItemPushOverrides(WORLD, item.id, { usesValue: 2, usesMax: 2, recharges: false });

  const opId = "op_hand_authored";
  const timer = armFakeWatcher(WORLD, { opId, ok: true, foundryUuid: "Item.hand1" }, 15);
  const result = await pushItemToFoundry(dataDir, WORLD, item.id, {}, { pollMs: 5, timeoutMs: 200, makeOpId: () => opId });
  clearTimeout(timer);

  assert.equal(result.ok, true);
  assert.equal(result.foundryUuid, "Item.hand1");
  assert.equal(getItem(WORLD, item.id).foundryItemRef, "Item.hand1");
});

await test("hand-authored item: the composed create_item op carries the escaped description + folded uses", async () => {
  const WORLD = "item-push-hand-authored-shape-world";
  let item = saveItem(WORLD, { name: "Rusty Key", description: "Opens something, probably.", status: "accepted" });
  item = setItemPushOverrides(WORLD, item.id, { usesValue: 1, usesMax: 1, recharges: false, displayName: "Rusty Key (last use)" });

  // No watcher armed -- inspect the ops file directly before it's ever cleared.
  const result = await pushItemToFoundry(dataDir, WORLD, item.id, {}, { pollMs: 5, timeoutMs: 20 });
  assert.equal(result.status, "queued");
  const ops = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, "create_item");
  assert.equal(ops[0].data.name, "Rusty Key (last use)");
  assert.equal(ops[0].data.type, "consumable");
  assert.equal(ops[0].data.system.description.value, "<p>Opens something, probably.</p>");
  assert.deepEqual(ops[0].data.system.uses, { value: 1, max: 1, recovery: [] });
});

// ===========================================================================
// Queued -> pending-ledger -> reconcile round-trip
// ===========================================================================

await test("queued -> pending ledger -> reconcile: a single-phase (hand-authored) push resolves on the NEXT push's reconcile pass", async () => {
  const WORLD = "item-push-reconcile-world";
  const item = saveItem(WORLD, { name: "Ledger Test Item", description: "x", status: "accepted" });

  const opId = "op_ledger_test";
  const first = await pushItemToFoundry(dataDir, WORLD, item.id, {}, { pollMs: 5, timeoutMs: 20, makeOpId: () => opId });
  assert.equal(first.status, "queued");
  assert.equal(getItem(WORLD, item.id).pendingPush.opId, opId);
  assert.equal(getItem(WORLD, item.id).pendingPush.phase, "create");

  // The "Foundry watcher" finally applies + reports late, AFTER the poll window closed.
  seedFile(foundryResultsPath(dataDir, WORLD), [{ opId, ok: true, foundryUuid: "Item.ledger1" }]);
  writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8");

  const reconciled = await reconcilePendingItemResults(dataDir, WORLD, { pollMs: 5, timeoutMs: 20 });
  assert.equal(reconciled, 1);
  const after = getItem(WORLD, item.id);
  assert.equal(after.foundryItemRef, "Item.ledger1");
  assert.equal(after.pendingPush, null);
  // Results file consumed -- this producer's own opId doesn't linger for a future call.
  assert.deepEqual(JSON.parse(readFileSync(foundryResultsPath(dataDir, WORLD), "utf8")), []);
});

await test("queued -> pending ledger -> reconcile: the TWO-PHASE lostech flow resolves across reconcile calls (import late, then update)", async () => {
  const WORLD = "item-push-reconcile-lostech-world";
  let item = saveItem(WORLD, { name: "Bag of Holding", sourceText: "DMG p155 via Plutonium", status: "accepted" });
  item = setItemPushOverrides(WORLD, item.id, { usesValue: 1, usesMax: 1, recharges: false });

  const importOpId = "op_ledger_import";
  const first = await pushItemToFoundry(dataDir, WORLD, item.id, {}, { pollMs: 5, timeoutMs: 20, makeOpId: () => importOpId });
  assert.equal(first.status, "queued");
  assert.equal(first.phase, "import");
  assert.equal(getItem(WORLD, item.id).pendingPush.opId, importOpId);

  // Import result lands late. reconcile fires the follow-up update op itself
  // (armed to resolve immediately) -- update succeeds -> ref written.
  seedFile(foundryResultsPath(dataDir, WORLD), [{ opId: importOpId, ok: true, foundryUuid: "Item.ledger-lostech1" }]);
  writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8");
  const timer = armRespondingWatcher(WORLD, (ops) => ops.map((op) => ({ opId: op.opId, ok: true, foundryUuid: op.data.itemUuid })), 15);
  const reconciled = await reconcilePendingItemResults(dataDir, WORLD, { pollMs: 5, timeoutMs: 200 });
  clearTimeout(timer);
  assert.equal(reconciled, 1);
  const after = getItem(WORLD, item.id);
  assert.equal(after.foundryItemRef, "Item.ledger-lostech1");
  assert.equal(after.pendingPush, null);
});

await test("queued -> pending ledger -> reconcile: an ok:false import result clears the ledger, writes nothing", async () => {
  const WORLD = "item-push-reconcile-fail-world";
  const item = saveItem(WORLD, { name: "Bag of Holding", sourceText: "DMG p155 via Plutonium", status: "accepted" });
  const opId = "op_ledger_fail";
  await pushItemToFoundry(dataDir, WORLD, item.id, {}, { pollMs: 5, timeoutMs: 20, makeOpId: () => opId });

  seedFile(foundryResultsPath(dataDir, WORLD), [{ opId, ok: false, error: "Plutonium not installed" }]);
  writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8");
  const reconciled = await reconcilePendingItemResults(dataDir, WORLD, { pollMs: 5, timeoutMs: 20 });
  assert.equal(reconciled, 1);
  const after = getItem(WORLD, item.id);
  assert.equal(after.foundryItemRef, null);
  assert.equal(after.pendingPush, null, "cleared -- safe to retry the whole push");
});

// ===========================================================================
// pushBestiaryEntryToFoundry
// ===========================================================================

await test("pushBestiaryEntryToFoundry: composes import_via_plutonium {kind:'creature'} with the verbatim raw entry; writes foundryActorRef on confirmed ok", async () => {
  const WORLD = "bestiary-push-world";
  let entry = saveBestiaryEntry({ rawFields: { name: "Goblin" }, sourceText: "MM p166 via Plutonium" });
  assert.equal(getBestiaryEntry(entry.id).sourcePill, "plutonium"); // sourcePill is a read-time projection, not on saveBestiaryEntry's own return

  const opId = "op_bestiary_ok";
  const timer = armFakeWatcher(WORLD, { opId, ok: true, foundryUuid: "Actor.goblin1" }, 15);
  const result = await pushBestiaryEntryToFoundry(dataDir, entry.id, { world: WORLD }, { pollMs: 5, timeoutMs: 200, makeOpId: () => opId });
  clearTimeout(timer);

  assert.equal(result.ok, true);
  assert.equal(result.foundryUuid, "Actor.goblin1");
  const after = getBestiaryEntry(entry.id);
  assert.equal(after.foundryActorRef, "Actor.goblin1", "SAME field composeSceneOps' roster scan already reads for token eligibility");
});

await test("pushBestiaryEntryToFoundry: op shape carries the exact raw record", async () => {
  const WORLD = "bestiary-push-shape-world";
  const entry = saveBestiaryEntry({ rawFields: { name: "Goblin" }, sourceText: "MM p166 via Plutonium" });
  const result = await pushBestiaryEntryToFoundry(dataDir, entry.id, { world: WORLD }, { pollMs: 5, timeoutMs: 20 });
  assert.equal(result.status, "queued");
  const ops = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, "import_via_plutonium");
  assert.equal(ops[0].data.kind, "creature");
  assert.deepEqual(ops[0].data.entry, GOBLIN);
});

await test("pushBestiaryEntryToFoundry: refuses a non-Plutonium (hand-authored/SRD) entry", async () => {
  const WORLD = "bestiary-push-non-plutonium-world";
  const entry = saveBestiaryEntry({ rawFields: { name: "Homebrew Ooze" }, sourceText: "hand-authored" });
  assert.equal(getBestiaryEntry(entry.id).sourcePill, "mine");
  await assert.rejects(
    () => pushBestiaryEntryToFoundry(dataDir, entry.id, { world: WORLD }, { pollMs: 5, timeoutMs: 20 }),
    /no Plutonium provenance/
  );
});

await test("pushBestiaryEntryToFoundry: refuses a Plutonium `_copy` reprint shell", async () => {
  const WORLD = "bestiary-push-copy-shell-world";
  const entry = saveBestiaryEntry({ rawFields: { name: "Goblin Reprint" }, sourceText: "MM via Plutonium" });
  await assert.rejects(
    () => pushBestiaryEntryToFoundry(dataDir, entry.id, { world: WORLD }, { pollMs: 5, timeoutMs: 20 }),
    /_copy.*reprint shell/
  );
});

await test("pushBestiaryEntryToFoundry: refuses a row that already has a foundryActorRef", async () => {
  const WORLD = "bestiary-push-already-pushed-world";
  const entry = saveBestiaryEntry({ rawFields: { name: "Goblin" }, sourceText: "MM p166 via Plutonium", foundryActorRef: "Actor.already" });
  await assert.rejects(
    () => pushBestiaryEntryToFoundry(dataDir, entry.id, { world: WORLD }, { pollMs: 5, timeoutMs: 20 }),
    /already in Foundry/
  );
});

await test("pushBestiaryEntryToFoundry: ok:false leaves foundryActorRef null; queued -> pending ledger -> reconcile writes it later", async () => {
  const WORLD = "bestiary-push-reconcile-world";
  const failEntry = saveBestiaryEntry({ rawFields: { name: "Goblin" }, sourceText: "MM p166 via Plutonium" });
  let timer = armFakeWatcher(WORLD, { opId: "op_b_fail", ok: false, error: "importer returned nothing" }, 15);
  const failResult = await pushBestiaryEntryToFoundry(dataDir, failEntry.id, { world: WORLD }, { pollMs: 5, timeoutMs: 200, makeOpId: () => "op_b_fail" });
  clearTimeout(timer);
  assert.equal(failResult.ok, false);
  assert.equal(getBestiaryEntry(failEntry.id).foundryActorRef, null);

  const queuedEntry = saveBestiaryEntry({ rawFields: { name: "Goblin" }, sourceText: "MM p166 via Plutonium" });
  const opId = "op_b_queued";
  const queuedResult = await pushBestiaryEntryToFoundry(dataDir, queuedEntry.id, { world: WORLD }, { pollMs: 5, timeoutMs: 20, makeOpId: () => opId });
  assert.equal(queuedResult.status, "queued");
  assert.equal(getBestiaryEntry(queuedEntry.id).pendingPush.opId, opId);

  seedFile(foundryResultsPath(dataDir, WORLD), [{ opId, ok: true, foundryUuid: "Actor.goblin-late" }]);
  writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8");
  const reconciled = reconcilePendingBestiaryResults(dataDir, WORLD);
  assert.equal(reconciled, 1);
  const after = getBestiaryEntry(queuedEntry.id);
  assert.equal(after.foundryActorRef, "Actor.goblin-late");
  assert.equal(after.pendingPush, null);
});

console.log(`\n${passed} test(s) passed.`);
