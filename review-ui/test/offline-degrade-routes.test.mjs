import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * QA fix-wave W1, Fix 3 -- the deterministic, keyless-by-default route
 * coverage: every LLM-backed route found via the grep-driven audit (see
 * review-ui/server.mjs's own "QA fix-wave W1, Fix 3/Fix 4" block comment,
 * right above `offlineOpts`) must return 200 with honest, clearly-labelled
 * offline content -- NEVER the raw Anthropic SDK's "Could not resolve
 * authentication method" construction-time throw (which this repo's own
 * statusForError maps to 502) or any other 5xx. This test file's own
 * process never sets ANTHROPIC_API_KEY (matching this project's standing
 * "no live API calls in tests" rule), so the offline-degrade path is
 * unconditionally exercised for every route below -- no env-var gymnastics
 * needed, this environment IS the keyless default.
 *
 * The four originally-reported findings (writeup-propose, assist-prep's
 * three modes, propose-updates, bestiary/ingest) get their own explicit,
 * clearly-labelled tests; the rest of the grep-driven audit (narrate x3,
 * prep-content x4, scan-mentions x2, party-roster/ingest, thematic-filter,
 * quick-gen, resolve-pending, regenerate, writeup-select-framing,
 * reject-with-loop) are swept together, still asserting the exact same
 * invariant (200, never 5xx) for each.
 *
 * Matches review-ui/test/manual-edit-routes.test.mjs's established style:
 * real HTTP requests against an in-process server.listen(0).
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-offline-degrade-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_SESSION_NOTES_DIR = join(scratchDir, "session-notes");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
process.env.GM_TOOLS_USER_SETTINGS_DIR = join(scratchDir, "user-settings");
process.env.WF_DATA_DIR = dataDir;

// Belt-and-suspenders: this suite's whole premise is the keyless default --
// fail loudly (not silently attempt a real, billed call) if something in
// the wider test environment ever sets this.
delete process.env.ANTHROPIC_API_KEY;

const WORLD = "offline-degrade-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../graph-import/headless-apply.mjs");
const { addNodeOp } = await import("../../wf-mcp-server/lib/manual-edit-ops.mjs");
const { createScene } = await import("../../session-planner/scenes.mjs");
const { captureNote } = await import("../../session-planner/session-notes.mjs");
const { writePending } = await import("../../mutation-engine/pending-ledger.mjs");
const { setRubberDuckMode } = await import("../../mutation-engine/user-settings.mjs");
const { QUICK_PICK_REASONS } = await import("../../graph-import/writeup-import.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });

let server, base;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const parsed = await res.json().catch(() => null);
  return { status: res.status, body: parsed };
}

function assertNever5xx(status, label) {
  assert.ok(status < 500, `${label}: must never be a 5xx (raw auth-error crash) keyless -- got ${status}`);
}

// ---------------------------------------------------------------------------
// The four originally-reported findings
// ---------------------------------------------------------------------------

test("Fix 3 finding 1: POST /api/writeup-propose degrades keyless -- 200, a real (honestly empty) batch, never 5xx", async () => {
  const { status, body } = await postJson("/api/writeup-propose", { world: WORLD, text: "A quiet village square, watched over by an old oak." });
  assertNever5xx(status, "writeup-propose");
  assert.equal(status, 200);
  assert.ok(typeof body.batchId === "string" && body.batchId.length > 0, "a real batch must still be created offline");
  assert.equal(body.mutationCount, 0, "offline extraction is honestly empty -- no invented entities");
});

// Fix 4's own originally-reported finding, at the route (not just e2e) layer.
test("Fix 4 (the originally-reported finding): POST .../develop-description degrades keyless -- 200, offline:true, and `suggestion` is a clean, disclaimer-free echo of the GM's vision", async () => {
  const { entityId: placeId } = await addNodeOp(dataDir, WORLD, { name: "The Fix 4 Route Test Place", type: "place" });
  const { status, body } = await postJson(`/api/graph/nodes/${placeId}/develop-description`, { world: WORLD, vision: "a stair down, recently bricked over" });
  assertNever5xx(status, "graph/nodes/:id/develop-description");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.offline, true);
  assert.doesNotMatch(body.suggestion, /Offline pass|ANTHROPIC_API_KEY/i, "the suggestion BODY must never carry the disclaimer");
  assert.match(body.suggestion, /stair down|recently bricked over/i, "the body must be a usable-as-is echo of the GM's own vision line");
});

