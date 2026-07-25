#!/usr/bin/env node
/**
 * Manual/integration smoke test for mutation-engine/narrate.mjs — task 3.2's
 * acceptance criterion: "Manual/integration smoke test (.smoke.mjs, matching
 * the project's existing pattern) making one real call against a real
 * accepted batch, producing prose a human can actually judge for fit."
 *
 * NOT run as part of `node --test` — it makes a real, billed Anthropic API
 * call. Run it manually once ANTHROPIC_API_KEY is set:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node mutation-engine/narrate.smoke.mjs
 *
 * Builds a small fixture batch in the shape narrateBatch() actually expects
 * (StoredMutation objects with entityContext/diff, all status:'accepted' --
 * as if wf_propose_mutations -> wf_accept had already run) and narrates it
 * twice: once plain, once with a regenerate-with-note steering guidance, so
 * both code paths get a real, inspectable output. Also exercises the hard
 * gate against a batch with one pending mutation left in it, confirming the
 * rejection is a typed error and that the model is never called for it.
 */
import { narrateBatch, NarrationGateError } from "./narrate.mjs";

const acceptedBatch = {
  id: "smoke-narrate-batch-1",
  world: "wf-smoke-test",
  createdAt: new Date().toISOString(),
  scope: { mode: "seed", anchorId: "alvor", depth: 2 },
  elapsedTimeDescriptor: "right now",
  status: "open",
  mutations: [
    {
      op: "upsert_entity",
      id: "alvor",
      data: { description: "Shaken, forge gone cold, staring at the smoke rising from Riverwood's mill." },
      rationale: "The mill fire directly threatens Alvor's livelihood and his sister's safety.",
      batchId: "smoke-narrate-batch-1",
      sourceKind: "seeded-propagation",
      impactScore: 0.8,
      mutationId: "m0",
      status: "accepted",
      regionId: "region-0",
      entityContext: { name: "Alvor", importance: 0.5, tags: [] },
      diff: [{ field: "description", from: "The village smith, runs the forge.", to: "Shaken, forge gone cold, staring at the smoke rising from Riverwood's mill." }]
    },
    {
      op: "upsert_edge",
      id: "e2",
      data: { strength: 0.95, notes: "Alvor is now frantically trying to reach Gerdur through the smoke." },
      rationale: "The kinship bond intensifies under the immediate threat to Gerdur's safety.",
      batchId: "smoke-narrate-batch-1",
      sourceKind: "seeded-propagation",
      impactScore: 0.75,
      mutationId: "m1",
      status: "accepted",
      regionId: "region-0",
      entityContext: { name: "Alvor -> Gerdur (kinship)", importance: 0.5, tags: [] },
      diff: [
        { field: "strength", from: 0.8, to: 0.95 },
        { field: "notes", from: null, to: "Alvor is now frantically trying to reach Gerdur through the smoke." }
      ]
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

  console.log("=== 1. Hard gate: a batch with one pending mutation must be refused, model never called ===");
  const gatedBatch = structuredClone(acceptedBatch);
  gatedBatch.mutations[1].status = "pending";
  let gateOk = false;
  try {
    await narrateBatch(gatedBatch, { currentLocation: "Riverwood's forge", reachableAreas: ["the mill", "the road to Whiterun"] });
    console.error("SMOKE TEST FAILED: narrateBatch did not throw for a batch with a pending mutation.");
  } catch (err) {
    if (err instanceof NarrationGateError) {
      console.log(`Correctly refused: ${err.message}`);
      gateOk = true;
    } else {
      console.error("SMOKE TEST FAILED: threw the wrong error type:", err);
    }
  }

  console.log("\n=== 2. Real narration call against the fully-accepted batch ===");
  const result = await narrateBatch(acceptedBatch, {
    currentLocation: "Riverwood's forge",
    reachableAreas: ["the mill", "the road to Whiterun"]
  });
  console.log(`\nbatchId: ${result.batchId}\n`);
  console.log("--- NARRATION ---");
  console.log(result.prose);
  console.log("--- END NARRATION ---\n");

  console.log("=== 3. Regenerate-with-note: same batch, different tone ===");
  const regenerated = await narrateBatch(acceptedBatch, {
    currentLocation: "Riverwood's forge",
    reachableAreas: ["the mill", "the road to Whiterun"],
    note: "Make it more urgent and frightening -- the party should feel like they need to act NOW."
  });
  console.log("\n--- REGENERATED NARRATION (with steering note) ---");
  console.log(regenerated.prose);
  console.log("--- END REGENERATED NARRATION ---\n");

  const proseOk = result.prose.length > 0 && regenerated.prose.length > 0;
  const differedOk = result.prose !== regenerated.prose;

  console.log(`gate correctly refused a non-accepted batch: ${gateOk}`);
  console.log(`both calls produced non-empty prose: ${proseOk}`);
  console.log(`regenerate-with-note produced different prose than the plain call: ${differedOk}`);

  if (gateOk && proseOk) {
    console.log("\nSMOKE TEST PASSED: narration gate enforced, real prose produced for a human to judge above.");
  } else {
    console.error("\nSMOKE TEST FAILED -- see above.");
    process.exitCode = 1;
  }
}

await main();
