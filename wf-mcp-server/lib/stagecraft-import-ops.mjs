/**
 * Import-on-accept — Phase 38 task 38.2, §4 of review-ui/test/e2e/
 * phase38-fixture.mjs (THE WRITTEN CONTRACT). Composes the ops-channel
 * writer (./foundry-ops.mjs's writeFoundryOps) with the Stagecraft store
 * (session-planner/stagecraft-store.mjs) -- shared by review-ui/server.mjs's
 * extended `POST /api/session-planner/stagecraft/:id/accept` route, per
 * gm-tools-conventions' "front-ends are thin wrappers, never logic
 * duplicators." Sibling module to ./foundry-push-ops.mjs (32.3/36.2) -- same
 * location/naming convention, SAME shape ("reuse the 36.3 pending/reconcile
 * machinery" per the task plan's own instruction), a DIFFERENT store
 * (stagecraft-store.mjs, not session-planner/scenes.mjs) and a SINGLE-op
 * immediate composition (mirrors `pushSceneToFoundry`'s one-op-per-call
 * shape, not `flushDirtyStagedScenes`'s multi-scene batch shape -- an
 * accept is always exactly one asset, one op).
 *
 * `importCompendiumSceneOnAccept` is called ONLY for a StagecraftAsset that
 * already carries a non-null `compendiumRef` and no `foundryRef?.sceneUuid`
 * yet -- the caller (review-ui/server.mjs's accept route) is responsible for
 * that gate; this function assumes it and throws if handed an asset with no
 * `compendiumRef` (a caller bug, not a runtime condition to handle
 * gracefully).
 *
 * Outcome handling (§4, three cases):
 *   applied, ok:true  -> markStagecraftAssetImported (foundryRef.sceneUuid +
 *                        status:'accepted' + pendingImport cleared).
 *   applied, ok:false -> asset UNCHANGED (setStagecraftAssetPendingImport(null)
 *                        only, in case a PRIOR cycle had left one set --
 *                        stays 'proposed', compendiumRef intact, retryable).
 *   queued (no live Foundry client picked the batch up within the poll
 *   window) -> setStagecraftAssetPendingImport({opId, requestedAt}); asset
 *                        stays 'proposed'.
 */
import {
  getStagecraftAsset,
  listStagecraftAssets,
  setStagecraftAssetPendingImport,
  markStagecraftAssetImported
} from "../../session-planner/stagecraft-store.mjs";
import { writeFoundryOps, makeOpId } from "./foundry-ops.mjs";
import { foundryResultsPath } from "./snapshot.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * @param {string} dataDir
 * @param {string} world
 * @param {string} assetId
 * @param {object} [opts]   forwarded to writeFoundryOps (pollMs/timeoutMs -- test-injectable); opts.makeOpId overrides id generation; opts.now overrides the pendingImport.requestedAt timestamp
 * @returns {Promise<
 *   {status:'queued', assetId:string, opId:string, note:string, asset:object} |
 *   {status:'applied', assetId:string, opId:string, ok:true, foundryUuid:string, asset:object} |
 *   {status:'applied', assetId:string, opId:string, ok:false, error:string, asset:object}
 * >}
 */
export async function importCompendiumSceneOnAccept(dataDir, world, assetId, opts = {}) {
  const asset = getStagecraftAsset(world, assetId); // throws "No stagecraft asset found" if unknown, same as every other stagecraft-store caller
  if (!asset.compendiumRef) {
    throw new Error(
      `importCompendiumSceneOnAccept: stagecraft asset "${assetId}" has no compendiumRef -- not an import-eligible ` +
      `browse row (the caller must gate on compendiumRef before calling this).`
    );
  }

  const opId = opts.makeOpId ? opts.makeOpId() : makeOpId();
  const op = {
    opId,
    kind: "import_compendium_scene",
    data: { packId: asset.compendiumRef.packId, entryId: asset.compendiumRef.entryId }
  };

  const outcome = await writeFoundryOps(dataDir, world, [op], opts);

  if (outcome.status === "queued") {
    const requestedAt = opts.now ?? new Date().toISOString();
    const pending = setStagecraftAssetPendingImport(world, assetId, { opId, requestedAt });
    return { status: "queued", assetId, opId, note: outcome.note, asset: pending };
  }

  const result = outcome.results.find((r) => r.opId === opId);
  if (!result || !result.ok) {
    // A late/stale pendingImport (from some prior cycle) must never
    // permanently block a retry -- clear it here regardless, per §4's "a
    // later accept attempt on a still-proposed, still-pending row must
    // re-check reconciliation, not throw/no-op forever" instruction.
    const unchanged = setStagecraftAssetPendingImport(world, assetId, null);
    return {
      status: "applied",
      assetId,
      opId,
      ok: false,
      error: result?.error ?? `No result for opId "${opId}" came back in the applied batch -- the Foundry watcher may not have recognized this op.`,
      asset: unchanged
    };
  }

  const updated = markStagecraftAssetImported(world, assetId, result.foundryUuid);
  return { status: "applied", assetId, opId, ok: true, foundryUuid: result.foundryUuid, asset: updated };
}

/**
 * Phase 38 task 38.2, §4 -- consumes LATE results for stagecraft assets a
 * previous `importCompendiumSceneOnAccept` call left in the pendingImport
 * ledger (the poll window closed before Foundry's watcher applied the
 * batch). Mirrors `wf-mcp-server/lib/foundry-push-ops.mjs`'s
 * `reconcilePendingResults` shape exactly, one store over:
 *   ok:true  -> markStagecraftAssetImported(foundryUuid), ledger cleared.
 *   ok:false -> pendingImport cleared only (no Foundry doc was created; the
 *               row stays 'proposed'/retryable).
 * A pending asset whose opId has NOT appeared yet stays pending. Consumed
 * entries are REMOVED from the results file (rewritten in place; "[]" when
 * empty) -- GM_Tools is the results consumer per the bridge contract §3, but
 * ONLY for opIds it recognizes here; entries belonging to some other
 * in-flight poll (e.g. a scene push) are left untouched.
 *
 * @param {string} dataDir
 * @param {string} world
 * @returns {number}   how many pending assets were reconciled this call
 */
export function reconcilePendingCompendiumImports(dataDir, world) {
  const pendingAssets = listStagecraftAssets(world).filter((a) => a.pendingImport?.opId);
  if (pendingAssets.length === 0) return 0;

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
  for (const asset of pendingAssets) {
    const { opId } = asset.pendingImport;
    const result = allResults.find((r) => r.opId === opId);
    if (!result) continue;
    if (result.ok) {
      markStagecraftAssetImported(world, asset.id, result.foundryUuid);
    } else {
      setStagecraftAssetPendingImport(world, asset.id, null);
    }
    consumedOpIds.add(opId);
    reconciled++;
  }

  if (consumedOpIds.size > 0) {
    const remaining = allResults.filter((r) => !consumedOpIds.has(r.opId));
    writeFileSync(resultsPath, remaining.length ? JSON.stringify(remaining, null, 2) : "[]", "utf8");
  }
  return reconciled;
}