test("Fix 3 finding 2a: POST .../assist-prep mode=propose-elements degrades keyless -- 200, never 5xx", async () => {
  const scene = createScene(WORLD, { objectiveNote: "Explore the ruin" });
  const { status, body } = await postJson(`/api/scene-planning/scenes/${scene.id}/assist-prep`, { world: WORLD, mode: "propose-elements" });
  assertNever5xx(status, "assist-prep propose-elements");
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.elements) && body.elements.length > 0);
});

test("Fix 3 finding 2b: POST .../assist-prep mode=draft-fields degrades keyless -- 200, echoes the requested elementName, never 5xx", async () => {
  const scene = createScene(WORLD, { objectiveNote: "Explore the ruin" });
  const { status, body } = await postJson(`/api/scene-planning/scenes/${scene.id}/assist-prep`, { world: WORLD, mode: "draft-fields", elementName: "The Sealed Door" });
  assertNever5xx(status, "assist-prep draft-fields");
  assert.equal(status, 200);
  assert.equal(body.elements.length, 1);
  assert.equal(body.elements[0].name, "The Sealed Door");
});

test("Fix 3 finding 2c: POST .../assist-prep mode=draft-read-aloud degrades keyless -- 200, a real narration string, never 5xx", async () => {
  const scene = createScene(WORLD, { objectiveNote: "Explore the ruin" });
  const { status, body } = await postJson(`/api/scene-planning/scenes/${scene.id}/assist-prep`, { world: WORLD, mode: "draft-read-aloud" });
  assertNever5xx(status, "assist-prep draft-read-aloud");
  assert.equal(status, 200);
  assert.ok(typeof body.narration === "string" && body.narration.length > 0);
});

test("Fix 3 finding 3: POST .../scenes/:id/propose-updates (Wrap) degrades keyless -- 200, never 5xx", async () => {
  const scene = createScene(WORLD, { objectiveNote: "A tense negotiation" });
  captureNote(WORLD, { text: "The envoy revealed a hidden agenda.", sceneId: scene.id });
  const { status, body } = await postJson(`/api/scene-planning/scenes/${scene.id}/propose-updates`, { world: WORLD });
  assertNever5xx(status, "scene propose-updates");
  assert.equal(status, 200);
  assert.ok(typeof body.batchId === "string" && body.batchId.length > 0);
});

test("Fix 3 finding 3b (plan-level Wrap, same underlying importWriteup call): POST .../plans/:id/propose-updates degrades keyless -- 200, never 5xx", async () => {
  const { createPlan, addSceneToPlan } = await import("../../session-planner/plans.mjs");
  const scene = createScene(WORLD, { objectiveNote: "A tense negotiation, plan-scoped" });
  captureNote(WORLD, { text: "The envoy revealed a hidden agenda.", sceneId: scene.id });
  const plan = createPlan(WORLD, { name: "Test Plan" });
  addSceneToPlan(WORLD, plan.id, scene.id);
  const { status, body } = await postJson(`/api/scene-planning/plans/${plan.id}/propose-updates`, { world: WORLD });
  assertNever5xx(status, "plan propose-updates");
  assert.equal(status, 200);
  assert.ok(typeof body.batchId === "string" && body.batchId.length > 0);
});

test("Fix 3 finding 4: POST /api/combat-planning/bestiary/ingest degrades keyless -- 200, a real 'proposed' entry, never 5xx", async () => {
  const { status, body } = await postJson("/api/combat-planning/bestiary/ingest", { text: "A hulking brute with a rusted axe. AC 13, HP 45." });
  assertNever5xx(status, "bestiary/ingest");
  assert.equal(status, 200);
  assert.equal(body.entry.status, "proposed");
  assert.ok(body.entry.rawFields.name && body.entry.rawFields.hp && body.entry.rawFields.ac);
});

// Not one of the 4 originally-named findings, but the SAME pre-existing
// offline client (offlineReskinSuggestClient) Fix 4 requires cleaning up --
// see combat-planning/reskin-suggest.mjs's own doc comment.
test("Fix 4 (pre-existing offline client, updated to the new clean-body/offline-flag convention): POST .../bestiary/:id/reskin-suggest degrades keyless -- 200, offline:true, clean bodies, never 5xx", async () => {
  const { saveBestiaryEntry } = await import("../../combat-planning/bestiary-store.mjs");
  const entry = saveBestiaryEntry({ rawFields: { name: "Test Ogre", type: "monster", hp: 59, ac: 13 } });
  const { status, body } = await postJson(`/api/combat-planning/bestiary/${entry.id}/reskin-suggest`, { world: WORLD, vision: "closer to a court intriguer" });
  assertNever5xx(status, "bestiary/:id/reskin-suggest");
  assert.equal(status, 200);
  assert.equal(body.offline, true, "the response must honestly flag itself as an offline degrade");
  assert.ok(body.suggestions.length >= 2);
  for (const s of body.suggestions) {
    assert.doesNotMatch(s.description, /Offline pass|ANTHROPIC_API_KEY/i, "a reskin suggestion's persisted-on-accept body must be clean");
    assert.doesNotMatch(s.habitatHint, /Offline pass|ANTHROPIC_API_KEY/i);
  }
});

