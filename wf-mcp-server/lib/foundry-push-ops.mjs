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
 *
 * EXTENDED Phase 36 task 36.2 (the quiet-push flush engine, review-ui/test/
 * e2e/phase36-fixture.mjs §5 -- THE WRITTEN CONTRACT) -- this is the
 * "extend the pushSceneToFoundry family, don't fork a parallel path" home
 * for that engine: `composeSceneOps` (one dirty scene -> its op group) and
 * `flushDirtyStagedScenes` (every dirty staged scene in a world -> ONE
 * `writeFoundryOps` batch write, per §5's "one flush cycle, one write" rule)
 * live in this SAME file, reusing `resolveSceneName`/`makeOpId`/
 * `writeFoundryOps` unchanged rather than re-deriving any of them.
 * `pushSceneToFoundry` itself is UNCHANGED -- it still backs the existing,
 * separate `POST /api/foundry/push-scene` manual route; the flush engine
 * below is a second, independent producer onto the SAME ops-channel writer.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { getScene, updateScene, listScenesByRecency, markScenePushed } from "../../session-planner/scenes.mjs";
import { getSceneTray } from "../../session-planner/scene-tray.mjs";
import { getStagecraftAsset } from "../../session-planner/stagecraft-store.mjs";
import { getBestiaryEntry } from "../../combat-planning/bestiary-store.mjs";
import { getPartyMember } from "../../combat-planning/party-roster-store.mjs";
import { loadSnapshot } from "./snapshot.mjs";
import { writeFoundryOps, makeOpId, FoundryOpsInFlightError } from "./foundry-ops.mjs";

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

// ===========================================================================
// Phase 36 task 36.2 -- the quiet-push flush engine.
// phase36-fixture.mjs §5/§6, plans/phase-32-bridge-contract.md v2 §2.
// ===========================================================================

/**
 * §5's "grid-step cluster at scene center" fallback canvas -- MUST match
 * phase36-fixture.mjs's own exported `DEFAULT_CANVAS`/`DEFAULT_GRID_SIZE`
 * values exactly (that file's e2e assertions and this composer's real
 * output are compared directly). Not IMPORTED from the test fixture --
 * production code importing a `review-ui/test/e2e/*` file would invert this
 * project's module-boundary convention -- so this is a deliberate, exact
 * duplication of the same two constants + `clusterTokenPositions` formula,
 * not a drift risk in practice (both are tiny and change together only if
 * §5 itself changes, at which point BOTH copies need the same edit -- flagged
 * here explicitly for that reason).
 */
export const DEFAULT_CANVAS = { width: 4000, height: 3000 };
export const DEFAULT_GRID_SIZE = 100;

/**
 * @param {number} count
 * @param {{center?:{x:number,y:number}, gridSize?:number}} [opts]
 * @returns {{x:number,y:number}[]}
 */
export function clusterTokenPositions(count, opts = {}) {
  const center = opts.center ?? { x: DEFAULT_CANVAS.width / 2, y: DEFAULT_CANVAS.height / 2 };
  const gridSize = opts.gridSize ?? DEFAULT_GRID_SIZE;
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const positions = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const offsetX = (col - (cols - 1) / 2) * gridSize;
    const offsetY = (row - (rows - 1) / 2) * gridSize;
    positions.push({ x: Math.round(center.x + offsetX), y: Math.round(center.y + offsetY) });
  }
  return positions;
}

/** dirty(scene) -- §5's dirty predicate, exported for reuse/testing. */
export function isSceneDirty(scene) {
  return scene.stagedForFoundry === true && (scene.lastPushedAt === null || scene.updatedAt > scene.lastPushedAt);
}

