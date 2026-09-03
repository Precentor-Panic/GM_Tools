/**
 * Truth-notes store — pure, Foundry-free, unit-testable.
 *
 * Session Wrap workstream (see session-planner/session-wrap.mjs's own header
 * for the full flow). Holds the player-facing "What you've learned" recap
 * `generateTruthNotes()` produces after a GM has applied reveal-state
 * transitions for a session — one recap per Plan, HISTORY not a single
 * overwritten "latest" value, cloning mutation-engine/entity-narration.mjs's
 * exact history/supersede shape (same reasoning: a GM re-running Wrap for
 * the same Plan, or generating a second cut of the recap, should never lose
 * the earlier version).
 *
 * Storage: one JSON file per (world, planId) — matching entity-narration.mjs's
 * own per-entity-file convention (`<truthNotesRoot>/<world>/<planId>.json`,
 * a flat array of TruthNotesEntry objects). Default root is
 * GM_Tools/truth-notes/ (sibling to entity-narration/, scene-narration/);
 * override with GM_TOOLS_TRUTH_NOTES_DIR (tests use this for isolation, same
 * "no write leaked into the repo's real default directory" regression-test
 * convention as test/user-settings.test.mjs).
 *
 * HISTORY, not a single overwritten "latest" value: every save appends a new
 * entry and marks any existing `status:'current'` entry `'superseded'`
 * first. Nothing is ever deleted. Only one entry per Plan may be `'current'`
 * at a time.
 *
 * Concurrency: reuses review-state.mjs's `withLock`/`ConcurrentWriteError`
 * rather than a second file-locking implementation, per this directory's own
 * established precedent (entity-narration.mjs, scene-narration.mjs).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "truth-notes");

export const SCHEMA_VERSION = 1;

export const TruthNotesStatus = z.enum(["current", "superseded"]);

export const TruthNotesEntry = z.object({
  id: z.string(),
  createdAt: z.string(),
  sessionNumber: z.number().nullable(),
  revealedEntityIds: z.array(z.string()),
  markdown: z.string(),
  status: TruthNotesStatus
}).strict();

export function truthNotesRoot() {
  return process.env.GM_TOOLS_TRUTH_NOTES_DIR || DEFAULT_ROOT;
}

function worldDir(world) {
  return join(truthNotesRoot(), world);
}

function notesFilePath(world, planId) {
  return join(worldDir(world), `${planId}.json`);
}

/** Generate a truth-notes entry id. Injectable (opts.makeId) for deterministic tests, same pattern as entity-narration.mjs's makeNarrationId. */
export function makeTruthNotesId() {
  return `tnote_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Full history for a Plan, oldest-first as stored. Returns [] if truth notes have never been saved for it -- not an error. */
export function getTruthNotesHistory(world, planId) {
  const filePath = notesFilePath(world, planId);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** The one entry with status:'current', or null (never a 404 -- absence is a valid state, same convention as getCurrentSceneNarration). */
export function getCurrentTruthNotes(world, planId) {
  return getTruthNotesHistory(world, planId).find((e) => e.status === "current") ?? null;
}

function writeHistory(world, planId, entries) {
  const validated = entries.map((e) => TruthNotesEntry.parse(e));
  const filePath = notesFilePath(world, planId);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(validated, null, 2), "utf8");
  });
  return validated;
}

/**
 * Record a new truth-notes entry for a Plan: marks any existing `'current'`
 * entry `'superseded'` (still present in history, never deleted), appends
 * the new entry as `'current'`.
 *
 * @param {string} world
 * @param {string} planId
 * @param {{sessionNumber:number|null, revealedEntityIds:string[], markdown:string}} data
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object}   the newly-saved, now-current entry
 */
export function saveTruthNotes(world, planId, { sessionNumber, revealedEntityIds, markdown }, opts = {}) {
  const makeId = opts.makeId ?? makeTruthNotesId;
  const now = opts.now ?? new Date().toISOString();
  const existing = getTruthNotesHistory(world, planId).map((e) =>
    e.status === "current" ? { ...e, status: "superseded" } : e
  );
  const entry = {
    id: makeId(),
    createdAt: now,
    sessionNumber: sessionNumber ?? null,
    revealedEntityIds: revealedEntityIds ?? [],
    markdown,
    status: "current"
  };
  writeHistory(world, planId, [...existing, entry]);
  return entry;
}

export { ConcurrentWriteError };
