/**
 * Post-session graph update — pure text assembly, no LLM plumbing of its
 * own. Phase 26 task 26.9, §26.E.
 *
 * The project owner's own proposed shape: after a session, take the
 * collected scene notes (Add Event notes, already scene-scoped via
 * session-notes.mjs's existing `sceneId` field) plus their associated
 * scenes' context, run one LLM call proposing graph updates, and route it
 * through the EXISTING DM review/accept/reject workflow. This module is
 * ONLY the "assemble a Plan's scenes' notes into writeup-shaped text" step
 * -- the actual LLM extraction / dry-run merge / review-state batch
 * creation is entirely graph-import/writeup-import.mjs's own importWriteup,
 * called directly by review-ui/server.mjs's new route, never duplicated
 * here.
 *
 * Deliberately does NOT mark the assembled notes `consumed` -- that field's
 * existing meaning (session-notes.mjs's own runBatchIntake) is tied to a
 * DIFFERENT pipeline (per-note scan-mentions intake); overloading it here
 * would conflate two genuinely different consumption models. A note may
 * legitimately appear in more than one propose-updates run (e.g. two
 * different Plans sharing a scene) -- not addressed by this task's own
 * acceptance criteria, flagged here rather than silently decided either way.
 */
import { getPlan } from "./plans.mjs";
import { getScene } from "./scenes.mjs";
import { listPendingNotes } from "./session-notes.mjs";
import { loadSnapshot } from "../wf-mcp-server/lib/snapshot.mjs";
import { importWriteup } from "../graph-import/writeup-import.mjs";

/**
 * @param {string} world
 * @param {string} planId
 * @param {Map<string,string>} entityNameById   anchor-entity id -> real name, caller-loaded (this module has no snapshot access of its own)
 * @returns {{text:string, noteIds:string[], sceneCount:number}}
 */
export function assembleWriteupTextForPlan(world, planId, entityNameById) {
  const plan = getPlan(world, planId); // throws "No plan found" if unknown, uncaught/unreinterpreted

  const notesBySceneId = new Map();
  for (const note of listPendingNotes(world)) {
    if (!note.sceneId || !plan.sceneIds.includes(note.sceneId)) continue;
    if (!notesBySceneId.has(note.sceneId)) notesBySceneId.set(note.sceneId, []);
    notesBySceneId.get(note.sceneId).push(note);
  }

  const sections = [];
  const noteIds = [];
  let sceneCount = 0;

  for (const sceneId of plan.sceneIds) {
    const notes = notesBySceneId.get(sceneId);
    if (!notes || !notes.length) continue; // a Plan scene with no notes yet contributes nothing

    const scene = getScene(world, sceneId);
    const anchorName = scene.locationEntityId ? (entityNameById.get(scene.locationEntityId) ?? scene.locationEntityId) : null;
    const sceneName = scene.name || anchorName || scene.objectiveNote || "Ad-hoc scene";
    const heading = anchorName && anchorName !== sceneName ? `## ${sceneName} (at ${anchorName})` : `## ${sceneName}`;

    sections.push([heading, ...notes.map((n) => n.text)].join("\n"));
    for (const n of notes) noteIds.push(n.id);
    sceneCount++;
  }

  return { text: sections.join("\n\n"), noteIds, sceneCount };
}

/**
 * The full composition (§26.E): assemble a Plan's scenes' notes, then
 * delegate straight to the EXISTING importWriteup() -- no logic duplicated.
 * Exported as a genuine, directly-callable op (not just inlined into
 * review-ui/server.mjs's route) SPECIFICALLY so it can be exercised with a
 * real, working `opts.llmOpts.client` injection in tests -- a live function
 * reference cannot survive a real HTTP JSON round trip (fetch()/
 * JSON.stringify silently drop function properties), so any test wanting a
 * genuinely-working injected client must call this in-process, exactly the
 * way graph-import/writeup-import.test.mjs's own tests already call
 * proposeWfiFromWriteup/importWriteup directly. review-ui/server.mjs's
 * route is a thin wrapper over this function; when hit for real (no
 * injected client), it falls through to a real Anthropic client exactly
 * like every other writeup-import-backed route already does.
 *
 * @param {string} dir
 * @param {string} world
 * @param {string} planId
 * @param {object} [opts]
 * @param {object} [opts.llmOpts]   forwarded to importWriteup unchanged
 * @returns {Promise<{batchId:string, mutationCount:number, importSummary:object, suggestions:object[], headline:string}>}
 */
