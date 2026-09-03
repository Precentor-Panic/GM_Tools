import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";

/**
 * CONTRACT UNDER TEST -- the accept-time narrative-state landing hook (WS4):
 * a mutation carrying entityContext.narrativeState ({truth?, stance?,
 * revealState?}, put there by writeup-import) lands in the narrative-state
 * SIDECAR (never the graph) when the GM accepts it via acceptMutationIds,
 * with full batch/mutation provenance and source:"intake" transitions.
 * Degrade: no opts.dir => a warning, never a failed accept; a batch with no
 * narrativeState anywhere accepts with an identical result shape.
 */

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-narrative-state-landing-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
// NO GM_TOOLS_NARRATIVE_STATE_DIR override: prove the landing writes the
// call-A world-dir default, beside where the snapshot would live.
delete process.env.GM_TOOLS_NARRATIVE_STATE_DIR;

const { snapshotFilePath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../mutation-engine/review-state.mjs");
const { acceptMutationIds } = await import("../lib/mutation-ops.mjs");
const { getNarrativeState } = await import("../../mutation-engine/narrative-state.mjs");

const WORLD = "narrative-state-landing-test-world";
bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

function makeBatch(mutations) {
  return createBatch(WORLD, { mode: "writeup-import" }, undefined, mutations);
}
const baseMutation = (id, extra = {}) => ({
  op: "upsert_entity", id, data: { name: id }, rationale: "test", sourceKind: "writeup-import", batchId: "x", ...extra
});

test("accepting a truth-carrying mutation lands truth+stance+revealState in the sidecar with intake provenance", () => {
  const batch = makeBatch([
    baseMutation("land-vane", {
      entityContext: {
        name: "Corvin Vane",
        narrativeState: { truth: "He drains the Source.", stance: "concealing", revealState: "hidden" }
      }
    }),
    baseMutation("land-inn", { entityContext: { name: "The Ewer" } }) // no narrativeState — must stay record-less
  ]);
  const result = acceptMutationIds(WORLD, batch.id, batch.mutations.map((m) => m.mutationId), { dir: dataDir });
  assert.deepEqual(result.accepted.length, 2);

  const record = getNarrativeState(dataDir, WORLD, "land-vane");
  assert.ok(record, "sidecar record created at accept time");
  assert.equal(record.truth, "He drains the Source.");
  assert.equal(record.stance, "concealing");
  assert.equal(record.revealState, "hidden");
  assert.equal(record.sourceBatchId, batch.id);
  assert.equal(record.sourceMutationId, batch.mutations[0].mutationId);
  assert.ok(record.transitions.every((t) => t.source === "intake"), "transitions stamped source:intake");

  assert.equal(getNarrativeState(dataDir, WORLD, "land-inn"), null, "a payload-less sibling stays fully open");
  // The world-dir default location, beside the snapshot.
  assert.ok(existsSync(join(dataDir, "worlds", WORLD, "narrative-state", "land-vane.json")));
});

test("stance-only and revealState-only payloads land without inventing the missing pieces", () => {
  const batch = makeBatch([
    baseMutation("land-cache", { entityContext: { narrativeState: { revealState: "hidden" } } }),
    baseMutation("land-marek", { entityContext: { narrativeState: { stance: "unaware" } } })
  ]);
  acceptMutationIds(WORLD, batch.id, batch.mutations.map((m) => m.mutationId), { dir: dataDir });
  const cache = getNarrativeState(dataDir, WORLD, "land-cache");
  assert.equal(cache.revealState, "hidden");
  assert.equal(cache.truth, undefined);
  const marek = getNarrativeState(dataDir, WORLD, "land-marek");
  assert.equal(marek.stance, "unaware");
  assert.equal(marek.revealState, "unrevealed", "stance-only creation takes the adjudicated default");
});

test("no opts.dir: the accept still succeeds (warning, not error) and nothing lands", () => {
  const batch = makeBatch([
    baseMutation("land-lost", { entityContext: { narrativeState: { truth: "would be lost" } } })
  ]);
  const result = acceptMutationIds(WORLD, batch.id, batch.mutations.map((m) => m.mutationId), {});
  assert.equal(result.accepted.length, 1, "accept never fails on the landing hook");
  assert.equal(getNarrativeState(dataDir, WORLD, "land-lost"), null);
});

test("a batch with no narrativeState anywhere produces the same result shape as before the hook", () => {
  const batch = makeBatch([baseMutation("land-plain")]);
  const result = acceptMutationIds(WORLD, batch.id, batch.mutations.map((m) => m.mutationId), { dir: dataDir });
  assert.deepEqual(Object.keys(result).sort(), ["accepted", "batchId", "batchStatus"]);
});

after(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});
