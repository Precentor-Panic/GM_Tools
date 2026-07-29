import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — session-planner/flags.mjs (Phase 16 task 16.3).
 * This module does not exist yet; this file is the interface spec for it,
 * per plans/phase-16-tasks.md task 16.0. It is expected to fail with
 * "Cannot find module" until 16.3 lands.
 *
 * Design record §5: TWO INDEPENDENT flags, deliberately never merged into
 * one signal -- "a fully-written node can still be structurally fragile; a
 * fully-connected node can still be unwritten. These are different DM
 * responses (write more vs. add another edge) and must stay two separate
 * flags." Both accept a corridor-distance value (session-planner/corridor.mjs's
 * output) purely to pass through onto the returned object -- the actual
 * loud-in-corridor/quiet-beyond severity SCOPING is session-planner/brief.mjs's
 * (16.5) job, not either of these two functions'.
 *
 * ---------------------------------------------------------------------------
 * contentReadinessFlag(world, entityId, distance)
 * ---------------------------------------------------------------------------
 * "Edge of the world" / content-readiness flag. STORE I/O: reads
 * mutation-engine/entity-narration.mjs's getCurrentEntityNarration(world,
 * entityId) and mutation-engine/pending-ledger.mjs's readAvailablePending(
 * world, entityId) -- no new schema, purely a read-composition of two
 * existing stores. Tests importing this module MUST isolate
 * GM_TOOLS_ENTITY_NARRATION_DIR, GM_TOOLS_PENDING_LEDGER_DIR, and
 * GM_TOOLS_REVIEW_STATE_DIR (both sibling stores reuse review-state.mjs's
 * withLock).
 *
 *   @param {string} world
 *   @param {string} entityId
 *   @param {number|null} distance   the entity's corridor distance (from
 *                                   session-planner/corridor.mjs's tagged
 *                                   output), or null if the caller doesn't
 *                                   have one (e.g. a beyond-corridor sweep).
 *                                   Passed straight through onto the result,
 *                                   never inspected/branched on internally.
 *   @returns {{
 *     entityId: string,
 *     distance: number|null,
 *     flagged: boolean,
 *     reasons: Array<'no-narration'|'pending-debt'>
 *   }}
 *   reasons includes 'no-narration' when getCurrentEntityNarration returns
 *   null/falsy, and 'pending-debt' when readAvailablePending returns a
 *   non-empty array. EITHER reason alone is enough to set flagged:true (an
 *   entity can have prior narration but still have fresh unresolved
 *   deferred debt sitting on it -- that's still "you haven't caught this up
 *   yet"). flagged:false and reasons:[] when neither condition holds.
 *
 * ---------------------------------------------------------------------------
 * structuralUnderConnectionFlag(entities, edges, entityId, distance, { minEdges })
 * ---------------------------------------------------------------------------
 * PURE graph function, zero store I/O (matches propagate.mjs's convention).
 * Reuses wf-mcp-server/lib/graph.mjs's edgesFor() for the count, not a
 * second edge-counting loop.
 *
 *   @param {object[]} entities
 *   @param {object[]} edges
 *   @param {string} entityId
 *   @param {number|null} distance   same pass-through convention as above
 *   @param {object} [opts]
 *   @param {number} [opts.minEdges]   default DEFAULT_MIN_EDGES (exported)
 *   @returns {{
 *     entityId: string,
 *     distance: number|null,
 *     flagged: boolean,
 *     edgeCount: number,
 *     minEdges: number
 *   }}
 *   flagged := edgeCount < minEdges.
 *
 * ---------------------------------------------------------------------------
 * DEFAULT_MIN_EDGES
 * ---------------------------------------------------------------------------
 * Exported constant, the structural flag's default threshold.
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

// Isolate every sibling store this module composes reads from, BEFORE
// importing it -- same isolation pattern as test/pending-ledger.test.mjs /
// test/entity-narration.test.mjs.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-session-planner-flags-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");

const WORLD = "session-planner-flags-test-world";

function threeNodeGraph() {
  // hub has 2 edges (well-connected); leaf has 1 edge (under-connected at
  // the default minEdges=2 threshold).
  const entities = [
    { id: "hub", name: "Hub", type: "place" },
    { id: "leaf", name: "Leaf", type: "person" },
    { id: "other", name: "Other", type: "person" }
  ];
  const edges = [
    { id: "eA", sourceId: "hub", targetId: "leaf", relationshipType: "presence" },
    { id: "eB", sourceId: "hub", targetId: "other", relationshipType: "presence" }
  ];
  return { entities, edges };
}

(async () => {
  const { saveEntityNarration } = await import("../../mutation-engine/entity-narration.mjs");
  const { writePending } = await import("../../mutation-engine/pending-ledger.mjs");
  const { contentReadinessFlag, structuralUnderConnectionFlag, DEFAULT_MIN_EDGES } =
    await import("../../session-planner/flags.mjs");

  // ------------------------------------------------------- contentReadinessFlag

  test("contentReadinessFlag: flagged with reason 'no-narration' for a never-narrated entity with no pending debt", () => {
    const result = contentReadinessFlag(WORLD, "npc-never-narrated", 2);
    assert.equal(result.flagged, true);
    assert.deepEqual(result.reasons, ["no-narration"]);
    assert.equal(result.entityId, "npc-never-narrated");
    assert.equal(result.distance, 2, "distance is passed through unchanged");
  });

  test("contentReadinessFlag: not flagged once the entity has current narration and no pending debt", () => {
    saveEntityNarration(WORLD, "npc-narrated", { prose: "A grizzled veteran of the border wars." }, { makeId: () => "n1", now: "2026-07-22T00:00:00.000Z" });
    const result = contentReadinessFlag(WORLD, "npc-narrated", 1);
    assert.equal(result.flagged, false);
    assert.deepEqual(result.reasons, []);
  });

  test("contentReadinessFlag: flagged with reason 'pending-debt' even when the entity DOES have current narration (debt is a separate live signal)", () => {
    saveEntityNarration(WORLD, "npc-narrated-with-debt", { prose: "Runs the quartermaster's stores." }, { makeId: () => "n2", now: "2026-07-22T00:05:00.000Z" });
    writePending(WORLD, "npc-narrated-with-debt", {
      causeTag: "npc-narrated-with-debt: raided (cycle 1)",
      impactScore: 0.4,
      sourceBatchId: "batch_fixture",
      cycleDescriptor: "cycle 1"
    });
    const result = contentReadinessFlag(WORLD, "npc-narrated-with-debt", 0);
    assert.equal(result.flagged, true);
    assert.deepEqual(result.reasons, ["pending-debt"]);
  });

  // -------------------------------------------------- structuralUnderConnectionFlag

  test("structuralUnderConnectionFlag: flagged for a node below DEFAULT_MIN_EDGES", () => {
    const { entities, edges } = threeNodeGraph();
    const result = structuralUnderConnectionFlag(entities, edges, "leaf", 1, {});
    assert.equal(result.flagged, true);
    assert.equal(result.edgeCount, 1);
    assert.equal(result.minEdges, DEFAULT_MIN_EDGES);
    assert.equal(result.distance, 1);
  });

  test("structuralUnderConnectionFlag: not flagged for a well-connected node", () => {
    const { entities, edges } = threeNodeGraph();
    const result = structuralUnderConnectionFlag(entities, edges, "hub", 0, {});
    assert.equal(result.flagged, false);
    assert.equal(result.edgeCount, 2);
  });

  test("structuralUnderConnectionFlag: minEdges is caller-tunable", () => {
    const { entities, edges } = threeNodeGraph();
    const result = structuralUnderConnectionFlag(entities, edges, "hub", 0, { minEdges: 3 });
    assert.equal(result.flagged, true, "hub has only 2 edges, below an explicit minEdges of 3");
  });

  // ------------------------------------------------------- THE INDEPENDENCE TEST

  test("THE INDEPENDENCE TEST: content-readiness fires WITHOUT structural under-connection (well-connected but never narrated)", () => {
    const { entities, edges } = threeNodeGraph();
    // "hub" is well-connected (2 edges, >= DEFAULT_MIN_EDGES) but has never
    // been narrated and carries no pending debt in this fresh world.
    const content = contentReadinessFlag(WORLD, "hub", 0);
    const structural = structuralUnderConnectionFlag(entities, edges, "hub", 0, {});
    assert.equal(content.flagged, true, "content-readiness must fire: never narrated");
    assert.equal(structural.flagged, false, "structural flag must NOT fire: hub is well-connected");
  });

  test("THE INDEPENDENCE TEST (reverse direction): structural under-connection fires WITHOUT content-readiness (narrated but sparsely connected)", () => {
    const { entities, edges } = threeNodeGraph();
    saveEntityNarration(WORLD, "leaf", { prose: "A quiet hamlet at the edge of the map." }, { makeId: () => "n3", now: "2026-07-22T00:10:00.000Z" });
    const content = contentReadinessFlag(WORLD, "leaf", 1);
    const structural = structuralUnderConnectionFlag(entities, edges, "leaf", 1, {});
    assert.equal(content.flagged, false, "content-readiness must NOT fire: leaf has current narration and no pending debt");
    assert.equal(structural.flagged, true, "structural flag must fire: leaf has only 1 edge, below DEFAULT_MIN_EDGES");
  });

  console.log(`\n${passed} passed`);
})();

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
