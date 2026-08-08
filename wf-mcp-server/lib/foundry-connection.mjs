/**
 * Connection-state derivation + sync-now composition — Phase 34 task 34.1.
 * Backend glue behind the Connection-Menu chip/panel (design record +
 * plans/phase-34-tasks.md's pre-specified route/store contract, which 34.0's
 * e2e pins independently). Pure composition over EXISTING primitives only,
 * per gm-tools-conventions' "front-ends are thin wrappers, never logic
 * duplicators": ./foundry-index.mjs's readFoundryIndex (the Foundry ->
 * GM_Tools PULL file reader, never throws on a missing file -- see its own
 * header) and ./foundry-pull-ops.mjs's pullFoundryActorsToStores (the
 * EXISTING review-gated ingest, unmodified). No second index reader, no
 * second pull implementation.
 *
 * STATE DERIVATION:
 *   off   = no readable foundry-index (readFoundryIndex returned null, or
 *           it returned a shape with no `exportedAt` at all -- the
 *           "genuinely malformed top-level shape" degrade-to-empty case
 *           foundry-index.mjs's own header documents).
 *   stale = index.exportedAt is older than staleThresholdMs (default 15
 *           minutes, DEFAULT_STALE_THRESHOLD_MS below) -- overridable per
 *           call via opts.staleThresholdMs, which the route wires from
 *           session-planner/app-settings.mjs's staleThresholdMs when set.
 *   live  = index present and fresh.
 * `counts` comes straight from the index's own arrays. NOTE: the index
 * shape as read TODAY (foundry-index.mjs's FoundryIndexShape) only actually
 * carries actors/users/scenes/tokens -- the bridge contract has no
 * items/journals arrays yet (a Phase-32 scope limit on the Foundry side,
 * not something this task can retroactively add). This module reports 0
 * for either missing array rather than omitting the key or throwing, so
 * the documented `counts:{actors,items,scenes,journals}` response shape
 * holds even though `items`/`journals` are always 0 until a future Foundry-
 * side bridge extension adds them.
 *
 * SYNC-LOG: a tiny per-world append-only log (`<syncLogRoot>/<world>.json`,
 * a flat array of `{at, ok, error?, pulled?}`, capped to the last
 * SYNC_LOG_MAX_ENTRIES entries) written by syncNow below after every
 * sync-now attempt, success or failure. `lastSync` in deriveConnectionState's
 * response is the newest entry (at/ok/error only -- `pulled` is a logging
 * detail, not part of the connection-state contract). Default root is
 * GM_Tools/foundry-sync-log/ (sibling to review-state/, human-review/,
 * app-settings/); override with GM_TOOLS_SYNC_LOG_DIR (tests use this for
 * isolation, same convention as every sibling store). Reuses
 * review-state.mjs's withLock/ConcurrentWriteError rather than a second
 * file-locking implementation.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, ConcurrentWriteError } from "../../mutation-engine/review-state.mjs";
import { readFoundryIndex } from "./foundry-index.mjs";
import { pullFoundryActorsToStores } from "./foundry-pull-ops.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SYNC_LOG_ROOT = join(__dirname, "..", "..", "foundry-sync-log");

export const DEFAULT_STALE_THRESHOLD_MS = 15 * 60 * 1000;
export const SYNC_LOG_MAX_ENTRIES = 20;

export function syncLogRoot() {
  return process.env.GM_TOOLS_SYNC_LOG_DIR || DEFAULT_SYNC_LOG_ROOT;
}

function syncLogFilePath(world) {
  return join(syncLogRoot(), `${world}.json`);
}

/** Every logged entry for a world, oldest-first. [] if none yet -- never throws. */
export function readSyncLog(world) {
  const filePath = syncLogFilePath(world);
  if (!existsSync(filePath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return []; // a corrupt log file is informational-only, same "degrade rather than throw" reasoning as foundry-index.mjs's own malformed-shape handling
  }
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Append one sync-log entry, keeping only the last SYNC_LOG_MAX_ENTRIES.
 * withLock-protected read-modify-write, same convention as every sibling
 * store's own writer.
 *
 * @param {string} world
 * @param {{ok:boolean, error?:string, pulled?:object}} entry
 * @param {object} [opts]
 * @param {string} [opts.now]  injectable ISO timestamp, for deterministic tests
 * @returns {object} the stored entry
 */
export function appendSyncLogEntry(world, entry, opts = {}) {
  const filePath = syncLogFilePath(world);
  const now = opts.now ?? new Date().toISOString();
  const stored = {
    at: now,
    ok: !!entry.ok,
    ...(entry.error ? { error: entry.error } : {}),
    ...(entry.pulled ? { pulled: entry.pulled } : {})
  };
  return withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    const current = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) : [];
    const list = Array.isArray(current) ? current : [];
    const next = [...list, stored].slice(-SYNC_LOG_MAX_ENTRIES);
    writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
    return stored;
  });
}

