// E2 (2026-09-08): shelf abilities on Plutonium rows -- the status-independent
// action-field merge, the refresh-from-Plutonium path (a reskin keeps its own
// ability names slot-for-slot), the bulk backfill, and compactActionsLine.
// Plutonium data here is SYNTHETIC (invented creatures, invented text) --
// the IP rule covers fixtures, so never paste real 5etools stat-block text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-bestiary-actions-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
const dataDir = join(scratchDir, "foundrydata");
process.env.WF_DATA_DIR = dataDir;
process.on("exit", () => { try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ } });

const {
  saveBestiaryEntry, acceptBestiaryEntry, discardBestiaryEntry, getBestiaryEntry,
  createReskinnedBestiaryEntry,
  BESTIARY_ACTION_FIELD_KEYS, mergeBestiaryEntryActionFields, resolvePlutoniumChassis,
  refreshBestiaryEntryFromPlutonium, refreshAllBestiaryEntriesFromPlutonium, compactActionsLine,
  renameBestiaryEntryFlavor
} = await import("../../combat-planning/bestiary-store.mjs");
const { clearPlutoniumFamilyCache } = await import("../../combat-planning/plutonium-source.mjs");

// A synthetic Plutonium bestiary under the scratch data dir.
const bestiaryDir = join(dataDir, "modules", "plutonium", "data", "bestiary");
mkdirSync(bestiaryDir, { recursive: true });
const GRIT_WARDEN = {
  name: "Grit Warden", source: "SYN", page: 12, cr: "2", type: { type: "humanoid", tags: ["any race"] }, size: ["M"],
  ac: [{ ac: 15, from: ["scale mail"] }], hp: { average: 33, formula: "6d8 + 6" },
  trait: [{ name: "Sand-Sure", entries: ["The warden ignores difficult terrain made of sand."] }],
  action: [
    { name: "Multiattack", entries: ["The warden makes two Hook attacks."] },
    { name: "Hook", entries: ["{@atk mw} {@hit 5} to hit, reach 5 ft., one target. {@h}7 ({@damage 1d8 + 3}) slashing damage."] },
    { name: "Dust Gout {@recharge 5}", entries: ["The warden spits grit in a cone. {@dc 12} Dexterity save or 9 ({@damage 2d8}) bludgeoning damage."] }
  ],
  reaction: [{ name: "Brace", entries: ["The warden adds 2 to its AC against one melee attack."] }]
};
writeFileSync(join(bestiaryDir, "bestiary-syn.json"), JSON.stringify({ monster: [
  GRIT_WARDEN,
  { name: "Reprint Shell", source: "SYN", _copy: { name: "Grit Warden", source: "SYN" } }
] }), "utf8");
clearPlutoniumFamilyCache?.();

const PROVENANCE = "SYN p12 via Plutonium";
function addCompactPlutoniumRow(name = "Grit Warden") {
  // The pre-E2 shape: the compact index row only, no actions at all.
  let e = saveBestiaryEntry({ rawFields: { name, type: "humanoid (any race)", ac: 15, hp: 33, challengeRating: "2" }, sourceText: PROVENANCE });
  return acceptBestiaryEntry(e.id);
}

test("BESTIARY_ACTION_FIELD_KEYS is exactly the action vocabulary", () => {
  assert.deepEqual([...BESTIARY_ACTION_FIELD_KEYS], ["attacks", "multiattack", "rechargeAbilities", "legendaryActions", "traits"]);
});

