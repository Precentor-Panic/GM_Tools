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
 * flat array of SavedEncounter objects. getSavedEncounter looks up by
 * encounterId alone (no sceneId needed), which is exactly why a flat
 * per-world array beats a per-(world,sceneId) file layout here (unlike
 * mutation-engine/scene-undo.mjs's per-session file, which is always looked
 * up by (world, sceneId) together and never needs a bare-id lookup).
 * Default root is GM_Tools/saved-encounters/ (sibling to session-notes/,
 * scene-membership/); override with GM_TOOLS_SAVED_ENCOUNTERS_DIR (tests use
 * this for isolation). Reuses review-state.mjs's withLock/
 * ConcurrentWriteError, same convention as every sibling store.
 *
 * Phase 27 task 27.2, F11 (SCHEMA_VERSION 2) — SHARED, MULTI-SCENE
 * DEFINITION: an encounter is no longer a per-scene copy. `sceneIds: []`
 * replaces the original single `sceneId` field (mirroring session-planner/
 * plans.mjs's own many-to-many `sceneIds[]` precedent for Plans<->Scenes).
 * saveEncounter keeps its `(world, sceneId, fields)` signature and creates
 * with `sceneIds: [sceneId]` (the origin scene) -- everything past creation
 * (attachEncounterToScene/detachEncounterFromScene/listEncountersForScene/
 * listEncountersForWorld) operates on the array. Legacy (schema-version-1)
 * records normalize to `sceneIds: [sceneId]` ON READ ONLY (normalizeEncounter,
 * below) -- no hard migration, no on-disk rewrite. Picking an existing
 * encounter for a second scene attaches the SAME definition (a shared
 * reference), never mints a duplicate snapshot; a detach that empties
 * `sceneIds` keeps the record as an unplaced library entry, not a delete.
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

/**
 * Phase 27 task 27.2, F11: a saved encounter is now a SHARED, multi-scene
 * definition -- `sceneIds: []` replaces the single `sceneId`, mirroring
 * session-planner/plans.mjs's own many-to-many `sceneIds[]` precedent.
 * SCHEMA_VERSION 2 = the `sceneIds[]` shape; version 1 (implicit, no field)
 * is the original single-`sceneId` shape. No hard migration -- legacy
 * records normalize to the current shape ON READ ONLY (see
 * normalizeEncounter/readEncounters below); the on-disk file is never
 * rewritten just to migrate it.
 */
export const SCHEMA_VERSION = 2;

/**
 * Normalizes one on-disk record to the current (`sceneIds: []`) shape.
 * A record already carrying a real `sceneIds` array is returned unchanged
 * (current shape). A legacy record (schema version 1, single `sceneId`
 * field) reads as `sceneIds: [sceneId]` -- the `sceneId` field itself is
 * dropped from the normalized (in-memory only) view so every caller past
 * this point sees exactly one shape, never a mix.
 *
 * @param {object} e   a raw record as stored on disk
 * @returns {object}   the normalized (in-memory) record
 */
function normalizeEncounter(e) {
  if (Array.isArray(e.sceneIds)) return e;
  const { sceneId, ...rest } = e;
  return { ...rest, sceneIds: sceneId ? [sceneId] : [] };
}

function worldFilePath(world) {
  return join(savedEncountersRoot(), `${world}.json`);
}

function readEncounters(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) return [];
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  return raw.map(normalizeEncounter);
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
    // Phase 27 task 27.2: a shared, multi-scene definition -- created with
    // ONLY the origin scene as a member, same as before except the field is
    // now an array (attachEncounterToScene/detachEncounterFromScene grow and
    // shrink it later; a detach that empties it keeps the record as an
    // unplaced library entry, see detachEncounterFromScene below).
    sceneIds: [sceneId],
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

/** @returns {object[]}   every SavedEncounter for `world` whose `sceneIds` includes `sceneId`, in save order. [] if none. */
export function listEncountersForScene(world, sceneId) {
  return readEncounters(world).filter((e) => e.sceneIds.includes(sceneId));
}

/** @returns {object[]}   every SavedEncounter definition for `world`, each appearing exactly once regardless of how many scenes reference it -- the world-picker feed. [] if none. */
export function listEncountersForWorld(world) {
  return readEncounters(world);
}

/**
 * Idempotent: attaching a scene the definition already includes is a no-op
 * (no duplicate entry in `sceneIds`), still returns the current record.
 *
 * @param {string} world
 * @param {string} encounterId
 * @param {string} sceneId
 * @returns {object}   the updated SavedEncounter. Throws a clear Error if `encounterId` is unknown.
 */
export function attachEncounterToScene(world, encounterId, sceneId) {
  const encounters = readEncounters(world);
  const encounter = encounters.find((e) => e.id === encounterId);
  if (!encounter) {
    throw new Error(`No saved encounter found: world="${world}" encounterId="${encounterId}"`);
  }
  if (!encounter.sceneIds.includes(sceneId)) {
    encounter.sceneIds.push(sceneId);
    writeEncounters(world, encounters);
  }
  return encounter;
}

/**
 * Idempotent: detaching an absent sceneId is a safe no-op. A detach that
 * empties `sceneIds` does NOT delete the record -- it survives as an
 * unplaced library entry, still reachable via listEncountersForWorld for a
 * later re-attach (orphan semantics per phase-27-tasks.md 27.2 -- a separate,
 * explicit delete-the-definition affordance is out of scope here).
 *
 * @param {string} world
 * @param {string} encounterId
 * @param {string} sceneId
 * @returns {object}   the updated SavedEncounter. Throws a clear Error if `encounterId` is unknown.
 */
export function detachEncounterFromScene(world, encounterId, sceneId) {
  const encounters = readEncounters(world);
  const encounter = encounters.find((e) => e.id === encounterId);
  if (!encounter) {
    throw new Error(`No saved encounter found: world="${world}" encounterId="${encounterId}"`);
  }
  const nextIds = encounter.sceneIds.filter((id) => id !== sceneId);
  if (nextIds.length !== encounter.sceneIds.length) {
    encounter.sceneIds = nextIds;
    writeEncounters(world, encounters);
  }
  return encounter;
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
