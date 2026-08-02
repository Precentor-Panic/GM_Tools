/**
 * Saved-encounter store — pure, Foundry-free, unit-testable.
 *
 * Phase 22 ADDENDUM (found while grounding Phase 23's task plan in real
 * code, same precedent as the Phase 18 addendum found while grounding
 * Phase 19 — a small, tightly-scoped gap-fill with its own tests, not a
 * separate QE-then-build cycle). plans/phase-21-review.md §6: "Add Event"
 * and "Add Encounter" are equal-weight, permanently — but "Add Event"
 * (session-planner/session-notes.mjs's captureNote, which already accepts a
 * sceneId) had no sibling on the encounter side: combat-planning/
 * encounter-heuristic.mjs's suggestEncounter/scoreCombination are pure,
 * stateless scoring functions with no persistence at all, and the Encounter
 * Builder UI's working roster (review-ui/public/combat-planning-view.js's
 * session.workingRoster) only ever lives as ephemeral browser state. This
 * module is that missing sibling — Phase 23 (scene construction UI, not yet
 * dispatched) needs a real "Add Encounter" action with something to attach.
 *
 * SNAPSHOT, NOT A LIVE REFERENCE: saveEncounter persists the roster
 * combination, the knobs used, and the score fields (expectedScore/
 * burstCeiling/snowballDelta/asymmetricRiskFlag) AS THEY WERE AT SAVE TIME —
 * plain data copied in, never a pointer back into combat-planning/
 * bestiary-store.mjs or a live re-invocation of suggestEncounter/
 * scoreCombination. If the underlying bestiary entry's score changes later,
 * getSavedEncounter's return value does NOT change (see this module's own
 * test file for the proof). encounter-heuristic.mjs's scoring logic is
 * imported nowhere in this file — this module only stores what that logic
 * already produced, per the addendum's own "doesn't touch how scores are
 * computed" constraint.
 *
 * Storage: ONE JSON file PER WORLD — `<savedEncountersRoot>/<world>.json`, a
 * flat array of SavedEncounter objects, each carrying its own `sceneId`
 * field — the EXACT same shape session-planner/session-notes.mjs already
 * uses for its own scene-attachable "Add Event" records (a SessionNote is a
 * flat per-world array with a `sceneId` field; listPendingNotes filters that
 * array the same way listEncountersForScene does here), chosen specifically
 * so this module reads as a sibling of session-notes.mjs, not a differently-
 * shaped store for a conceptually equal-weight feature. getSavedEncounter
 * looks up by encounterId alone (no sceneId needed), which is exactly why a
 * flat per-world array beats a per-(world,sceneId) file layout here (unlike
 * mutation-engine/scene-undo.mjs's per-session file, which is always looked
 * up by (world, sceneId) together and never needs a bare-id lookup).
 * Default root is GM_Tools/saved-encounters/ (sibling to session-notes/,
 * scene-membership/); override with GM_TOOLS_SAVED_ENCOUNTERS_DIR (tests use
 * this for isolation). Reuses review-state.mjs's withLock/
 * ConcurrentWriteError, same convention as every sibling store.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "saved-encounters");

export function savedEncountersRoot() {
  return process.env.GM_TOOLS_SAVED_ENCOUNTERS_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return join(savedEncountersRoot(), `${world}.json`);
}

function readEncounters(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeEncounters(world, encounters) {
  const filePath = worldFilePath(world);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(encounters, null, 2), "utf8");
  });
  return encounters;
}

/** Generate a saved-encounter id. Injectable (opts.makeId) for deterministic tests, same convention as session-notes.mjs's makeNoteId/scene-undo.mjs's makeSceneUndoActionId. */
export function makeSavedEncounterId() {
  return `enc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Persists a SNAPSHOT of a built encounter, linked to a scene. Plain data in,
 * plain data out — `combination`/`knobs`/`scoreSnapshot` are deep-copied via
 * JSON round-trip before being written, so no caller-held reference (or any
 * later mutation of a bestiary entry the combination was built from) can
 * ever change what a later getSavedEncounter/listEncountersForScene call
 * returns.
 *
 * @param {string} world
 * @param {string} sceneId                                     required — this is what makes the encounter "attached" (design record §6)
 * @param {object} fields
 * @param {string} [fields.name]                                defaults to "Encounter" if omitted/blank, same "always a real string" convention as transit-entity.mjs's default naming
 * @param {Array<{entryId:string, count:number}>} fields.combination   encounter-heuristic.mjs's own combination shape, echoed verbatim
 * @param {object} [fields.knobs]                               the knobs suggestEncounter/scoreCombination were called with
 * @param {{expectedScore:number, burstCeiling:number, snowballDelta:object, asymmetricRiskFlag:boolean}} fields.scoreSnapshot   the score fields AT SAVE TIME, per encounter-heuristic.mjs's own suggestEncounter/scoreCombination output shape (minus `combination`, passed separately above)
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object}   the created SavedEncounter
 */
export function saveEncounter(world, sceneId, { name, combination, knobs, scoreSnapshot } = {}, opts = {}) {
  if (!sceneId) throw new Error("saveEncounter requires a sceneId -- an encounter is always attached to a scene.");
  const makeId = opts.makeId ?? makeSavedEncounterId;
  const now = opts.now ?? new Date().toISOString();
  const encounter = {
    id: makeId(),
    world,
    sceneId,
    name: name && String(name).trim() ? String(name).trim() : "Encounter",
    // JSON round-trip: a real snapshot, not a reference to caller-held
    // objects (e.g. a bestiary entry or a live derivedScore) that could
    // mutate out from under this store later.
    combination: JSON.parse(JSON.stringify(combination ?? [])),
    knobs: JSON.parse(JSON.stringify(knobs ?? {})),
    scoreSnapshot: JSON.parse(JSON.stringify(scoreSnapshot ?? {})),
    createdAt: now
  };
  const encounters = readEncounters(world);
  writeEncounters(world, [...encounters, encounter]);
  return encounter;
}

/** @returns {object[]}   every SavedEncounter for `world` attached to `sceneId`, in save order. [] if none. */
export function listEncountersForScene(world, sceneId) {
  return readEncounters(world).filter((e) => e.sceneId === sceneId);
}

/** @returns {object|null}   the SavedEncounter with this id in `world`, or null if not found. */
export function getSavedEncounter(world, encounterId) {
  return readEncounters(world).find((e) => e.id === encounterId) ?? null;
}

/**
 * Idempotent-in-effect: removing an absent/already-removed encounterId is a
 * safe no-op (returns null), not an error, matching scene-membership.mjs's
 * removeNodeFromScene convention.
 *
 * @param {string} world
 * @param {string} encounterId
 * @returns {object|null}   the removed SavedEncounter, or null if no matching id was found.
 */
export function removeSavedEncounter(world, encounterId) {
  const encounters = readEncounters(world);
  const found = encounters.find((e) => e.id === encounterId);
  if (!found) return null;
  writeEncounters(world, encounters.filter((e) => e.id !== encounterId));
  return found;
}

export { ConcurrentWriteError };