test("mergeBestiaryEntryActionFields: status-independent, only action keys, null removes, outliers re-derived, name/ac/hp/cr untouched", () => {
  const e = addCompactPlutoniumRow();
  assert.equal(e.status, "accepted");
  const merged = mergeBestiaryEntryActionFields(e.id, {
    attacks: [{ name: "Hook", toHitBonus: 5, damageDice: "1d8+3", damageType: "slashing" }],
    multiattack: { count: 2 },
    name: "Hijack", ac: 1, hp: 1, challengeRating: "30"
  });
  assert.equal(merged.status, "accepted", "merging never changes status");
  assert.equal(merged.rawFields.name, "Grit Warden");
  assert.equal(merged.rawFields.ac, 15);
  assert.equal(merged.rawFields.hp, 33);
  assert.equal(merged.rawFields.challengeRating, "2");
  assert.equal(merged.rawFields.attacks[0].name, "Hook");
  assert.deepEqual(merged.rawFields.multiattack, { count: 2 });
  assert.equal(merged.needsConfirmation, false);
  // An implausible attack re-runs the outlier check.
  const flagged = mergeBestiaryEntryActionFields(e.id, { attacks: [{ name: "Doom", damageDice: "20d20" }] });
  assert.equal(flagged.needsConfirmation, true);
  assert.ok(flagged.outlierReasons.length > 0);
  // null removes a key; other keys survive.
  const cleared = mergeBestiaryEntryActionFields(e.id, { attacks: null });
  assert.equal("attacks" in cleared.rawFields, false);
  assert.deepEqual(cleared.rawFields.multiattack, { count: 2 });
  assert.equal(cleared.needsConfirmation, false);
  assert.equal(getBestiaryEntry(e.id).rawFields.ac, 15, "persisted");
});

test("resolvePlutoniumChassis: the row itself, a reskin's chassis, null for hand-authored", () => {
  const chassis = addCompactPlutoniumRow();
  assert.deepEqual(resolvePlutoniumChassis(chassis), { name: "Grit Warden", source: "SYN", chassisEntryId: chassis.id });
  const reskin = createReskinnedBestiaryEntry(chassis, { name: "Dune Sentinel", description: "A warden in dust-coloured wraps." });
  assert.deepEqual(resolvePlutoniumChassis(reskin), { name: "Grit Warden", source: "SYN", chassisEntryId: chassis.id });
  const hand = saveBestiaryEntry({ rawFields: { name: "Hand Thing", type: "beast", ac: 10, hp: 10 }, sourceText: "typed in by hand" });
  assert.equal(resolvePlutoniumChassis(hand), null);
  assert.equal(resolvePlutoniumChassis(null), null);
  // The chassis display now rides parsePlutoniumProvenance: a PAGELESS stamp yields a code too
  // (it used to read "" and the chassis line showed a bare name).
  const pageless = acceptBestiaryEntry(saveBestiaryEntry({ rawFields: { name: "Grit Warden", type: "humanoid", ac: 15, hp: 33 }, sourceText: "SYN via Plutonium" }).id);
  const r2 = createReskinnedBestiaryEntry(pageless, { name: "Ash Sentinel", description: "ash-grey" });
  assert.equal(r2.chassis, "Grit Warden (SYN)");
});

test("refreshBestiaryEntryFromPlutonium: a chassis row gains attacks/multiattack/recharge/traits from the record; AC/HP/CR/note stay", () => {
  const e = addCompactPlutoniumRow();
  const refreshed = refreshBestiaryEntryFromPlutonium(dataDir, e.id);
  const rf = refreshed.rawFields;
  assert.equal(rf.ac, 15);
  assert.equal(rf.hp, 33);
  assert.equal(rf.challengeRating, "2");
  assert.deepEqual(rf.attacks.map((a) => [a.name, a.toHitBonus, a.damageDice, a.damageType]), [["Hook", 5, "1d8+3", "slashing"]]);
  assert.deepEqual(rf.multiattack, { count: 2, attackNames: ["Hook"] });
  assert.equal(rf.rechargeAbilities[0].name, "Dust Gout");
  assert.equal(rf.rechargeAbilities[0].rechargeOn, "5-6");
  assert.deepEqual(rf.traits.map((t) => [t.name, t.kind]), [["Sand-Sure", "trait"], ["Brace", "reaction"]]);
  assert.ok(!JSON.stringify(rf).includes("{@"));
  assert.equal(refreshed.status, "accepted");
  // Idempotent: a second refresh is byte-identical on the action keys.
  const again = refreshBestiaryEntryFromPlutonium(dataDir, e.id);
  for (const k of BESTIARY_ACTION_FIELD_KEYS) assert.deepEqual(again.rawFields[k], rf[k]);
});

