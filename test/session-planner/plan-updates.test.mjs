import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — session-planner/plan-updates.mjs. This is the first
 * dedicated unit-test file for this module (it previously had only
 * route/e2e coverage) — added while extending it with
 * `assembleWriteupTextForScene`/`proposeUpdatesForScene` (Phase 28 task
 * 28.1, the scene-scoped mirrors of the already-shipped Phase 26
 * `assembleWriteupTextForPlan`/`proposeUpdatesForPlan`), per
 * gm-tools-conventions' "deterministic logic must have unit tests before
 * done" and this task's own instruction to test the assembly step
 * deterministically and the propose step with a mocked LLM client (mirrors
 * test/writeup-import.test.mjs's own mockClient pattern).
 *
 * assembleWriteupTextForScene(world, sceneId, entityNameById) is PURE text
 * assembly, no LLM call -- a single scene's own pending notes (session-notes.mjs)
 * turned into one writeup-shaped section, or {text:"", noteIds:[]} if the
 * scene has no pending notes. proposeUpdatesForScene(dir, world, sceneId, opts)
 * assembles then delegates straight to the EXISTING, unmodified importWriteup()
 * -- same response shape as proposeUpdatesForPlan: {batchId, mutationCount,
 * importSummary, suggestions, headline}.
 */

// Same isolation pattern as test/writeup-import.test.mjs: point every store
// this module transitively touches at a scratch dir BEFORE any import.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-plan-updates-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PLANS_DIR = join(scratchDir, "session-plans");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_SESSION_NOTES_DIR = join(scratchDir, "session-notes");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "plan-updates-test-world";

const { assembleWriteupTextForScene, proposeUpdatesForScene } = await import("../../session-planner/plan-updates.mjs");
const { createScene } = await import("../../session-planner/scenes.mjs");
const { captureNote } = await import("../../session-planner/session-notes.mjs");
const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { loadBatch } = await import("../../mutation-engine/review-state.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "place-anchor-pu", name: "The Wayward Inn", type: "place", importance: 0.5 } }
]);

