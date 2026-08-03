/**
 * Scene-to-scene link store — pure, Foundry-free, unit-testable.
 *
 * Phase 26 task 26.3, §26.C ("Path B"). Explicit scene-to-scene links,
 * recorded as `{sceneId, linkedSceneId, reason?, graphEdgeId?}` — entirely
 * OUTSIDE the World Fabric graph itself (considered-and-rejected: making
 * scenes real graph entities, per §26.C's own restated reasoning). Two
 * scenes become linked whenever "+Scene"/"link to an existing scene" is used
 * from within a scene, REGARDLESS of whether their underlying places got
 * graph-linked — the project owner's own words: "the scenes are linked
 * because they are tied together in a plan."
 *
 * ONE record per link (not two) — matching scene-membership.mjs's own
 * economical convention — but bidirectional FOR QUERY PURPOSES: linking
 * A->B means both "scenes linked to A" and "scenes linked to B" surface it.
 *
 * Phase 27 task 27.3, F12 (SCHEMA_VERSION 2 = the optional `graphEdgeId`
 * field) — a scene-link MAY additionally carry the id of a real World Fabric
 * graph edge (`addEdgeOp`'s return value) pushed between the two scenes' own
 * place entities, so a later "break the graph link?" action
 * (`deleteEdgeOp`) can target that exact edge. Purely additive/optional:
 * records without it (SCHEMA_VERSION 1, pre-27.3) still read fine —
 * `graphEdgeId` simply reads as `null` wherever it was never stored, no
 * normalize-on-read step is needed (unlike saved-encounter.mjs's `sceneIds`
 * shape change, which renamed a field; this one only ADDS one).
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

/** Phase 27 task 27.3: 2 = the record shape with an optional `graphEdgeId` field. 1 (implicit) = the original {sceneId, linkedSceneId, reason} shape, still readable as-is (additive-only change, no normalize-on-read needed). */
export const SCHEMA_VERSION = 2;

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
 * the existing record's `reason`/`graphEdgeId` (when a new one is supplied)
 * rather than creating a second record -- never duplicates.
 *
 * @param {string} world
 * @param {string} sceneIdA
 * @param {string} sceneIdB
 * @param {string} [reason]
 * @param {string} [graphEdgeId]   Phase 27 task 27.3, F12 -- the id of a real World Fabric graph edge (addEdgeOp's return value) pushed between the two scenes' place entities, if any. Omit (or pass null) when linking without a graph push.
 * @returns {{sceneId:string, linkedSceneId:string, reason:string|null, graphEdgeId:string|null}}   the stored record (as-stored orientation, not necessarily A->B)
 */
export function linkScenes(world, sceneIdA, sceneIdB, reason = null, graphEdgeId = null) {
  const links = readLinks(world);
  const existing = links.find((l) => isSamePair(l, sceneIdA, sceneIdB));
  if (existing) {
    let changed = false;
    if (reason !== undefined && reason !== null) {
      existing.reason = reason;
      changed = true;
    }
    if (graphEdgeId !== undefined && graphEdgeId !== null) {
      existing.graphEdgeId = graphEdgeId;
      changed = true;
    }
    if (changed) writeLinks(world, links);
    return existing;
  }
  const created = { sceneId: sceneIdA, linkedSceneId: sceneIdB, reason: reason ?? null, graphEdgeId: graphEdgeId ?? null };
  writeLinks(world, [...links, created]);
  return created;
}

/**
 * Idempotent: unlinking an absent pair is a safe no-op.
 *
 * @param {string} world
 * @param {string} sceneIdA
 * @param {string} sceneIdB
 * @returns {{removed:boolean, link:{sceneId:string, linkedSceneId:string, reason:string|null, graphEdgeId:string|null}|null}}   `link` is the REMOVED record (as-stored orientation), so a caller can target its `graphEdgeId` for a graph-edge break; null when nothing matched.
 */
export function unlinkScenes(world, sceneIdA, sceneIdB) {
  const links = readLinks(world);
  const found = links.find((l) => isSamePair(l, sceneIdA, sceneIdB)) ?? null;
  const removed = found !== null;
  if (removed) {
    writeLinks(world, links.filter((l) => l !== found));
  }
  return { removed, link: found ? { ...found, graphEdgeId: found.graphEdgeId ?? null } : null };
}

/**
 * Bidirectional query over single-direction-stored records: returns one
 * entry per OTHER scene linked to `sceneId`, regardless of which side of the
 * originally-stored pair `sceneId` was.
 *
 * @param {string} world
 * @param {string} sceneId
 * @returns {Array<{sceneId:string, reason:string|null, graphEdgeId:string|null}>}   `sceneId` here is the OTHER (linked) scene's id
 */
export function getLinkedScenes(world, sceneId) {
  const links = readLinks(world);
  const out = [];
  for (const link of links) {
    if (link.sceneId === sceneId) {
      out.push({ sceneId: link.linkedSceneId, reason: link.reason ?? null, graphEdgeId: link.graphEdgeId ?? null });
    } else if (link.linkedSceneId === sceneId) {
      out.push({ sceneId: link.sceneId, reason: link.reason ?? null, graphEdgeId: link.graphEdgeId ?? null });
    }
  }
  return out;
}

export { ConcurrentWriteError };
