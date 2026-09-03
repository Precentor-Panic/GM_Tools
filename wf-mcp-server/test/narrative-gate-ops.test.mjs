import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";

/**
 * CONTRACT UNDER TEST -- the narrative-state knowledge gate at the ops
 * layer (WS3 of the Layer-2 plan), asserted on ACTUAL PROMPT CONTENT via
 * injected mock clients:
 *   - table-facing narration (narrateEntityOp/narrateOp): hidden entities'
 *     names AND ids scrubbed; withheld truths become the allusion block
 *     (stance guidance included, truth text NEVER present);
 *   - GM-facing prep (generatePrepContentOp): truth + stance injected
 *     plainly;
 *   - the gin-up regression: a world with ZERO narrative-state records
 *     produces prompts with no gate artifacts at all (no allusion block,
 *     no GM-truth block, no unfilled {{...}} slots).
 */

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-narrative-gate-ops-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
process.env.GM_TOOLS_NARRATIVE_STATE_DIR = join(scratchDir, "narrative-state");

const { snapshotFilePath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../mutation-engine/review-state.mjs");
const { acceptMutations } = await import("../../mutation-engine/rollback.mjs");
const { setNarrativeTruth, setRevealState } = await import("../../mutation-engine/narrative-state.mjs");
const { narrateOp, narrateEntityOp } = await import("../lib/mutation-ops.mjs");
const { generatePrepContentOp } = await import("../lib/prep-content-ops.mjs");

const WORLD = "narrative-gate-ops-test-world";
const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
// The square is the narration target; Vane is a visible neighbor holding a
// concealing truth; the vault is a HIDDEN neighbor (id deliberately
// name-shaped, "sealed-vault" -- the raw-id leak case).
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "gate-square", name: "The Square", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "gate-vane", name: "Corvin Vane", type: "person", importance: 0.9 } },
  { op: "upsert_entity", data: { id: "sealed-vault", name: "The Sealed Vault", type: "place", importance: 0.7 } },
  { op: "upsert_edge", data: { id: "e1", sourceId: "gate-vane", targetId: "gate-square", relationshipType: "presence" } },
  { op: "upsert_edge", data: { id: "e2", sourceId: "sealed-vault", targetId: "gate-square", relationshipType: "containment" } }
]);
const { readFileSync } = await import("node:fs");
const { entities, edges } = JSON.parse(readFileSync(snapPath, "utf8")).snapshot;

function mockClient(reply) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params.messages[0].content);
        return { content: [{ type: "text", text: reply }], stop_reason: "end_turn" };
      }
    }
  };
}

function makeAcceptedBatch(mutations) {
  const batch = createBatch(WORLD, { mode: "test" }, "a few hours", mutations);
  acceptMutations(WORLD, batch.id, batch.mutations.map((m) => m.mutationId), entities, edges);
  return batch.id;
}

const squareBatchId = makeAcceptedBatch([
  { op: "upsert_entity", id: "gate-square", data: { description: "Fresh cobbles" }, rationale: "test change", sourceKind: "manual", batchId: "x", entityContext: { name: "The Square" } }
]);

// ------------------------- gin-up regression (BEFORE any records exist) ----

test("REGRESSION: zero narrative-state records => no gate artifacts in the narration prompt at all", async () => {
  const client = mockClient("The square hums with evening trade.");
  await narrateEntityOp(dataDir, WORLD, { batchId: squareBatchId, mutationId: "m0" }, { client });
  const prompt = client.calls[0];
  assert.doesNotMatch(prompt, /UNREVEALED TRUTHS/);
  assert.doesNotMatch(prompt, /GM TRUTH/);
  // (the template's own doc header legitimately contains a literal "{{...}}",
  // so assert on the actual slot names, not any brace pair)
  assert.doesNotMatch(prompt, /\{\{withheldGuidance\}\}/, "the gate slot must be filled (empty), never left literal");
  assert.match(prompt, /The Sealed Vault/, "with no records, the (future-hidden) neighbor is plain context");
});

