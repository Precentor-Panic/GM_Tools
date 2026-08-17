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
 * The map image (`mapSrc`) — Friction Wave 1 W3c superseded Phase 32's
 * "caller-supplied for now" rule: `mapSrc` is now an OPTIONAL override.
 * When omitted, it DEFAULTS from the scene's own linked stagecraft map
 * asset (`scene.mapAssetId`, W3b) — the asset's `src` (W3a, the durable
 * file path/URL) first, else its `foundryRef.imagePath` (a pulled Foundry
 * map's real path). An explicit `mapSrc` still wins unconditionally. When
 * NEITHER exists (no override, and no linked asset with a resolvable
 * source), this throws a clear error naming both fixes — never a silent
 * mapless push. This function still does not validate that the resolved
 * src points at a real file/URL -- Scene.background.src is Foundry's own
 * document field, resolved by the Foundry-side watcher when it actually
 * creates the Scene.
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getScene, updateScene, listScenesByRecency, markScenePushed, setScenePendingPush } from "../../session-planner/scenes.mjs";
import { getSceneTray } from "../../session-planner/scene-tray.mjs";
import { getStagecraftAsset } from "../../session-planner/stagecraft-store.mjs";
import { getBestiaryEntry } from "../../combat-planning/bestiary-store.mjs";
import { getPartyMember } from "../../combat-planning/party-roster-store.mjs";
import { loadSnapshot, foundryResultsPath } from "./snapshot.mjs";
import { writeFoundryOps, makeOpId, FoundryOpsInFlightError } from "./foundry-ops.mjs";

/**
 * Pixel dimensions of a local PNG/JPEG, or null when unreadable/unsupported.
 * Russell (2026-08-16, Kilmarn exercise): scenes pushed without width/height
 * left Foundry on its default canvas size, so a portrait-aspect czepeku map
 * rendered visibly stretched. Reading the real dimensions lets every push
 * default the Scene's canvas to the image's own aspect. Deliberately tiny
 * header parsers (repo has a no-runtime-deps rule); anything unparseable
 * just returns null and the push proceeds without dims, exactly as before.
 */
export function imageDimensions(absPath) {
  let buf;
  try { buf = readFileSync(absPath); } catch { return null; }
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    // PNG: 8-byte signature, IHDR length+type, then width/height big-endian.
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // JPEG: walk segments to the first SOFn frame header.
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + len;
    }
  }
  return null;
}

/** Best-effort width/height from a dataDir-relative background src. */
function dimsForSrc(dataDir, src) {
  if (!src || /^https?:/.test(src)) return null;
  const abs = join(dataDir, src);
  return existsSync(abs) ? imageDimensions(abs) : null;
}

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
      // to the same "(place removed)" guard below rather than letting a
      // display-name lookup fail the push.
    }
    // QA W2 fix (Group B #10): a deleted anchor place (or a lookup that
    // failed above) used to fall back to the raw wf_ id -- never a good
    // display string, and now especially visible since this name gets
    // pushed straight into a live Foundry scene document. Same guard as
    // every other copy of this resolver.
    return "(place removed)";
  }
  return scene.objectiveNote || "Ad-hoc scene";
}

