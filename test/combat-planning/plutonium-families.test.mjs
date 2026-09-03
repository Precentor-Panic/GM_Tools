import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — combat-planning/plutonium-source.mjs (Aureus to the
 * Table task G4): the generalized family-descriptor core layered on top of
 * the pre-existing bestiary-only indexer. Synthetic fixture dirs only
 * (never the real module dir); exercises the items family's real shapes
 * (item+baseitem merge, _copy skip, isBase), the generic
 * search/facets/cap path, getRawPlutoniumEntry's verbatim record, the
 * graceful not-installed state, coarse cache invalidation, and one load
 * test per rules-shaped family (variantrules/actions/conditionsdiseases/
 * skills/senses/tables).
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

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-plutonium-families-test-"));
const dataDir = join(scratchDir, "foundrydata");
const pluginDir = join(dataDir, "modules", "plutonium", "data");

const {
  loadPlutoniumFamily,
  clearPlutoniumFamilyCache,
  searchPlutoniumFamily,
  familyFacets,
  findPlutoniumRecord,
  getRawPlutoniumEntry,
  normalizeItem,
  normalizeSimpleEntry
} = await import("../../combat-planning/plutonium-source.mjs");

function writeJson(relPath, data) {
  const filePath = join(pluginDir, relPath);
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data), "utf8");
}

// --- items fixture: item.json + items-base.json, real field-shape quirks ---
const ITEMS = [
  { name: "Potion of Healing", source: "DMG", page: 187, srd: true, type: "P", rarity: "common", weight: 0.5, value: 5000, entries: ["Regain hit points."] },
  { name: "+1 All-Purpose Tool", source: "TCE", page: 119, type: "SCF", rarity: "uncommon", reqAttune: "by an artificer", wondrous: true },
  { name: "Bag of Holding", source: "DMG", page: 153, type: "AT", rarity: "uncommon", reqAttune: true, wondrous: true, weight: 15, value: 400000 },
  // _copy shell -- must be skipped entirely (unlike normalizeMonster's own softer rule).
  { name: "Alchemist's Doom", source: "SCC", page: 179, _copy: { name: "Alchemist's Fire (flask)", source: "PHB" }, type: "G", rarity: "unknown" }
];
const BASEITEMS = [
  { name: "Longsword", source: "PHB", page: 149, srd: true, type: "M", rarity: "none", weight: 3, value: 1500 },
  { name: "Alchemist's Supplies", source: "PHB", page: 154, srd: true, type: "AT", rarity: "none", weight: 8, value: 5000 }
];
writeJson("items.json", { item: ITEMS });
writeJson("items-base.json", { baseitem: BASEITEMS });

test("normalizeItem: full field set, isBase from ctx.prop, _copy always skipped", () => {
  const potion = normalizeItem(ITEMS[0], { prop: "item" });
  assert.deepEqual(potion, {
    name: "Potion of Healing", source: "DMG", page: 187, type: "P", rarity: "common",
    weight: 0.5, value: 5000, reqAttune: false, wondrous: false, isBase: false, srd: true
  });
  const tool = normalizeItem(ITEMS[1], { prop: "item" });
  assert.equal(tool.reqAttune, "by an artificer", "reqAttune string passes through verbatim");
  assert.equal(tool.wondrous, true);
  const bag = normalizeItem(ITEMS[2], { prop: "item" });
  assert.equal(bag.reqAttune, true, "reqAttune boolean passes through");
  const sword = normalizeItem(BASEITEMS[0], { prop: "baseitem" });
  assert.equal(sword.isBase, true);
  assert.equal(sword.rarity, "none", "mundane baseitem keeps rarity 'none' verbatim");
  assert.equal(normalizeItem(ITEMS[3], { prop: "item" }), null, "_copy record is always skipped");
});

test("loadPlutoniumFamily('items'): merges item.json + items-base.json, skips _copy, isBase flag correct", () => {
  const family = loadPlutoniumFamily(dataDir, "items");
  assert.equal(family.installed, true);
  assert.equal(family.count, 5, "3 items (minus the _copy shell) + 2 baseitems");
  const names = family.rows.map((r) => r.name);
  assert.ok(names.includes("Potion of Healing"));
  assert.ok(names.includes("Longsword"));
  assert.ok(!names.includes("Alchemist's Doom"), "_copy shell excluded from the family");
  const sword = family.rows.find((r) => r.name === "Longsword");
  assert.equal(sword.isBase, true);
  const potion = family.rows.find((r) => r.name === "Potion of Healing");
  assert.equal(potion.isBase, false);
  assert.deepEqual([...names].sort((a, b) => a.localeCompare(b)), names, "stable name order for pagination");
});

