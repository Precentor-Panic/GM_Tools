import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — "Aureus to the Table" workstream B2 task G8's three
 * new review-ui/server.mjs routes, thin wrappers over
 * wf-mcp-server/lib/foundry-item-push-ops.mjs. Real HTTP requests via
 * fetch() against an in-process server.listen(0), same pattern as
 * foundry-push-routes.test.mjs (push-scene's own route test, this module's
 * sibling).
 *
 * ---------------------------------------------------------------------------
 * POST /api/foundry/push-item              { world, itemId, actorUuid? }
 * POST /api/foundry/push-bestiary-entry     { world, entryId }
 * POST /api/combat-planning/items/:id/push-overrides   { world, overrides|null }
 * ---------------------------------------------------------------------------
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-foundry-item-push-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_ITEM_DIR = join(scratchDir, "items");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "foundry-item-push-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

// --- fixture Plutonium data --------------------------------------------------
const pluginDataDir = join(dataDir, "modules", "plutonium", "data");
mkdirSync(pluginDataDir, { recursive: true });
const BAG_OF_HOLDING = { name: "Bag of Holding", source: "DMG", page: 155, type: "WAND", rarity: "uncommon", entries: ["A bag."] };
writeFileSync(join(pluginDataDir, "items.json"), JSON.stringify({ item: [BAG_OF_HOLDING] }), "utf8");
writeFileSync(join(pluginDataDir, "items-base.json"), JSON.stringify({ baseitem: [] }), "utf8");
const bestiaryDir = join(pluginDataDir, "bestiary");
mkdirSync(bestiaryDir, { recursive: true });
const GOBLIN = { name: "Goblin", source: "MM", page: 166, cr: "1/4", type: "humanoid", ac: [15], hp: { average: 7, formula: "2d6" } };
writeFileSync(join(bestiaryDir, "bestiary-mm.json"), JSON.stringify({ monster: [GOBLIN] }), "utf8");

const { foundryOpsPath, foundryResultsPath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { saveItem, getItem } = await import("../../combat-planning/item-store.mjs");
const { saveBestiaryEntry, getBestiaryEntry } = await import("../../combat-planning/bestiary-store.mjs");
const { createReviewServer } = await import("../server.mjs");

let server;
let base;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

function seedFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
}

/** Polls the ops file for a batch matching `predicate`, then answers it via `respond(ops)`. */
function armFakeWatcher(world, predicate, respond) {
  const opsPath = foundryOpsPath(dataDir, world);
  const resultsPath = foundryResultsPath(dataDir, world);
  const interval = setInterval(() => {
    if (!existsSync(opsPath)) return;
    let ops;
    try {
      ops = JSON.parse(readFileSync(opsPath, "utf8"));
    } catch {
      return;
    }
    if (Array.isArray(ops) && ops.length && predicate(ops)) {
      clearInterval(interval);
      seedFile(resultsPath, respond(ops));
      writeFileSync(opsPath, "[]", "utf8");
    }
  }, 20);
  return interval;
}

test("POST /api/foundry/push-item: real round trip for a hand-authored item -> create_item, ok:true, foundryItemRef set", async () => {
  const item = saveItem(WORLD, { name: "Plain Rope", description: "50 feet.", status: "accepted" });
  const watcher = armFakeWatcher(WORLD, (ops) => ops[0].kind === "create_item", (ops) => [{ opId: ops[0].opId, ok: true, foundryUuid: "Item.route1" }]);

  const { status, body } = await postJson("/api/foundry/push-item", { world: WORLD, itemId: item.id });
  clearInterval(watcher);

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.foundryUuid, "Item.route1");
  assert.equal(getItem(WORLD, item.id).foundryItemRef, "Item.route1");
});

test("POST /api/foundry/push-item: real round trip for a Plutonium-sourced item -> import_via_plutonium with the raw record", async () => {
  const item = saveItem(WORLD, { name: "Bag of Holding", sourceText: "DMG p155 via Plutonium", status: "accepted" });
  let capturedEntry = null;
  const watcher = armFakeWatcher(WORLD, (ops) => ops[0].kind === "import_via_plutonium", (ops) => {
    capturedEntry = ops[0].data.entry;
    return [{ opId: ops[0].opId, ok: true, foundryUuid: "Item.route2" }];
  });

  const { status, body } = await postJson("/api/foundry/push-item", { world: WORLD, itemId: item.id });
  clearInterval(watcher);

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(capturedEntry, BAG_OF_HOLDING);
  assert.equal(getItem(WORLD, item.id).foundryItemRef, "Item.route2");
});

test("POST /api/foundry/push-item: missing itemId -> 400", async () => {
  const { status, body } = await postJson("/api/foundry/push-item", { world: WORLD });
  assert.equal(status, 400);
  assert.match(body.error, /itemId/);
});

test("POST /api/foundry/push-item: already-pushed item -> 400 with a clear error", async () => {
  const item = saveItem(WORLD, { name: "Already There", foundryItemRef: "Item.existing", status: "accepted" });
  const { status, body } = await postJson("/api/foundry/push-item", { world: WORLD, itemId: item.id });
  assert.equal(status, 400);
  assert.match(body.error, /already in Foundry/);
});

