import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — new `mutation-engine/scene-develop.mjs` (Phase 22
 * task 22.5). This module does not exist yet; this file is the interface
 * spec for it, per plans/phase-22-tasks.md task 22.0. Expected to fail with
 * "Cannot find module" until 22.5 lands.
 *
 * Implements plans/phase-21-review.md §5's "Develop this scene" batch
 * action AND §12's identified engine-layer requirement: "A server-side
 * batch development orchestrator ... running the existing
 * propose->reframe->generate->accept round-trip across every scene member
 * with real sequencing and partial-failure handling. Must not be a
 * client-side loop calling the single-node flow N times."
 *
 * It SEQUENCES wf-mcp-server/lib/prep-content-ops.mjs's existing
 * proposePrepFramingsOp / reframePrepFramingsOp / generatePrepContentOp --
 * imported and called, never reimplemented. Each member's result still
 * lands on the EXISTING accept/discard gate (acceptPrepContentOp /
 * discardPrepContentOp) -- this orchestrator proposes/generates, it NEVER
 * calls either of those itself, so nothing it produces is ever silently
 * treated as accepted.
 *
 * ---------------------------------------------------------------------------
 * developScene(dir, world, sceneId, memberEntityIds, opts = {})
 * ---------------------------------------------------------------------------
 *   @param {string} dir
 *   @param {string} world
 *   @param {string} sceneId                for scene-undo session scoping (22.4) only
 *   @param {string[]} memberEntityIds       ALL scene members to develop, IN ORDER
 *   @param {object} [opts.selections]       { [entityId]: <selection> } -- OPTIONAL.
 *     If a member id has an entry here, that member's pass runs BOTH
 *     propose AND generate (the caller already knows which framing to use
 *     -- selection is the same shape generatePrepContentOp's own
 *     `selection` param already takes). If a member id is ABSENT here, that
 *     member's pass runs propose ONLY, returning its framings for later
 *     review -- the per-node continuation (pick a framing, then generate)
 *     happens through the SAME existing single-node prep-content-ops.mjs
 *     routes afterward; this orchestrator is not a second review mechanism.
 *   @param {string[]} [opts.reframeMemberIds]   member ids that get ONE
 *     bounded reframePrepFramingsOp round instead of a fresh propose (the
 *     batch-scale mirror of the single-node reject-loop).
 *   @param {object} [opts.priorRoundCounts]  { [entityId]: number } for reframe members
 *   @param {object} [opts.ops]   INJECTABLE override of
 *     { proposePrepFramingsOp, reframePrepFramingsOp, generatePrepContentOp }
 *     -- defaults to the REAL prep-content-ops.mjs imports. This is the
 *     test-injection point: it lets a test mock a mid-batch failure or
 *     record call order without needing a real LLM client three modules
 *     deep. Production callers never pass this.
 *   @param {boolean} [opts.recordUndo]   default true -- whether completed
 *     GENERATE steps get recorded into 22.4's scene-undo session via
 *     mutation-engine/scene-undo.mjs's recordSceneUndoAction (a session
 *     must already be started by the caller via startSceneUndoSession
 *     before calling developScene with recordUndo left at its default).
 *     PROPOSE-only members record nothing (an unaccepted, not-yet-generated
 *     framing round has nothing durable to unwind).
 *
 * SCENE-UNDO RECORDING SHAPE (pinned -- prep-content generation is NOT a
 * graph mutation and does not fit manual-undo.mjs's ManualUndoKind values
 * semantically, but manual-undo.mjs's UndoAction.graphMutations field is
 * typed `z.array(z.record(z.string(), z.any()))` -- an array of ARBITRARY
 * objects, not constrained to real upsert/delete op names at the schema
 * level -- so a synthetic, non-graph-mutation marker validates cleanly
 * without touching or widening manual-undo.mjs's schema at all). For each
 * completed GENERATE step, developScene calls
 * recordSceneUndoAction(world, sceneId, {
 *   kind: "edit_node",   // the closest-fitting EXISTING ManualUndoKind value -- reused verbatim, no new kind added
 *   description: `Developed content for entity "${entityId}".`,
 *   graphMutations: [{ op: "discard_prep_content", entityId }]
 * })
 * The `discard_prep_content` op is a SYNTHETIC marker meaningful only to a
 * future undo-APPLYING caller (Phase 23's UI, which knows to call
 * prep-content-ops.mjs's discardPrepContentOp(w, {entityId}) when it pops
 * this action) -- scene-undo.mjs and scene-develop.mjs themselves never
 * interpret or apply it, exactly matching manual-undo.mjs's own established
 * "the UndoAction just carries data, a separate caller applies it" split.
 *
 *   @returns {Promise<{sceneId:string, results: Array<{
 *     entityId: string,
 *     ok: boolean,
 *     stage: 'framed'|'generated',
 *     framings?: object,
 *     prepContent?: object,
 *     error?: string
 *   }>}>}
 *
 * SEQUENCING (real, observable, server-side -- NOT `Promise.all`):
 * memberEntityIds are processed ONE AT A TIME, IN ARRAY ORDER. A test can
 * observe this directly via opts.ops's injected mock functions, each
 * pushing onto a shared call-order array as they're invoked -- the
 * recorded order must exactly equal memberEntityIds' own order, and (the
 * "genuinely sequenced, not a dumb parallel fan-out" property) member N's
 * call must not begin until member N-1's own promise has already resolved.
 *
 * PARTIAL FAILURE: if member K's proposePrepFramingsOp/generatePrepContentOp
 * call rejects, that member's result entry is `{entityId, ok:false, error}`
 * and the loop CONTINUES to member K+1 -- it does NOT abort the whole
 * batch, and does NOT throw out of developScene itself (the returned
 * promise still resolves, with every OTHER member's own real result
 * intact). Nothing failed, and nothing merely proposed/generated, is EVER
 * passed to acceptPrepContentOp by this module -- confirmed both by a
 * behavioral test (no acceptPrepContentOp-shaped side effect observable)
 * and a source-grep (this module's own source never calls
 * acceptPrepContentOp/discardPrepContentOp at all).
 */

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-scene-develop-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SCENE_UNDO_DIR = join(scratchDir, "scene-undo");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");

