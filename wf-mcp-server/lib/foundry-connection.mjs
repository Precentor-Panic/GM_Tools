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
import { partySheetsFromIndex, PARTY_SHEETS_VERSION } from "../../combat-planning/party-sheet-index.mjs";
import { listPartyMembers } from "../../combat-planning/party-roster-store.mjs";
import { pullFoundryActorsToStores } from "./foundry-pull-ops.mjs";
// Phase 36 task 36.2, §5 -- the quiet-push flush engine's own entry point.
// sync-now is the SECOND of its two flush triggers, run UNCONDITIONALLY
// (independent of the pull half's own `state:'off'` early return below) --
// see syncNow's own updated doc comment.
import { flushDirtyStagedScenes } from "./foundry-push-ops.mjs";

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
/**
 * The freshness rules, extracted (2026-10-06) so a second consumer --
 * readPartySheets below -- cannot grow a drifting copy of them.
 * deriveConnectionState calls this; its own behaviour is unchanged, and
 * wf-mcp-server/test/foundry-connection.test.mjs is the regression net.
 *
 *   - no exportedAt at all            -> state 'off', ageMs null
 *   - present but unparseable         -> state 'off' (an honest "no usable
 *     freshness signal" rather than claiming 'live' with a bogus age)
 *   - otherwise                       -> 'live' | 'stale' against the threshold
 *
 * @param {string|null|undefined} exportedAt
 * @param {object} [opts]
 * @param {number} [opts.staleThresholdMs]
 * @param {number|string} [opts.now]  injectable, for deterministic tests
 * @returns {{state:'live'|'stale'|'off', exportedAt:string|null, ageMs:number|null, staleThresholdMs:number}}
 */
export function indexFreshness(exportedAt, opts = {}) {
  const staleThresholdMs = opts.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const nowMs = opts.now === undefined ? Date.now() : typeof opts.now === "string" ? Date.parse(opts.now) : opts.now;

  if (!exportedAt) return { state: "off", exportedAt: null, ageMs: null, staleThresholdMs };

  const exportedAtMs = Date.parse(exportedAt);
  if (Number.isNaN(exportedAtMs)) return { state: "off", exportedAt, ageMs: null, staleThresholdMs };

  const ageMs = Math.max(0, nowMs - exportedAtMs);
  return { state: ageMs > staleThresholdMs ? "stale" : "live", exportedAt, ageMs, staleThresholdMs };
}

export function deriveConnectionState(dataDir, world, opts = {}) {
  const lastSync = lastSyncFor(world);
  const index = readFoundryIndex(dataDir, world);
  const fresh = indexFreshness(index?.exportedAt, opts);
  const counts = fresh.state === "off" ? null : countsFromIndex(index);
  return { ...fresh, counts, lastSync, world };
}

/**
 * The Run view's party rail (2026-10-06). Composes readFoundryIndex with the
 * pure projection in combat-planning/party-sheet-index.mjs and the roster
 * store's curated rows. READ-ONLY -- writes nothing, so no review gate
 * applies; see that module's header for why this is a projection rather than
 * another store.
 *
 * Never throws: a world with no index yet returns state 'off', empty sheets,
 * and the same reindex instruction syncNow uses, so the rail can say what to
 * do instead of rendering dashes that read like real zeroes.
 *
 * @param {string} dataDir
 * @param {string} world
 * @param {object} [opts]  staleThresholdMs / now, forwarded to indexFreshness
 * @returns {object}
 */
export function readPartySheets(dataDir, world, opts = {}) {
  const index = readFoundryIndex(dataDir, world);
  const fresh = indexFreshness(index?.exportedAt, opts);
  if (fresh.state === "off") {
    return {
      version: PARTY_SHEETS_VERSION, world, ...fresh, sheets: [], excluded: [],
      note: "No Foundry index for this world yet -- open it in Foundry with the World Fabric module active and run a reindex (`api.reindexForGmTools()`)."
    };
  }
  let rosterMembers = [];
  try { rosterMembers = listPartyMembers(world); } catch { rosterMembers = []; }
  const projected = partySheetsFromIndex(index, { rosterMembers });
  return { version: projected.version, world, ...fresh, sheets: projected.sheets, excluded: projected.excluded };
}

/**
 * POST /api/foundry/sync-now's composition -- the route itself stays a thin
 * wrapper over this. Per the pre-specified contract: does NOT block on a
 * live Foundry client being open, and does NOT throw when no index exists
 * yet -- that's an ordinary, expected "never reindexed" state, reported as
 * `{state:'off', message}` (200, not 4xx/5xx).
 *
 * Phase 36 task 36.2, §5: gained a `pushed` key, additive alongside the
 * existing `pulled`/`indexAgeMs`/`state` (and alongside `message` on the
 * `state:'off'` branch). The push half (`flushDirtyStagedScenes`) runs
 * UNCONDITIONALLY, independent of the pull half's own `state:'off'`-when-
 * no-index early return above -- a world with staged scenes but no Foundry
 * index yet must still attempt to flush them (push and pull are independent
 * concerns; gating push on pull's own precondition would silently block
 * "ready to run" for a world that's never been pulled FROM). This is why
 * `syncNow` is now `async` (it wasn't before) -- `flushDirtyStagedScenes`
 * itself awaits `writeFoundryOps`'s poll.
 *
 * @param {string} dataDir
 * @param {string} world
 * @param {object} [opts]
 * @param {object} [opts.pullOpts]  forwarded to pullFoundryActorsToStores (makeId/now — test-injectable determinism)
 * @param {object} [opts.pushOpts]  forwarded to flushDirtyStagedScenes (makeOpId/pollMs/timeoutMs — test-injectable determinism)
 * @param {string} [opts.now]       injectable ISO timestamp for the sync-log entry AND deriveConnectionState's freshness calc
 * @returns {Promise<
 *   {state:'off', message:string, pushed:object} |
 *   {pulled:object, indexAgeMs:number, state:'live'|'stale', pushed:object}
 * >}
 */
export async function syncNow(dataDir, world, opts = {}) {
  let index;
  try {
    index = readFoundryIndex(dataDir, world);
  } catch (err) {
    appendSyncLogEntry(world, { ok: false, error: err.message }, opts);
    throw err;
  }

  const pushed = await flushDirtyStagedScenes(dataDir, world, opts.pushOpts ?? {});

  if (!index || !index.exportedAt) {
    return {
      state: "off",
      message:
        `No Foundry index found for world "${world}" yet -- open this world in Foundry with the World Fabric ` +
        `module active and run a reindex (api.reindexForGmTools()) first.`,
      pushed
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
  return { pulled, indexAgeMs: ageMs, state, pushed };
}

export { ConcurrentWriteError };
