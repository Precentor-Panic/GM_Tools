import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — session-planner/session-wrap.mjs (Session Wrap).
 * listWrapCandidates (pure read), suggestWrapTransitions (mocked haiku-tier
 * LLM call, validated against the real candidate set), applyWrapTransitions
 * (direct sidecar writes, no review batch), generateTruthNotes (mocked
 * sonnet-tier LLM call, player-safety-gated to ONLY the revealed entities).
 * See session-wrap.mjs's own header for the write-discipline/player-safety
 * reasoning this file's tests are pinning down.
 */

// Same isolation pattern as test/narrative-state.test.mjs / world-clock.test.mjs
// / plan-updates.test.mjs: every store this module transitively touches
// pointed at a scratch dir BEFORE any import. WF_TIMELINE_GIT=0 keeps the
// world-timeline commit (applyWrapTransitions' best-effort call) from ever
// shelling out to real git against scratch data.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-session-wrap-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_NARRATIVE_STATE_DIR = join(scratchDir, "narrative-state");
process.env.GM_TOOLS_TRUTH_NOTES_DIR = join(scratchDir, "truth-notes");
process.env.GM_TOOLS_PLANS_DIR = join(scratchDir, "session-plans");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_SESSION_NOTES_DIR = join(scratchDir, "session-notes");
process.env.GM_TOOLS_WORLD_CLOCK_DIR = join(scratchDir, "world-clock");
process.env.GM_TOOLS_APP_SETTINGS_DIR = join(scratchDir, "app-settings");
process.env.WF_TIMELINE_GIT = "0";
process.env.WF_DATA_DIR = dataDir;

const WORLD = "session-wrap-test-world";

const {
  listWrapCandidates,
  suggestWrapTransitions,
  applyWrapTransitions,
  generateTruthNotes
} = await import("../../session-planner/session-wrap.mjs");
const { setNarrativeTruth, setStance, setRevealState, getNarrativeState } = await import("../../mutation-engine/narrative-state.mjs");
const { getTruthNotesHistory, getCurrentTruthNotes } = await import("../../session-planner/truth-notes.mjs");
const { createPlan, addSceneToPlan } = await import("../../session-planner/plans.mjs");
const { createScene } = await import("../../session-planner/scenes.mjs");
const { captureNote } = await import("../../session-planner/session-notes.mjs");
const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "ent-mira", name: "Mira the Barkeep", type: "person", description: "A cheerful innkeeper.", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "ent-ghost", name: "The Miller's Ghost", type: "concept", description: "A cold draft near the mill.", importance: 0.4 } }
]);

// Narrative-state truths -- ent-mira will be revealed this session, ent-ghost
// stays withheld throughout (the player-safety control case).
setNarrativeTruth(dataDir, WORLD, "ent-mira", "She was a Crown intelligence spy for a decade.", { stance: "concealing" }, { now: "2026-09-02T09:00:00.000Z" });
setNarrativeTruth(dataDir, WORLD, "ent-ghost", "The miller's ghost drowned his own daughter.", { stance: "unaware" }, { now: "2026-09-02T09:00:00.000Z" });
// A record for an entity id that has NO snapshot entry at all -- the id-fallback case.
setNarrativeTruth(dataDir, WORLD, "ghost-id-not-in-graph", "Nobody living remembers this.", {}, { now: "2026-09-02T09:00:00.000Z" });
// An entity already fully revealed BEFORE wrap ever runs -- must never appear as a candidate.
setNarrativeTruth(dataDir, WORLD, "ent-already-known", "This was revealed long ago.", {}, { now: "2026-09-02T09:00:00.000Z" });
setRevealState(dataDir, WORLD, "ent-already-known", "revealed", { source: "manual" }, { now: "2026-09-02T09:00:00.000Z" });

// A Plan with one scene and a real session note, for the suggester's session-notes context.
const scene = createScene(WORLD, { name: "The Wayward Inn" }, { makeId: () => "scene-wrap-test" });
const plan = createPlan(WORLD, { name: "Session 1" }, { makeId: () => "plan-wrap-test" });
addSceneToPlan(WORLD, plan.id, scene.id);
captureNote(WORLD, { text: "Mira let slip she used to work for the Crown.", sceneId: scene.id }, { makeId: () => "note-wrap-test" });

