import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — Friction Wave 1 W4c:
 * POST /api/combat-planning/bestiary/add-from-plutonium {name, source}
 * -> {entry}: the ONE explicit bridge from the read-only Plutonium source
 * layer onto the curated shelf. Creates an ACCEPTED bestiary entry with the
 * index row's real stats in rawFields + a "SOURCE pPAGE via Plutonium"
 * note/sourceText (deriveSourcePill -> "plutonium"). Dedupe guard: the same
 * (name, source) creature twice -> 409; a DISCARDED earlier copy doesn't
 * block a re-add. Unknown creature / missing fields -> clean 400.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-w4c-add-plutonium-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "w4c-add-plutonium-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const bestiaryDir = join(dataDir, "modules", "plutonium", "data", "bestiary");
mkdirSync(bestiaryDir, { recursive: true });
writeFileSync(join(bestiaryDir, "bestiary-mm.json"), JSON.stringify({
  monster: [
    { name: "Guard", source: "MM", page: 347, cr: "1/8", type: { type: "humanoid", tags: ["any race"] }, size: ["M"], ac: [{ ac: 16 }], hp: { average: 11 }, environment: ["urban"] },
    { name: "Arcanaloth", source: "MM", page: 313, cr: "12", type: { type: "fiend", tags: ["yugoloth"] }, size: ["M"], ac: [17], hp: { average: 104 } },
    { name: "Pageless Wisp", source: "HB", cr: "2", type: "undead", ac: [19], hp: { average: 22 } },
    // Synthetic (never real 5etools text) record carrying actions/traits, for
    // the shelf-actions mapper path (2026-09-08).
    {
      name: "Grit Warden", source: "SYN", page: 12, cr: "2", type: { type: "humanoid", tags: ["any race"] }, size: ["M"],
      ac: [{ ac: 15, from: ["scale mail"] }], hp: { average: 33, formula: "6d8 + 6" },
      trait: [{ name: "Sand-Sure", entries: ["The warden ignores difficult terrain made of sand."] }],
      action: [
        { name: "Multiattack", entries: ["The warden makes two Hook attacks."] },
        { name: "Hook", entries: ["{@atk mw} {@hit 5} to hit, reach 5 ft., one target. {@h}7 ({@damage 1d8 + 3}) slashing damage."] },
        { name: "Dust Gout {@recharge 5}", entries: ["The warden spits grit in a cone. {@dc 12} Dexterity save or 9 ({@damage 2d8}) bludgeoning damage."] }
      ],
      reaction: [{ name: "Brace", entries: ["The warden adds 2 to its AC against one melee attack."] }]
    }
  ]
}), "utf8");

const { createReviewServer } = await import("../server.mjs");
const { getBestiaryEntry, listBestiaryEntries, discardBestiaryEntry } = await import("../../combat-planning/bestiary-store.mjs");
const { clearPlutoniumIndexCache } = await import("../../combat-planning/plutonium-source.mjs");

let server, base;

