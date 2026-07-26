#!/usr/bin/env node
/**
 * Manual/integration smoke test for mutation-engine/prep-content.mjs's
 * framing + generation calls — Phase 11 task 11.2's actual acceptance-
 * critical regression test: "a real-API smoke test proving two different
 * entities (e.g. a person and a place) produce genuinely different,
 * type-appropriate field shapes" — the concrete failure mode ("generic
 * mushy content forced onto everything") this phase's framing-first design
 * exists to prevent.
 *
 * NOT run as part of `node --test` — it makes real, billed Anthropic API
 * calls. Run it manually once ANTHROPIC_API_KEY is set:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node mutation-engine/prep-content.smoke.mjs
 *
 * Isolates prep-content.mjs's storage into a scratch temp directory BEFORE
 * importing it (same convention every other store's smoke test in this
 * project uses) since this script really does persist prep content via
 * savePrepContent/acceptPrepContent/updatePrepField on success.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-prep-content-smoke-"));
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");

const {
  proposeFramingsForEntity,
  composePrepFramingNote,
  generatePrepContent,
  regeneratePrepField,
  savePrepContent,
  acceptPrepContent,
  updatePrepField,
  markPrepContentStale,
  getPrepContent,
  fieldsSchemaForType
} = await import("./prep-content.mjs");
const { neighborhood, findEntity } = await import("../wf-mcp-server/lib/graph.mjs");

const WORLD = "wf-smoke-test-prep-content";

// A small fixture graph: Alvor (smith, person) <-kinship-> Gerdur (his
// sister, runs the mill) <-containment-> Riverwood (the village, place).
// Both Alvor and Riverwood get developed in this run -- a person and a
// place, the exact pairing task 11.2 names as the regression check.
const entities = [
  { id: "alvor", name: "Alvor", type: "person", description: "The village smith, runs the forge. Quiet, methodical, well-liked." },
  { id: "gerdur", name: "Gerdur", type: "person", description: "Alvor's sister, runs Riverwood's mill." },
  { id: "riverwood", name: "Riverwood", type: "place", description: "A small logging village on the river, known for its lumber trade." }
];
const edges = [
  { id: "e1", sourceId: "alvor", targetId: "gerdur", relationshipType: "kinship", strength: 0.9 },
  { id: "e2", sourceId: "gerdur", targetId: "riverwood", relationshipType: "containment", strength: 0.7 },
  { id: "e3", sourceId: "alvor", targetId: "riverwood", relationshipType: "containment", strength: 0.6 }
];

function groundingFor(entityId) {
  const entity = findEntity(entities, entityId);
  const { edges: nearby } = neighborhood(entities, edges, entityId, 1);
  const entityMap = new Map(entities.map((e) => [e.id, e]));
  const neighborDescriptions = nearby
    .filter((e) => e.sourceId === entityId || e.targetId === entityId)
    .map((e) => {
      const otherId = e.sourceId === entityId ? e.targetId : e.sourceId;
      return `${entityMap.get(otherId)?.name ?? otherId} (${e.relationshipType})`;
    });
  return { entityLabel: `${entity.name} (${entity.type})`, neighborDescriptions };
}

async function developEntity(entity) {
  const ctx = groundingFor(entity.id);
  console.log(`\n--- developing ${entity.name} (${entity.type}) ---`);
  console.log(`grounding context: ${JSON.stringify(ctx)}`);

  const { framings } = await proposeFramingsForEntity(entity, ctx, {});
  console.log("framings:", framings.map((f) => `${f.id}: ${f.sentence}`).join(" | "));
  if (framings.length !== 3) throw new Error(`Expected 3 framings for ${entity.name}, got ${framings.length}`);

  const note = composePrepFramingNote({ primary: framings[0] });
  const { fields } = await generatePrepContent(entity, ctx, note, {});
  console.log("generated fields:", JSON.stringify(fields, null, 2));

  const saved = savePrepContent(WORLD, entity.id, { entityType: entity.type, framingUsed: note, fields });
  return saved;
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

  const alvorDoc = await developEntity(entities[0]); // person
  const riverwoodDoc = await developEntity(entities[2]); // place

  console.log("\n=== 3. Structural check: person and place have genuinely different field shapes ===");
  const personKeys = Object.keys(fieldsSchemaForType("person").shape).sort();
  const placeKeys = Object.keys(fieldsSchemaForType("place").shape).sort();
  const alvorKeys = Object.keys(alvorDoc.fields).sort();
  const riverwoodKeys = Object.keys(riverwoodDoc.fields).sort();
  const alvorShapeOk = JSON.stringify(alvorKeys) === JSON.stringify(personKeys);
  const riverwoodShapeOk = JSON.stringify(riverwoodKeys) === JSON.stringify(placeKeys);
  const shapesGenuinelyDiffer = JSON.stringify(personKeys) !== JSON.stringify(placeKeys);
  console.log(`Alvor's fields match the PERSON template exactly: ${alvorShapeOk} (${alvorKeys.join(", ")})`);
  console.log(`Riverwood's fields match the PLACE template exactly: ${riverwoodShapeOk} (${riverwoodKeys.join(", ")})`);
  console.log(`person and place templates are genuinely different shapes: ${shapesGenuinelyDiffer}`);

  console.log("\n=== 4. Content check: not generic mushy content -- Alvor's content mentions people/place he's actually connected to ===");
  const alvorText = JSON.stringify(alvorDoc.fields).toLowerCase();
  const mentionsConnection = alvorText.includes("gerdur") || alvorText.includes("riverwood") || alvorText.includes("mill") || alvorText.includes("forge");
  console.log(`Alvor's generated content references his real graph connections (Gerdur/Riverwood/mill/forge): ${mentionsConnection}`);

  console.log("\n=== 5. Accept + field-granular regenerate: one field changes, the rest stay byte-identical ===");
  acceptPrepContent(WORLD, "alvor");
  const beforeRegen = getPrepContent(WORLD, "alvor");
  const newSecret = await regeneratePrepField(entities[0], groundingFor("alvor"), beforeRegen.fields, "secret", "make it darker and more dangerous", {});
  console.log(`regenerated secret: ${newSecret}`);
  const afterRegen = updatePrepField(WORLD, "alvor", "secret", newSecret);
  const secretChanged = afterRegen.fields.secret !== beforeRegen.fields.secret;
  let otherFieldsUntouched = true;
  for (const key of Object.keys(beforeRegen.fields)) {
    if (key === "secret") continue;
    if (JSON.stringify(afterRegen.fields[key]) !== JSON.stringify(beforeRegen.fields[key])) otherFieldsUntouched = false;
  }
  console.log(`secret field changed: ${secretChanged}`);
  console.log(`every OTHER field is byte-identical to before the regenerate: ${otherFieldsUntouched}`);

  console.log("\n=== 6. Staleness: marking stale keeps fields fully readable ===");
  const staled = markPrepContentStale(WORLD, "alvor");
  const staleOk = staled.status === "stale" && JSON.stringify(staled.fields) === JSON.stringify(afterRegen.fields);
  console.log(`status is now 'stale' and fields are unchanged/still readable: ${staleOk}`);

  const allOk = alvorShapeOk && riverwoodShapeOk && shapesGenuinelyDiffer && mentionsConnection && secretChanged && otherFieldsUntouched && staleOk;
  if (allOk) {
    console.log("\nSMOKE TEST PASSED: a person and a place produced genuinely different, type-appropriate, graph-grounded prep content; field-granular regenerate and staleness both work as designed.");
  } else {
    console.error("\nSMOKE TEST FAILED -- see above.");
    process.exitCode = 1;
  }
}

await main().finally(() => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
