import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — "Aureus to the Table" task G5:
 * GET /api/combat-planning/plutonium-items?query&type&rarity&source&offset&limit
 * -> { installed, count, total, offset, limit, rows, facets: {sources, types, rarities} }
 * POST /api/combat-planning/items/add-from-plutonium {world, name, source} -> {item}
 *
 * Thin wrappers over combat-planning/plutonium-source.mjs's generalized
 * family core (task G4). GET is library-wide (no world), dataDir resolved
 * via resolveDir() (WF_DATA_DIR) ONLY. POST is WORLD-SCOPED (unlike the
 * bestiary sibling route), and refuses a path-traversal-shaped world id.
 * Fixture module dir only, never the real Plutonium install.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-plutonium-items-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_ITEM_DIR = join(scratchDir, "items");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "plutonium-items-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const pluginDataDir = join(dataDir, "modules", "plutonium", "data");
mkdirSync(pluginDataDir, { recursive: true });
const ITEMS = [
  { name: "Potion of Healing", source: "DMG", page: 187, srd: true, type: "P", rarity: "common", weight: 0.5, value: 5000 },
  { name: "Bag of Holding", source: "DMG", page: 153, type: "AT", rarity: "uncommon", reqAttune: true, wondrous: true, weight: 15, value: 400000 },
  { name: "+1 All-Purpose Tool", source: "TCE", page: 119, type: "SCF", rarity: "uncommon", reqAttune: "by an artificer", wondrous: true }
];
const BASEITEMS = [
  { name: "Longsword", source: "PHB", page: 149, srd: true, type: "M", rarity: "none", weight: 3, value: 1500 }
];
writeFileSync(join(pluginDataDir, "items.json"), JSON.stringify({ item: ITEMS }), "utf8");
writeFileSync(join(pluginDataDir, "items-base.json"), JSON.stringify({ baseitem: BASEITEMS }), "utf8");

const { createReviewServer } = await import("../server.mjs");
const { listItems } = await import("../../combat-planning/item-store.mjs");
const { clearPlutoniumFamilyCache } = await import("../../combat-planning/plutonium-source.mjs");

let server, base;