test("getRawPlutoniumEntry: returns the FULL verbatim raw record, not the normalized row", () => {
  const raw = getRawPlutoniumEntry(dataDir, "items", { name: "potion of healing", source: "dmg" });
  assert.deepEqual(raw, ITEMS[0], "verbatim, including fields normalizeItem drops (entries, srd, page...)");
  assert.equal(getRawPlutoniumEntry(dataDir, "items", { name: "nope", source: "DMG" }), null);
});

test("findPlutoniumRecord: (name, source) identity pair, case-insensitive; returns the NORMALIZED row", () => {
  const hit = findPlutoniumRecord(dataDir, "items", { name: "Longsword", source: "PHB" });
  assert.equal(hit.type, "M");
  assert.equal(hit.isBase, true);
  assert.equal(findPlutoniumRecord(dataDir, "items", { name: "Longsword", source: "XGE" }), null);
  assert.equal(findPlutoniumRecord(dataDir, "items", {}), null);
});

test("searchPlutoniumFamily: name substring query, exact facet-key filters, offset/limit window+cap", () => {
  const { rows } = loadPlutoniumFamily(dataDir, "items");
  const byQuery = searchPlutoniumFamily(rows, { query: "potion" });
  assert.deepEqual(byQuery.rows.map((r) => r.name), ["Potion of Healing"]);

  const byType = searchPlutoniumFamily(rows, { filters: { type: "AT" } });
  assert.deepEqual(byType.rows.map((r) => r.name).sort(), ["Alchemist's Supplies", "Bag of Holding"]);

  const bySourceAndRarity = searchPlutoniumFamily(rows, { filters: { source: "phb", rarity: "none" } });
  assert.deepEqual(bySourceAndRarity.rows.map((r) => r.name).sort(), ["Alchemist's Supplies", "Longsword"]);

  const page1 = searchPlutoniumFamily(rows, { limit: 2, offset: 0 });
  const page2 = searchPlutoniumFamily(rows, { limit: 2, offset: 2 });
  assert.equal(page1.rows.length, 2);
  assert.equal(page2.rows.length, 2);
  assert.notDeepEqual(page1.rows.map((r) => r.name), page2.rows.map((r) => r.name));
  assert.equal(page1.matched, rows.length, "matched is the FILTERED total, not the page size");

  const cap = searchPlutoniumFamily(rows, { limit: 10000 });
  assert.equal(cap.limit, 500, "limit is hard-capped at 500 regardless of what's requested");
});

test("familyFacets: source/type/rarity counts over the whole family, most-common first, no blank/null ids", () => {
  const { rows } = loadPlutoniumFamily(dataDir, "items");
  const { source, type, rarity } = familyFacets(rows, ["source", "type", "rarity"]);
  assert.equal(source[0].id, "DMG", "DMG and PHB tie at count 2 -- alphabetical tiebreak puts DMG first");
  assert.equal(source[0].count, 2);
  assert.ok(source.some((s) => s.id === "PHB" && s.count === 2));
  assert.ok(type.some((t) => t.id === "AT" && t.count === 2));
  assert.ok(rarity.some((r) => r.id === "none" && r.count === 2));
  assert.ok(!source.some((s) => s.id === null || s.id === ""));
});

test("loadPlutoniumFamily: {installed:false} on a dataDir with no plutonium module at all", () => {
  const emptyDataDir = join(scratchDir, "no-plutonium-here");
  const family = loadPlutoniumFamily(emptyDataDir, "items");
  assert.equal(family.installed, false);
  assert.deepEqual(family.rows, []);
  assert.deepEqual(family.raw, []);
  assert.equal(family.count, 0);
});

test("loadPlutoniumFamily: throws a clear error for an unknown family name", () => {
  assert.throws(() => loadPlutoniumFamily(dataDir, "not-a-real-family"), /Unknown Plutonium family/);
});

test("cache: unchanged files -> the SAME family object reused; touching a backing file rebuilds", () => {
  clearPlutoniumFamilyCache();
  const first = loadPlutoniumFamily(dataDir, "items");
  const second = loadPlutoniumFamily(dataDir, "items");
  assert.equal(first, second, "unchanged files -> cache hit, identical object");

  writeJson("items-base.json", { baseitem: [...BASEITEMS, { name: "Dagger", source: "PHB", page: 149, type: "M", rarity: "none", weight: 1, value: 200 }] });
  const future = new Date(Date.now() + 5000);
  utimesSync(join(pluginDir, "items-base.json"), future, future);

  const third = loadPlutoniumFamily(dataDir, "items");
  assert.notEqual(first, third, "changed backing file -> rebuild");
  assert.equal(third.count, first.count + 1);
  assert.ok(third.rows.some((r) => r.name === "Dagger"));
});

