/**
 * Scene membership store — pure, Foundry-free, unit-testable.
 *
 * Phase 22 task 22.3. Design record §4: the default surfaced set for a scene
 * stays 1-hop from its anchor (session-planner/corridor.mjs, unchanged) — this
 * module is the "add arbitrary node" escape hatch: a scene's EXPLICIT
 * extra-membership list, layered on top of (never replacing) that 1-hop
 * default, plus the reachability-aware intervening-node OFFER (§4's "offered,
 * never forced" rule).
 *
 * Storage: ONE JSON file PER WORLD — `<sceneMembershipRoot>/<world>.json`, a
 * flat array of `{ sceneId, entityIds }`. Same one-file-per-world flat
 * convention as session-planner/scenes.mjs itself, but a wholly SEPARATE
 * store — this store owns membership. (Phase 31 task 31.2: addNodeToScene now
 * ALSO makes one best-effort call into scenes.mjs's touchScene to bump the
 * Scene's recency for the World scene-tray; the membership write remains this
 * store's own authoritative data.) Default root is GM_Tools/scene-membership/ (sibling to
 * session-scenes/); override with GM_TOOLS_SCENE_MEMBERSHIP_DIR (tests use
 * this for isolation). Reuses review-state.mjs's withLock/ConcurrentWriteError
 * rather than a second file-locking implementation.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";
import { shortestPath } from "./corridor.mjs";
// Phase 31 task 31.2 (§3.1): a scene-member add bumps the target Scene's
// recency so the World scene-tray reflects the drop (moves to top, agoLabel ->
// "just now"). This is the ONLY coupling to scenes.mjs — a best-effort recency
// signal layered on top of this store's own authoritative membership write.
import { touchScene } from "./scenes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "scene-membership");

export function sceneMembershipRoot() {
  return process.env.GM_TOOLS_SCENE_MEMBERSHIP_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return join(sceneMembershipRoot(), `${world}.json`);
}

function readEntries(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeEntries(world, entries) {
  const filePath = worldFilePath(world);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf8");
  });
  return entries;
}

/**
 * @param {string} world
 * @param {string} sceneId
 * @returns {{sceneId:string, entityIds:string[]}}   {sceneId, entityIds: []} for a scene with no entry yet.
 */
export function getSceneMembership(world, sceneId) {
  const entries = readEntries(world);
  const entry = entries.find((e) => e.sceneId === sceneId);
  return entry ? { sceneId: entry.sceneId, entityIds: [...entry.entityIds] } : { sceneId, entityIds: [] };
}

/**
 * Trivially easy add, per the design record's own framing — no reachability
 * check, no snapshot read at all. Idempotent: adding an already-present
 * entityId is a no-op (no duplicate), still returns the current membership.
 *
 * @param {string} world
 * @param {string} sceneId
 * @param {string} entityId
 * @returns {{sceneId:string, entityIds:string[]}}
 */
export function addNodeToScene(world, sceneId, entityId) {
  const entries = readEntries(world);
  const entry = entries.find((e) => e.sceneId === sceneId);
  let result;
  if (!entry) {
    const created = { sceneId, entityIds: [entityId] };
    writeEntries(world, [...entries, created]);
    result = { sceneId, entityIds: [...created.entityIds] };
  } else {
    if (!entry.entityIds.includes(entityId)) {
      entry.entityIds.push(entityId);
      writeEntries(world, entries);
    }
    result = { sceneId, entityIds: [...entry.entityIds] };
  }
  // Phase 31 task 31.2 (§3.1): bump the Scene's recency. Best-effort and
  // decoupled — the membership write above is authoritative; a scene that has
  // no record in the scenes store (this store never validated the FK) must not
  // fail the add, so a missing-scene throw is swallowed.
  try { touchScene(world, sceneId); } catch { /* scene not in scenes store — recency bump is best-effort */ }
  return result;
}

/**
 * Idempotent: removing an absent entityId is a safe no-op, not an error.
 *
 * @param {string} world
 * @param {string} sceneId
 * @param {string} entityId
 * @returns {{sceneId:string, entityIds:string[]}}
 */
export function removeNodeFromScene(world, sceneId, entityId) {
  const entries = readEntries(world);
  const entry = entries.find((e) => e.sceneId === sceneId);
  if (!entry) return { sceneId, entityIds: [] };
  const nextIds = entry.entityIds.filter((id) => id !== entityId);
  if (nextIds.length !== entry.entityIds.length) {
    entry.entityIds = nextIds;
    writeEntries(world, entries);
  }
  return { sceneId, entityIds: [...entry.entityIds] };
}

/**
 * PURE function (no store I/O at all) built on session-planner/corridor.mjs's
 * shortestPath — imported, not reimplemented. Never auto-adds anything; the
 * caller decides whether/what to add via addNodeToScene, separately.
 *
 * @param {object[]} entities
 * @param {object[]} edges
 * @param {string} sceneAnchorId
 * @param {string} targetEntityId
 * @returns {{reachable:boolean, interveningEntityIds:string[]}}
 */
export function offerInterveningNodes(entities, edges, sceneAnchorId, targetEntityId) {
  const path = shortestPath(entities, edges, sceneAnchorId, targetEntityId);
  if (!path) return { reachable: false, interveningEntityIds: [] };
  return { reachable: true, interveningEntityIds: path.slice(1, -1) };
}

export { ConcurrentWriteError };
