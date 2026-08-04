import assert from "node:assert/strict";
import { mkdtempSync as mkdtemp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — new `session-planner/element-assist.mjs` (Phase 28
 * task 28.4, §E). The `✦` scene-element functional-prep LLM assist:
 *  - loads the scene's place + one-hop graph neighbors + already-keyed elements
 *    as context,
 *  - calls the model through the SAME `opts.client` injection seam every other
 *    outbound-LLM call site uses (mutation-engine/llm-call.mjs),
 *  - Zod-validates each returned element's `fields` against scene-elements.mjs's
 *    own SceneElementFields shape (dropping unknown keys so one stray key never
 *    fails the whole draft),
 *  - returns store-shaped drafts and NEVER writes to the graph or the store.
 *
 * Per gm-tools-conventions' LLM-code rule: this is the mocked-client unit test
 * (orchestration/validation/shaping); the real round-trip is a documented
 * manual smoke test in the module header, not run here.
 */

let passed = 0;
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

// Isolate every store this module transitively touches BEFORE any import,
// mirroring test/scene-planning/scene-elements.test.mjs exactly.
const scratchDir = mkdtemp(join(tmpdir(), "gm-tools-element-assist-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_SCENE_ELEMENTS_DIR = join(scratchDir, "scene-elements");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_PLANS_DIR = join(scratchDir, "session-plans");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "element-assist-test-world";

const { assistScenePrep, DEFAULT_ELEMENT_ASSIST_MODEL } = await import("../../session-planner/element-assist.mjs");
const { createScene } = await import("../../session-planner/scenes.mjs");
const { createElement, listElementsForScene } = await import("../../session-planner/scene-elements.mjs");
const { snapshotFilePath, loadSnapshot } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "place-crypt", name: "The Drowned Crypt", type: "place", importance: 0.6, description: "A flooded burial vault beneath the chapel." } },
  { op: "upsert_entity", data: { id: "npc-sexton", name: "Old Maur the Sexton", type: "person", importance: 0.5, description: "Keeps the crypt." } },
  { op: "upsert_edge", data: { id: "edge-sexton-crypt", sourceId: "npc-sexton", targetId: "place-crypt", relationshipType: "containment" } }
]);

const scene = createScene(WORLD, { locationEntityId: "place-crypt" }, { makeId: () => "scene-crypt-1" });

/** A fake Anthropic-SDK-shaped client that returns a canned JSON body and records the prompt it saw. */
function fakeClient(jsonBody, capture = {}) {
  return {
    messages: {
      async create(args) {
        capture.model = args.model;
        capture.prompt = args.messages?.[0]?.content ?? "";
        return {
          content: [{ type: "text", text: typeof jsonBody === "string" ? jsonBody : JSON.stringify(jsonBody) }],
          stop_reason: "end_turn"
        };
      }
    }
  };
}

await testAsync("propose-elements: validates + shapes canned drafts, never writes to the store", async () => {
  const capture = {};
  const client = fakeClient({
    elements: [
      { name: "A blood-stamped ledger", fields: { trigger: "PCs read it", gives: "the heir was disinherited", means: "motive for the murder" } },
      { name: "A rusted grate", fields: { trigger: "PCs pry it open", gives: "access to the sub-crypt", checks: [{ skill: "Athletics", dc: 13, purpose: "wrench it free" }] } }
    ]
  }, capture);

  const out = await assistScenePrep(dataDir, WORLD, scene.id, { mode: "propose-elements" }, { client });

  assert.equal(out.elements.length, 2, "both proposed elements survive validation");
  assert.equal(out.elements[0].name, "A blood-stamped ledger");
  assert.equal(out.elements[0].fields.trigger, "PCs read it");
  assert.deepEqual(out.elements[1].fields.checks, [{ skill: "Athletics", dc: 13, purpose: "wrench it free" }]);

  // Default model + grounded context reached the client.
  assert.equal(capture.model, DEFAULT_ELEMENT_ASSIST_MODEL);
  assert.match(capture.prompt, /The Drowned Crypt/, "the room name grounds the prompt");
  assert.match(capture.prompt, /Old Maur the Sexton/, "the one-hop graph neighbor grounds the prompt");

  // Purely a draft — nothing was persisted to the scene-elements store.
  assert.deepEqual(listElementsForScene(WORLD, scene.id), [], "assist must NOT write to the store — the caller persists");
});

await testAsync("propose-elements: an unknown field key is dropped, not fatal; a nameless element is skipped", async () => {
  const client = fakeClient({
    elements: [
      { name: "A guttering candle", fields: { looks: "a stub of black wax", bogusKey: "should be dropped", gives: "nothing useful" } },
      { name: "   ", fields: { trigger: "ignored" } }
    ]
  });
  const out = await assistScenePrep(dataDir, WORLD, scene.id, { mode: "propose-elements" }, { client });
  assert.equal(out.elements.length, 1, "the nameless element is filtered out");
  assert.equal(out.elements[0].fields.looks, "a stub of black wax");
  assert.equal(out.elements[0].fields.gives, "nothing useful");
  assert.ok(!("bogusKey" in out.elements[0].fields), "an unknown key is dropped so it survives the store's strict schema later");
});

await testAsync("draft-fields: returns exactly the one named element (case-insensitive match)", async () => {
  const client = fakeClient({
    elements: [
      { name: "A blood-stamped ledger", fields: { trigger: "PCs read it", gives: "the will names a secret heir", function: "estate record" } }
    ]
  });
  const out = await assistScenePrep(dataDir, WORLD, scene.id, { mode: "draft-fields", elementName: "a blood-stamped ledger" }, { client });
  assert.equal(out.elements.length, 1);
  assert.equal(out.elements[0].name, "A blood-stamped ledger");
  assert.equal(out.elements[0].fields.function, "estate record");
});

await testAsync("draft-fields: requires a non-empty elementName", async () => {
  await assert.rejects(
    () => assistScenePrep(dataDir, WORLD, scene.id, { mode: "draft-fields" }, { client: fakeClient({ elements: [] }) }),
    /requires a non-empty elementName/
  );
});

await testAsync("already-keyed elements are surfaced to the model as context (don't re-propose)", async () => {
  createElement(WORLD, scene.id, { name: "An existing altar" });
  const capture = {};
  await assistScenePrep(dataDir, WORLD, scene.id, { mode: "propose-elements" }, { client: fakeClient({ elements: [] }, capture) });
  assert.match(capture.prompt, /An existing altar/, "elements already keyed in the room are listed in the prompt");
  // clean up so this test is order-independent-ish (store is scratch anyway)
});

console.log(`\nelement-assist: ${passed} passed`);