/**
 * First ACCEPTED roster `kind:'asset'` row whose underlying StagecraftAsset
 * has `.kind === assetKind` ("map" | "splash"), in roster order. Extras (a
 * second accepted asset of the SAME kind) are recorded into `skipped` with
 * the exact "only one map per scene push, first-pass" reason for `kind:
 * "map"` (pinned verbatim by §5); the analogous phrase for "splash". A
 * roster row whose asset can't be found, isn't accepted, or is a different
 * kind, is silently passed over (not itself a push-worthy skip -- only a
 * genuine "we found one but couldn't use it" case is recorded).
 */
function firstAcceptedAssetOfKind(world, roster, assetKind, skipped) {
  let found = null;
  for (const row of roster) {
    if (row.kind !== "asset") continue;
    let asset;
    try {
      asset = getStagecraftAsset(world, row.id);
    } catch {
      continue; // unknown asset id -- nothing to report against this kind specifically
    }
    if (asset.kind !== assetKind) continue;
    if (asset.status !== "accepted") {
      skipped.push({ reason: `stagecraft asset "${asset.id}" (${asset.name}) is not accepted -- only accepted assets are eligible for push, skipped` });
      continue;
    }
    if (found) {
      skipped.push({ reason: `only one ${assetKind} per scene push, first-pass -- extra ${assetKind} asset "${asset.id}" (${asset.name}) skipped` });
      continue;
    }
    found = asset;
  }
  return found;
}

/**
 * §5's map/splash src resolution order: `foundryRef.imagePath` as-is, else
 * a `source:'local'` asset's `localFilePath` copied into
 * `<dataDir>/worlds/<world>/scenes-from-gmtools/`, else a recorded skip
 * (never a guessed/fabricated src). The copy happens synchronously and MUST
 * succeed before the op referencing it is composed.
 */
function resolveAssetSrc(dataDir, world, asset, skipped) {
  if (typeof asset?.foundryRef?.imagePath === "string" && asset.foundryRef.imagePath) {
    return asset.foundryRef.imagePath;
  }
  if (asset?.source === "local" && typeof asset?.localFilePath === "string" && asset.localFilePath) {
    const destDir = join(dataDir, "worlds", world, "scenes-from-gmtools");
    mkdirSync(destDir, { recursive: true });
    const filename = basename(asset.localFilePath);
    copyFileSync(asset.localFilePath, join(destDir, filename));
    return `worlds/${world}/scenes-from-gmtools/${filename}`;
  }
  skipped.push({ reason: `no image source available for asset ${asset?.id}` });
  return null;
}

/**
 * §5's token-composition eligibility scan: roster `creature`/`hero` rows
 * whose linked record is `status:'accepted'` AND carries a non-null
 * `foundryActorRef`. Ineligible rows are recorded into `skipped`, never
 * silently dropped. Creatures are expanded before heroes (§5's own pinned
 * ordering), each row's own `n` stack count expanding to `n` individual
 * `{actorUuid}` placements (positions assigned by the caller, after the
 * full eligible list is known -- clusterTokenPositions needs the total
 * count up front).
 * @returns {{actorUuid:string}[]}
 */
function eligibleTokenActors(world, roster, skipped) {
  const actors = [];
  const collect = (rows, lookup, label) => {
    for (const row of rows) {
      let record;
      try {
        record = lookup(row.id);
      } catch {
        skipped.push({ reason: `${label} "${row.id}" not found -- skipped (n=${row.n})` });
        continue;
      }
      if (record.status !== "accepted" || !record.foundryActorRef) {
        const name = record.rawFields?.name ?? record.name ?? "unnamed";
        skipped.push({
          reason: `${label} "${row.id}" (${name}) is not eligible for token push (must be accepted with a linked Foundry actor) -- skipped (n=${row.n})`
        });
        continue;
      }
      for (let i = 0; i < row.n; i++) actors.push({ actorUuid: record.foundryActorRef });
    }
  };
  collect(roster.filter((r) => r.kind === "creature"), (id) => getBestiaryEntry(id), "bestiary creature");
  collect(roster.filter((r) => r.kind === "hero"), (id) => getPartyMember(world, id), "party hero");
  return actors;
}