before(async () => {
  clearPlutoniumIndexCache();
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

test("add-from-plutonium: creates an ACCEPTED curated entry with the real stats in rawFields + the 'SOURCE pPAGE via Plutonium' note, sourcePill 'plutonium'", async () => {
  const { status, body } = await postJson("/api/combat-planning/bestiary/add-from-plutonium", { name: "Guard", source: "MM" });
  assert.equal(status, 200);
  const entry = body.entry;
  assert.equal(entry.status, "accepted", "an explicit per-creature add is a deliberate act -- lands accepted, like hand-add");
  assert.equal(entry.rawFields.name, "Guard");
  assert.equal(entry.rawFields.type, "humanoid (any race)");
  assert.equal(entry.rawFields.ac, 16);
  assert.equal(entry.rawFields.hp, 11);
  assert.equal(entry.rawFields.challengeRating, "1/8");
  assert.equal(entry.note, "MM p347 via Plutonium");
  assert.equal(entry.sourceText, "MM p347 via Plutonium");
  assert.equal(entry.sourcePill, "plutonium", "the distinct pill -- never 'mine'/'srd'");
  assert.equal(entry.foundryActorRef, null, "nothing Foundry-facing -- import stays a manual Plutonium act");

  // Persisted for real, projection intact on a fresh read.
  const reread = getBestiaryEntry(entry.id);
  assert.equal(reread.sourcePill, "plutonium");
  assert.equal(reread.status, "accepted");
});

test("dedupe guard: adding the SAME (name, source) creature again -> 409, no second entry", async () => {
  const first = await postJson("/api/combat-planning/bestiary/add-from-plutonium", { name: "Arcanaloth", source: "MM" });
  assert.equal(first.status, 200);
  const countBefore = listBestiaryEntries().length;

  const dup = await postJson("/api/combat-planning/bestiary/add-from-plutonium", { name: "Arcanaloth", source: "MM" });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /already exists/i);
  assert.equal(listBestiaryEntries().length, countBefore, "the guard must not half-write");
});

test("dedupe guard: a DISCARDED earlier copy does NOT block a re-add (a discard was 'not this one', not 'never again')", async () => {
  const first = await postJson("/api/combat-planning/bestiary/add-from-plutonium", { name: "Pageless Wisp", source: "HB" });
  assert.equal(first.status, 200);
  assert.equal(first.body.entry.note, "HB via Plutonium", "no page -> no pN in the provenance line");

  // Discard directly through the store (accept happened, so the route's own
  // discard would refuse -- but the guard's contract is about entry STATUS,
  // however it got there).
  const raw = JSON.parse(JSON.stringify(first.body.entry));
  const { writeFileSync: wfs } = await import("node:fs");
  wfs(join(process.env.GM_TOOLS_BESTIARY_DIR, `${raw.id}.json`), JSON.stringify({ ...raw, status: "proposed" }), "utf8");
  discardBestiaryEntry(raw.id);

  const readd = await postJson("/api/combat-planning/bestiary/add-from-plutonium", { name: "Pageless Wisp", source: "HB" });
  assert.equal(readd.status, 200);
  assert.notEqual(readd.body.entry.id, raw.id, "a fresh entry, not a resurrect");
});

test("shelf actions (2026-09-08): a record with actions lands with attacks/multiattack/rechargeAbilities/traits mapped from the FULL record, tag text rendered, AC/HP/CR unchanged", async () => {
  const { status, body } = await postJson("/api/combat-planning/bestiary/add-from-plutonium", { name: "Grit Warden", source: "SYN" });
  assert.equal(status, 200);
  const rf = body.entry.rawFields;
  assert.equal(rf.ac, 15);
  assert.equal(rf.hp, 33);
  assert.equal(rf.challengeRating, "2");
  assert.equal(rf.multiattack.count, 2);
  assert.equal(rf.attacks.length, 1);
  assert.equal(rf.attacks[0].name, "Hook");
  assert.equal(rf.attacks[0].toHitBonus, 5);
  assert.equal(rf.attacks[0].damageDice, "1d8+3");
  assert.equal(rf.attacks[0].damageType, "slashing");
  assert.equal(rf.rechargeAbilities.length, 1);
  assert.equal(rf.rechargeAbilities[0].name, "Dust Gout");
  assert.equal(rf.rechargeAbilities[0].rechargeOn, "5-6");
  assert.equal(rf.rechargeAbilities[0].damageDice, "2d8");
  assert.deepEqual(rf.traits.map((t) => [t.name, t.kind]), [["Sand-Sure", "trait"], ["Brace", "reaction"]]);
  assert.ok(!JSON.stringify(rf).includes("{@"), "no 5etools tag survives onto the shelf");
  // The projection's compact actions line is derived from the same fields.
  const reread = getBestiaryEntry(body.entry.id);
  assert.equal(reread.rawFields.attacks[0].name, "Hook");
});

test("shelf actions (2026-09-08): an actions-less record still lands via the compact path -- no action keys, stats intact", async () => {
  const guard = listBestiaryEntries().find((e) => e.rawFields.name === "Guard" && e.status === "accepted");
  assert.ok(guard, "the Guard added by the first test");
  for (const key of ["attacks", "multiattack", "rechargeAbilities", "legendaryActions", "traits"]) {
    assert.equal(key in guard.rawFields, false, `${key} absent when the record carries no actions`);
  }
  assert.equal(guard.rawFields.ac, 16);
});

test("unknown creature / missing identity fields -> clean 400s", async () => {
  const unknown = await postJson("/api/combat-planning/bestiary/add-from-plutonium", { name: "Not A Real Monster", source: "MM" });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /No Plutonium creature matches/);

  const missing = await postJson("/api/combat-planning/bestiary/add-from-plutonium", { name: "Guard" });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /both required/);
});
