import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST -- shelf actions backfill (2026-09-08):
 *   POST /api/combat-planning/bestiary/:id/refresh-from-plutonium -> {entry}
 *     re-reads the row's Plutonium record (a reskin resolves through its
 *     chassis) and merges attacks/multiattack/rechargeAbilities/
 *     legendaryActions/traits; a reskin keeps its own reflavoured names
 *     slot-for-slot. 400 (with the entry named) for a missing id; 400 for a
 *     row with no Plutonium provenance.
 *   POST /api/combat-planning/bestiary/refresh-from-plutonium ->
 *     {refreshed, skipped, failed[]} over the whole shelf, never a thrown
 *     error for one bad row.
 * Fixture records are synthetic -- never real 5etools text.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-bestiary-refresh-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.WF_DATA_DIR = dataDir;
process.env.WF_DEFAULT_WORLD = "bestiary-refresh-routes-test-world";

const bestiaryDir = join(dataDir, "modules", "plutonium", "data", "bestiary");
mkdirSync(bestiaryDir, { recursive: true });
writeFileSync(join(bestiaryDir, "bestiary-syn.json"), JSON.stringify({ monster: [
  {
    name: "Grit Warden", source: "SYN", page: 12, cr: "2", type: { type: "humanoid", tags: ["any race"] }, size: ["M"],
    ac: [{ ac: 15, from: ["scale mail"] }], hp: { average: 33, formula: "6d8 + 6" },
    trait: [{ name: "Sand-Sure", entries: ["The warden ignores difficult terrain made of sand."] }],
    action: [
      { name: "Multiattack", entries: ["The warden makes two Hook attacks."] },
      { name: "Hook", entries: ["{@atk mw} {@hit 5} to hit, reach 5 ft., one target. {@h}7 ({@damage 1d8 + 3}) slashing damage."] }
    ]
  }
] }), "utf8");

const { createReviewServer } = await import("../server.mjs");
const {
  saveBestiaryEntry, acceptBestiaryEntry, getBestiaryEntry, createReskinnedBestiaryEntry, discardBestiaryEntry, mergeBestiaryEntryActionFields
} = await import("../../combat-planning/bestiary-store.mjs");
const { clearPlutoniumIndexCache, clearPlutoniumFamilyCache } = await import("../../combat-planning/plutonium-source.mjs");

const PROVENANCE = "SYN p12 via Plutonium";
let server, base;

before(async () => {
  clearPlutoniumIndexCache();
  clearPlutoniumFamilyCache?.();
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

async function post(path, body = {}) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

function compactChassisRow() {
  // What add-from-plutonium used to write before the mapper path: stats only.
  return acceptBestiaryEntry(saveBestiaryEntry({
    rawFields: { name: "Grit Warden", type: "humanoid (any race)", ac: 15, hp: 33, challengeRating: "2" },
    sourceText: PROVENANCE
  }).id);
}

test("per-id refresh: a compact Plutonium row gains attacks/multiattack/traits from its record; AC/HP/CR/sourceText stay", async () => {
  const row = compactChassisRow();
  assert.equal("attacks" in row.rawFields, false);
  const { status, body } = await post(`/api/combat-planning/bestiary/${row.id}/refresh-from-plutonium`);
  assert.equal(status, 200);
  const rf = body.entry.rawFields;
  assert.equal(rf.attacks[0].name, "Hook");
  assert.equal(rf.attacks[0].toHitBonus, 5);
  assert.equal(rf.multiattack.count, 2);
  assert.deepEqual(rf.traits.map((t) => t.name), ["Sand-Sure"]);
  assert.equal(rf.ac, 15);
  assert.equal(rf.hp, 33);
  assert.equal(body.entry.sourceText, PROVENANCE);
  assert.equal(body.entry.status, "accepted", "status-independent merge -- an accepted row refreshes in place");
  assert.equal(getBestiaryEntry(row.id).rawFields.attacks[0].name, "Hook", "persisted");
});

test("per-id refresh: a reskin resolves through its chassis and KEEPS its reflavoured names slot-for-slot while mechanics come from the book", async () => {
  const chassis = compactChassisRow();
  const reskin = createReskinnedBestiaryEntry(chassis, { name: "Dune Picket", description: "Same warden, desert kit." });
  // Simulate the A2 flow: reflavoured names patched on the reskin row first.
  mergeBestiaryEntryActionFields(reskin.id, {
    attacks: [{ name: "Sand-Hook", toHitBonus: 1, damageDice: "1d4", damageType: "slashing", summary: "A hooked blade from under the wraps." }],
    traits: [{ name: "Dune-Footed", summary: "Never slowed by sand.", kind: "trait" }]
  });
  const { status, body } = await post(`/api/combat-planning/bestiary/${reskin.id}/refresh-from-plutonium`);
  assert.equal(status, 200);
  const rf = body.entry.rawFields;
  assert.equal(rf.attacks[0].name, "Sand-Hook", "reflavoured name survives the refresh");
  assert.equal(rf.attacks[0].summary, "A hooked blade from under the wraps.");
  assert.equal(rf.attacks[0].toHitBonus, 5, "mechanics fresh from the record");
  assert.equal(rf.attacks[0].damageDice, "1d8+3");
  assert.equal(rf.traits[0].name, "Dune-Footed");
  assert.equal(getBestiaryEntry(chassis.id).rawFields.attacks, undefined, "the chassis row is untouched by a reskin's refresh");
});

test("per-id refresh: missing id -> clean 400 naming the entry (the shelf's convention: 404 is reserved for a missing ROUTE, see combat-planning-routes.test.mjs); a hand-authored row (no Plutonium provenance) -> 400, never 500", async () => {
  const missing = await post("/api/combat-planning/bestiary/bst_does_not_exist/refresh-from-plutonium");
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /No bestiary entry found/);

  const hand = saveBestiaryEntry({ rawFields: { name: "Hand Thug", ac: 11, hp: 9 } });
  const res = await post(`/api/combat-planning/bestiary/${hand.id}/refresh-from-plutonium`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /no Plutonium provenance/);
});

test("bulk refresh: {refreshed, skipped, failed[]} -- provenance rows + reskins refreshed, hand rows + discarded rows skipped, a row whose record is gone lands in failed with its name (never a thrown error)", async () => {
  const chassis = compactChassisRow();
  const reskin = createReskinnedBestiaryEntry(chassis, { name: "Wall Picket", description: "A warden on the wall." });
  const hand = saveBestiaryEntry({ rawFields: { name: "Hand Thug", ac: 11, hp: 9 } });
  const discarded = discardBestiaryEntry(saveBestiaryEntry({ rawFields: { name: "Grit Warden", ac: 1, hp: 1 }, sourceText: PROVENANCE }).id);
  const gone = acceptBestiaryEntry(saveBestiaryEntry({ rawFields: { name: "Nobody", ac: 10, hp: 5 }, sourceText: "SYN p99 via Plutonium" }).id);

  const { status, body } = await post("/api/combat-planning/bestiary/refresh-from-plutonium");
  assert.equal(status, 200);
  assert.ok(body.refreshed.includes(chassis.id));
  assert.ok(body.refreshed.includes(reskin.id));
  assert.ok(body.skipped.includes(hand.id));
  assert.ok(body.skipped.includes(discarded.id));
  assert.equal(body.failed.length, 1);
  assert.equal(body.failed[0].entryId, gone.id);
  assert.equal(body.failed[0].name, "Nobody");
  assert.match(body.failed[0].error, /is not available/);
  assert.equal(getBestiaryEntry(reskin.id).rawFields.attacks[0].name, "Hook", "a reskin with no prior names inherits the book names");
});