// ---------------------------------------------------------------------------
// Fix 4: offline content must never carry "Offline pass"/"ANTHROPIC_API_KEY"
// disclaimer text inside a field that gets SAVED as real, persisted content.
// ---------------------------------------------------------------------------

test("Fix 4 (applied across every offline client, not just develop-place): none of the persisted-content fields above contain 'Offline pass' or 'ANTHROPIC_API_KEY'", async () => {
  const scene = createScene(WORLD, { objectiveNote: "Fix 4 sweep" });
  const elements = (await postJson(`/api/scene-planning/scenes/${scene.id}/assist-prep`, { world: WORLD, mode: "propose-elements" })).body;
  const readAloud = (await postJson(`/api/scene-planning/scenes/${scene.id}/assist-prep`, { world: WORLD, mode: "draft-read-aloud" })).body;
  const bestiary = (await postJson("/api/combat-planning/bestiary/ingest", { text: "Something menacing." })).body;

  const haystacks = [
    JSON.stringify(elements.elements),
    readAloud.narration,
    JSON.stringify(bestiary.entry.rawFields)
  ];
  for (const text of haystacks) {
    assert.doesNotMatch(text, /Offline pass/i, `persisted content must never carry the disclaimer verbatim: ${text}`);
    assert.doesNotMatch(text, /ANTHROPIC_API_KEY/, `persisted content must never instruct the GM to configure anything: ${text}`);
  }
});

// ---------------------------------------------------------------------------
// The broader grep-driven audit sweep -- same invariant, one test each.
// ---------------------------------------------------------------------------

test("audit sweep: POST /api/combat-planning/party-roster/ingest degrades keyless -- 200, never 5xx", async () => {
  const { status, body } = await postJson("/api/combat-planning/party-roster/ingest", { world: WORLD, text: "A stalwart fighter named Bram." });
  assertNever5xx(status, "party-roster/ingest");
  assert.equal(status, 200);
  assert.ok(body.member.name);
});

test("audit sweep: POST /api/scene-planning/quick-gen degrades keyless -- 200, never 5xx", async () => {
  const { status, body } = await postJson("/api/scene-planning/quick-gen", { world: WORLD, prompt: "Describe a locked chest." });
  assertNever5xx(status, "quick-gen");
  assert.equal(status, 200);
  assert.ok(typeof body.text === "string" && body.text.length > 0);
});

test("audit sweep: prep-content propose-framings/generate/regenerate-field all degrade keyless -- 200 at every step, never 5xx", async () => {
  const { entityId } = await addNodeOp(dataDir, WORLD, { name: "The Sunken Archive", type: "place" });

  const framings = await postJson(`/api/entities/${entityId}/prep/propose-framings`, { world: WORLD });
  assertNever5xx(framings.status, "prep/propose-framings");
  assert.equal(framings.status, 200);
  assert.equal(framings.body.framings.length, 3);

  const reframe = await postJson(`/api/entities/${entityId}/prep/reframe`, { world: WORLD, priorRoundCount: 1 });
  assertNever5xx(reframe.status, "prep/reframe");
  assert.equal(reframe.status, 200);

  const generate = await postJson(`/api/entities/${entityId}/prep/generate`, { world: WORLD, selection: { primary: framings.body.framings[0] } });
  assertNever5xx(generate.status, "prep/generate");
  assert.equal(generate.status, 200, JSON.stringify(generate.body));
  // "place" type's own real field list (mutation-engine/prep-content.mjs) --
  // proves the offline client answered with THIS type's exact schema, not a
  // generic/wrong-type stub that would have failed zod .strict() validation.
  assert.ok("descriptionAtmosphere" in generate.body.fields);
  assert.ok("potentialRolls" in generate.body.fields);
  assert.deepEqual(generate.body.fields.potentialRolls, []);
  assert.doesNotMatch(generate.body.fields.descriptionAtmosphere, /Offline pass|ANTHROPIC_API_KEY/i);

  const regenField = await postJson(`/api/entities/${entityId}/prep/regenerate-field`, { world: WORLD, fieldName: "descriptionAtmosphere" });
  assertNever5xx(regenField.status, "prep/regenerate-field");
  assert.equal(regenField.status, 200);

  const regenRolls = await postJson(`/api/entities/${entityId}/prep/regenerate-field`, { world: WORLD, fieldName: "potentialRolls" });
  assertNever5xx(regenRolls.status, "prep/regenerate-field (array field)");
  assert.equal(regenRolls.status, 200);
  assert.deepEqual(regenRolls.body.fields.potentialRolls, []);
});

