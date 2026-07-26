#!/usr/bin/env node
/**
 * Manual/integration smoke test for Phase 8 task 8.1's framing-proposal
 * call: proposeFramingsFromWriteup(writeupText). Makes a REAL, small, cheap
 * Anthropic API call (DEFAULT_FRAMING_MODEL) — not run as part of
 * `node --test`, matching the established .smoke.mjs convention
 * (texture.smoke.mjs, resolve-seed.smoke.mjs, narrate.smoke.mjs).
 *
 * Confirms two things a mocked unit test cannot:
 *   1. The three framings are genuinely distinct readings of the writeup,
 *      not three near-duplicate paraphrases ("just three ghostwriters
 *      instead of one" is exactly what the design doc says NOT to build).
 *   2. The call is visibly fast relative to Phase 3's measured ~51-59s p50
 *      baseline for the real extraction pass (wf_propose_mutations).
 *
 * Run manually once ANTHROPIC_API_KEY is set (from GM_Tools/):
 *
 *   node --env-file-if-exists=.env graph-import/writeup-framing.smoke.mjs
 */
import { proposeFramingsFromWriteup, DEFAULT_FRAMING_MODEL, DEFAULT_WRITEUP_IMPORT_MODEL } from "./writeup-import.mjs";

const WRITEUP = `
The free city of Thornhollow sits where two rivers meet. For a generation the
Merchant Council — a cartel of guild leaders — has kept the peace by paying
off the river raiders instead of fighting them. Captain Ysolde Marrow, who
commands the city watch, thinks that's cowardice and has started training a
militia in secret. Meanwhile, half a mile upriver, an expedition financed by
the Council has just broken into a sealed ruin that predates the city itself
— and nobody who went in has come back out. Ysolde's estranged brother Dorn
was one of the four who went in.
`.trim();

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. This smoke test makes a real (small, cheap) Anthropic API call and cannot run without credentials.");
    process.exitCode = 1;
    return;
  }

  console.log(`Model: ${DEFAULT_FRAMING_MODEL} (framing) vs ${DEFAULT_WRITEUP_IMPORT_MODEL} (real extraction, for comparison)`);
  console.log("Writeup:\n" + WRITEUP + "\n");

  const start = Date.now();
  const { framings } = await proposeFramingsFromWriteup(WRITEUP);
  const elapsedMs = Date.now() - start;

  console.log(`\nElapsed: ${(elapsedMs / 1000).toFixed(2)}s\n`);
  for (const f of framings) {
    console.log(`  (${f.id}) ${f.sentence}`);
  }

  if (framings.length !== 3) {
    throw new Error(`Expected exactly 3 framings, got ${framings.length}`);
  }
  const ids = framings.map((f) => f.id).sort().join(",");
  if (ids !== "a,b,c") {
    throw new Error(`Expected ids a,b,c, got ${ids}`);
  }

  // Crude distinctness check: no two framings should share more than half
  // their (lowercased, stopword-free-ish) significant words — a cheap
  // automated guard against "three near-duplicate paraphrases", though the
  // real judgment call is eyeballing the printed sentences above.
  const words = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 3));
  const sets = framings.map((f) => words(f.sentence));
  let maxOverlap = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const shared = [...sets[i]].filter((w) => sets[j].has(w)).length;
      const smaller = Math.min(sets[i].size, sets[j].size) || 1;
      maxOverlap = Math.max(maxOverlap, shared / smaller);
    }
  }
  console.log(`\nMax pairwise significant-word overlap: ${(maxOverlap * 100).toFixed(0)}%`);

  console.log(`\nPhase 3's real-extraction baseline (wf_propose_mutations, mode='seed'): p50 ~51-59s.`);
  console.log(`This framing call took ${(elapsedMs / 1000).toFixed(2)}s.`);
  if (elapsedMs > 15000) {
    console.warn("WARNING: this framing call took over 15s -- slower than expected for a 'cheap, visibly-fast glance'. Investigate before claiming this is genuinely fast.");
  } else {
    console.log("Confirmed genuinely fast relative to the real-extraction baseline.");
  }

  console.log("\nSMOKE TEST PASSED (structural checks). Read the three framings above and confirm by eye that they are genuinely distinct readings, not near-duplicates.");
}

main().catch((err) => {
  console.error("\nSMOKE TEST FAILED:", err.stack || err.message);
  process.exitCode = 1;
});
