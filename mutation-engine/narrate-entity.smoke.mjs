#!/usr/bin/env node
/**
 * Manual/integration smoke test for mutation-engine/narrate.mjs's
 * narrateEntity() — Phase 10 task 10.2's actual acceptance-critical
 * regression test: "a real-API smoke test comparing two DIFFERENT entities'
 * narrations from the same batch and confirming they're genuinely different
 * (not the same cached text) — this is the actual regression test for the
 * bug that was found."
 *
 * NOT run as part of `node --test` — it makes real, billed Anthropic API
 * calls. Run it manually once ANTHROPIC_API_KEY is set:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node mutation-engine/narrate-entity.smoke.mjs
 *
 * Isolates entity-narration.mjs's storage into a scratch temp directory
 * BEFORE importing it (same convention this project's test files use to
 * avoid polluting the repo's real default entity-narration/ directory —
 * see test/entity-narration.test.mjs) since this script really does persist
 * a narration via saveEntityNarration on success.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-narrate-entity-smoke-"));
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");

const { narrateEntity, NarrationGateError } = await import("./narrate.mjs");
const { getCurrentEntityNarration, getEntityNarrationHistory } = await import("./entity-narration.mjs");

const WORLD = "wf-smoke-test-entity";

// A small fixture graph: Alvor (smith) <-kinship-> Gerdur (his sister, runs
// the mill) <-containment-> Riverwood (the village). Both Alvor and Gerdur
// get their own accepted mutation in the SAME batch -- this is the exact
// shape the reported bug occurred in (every row in a batch showing the same
// generic text).
const entities = [
  { id: "alvor", name: "Alvor", type: "person", description: "The village smith, runs the forge." },
  { id: "gerdur", name: "Gerdur", type: "person", description: "Alvor's sister, runs Riverwood's mill." },
  { id: "riverwood", name: "Riverwood", type: "place", description: "A small logging village." }
];
const edges = [
  { id: "e1", sourceId: "alvor", targetId: "gerdur", relationshipType: "kinship", strength: 0.9 },
  { id: "e2", sourceId: "gerdur", targetId: "riverwood", relationshipType: "containment", strength: 0.7 }
];

const acceptedBatch = {
  id: "smoke-narrate-entity-batch-1",
  world: WORLD,
  createdAt: new Date().toISOString(),
  scope: { mode: "seed", anchorId: "alvor", depth: 2 },
  elapsedTimeDescriptor: "right now",
  status: "open",
  mutations: [
    {
      op: "upsert_entity",
      id: "alvor",
      data: { description: "Shaken, forge gone cold, staring at the smoke rising from the mill." },
      rationale: "The mill fire directly threatens Alvor's livelihood and his sister's safety.",
      batchId: "smoke-narrate-entity-batch-1",
      sourceKind: "seeded-propagation",
      impactScore: 0.8,
      mutationId: "m0",
      status: "accepted",
      regionId: "region-0",
      entityContext: { name: "Alvor", importance: 0.5, tags: [] },
      diff: [{ field: "description", from: "The village smith, runs the forge.", to: "Shaken, forge gone cold, staring at the smoke rising from the mill." }]
    },
    {
      op: "upsert_entity",
      id: "gerdur",
      data: { description: "Coughing, herding the last workers out of the burning mill." },
      rationale: "The fire started in the mill itself, where Gerdur works and has authority.",
      batchId: "smoke-narrate-entity-batch-1",
      sourceKind: "seeded-propagation",
      impactScore: 0.85,
      mutationId: "m1",
      status: "accepted",
      regionId: "region-0",
      entityContext: { name: "Gerdur", importance: 0.5, tags: [] },
      diff: [{ field: "description", from: "Alvor's sister, runs Riverwood's mill.", to: "Coughing, herding the last workers out of the burning mill." }]
    }
  ]
};

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set. This smoke test makes real (small, cheap) Anthropic API calls " +
      "and cannot run without credentials. Set the env var and re-run."
    );
    process.exitCode = 1;
    return;
  }

  console.log("=== 1. Entity-grain gate: one mutation still pending must be refused, other unaffected, model never called for it ===");
  const gatedBatch = structuredClone(acceptedBatch);
  gatedBatch.mutations[1].status = "pending";
  let gateOk = false;
  try {
    await narrateEntity(gatedBatch, "m1", { world: WORLD, entities, edges });
    console.error("SMOKE TEST FAILED: narrateEntity did not throw for a pending mutation.");
  } catch (err) {
    if (err instanceof NarrationGateError) {
      console.log(`Correctly refused m1 (pending): ${err.message}`);
      gateOk = true;
    } else {
      console.error("SMOKE TEST FAILED: threw the wrong error type:", err);
    }
  }

  console.log("\n=== 2. Real narration call for ALVOR (m0) ===");
  const alvorResult = await narrateEntity(acceptedBatch, "m0", { world: WORLD, entities, edges });
  console.log("--- ALVOR NARRATION ---");
  console.log(alvorResult.prose);
  console.log("--- END ---\n");

  console.log("=== 3. Real narration call for GERDUR (m1), SAME BATCH ===");
  const gerdurResult = await narrateEntity(acceptedBatch, "m1", { world: WORLD, entities, edges });
  console.log("--- GERDUR NARRATION ---");
  console.log(gerdurResult.prose);
  console.log("--- END ---\n");

  const bothNonEmpty = alvorResult.prose.length > 0 && gerdurResult.prose.length > 0;
  const genuinelyDifferent = alvorResult.prose !== gerdurResult.prose;

  console.log("=== 4. Persistence check: both narrations durably readable back from entity-narration.mjs's store ===");
  const alvorCurrent = getCurrentEntityNarration(WORLD, "alvor");
  const gerdurCurrent = getCurrentEntityNarration(WORLD, "gerdur");
  const persistedOk =
    alvorCurrent?.prose === alvorResult.prose &&
    gerdurCurrent?.prose === gerdurResult.prose &&
    getEntityNarrationHistory(WORLD, "alvor").length === 1 &&
    getEntityNarrationHistory(WORLD, "gerdur").length === 1;
  console.log(`alvor persisted correctly: ${alvorCurrent?.prose === alvorResult.prose}`);
  console.log(`gerdur persisted correctly: ${gerdurCurrent?.prose === gerdurResult.prose}`);

  console.log(`\ngate correctly refused a non-accepted mutation while leaving the other narratable: ${gateOk}`);
  console.log(`both calls produced non-empty prose: ${bothNonEmpty}`);
  console.log(`THE REGRESSION TEST -- alvor's and gerdur's narrations are genuinely different texts (not the same cached prose): ${genuinelyDifferent}`);
  console.log(`both narrations durably persisted (per-entity, not overwriting each other): ${persistedOk}`);

  if (gateOk && bothNonEmpty && genuinelyDifferent && persistedOk) {
    console.log("\nSMOKE TEST PASSED: entity-grain gate enforced, two different entities in one batch produced genuinely different, durably-persisted narrations.");
  } else {
    console.error("\nSMOKE TEST FAILED -- see above.");
    process.exitCode = 1;
  }
}

await main().finally(() => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
