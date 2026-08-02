import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — new `combat-planning/saved-encounter.mjs`. Phase 22
 * ADDENDUM (found while grounding Phase 23's task plan, same precedent as
 * the Phase 18 addendum found while grounding Phase 19 — small, own tests,
 * single dispatch). plans/phase-21-review.md §6: "Add Encounter" must stay
 * an equal-weight sibling of "Add Event" (session-planner/session-notes.mjs's
 * captureNote), but had no persistence at all before this module.
 *
 * Storage: ONE JSON file PER WORLD -- `<savedEncountersRoot>/<world>.json`,
 * a flat array of SavedEncounter objects each carrying its own `sceneId`
 * field -- the exact same shape session-notes.mjs already uses.
 *
 * ---------------------------------------------------------------------------
 * saveEncounter(world, sceneId, {name, combination, knobs, scoreSnapshot}, opts)
 * ---------------------------------------------------------------------------
 * Persists a SNAPSHOT (plain data, JSON-round-tripped in) -- never a live
 * reference back into combat-planning/bestiary-store.mjs or a re-invocation
 * of encounter-heuristic.mjs's suggestEncounter/scoreCombination. A test
 * below proves this directly: saving an encounter, then mutating the
 * underlying bestiary entry's derivedScore via
 * updateBestiaryEntryScore, does NOT change what getSavedEncounter later
 * returns.
 *
 * ---------------------------------------------------------------------------
 * listEncountersForScene(world, sceneId) / getSavedEncounter(world, encounterId)
 * / removeSavedEncounter(world, encounterId)
 * ---------------------------------------------------------------------------
 * Standard CRUD round trip. removeSavedEncounter is idempotent-in-effect: a
 * second removal of the same id is a safe no-op (returns null), matching
 * session-planner/scene-membership.mjs's removeNodeFromScene convention.
 *
 * This module never imports combat-planning/encounter-heuristic.mjs at all
 * -- it only stores what that module's scoring functions already produced,
 * per the addendum's own "doesn't touch how scores are computed" constraint.
 */

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-saved-encounter-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SAVED_ENCOUNTERS_DIR = join(scratchDir, "saved-encounters");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");

const {
  saveEncounter,
  listEncountersForScene,
  getSavedEncounter,
  removeSavedEncounter,
  savedEncountersRoot
} = await import("../../combat-planning/saved-encounter.mjs");
const { saveBestiaryEntry, updateBestiaryEntryScore } = await import("../../combat-planning/bestiary-store.mjs");

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

const WORLD = "saved-encounter-test-world";