/**
 * @param {string} dir
 * @param {string} world
 * @param {string} sceneId
 * @param {{mapSrc?:string, name?:string, width?:number, height?:number}} args
 *   `mapSrc` overrides the map source when given; omitted, it defaults from
 *   the scene's linked map asset (see this module's header note -- W3c). A
 *   push still always carries a map: when neither resolves, this throws.
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
  const scene = getScene(world, sceneId); // throws a clear "No scene found" if unknown, same as every other scenes.mjs caller

  // W3c -- explicit mapSrc wins; else default from the scene's linked map
  // asset (W3b's scene.mapAssetId): asset.src (W3a) first, else a pulled
  // Foundry map's own foundryRef.imagePath. Never a guessed/fabricated src.
  let resolvedMapSrc = mapSrc || null;
  if (!resolvedMapSrc && scene.mapAssetId) {
    let asset = null;
    try {
      asset = getStagecraftAsset(world, scene.mapAssetId);
    } catch {
      // A dangling link (asset deleted out from under the scene) falls
      // through to the same clear no-source error below rather than a
      // confusing store-level not-found.
    }
    resolvedMapSrc = asset?.src || asset?.foundryRef?.imagePath || null;
  }
  if (!resolvedMapSrc) {
    throw new Error(
      scene.mapAssetId
        ? `pushSceneToFoundry: no mapSrc given, and this scene's linked map asset ("${scene.mapAssetId}") has no ` +
          `resolvable source (neither src nor foundryRef.imagePath). Set the asset's file path on its Library ` +
          `Stagecraft row, or pass an explicit mapSrc.`
        : "pushSceneToFoundry: no mapSrc given and this scene has no linked map asset to default from. " +
          "Link a map asset to the scene (scene page → 'link a map…'), or pass an explicit mapSrc."
    );
  }

  // Default the Scene canvas to the image's own pixel dimensions when the
  // caller didn't specify — prevents Foundry's default canvas stretching a
  // portrait/landscape map (Russell, 2026-08-16). Explicit width/height wins.
  const dims = width === undefined && height === undefined ? dimsForSrc(dir, resolvedMapSrc) : null;
  const opId = opts.makeOpId ? opts.makeOpId() : makeOpId();
  const op = {
    opId,
    kind: "create_scene",
    data: {
      name: name ?? resolveSceneName(dir, world, scene),
      background: { src: resolvedMapSrc },
      ...(width !== undefined ? { width } : dims ? { width: dims.width } : {}),
      ...(height !== undefined ? { height } : dims ? { height: dims.height } : {})
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
 * Phase 36 task 36.4a -- the quiet flush's own default poll budget (see
 * `flushDirtyStagedScenes`'s doc comment for the full "why"). Exported
 * (same precedent as `DEFAULT_CANVAS`/`DEFAULT_GRID_SIZE` just above) so a
 * deterministic test can pin the exact values without waiting out a real
 * 7-second timeout.
 */
export const DEFAULT_FLUSH_POLL_MS = 500;
export const DEFAULT_FLUSH_TIMEOUT_MS = 7000;

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
 * (W3a, additive) the asset's own `src` field as-is (a Foundry-resolvable
 * path/URL, never copied), else a `source:'local'` asset's `localFilePath`
 * copied into `<dataDir>/worlds/<world>/scenes-from-gmtools/`, else a
 * recorded skip (never a guessed/fabricated src). The copy happens
 * synchronously and MUST succeed before the op referencing it is composed.
 * Pre-W3a assets carry no `src`, so the original two-tier order is
 * byte-identical for every existing record.
 */
