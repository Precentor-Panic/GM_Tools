/**
 * Scene-to-scene link store — pure, Foundry-free, unit-testable.
 *
 * Phase 26 task 26.3, §26.C ("Path B"). Explicit scene-to-scene links,
 * recorded as `{sceneId, linkedSceneId, reason?}` — entirely OUTSIDE the
 * World Fabric graph (considered-and-rejected: making scenes real graph
 * entities, per §26.C's own restated reasoning). Two scenes become linked
 * whenever "+Scene"/"link to an existing scene" is used from within a
 * scene, REGARDLESS of whether their underlying places got graph-linked —
 * the project owner's own words: "the scenes are linked because they are
 * tied together in a plan."
 *
 * ONE record per link (not two) — matching scene-membership.mjs's own
 * economical convention — but bidirectional FOR QUERY PURPOSES: linking
 * A->B means both "scenes linked to A" and "scenes linked to B" surface it.
 *
 * Storage: ONE JSON file PER WORLD — `<sceneLinksRoot>/<world>.json`, a flat
 * array of link records. Default root is GM_Tools/scene-links/ (sibling to
 * session-scenes/, scene-membership/, session-plans/); override with
 * GM_TOOLS_SCENE_LINKS_DIR (tests use this for isolation, matching
 * phase26-fixture.mjs's setupPhase26Env). Reuses review-state.mjs's
 * withLock/ConcurrentWriteError, same as every sibling store here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "scene-links");

export function sceneLinksRoot() {
  return process.env.GM_TOOLS_SCENE_LINKS_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return join(sceneLinksRoot(), `${world}.json`);
}

function readLinks(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeLinks(world, links) {
  const filePath = worldFilePath(world);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(links, null, 2), "utf8");
  });
  return links;
}

function isSamePair(link, sceneIdA, sceneIdB) {
  return (
    (link.sceneId === sceneIdA && link.linkedSceneId === sceneIdB) ||
    (link.sceneId === sceneIdB && link.linkedSceneId === sceneIdA)
  );
}

/**
 * Idempotent by unordered pair: linking an already-linked pair again updates
 * the existing record's `reason` (when a new one is supplied) rather than
 * creating a second record.
 *
 * @param {string} world
 * @param {string} sceneIdA
 * @param {string} sceneIdB
 * @param {string} [reason]
 * @returns {{sceneId:string, linkedSceneId:string, reason:string|null}}   the stored record (as-stored orientation, not necessarily A->B)
 */
export function linkScenes(world, sceneIdA, sceneIdB, reason = null) {
  const links = readLinks(world);
  const existing = links.find((l) => isSamePair(l, sceneIdA, sceneIdB));
  if (existing) {
    if (reason !== undefined && reason !== null) {
      existing.reason = reason;
      writeLinks(world, links);
    }
    return existing;
  }
  const created = { sceneId: sceneIdA, linkedSceneId: sceneIdB, reason: reason ?? null };
  writeLinks(world, [...links, created]);
  return created;
}

/**
 * Idempotent: unlinking an absent pair is a safe no-op.
 *
 * @param {string} world
 * @param {string} sceneIdA
 * @param {string} sceneIdB
 * @returns {{removed:boolean}}
 */
export function unlinkScenes(world, sceneIdA, sceneIdB) {
  const links = readLinks(world);
  const next = links.filter((l) => !isSamePair(l, sceneIdA, sceneIdB));
  const removed = next.length !== links.length;
  if (removed) writeLinks(world, next);
  return { removed };
}

/**
 * Bidirectional query over single-direction-stored records: returns one
 * entry per OTHER scene linked to `sceneId`, regardless of which side of the
 * originally-stored pair `sceneId` was.
 *
 * @param {string} world
 * @param {string} sceneId
 * @returns {Array<{sceneId:string, reason:string|null}>}   `sceneId` here is the OTHER (linked) scene's id
 */
export function getLinkedScenes(world, sceneId) {
  const links = readLinks(world);
  const out = [];
  for (const link of links) {
    if (link.sceneId === sceneId) {
      out.push({ sceneId: link.linkedSceneId, reason: link.reason ?? null });
    } else if (link.linkedSceneId === sceneId) {
      out.push({ sceneId: link.sceneId, reason: link.reason ?? null });
    }
  }
  return out;
}

export { ConcurrentWriteError };
