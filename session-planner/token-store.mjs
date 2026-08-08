/**
 * Token index store — Phase 35 task 35.1, §3 of review-ui/test/e2e/
 * phase35-fixture.mjs (THE WRITTEN CONTRACT), reusing
 * plans/phase-32-deferred.md §2's TokenRecord design VERBATIM (no changes
 * this phase). Grouped with scenes.mjs (session-planner/), not
 * combat-planning/ — tokens are scene-attached, not combat-stat-attached.
 *
 * Deliberately NO status/review-gate (deferred §2: a positional fact
 * Foundry already owns, not authored content a human accepts/edits) and NO
 * per-token upsert-by-id (`PlacedToken` has no stable id in
 * FOUNDRY_INDEX_VERSION=1) — every pull does a full PER-SCENE REPLACE via
 * `syncTokensForScene`, never an upsert; two tokens with the same
 * name/x/y/actorUuid are indistinguishable in the wire format, so inventing
 * a fake identity to upsert against would be worse than a blunt replace.
 *
 * Storage: `<tokenRoot>/<world>.json`, ONE JSON file per world, a flat
 * array of TokenRecord. Default root GM_Tools/tokens/; override
 * GM_TOOLS_TOKEN_DIR (tests use this for isolation — the exact env var name
 * is pinned by review-ui/test/e2e/phase35-fixture.mjs's own
 * setupPhase35Env). Reuses review-state.mjs's withLock/ConcurrentWriteError,
 * per every other store's established precedent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";
import { listScenesForWorld } from "./scenes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "tokens");

export function tokenRoot() {
  return process.env.GM_TOOLS_TOKEN_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return join(tokenRoot(), `${world}.json`);
}

function readTokens(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeTokens(world, tokens) {
  const filePath = worldFilePath(world);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(tokens, null, 2), "utf8");
  });
  return tokens;
}

/** Generate a token-record id. Injectable (opts.makeId) for deterministic tests. */
export function makeTokenId() {
  return `tok_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Best-effort link into session-planner/scenes.mjs: the id of the GM_Tools
 * scene whose `foundrySceneRef === sceneUuid`, or `null` if unresolved (the
 * common case on a first-ever pull — deferred §2's own note: this only
 * resolves for a scene that was itself PUSHED from GM_Tools, since no
 * pull-scenes slice exists yet).
 */
function resolveSceneId(world, sceneUuid) {
  const scene = listScenesForWorld(world).find((s) => s.foundrySceneRef === sceneUuid);
  return scene ? scene.id : null;
}

/**
 * Full per-scene REPLACE: deletes every existing TokenRecord for
 * `sceneUuid` in `world`, then inserts the freshly-pulled set wholesale —
 * mirrors the index file's own "always a full replace" semantics rather
 * than inventing a fake per-token identity to upsert against. `capturedAt`
 * should be the index's own `exportedAt` this token set was read from
 * (falls back to opts.now/current time if omitted, e.g. a direct hand-call).
 *
 * @param {string} world
 * @param {string} sceneUuid
 * @param {{name?:string, x?:number, y?:number, actorUuid?:string, img?:string}[]} rawTokens
 * @param {string} [capturedAt]
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object[]}   the freshly-inserted TokenRecords for this scene, AFTER the replace (so an empty `rawTokens` correctly returns [], distinguishing "genuinely empty now" from "still has tokens from before")
 */
export function syncTokensForScene(world, sceneUuid, rawTokens, capturedAt, opts = {}) {
  const makeId = opts.makeId ?? makeTokenId;
  const now = capturedAt ?? opts.now ?? new Date().toISOString();
  const sceneId = resolveSceneId(world, sceneUuid);
  const all = readTokens(world);
  const others = all.filter((t) => t.sceneUuid !== sceneUuid);
  const fresh = (Array.isArray(rawTokens) ? rawTokens : []).map((t) => ({
    id: makeId(),
    world,
    sceneUuid,
    sceneId,
    name: typeof t?.name === "string" && t.name ? t.name : "Unnamed Token",
    x: typeof t?.x === "number" ? t.x : null,
    y: typeof t?.y === "number" ? t.y : null,
    actorUuid: typeof t?.actorUuid === "string" ? t.actorUuid : null,
    img: typeof t?.img === "string" ? t.img : null,
    capturedAt: now
  }));
  writeTokens(world, [...others, ...fresh]);
  return fresh;
}

/**
 * @param {string} world
 * @param {string} [sceneUuid]   optional filter
 * @returns {object[]}   every TokenRecord for `world` (optionally filtered by `sceneUuid`). [] if none.
 */
export function listTokens(world, sceneUuid) {
  const tokens = readTokens(world);
  return sceneUuid ? tokens.filter((t) => t.sceneUuid === sceneUuid) : tokens;
}

export { ConcurrentWriteError };