test("refresh on a reskin: reflavoured ability names/summaries survive slot-for-slot, mechanics come fresh; chassis keeps book text", () => {
  const chassis = addCompactPlutoniumRow();
  const reskin = createReskinnedBestiaryEntry(chassis, { name: "Dune Sentinel", description: "wraps and grit" });
  // First backfill -> book names.
  let r = refreshBestiaryEntryFromPlutonium(dataDir, reskin.id);
  assert.equal(r.rawFields.attacks[0].name, "Hook");
  assert.equal(r.rawFields.name, "Dune Sentinel", "the reskin's own name is not an action field");
  // A2-style reflavour: names + summaries only, mechanics verbatim.
  mergeBestiaryEntryActionFields(reskin.id, {
    attacks: [{ ...r.rawFields.attacks[0], name: "Sand-Hook", summary: "A hooked blade from under the wraps." }],
    rechargeAbilities: [{ ...r.rawFields.rechargeAbilities[0], name: "Grit Spit" }],
    traits: [{ ...r.rawFields.traits[0], name: "Dune-Footed" }, r.rawFields.traits[1]]
  });
  r = refreshBestiaryEntryFromPlutonium(dataDir, reskin.id);
  assert.equal(r.rawFields.attacks[0].name, "Sand-Hook");
  assert.equal(r.rawFields.attacks[0].summary, "A hooked blade from under the wraps.");
  assert.equal(r.rawFields.attacks[0].toHitBonus, 5, "mechanics fresh from the record");
  assert.equal(r.rawFields.attacks[0].damageDice, "1d8+3");
  assert.equal(r.rawFields.rechargeAbilities[0].name, "Grit Spit");
  assert.equal(r.rawFields.rechargeAbilities[0].rechargeOn, "5-6");
  assert.equal(r.rawFields.rechargeAbilities[0].summary.startsWith("The warden spits"), true, "an unreflavoured summary takes the book's");
  assert.deepEqual(r.rawFields.traits.map((t) => t.name), ["Dune-Footed", "Brace"]);
  // The chassis row itself still reads the book names.
  const c = refreshBestiaryEntryFromPlutonium(dataDir, chassis.id);
  assert.equal(c.rawFields.attacks[0].name, "Hook");
  assert.equal(c.rawFields.traits[0].name, "Sand-Sure");
});

test("refresh refuses cleanly: hand-authored row, missing record, reprint shell, unknown id", () => {
  const hand = saveBestiaryEntry({ rawFields: { name: "Hand Thing", type: "beast", ac: 10, hp: 10 }, sourceText: "typed in by hand" });
  assert.throws(() => refreshBestiaryEntryFromPlutonium(dataDir, hand.id), /no Plutonium provenance/);
  let gone = saveBestiaryEntry({ rawFields: { name: "Nobody", type: "beast", ac: 10, hp: 10 }, sourceText: "SYN p99 via Plutonium" });
  assert.throws(() => refreshBestiaryEntryFromPlutonium(dataDir, gone.id), /is not available/);
  // A _copy reprint shell never enters the family index, so it reads as unavailable too.
  let shell = saveBestiaryEntry({ rawFields: { name: "Reprint Shell", type: "beast", ac: 10, hp: 10 }, sourceText: "SYN via Plutonium" });
  assert.throws(() => refreshBestiaryEntryFromPlutonium(dataDir, shell.id), /reprint shell/);
  assert.throws(() => refreshBestiaryEntryFromPlutonium(dataDir, "bst_nope"), /No bestiary entry found/);
});

