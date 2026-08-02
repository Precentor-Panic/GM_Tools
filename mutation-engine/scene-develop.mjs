/**
 * Batch "develop this scene" orchestrator — Phase 22 task 22.5.
 *
 * Implements plans/phase-21-review.md §5's "Develop this scene" batch action
 * AND §12's identified engine-layer requirement: "A server-side batch
 * development orchestrator ... running the existing
 * propose->reframe->generate->accept round-trip across every scene member
 * with real sequencing and partial-failure handling. Must not be a
 * client-side loop calling the single-node flow N times."
 *
 * SEQUENCES wf-mcp-server/lib/prep-content-ops.mjs's existing
 * proposePrepFramingsOp/reframePrepFramingsOp/generatePrepContentOp —
 * imported and called, never reimplemented. Each member's result still
 * lands on the EXISTING accept/discard gate (acceptPrepContentOp/
 * discardPrepContentOp) — this orchestrator proposes/generates, it NEVER
 * calls either of those itself, so nothing it produces is ever silently
 * treated as accepted.
 */
import {
  proposePrepFramingsOp,
  reframePrepFramingsOp,
  generatePrepContentOp
} from "../wf-mcp-server/lib/prep-content-ops.mjs";
import { recordSceneUndoAction } from "./scene-undo.mjs";

/**
 * @param {string} dir
 * @param {string} world
 * @param {string} sceneId                for scene-undo session scoping (22.4) only
 * @param {string[]} memberEntityIds       ALL scene members to develop, IN ORDER
 * @param {object} [opts]
 * @param {object} [opts.selections]       { [entityId]: <selection> } — a member with an
 *                                         entry here runs propose THEN generate; a member
 *                                         without one runs propose ONLY (framings returned
 *                                         for later review through the same single-node
 *                                         prep-content-ops.mjs routes).
 * @param {string[]} [opts.reframeMemberIds]   member ids that get ONE bounded
 *                                         reframePrepFramingsOp round instead of a fresh propose.
 * @param {object} [opts.priorRoundCounts]  { [entityId]: number } for reframe members
 * @param {object} [opts.ops]              injectable override of
 *                                         { proposePrepFramingsOp, reframePrepFramingsOp, generatePrepContentOp }
 *                                         — defaults to the real prep-content-ops.mjs imports.
 * @param {boolean} [opts.recordUndo]      default true — records each completed GENERATE
 *                                         step into 22.4's scene-undo session. A session must
 *                                         already be started by the caller (startSceneUndoSession)
 *                                         before calling developScene with this left at its default.
 * @returns {Promise<{sceneId:string, results: Array<{entityId:string, ok:boolean, stage:'framed'|'generated', framings?:object, prepContent?:object, error?:string}>}>}
 */
export async function developScene(dir, world, sceneId, memberEntityIds, opts = {}) {
  const ops = {
    proposePrepFramingsOp,
    reframePrepFramingsOp,
    generatePrepContentOp,
    ...(opts.ops ?? {})
  };
  const selections = opts.selections ?? {};
  const reframeMemberIds = new Set(opts.reframeMemberIds ?? []);
  const priorRoundCounts = opts.priorRoundCounts ?? {};
  const recordUndo = opts.recordUndo ?? true;

  // Processed ONE AT A TIME, IN ARRAY ORDER -- a plain for-await loop, never
  // Promise.all: member N's call must not begin until member N-1's own
  // promise has already resolved.
  const results = [];
  for (const entityId of memberEntityIds) {
    try {
      const framingsResult = reframeMemberIds.has(entityId)
        ? await ops.reframePrepFramingsOp(dir, world, { entityId, priorRoundCount: priorRoundCounts[entityId] })
        : await ops.proposePrepFramingsOp(dir, world, { entityId });

      if (Object.prototype.hasOwnProperty.call(selections, entityId)) {
        const generateResult = await ops.generatePrepContentOp(dir, world, { entityId, selection: selections[entityId] });

        if (recordUndo) {
          recordSceneUndoAction(world, sceneId, {
            kind: "edit_node", // closest-fitting existing ManualUndoKind value -- reused verbatim
            description: `Developed content for entity "${entityId}".`,
            graphMutations: [{ op: "discard_prep_content", entityId }]
          });
        }

        results.push({
          entityId,
          ok: true,
          stage: "generated",
          framings: framingsResult.framings,
          prepContent: generateResult.prepContent
        });
      } else {
        results.push({ entityId, ok: true, stage: "framed", framings: framingsResult.framings });
      }
    } catch (err) {
      // PARTIAL FAILURE: this member's own failure is reported per-node --
      // the loop continues to the next member, the batch does not abort, and
      // nothing partially-produced for this member is ever treated as
      // accepted (no acceptPrepContentOp/discardPrepContentOp call anywhere
      // in this module).
      results.push({ entityId, ok: false, error: err.message });
    }
  }

  return { sceneId, results };
}