function lastSyncFor(world) {
  const log = readSyncLog(world);
  if (!log.length) return null;
  const last = log[log.length - 1];
  return { at: last.at, ok: !!last.ok, ...(last.error ? { error: last.error } : {}) };
}

function countsFromIndex(index) {
  return {
    actors: Array.isArray(index.actors) ? index.actors.length : 0,
    items: Array.isArray(index.items) ? index.items.length : 0,
    scenes: Array.isArray(index.scenes) ? index.scenes.length : 0,
    journals: Array.isArray(index.journals) ? index.journals.length : 0
  };
}

/**
 * @param {string} dataDir
 * @param {string} world
 * @param {object} [opts]
 * @param {number} [opts.staleThresholdMs]  default DEFAULT_STALE_THRESHOLD_MS
 * @param {number|string} [opts.now]  injectable "now" (ms epoch or ISO string), for deterministic tests
 * @returns {{state:'live'|'stale'|'off', exportedAt:string|null, ageMs:number|null, staleThresholdMs:number, counts:object|null, lastSync:object|null, world:string}}
 */
export function deriveConnectionState(dataDir, world, opts = {}) {
  const staleThresholdMs = opts.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const nowMs = opts.now === undefined ? Date.now() : typeof opts.now === "string" ? Date.parse(opts.now) : opts.now;
  const lastSync = lastSyncFor(world);

  const index = readFoundryIndex(dataDir, world);
  if (!index || !index.exportedAt) {
    return { state: "off", exportedAt: null, ageMs: null, staleThresholdMs, counts: null, lastSync, world };
  }

  const exportedAtMs = Date.parse(index.exportedAt);
  if (Number.isNaN(exportedAtMs)) {
    // A present-but-unparseable exportedAt is informationally the same as
    // "no usable freshness signal" -- treat it as off rather than crashing
    // or silently claiming "live" with a bogus age.
    return { state: "off", exportedAt: index.exportedAt, ageMs: null, staleThresholdMs, counts: null, lastSync, world };
  }

  const ageMs = Math.max(0, nowMs - exportedAtMs);
  const state = ageMs > staleThresholdMs ? "stale" : "live";
  return { state, exportedAt: index.exportedAt, ageMs, staleThresholdMs, counts: countsFromIndex(index), lastSync, world };
}

/**
 * POST /api/foundry/sync-now's composition -- the route itself stays a thin
 * wrapper over this. Per the pre-specified contract: does NOT block on a
 * live Foundry client being open, and does NOT throw when no index exists
 * yet -- that's an ordinary, expected "never reindexed" state, reported as
 * `{state:'off', message}` (200, not 4xx/5xx).
 *
 * @param {string} dataDir
 * @param {string} world
 * @param {object} [opts]
 * @param {object} [opts.pullOpts]  forwarded to pullFoundryActorsToStores (makeId/now — test-injectable determinism)
 * @param {string} [opts.now]       injectable ISO timestamp for the sync-log entry AND deriveConnectionState's freshness calc
 * @returns {{state:'off', message:string} | {pulled:object, indexAgeMs:number, state:'live'|'stale'}}
 */
export function syncNow(dataDir, world, opts = {}) {
  let index;
  try {
    index = readFoundryIndex(dataDir, world);
  } catch (err) {
    appendSyncLogEntry(world, { ok: false, error: err.message }, opts);
    throw err;
  }

  if (!index || !index.exportedAt) {
    return {
      state: "off",
      message:
        `No Foundry index found for world "${world}" yet -- open this world in Foundry with the World Fabric ` +
        `module active and run a reindex (api.reindexForGmTools()) first.`
    };
  }

  let pullResult;
  try {
    pullResult = pullFoundryActorsToStores(dataDir, world, opts.pullOpts ?? {});
  } catch (err) {
    appendSyncLogEntry(world, { ok: false, error: err.message }, opts);
    throw err;
  }

  const pulled = {
    bestiaryProposed: pullResult.bestiaryProposed,
    partyProposed: pullResult.partyProposed,
    alreadyLinked: pullResult.alreadyLinked
  };
  appendSyncLogEntry(
    world,
    { ok: true, pulled: { bestiaryProposed: pulled.bestiaryProposed.length, partyProposed: pulled.partyProposed.length } },
    opts
  );

  const { state, ageMs } = deriveConnectionState(dataDir, world, opts);
  return { pulled, indexAgeMs: ageMs, state };
}

export { ConcurrentWriteError };