test("no dependency on combat-planning/encounter-heuristic.mjs -- confirmed by reading the module's own source, matching encounter-heuristic.mjs's own no-llm-call test convention", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../combat-planning/saved-encounter.mjs", import.meta.url), "utf8");
  assert.ok(!/from ["'].*encounter-heuristic\.mjs["']/.test(src), "saved-encounter.mjs must never import encounter-heuristic.mjs -- it only persists that module's output, never recomputes it");
});

test("directory isolation: savedEncountersRoot() honors GM_TOOLS_SAVED_ENCOUNTERS_DIR", () => {
  assert.equal(savedEncountersRoot(), process.env.GM_TOOLS_SAVED_ENCOUNTERS_DIR);
});

test("saveEncounter requires a sceneId -- an encounter is always attached to a scene", () => {
  assert.throws(() => saveEncounter(WORLD, null, { combination: [] }), /sceneId/);
  assert.throws(() => saveEncounter(WORLD, undefined, { combination: [] }), /sceneId/);
});

test("saveEncounter: round-trips via getSavedEncounter, defaults name when omitted", () => {
  const saved = saveEncounter(WORLD, "scene-1", {
    combination: [{ entryId: "wolf-1", count: 3 }],
    knobs: { minionRules: false },
    scoreSnapshot: { expectedScore: 42, burstCeiling: 10, snowballDelta: {}, asymmetricRiskFlag: false }
  });
  assert.ok(saved.id);
  assert.equal(saved.sceneId, "scene-1");
  assert.equal(saved.name, "Encounter", "blank/omitted name must default to a real string, not undefined/null/empty");
  assert.deepEqual(saved.combination, [{ entryId: "wolf-1", count: 3 }]);
  assert.equal(saved.scoreSnapshot.expectedScore, 42);

  const fetched = getSavedEncounter(WORLD, saved.id);
  assert.deepEqual(fetched, saved);
});

test("saveEncounter: honors an explicit name, trims whitespace", () => {
  const saved = saveEncounter(WORLD, "scene-1", { name: "  Ambush at the Bridge  ", combination: [] });
  assert.equal(saved.name, "Ambush at the Bridge");
});

test("listEncountersForScene: returns only encounters attached to that scene, in save order", () => {
  saveEncounter(WORLD, "scene-list-a", { name: "A1", combination: [] });
  saveEncounter(WORLD, "scene-list-b", { name: "B1", combination: [] });
  saveEncounter(WORLD, "scene-list-a", { name: "A2", combination: [] });

  const listA = listEncountersForScene(WORLD, "scene-list-a");
  assert.equal(listA.length, 2);
  assert.deepEqual(listA.map((e) => e.name), ["A1", "A2"]);

  const listB = listEncountersForScene(WORLD, "scene-list-b");
  assert.equal(listB.length, 1);
  assert.equal(listB[0].name, "B1");
});

test("listEncountersForScene: a never-touched scene returns [], not an error", () => {
  assert.deepEqual(listEncountersForScene(WORLD, "scene-never-touched"), []);
});

test("getSavedEncounter: an unknown id returns null, not an error", () => {
  assert.equal(getSavedEncounter(WORLD, "no-such-id"), null);
});

test("removeSavedEncounter: removes a present encounter, returns the removed record, and it disappears from list/get", () => {
  const saved = saveEncounter(WORLD, "scene-remove", { name: "To Remove", combination: [] });
  const other = saveEncounter(WORLD, "scene-remove", { name: "Stays", combination: [] });

  const removed = removeSavedEncounter(WORLD, saved.id);
  assert.equal(removed.id, saved.id);
  assert.equal(getSavedEncounter(WORLD, saved.id), null);

  const remaining = listEncountersForScene(WORLD, "scene-remove");
  assert.deepEqual(remaining.map((e) => e.id), [other.id]);
});

test("removeSavedEncounter: removing an absent/already-removed id is a safe no-op, returns null", () => {
  assert.equal(removeSavedEncounter(WORLD, "never-existed"), null);
  const saved = saveEncounter(WORLD, "scene-double-remove", { name: "X", combination: [] });
  removeSavedEncounter(WORLD, saved.id);
  assert.equal(removeSavedEncounter(WORLD, saved.id), null, "a second removal of the same id must be a no-op, not throw");
});

// ------------------------------------------------------- THE SNAPSHOT PROOF

test("SNAPSHOT PROOF: saving an encounter, then changing the underlying bestiary entry's score, does NOT change what getSavedEncounter later returns", () => {
  const bestiaryEntry = saveBestiaryEntry({
    rawFields: { name: "Wolf", hp: 11, ac: 13 },
    derivedScore: { actionEconomyScore: 7 }
  });

  const saved = saveEncounter(WORLD, "scene-snapshot", {
    name: "Wolf Pack",
    combination: [{ entryId: bestiaryEntry.id, count: 4 }],
    knobs: { scalingSlider: 1 },
    scoreSnapshot: { expectedScore: 28, burstCeiling: 0, snowballDelta: {}, asymmetricRiskFlag: false }
  });
  assert.equal(saved.scoreSnapshot.expectedScore, 28);

  // Mutate the underlying bestiary entry's score AFTER the encounter was
  // saved -- this is exactly the "underlying bestiary/roster could change
  // later" scenario the addendum spec calls out.
  updateBestiaryEntryScore(bestiaryEntry.id, { actionEconomyScore: 999 });

  const fetchedAfterMutation = getSavedEncounter(WORLD, saved.id);
  assert.equal(
    fetchedAfterMutation.scoreSnapshot.expectedScore,
    28,
    "getSavedEncounter must keep returning the score AS IT WAS AT SAVE TIME -- a live reference would now read something derived from actionEconomyScore:999"
  );
  assert.deepEqual(
    fetchedAfterMutation.combination,
    [{ entryId: bestiaryEntry.id, count: 4 }],
    "the combination itself is also an untouched snapshot"
  );
});

test("SNAPSHOT PROOF (mutation independence): mutating the object literal passed INTO saveEncounter after the call does not retroactively change the stored record", () => {
  const combination = [{ entryId: "orc-1", count: 2 }];
  const scoreSnapshot = { expectedScore: 15, burstCeiling: 0, snowballDelta: {}, asymmetricRiskFlag: false };
  const saved = saveEncounter(WORLD, "scene-mutate-after", { name: "Orcs", combination, knobs: {}, scoreSnapshot });

  combination.push({ entryId: "orc-2", count: 99 });
  scoreSnapshot.expectedScore = -1;

  const fetched = getSavedEncounter(WORLD, saved.id);
  assert.deepEqual(fetched.combination, [{ entryId: "orc-1", count: 2 }], "mutating the caller's array after the call must not affect the stored snapshot");
  assert.equal(fetched.scoreSnapshot.expectedScore, 15, "mutating the caller's scoreSnapshot object after the call must not affect the stored snapshot");
});

console.log(`\n${passed} test(s) passed.`);
rmSync(scratchDir, { recursive: true, force: true });
