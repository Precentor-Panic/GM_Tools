#!/usr/bin/env node
/**
 * Manual/integration smoke test for time-skip/run.mjs's orchestrateBatch —
 * Phase 2 task 2.2's acceptance criterion: "Integration smoke test with real
 * (small, cheap) API calls confirming total call count stays materially
 * below entity count for a multi-region fixture scope -- validates the
 * cost-reduction design empirically, not just via the mock."
 *
 * NOT run as part of `node --test` — it makes real, billed Anthropic API
 * calls. Run it manually once ANTHROPIC_API_KEY is set:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node time-skip/resumability.smoke.mjs
 *
 * As of this writing (Phase 2 build session) ANTHROPIC_API_KEY was not set
 * in the environment, so this script has been written and the underlying
 * orchestrateBatch()/resumability logic unit-tested via test/resumability.test.mjs
 * and test/resumability-crossprocess.test.mjs's mocked-client coverage, but
 * this real-call path has NOT been executed. Run it manually before relying
 * on a real multi-region time-skip batch against a live API key for the
 * first time.
 */
import { orchestrateBatch } from "./run.mjs";

// A "small town" fixture with 3 well-separated clusters (12 entities total),
// each cluster internally connected but disconnected from the others, so
// groupByRegion's union-find keeps them as 3 distinct regions -- a
// meaningfully multi-region case for the "call count << entity count" claim
// to actually mean something (a 1-entity or 1-region fixture wouldn't).
function cluster(prefix, n) {
  const entities = [];
  const edges = [];
  for (let i = 0; i < n; i++) {
    entities.push({ id: `${prefix}${i}`, name: `${prefix}${i}`, type: "person", importance: 0.6 });
    if (i > 0) {
      edges.push({
        id: `${prefix}e${i}`,
        sourceId: `${prefix}${i - 1}`,
        targetId: `${prefix}${i}`,
        relationshipType: "social",
        strength: 0.8
      });
    }
  }
  return { entities, edges };
}

const clusters = ["north", "east", "west"].map((p) => cluster(p, 4)); // 3 clusters x 4 entities = 12 entities, 3 regions
const entities = clusters.flatMap((c) => c.entities);
const edges = clusters.flatMap((c) => c.edges);

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set. This smoke test makes real (small, cheap) Anthropic API calls " +
      "and cannot run without credentials. Set the env var and re-run."
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Fixture: ${entities.length} entities across ${clusters.length} disconnected regions.`);
  console.log("Calling orchestrateBatch(mode='ambient', elapsedSessions=12) -- expect ~3 API calls (1/region), not 12 (1/entity)...");

  let apiCallCount = 0;
  // Wrap the real Anthropic client to count calls without altering behavior.
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const realClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const countingClient = {
    messages: {
      create: async (params) => {
        apiCallCount++;
        return realClient.messages.create(params);
      }
    }
  };

  const result = await orchestrateBatch(
    "wf-smoke-test",
    { mode: "ambient", elapsedSessions: 12 },
    "a dozen sessions",
    { entities, edges, batchId: `smoke-resumability-${Date.now()}`, textureOpts: { client: countingClient } }
  );

  console.log(`\nResult: ${JSON.stringify(result, null, 2)}`);
  console.log(`\nReal API calls made: ${apiCallCount}`);
  console.log(`Entity count: ${entities.length}`);

  if (apiCallCount === 0) {
    console.warn("No API calls were made -- the fixture's decay may not have cleared IMPACT_THRESHOLD. Try a larger elapsedSessions.");
  } else if (apiCallCount < entities.length) {
    console.log(`\nSMOKE TEST PASSED: ${apiCallCount} calls for ${entities.length} entities -- materially below 1-call-per-entity.`);
  } else {
    console.error(`\nSMOKE TEST FAILED: ${apiCallCount} calls is NOT materially below the ${entities.length}-entity count -- region batching may be broken.`);
    process.exitCode = 1;
  }
}

await main();
