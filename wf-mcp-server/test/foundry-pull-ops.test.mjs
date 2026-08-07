import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CONTRACT UNDER TEST — wf-mcp-server/lib/foundry-pull-ops.mjs's
 * pullFoundryActorsToStores(dataDir, world) (Phase 32 task 32.2, the
 * phase's PRIMARY deliverable). End-to-end against the 32.0 fixtures + real
 * (scratch-isolated) bestiary/party-roster stores on disk -- no live
 * Foundry, no mocking of the stores themselves (this is exactly the
 * composition the route/MCP tool call verbatim).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "foundry-bridge");

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

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-foundry-pull-ops-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
const dataDir = join(scratchDir, "foundrydata");

const { pullFoundryActorsToStores } = await import("../lib/foundry-pull-ops.mjs");
const { foundryIndexPath } = await import("../lib/snapshot.mjs");
const { listBestiaryEntries, acceptBestiaryEntry } = await import("../../combat-planning/bestiary-store.mjs");
const { listPartyMembers, acceptPartyMember } = await import("../../combat-planning/party-roster-store.mjs");

function writeIndexFixture(world, fixtureName) {
  const src = JSON.parse(readFileSync(join(FIXTURES_DIR, fixtureName), "utf8"));
  const dest = foundryIndexPath(dataDir, world);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(src), "utf8");
  return src;
}

const SAMPLE_WORLD = "pull-ops-sample-world";
writeIndexFixture(SAMPLE_WORLD, "foundry-index.sample.json");

test("pullFoundryActorsToStores: no index file yet -- indexFound:false, empty results, never throws", () => {
  const result = pullFoundryActorsToStores(dataDir, "never-indexed-world");
  assert.equal(result.indexFound, false);
  assert.deepEqual(result.bestiaryProposed, []);
  assert.deepEqual(result.partyProposed, []);
  assert.deepEqual(result.alreadyLinked, { bestiary: [], party: [] });
});

test("pullFoundryActorsToStores: the sample fixture's 2 monsters land in bestiaryProposed, the 1 PC lands in partyProposed, all status:'proposed'", () => {
  const result = pullFoundryActorsToStores(dataDir, SAMPLE_WORLD);
  assert.equal(result.indexFound, true);
  assert.equal(result.bestiaryProposed.length, 2);
  assert.equal(result.partyProposed.length, 1);

  const names = result.bestiaryProposed.map((e) => e.rawFields.name).sort();
  assert.deepEqual(names, ["Goblin", "Goblin Boss"]);
  assert.ok(result.bestiaryProposed.every((e) => e.status === "proposed"));
  assert.ok(result.bestiaryProposed.every((e) => typeof e.foundryActorRef === "string" && e.foundryActorRef.startsWith("Actor.")));

  assert.equal(result.partyProposed[0].name, "Elowen Ashgrove");
  assert.equal(result.partyProposed[0].status, "proposed");
  assert.equal(result.partyProposed[0].foundryActorRef, "Actor.pc001elowen");
});

test("pullFoundryActorsToStores: everything landed in the REAL stores too, not just the returned result (listBestiaryEntries/listPartyMembers agree)", () => {
  const entries = listBestiaryEntries().filter((e) => e.foundryActorRef?.startsWith("Actor.gob"));
  assert.equal(entries.length, 2);
  const members = listPartyMembers(SAMPLE_WORLD);
  assert.equal(members.length, 1);
  assert.equal(members[0].foundryActorRef, "Actor.pc001elowen");
});

test("pullFoundryActorsToStores: re-running the SAME pull UPDATES the still-proposed candidates in place -- no duplicates created", () => {
  const before = listBestiaryEntries().length;
  const beforeMembers = listPartyMembers(SAMPLE_WORLD).length;

  const result = pullFoundryActorsToStores(dataDir, SAMPLE_WORLD);
  assert.equal(result.bestiaryProposed.length, 2);
  assert.equal(result.partyProposed.length, 1);

  const after = listBestiaryEntries().length;
  const afterMembers = listPartyMembers(SAMPLE_WORLD).length;
  assert.equal(after, before, "re-ingest must UPDATE the existing proposed entries, never create new ones");
  assert.equal(afterMembers, beforeMembers, "same for party-roster members");
});

test("pullFoundryActorsToStores: accepting a candidate, then re-pulling, NEVER touches the accepted entry -- reported under alreadyLinked instead", () => {
  const bossEntryBefore = listBestiaryEntries().find((e) => e.foundryActorRef === "Actor.gob001boss");
  const accepted = acceptBestiaryEntry(bossEntryBefore.id);
  assert.equal(accepted.status, "accepted");

  const elowenBefore = listPartyMembers(SAMPLE_WORLD).find((m) => m.foundryActorRef === "Actor.pc001elowen");
  const acceptedMember = acceptPartyMember(SAMPLE_WORLD, elowenBefore.id);
  assert.equal(acceptedMember.status, "accepted");

  const result = pullFoundryActorsToStores(dataDir, SAMPLE_WORLD);

  // The accepted bestiary entry is no longer in bestiaryProposed (only the
  // still-proposed Goblin grunt is) and is reported under alreadyLinked.
  assert.equal(result.bestiaryProposed.length, 1);
  assert.equal(result.bestiaryProposed[0].rawFields.name, "Goblin");
  assert.deepEqual(result.alreadyLinked.bestiary, ["Actor.gob001boss"]);

  // The accepted party member: no longer in partyProposed, reported under alreadyLinked.
  assert.deepEqual(result.partyProposed, []);
  assert.deepEqual(result.alreadyLinked.party, ["Actor.pc001elowen"]);

  // And the accepted records themselves are provably untouched -- re-read from the store.
  const bossEntryAfter = listBestiaryEntries().find((e) => e.foundryActorRef === "Actor.gob001boss");
  assert.equal(bossEntryAfter.status, "accepted");
  assert.equal(bossEntryAfter.rawFields.hp, 21, "the accepted entry's rawFields were never overwritten by the re-pull");

  const elowenAfter = listPartyMembers(SAMPLE_WORLD).find((m) => m.foundryActorRef === "Actor.pc001elowen");
  assert.equal(elowenAfter.status, "accepted");
});

test("pullFoundryActorsToStores: the minimal fixture's single sparse monster is ingested without throwing (hp present, ac null, no attacks)", () => {
  const MINIMAL_WORLD = "pull-ops-minimal-world";
  writeIndexFixture(MINIMAL_WORLD, "foundry-index.minimal.json");

  const result = pullFoundryActorsToStores(dataDir, MINIMAL_WORLD);
  assert.equal(result.indexFound, true);
  assert.equal(result.bestiaryProposed.length, 1);
  assert.equal(result.partyProposed.length, 0);
  assert.equal(result.bestiaryProposed[0].rawFields.hp, 9);
  assert.equal(result.bestiaryProposed[0].rawFields.ac, null);
  assert.deepEqual(result.skippedActors, []);
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
