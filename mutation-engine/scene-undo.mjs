/**
 * Scene-scoped batch-undo — pure, Foundry-free, unit-testable.
 *
 * Phase 22 task 22.4. Resolves plans/phase-21-review.md §12's "scene-local
 * rollback" open question exactly as adjudicated: a GENUINE ordered action
 * history scoped to one scene-development session — NOT
 * mutation-engine/manual-undo.mjs's single global last-write-wins slot
 * copy-pasted under a new name. That module's own header comment is
 * explicit: "there is no history list to push onto" — this is precisely the
 * gap this new module closes, for the "Develop this scene" flow
 * specifically. Single-node "Develop this node" is UNAFFECTED and keeps
 * using manual-undo.mjs's existing global slot, completely untouched by this
 * module.
 *
 * REUSES manual-undo.mjs's UndoAction zod schema (graphMutations/
 * narrationUndo union) by IMPORTING it — this module never redefines its own
 * copy of that shape.
 *
 * Storage: file-PER-(world,sceneId)-SESSION —
 * `<sceneUndoRoot>/<world>/<sceneId>.json`, holding `{ sceneId, world,
 * createdAt, actions: UndoAction[] }`. This is deliberately the SAME
 * per-batch-file-under-a-world-subdir layout mutation-engine/review-state.mjs
 * already uses, NOT manual-undo.mjs's single flat-file-per-world layout.
 * Default root is GM_Tools/scene-undo/ (sibling to review-state/,
 * manual-undo/); override with GM_TOOLS_SCENE_UNDO_DIR (tests use this for
 * isolation). Reuses review-state.mjs's withLock/ConcurrentWriteError, same
 * convention as every sibling store.
 *
 * `startSceneUndoSession` ALWAYS (re)initializes a fresh, EMPTY session for
 * that (world, sceneId) pair — one "Develop this scene" click is one
 * session; it deliberately does not try to merge across separate presses.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, ConcurrentWriteError } from "./review-state.mjs";
import { UndoAction } from "./manual-undo.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "scene-undo");

export function sceneUndoRoot() {
  return process.env.GM_TOOLS_SCENE_UNDO_DIR || DEFAULT_ROOT;
}

function sessionFilePath(world, sceneId) {
  return join(sceneUndoRoot(), world, `${sceneId}.json`);
}

function readSession(world, sceneId) {
  const filePath = sessionFilePath(world, sceneId);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeSession(world, sceneId, session) {
  const filePath = sessionFilePath(world, sceneId);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(session, null, 2), "utf8");
  });
  return session;
}

/** Generate a scene-undo action id. Injectable (opts.makeId) for deterministic tests, same convention as manual-undo.mjs's own makeUndoActionId. */
export function makeSceneUndoActionId() {
  return `scundo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Always (re)initializes a fresh, empty session for (world, sceneId) —
 * discards whatever was recorded by a prior session for the same pair.
 *
 * @param {string} world
 * @param {string} sceneId
 * @param {object} [opts]
 * @param {string} [opts.now]
 * @returns {{sceneId:string, world:string, createdAt:string, actions:object[]}}
 */
export function startSceneUndoSession(world, sceneId, opts = {}) {
  const now = opts.now ?? new Date().toISOString();
  const session = { sceneId, world, createdAt: now, actions: [] };
  return writeSession(world, sceneId, session);
}

/**
 * Appends a validated UndoAction to the session. Throws a clear error if no
 * session has been started yet for this (world, sceneId).
 *
 * @param {string} world
 * @param {string} sceneId
 * @param {{kind:string, description:string, graphMutations?:object[]|null, narrationUndo?:object|null}} action
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object}   the full updated session
 */
export function recordSceneUndoAction(world, sceneId, action, opts = {}) {
  const session = readSession(world, sceneId);
  if (!session) {
    throw new Error(
      `No scene-undo session started for world="${world}" sceneId="${sceneId}" -- call startSceneUndoSession first.`
    );
  }
  const makeId = opts.makeId ?? makeSceneUndoActionId;
  const now = opts.now ?? new Date().toISOString();
  const stored = UndoAction.parse({
    actionId: makeId(),
    kind: action.kind,
    world,
    createdAt: now,
    description: action.description,
    graphMutations: action.graphMutations ?? null,
    narrationUndo: action.narrationUndo ?? null
  });
  session.actions.push(stored);
  return writeSession(world, sceneId, session);
}

/** Read-only peek. [] if no session has been started (or it's empty). */
export function listSceneUndoActions(world, sceneId) {
  const session = readSession(world, sceneId);
  return session ? [...session.actions] : [];
}

/**
 * Pops and RETURNS the most-recently-recorded action (does NOT apply its
 * inverse itself — matches manual-undo.mjs's consumeUndoSlot's own "return
 * the data, caller applies it" convention). null if the session is
 * empty/nonexistent.
 */
export function undoLastSceneAction(world, sceneId) {
  const session = readSession(world, sceneId);
  if (!session || session.actions.length === 0) return null;
  const action = session.actions.pop();
  writeSession(world, sceneId, session);
  return action;
}

/**
 * Pops and returns EVERY recorded action, in REVERSE (most-recent-first)
 * order, clearing the session's action list. [] if empty/nonexistent.
 */
export function undoAllSceneActions(world, sceneId) {
  const session = readSession(world, sceneId);
  if (!session || session.actions.length === 0) return [];
  const reversed = [...session.actions].reverse();
  session.actions = [];
  writeSession(world, sceneId, session);
  return reversed;
}

/** Empties a session's action list without returning it. Safe no-op if no session exists. */
export function clearSceneUndoSession(world, sceneId) {
  const session = readSession(world, sceneId);
  if (!session) return;
  session.actions = [];
  writeSession(world, sceneId, session);
}

export { ConcurrentWriteError };
