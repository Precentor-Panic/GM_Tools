/**
 * Real-API smoke test for graph-import/scan-mentions.mjs. Per
 * gm-tools-conventions ("LLM-dependent code gets ... a documented manual or
 * integration smoke test that makes a real (small, cheap) API call and
 * confirms the output validates"), same pattern as
 * graph-import/writeup-framing.smoke.mjs. Requires ANTHROPIC_API_KEY.
 *
 * Run: node --env-file-if-exists=.env graph-import/scan-mentions.smoke.mjs
 *
 * Proves the full pipeline end to end with REAL generated-content-shaped
 * text (deliberately similar to what Phase 11's prep-content generation
 * actually produces -- a person entity's description mentioning a place and
 * an unnamed-until-now NPC), against a real small fixture graph containing
 * one of the two mentions already: confirms the model extracts BOTH real
 * mentions, and that previewMentionScan correctly classifies one as a LINK
 * (matches the pre-existing fixture entity) and the other as PROPOSE-NEW.
 */
import { scanForMentionedEntities } from "./scan-mentions.mjs";

const WORLD = "scan-mentions-smoke-world";

const existingSnapshot = {
  entities: [
    {
      id: "kaeliss",
      name: "Kaeliss",
      type: "person",
      description: "A traveling scholar who has spent the last decade cataloguing ruins.",
      importance: 0.6,
      tags: [],
      attributes: {}
    },
    {
      id: "riverwood",
      name: "Riverwood",
      type: "place",
      description: "A logging village at the foot of the mountains.",
      importance: 0.7,
      tags: [],
      attributes: {}
    }
  ],
  edges: [],
  entityTypes: [
    { id: "person", attributeDefs: [] },
    { id: "place", attributeDefs: [] },
    { id: "faction", attributeDefs: [] },
    { id: "object", attributeDefs: [] },
    { id: "event", attributeDefs: [] },
    { id: "concept", attributeDefs: [] }
  ]
};

// prep-content-shaped text: written from Kaeliss's own perspective (the
// "source entity" here), mentioning Riverwood (which already exists in the
// fixture above -- should resolve to a LINK) and Old Kellan (which does
// not -- should resolve to a PROPOSE-NEW).
const scanText = `
Kaeliss grew up on the road, never settling long in one place, until a bad
winter forced her to overwinter in Riverwood three years ago. She struck up
an unlikely friendship there with Old Kellan, the town's gruff quartermaster,
who taught her how to read the old trade-caravan ledgers. She still writes to
him twice a year.
`.trim();

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set -- this smoke test requires a real API key. Skipping.");
    process.exit(0);
  }

  console.log("Scanning Kaeliss's prep-content-shaped text for mentions...");
  const result = await scanForMentionedEntities(WORLD, "kaeliss", scanText, existingSnapshot);

  console.log(`\nbatchId: ${result.batchId}`);
  console.log(`mutationCount: ${result.mutationCount}`);
  console.log(`linkCount: ${result.linkCount}`);
  console.log(`newCount: ${result.newCount}`);
  console.log(`\nheadline:\n${result.headline}\n`);

  if (result.linkCount < 1) {
    throw new Error(`Expected at least 1 LINK result (Riverwood, already in the fixture) -- got linkCount=${result.linkCount}`);
  }
  if (result.newCount < 1) {
    throw new Error(`Expected at least 1 PROPOSE-NEW result (Old Kellan, not in the fixture) -- got newCount=${result.newCount}`);
  }

  const { loadBatch } = await import("../mutation-engine/review-state.mjs");
  const batch = loadBatch(WORLD, result.batchId);
  console.log("Mutations:");
  for (const m of batch.mutations) {
    console.log(`  [${m.entityContext?.scanResultKind ?? "?"}] ${m.op} — ${m.entityContext?.name ?? m.id} — ${m.rationale}`);
  }

  const hasRiverwoodLink = batch.mutations.some(
    (m) => m.entityContext?.scanResultKind === "link" && (m.data?.targetId === "riverwood")
  );
  if (!hasRiverwoodLink) {
    throw new Error("Expected a LINK mutation targeting the real existing 'riverwood' entity id -- dedup did not resolve correctly.");
  }

  console.log("\nPASS: scan-mentions smoke test produced both a LINK (to the real existing entity) and a PROPOSE-NEW result.");
}

main().catch((err) => {
  console.error("FAIL:", err.stack || err.message);
  process.exit(1);
});
