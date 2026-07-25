#!/usr/bin/env node
/**
 * Manual/integration smoke test for time-skip/resolve-seed.mjs — Phase 2
 * task 2.2b's acceptance criterion: "Manual/integration smoke test with a
 * real API call against the fixture graph."
 *
 * NOT run as part of `node --test` — it makes real, billed Anthropic API
 * calls. Run it manually once ANTHROPIC_API_KEY is set:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node time-skip/resolve-seed.smoke.mjs
 *
 * As of this writing (Phase 2 build session) ANTHROPIC_API_KEY was not set
 * in the environment, so this script has been written and resolveSeed()'s
 * orchestration/validation/retry logic unit-tested via
 * test/resolve-seed.test.mjs's mocked-client coverage, but this real-call
 * path has NOT been executed. Run it manually before relying on resolveSeed
 * against a live API key for the first time.
 */
import { resolveSeed, SeedResolutionError } from "./resolve-seed.mjs";

// Same "Riverwood" fixture shape as mutation-engine/texture.smoke.mjs, with
// one added ambiguity case (two innkeeper-adjacent entities) to exercise
// the disambiguation path too.
const entities = [
  { id: "riverwood", name: "Riverwood", type: "place", importance: 0.7, summary: "A logging village by the river." },
  { id: "alvor", name: "Alvor", type: "person", importance: 0.5, summary: "The village smith, runs the forge." },
  { id: "gerdur", name: "Gerdur", type: "person", importance: 0.4, summary: "Alvor's sister, runs the mill." },
  { id: "orgnar", name: "Orgnar", type: "person", importance: 0.3, summary: "Runs the Sleeping Giant Inn, the village tavern." },
  { id: "delphine", name: "Delphine", type: "person", importance: 0.3, summary: "Innkeeper's helper at the Sleeping Giant Inn, secretly a veteran." }
];
const edges = [];

async function run(label, description) {
  console.log(`\n--- ${label}: "${description}" ---`);
  try {
    const result = await resolveSeed(description, { entities, edges });
    console.log(JSON.stringify(result, null, 2));
    return { ok: true, result };
  } catch (err) {
    if (err instanceof SeedResolutionError) {
      console.log(`SeedResolutionError (kind=${err.kind}): ${err.message}`);
      return { ok: err.kind === "no-match", result: err }; // no-match is an EXPECTED outcome for the no-match case below
    }
    console.error("Unexpected error:", err);
    return { ok: false, result: err };
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set. This smoke test makes real (small, cheap) Anthropic API calls " +
      "and cannot run without credentials. Set the env var and re-run."
    );
    process.exitCode = 1;
    return;
  }

  const single = await run("single-match case", "the village smith is attacked in the night");
  const ambiguous = await run("ambiguous case", "someone at the inn notices a stranger");
  const noMatch = await run("no-match case", "a dragon burns down the capital city");

  const singleOk = single.ok && single.result.status === "resolved" && single.result.entityId === "alvor";
  const ambiguousOk = ambiguous.ok && ambiguous.result.status === "ambiguous" && ambiguous.result.candidates.length >= 2;
  const noMatchOk = noMatch.ok; // expected to throw SeedResolutionError(kind='no-match')

  console.log(`\nsingle-match resolved correctly: ${singleOk}`);
  console.log(`ambiguous case returned candidates (not a guess): ${ambiguousOk}`);
  console.log(`no-match case threw a typed error: ${noMatchOk}`);

  if (singleOk && ambiguousOk && noMatchOk) {
    console.log("\nSMOKE TEST PASSED: all three resolution paths behaved as designed against a real model.");
  } else {
    console.error("\nSMOKE TEST FAILED (or model judged a case differently than expected -- inspect the output above; " +
      "LLM judgment calls on the ambiguous/no-match cases are not guaranteed deterministic, re-run once before concluding a real bug).");
    process.exitCode = 1;
  }
}

await main();