/**
 * Composes ONE dirty scene's op group: the scene op itself (`create_scene`
 * when `scene.foundrySceneRef == null`, else `update_scene` targeting it),
 * plus -- CREATE PATH ONLY, per §5's pinned "update-path never re-emits
 * token/journal-image ops" limitation -- its roster's `create_token` ops
 * (clustered at scene center, creatures-then-heroes order) and a
 * `create_journal_image` op for an accepted splash asset, if any.
 *
 * @param {string} dataDir
 * @param {string} world
 * @param {object} scene
 * @param {object} [opts]   opts.makeOpId overrides id generation, for deterministic tests
 * @returns {{sceneOp:object, tokenOps:object[], journalOp:object|null, skipped:object[], snapshotUpdatedAt:string}}
 */
export function composeSceneOps(dataDir, world, scene, opts = {}) {
  const nextOpId = () => (opts.makeOpId ? opts.makeOpId() : makeOpId());
  const skipped = [];
  const tray = getSceneTray(world, scene.id);
  const roster = Array.isArray(tray.roster) ? tray.roster : [];
  const isCreatePath = scene.foundrySceneRef == null;

  const mapAsset = firstAcceptedAssetOfKind(world, roster, "map", skipped);
  const splashAsset = firstAcceptedAssetOfKind(world, roster, "splash", skipped);

  const data = { name: resolveSceneName(dataDir, world, scene) };
  if (mapAsset) {
    const src = resolveAssetSrc(dataDir, world, mapAsset, skipped);
    if (src) data.background = { src };
  }
  if (splashAsset) {
    const src = resolveAssetSrc(dataDir, world, splashAsset, skipped);
    if (src) data.foreground = { src };
  }

  const sceneOpId = nextOpId();
  const sceneOp = isCreatePath
    ? { opId: sceneOpId, kind: "create_scene", data }
    : { opId: sceneOpId, kind: "update_scene", data: { sceneUuid: scene.foundrySceneRef, patch: data } };

  let tokenOps = [];
  let journalOp = null;
  if (isCreatePath) {
    const actors = eligibleTokenActors(world, roster, skipped);
    if (actors.length > 0) {
      const positions = clusterTokenPositions(actors.length, {
        center: { x: (data.width ?? DEFAULT_CANVAS.width) / 2, y: (data.height ?? DEFAULT_CANVAS.height) / 2 },
        gridSize: data.grid?.size ?? DEFAULT_GRID_SIZE
      });
      tokenOps = actors.map((actor, i) => ({
        opId: nextOpId(),
        kind: "create_token",
        data: {
          // The scene doesn't have a real Foundry sceneUuid yet on its
          // FIRST-EVER push (that's exactly the CREATE-path condition
          // gating this whole block) -- §5 itself flags this: token ops
          // "tie to the SAME batch as their scene op via ordering/grouping,
          // not a resolved sceneUuid." The contract text describes the
          // limitation but does not pin a literal placeholder value; this
          // composer's own resolution (FLAGGED as an explicit assumption,
          // not silently guessed) is the paired create_scene op's own
          // `opId` -- a same-batch correlation token a Foundry-side watcher
          // can resolve via adjacency ("the scene I just created earlier in
          // THIS apply pass"), not a `fromUuid()`-resolvable uuid.
          sceneUuid: sceneOpId,
          actorUuid: actor.actorUuid,
          x: positions[i].x,
          y: positions[i].y
        }
      }));
    }
    if (splashAsset && data.foreground) {
      journalOp = {
        opId: nextOpId(),
        kind: "create_journal_image",
        data: { imageSrc: data.foreground.src, journalName: splashAsset.name, pageName: splashAsset.name }
      };
    }
  }

  return { sceneOp, tokenOps, journalOp, skipped, snapshotUpdatedAt: scene.updatedAt };
}