test("audit sweep: POST /api/entities/:id/scan-mentions degrades keyless -- 200, an honest empty mentions list, never 5xx", async () => {
  const { entityId } = await addNodeOp(dataDir, WORLD, { name: "A Weathered Journal", type: "object" });
  const { status, body } = await postJson(`/api/entities/${entityId}/scan-mentions`, { world: WORLD, text: "It mentions a name, Kaelen, in passing." });
  assertNever5xx(status, "scan-mentions");
  assert.equal(status, 200);
  assert.deepEqual(body.mentions ?? [], []);
});

test("audit sweep: POST /api/session-planner/notes/intake degrades keyless -- 200, never 5xx", async () => {
  const { entityId } = await addNodeOp(dataDir, WORLD, { name: "An Anchor For Intake", type: "concept" });
  const note = captureNote(WORLD, { text: "Something happened near the anchor.", anchorEntityId: entityId });
  const { status } = await postJson("/api/session-planner/notes/intake", { world: WORLD, noteIds: [note.id] });
  assertNever5xx(status, "session-planner/notes/intake");
  assert.equal(status, 200);
});

test("audit sweep: narrate (whole-batch), narrate-entity, and the standalone entity narrate route all degrade keyless -- 200, never 5xx", async () => {
  const { entityId } = await addNodeOp(dataDir, WORLD, { name: "A Narratable Node", type: "person" });

  // The standalone route looks up the most recent accepted mutation itself.
  const standalone = await postJson(`/api/entities/${entityId}/narrate`, { world: WORLD });
  assertNever5xx(standalone.status, "entities/:id/narrate");
  assert.equal(standalone.status, 200);
  assert.ok(typeof standalone.body.prose === "string" && standalone.body.prose.length > 0);
  assert.doesNotMatch(standalone.body.prose, /Offline pass|ANTHROPIC_API_KEY/i);

  // Whole-batch and batch+mutationId narrate, targeting the SAME batch/mutation.
  const wholeBatch = await postJson(`/api/batches/${standalone.body.batchId}/narrate`, { world: WORLD });
  assertNever5xx(wholeBatch.status, "batches/:id/narrate");
  assert.equal(wholeBatch.status, 200);

  const narrateEntity = await postJson(`/api/batches/${standalone.body.batchId}/narrate-entity`, { world: WORLD, mutationId: standalone.body.mutationId });
  assertNever5xx(narrateEntity.status, "batches/:id/narrate-entity");
  assert.equal(narrateEntity.status, 200);
});

test("audit sweep: POST /api/pending-entities/:id/resolve degrades keyless -- 200, never 5xx", async () => {
  const { entityId } = await addNodeOp(dataDir, WORLD, { name: "A Deferred Thread", type: "event" });
  writePending(WORLD, entityId, { causeTag: "A rumor spreads.", impactScore: 0.5, sourceBatchId: "manual", cycleDescriptor: "Manual" });
  const { status } = await postJson(`/api/pending-entities/${entityId}/resolve`, { world: WORLD });
  assertNever5xx(status, "pending-entities/:id/resolve");
  assert.equal(status, 200);
});

test("audit sweep: POST /api/batches/:id/regenerate degrades keyless (the per-region texture dispatch, via a manually-seeded batch with real mutations to regenerate) -- 200, never 5xx", async () => {
  const { createBatch } = await import("../../mutation-engine/review-state.mjs");
  const { entityId } = await addNodeOp(dataDir, WORLD, { name: "A Regenerate-Target Node", type: "concept" });
  const batch = createBatch(WORLD, { mode: "manual" }, "a test session", [
    { op: "upsert_entity", id: entityId, data: { importance: 0.6 }, rationale: "Seeded for regenerate coverage.", batchId: "placeholder", sourceKind: "manual", entityContext: { name: "A Regenerate-Target Node", importance: 0.6, tags: [] } }
  ]);
  const { status, body } = await postJson(`/api/batches/${batch.id}/regenerate`, { world: WORLD, scope: "batch", note: "try again, offline" });
  assertNever5xx(status, "batches/:id/regenerate (texture)");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.regenerated.length, 1);
});