function mockClient(responseText, captured) {
  return {
    messages: {
      create: async (params) => {
        if (captured) captured.push(params.messages[0].content);
        return { content: [{ type: "text", text: responseText }], stop_reason: "end_turn" };
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

// ------------------------------------------------------------- listWrapCandidates

test("listWrapCandidates: excludes fully-revealed entities, joins real names, falls back to raw id", () => {
  const { candidates } = listWrapCandidates(dataDir, WORLD);
  const ids = candidates.map((c) => c.entityId);

  assert.ok(!ids.includes("ent-already-known"), "a revealed entity must never be a wrap candidate");
  assert.ok(ids.includes("ent-mira") && ids.includes("ent-ghost") && ids.includes("ghost-id-not-in-graph"));

  const mira = candidates.find((c) => c.entityId === "ent-mira");
  assert.equal(mira.entityName, "Mira the Barkeep", "name joined from the live snapshot");
  assert.equal(mira.revealState, "unrevealed");
  assert.equal(mira.stance, "concealing");
  assert.equal(mira.truth, "She was a Crown intelligence spy for a decade.");

  const noSnapshotEntity = candidates.find((c) => c.entityId === "ghost-id-not-in-graph");
  assert.equal(noSnapshotEntity.entityName, "ghost-id-not-in-graph", "falls back to the raw id when no snapshot entity matches");
});

test("listWrapCandidates: a missing snapshot (no bootstrapSnapshot ever run for this world) still lists real candidates by id, never throws", () => {
  const noSnapshotWorld = "session-wrap-no-snapshot-world";
  setNarrativeTruth(dataDir, noSnapshotWorld, "orphan-entity", "A truth with nowhere to look up a name.", {}, { now: "2026-09-02T09:00:00.000Z" });

  const { candidates } = listWrapCandidates(dataDir, noSnapshotWorld);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].entityId, "orphan-entity");
  assert.equal(candidates[0].entityName, "orphan-entity", "no snapshot to join a name from -- falls back to the raw id, never throws");
});

// --------------------------------------------------------- suggestWrapTransitions

await testAsync("suggestWrapTransitions: valid suggestions pass through; an invented entityId and an invalid state are dropped with reasons", async () => {
  const captured = [];
  const response = JSON.stringify({
    suggestions: [
      { entityId: "ent-mira", suggestedState: "revealed", rationale: "She told the party outright." },
      { entityId: "made-up-entity-id", suggestedState: "revealed", rationale: "Invented id -- must be dropped." },
      { entityId: "ent-ghost", suggestedState: "not-a-real-reveal-state", rationale: "Invalid state -- must be dropped." }
    ]
  });

  const result = await suggestWrapTransitions(dataDir, WORLD, plan.id, { client: mockClient(response, captured) });

  assert.deepEqual(result.suggestions, [{ entityId: "ent-mira", suggestedState: "revealed", rationale: "She told the party outright." }]);
  assert.equal(result.dropped.length, 2);
  assert.ok(result.dropped.some((d) => d.entityId === "made-up-entity-id" && d.reason === "unknown entityId"));
  assert.ok(result.dropped.some((d) => d.entityId === "ent-ghost" && d.reason === "invalid revealState"));
  assert.equal(result.candidateCount, 3);

  // Prompt-content assertions: the GM-side suggester prompt must carry the
  // full candidate truth text (player-safety does NOT apply to this prompt)
  // and the real session-notes text assembled from the plan's scenes.
  assert.equal(captured.length, 1);
  const prompt = captured[0];
  assert.ok(prompt.includes("She was a Crown intelligence spy for a decade."), "candidate truth must reach the GM-side suggester prompt");
  assert.ok(prompt.includes("The miller's ghost drowned his own daughter."), "every withheld candidate's truth is GM-side content here");
  assert.ok(prompt.includes("Mira let slip she used to work for the Crown."), "the plan's own session notes must reach the prompt");
});

await testAsync("suggestWrapTransitions: an empty candidate roster skips the LLM call entirely", async () => {
  const emptyPlan = createPlan(WORLD, { name: "Empty" }, { makeId: () => "plan-wrap-empty" });
  let called = false;
  const client = { messages: { create: async () => { called = true; return { content: [{ type: "text", text: "{}" }], stop_reason: "end_turn" }; } } };
  const result = await suggestWrapTransitions(dataDir, "a-world-with-no-narrative-state", emptyPlan.id, { client });
  assert.equal(called, false, "no candidates means nothing to suggest over -- the model must not be called");
  assert.deepEqual(result, { suggestions: [], dropped: [], candidateCount: 0 });
});

// ----------------------------------------------------------- applyWrapTransitions

test("applyWrapTransitions: stamps source:'wrap' + sessionNumber, and is idempotent for a same-state decision", () => {
  const decisions = [{ entityId: "ent-mira", to: "revealed", note: "Told outright at the table." }];
  const result = applyWrapTransitions(dataDir, WORLD, decisions, { planId: plan.id, now: "2026-09-02T12:00:00.000Z" });

  assert.deepEqual(result.applied, [{ entityId: "ent-mira", to: "revealed" }]);
  assert.equal(typeof result.sessionNumber === "number" || result.sessionNumber === null, true);
  assert.equal(result.timeline.committed, false, "WF_TIMELINE_GIT=0 in this test file's scratch env");
  assert.match(result.timeline.warning, /WF_TIMELINE_GIT=0/);

  const record = getNarrativeState(dataDir, WORLD, "ent-mira");
  assert.equal(record.revealState, "revealed");
  const lastTransition = record.transitions[record.transitions.length - 1];
  assert.equal(lastTransition.from, "unrevealed");
  assert.equal(lastTransition.to, "revealed");
  assert.equal(lastTransition.source, "wrap");
  assert.equal(lastTransition.note, "Told outright at the table.");
  assert.equal(lastTransition.sessionNumber, result.sessionNumber);

  const transitionCountBefore = record.transitions.length;
  applyWrapTransitions(dataDir, WORLD, decisions, { planId: plan.id, now: "2026-09-02T13:00:00.000Z" });
  const recordAfter = getNarrativeState(dataDir, WORLD, "ent-mira");
  assert.equal(recordAfter.transitions.length, transitionCountBefore, "same-state decision is a safe no-op -- no duplicate transition");
});

// ------------------------------------------------------------- generateTruthNotes

await testAsync("generateTruthNotes: PLAYER-SAFETY -- prompt carries the revealed entity's name+truth, never a still-withheld entity's", async () => {
  const captured = [];
  const response = JSON.stringify({ markdown: "You learned that Mira has a secret past with the Crown." });

  const entry = await generateTruthNotes(dataDir, WORLD, plan.id, ["ent-mira"], {
    client: mockClient(response, captured),
    now: "2026-09-02T14:00:00.000Z",
    makeId: () => "tnote-first"
  });

  assert.equal(captured.length, 1);
  const prompt = captured[0];
  assert.ok(prompt.includes("Mira the Barkeep"), "the revealed entity's name must reach the recap prompt");
  assert.ok(prompt.includes("She was a Crown intelligence spy for a decade."), "the revealed entity's truth must reach the recap prompt");
  assert.ok(!prompt.includes("The Miller's Ghost"), "a still-withheld entity's name must NEVER reach the recap prompt");
  assert.ok(!prompt.includes("The miller's ghost drowned his own daughter."), "a still-withheld entity's truth must NEVER reach the recap prompt");

  assert.equal(entry.markdown, "You learned that Mira has a secret past with the Crown.");
  assert.deepEqual(entry.revealedEntityIds, ["ent-mira"]);
  assert.equal(entry.status, "current");
  assert.equal(entry.id, "tnote-first");
});

await testAsync("generateTruthNotes: a new generation supersedes the prior current entry, never deletes it", async () => {
  const response = JSON.stringify({ markdown: "A second cut of the same recap." });
  const entry2 = await generateTruthNotes(dataDir, WORLD, plan.id, ["ent-mira"], {
    client: mockClient(response),
    now: "2026-09-02T15:00:00.000Z",
    makeId: () => "tnote-second"
  });

  assert.equal(entry2.status, "current");
  const history = getTruthNotesHistory(WORLD, plan.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].id, "tnote-first");
  assert.equal(history[0].status, "superseded", "the prior entry is superseded, still present in history -- never deleted");
  assert.equal(history[1].id, "tnote-second");
  assert.equal(history[1].status, "current");

  const current = getCurrentTruthNotes(WORLD, plan.id);
  assert.equal(current.id, "tnote-second");
});

console.log(`\n${passed} passed`);
rmSync(scratchDir, { recursive: true, force: true });