// Same mockClient helper as test/writeup-import.test.mjs -- a minimal stand-in
// for the Anthropic SDK's messages.create shape.
function mockClient(responses) {
  let call = 0;
  return {
    messages: {
      create: async () => {
        const resp = responses[Math.min(call, responses.length - 1)];
        call++;
        return { content: [{ type: "text", text: resp }], stop_reason: "end_turn" };
      }
    }
  };
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

// ------------------------------------------- assembleWriteupTextForScene (pure)

test("assembleWriteupTextForScene: {text:'', noteIds:[]} for a scene with no pending notes -- not an error", () => {
  const scene = createScene(WORLD, { locationEntityId: "place-anchor-pu" }, { makeId: () => "scene-no-notes" });
  const result = assembleWriteupTextForScene(WORLD, scene.id, new Map());
  assert.deepEqual(result, { text: "", noteIds: [] });
});

test("assembleWriteupTextForScene: throws a clear error for an unknown sceneId", () => {
  assert.throws(() => assembleWriteupTextForScene(WORLD, "scene-does-not-exist", new Map()), /No scene found/);
});

test("assembleWriteupTextForScene: assembles ONLY this scene's own pending notes, heading uses the anchor place's real name", () => {
  const scene = createScene(WORLD, { locationEntityId: "place-anchor-pu" }, { makeId: () => "scene-with-notes" });
  const otherScene = createScene(WORLD, { locationEntityId: "place-anchor-pu" }, { makeId: () => "scene-other-notes" });
  captureNote(WORLD, { text: "The barkeep mentions a missing shipment.", sceneId: scene.id }, { makeId: () => "note-1" });
  captureNote(WORLD, { text: "A hooded figure watches from the corner.", sceneId: scene.id }, { makeId: () => "note-2" });
  captureNote(WORLD, { text: "Unrelated note for a different scene.", sceneId: otherScene.id }, { makeId: () => "note-other" });

  const entityNameById = new Map([["place-anchor-pu", "The Wayward Inn"]]);
  const result = assembleWriteupTextForScene(WORLD, scene.id, entityNameById);

  assert.ok(result.text.includes("The Wayward Inn"), "heading must use the anchor place's real name");
  assert.ok(result.text.includes("The barkeep mentions a missing shipment."));
  assert.ok(result.text.includes("A hooded figure watches from the corner."));
  assert.ok(!result.text.includes("Unrelated note"), "must not pull in another scene's notes");
  assert.deepEqual(result.noteIds, ["note-1", "note-2"]);
});

test("assembleWriteupTextForScene: falls back to scene.name, then objectiveNote, then 'Ad-hoc scene' when there is no anchor place", () => {
  const namedScene = createScene(WORLD, { name: "The Confrontation" }, { makeId: () => "scene-named-fallback" });
  captureNote(WORLD, { text: "Swords are drawn.", sceneId: namedScene.id }, { makeId: () => "note-named" });
  const namedResult = assembleWriteupTextForScene(WORLD, namedScene.id, new Map());
  assert.ok(namedResult.text.includes("The Confrontation"));

  const objectiveScene = createScene(WORLD, { objectiveNote: "Find the missing courier" }, { makeId: () => "scene-objective-fallback" });
  captureNote(WORLD, { text: "A torn cloak is found.", sceneId: objectiveScene.id }, { makeId: () => "note-objective" });
  const objectiveResult = assembleWriteupTextForScene(WORLD, objectiveScene.id, new Map());
  assert.ok(objectiveResult.text.includes("Find the missing courier"));

  const adHocScene = createScene(WORLD, {}, { makeId: () => "scene-adhoc-fallback" });
  captureNote(WORLD, { text: "Something happens.", sceneId: adHocScene.id }, { makeId: () => "note-adhoc" });
  const adHocResult = assembleWriteupTextForScene(WORLD, adHocScene.id, new Map());
  assert.ok(adHocResult.text.includes("Ad-hoc scene"));
});

// ------------------------------------------- proposeUpdatesForScene (mocked LLM)

await testAsync("proposeUpdatesForScene: throws a clear error when the scene has no pending notes", async () => {
  const scene = createScene(WORLD, { locationEntityId: "place-anchor-pu" }, { makeId: () => "scene-propose-empty" });
  await assert.rejects(() => proposeUpdatesForScene(dataDir, WORLD, scene.id), /no pending notes/);
});

await testAsync("proposeUpdatesForScene: end-to-end (mocked LLM) creates a real review-state batch, response shape matches proposeUpdatesForPlan's own", async () => {
  const scene = createScene(WORLD, { locationEntityId: "place-anchor-pu" }, { makeId: () => "scene-propose-full" });
  captureNote(WORLD, { text: "The innkeeper, Mira, reveals she used to be a spy.", sceneId: scene.id }, { makeId: () => "note-propose-1" });

  const goodResponse = JSON.stringify({
    entities: [
      { name: "Mira", type: "person", description: "The innkeeper, formerly a spy.", importance: 0.5, rationale: "Revealed in the scene notes." }
    ],
    edges: []
  });
  const client = mockClient([goodResponse]);

  const result = await proposeUpdatesForScene(dataDir, WORLD, scene.id, { llmOpts: { client } });

  assert.ok(result.batchId);
  assert.equal(result.mutationCount, 1);
  assert.ok(Array.isArray(result.suggestions));
  assert.ok(result.importSummary);
  assert.ok(typeof result.headline === "string" && result.headline.length > 0);

  const batch = loadBatch(WORLD, result.batchId);
  assert.equal(batch.scope.mode, "writeup-import", "delegates to the EXISTING importWriteup pipeline, not a second one");
  assert.equal(batch.mutations.length, 1);
  assert.equal(batch.mutations[0].status, "pending", "review-gated -- proposes, never auto-writes");
});

console.log(`\n${passed} passed`);
rmSync(scratchDir, { recursive: true, force: true });
