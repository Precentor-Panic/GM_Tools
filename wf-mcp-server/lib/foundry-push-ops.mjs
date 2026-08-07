/**
 * Foundry Scene PUSH — Phase 32 task 32.3 (the thin push slice, GM_Tools's
 * write-channel proof). Composes the ops-channel writer (./foundry-ops.mjs's
 * writeFoundryOps) with the EXISTING scene store
 * (session-planner/scenes.mjs) -- shared verbatim by review-ui/server.mjs's
 * POST /api/foundry/push-scene route and wf-mcp-server/index.mjs's
 * wf_push_scene_to_foundry tool, per gm-tools-conventions' "front-ends are
 * thin wrappers, never logic duplicators." Sibling module to
 * ./foundry-pull-ops.mjs (32.2) -- same location, same naming convention,
 * opposite direction.
 *
 * The map image itself (`mapSrc`) is an INPUT for now, not resolved from
 * anywhere on the GM_Tools side (plans/phase-32-tasks.md 32.3: "the map
 * image path/url is an input for now — the interface will supply it
 * later"). This function does not validate that mapSrc points at a real
 * file/URL -- Scene.background.src is Foundry's own document field,
 * resolved by the Foundry-side watcher when it actually creates the Scene.
 *
 * On an `ok:true` applied result, writes the returned `foundryUuid` into the
 * scene's own `foundrySceneRef` (scenes.mjs's updateScene, an additive
 * field). On `ok:false` (a real per-op Foundry-side failure) or a `queued`
 * outcome (no live Foundry client picked up the batch within the poll
 * window), the ref is left untouched -- this never writes a ref without a
 * real, confirmed-applied Foundry UUID behind it.
 */
import { getScene, updateScene } from "../../session-planner/scenes.mjs";
import { loadSnapshot } from "./snapshot.mjs";
import { writeFoundryOps, makeOpId } from "./foundry-ops.mjs";

/**
 * Same fallback order as review-ui/public/plans-view.js's own
 * resolveSceneDisplayName (kept in step deliberately, not re-derived) --
 * bespoke name, else the scene's location entity's real name (looked up
 * from the live snapshot; falls back to the raw locationEntityId if the
 * snapshot is missing/the entity isn't found there, rather than throwing --
 * this is a display-name best-effort, not a correctness-critical lookup),
 * else objectiveNote, else a generic label.
 */
function resolveSceneName(dir, world, scene) {
  if (scene.name) return scene.name;
  if (scene.locationEntityId) {
    try {
      const { entities } = loadSnapshot(dir, world).snapshot;
      const entity = entities.find((e) => e.id === scene.locationEntityId);
      if (entity?.name) return entity.name;
    } catch {
      // No live snapshot for this world (or a read error) -- fall through
      // to the raw id rather than letting a display-name lookup fail the push.
    }
    return scene.locationEntityId;
  }
  return scene.objectiveNote || "Ad-hoc scene";
}

/**
 * @param {string} dir
 * @param {string} world
 * @param {string} sceneId
 * @param {{mapSrc:string, name?:string, width?:number, height?:number}} args
 *   `mapSrc` is required -- this op exists to get a map into Foundry.
 *   `name` overrides the scene's own resolved display name for the pushed
 *   Foundry Scene's title, if given.
 * @param {object} [opts]   forwarded to writeFoundryOps (pollMs/timeoutMs -- test-injectable); opts.makeOpId overrides id generation for deterministic tests
 * @returns {Promise<
 *   {status:'queued', sceneId:string, opId:string, note:string} |
 *   {status:'applied', sceneId:string, opId:string, ok:true, foundryUuid:string, scene:object} |
 *   {status:'applied', sceneId:string, opId:string, ok:false, error:string}
 * >}
 */
export async function pushSceneToFoundry(dir, world, sceneId, { mapSrc, name, width, height } = {}, opts = {}) {
  if (!mapSrc) {
    throw new Error("pushSceneToFoundry requires mapSrc (the map image path/url for the new Foundry Scene's background).");
  }
  const scene = getScene(world, sceneId); // throws a clear "No scene found" if unknown, same as every other scenes.mjs caller

  const opId = opts.makeOpId ? opts.makeOpId() : makeOpId();
  const op = {
    opId,
    kind: "create_scene",
    data: {
      name: name ?? resolveSceneName(dir, world, scene),
      background: { src: mapSrc },
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {})
    }
  };

  const outcome = await writeFoundryOps(dir, world, [op], opts);

  if (outcome.status === "queued") {
    return { status: "queued", sceneId, opId, note: outcome.note };
  }

  const result = outcome.results.find((r) => r.opId === opId);
  if (!result) {
    return {
      status: "applied",
      sceneId,
      opId,
      ok: false,
      error: `No result for opId "${opId}" came back in the applied batch -- the Foundry watcher may not have recognized this op.`
    };
  }

  if (!result.ok) {
    return { status: "applied", sceneId, opId, ok: false, error: result.error ?? "Foundry reported ok:false with no error message." };
  }

  const updated = updateScene(world, sceneId, { foundrySceneRef: result.foundryUuid ?? null });
  return { status: "applied", sceneId, opId, ok: true, foundryUuid: result.foundryUuid, scene: updated };
}