test("POST /api/combat-planning/items/:id/push-overrides: sets, then clears with null", async () => {
  const item = saveItem(WORLD, { name: "Necklace Base", status: "accepted" });

  const set = await postJson(`/api/combat-planning/items/${item.id}/push-overrides`, {
    world: WORLD,
    overrides: { displayName: "Necklace of Fireballs (one bead)", usesValue: 1, usesMax: 1, recharges: false }
  });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.item.pushOverrides, { displayName: "Necklace of Fireballs (one bead)", usesValue: 1, usesMax: 1, recharges: false });

  const cleared = await postJson(`/api/combat-planning/items/${item.id}/push-overrides`, { world: WORLD, overrides: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.item.pushOverrides, null);
});

test("POST /api/combat-planning/items/:id/push-overrides: an unknown key -> 400 (loud ZodError, never silently dropped)", async () => {
  const item = saveItem(WORLD, { name: "Bad Overrides Item", status: "accepted" });
  const { status } = await postJson(`/api/combat-planning/items/${item.id}/push-overrides`, {
    world: WORLD,
    overrides: { notARealField: true }
  });
  assert.equal(status, 400);
});

test("push-item then lostech overrides: a full two-op round trip through the real routes", async () => {
  const item = saveItem(WORLD, { name: "Bag of Holding", sourceText: "DMG p155 via Plutonium", status: "accepted" });
  await postJson(`/api/combat-planning/items/${item.id}/push-overrides`, {
    world: WORLD,
    overrides: { usesValue: 1, usesMax: 1, recharges: false }
  });

  const capturedOps = [];
  const opsPath = foundryOpsPath(dataDir, WORLD);
  const resultsPath = foundryResultsPath(dataDir, WORLD);
  const interval = setInterval(() => {
    if (!existsSync(opsPath)) return;
    let ops;
    try {
      ops = JSON.parse(readFileSync(opsPath, "utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(ops) || !ops.length) return;
    capturedOps.push(...ops);
    const responses = ops.map((op) => op.kind === "import_via_plutonium"
      ? { opId: op.opId, ok: true, foundryUuid: "Item.lostech-route" }
      : { opId: op.opId, ok: true, foundryUuid: op.data.itemUuid });
    seedFile(resultsPath, responses);
    writeFileSync(opsPath, "[]", "utf8");
    if (capturedOps.some((o) => o.kind === "update_item")) clearInterval(interval);
  }, 20);

  const { status, body } = await postJson("/api/foundry/push-item", { world: WORLD, itemId: item.id });
  clearInterval(interval);

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.foundryUuid, "Item.lostech-route");
  assert.equal(capturedOps.length, 2);
  assert.equal(capturedOps[0].kind, "import_via_plutonium");
  assert.equal(capturedOps[1].kind, "update_item");
  assert.deepEqual(capturedOps[1].data.patch, { "system.uses": { value: 1, max: 1, recovery: [] } });
});

test("POST /api/foundry/push-bestiary-entry: real round trip -> import_via_plutonium {kind:'creature'}, foundryActorRef set", async () => {
  const entry = saveBestiaryEntry({ rawFields: { name: "Goblin" }, sourceText: "MM p166 via Plutonium" });
  let capturedData = null;
  const watcher = armFakeWatcher(WORLD, (ops) => ops[0].kind === "import_via_plutonium", (ops) => {
    capturedData = ops[0].data;
    return [{ opId: ops[0].opId, ok: true, foundryUuid: "Actor.route1" }];
  });

  const { status, body } = await postJson("/api/foundry/push-bestiary-entry", { world: WORLD, entryId: entry.id });
  clearInterval(watcher);

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.foundryUuid, "Actor.route1");
  assert.equal(capturedData.kind, "creature");
  assert.deepEqual(capturedData.entry, GOBLIN);
  assert.equal(getBestiaryEntry(entry.id).foundryActorRef, "Actor.route1");
});

test("POST /api/foundry/push-bestiary-entry: missing entryId -> 400", async () => {
  const { status, body } = await postJson("/api/foundry/push-bestiary-entry", { world: WORLD });
  assert.equal(status, 400);
  assert.match(body.error, /entryId/);
});

test("POST /api/foundry/push-bestiary-entry: a non-Plutonium entry -> 400 with a clear error", async () => {
  const entry = saveBestiaryEntry({ rawFields: { name: "Homebrew Thing" }, sourceText: "hand-authored" });
  const { status, body } = await postJson("/api/foundry/push-bestiary-entry", { world: WORLD, entryId: entry.id });
  assert.equal(status, 400);
  assert.match(body.error, /no Plutonium provenance/);
});

test("SECURITY: POST /api/foundry/push-item rejects a path-traversal-shaped world id with 400 (checked before any file read)", async () => {
  const { status, body } = await postJson("/api/foundry/push-item", { world: "../../../../etc", itemId: "whatever" });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

void __dirname;