// ------------------------------------------------ now flag the two secrets
// (inside the test body, not module scope -- node:test evaluates the whole
// module before running any test, so module-level flagging would corrupt
// the zero-records regression above)

test("table gate (narrateEntityOp): hidden neighbor scrubbed (name AND id), allusion block carries stance guidance, truth text absent", async () => {
  setNarrativeTruth(dataDir, WORLD, "gate-vane", "Vane is quietly draining the Source.", { stance: "concealing" });
  setRevealState(dataDir, WORLD, "sealed-vault", "hidden", { source: "manual" });
  const client = mockClient("The square hums, and Vane smiles a little too easily.");
  await narrateEntityOp(dataDir, WORLD, { batchId: squareBatchId, mutationId: "m0" }, { client });
  const prompt = client.calls[0];
  assert.doesNotMatch(prompt, /Sealed Vault/, "hidden entity's NAME must not appear");
  assert.doesNotMatch(prompt, /sealed-vault/, "hidden entity's name-shaped ID must not leak via edges");
  assert.match(prompt, /UNREVEALED TRUTHS/);
  assert.match(prompt, /Corvin Vane: actively concealing/, "stance crosses the gate as roleplay guidance");
  assert.doesNotMatch(prompt, /draining the Source/, "the truth text must NEVER reach a table prompt");
  assert.match(prompt, /Corvin Vane \(presence\)/, "the withheld-but-not-hidden neighbor stays visible as surface");
});

test("table gate (narrateOp, batch grain): a batch touching a flagged target carries the allusion block", async () => {
  const vaneBatchId = makeAcceptedBatch([
    { op: "upsert_entity", id: "gate-vane", data: { description: "Seen near the guildhall" }, rationale: "movement", sourceKind: "manual", batchId: "x", entityContext: { name: "Corvin Vane" } }
  ]);
  const client = mockClient("Vane passes through the crowd.");
  await narrateOp(dataDir, WORLD, { batchId: vaneBatchId }, { client });
  const prompt = client.calls[0];
  assert.match(prompt, /UNREVEALED TRUTHS/);
  assert.match(prompt, /Corvin Vane: actively concealing/);
  assert.doesNotMatch(prompt, /draining the Source/);
});

test("a HIDDEN narration target is not refused — it joins the allusion block instead (the GM asked)", async () => {
  const vaultBatchId = makeAcceptedBatch([
    { op: "upsert_entity", id: "sealed-vault", data: { description: "Dust shifts" }, rationale: "quake", sourceKind: "manual", batchId: "x", entityContext: { name: "The Sealed Vault" } }
  ]);
  const client = mockClient("Somewhere below, dust shifts.");
  await narrateEntityOp(dataDir, WORLD, { batchId: vaultBatchId, mutationId: "m0" }, { client });
  const prompt = client.calls[0];
  assert.match(prompt, /The Sealed Vault \(place\)/, "target itself stays in grounding context");
  assert.match(prompt, /UNREVEALED TRUTHS/);
  assert.match(prompt, /The Sealed Vault: holds something the players have not learned/);
});

test("GM prep (generatePrepContentOp) gets truth AND stance plainly — the injection that keeps prep from getting worse", async () => {
  const client = mockClient(JSON.stringify({ fields: { descriptionAppearance: "A man of easy smiles.", personalityMannerisms: "Laughs first.", motivationGoal: "Finish the siphon quietly.", secret: "He drains the Source.", potentialRolls: [], hook: "He owes the party a favor." } }));
  await generatePrepContentOp(dataDir, WORLD, { entityId: "gate-vane", selection: { primary: { id: "a", sentence: "The charming traitor." } } }, { client });
  const prompt = client.calls[0];
  assert.match(prompt, /GM TRUTH — Corvin Vane \[reveal: unrevealed\]/);
  assert.match(prompt, /Vane is quietly draining the Source\./, "GM prompts get the truth text plainly");
  assert.match(prompt, /Stance: concealing/);
});

after(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});