function resolveAssetSrc(dataDir, world, asset, skipped) {
  if (typeof asset?.foundryRef?.imagePath === "string" && asset.foundryRef.imagePath) {
    return asset.foundryRef.imagePath;
  }
  if (typeof asset?.src === "string" && asset.src) {
    return asset.src;
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

  // Russell (2026-08-16): "stage for Foundry" must carry the scene's map.
  // The scene's own linked map (W3b scene.mapAssetId) is the primary source;
  // the tray-roster scan (phase36's original contract) is the fallback for
  // scenes that stage-dress via tray rows instead of a link.
  let mapAsset = null;
  if (scene.mapAssetId) {
    try {
      const linked = getStagecraftAsset(world, scene.mapAssetId);
      if (linked?.kind === "map" && linked.status !== "discarded") mapAsset = linked;
      else skipped.push({ kind: "asset", id: scene.mapAssetId, reason: "linked map asset is not a usable map (wrong kind or discarded)" });
    } catch {
      skipped.push({ kind: "asset", id: scene.mapAssetId, reason: "linked map asset not found" });
    }
  }
  if (!mapAsset) mapAsset = firstAcceptedAssetOfKind(world, roster, "map", skipped);
  const splashAsset = firstAcceptedAssetOfKind(world, roster, "splash", skipped);

  const data = { name: resolveSceneName(dataDir, world, scene) };
  if (mapAsset) {
    const src = resolveAssetSrc(dataDir, world, mapAsset, skipped);
    if (src) {
      data.background = { src };
      const dims = dimsForSrc(dataDir, src);
      if (dims) { data.width = dims.width; data.height = dims.height; }
    }
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
      // Orchestrator reconcile (36.3 live-smoke finding): the original
      // composition emitted separate create_token ops correlated to the
      // create_scene op by its opId -- but the MODULE's create_token creator
      // resolves sceneUuid via fromUuid() and rejected the correlation token
      // ('create_token: unresolvable sceneUuid "op_..."'). The contract's
      // create_scene.data ALREADY grew an inline `tokens[]` for exactly this
      // create-path case (36.1 implemented it: batch-placed via
      // createEmbeddedDocuments after Scene.create) -- so create-path tokens
      // ride INSIDE the scene op, and standalone create_token stays reserved
      // for a future update-path that has a real sceneUuid to give it.
      data.tokens = actors.map((actor, i) => ({
        actorUuid: actor.actorUuid,
        x: positions[i].x,
        y: positions[i].y
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
 * Orchestrator reconcile (36.3 live-smoke finding) -- consumes LATE results
 * for scenes a previous flush cycle left in the pending-push ledger
 * (scenes.mjs `pendingPush`, recorded when ops were written but the poll
 * window closed before Foundry's watcher applied them). For each pending
 * scene whose opId appears in world-fabric-foundry-results.json:
 *   ok:true  -> markScenePushed (foundryUuid + the COMPOSE-TIME
 *               snapshotUpdatedAt from the ledger -- same race rule as a
 *               same-cycle write-back) and clear the ledger entry.
 *   ok:false -> clear the ledger entry only (no Foundry doc was created;
 *               the scene is dirty again and safely re-composable).
 * Consumed entries are REMOVED from the results file (rewritten in place;
 * "[]" when empty) -- GM_Tools is the results consumer per the bridge
 * contract §3, but ONLY for opIds it recognizes: entries belonging to some
 * other in-flight poll (e.g. a manual push-scene call) are left untouched.
 * A pending scene whose opId has NOT appeared yet stays pending (and stays
 * excluded from recomposition) -- a lost-forever op (client died mid-apply)
 * self-heals when Foundry's watcher eventually clears the ops channel and
 * a results entry lands, or can be manually unstuck by re-staging.
 *
 * @param {string} dataDir
 * @param {string} world
 * @returns {number}   how many pending scenes were reconciled this call
 */
export function reconcilePendingResults(dataDir, world) {
  const pendingScenes = listScenesByRecency(world).filter((s) => s.pendingPush?.opId);
  if (pendingScenes.length === 0) return 0;

  const resultsPath = foundryResultsPath(dataDir, world);
  if (!existsSync(resultsPath)) return 0;
  let allResults;
  try {
    const raw = readFileSync(resultsPath, "utf8").trim();
    const parsed = raw ? JSON.parse(raw) : [];
    allResults = Array.isArray(parsed) ? parsed : [];
  } catch {
    return 0; // unreadable mid-write -- try again next cycle
  }
  if (allResults.length === 0) return 0;

  const consumedOpIds = new Set();
  let reconciled = 0;
  for (const scene of pendingScenes) {
    const { opId, snapshotUpdatedAt } = scene.pendingPush;
    const result = allResults.find((r) => r.opId === opId);
    if (!result) continue;
    if (result.ok) {
      markScenePushed(world, scene.id, {
        foundrySceneRef: result.foundryUuid ?? scene.foundrySceneRef ?? null,
        lastPushedAt: snapshotUpdatedAt
      });
    }
    setScenePendingPush(world, scene.id, null);
    consumedOpIds.add(opId);
    reconciled++;
  }

  if (consumedOpIds.size > 0) {
    const remaining = allResults.filter((r) => !consumedOpIds.has(r.opId));
    writeFileSync(resultsPath, remaining.length ? JSON.stringify(remaining, null, 2) : "[]", "utf8");
  }
  return reconciled;
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
 * Default poll budget (Phase 36 task 36.4a, Russell's pass finding #1 --
 * "the update seemed slow"): `DEFAULT_FLUSH_POLL_MS`/`DEFAULT_FLUSH_TIMEOUT_MS`
 * below, 500ms/7000ms -- MATCHES `writeFoundryOps`'s own default now (it was
 * previously a deliberately SHORTER 250ms/1500ms, "a QUIET, often-background
 * flush"). Root cause: Foundry's watcher only ticks every ~5s, so the
 * original budget was consistently shorter than one full tick -- nearly
 * every quiet push missed its own poll window and fell through to the
 * pending-ledger + server-side follow-up chain (worst case ~8-20s before the
 * UI could reflect it), even when Foundry was open and would have confirmed
 * within a few seconds. The new budget spans one full watcher tick plus
 * FilePicker upload time, so most cycles now confirm results IN this same
 * call and never touch the ledger at all -- the ledger/reconcile/follow-up
 * chain above is UNCHANGED and stays the safety net for the genuinely-slow
 * or Foundry-closed case. This is still a background/server-side await --
 * nothing user-facing blocks on it; `sync-now` (a manual, user-clicked
 * action) inherits the same budget, which is an acceptable wait for a
 * button. Overridable via opts, same as every other pollMs/timeoutMs-
 * accepting function in this project -- deterministic tests keep their own
 * tiny budgets.
 *
 * @param {string} dataDir
 * @param {string} world
 * @param {object} [opts]   forwarded to composeSceneOps (opts.makeOpId) and writeFoundryOps (opts.pollMs/opts.timeoutMs)
 * @returns {Promise<{flushed:number, results:object[], skipped:object[], queued?:true, note?:string}>}
 */
export async function flushDirtyStagedScenes(dataDir, world, opts = {}) {
  // Orchestrator reconcile (36.3 live-smoke finding): FIRST consume any
  // late-arriving results for scenes a previous cycle left pending (see
  // reconcilePendingResults' doc comment), and EXCLUDE still-pending scenes
  // from recomposition -- without this, the quiet flush's short poll window
  // (routinely shorter than Foundry's 5s watcher tick) left applied results
  // unconsumed and the "stays dirty, retried next trigger" rule re-created
  // the same scene in Foundry on every retry.
  const reconciled = reconcilePendingResults(dataDir, world);
  const dirtyScenes = listScenesByRecency(world).filter((s) => isSceneDirty(s) && !s.pendingPush);
  if (dirtyScenes.length === 0) {
    // Sparse pendingCount here too -- a too-early follow-up (results not
    // landed yet) takes THIS return, and the server's bounded chain needs
    // the signal to schedule its second, longer follow-up.
    const stillPending = listScenesByRecency(world).filter((s) => s.pendingPush?.opId).length;
    return { flushed: 0, results: [], skipped: [], reconciled, ...(stillPending > 0 ? { pendingCount: stillPending } : {}) };
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

  const writeOpts = { pollMs: DEFAULT_FLUSH_POLL_MS, timeoutMs: DEFAULT_FLUSH_TIMEOUT_MS, ...opts };
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
    } else if (outcome.status === "queued") {
      // Ops WERE written but no result landed inside the poll window (the
      // common case for the quiet auto-flush -- its budget is shorter than
      // Foundry's watcher tick). Record the pending ledger entry so the
      // NEXT cycle reconciles the late result instead of composing a
      // duplicate create (36.3 live-smoke fix). A genuine ok:false result
      // (Foundry-side failure) records nothing -- stays dirty, retried.
      setScenePendingPush(world, scene.id, { opId: sceneOpId, snapshotUpdatedAt });
    }
  }

  // Sparse key (mirrors `queued`): how many of this world's scenes hold an
  // unreconciled pendingPush ledger entry AFTER this cycle -- the server's
  // bounded follow-up chain keys on it (a late watcher apply lands ~5-9s
  // after the ops write; one 8s follow-up sometimes fires just early, so a
  // second, longer follow-up closes the loop without waiting for the next
  // user mutation or Sync now).
  const pendingCount = listScenesByRecency(world).filter((s) => s.pendingPush?.opId).length;
  return {
    flushed: perScene.length,
    results,
    skipped,
    reconciled,
    ...(pendingCount > 0 ? { pendingCount } : {}),
    ...(outcome.status === "queued" ? { queued: true, note: outcome.note } : {})
  };
}