const WORLD = "scene-develop-test-world";
const SCENE_ID = "scene-develop-test-scene";

let passed = 0;
async function test(name, fn) {
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

/** Builds an injectable opts.ops trio that records call order and can be told to reject for specific entity ids. */
function makeMockOps({ failFor = new Set(), delays = {} } = {}) {
  const callOrder = [];
  const inFlight = new Set();
  const concurrencyViolations = [];

  async function tracked(entityId, fn) {
    callOrder.push(entityId);
    if (inFlight.size > 0) concurrencyViolations.push(entityId); // something else was still running when this started
    inFlight.add(entityId);
    if (delays[entityId]) await new Promise((r) => setTimeout(r, delays[entityId]));
    try {
      if (failFor.has(entityId)) throw new Error(`Mocked failure for ${entityId}`);
      return fn();
    } finally {
      inFlight.delete(entityId);
    }
  }

  return {
    callOrder,
    concurrencyViolations,
    ops: {
      proposePrepFramingsOp: async (dir, w, { entityId }) =>
        tracked(entityId, () => ({ entityId, entityType: "person", entityName: entityId, framings: [{ id: "f1", text: "framing" }], framingRound: 1 })),
      reframePrepFramingsOp: async (dir, w, { entityId }) =>
        tracked(entityId, () => ({ entityId, entityType: "person", entityName: entityId, framings: [{ id: "f2", text: "reframed" }], framingRound: 2 })),
      generatePrepContentOp: async (dir, w, { entityId }) =>
        tracked(entityId, () => ({ entityId, prepContent: { status: "proposed", fields: { descriptionAppearance: "generated" } } }))
    }
  };
}

(async () => {
  let mod;
  try {
    mod = await import("../../mutation-engine/scene-develop.mjs");
  } catch (err) {
    console.error("FAIL  import mutation-engine/scene-develop.mjs");
    console.error(err.stack || err.message);
    process.exitCode = 1;
    console.log(`\n${passed} test(s) passed.`);
    rmSync(scratchDir, { recursive: true, force: true });
    return;
  }
  const { developScene } = mod;

  await test("SOURCE GREP: scene-develop.mjs never calls acceptPrepContentOp/discardPrepContentOp -- it only proposes/generates, gating stays with the caller", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../mutation-engine/scene-develop.mjs", import.meta.url), "utf8");
    assert.ok(!/acceptPrepContentOp\s*\(/.test(src), "must never auto-accept");
    assert.ok(!/discardPrepContentOp\s*\(/.test(src), "must never auto-discard");
  });

  await test("all members without a selection: every member gets propose-only, ok:true, stage:'framed'", async () => {
    const { ops, callOrder } = makeMockOps();
    const members = ["m1", "m2", "m3"];
    const result = await developScene("dir", WORLD, SCENE_ID, members, { ops, recordUndo: false });
    assert.equal(result.sceneId, SCENE_ID);
    assert.equal(result.results.length, 3);
    for (const r of result.results) {
      assert.equal(r.ok, true);
      assert.equal(r.stage, "framed");
      assert.ok(r.framings);
    }
    assert.deepEqual(callOrder, members, "propose must be called for every member, in order");
  });

  await test("a member WITH a selection runs propose then generate, reaching stage:'generated'", async () => {
    const { ops } = makeMockOps();
    const members = ["m1", "m2"];
    const result = await developScene("dir", WORLD, SCENE_ID, members, {
      ops,
      recordUndo: false,
      selections: { m2: { framingId: "f1" } }
    });
    const m1 = result.results.find((r) => r.entityId === "m1");
    const m2 = result.results.find((r) => r.entityId === "m2");
    assert.equal(m1.stage, "framed", "m1 has no selection -- propose only");
    assert.equal(m2.stage, "generated", "m2 has a selection -- propose then generate");
    assert.ok(m2.prepContent);
  });

  // -------------------------------------------------- REAL SEQUENCING

  await test("REAL SEQUENCING: members are processed strictly one-at-a-time, in memberEntityIds order -- not a dumb Promise.all fan-out", async () => {
    const members = ["seq-a", "seq-b", "seq-c", "seq-d"];
    const { ops, callOrder, concurrencyViolations } = makeMockOps({ delays: { "seq-a": 20, "seq-b": 5, "seq-c": 15, "seq-d": 1 } });
    await developScene("dir", WORLD, SCENE_ID, members, { ops, recordUndo: false });
    assert.deepEqual(callOrder, members, "call order must exactly equal input order despite varying artificial delays");
    assert.deepEqual(concurrencyViolations, [], "no member's call may begin while a PRIOR member's call is still in flight -- a real Promise.all fan-out would trip this");
  });

  // -------------------------------------------------- PARTIAL FAILURE

  await test("PARTIAL FAILURE: node 3 of 5 fails -- the other 4 nodes' results are still returned/usable, failure reported PER-NODE, batch does not abort", async () => {
    const members = ["p1", "p2", "p3", "p4", "p5"];
    const { ops, callOrder } = makeMockOps({ failFor: new Set(["p3"]) });
    const result = await developScene("dir", WORLD, SCENE_ID, members, { ops, recordUndo: false });

    assert.equal(result.results.length, 5, "every member must have a result entry, including the failed one");
    assert.deepEqual(callOrder, members, "the batch must continue past the failure to every remaining member -- not abort");

    const byId = Object.fromEntries(result.results.map((r) => [r.entityId, r]));
    assert.equal(byId.p3.ok, false);
    assert.match(byId.p3.error, /Mocked failure for p3/);
    assert.equal(byId.p3.framings, undefined, "a failed member must carry no partial framings/content data");

    for (const id of ["p1", "p2", "p4", "p5"]) {
      assert.equal(byId[id].ok, true, `${id} must be unaffected by p3's failure`);
      assert.ok(byId[id].framings, `${id}'s real result must still be usable`);
    }
  });

  await test("PARTIAL FAILURE with selections: a generate-stage failure is also reported per-node without corrupting siblings", async () => {
    const members = ["g1", "g2", "g3"];
    const { ops } = makeMockOps({ failFor: new Set(["g2"]) });
    const result = await developScene("dir", WORLD, SCENE_ID, members, {
      ops,
      recordUndo: false,
      selections: { g1: { framingId: "f1" }, g2: { framingId: "f1" }, g3: { framingId: "f1" } }
    });
    const byId = Object.fromEntries(result.results.map((r) => [r.entityId, r]));
    assert.equal(byId.g1.ok, true);
    assert.equal(byId.g1.stage, "generated");
    assert.equal(byId.g2.ok, false);
    assert.equal(byId.g3.ok, true);
    assert.equal(byId.g3.stage, "generated");
  });

  // -------------------------------------------------- reframe path

  await test("a member in opts.reframeMemberIds calls reframePrepFramingsOp instead of a fresh propose", async () => {
    const members = ["r1"];
    const { ops } = makeMockOps();
    let reframeCalled = false;
    ops.reframePrepFramingsOp = async (dir, w, args) => {
      reframeCalled = true;
      return { entityId: args.entityId, framings: [{ id: "f9", text: "reframed" }], framingRound: (args.priorRoundCount ?? 1) + 1 };
    };
    const result = await developScene("dir", WORLD, SCENE_ID, members, { ops, recordUndo: false, reframeMemberIds: ["r1"], priorRoundCounts: { r1: 1 } });
    assert.equal(reframeCalled, true);
    assert.equal(result.results[0].ok, true);
    assert.equal(result.results[0].framings[0].id, "f9");
  });

  // -------------------------------------------------- scene-undo integration (22.4)

  await test("recordUndo:true (default) records each completed GENERATE step into 22.4's scene-undo session, in order -- propose-only members record nothing (nothing to undo yet)", async () => {
    const { startSceneUndoSession, listSceneUndoActions } = await import("../../mutation-engine/scene-undo.mjs");
    const sceneId = "scene-develop-undo-integration";
    startSceneUndoSession(WORLD, sceneId);

    const members = ["u1", "u2", "u3"];
    const { ops } = makeMockOps();
    await developScene("dir", WORLD, sceneId, members, {
      ops,
      selections: { u1: { framingId: "f1" }, u3: { framingId: "f1" } } // u2 stays propose-only
    });

    const recorded = listSceneUndoActions(WORLD, sceneId);
    assert.equal(recorded.length, 2, "only the two GENERATE-stage members (u1, u3) produce something undoable -- u2 stayed propose-only");
    assert.deepEqual(recorded.map((a) => a.kind), ["edit_node", "edit_node"], "the closest-fitting existing ManualUndoKind, reused verbatim");
    assert.deepEqual(
      recorded.map((a) => a.graphMutations),
      [[{ op: "discard_prep_content", entityId: "u1" }], [{ op: "discard_prep_content", entityId: "u3" }]],
      "the pinned synthetic marker shape -- meaningful only to a future undo-APPLYING caller, never interpreted here"
    );
    assert.ok(recorded[0].description.includes("u1"));
    assert.ok(recorded[1].description.includes("u3"));
  });

  await test("recordUndo:false never touches the scene-undo store at all", async () => {
    const { startSceneUndoSession, listSceneUndoActions } = await import("../../mutation-engine/scene-undo.mjs");
    const sceneId = "scene-develop-undo-opt-out";
    startSceneUndoSession(WORLD, sceneId);
    const { ops } = makeMockOps();
    await developScene("dir", WORLD, sceneId, ["v1"], { ops, recordUndo: false, selections: { v1: { framingId: "f1" } } });
    assert.deepEqual(listSceneUndoActions(WORLD, sceneId), [], "recordUndo:false must record nothing");
  });

  console.log(`\n${passed} test(s) passed.`);
  rmSync(scratchDir, { recursive: true, force: true });
})();