test("audit sweep: POST /api/batches/:id/regenerate degrades keyless (the writeup-import dispatch -- regenerateWriteupImport re-runs the SAME offline extraction) -- 200, an honestly-empty replacement, never 5xx", async () => {
  const { createBatch } = await import("../../mutation-engine/review-state.mjs");
  const { entityId } = await addNodeOp(dataDir, WORLD, { name: "A Writeup-Regenerate Seed", type: "concept" });
  // A hand-seeded writeup-import-sourceKind batch WITH real original text
  // (batch.scope.text -- required by regenerateWriteupImport, since it
  // re-runs extraction against the batch's ORIGINALLY-STORED text, not the
  // note alone) and one real mutation, so scope='batch' has something to
  // replace.
  const batch = createBatch(WORLD, { mode: "writeup-import", text: "A merchant caravan arrives at dusk." }, undefined, [
    { op: "upsert_entity", id: entityId, data: { importance: 0.5 }, rationale: "Seeded for regenerate coverage.", batchId: "placeholder", sourceKind: "writeup-import", entityContext: { name: "A Writeup-Regenerate Seed", importance: 0.5, tags: [] } }
  ]);
  const { status, body } = await postJson(`/api/batches/${batch.id}/regenerate`, { world: WORLD, scope: "batch", note: "try again, offline" });
  assertNever5xx(status, "batches/:id/regenerate (writeup-import)");
  assert.equal(status, 200, JSON.stringify(body));
  // Honest offline re-extraction: replaces the one seeded mutation with
  // zero new ones (Fix 4 -- never invents entities from prose offline).
  assert.equal(body.regenerated.length, 0);
});

test("audit sweep: rubber-duck mode's writeup-propose framing phase, writeup-select-framing, and the reject-loop all degrade keyless -- 200, never 5xx", async () => {
  setRubberDuckMode(true);
  try {
    const phaseA = await postJson("/api/writeup-propose", { world: WORLD, text: "A festival turns tense as rumors spread." });
    assertNever5xx(phaseA.status, "writeup-propose (rubber-duck phase A)");
    assert.equal(phaseA.status, 200);
    assert.equal(phaseA.body.phase, "framing");
    assert.equal(phaseA.body.framings.length, 3);

    const phaseB = await postJson("/api/writeup-select-framing", {
      world: WORLD,
      writeupText: phaseA.body.writeupText,
      mode: phaseA.body.mode,
      framings: phaseA.body.framings,
      selection: { primary: phaseA.body.framings[0] },
      rubberDuck: phaseA.body.rubberDuck
    });
    assertNever5xx(phaseB.status, "writeup-select-framing (new batch)");
    assert.equal(phaseB.status, 200);

    // The reject-loop needs a batch with an actual mutation to reject
    // (rejectOp's own precondition, unrelated to this fix-wave) -- the
    // offline extraction above is honestly EMPTY (Fix 4), so hand-seed a
    // rubber-duck writeup-import batch WITH one real mutation instead of
    // reusing phaseB's own empty one, still targeting the SAME reject-loop
    // dispatch this test is about.
    const { createBatch } = await import("../../mutation-engine/review-state.mjs");
    const { entityId } = await addNodeOp(dataDir, WORLD, { name: "A Reject-Loop Seed", type: "concept" });
    const seededBatch = createBatch(
      WORLD,
      { mode: "writeup-import", text: "A festival turns tense as rumors spread.", rubberDuck: { enabled: true, updatedAt: null } },
      undefined,
      [{ op: "upsert_entity", id: entityId, data: { importance: 0.5 }, rationale: "Seeded for reject-loop coverage.", batchId: "placeholder", sourceKind: "writeup-import", entityContext: { name: "A Reject-Loop Seed", importance: 0.5, tags: [] } }]
    );

    // Reject-loop, quick-pick path -- triggers a NEW bounded framing round.
    const reject = await postJson(`/api/batches/${seededBatch.id}/reject`, { world: WORLD, scope: "batch", quickPickReason: Object.keys(QUICK_PICK_REASONS)[0] });
    assertNever5xx(reject.status, "batches/:id/reject (rubber-duck loop)");
    assert.equal(reject.status, 200, JSON.stringify(reject.body));
    assert.equal(reject.body.rubberDuckLoop?.kind, "reframe");
    assert.equal(reject.body.rubberDuckLoop.framings.length, 3);
  } finally {
    setRubberDuckMode(false);
  }
});
