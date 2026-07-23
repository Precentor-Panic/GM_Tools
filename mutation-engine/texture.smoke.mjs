#!/usr/bin/env node
/**
 * Manual/integration smoke test for mutation-engine/texture.mjs — task 1.5's
 * acceptance criterion: "a manual/integration smoke test (documented, not
 * necessarily automated in CI) makes one real API call against a small
 * fixture batch and confirms the output validates."
 *
 * NOT run as part of `node --test` — it makes a real, billed Anthropic API
 * call. Run it manually once ANTHROPIC_API_KEY is set:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node mutation-engine/texture.smoke.mjs
 *
 * As of this writing (Phase 1 build session) ANTHROPIC_API_KEY was not set
 * in the environment, so this script has been written and unit-tested via
 * texture.test.mjs's mocked-client coverage, but this real-call path has
 * NOT been executed. Run it manually before relying on textureBatch against
 * a live API key for the first time.
 */
import { textureBatch, TextureValidationError } from "./texture.mjs";

const entities = [
  { id: "riverwood", name: "Riverwood", type: "place", importance: 0.7, summary: "A logging village by the river." },
  { id: "alvor", name: "Alvor", type: "person", importance: 0.5, summary: "The village smith.", attributes: { homeLocation: "riverwood" } },
  { id: "gerdur", name: "Gerdur", type: "person", importance: 0.4, summary: "Alvor's sister, runs the mill." }
];

const edges = [
  { id: "e1", sourceId: "alvor", targetId: "riverwood", relationshipType: "location", strength: 0.8 },
  { id: "e2", sourceId: "alvor", targetId: "gerdur", relationshipType: "kinship", strength: 0.8 }
];

// A small, cheap fixture batch: pretend an event seeded impact at alvor,
// propagated lightly to gerdur.
const candidateDeltas = [
  { kind: "seed-propagated", entityId: "alvor", impactScore: 0.7, importance: 0.5, needsLLM: true },
  { kind: "seed-propagated", entityId: "gerdur", impactScore: 0.4, importance: 0.4, needsLLM: true }
];

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set. This smoke test makes a real (small, cheap) Anthropic API call " +
      "and cannot run without credentials. Set the env var and re-run."
    );
    process.exitCode = 1;
    return;
  }

  console.log("Calling textureBatch against a 3-entity fixture (expect 1 API call, one connected region)...");
  try {
    const { mutations, regions } = await textureBatch(candidateDeltas, {
      entities,
      edges,
      world: "wf-smoke-test",
      batchId: "smoke-batch-1",
      elapsedTimeDescriptor: "a few hours"
    });

    console.log(`Regions: ${regions.length}`);
    console.log(`Mutations: ${mutations.length}`);
    for (const m of mutations) {
      console.log(`- ${m.op} ${m.id ?? "(new)"}: ${m.rationale}`);
    }

    if (mutations.length === 0) {
      console.warn("No mutations produced — model may have judged nothing worth texturing. Re-run or inspect the prompt.");
    }
    console.log("\nSMOKE TEST PASSED: output validated against schema.mjs's Mutation shape.");
  } catch (err) {
    if (err instanceof TextureValidationError) {
      console.error("SMOKE TEST FAILED: model output did not validate after retry.");
      console.error("Last raw response:", err.rawResponse);
      console.error(err.lastError);
    } else {
      console.error("SMOKE TEST FAILED with an unexpected error:", err);
    }
    process.exitCode = 1;
  }
}

await main();
