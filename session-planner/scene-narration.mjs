/**
 * Scene narration store — pure, Foundry-free, unit-testable.
 *
 * Phase 28 task 28.1. Mirrors mutation-engine/entity-narration.mjs's
 * history/supersede shape one level up: keyed by `sceneId` instead of
 * `entityId`, holding a scene's own hand-typed "read-aloud" text (the design
 * record's "show THIS scene's own time-slice only" — a scene's narration is
 * authored directly by the GM via click-to-edit, not LLM-generated the way
 * entity-narration.mjs's entries are, so this store carries no
 * `sourceMutationId`/`sourceBatchId` provenance fields).
 *
 * Storage: one JSON file per (world, sceneId) — matching entity-narration.mjs's
 * own per-entity-file convention exactly (`<sceneNarrationRoot>/<world>/
 * <sceneId>.json`, a flat array of SceneNarrationEntry objects), for the same
 * reason: the real query pattern here is always keyed by a single scene (get
 * current, get history), never "every narrated scene in a world at once".
 * Default root is GM_Tools/scene-narration/ (sibling to entity-narration/,
 * session-scenes/); override with GM_TOOLS_SCENE_NARRATION_DIR (tests use
 * this for isolation — the exact env var name is pinned by
 * review-ui/test/e2e/phase28-fixture.mjs's own setupPhase28Env).
 *
 * HISTORY, not a single overwritten "latest" value — every save appends a
 * new entry and marks any existing `status:'current'` entry `'superseded'`
 * first. Nothing is ever deleted. Only one entry per scene may be `'current'`
 * at a time.
 *
 * Concurrency: reuses review-state.mjs's `withLock`/`ConcurrentWriteError`
 * rather than a second file-locking implementation, per this directory's own
 * established precedent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "scene-narration");

export const SCHEMA_VERSION = 1;

export const SceneNarrationStatus = z.enum(["current", "superseded"]);

export const SceneNarrationEntry = z.object({
  narrationId: z.string(),
  sceneId: z.string(),
  text: z.string(),
  createdAt: z.string(),
  status: SceneNarrationStatus
}).strict();

export function sceneNarrationRoot() {
  return process.env.GM_TOOLS_SCENE_NARRATION_DIR || DEFAULT_ROOT;
}

function worldDir(world) {
  return join(sceneNarrationRoot(), world);
}

function narrationFilePath(world, sceneId) {
  return join(worldDir(world), `${sceneId}.json`);
}

/** Generate a narration-entry id. Injectable (opts.makeId) for deterministic tests, same pattern as entity-narration.mjs's makeNarrationId. */
export function makeNarrationId() {
  return `snarr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Full history for a scene, oldest-first as stored. Returns [] if the scene has never had narration saved -- not an error. */
export function getSceneNarrationHistory(world, sceneId) {
  const filePath = narrationFilePath(world, sceneId);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** The one entry with status:'current', or null (never a 404 -- absence is a valid state per the route contract). */
export function getCurrentSceneNarration(world, sceneId) {
  return getSceneNarrationHistory(world, sceneId).find((e) => e.status === "current") ?? null;
}

function writeHistory(world, sceneId, entries) {
  const validated = entries.map((e) => SceneNarrationEntry.parse(e));
  const filePath = narrationFilePath(world, sceneId);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(validated, null, 2), "utf8");
  });
  return validated;
}

/**
 * Record new narration text for a scene: marks any existing `'current'`
 * entry `'superseded'` (still present in history, never deleted), appends
 * the new entry as `'current'`.
 *
 * @param {string} world
 * @param {string} sceneId
 * @param {{text:string}} data
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object}   the newly-saved, now-current entry
 */
export function saveSceneNarration(world, sceneId, { text }, opts = {}) {
  const makeId = opts.makeId ?? makeNarrationId;
  const now = opts.now ?? new Date().toISOString();
  const existing = getSceneNarrationHistory(world, sceneId).map((e) =>
    e.status === "current" ? { ...e, status: "superseded" } : e
  );
  const entry = {
    narrationId: makeId(),
    sceneId,
    text,
    createdAt: now,
    status: "current"
  };
  writeHistory(world, sceneId, [...existing, entry]);
  return entry;
}

/**
 * Marks the scene's current narration (if any) as superseded WITHOUT adding
 * a new entry. Safe no-op (writes nothing) for a scene with no current
 * narration.
 *
 * @returns {object[]} the scene's full history (unchanged if nothing was current)
 */
export function supersedeSceneNarration(world, sceneId) {
  const existing = getSceneNarrationHistory(world, sceneId);
  if (!existing.some((e) => e.status === "current")) return existing;
  const updated = existing.map((e) => (e.status === "current" ? { ...e, status: "superseded" } : e));
  return writeHistory(world, sceneId, updated);
}

export { ConcurrentWriteError };
