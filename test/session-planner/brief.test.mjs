import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — session-planner/brief.mjs (Phase 16 task 16.5).
 * This module does not exist yet; this file is the interface spec for it,
 * per plans/phase-16-tasks.md task 16.0. It is expected to fail with
 * "Cannot find module" until 16.5 lands.
 *
 * Pure orchestration over the modules built in 16.1-16.4 -- STORE I/O
 * happens (via contentReadinessFlag / getCurrentEntityNarration /
 * listPendingNotes), so tests importing this module must isolate every
 * sibling store's env var, same as test/session-planner/flags.test.mjs.
 *
 * ---------------------------------------------------------------------------
 * buildSessionBrief(world, snapshot, scene, { corridorTolerance })
 * ---------------------------------------------------------------------------
 *   @param {string} world
 *   @param {{entities:object[], edges:object[]}} snapshot   the FULL live
 *          snapshot (not pre-filtered) -- brief.mjs needs the whole graph
 *          both to build the corridor (session-planner/corridor.mjs) AND to
 *          sweep every OTHER entity for the beyond-corridor collapsed flag
 *          counts (design record §5).
 *   @param {object} scene   a session-planner/scenes.mjs Scene record (at
 *          minimum {id, locationEntityId} are read; scene.locationEntityId
 *          is corridorNodes()'s single-point path root for this phase --
 *          multi-point routes are exercised directly at the corridor.mjs
 *          layer, not yet wired through the scene store).
 *   @param {object} [opts]
 *   @param {number} [opts.corridorTolerance]   default a small positive int
 *          (implementation's choice; passed straight to corridorNodes)
 *   @returns {{
 *     sceneId: string,
 *     path: string[],                 // corridorNodes()'s own input path
 *     locations: Array<{
 *       entityId: string,
 *       distance: number,
 *       digest: {name,roleTag,hook}|null,      // session-planner/digest.mjs's buildAmbientDigestEntry output
 *       contentFlag: object,                    // session-planner/flags.mjs's contentReadinessFlag FULL result (loud -- in-corridor)
 *       structuralFlag: object,                 // structuralUnderConnectionFlag FULL result (loud -- in-corridor)
 *       notes: object[]                         // this entity's own unconsumed session-planner/session-notes.mjs notes (anchorEntityId match)
 *     }>,
 *     beyondCorridor: {
 *       contentReadinessCount: number,   // COUNT ONLY (quiet/collapsed, §5) of
 *                                        // flagged.true entities OUTSIDE the
 *                                        // corridor set -- never per-entity detail
 *       structuralUnderConnectionCount: number
 *     }
 *   }}
 *
 *   HARD REQUIREMENT (design record §7, a data-shape decision as much as a
 *   UI one): the returned structure must contain NO ordinal/chapter-
 *   numbering field ANYWHERE in its shape -- no `order`, `chapter`,
 *   `chapterNumber`, `sequence`, `step`, `stopNumber`, `position`, `ordinal`,
 *   or `rank` key at any depth. `locations` is an unordered/distance-tagged
 *   collection, not a numbered sequence.
 *
 * ---------------------------------------------------------------------------
 * checkStaleness(world, scene, currentLocationEntityId)
 * ---------------------------------------------------------------------------
 * Proactive staleness detection (design record §7): compares the scene's
 * anchor location against wherever the party actually currently is, IF
 * that's been recorded. Pure comparison, no store I/O of its own.
 *   @param {string} world
 *   @param {object} scene                     {locationEntityId, ...}
 *   @param {string|null|undefined} currentLocationEntityId
 *   @returns {{
 *     stale: boolean,
 *     sceneLocationEntityId: string|null,
 *     currentLocationEntityId: string|null,
 *     reason?: 'no-current-position-recorded'
 *   }}
 *   - currentLocationEntityId is null/undefined ("hasn't been recorded"):
 *     stale:false, reason:'no-current-position-recorded' (can't flag
 *     staleness without data to compare against).
 *   - otherwise: stale := scene.locationEntityId !== currentLocationEntityId.
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

/** Recursively walk a value, collecting every own key name seen at any depth -- for the "no ordinal/chapter field anywhere" assertion. */
function collectAllKeys(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return seen;
  if (Array.isArray(value)) {
    for (const item of value) collectAllKeys(item, seen);
    return seen;
  }
  for (const [key, val] of Object.entries(value)) {
    seen.add(key);
    collectAllKeys(val, seen);
  }
  return seen;
}

const ORDINAL_FIELD_NAMES = /^(order|chapter|chapternumber|sequence|step|stopnumber|position|ordinal|rank)$/i;

// Isolate every sibling store buildSessionBrief/checkStaleness compose reads
// from, before importing.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-session-planner-brief-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_SESSION_NOTES_DIR = join(scratchDir, "session-notes");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");

const WORLD = "session-planner-brief-test-world";

function fixtureSnapshot() {
  // a (home base / scene anchor) -- b (one hop away, in-corridor at tolerance 1)
  // f is a fully isolated entity: no edges at all, so it's OUTSIDE the
  // corridor regardless of tolerance -- the beyond-corridor sweep target.
  const entities = [
    { id: "a", name: "Home Base", type: "place" },
    { id: "b", name: "Neighbor Village", type: "place" },
    { id: "f", name: "Forgotten Ruin", type: "place" }
  ];
  const edges = [{ id: "e1", sourceId: "a", targetId: "b", relationshipType: "presence" }];
  return { entities, edges };
}

(async () => {
  const { createScene } = await import("../../session-planner/scenes.mjs");
  const { captureNote } = await import("../../session-planner/session-notes.mjs");
  const { buildSessionBrief, checkStaleness } = await import("../../session-planner/brief.mjs");

  // ------------------------------------------------------------- checkStaleness

  test("checkStaleness: not stale when the current position matches the scene's anchor location", () => {
    const scene = { id: "s1", locationEntityId: "a" };
    const result = checkStaleness(WORLD, scene, "a");
    assert.equal(result.stale, false);
    assert.equal(result.sceneLocationEntityId, "a");
    assert.equal(result.currentLocationEntityId, "a");
  });

  test("checkStaleness: stale when the party's actual current position has diverged from the scene's anchor (design record §7)", () => {
    const scene = { id: "s1", locationEntityId: "a" };
    const result = checkStaleness(WORLD, scene, "some-other-location");
    assert.equal(result.stale, true);
  });

  test("checkStaleness: not stale (and says why) when no current position has been recorded at all", () => {
    const scene = { id: "s1", locationEntityId: "a" };
    const result = checkStaleness(WORLD, scene, null);
    assert.equal(result.stale, false);
    assert.equal(result.reason, "no-current-position-recorded");
  });

  // -------------------------------------------------------------- buildSessionBrief

  test("buildSessionBrief: corridor entities get FULL per-node flag detail; the beyond-corridor entity collapses into a count only (design record §5)", () => {
    const { entities, edges } = fixtureSnapshot();
    const scene = createScene(WORLD, { locationEntityId: "a" }, { makeId: () => "brief-scene-1", now: "2026-07-22T20:00:00.000Z" });

    const brief = buildSessionBrief(WORLD, { entities, edges }, scene, { corridorTolerance: 1 });

    assert.equal(brief.sceneId, scene.id);
    const locationIds = brief.locations.map((l) => l.entityId).sort();
    assert.deepEqual(locationIds, ["a", "b"], "only in-corridor entities get a full per-node entry -- 'f' must NOT appear here");

    for (const loc of brief.locations) {
      assert.equal(typeof loc.distance, "number");
      assert.ok(loc.contentFlag && typeof loc.contentFlag.flagged === "boolean", "in-corridor nodes get FULL flag detail, not just a boolean");
      assert.ok(loc.structuralFlag && typeof loc.structuralFlag.flagged === "boolean");
      assert.ok(Array.isArray(loc.notes));
    }

    // 'f' is isolated (0 edges, never narrated, no debt) -- both flags fire
    // for it, but ONLY as a collapsed count, never per-entity detail.
    assert.equal(brief.beyondCorridor.contentReadinessCount, 1);
    assert.equal(brief.beyondCorridor.structuralUnderConnectionCount, 1);
  });

  test("buildSessionBrief: a session note anchored to an in-corridor entity is attached to that entity's own location entry, not left dangling", () => {
    const { entities, edges } = fixtureSnapshot();
    const scene = createScene(WORLD, { locationEntityId: "a" }, { makeId: () => "brief-scene-2", now: "2026-07-22T20:05:00.000Z" });
    captureNote(WORLD, { text: "The gate guard mentioned strange lights over the ruin at night.", anchorEntityId: "a", sceneId: scene.id }, {
      makeId: () => "brief-note-1",
      now: "2026-07-22T20:06:00.000Z"
    });

    const brief = buildSessionBrief(WORLD, { entities, edges }, scene, { corridorTolerance: 1 });
    const locA = brief.locations.find((l) => l.entityId === "a");
    const locB = brief.locations.find((l) => l.entityId === "b");
    assert.equal(locA.notes.length, 1);
    assert.equal(locA.notes[0].id, "brief-note-1");
    assert.equal(locB.notes.length, 0, "a note anchored to 'a' must not leak onto an unrelated location's entry");
  });

  test("buildSessionBrief: degenerate single-point scene (home-base-only, no multi-stop route) still returns a real, non-empty corridor (§2.1)", () => {
    const { entities, edges } = fixtureSnapshot();
    const scene = createScene(WORLD, { locationEntityId: "a" }, { makeId: () => "brief-scene-3", now: "2026-07-22T20:10:00.000Z" });
    const brief = buildSessionBrief(WORLD, { entities, edges }, scene, { corridorTolerance: 1 });
    assert.deepEqual(brief.path, ["a"]);
    assert.ok(brief.locations.length >= 1);
  });

  test("THE NO-CHAPTER-NUMBERING TEST: buildSessionBrief's output contains no ordinal/chapter-numbering field anywhere in its shape (design record §7)", () => {
    const { entities, edges } = fixtureSnapshot();
    const scene = createScene(WORLD, { locationEntityId: "a" }, { makeId: () => "brief-scene-4", now: "2026-07-22T20:15:00.000Z" });
    const brief = buildSessionBrief(WORLD, { entities, edges }, scene, { corridorTolerance: 1 });

    const allKeys = collectAllKeys(brief);
    const offenders = [...allKeys].filter((k) => ORDINAL_FIELD_NAMES.test(k));
    assert.deepEqual(offenders, [], `no ordinal/chapter-numbering field may appear anywhere in buildSessionBrief's output, found: ${offenders.join(", ")}`);
  });

  console.log(`\n${passed} passed`);
})();

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