export async function proposeUpdatesForPlan(dir, world, planId, opts = {}) {
  const { entities, edges, entityTypes } = loadSnapshot(dir, world).snapshot;
  const entityNameById = new Map(entities.map((e) => [e.id, e.name]));
  const { text } = assembleWriteupTextForPlan(world, planId, entityNameById);
  if (!text.trim()) {
    throw new Error(`Plan "${planId}" has no pending scene notes to propose updates from yet -- add some Add Event notes first.`);
  }
  return importWriteup(world, text, { entities, edges, entityTypes }, { llmOpts: opts.llmOpts });
}

/**
 * Phase 28 task 28.1: the scene-scoped mirror of assembleWriteupTextForPlan
 * above, one level down -- a SINGLE scene's own pending notes (not a Plan's
 * worth across many scenes). Same per-scene section-heading logic
 * (name/anchor-name fallback), just scoped to one sceneId instead of
 * iterating a Plan's `sceneIds`.
 *
 * @param {string} world
 * @param {string} sceneId
 * @param {Map<string,string>} entityNameById   anchor-entity id -> real name, caller-loaded (this module has no snapshot access of its own)
 * @returns {{text:string, noteIds:string[]}}
 */
export function assembleWriteupTextForScene(world, sceneId, entityNameById) {
  const scene = getScene(world, sceneId); // throws "No scene found" if unknown, uncaught/unreinterpreted

  const notes = listPendingNotes(world).filter((n) => n.sceneId === sceneId);
  if (!notes.length) return { text: "", noteIds: [] };

  const anchorName = scene.locationEntityId ? (entityNameById.get(scene.locationEntityId) ?? scene.locationEntityId) : null;
  const sceneName = scene.name || anchorName || scene.objectiveNote || "Ad-hoc scene";
  const heading = anchorName && anchorName !== sceneName ? `## ${sceneName} (at ${anchorName})` : `## ${sceneName}`;

  return {
    text: [heading, ...notes.map((n) => n.text)].join("\n"),
    noteIds: notes.map((n) => n.id)
  };
}

/**
 * The scene-scoped mirror of proposeUpdatesForPlan above: assemble ONE
 * scene's own pending notes, then delegate straight to the EXISTING
 * importWriteup() -- zero change to importWriteup, no logic duplicated.
 * Response shape is byte-identical to proposeUpdatesForPlan's own
 * `{batchId, mutationCount, importSummary, suggestions, headline}`, per the
 * Wrap route contract (review-ui/test/e2e/phase28-fixture.mjs §6).
 *
 * @param {string} dir
 * @param {string} world
 * @param {string} sceneId
 * @param {object} [opts]
 * @param {object} [opts.llmOpts]   forwarded to importWriteup unchanged
 * @returns {Promise<{batchId:string, mutationCount:number, importSummary:object, suggestions:object[], headline:string}>}
 */
export async function proposeUpdatesForScene(dir, world, sceneId, opts = {}) {
  const { entities, edges, entityTypes } = loadSnapshot(dir, world).snapshot;
  const entityNameById = new Map(entities.map((e) => [e.id, e.name]));
  const { text } = assembleWriteupTextForScene(world, sceneId, entityNameById);
  if (!text.trim()) {
    throw new Error(`Scene "${sceneId}" has no pending notes to propose updates from yet -- add some Add Event notes first.`);
  }
  return importWriteup(world, text, { entities, edges, entityTypes }, { llmOpts: opts.llmOpts });
}