// --- rules-shaped families: one load test each ------------------------------

test("normalizeSimpleEntry: flattens nested {entries} recursion, skips non-string leaves, truncates ~300 chars", () => {
  const short = normalizeSimpleEntry({ name: "Bloodied", source: "XPHB", page: 362, entries: ["Half HP or fewer."] });
  assert.deepEqual(short, { name: "Bloodied", source: "XPHB", page: 362, ruleType: null, textPreview: "Half HP or fewer." });

  const nested = normalizeSimpleEntry({
    name: "Ability Check",
    source: "XPHB",
    ruleType: "C",
    entries: ["Top line.", { type: "entries", name: "Nested", entries: ["Nested line."] }, { type: "table", rows: [["a"]] }]
  });
  assert.equal(nested.ruleType, "C");
  assert.equal(nested.textPreview, "Top line. Nested line.", "string kept, nested {entries} recursed, non-string leaf (table) skipped");

  const long = normalizeSimpleEntry({ name: "Long", source: "X", entries: ["x".repeat(400)] });
  assert.equal(long.textPreview.length, 301, "300 chars + the truncation ellipsis character");
  assert.ok(long.textPreview.endsWith("…"));

  assert.equal(normalizeSimpleEntry({}), null, "unnamed record is skipped");
});

const RULES_FAMILY_FIXTURES = {
  variantrules: { file: "variantrules.json", prop: "variantrule", record: { name: "Ability Check", source: "XPHB", page: 360, ruleType: "C", entries: ["An ability check ..."] } },
  actions: { file: "actions.json", prop: "action", record: { name: "Dash", source: "PHB", page: 192, entries: ["Move up to your speed."] } },
  skills: { file: "skills.json", prop: "skill", record: { name: "Acrobatics", source: "PHB", page: 176, ability: "dex", entries: ["Dexterity (Acrobatics)."] } },
  senses: { file: "senses.json", prop: "sense", record: { name: "Blindsight", source: "PHB", page: 183, entries: ["Perceive without sight."] } },
  tables: { file: "tables.json", prop: "table", record: { name: "2,500 gp Art Objects", source: "PSX", page: 26, caption: "2,500 gp Art Objects", rows: [["1", "A"]] } }
};

for (const [family, fixture] of Object.entries(RULES_FAMILY_FIXTURES)) {
  test(`loadPlutoniumFamily('${family}'): loads its fixed file, normalizes via normalizeSimpleEntry`, () => {
    writeJson(fixture.file, { [fixture.prop]: [fixture.record] });
    const data = loadPlutoniumFamily(dataDir, family);
    assert.equal(data.installed, true);
    assert.equal(data.count, 1);
    assert.equal(data.rows[0].name, fixture.record.name);
    assert.deepEqual(data.raw[0], fixture.record, "raw record retained verbatim alongside the normalized row (JSON round-trip, not the same reference)");
  });
}

// conditionsdiseases has three props sharing one file -- its own dedicated test.
test("loadPlutoniumFamily('conditionsdiseases'): all three props (condition/disease/status) merge into one family", () => {
  writeJson("conditionsdiseases.json", {
    condition: [{ name: "Blinded", source: "PHB", page: 290, entries: ["Can't see."] }],
    disease: [{ name: "Arcane Blight", source: "IDRotF", page: 233, entries: ["A magical disease."] }],
    status: [{ name: "Bloodied", source: "XPHB", page: 362, entries: ["Half HP or fewer."] }]
  });
  const data = loadPlutoniumFamily(dataDir, "conditionsdiseases");
  assert.equal(data.installed, true);
  assert.equal(data.count, 3);
  assert.deepEqual(data.rows.map((r) => r.name).sort(), ["Arcane Blight", "Blinded", "Bloodied"]);
});

test("loadPlutoniumFamily('spells'): descriptor-only in v1 -- resolves the dir but normalize:null yields zero rows", () => {
  const spellsDir = join(pluginDir, "spells");
  mkdirSync(spellsDir, { recursive: true });
  writeFileSync(join(spellsDir, "spells-phb.json"), JSON.stringify({ spell: [{ name: "Fireball", source: "PHB" }] }), "utf8");
  const data = loadPlutoniumFamily(dataDir, "spells");
  assert.equal(data.installed, true, "the dir exists and is read");
  assert.equal(data.count, 0, "normalize:null -- v1 deliberately surfaces nothing yet");
  assert.deepEqual(data.rows, []);
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
