import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — combat-planning/plutonium-source.mjs (Friction
 * Wave 1 W4a): the read-only Plutonium source-layer indexer. Fixture data
 * dir only (never the real module dir); exercises the real 5etools field
 * quirks the scratch proof-of-concept found: cr as string OR {cr}, type as
 * string OR {type,tags}, ac as array of number|{ac}, hp.average, _copy
 * reprint shells, plus the graceful not-installed state and the coarse
 * mtime/file-count cache invalidation.
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

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-plutonium-source-test-"));
const dataDir = join(scratchDir, "foundrydata");
const bestiaryDir = join(dataDir, "modules", "plutonium", "data", "bestiary");

const {
  plutoniumBestiaryDir,
  crToNumber,
  normalizeMonster,
  buildPlutoniumIndex,
  loadPlutoniumIndex,
  clearPlutoniumIndexCache,
  searchPlutoniumIndex,
  plutoniumFacets,
  findPlutoniumCreature
} = await import("../../combat-planning/plutonium-source.mjs");

function writeBestiaryFile(name, monsters) {
  mkdirSync(bestiaryDir, { recursive: true });
  writeFileSync(join(bestiaryDir, name), JSON.stringify({ monster: monsters }), "utf8");
}

// --- fixture data: the REAL field-shape quirks, miniaturized -----------------
const MM_MONSTERS = [
  { name: "Guard", source: "MM", page: 347, cr: "1/8", type: { type: "humanoid", tags: ["any race"] }, size: ["M"], ac: [{ ac: 16, from: ["chain shirt", "shield"] }], hp: { average: 11, formula: "2d8 + 2" }, environment: ["urban"] },
  { name: "Veteran", source: "MM", page: 350, cr: "3", type: { type: "humanoid", tags: ["any race"] }, size: ["M"], ac: [17], hp: { average: 58, formula: "9d8 + 18" }, environment: ["urban"] },
  { name: "Arcanaloth", source: "MM", page: 313, cr: "12", type: { type: "fiend", tags: ["yugoloth"] }, size: ["M"], ac: [17], hp: { average: 104, formula: "16d8 + 32" }, legendary: undefined },
  { name: "Will-o'-Wisp", source: "MM", page: 301, cr: "2", type: "undead", size: ["T"], ac: [19], hp: { average: 22, formula: "9d4" }, environment: ["swamp"] },
  { name: "Ancient Red Dragon", source: "MM", page: 97, cr: "24", type: "dragon", size: ["G"], ac: [22], hp: { average: 546, formula: "28d20 + 252" }, legendary: [{ name: "Detect", entries: ["..."] }] },
  // A reprint shell: _copy with no cr of its own -- must be SKIPPED.
  { name: "Reprint Shell", source: "MM", _copy: { name: "Guard", source: "OLD" } },
  // cr as an OBJECT ({cr, lair}) -- must still index.
  { name: "Lair Dragon", source: "MM", page: 90, cr: { cr: "20", lair: "24" }, type: "dragon", size: ["H"], ac: [20], hp: { average: 400, formula: "..." } }
];
const TOB_MONSTERS = [
  { name: "Cave Goblin", source: "ToB", page: 12, cr: "1/4", type: { type: "humanoid", tags: ["goblinoid"] }, size: ["S"], ac: [13], hp: { average: 7, formula: "2d6" }, environment: ["underdark"] },
  // Degenerate row: no cr/type/ac/hp at all -- indexes with nulls, never throws.
  { name: "Statless Oddity", source: "ToB" }
];

writeBestiaryFile("bestiary-mm.json", MM_MONSTERS);
writeBestiaryFile("bestiary-tob.json", TOB_MONSTERS);
// A non-bestiary file and a corrupt file: both must be ignored gracefully.
writeFileSync(join(bestiaryDir, "index.json"), JSON.stringify({ mm: "bestiary-mm.json" }), "utf8");
writeFileSync(join(bestiaryDir, "bestiary-corrupt.json"), "{ not json", "utf8");

test("plutoniumBestiaryDir: resolves under the SAME dataDir the rest of the server uses", () => {
  assert.equal(plutoniumBestiaryDir("/data"), join("/data", "modules", "plutonium", "data", "bestiary"));
});

test("crToNumber: fractions, integers, junk", () => {
  assert.equal(crToNumber("1/8"), 0.125);
  assert.equal(crToNumber("1/2"), 0.5);
  assert.equal(crToNumber("12"), 12);
  assert.equal(crToNumber(3), 3);
  assert.equal(crToNumber("Unknown"), null);
  assert.equal(crToNumber(null), null);
});

test("normalizeMonster: the full quirk set -- type object w/ tags, ac array-of-object, hp.average, legendary array -> true", () => {
  const guard = normalizeMonster(MM_MONSTERS[0]);
  assert.deepEqual(guard, {
    name: "Guard", source: "MM", page: 347, cr: "1/8", crNum: 0.125,
    type: "humanoid", tags: ["any race"], size: ["M"], ac: 16, hp: 11,
    environment: ["urban"], legendary: false
  });
  const dragon = normalizeMonster(MM_MONSTERS[4]);
  assert.equal(dragon.legendary, true);
  assert.equal(dragon.ac, 22);
  const lair = normalizeMonster(MM_MONSTERS[6]);
  assert.equal(lair.cr, "20", "cr object -> its .cr");
  assert.equal(lair.crNum, 20);
  assert.equal(normalizeMonster(MM_MONSTERS[5]), null, "_copy shell without its own cr is skipped");
});