test("refreshAllBestiaryEntriesFromPlutonium: refreshes provenance rows + reskins, skips discarded and hand-authored, reports failures per row", () => {
  const chassis = addCompactPlutoniumRow();
  const reskin = createReskinnedBestiaryEntry(chassis, { name: "Salt Sentinel", description: "salt-crusted" });
  const hand = saveBestiaryEntry({ rawFields: { name: "Hand Thing", type: "beast", ac: 10, hp: 10 }, sourceText: "typed in by hand" });
  const discarded = discardBestiaryEntry(saveBestiaryEntry({ rawFields: { name: "Grit Warden", type: "x", ac: 1, hp: 1 }, sourceText: PROVENANCE }).id);
  const missing = saveBestiaryEntry({ rawFields: { name: "Nobody", type: "beast", ac: 10, hp: 10 }, sourceText: "SYN p99 via Plutonium" });
  const result = refreshAllBestiaryEntriesFromPlutonium(dataDir);
  assert.ok(result.refreshed.includes(chassis.id));
  assert.ok(result.refreshed.includes(reskin.id));
  assert.ok(result.skipped.includes(hand.id));
  assert.ok(result.skipped.includes(discarded.id));
  assert.ok(!result.refreshed.includes(discarded.id));
  const fail = result.failed.find((f) => f.entryId === missing.id);
  assert.ok(fail, "the missing record is reported, never thrown");
  assert.equal(fail.name, "Nobody");
  assert.match(fail.error, /is not available/);
  assert.equal(getBestiaryEntry(reskin.id).rawFields.attacks[0].name, "Hook");
});

test("compactActionsLine: one line of what a block does; null when nothing to say; trait names capped", () => {
  assert.equal(compactActionsLine(null), null);
  assert.equal(compactActionsLine({ name: "Lump", ac: 8, hp: 5 }), null);
  assert.equal(compactActionsLine({
    multiattack: { count: 2 },
    attacks: [
      { name: "Mace", toHitBonus: 4, damageDice: "1d6+2", damageType: "bludgeoning" },
      { name: "Heavy Crossbow", toHitBonus: 2, damageDice: "1d10", damageType: "piercing" }
    ],
    traits: [{ name: "Pack Tactics", summary: "x" }]
  }), "Multiattack ×2 · Mace +4 (1d6+2 bludgeoning) · Heavy Crossbow +2 (1d10 piercing) · Pack Tactics");
  assert.equal(compactActionsLine({
    attacks: [{ name: "Jab", toHitBonus: -1, damageDice: "1" }],
    rechargeAbilities: [{ name: "Gout", rechargeOn: "5-6", damageDice: "2d8" }, { name: "Howl", rechargeOn: "6" }],
    legendaryActions: { count: 3 },
    traits: Array.from({ length: 8 }, (_, i) => ({ name: `T${i + 1}`, summary: "s" }))
  }), "Jab -1 (1) · Gout (Recharge 5-6, 2d8) · Howl (Recharge 6) · Legendary ×3 · T1 · T2 · T3 · T4 · T5 · T6 · +2 more");
});

test("renameBestiaryEntryFlavor: moves a reskin's flavorName AND rawFields.name together (status-independent, chassis link + mechanics untouched); refuses a chassis/hand row and an empty name", () => {
  const chassis = addCompactPlutoniumRow();
  const reskin = createReskinnedBestiaryEntry(chassis, { name: "Dune Sentinel", description: "wraps" });
  mergeBestiaryEntryActionFields(reskin.id, { attacks: [{ name: "Sand-Hook", toHitBonus: 5, damageDice: "1d8+3", damageType: "slashing" }] });
  const renamed = renameBestiaryEntryFlavor(reskin.id, "  Wall Picket ");
  assert.equal(renamed.flavorName, "Wall Picket");
  assert.equal(renamed.rawFields.name, "Wall Picket");
  assert.equal(renamed.status, "accepted");
  assert.equal(renamed.reskinOfEntryId, chassis.id);
  assert.equal(renamed.rawFields.attacks[0].name, "Sand-Hook");
  assert.equal(getBestiaryEntry(reskin.id).flavorName, "Wall Picket", "persisted");
  assert.throws(() => renameBestiaryEntryFlavor(chassis.id, "Nope"), /only a reskin row/);
  assert.throws(() => renameBestiaryEntryFlavor(reskin.id, "  "), /non-empty flavorName/);
  assert.equal(getBestiaryEntry(chassis.id).rawFields.name, "Grit Warden");
});
