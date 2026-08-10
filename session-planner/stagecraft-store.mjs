/**
 * Stagecraft asset store — Phase 35 task 35.1, §2 of review-ui/test/e2e/
 * phase35-fixture.mjs (THE WRITTEN CONTRACT). Per-world, ONE JSON file per
 * world (`<stagecraftRoot>/<world>.json`), a flat array of StagecraftAsset —
 * same layout convention as party-roster-store.mjs/token-store.mjs. Default
 * root GM_Tools/stagecraft/; override GM_TOOLS_STAGECRAFT_DIR (tests use
 * this for isolation — the exact env var name is pinned by
 * review-ui/test/e2e/phase35-fixture.mjs's own setupPhase35Env). Reuses
 * review-state.mjs's withLock/ConcurrentWriteError, per every other store's
 * established precedent.
 *
 * `status` is THIS file's own addition to the task plan's originally-pinned
 * shape (phase35-fixture.mjs §2 flags this explicitly) — required by the
 * phase's locked "all pulled content lands as proposals" decision, since a
 * pulled `scenes[]` map ref (§6, wf-mcp-server/lib/foundry-pull-ops.mjs) IS
 * exactly such content. saveStagecraftAsset defaults to 'accepted' — the
 * SAME "party-roster's own default-accepted-unless-Foundry-pull" convention
 * as party-roster-store.mjs (a hand-added splash/music row IS the
 * deliberate authorship act; only the Foundry pull's `map` refs ever pass
 * status:'proposed' explicitly).
 *
 * Music rows are HAND-ADDED ONLY this phase (locked decision — playlists
 * enter the foundry-index in a later wave) — nothing in this store enforces
 * that (it's a caller-side convention, same as every other status-gate
 * convention in this project); it's simply never exercised by the pull path
 * this phase.
 *
 * ADDITIVE CHANGE (Phase 36 task 36.2, §4): `localFilePath: string|null`
 * (default `null`) joins the StagecraftAsset shape — a hand-added
 * `source:'local'` asset's real filesystem path, OUTSIDE Foundry's data dir.
 * NOT populated by the pull path (a Foundry-sourced map already carries
 * `foundryRef.imagePath`, which needs no copy) and NOT yet writable through
 * any route this phase (no UI/route writes it yet, per phase36-fixture.mjs's
 * own header note) — it exists purely so the flush composer's src-resolution
 * order (wf-mcp-server/lib/foundry-push-ops.mjs) has a field to read once
 * something eventually populates it.
 *
 * ADDITIVE CHANGE (Phase 38 task 38.2, §3/§4 of review-ui/test/e2e/
 * phase38-fixture.mjs — THE WRITTEN CONTRACT): THREE more additive-optional
 * fields, all default `null`, all pre-existing records simply reading as
 * having none of them:
 *   - `compendiumRef: {packId, entryId} | null` — present ONLY on a
 *     not-yet-imported compendium Scene browse row (wf-mcp-server/lib/
 *     foundry-pull-ops.mjs's `upsertCompendiumBrowseRow`). A hand-added or
 *     Foundry-`scenes[]`-pulled map asset always has `compendiumRef: null`.
 *   - `thumb: string | null` — the compendium pack entry's own thumbnail
 *     path, carried through so the Library's browse-row rendering has
 *     something to show pre-import. NOT part of the bridge contract's own
 *     pinned StagecraftAsset candidate shape (§3 of phase38-fixture.mjs) —
 *     a deliberate, additive-only extension for the Library rendering
 *     deliverable, flagged here as such.
 *   - `pendingImport: {opId, requestedAt} | null` — the import-on-accept
 *     flow's OWN pending ledger (wf-mcp-server/lib/stagecraft-import-ops.mjs),
 *     mirroring `session-planner/scenes.mjs`'s `pendingPush` shape one store
 *     over: set when an `import_compendium_scene` op was written but the
 *     accept route's poll window closed before a result landed; cleared once
 *     `reconcilePendingCompendiumImports` (or a same-call poll) consumes a
 *     matching result.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";
import { addTag, removeTag } from "../combat-planning/tags.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "stagecraft");

export function stagecraftRoot() {
  return process.env.GM_TOOLS_STAGECRAFT_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return join(stagecraftRoot(), `${world}.json`);
}

function readAssets(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeAssets(world, assets) {
  const filePath = worldFilePath(world);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(assets, null, 2), "utf8");
  });
  return assets;
}

/** Generate a stagecraft-asset id. Injectable (opts.makeId) for deterministic tests. */
export function makeStagecraftAssetId() {
  return `sc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {string} world
 * @param {{kind:'map'|'splash'|'music', name:string, source?:'foundry'|'local', meta?:string|null, desc?:string|null, tags?:string[], foundryRef?:object|null, status?:'proposed'|'accepted'|'discarded'}} fields
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object}   the created StagecraftAsset
 */
export function saveStagecraftAsset(
  world,
  {
    kind,
    name,
    source = "local",
    meta = null,
    desc = null,
    tags = [],
    foundryRef = null,
    status = "accepted",
    localFilePath = null,
    compendiumRef = null,
    thumb = null,
    pendingImport = null
  },
  opts = {}
) {
  const makeId = opts.makeId ?? makeStagecraftAssetId;
  const now = opts.now ?? new Date().toISOString();
  const asset = {
    id: makeId(),
    world,
    kind,
    name,
    source,
    meta,
    desc,
    tags: Array.isArray(tags) ? tags : [],
    foundryRef,
    status,
    localFilePath,
    // Phase 38 task 38.2, §3/§4 -- see this file's own header comment.
    compendiumRef,
    thumb,
    pendingImport,
    createdAt: now
  };
  const assets = readAssets(world);
  writeAssets(world, [...assets, asset]);
  return asset;
}

/** @returns {object}   the StagecraftAsset. Throws a clear Error if not found. */
export function getStagecraftAsset(world, assetId) {
  const asset = readAssets(world).find((a) => a.id === assetId);
  if (!asset) {
    throw new Error(`No stagecraft asset found: world="${world}" assetId="${assetId}"`);
  }
  return asset;
}

/**
 * @param {string} world
 * @param {'map'|'splash'|'music'} [kind]   optional filter
 * @returns {object[]}   every StagecraftAsset for `world` (optionally filtered by `kind`), in creation order. [] if none.
 */
export function listStagecraftAssets(world, kind) {
  const assets = readAssets(world);
  return kind ? assets.filter((a) => a.kind === kind) : assets;
}

function findAssetIndex(world, assetId, assets) {
  const idx = assets.findIndex((a) => a.id === assetId);
  if (idx === -1) {
    throw new Error(`No stagecraft asset found: world="${world}" assetId="${assetId}"`);
  }
  return idx;
}

/** status: 'proposed' -> 'accepted'. @returns {object} the updated StagecraftAsset. */
export function acceptStagecraftAsset(world, assetId) {
  const assets = readAssets(world);
  const idx = findAssetIndex(world, assetId, assets);
  const updated = { ...assets[idx], status: "accepted" };
  const next = [...assets];
  next[idx] = updated;
  writeAssets(world, next);
  return updated;
}

/** status -> 'discarded' ONLY, refuses on already-'accepted'. @returns {object} the updated StagecraftAsset. */
export function discardStagecraftAsset(world, assetId) {
  const assets = readAssets(world);
  const idx = findAssetIndex(world, assetId, assets);
  if (assets[idx].status === "accepted") {
    throw new Error(
      `Refusing to discard stagecraft asset "${assetId}" (status "accepted") -- only a not-yet-accepted 'proposed' asset can be discarded outright.`
    );
  }
  const updated = { ...assets[idx], status: "discarded" };
  const next = [...assets];
  next[idx] = updated;
  writeAssets(world, next);
  return updated;
}

/**
 * Overwrites name/source/meta/desc/foundryRef on an EXISTING asset — the
 * re-pull update half of the `map`-ref dedup/upsert
 * (wf-mcp-server/lib/foundry-pull-ops.mjs). `id`/`world`/`kind`/`createdAt`/
 * `status`/`tags` are preserved untouched. Refuses unless still
 * `status:'proposed'` — same guard as every sibling store's re-ingest
 * updater.
 * @returns {object}   the updated StagecraftAsset
 */
export function updateStagecraftAssetFields(world, assetId, { name, source, meta, desc, foundryRef, thumb } = {}) {
  const assets = readAssets(world);
  const idx = findAssetIndex(world, assetId, assets);
  const existing = assets[idx];
  if (existing.status !== "proposed") {
    throw new Error(
      `Refusing to overwrite stagecraft asset "${assetId}" (status "${existing.status}") -- only a still-'proposed' ` +
      `asset may be updated by a re-ingest; an accepted/discarded asset is a human decision, never silently overwritten.`
    );
  }
  const updated = {
    ...existing,
    name: name ?? existing.name,
    source: source ?? existing.source,
    meta: meta !== undefined ? meta : existing.meta,
    desc: desc !== undefined ? desc : existing.desc,
    foundryRef: foundryRef !== undefined ? foundryRef : existing.foundryRef,
    // Phase 38 task 38.2, §3 -- a compendium browse row's re-ingest also
    // refreshes its thumb (additive-only field, see this file's own header).
    thumb: thumb !== undefined ? thumb : existing.thumb
  };
  const next = [...assets];
  next[idx] = updated;
  writeAssets(world, next);
  return updated;
}

/** @returns {object}   the updated StagecraftAsset. Throws a clear Error if `assetId` isn't found. */
export function addStagecraftTag(world, assetId, tag) {
  const assets = readAssets(world);
  findAssetIndex(world, assetId, assets); // throws "No stagecraft asset found" if unknown
  const next = addTag(assets, assetId, tag);
  writeAssets(world, next);
  return next.find((a) => a.id === assetId);
}

/** @returns {object}   the updated StagecraftAsset. Throws a clear Error if `assetId` isn't found. */
export function removeStagecraftTag(world, assetId, tag) {
  const assets = readAssets(world);
  findAssetIndex(world, assetId, assets); // throws "No stagecraft asset found" if unknown
  const next = removeTag(assets, assetId, tag);
  writeAssets(world, next);
  return next.find((a) => a.id === assetId);
}

/**
 * Phase 38 task 38.2, §4 -- the import-on-accept flow's pending-import
 * ledger writer. Mirrors `session-planner/scenes.mjs`'s `setScenePendingPush`
 * exactly, one store over: set `{opId, requestedAt}` when an
 * `import_compendium_scene` op was written but the accept route's poll
 * window closed before a result landed; `null` clears it (either because a
 * result landed, ok:true or ok:false, or because there was never a pending
 * import to begin with). `pendingImport` is additive-optional -- a
 * pre-Phase-38.2 asset on disk simply has this key absent, read identically
 * to `null`.
 * @param {string} world
 * @param {string} assetId
 * @param {{opId:string, requestedAt:string}|null} pending
 * @returns {object}   the updated StagecraftAsset
 */
export function setStagecraftAssetPendingImport(world, assetId, pending) {
  const assets = readAssets(world);
  const idx = findAssetIndex(world, assetId, assets);
  const updated = { ...assets[idx], pendingImport: pending ?? null };
  const next = [...assets];
  next[idx] = updated;
  writeAssets(world, next);
  return updated;
}

/**
 * Phase 38 task 38.2, §4 -- completes a compendiumRef browse row on a
 * confirmed `ok:true` import result: `foundryRef.sceneUuid` set,
 * `status:'accepted'`, `pendingImport` cleared. From this moment the row is
 * an ORDINARY accepted Foundry map asset (§3's "normal accepted-map
 * behavior") -- no further special-casing anywhere reads `compendiumRef`
 * again except to key a future re-pull's dedup (which now finds THIS
 * accepted row and leaves it untouched, same as `upsertStagecraftMap`'s own
 * accepted-match branch).
 * @param {string} world
 * @param {string} assetId
 * @param {string} sceneUuid
 * @returns {object}   the updated StagecraftAsset
 */
export function markStagecraftAssetImported(world, assetId, sceneUuid) {
  const assets = readAssets(world);
  const idx = findAssetIndex(world, assetId, assets);
  const updated = {
    ...assets[idx],
    foundryRef: { sceneUuid },
    status: "accepted",
    pendingImport: null
  };
  const next = [...assets];
  next[idx] = updated;
  writeAssets(world, next);
  return updated;
}

export { ConcurrentWriteError };