test("buildPlutoniumIndex: reads only bestiary-*.json, skips the corrupt file, counts real files, sorts by name", () => {
  const index = buildPlutoniumIndex(dataDir);
  assert.equal(index.installed, true);
  assert.equal(index.files, 2, "mm + tob; index.json is not a bestiary file, the corrupt one is skipped");
  assert.equal(index.count, 8, "7 MM rows minus the reprint shell = 6, plus 2 ToB rows");
  const names = index.creatures.map((c) => c.name);
  assert.deepEqual([...names].sort((a, b) => a.localeCompare(b)), names, "stable name order for pagination");
  const statless = index.creatures.find((c) => c.name === "Statless Oddity");
  assert.deepEqual(
    { cr: statless.cr, crNum: statless.crNum, type: statless.type, ac: statless.ac, hp: statless.hp },
    { cr: null, crNum: null, type: null, ac: null, hp: null },
    "degenerate rows index with nulls, never throw"
  );
});

test("not installed: a dataDir with no plutonium module -> {installed:false, creatures:[]}, never a throw", () => {
  const emptyDataDir = join(scratchDir, "no-plutonium-here");
  const index = loadPlutoniumIndex(emptyDataDir);
  assert.equal(index.installed, false);
  assert.deepEqual(index.creatures, []);
  assert.equal(index.count, 0);
});

test("cache: same dir state -> the SAME index object is reused; adding a file (dir mtime + count change) rebuilds", () => {
  clearPlutoniumIndexCache();
  const first = loadPlutoniumIndex(dataDir);
  const second = loadPlutoniumIndex(dataDir);
  assert.equal(first, second, "unchanged dir -> cache hit, identical object");

  writeBestiaryFile("bestiary-extra.json", [
    { name: "Extra Beast", source: "XTR", page: 1, cr: "1", type: "beast", size: ["M"], ac: [12], hp: { average: 10, formula: "..." } }
  ]);
  // Nudge the dir mtime well past the original (some filesystems have coarse timestamps).
  const future = new Date(Date.now() + 5000);
  utimesSync(bestiaryDir, future, future);

  const third = loadPlutoniumIndex(dataDir);
  assert.notEqual(first, third, "changed dir -> rebuild");
  assert.equal(third.count, first.count + 1);
  assert.ok(third.creatures.some((c) => c.name === "Extra Beast"));
});

test("searchPlutoniumIndex: text query is a case-insensitive name substring", () => {
  const { creatures } = loadPlutoniumIndex(dataDir);
  const r = searchPlutoniumIndex(creatures, { query: "dRaG" });
  assert.deepEqual(r.creatures.map((c) => c.name).sort(), ["Ancient Red Dragon", "Lair Dragon"]);
  assert.equal(r.matched, 2);
});

test("searchPlutoniumIndex: CR range bounds on crNum; CR-less rows are excluded when a bound is active", () => {
  const { creatures } = loadPlutoniumIndex(dataDir);
  const r = searchPlutoniumIndex(creatures, { crMin: 0.25, crMax: 3 });
  assert.deepEqual(r.creatures.map((c) => c.name).sort(), ["Cave Goblin", "Extra Beast", "Veteran", "Will-o'-Wisp"]);
  assert.ok(!r.creatures.some((c) => c.name === "Statless Oddity"), "no-CR rows never match a CR-bounded search");
  assert.ok(!r.creatures.some((c) => c.name === "Guard"), "1/8 < crMin 1/4");
});

test("searchPlutoniumIndex: type + source filters (case-insensitive exact), window/pagination caps the page", () => {
  const { creatures } = loadPlutoniumIndex(dataDir);
  const byType = searchPlutoniumIndex(creatures, { type: "HUMANOID" });
  assert.deepEqual(byType.creatures.map((c) => c.name).sort(), ["Cave Goblin", "Guard", "Veteran"]);
  const bySource = searchPlutoniumIndex(creatures, { source: "tob" });
  assert.equal(bySource.matched, 2);

  const page1 = searchPlutoniumIndex(creatures, { limit: 3, offset: 0 });
  const page2 = searchPlutoniumIndex(creatures, { limit: 3, offset: 3 });
  assert.equal(page1.creatures.length, 3);
  assert.equal(page2.creatures.length, 3);
  assert.notDeepEqual(page1.creatures.map((c) => c.name), page2.creatures.map((c) => c.name));
  assert.equal(page1.matched, creatures.length, "matched is the FILTERED total, not the page size");
});

test("plutoniumFacets: source/type counts over the whole index, most-common first", () => {
  const { creatures } = loadPlutoniumIndex(dataDir);
  const { sources, types } = plutoniumFacets(creatures);
  assert.equal(sources[0].id, "MM");
  assert.equal(sources[0].count, 6);
  assert.ok(types.some((t) => t.id === "humanoid" && t.count === 3));
  assert.ok(!types.some((t) => t.id === null || t.id === ""), "null/blank types never facet");
});

test("findPlutoniumCreature: (name, source) identity pair, case-insensitive; misses -> null", () => {
  const hit = findPlutoniumCreature(dataDir, { name: "arcanaloth", source: "mm" });
  assert.equal(hit.page, 313);
  assert.equal(hit.cr, "12", "the REAL MM CR 12 -- the friction note's own Arcanaloth finding");
  assert.equal(findPlutoniumCreature(dataDir, { name: "Arcanaloth", source: "ToB" }), null);
  assert.equal(findPlutoniumCreature(dataDir, {}), null);
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