/**
 * The quiet-push flush engine's top-level entry point -- §5's two triggers
 * (the debounced staged-scene-mutation trigger and `POST /api/foundry/
 * sync-now`) both call this SAME function. Scans every currently-dirty
 * staged scene for `world` (fresh at call time, per §5's "re-reads which
 * scenes are dirty right now" trigger-coalescing rule), composes ONE ops
 * batch covering all of them (`listScenesByRecency` order, each scene's own
 * op group contiguous), and writes it with ONE `writeFoundryOps` call.
 *
 * 409-in-flight (`FoundryOpsInFlightError`, a prior batch from ANY source
 * hasn't cleared yet) -> the WHOLE cycle is a no-op: nothing composed this
 * cycle is written, nothing is marked pushed, the error is swallowed into a
 * `{flushed:0, results:[], skipped:[], queued:true, note}` result (never
 * thrown up to a route caller) -- retried from a fresh dirty-scan on the
 * next trigger. A plain poll-timeout (ops WERE written, but no live Foundry
 * client picked them up within the poll window) is a lesser case: `flushed`
 * still counts every scene whose op group was actually written into this
 * batch (an attempted-this-cycle count, distinct from confirmed-applied) --
 * `results` is simply empty in that case, and no scene is marked pushed
 * (stays dirty, retried next trigger), matching §5's "ok:false/no-result
 * leaves the scene untouched" rule.
 *
 * Default poll budget is intentionally SHORTER than `writeFoundryOps`'s own
 * 500ms/7000ms default (pushSceneToFoundry's manual, user-clicked-a-button
 * defaults) -- this is a QUIET, often-background flush (debounced
 * auto-trigger, or a synchronously-awaited sync-now call); overridable via
 * opts, same as every other pollMs/timeoutMs-accepting function in this
 * project.
 *
 * @param {string} dataDir
 * @param {string} world
 * @param {object} [opts]   forwarded to composeSceneOps (opts.makeOpId) and writeFoundryOps (opts.pollMs/opts.timeoutMs)
 * @returns {Promise<{flushed:number, results:object[], skipped:object[], queued?:true, note?:string}>}
 */
export async function flushDirtyStagedScenes(dataDir, world, opts = {}) {
  const dirtyScenes = listScenesByRecency(world).filter(isSceneDirty);
  if (dirtyScenes.length === 0) {
    return { flushed: 0, results: [], skipped: [] };
  }

  const ops = [];
  const perScene = [];
  const skipped = [];
  for (const scene of dirtyScenes) {
    const { sceneOp, tokenOps, journalOp, skipped: sceneSkipped, snapshotUpdatedAt } = composeSceneOps(dataDir, world, scene, opts);
    ops.push(sceneOp, ...tokenOps, ...(journalOp ? [journalOp] : []));
    for (const s of sceneSkipped) skipped.push({ sceneId: scene.id, ...s });
    perScene.push({ scene, sceneOpId: sceneOp.opId, snapshotUpdatedAt });
  }

  const writeOpts = { pollMs: 250, timeoutMs: 1500, ...opts };
  let outcome;
  try {
    outcome = await writeFoundryOps(dataDir, world, ops, writeOpts);
  } catch (err) {
    if (err instanceof FoundryOpsInFlightError) {
      return { flushed: 0, results: [], skipped, queued: true, note: err.message };
    }
    throw err;
  }

  const results = outcome.status === "applied" ? outcome.results : [];
  for (const { scene, sceneOpId, snapshotUpdatedAt } of perScene) {
    const result = results.find((r) => r.opId === sceneOpId);
    if (result?.ok) {
      markScenePushed(world, scene.id, {
        foundrySceneRef: result.foundryUuid ?? scene.foundrySceneRef ?? null,
        lastPushedAt: snapshotUpdatedAt
      });
    }
    // ok:false, or no result at all (queued/timeout) -- scene stays dirty, retried next trigger (§5).
  }

  return {
    flushed: perScene.length,
    results,
    skipped,
    ...(outcome.status === "queued" ? { queued: true, note: outcome.note } : {})
  };
}