before(async () => {
  clearPlutoniumFamilyCache();
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}
async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

test("GET /api/combat-planning/plutonium-items: full family summary + first page + facets", async () => {
  const { status, body } = await getJson("/api/combat-planning/plutonium-items");
  assert.equal(status, 200);
  assert.equal(body.installed, true);
  assert.equal(body.count, 4, "3 items + 1 baseitem");
  assert.equal(body.total, 4);
  assert.equal(body.rows.length, 4);
  const potion = body.rows.find((r) => r.name === "Potion of Healing");
  assert.deepEqual(
    { source: potion.source, page: potion.page, type: potion.type, rarity: potion.rarity, isBase: potion.isBase },
    { source: "DMG", page: 187, type: "P", rarity: "common", isBase: false }
  );
  const sword = body.rows.find((r) => r.name === "Longsword");
  assert.equal(sword.isBase, true);
  assert.ok(body.facets.sources.some((s) => s.id === "DMG" && s.count === 2));
  assert.ok(body.facets.types.some((t) => t.id === "AT" && t.count === 1));
  assert.ok(body.facets.rarities.some((r) => r.id === "uncommon" && r.count === 2));
});

test("GET .../plutonium-items: query + type/rarity/source filters and pagination all work server-side", async () => {
  const byQuery = await getJson("/api/combat-planning/plutonium-items?query=potion");
  assert.deepEqual(byQuery.body.rows.map((r) => r.name), ["Potion of Healing"]);

  const byType = await getJson("/api/combat-planning/plutonium-items?type=SCF");
  assert.deepEqual(byType.body.rows.map((r) => r.name), ["+1 All-Purpose Tool"]);

  const byRarity = await getJson("/api/combat-planning/plutonium-items?rarity=uncommon");
  assert.equal(byRarity.body.total, 2);

  const bySource = await getJson("/api/combat-planning/plutonium-items?source=PHB");
  assert.deepEqual(bySource.body.rows.map((r) => r.name), ["Longsword"]);

  const page = await getJson("/api/combat-planning/plutonium-items?limit=2&offset=2");
  assert.equal(page.body.total, 4, "total stays the filtered total, not the page size");
  assert.equal(page.body.rows.length, 2, "the window is the page");
});

test("READ-ONLY: browsing the Plutonium items shelf never lands anything on the curated Reliquary", async () => {
  await getJson("/api/combat-planning/plutonium-items");
  await getJson("/api/combat-planning/plutonium-items?query=bag");
  assert.deepEqual(listItems(WORLD), [], "the source LAYER must never leak rows into the curated item store");
});

test("graceful not-installed state: WF_DATA_DIR without a plutonium module -> 200 {installed:false}, never an error", async () => {
  const bareDataDir = join(scratchDir, "bare-foundrydata");
  mkdirSync(bareDataDir, { recursive: true });
  const prev = process.env.WF_DATA_DIR;
  process.env.WF_DATA_DIR = bareDataDir;
  try {
    const bareServer = createReviewServer({ port: 0 });
    await new Promise((resolve) => bareServer.once("listening", resolve));
    const bareBase = `http://localhost:${bareServer.address().port}`;
    const res = await fetch(`${bareBase}/api/combat-planning/plutonium-items`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.installed, false);
    assert.deepEqual(body.rows, []);
    assert.equal(body.count, 0);
    await new Promise((resolve) => bareServer.close(resolve));
  } finally {
    process.env.WF_DATA_DIR = prev;
  }
});

test("add-from-plutonium: creates an ACCEPTED world-scoped item with the 'SOURCE pPAGE via Plutonium' sourceText provenance", async () => {
  const { status, body } = await postJson("/api/combat-planning/items/add-from-plutonium", { world: WORLD, name: "Potion of Healing", source: "DMG" });
  assert.equal(status, 200);
  const item = body.item;
  assert.equal(item.status, "accepted", "a deliberate per-item add lands accepted, like hand-add");
  assert.equal(item.name, "Potion of Healing");
  assert.equal(item.type, "P");
  assert.equal(item.sourceText, "DMG p187 via Plutonium");
  assert.match(item.description, /common/);
  assert.equal(item.foundryItemRef, null, "nothing Foundry-facing -- import stays a manual Plutonium act");
  assert.equal(item.world, WORLD);

  const reread = listItems(WORLD).find((i) => i.id === item.id);
  assert.equal(reread.status, "accepted");
  assert.equal(reread.sourceText, "DMG p187 via Plutonium");
});

test("dedupe guard: adding the SAME (name, source) item again in the SAME world -> 409, no second item", async () => {
  const first = await postJson("/api/combat-planning/items/add-from-plutonium", { world: WORLD, name: "Bag of Holding", source: "DMG" });
  assert.equal(first.status, 200);
  const countBefore = listItems(WORLD).length;

  const dup = await postJson("/api/combat-planning/items/add-from-plutonium", { world: WORLD, name: "Bag of Holding", source: "DMG" });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /already exists/i);
  assert.equal(listItems(WORLD).length, countBefore, "the guard must not half-write");
});

test("dedupe is per-world: the SAME (name, source) item can be added in a DIFFERENT world", async () => {
  const otherWorld = "plutonium-items-routes-test-world-2";
  const inFirst = await postJson("/api/combat-planning/items/add-from-plutonium", { world: WORLD, name: "Longsword", source: "PHB" });
  assert.equal(inFirst.status, 200);
  const inOther = await postJson("/api/combat-planning/items/add-from-plutonium", { world: otherWorld, name: "Longsword", source: "PHB" });
  assert.equal(inOther.status, 200, "world-scoped dedupe -- a different world's shelf is untouched");
  assert.notEqual(inOther.body.item.id, inFirst.body.item.id);
});

test("unknown item / missing identity fields -> clean 400s", async () => {
  const unknown = await postJson("/api/combat-planning/items/add-from-plutonium", { world: WORLD, name: "Not A Real Item", source: "DMG" });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /No Plutonium item matches/);

  const missing = await postJson("/api/combat-planning/items/add-from-plutonium", { world: WORLD, name: "Bag of Holding" });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /both required/);
});

test("SECURITY: a path-traversal-shaped world id on add-from-plutonium is rejected with a clean 400, not silently resolved", async () => {
  const { status, body } = await postJson("/api/combat-planning/items/add-from-plutonium", {
    world: "../../../../etc", name: "Potion of Healing", source: "DMG"
  });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});
