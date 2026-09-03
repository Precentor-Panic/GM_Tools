import assert from "node:assert/strict";
import { mkdtempSync as mkdtemp, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — the narrative-state knowledge gate in
 * session-planner/element-assist.mjs (WS3 of the Layer-2 plan), asserted on
 * ACTUAL PROMPT CONTENT:
 *  - draft-read-aloud (TABLE-facing, the sharpest pre-gate leak): hidden
 *    neighbors dropped entirely (name and description absent); withheld
 *    truths become the allusion block with per-stance guidance; the truth
 *    text itself never appears; a hidden anchor PLACE stays (the GM pointed
 *    the scene at it) but joins the allusion block;
 *  - propose-elements (GM-facing): full neighborhood + explicit GM-truth
 *    blocks (truth + stance, plainly);
 *  - gin-up regression: a world with zero records produces prompts with no
 *    gate artifacts at all.
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

const scratchDir = mkdtemp(join(tmpdir(), "gm-tools-element-assist-gate-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_SCENE_ELEMENTS_DIR = join(scratchDir, "scene-elements");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_PLANS_DIR = join(scratchDir, "session-plans");
process.env.GM_TOOLS_NARRATIVE_STATE_DIR = join(scratchDir, "narrative-state");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "element-assist-gate-test-world";

const { assistScenePrep } = await import("../../session-planner/element-assist.mjs");
const { createScene } = await import("../../session-planner/scenes.mjs");
const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { setNarrativeTruth, setRevealState } = await import("../../mutation-engine/narrative-state.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "gate-inn", name: "The Gilded Ewer", type: "place", importance: 0.6, description: "A busy dockside inn." } },
  { op: "upsert_entity", data: { id: "gate-marek", name: "Marek", type: "person", importance: 0.5, description: "The affable barkeep." } },
  { op: "upsert_entity", data: { id: "smugglers-cache", name: "The Smugglers' Cache", type: "place", importance: 0.5, description: "A hollow beneath the cellar." } },
  { op: "upsert_edge", data: { id: "ea1", sourceId: "gate-marek", targetId: "gate-inn", relationshipType: "presence" } },
  { op: "upsert_edge", data: { id: "ea2", sourceId: "smugglers-cache", targetId: "gate-inn", relationshipType: "containment" } }
]);

const scene = createScene(WORLD, { name: "Evening at the Ewer", locationEntityId: "gate-inn", objectiveNote: "Find out who is moving crates at night." });

function mockClient(replyObj) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params.messages[0].content);
        return { content: [{ type: "text", text: JSON.stringify(replyObj) }], stop_reason: "end_turn" };
      }
    }
  };
}

// ---------------- gin-up regression FIRST (before any records exist) -------

await testAsync("REGRESSION: zero records => read-aloud prompt has no gate artifacts; all neighbors plain context", async () => {
  const client = mockClient({ narration: "Lamplight and spilled ale." });
  await assistScenePrep(dataDir, WORLD, scene.id, { mode: "draft-read-aloud" }, { client });
  const prompt = client.calls[0];
  assert.doesNotMatch(prompt, /UNREVEALED TRUTHS/);
  assert.doesNotMatch(prompt, /\{\{withheldGuidance\}\}/, "slot filled empty, never literal");
  assert.match(prompt, /The Smugglers' Cache/, "future-hidden neighbor is plain context while no record exists");
});

await testAsync("REGRESSION: zero records => propose-elements prompt has no GM-truth block and no literal slot", async () => {
  const client = mockClient({ elements: [{ name: "A crate", fields: { gives: "salt smell" } }] });
  await assistScenePrep(dataDir, WORLD, scene.id, { mode: "propose-elements" }, { client });
  const prompt = client.calls[0];
  assert.doesNotMatch(prompt, /GM TRUTH/);
  assert.doesNotMatch(prompt, /\{\{gmTruthContext\}\}/);
});

// -------------------------------------------- flag the secrets, then gate --

await testAsync("draft-read-aloud (TABLE): hidden neighbor fully absent; concealing barkeep alluded to; truth text never present", async () => {
  setNarrativeTruth(dataDir, WORLD, "gate-marek", "Marek runs the smuggling ring himself.", { stance: "concealing" });
  setRevealState(dataDir, WORLD, "smugglers-cache", "hidden", { source: "manual" });

  const client = mockClient({ narration: "The barkeep's smile doesn't reach his eyes." });
  await assistScenePrep(dataDir, WORLD, scene.id, { mode: "draft-read-aloud" }, { client });
  const prompt = client.calls[0];
  assert.doesNotMatch(prompt, /Smugglers' Cache/, "hidden neighbor's name must not appear");
  assert.doesNotMatch(prompt, /hollow beneath the cellar/, "hidden neighbor's description must not appear");
  assert.match(prompt, /UNREVEALED TRUTHS/);
  assert.match(prompt, /Marek: actively concealing/, "stance guidance crosses the gate");
  assert.doesNotMatch(prompt, /smuggling ring/, "the truth text must NEVER reach a table prompt");
  assert.match(prompt, /The affable barkeep/, "the withheld-but-visible neighbor's SURFACE stays");
});

await testAsync("draft-read-aloud: a HIDDEN anchor place stays in the prompt but joins the allusion block", async () => {
  setRevealState(dataDir, WORLD, "gate-inn", "hidden", { source: "manual" });
  try {
    const client = mockClient({ narration: "You shouldn't be here." });
    await assistScenePrep(dataDir, WORLD, scene.id, { mode: "draft-read-aloud" }, { client });
    const prompt = client.calls[0];
    assert.match(prompt, /Name: The Gilded Ewer/, "the GM pointed the scene at it — the place stays");
    assert.match(prompt, /The Gilded Ewer: holds something the players have not learned/);
  } finally {
    setRevealState(dataDir, WORLD, "gate-inn", "revealed", { source: "manual" });
  }
});

await testAsync("propose-elements (GM): full neighborhood kept AND truth+stance injected plainly", async () => {
  const client = mockClient({ elements: [{ name: "A ledger", fields: { gives: "the night-shift roster" } }] });
  await assistScenePrep(dataDir, WORLD, scene.id, { mode: "propose-elements" }, { client });
  const prompt = client.calls[0];
  assert.match(prompt, /The Smugglers' Cache/, "GM prep keeps hidden entities visible");
  assert.match(prompt, /GM truths in play here/);
  assert.match(prompt, /Marek runs the smuggling ring himself\./, "GM prompts get the truth plainly");
  assert.match(prompt, /Stance: concealing/);
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
