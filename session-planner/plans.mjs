/**
 * Plan store — pure, Foundry-free, unit-testable.
 *
 * Phase 26 task 26.1, §26.D. A Plan is a named, reusable, MANY-TO-MANY
 * collection of scene ids: `{id, name, sceneIds: []}`. A scene's id can
 * appear in any number of Plans — no back-reference is ever stored on the
 * Scene record itself (session-planner/scenes.mjs stays completely
 * unmodified, imported nowhere in this file). The project owner's own
 * framing: "like a linked list? Or list of pointers" — this store only ever
 * holds pointers (scene ids), never a copy of scene data.
 *
 * Storage: ONE JSON file PER WORLD — `<plansRoot>/<world>.json`, a flat
 * array of Plan objects. Same one-file-per-world flat convention as every
 * sibling store in this directory (scenes.mjs, scene-membership.mjs).
 * Default root is GM_Tools/session-plans/ (sibling to session-scenes/,
 * scene-membership/); override with GM_TOOLS_PLANS_DIR (tests use this for
 * isolation, matching phase26-fixture.mjs's setupPhase26Env). Reuses
 * review-state.mjs's withLock/ConcurrentWriteError rather than a second
 * file-locking implementation, per this directory's own established
 * precedent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "session-plans");

export function plansRoot() {
  return process.env.GM_TOOLS_PLANS_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return join(plansRoot(), `${world}.json`);
}

function readPlans(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writePlans(world, plans) {
  const filePath = worldFilePath(world);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(plans, null, 2), "utf8");
  });
  return plans;
}

/** Generate a plan id. Injectable (opts.makeId) for deterministic tests, same pattern as scenes.mjs's makeSceneId. */
export function makePlanId() {
  return `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {string} world
 * @param {{name:string}} fields
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object}   the created Plan, `sceneIds` starts empty.
 */
export function createPlan(world, { name } = {}, opts = {}) {
  const makeId = opts.makeId ?? makePlanId;
  const now = opts.now ?? new Date().toISOString();
  const plan = {
    id: makeId(),
    world,
    name: name ?? null,
    sceneIds: [],
    createdAt: now
  };
  const plans = readPlans(world);
  writePlans(world, [...plans, plan]);
  return plan;
}

/** @returns {object}   the Plan. Throws a clear Error if not found. */
export function getPlan(world, planId) {
  const plan = readPlans(world).find((p) => p.id === planId);
  if (!plan) {
    throw new Error(`No plan found: world="${world}" planId="${planId}"`);
  }
  return plan;
}

/** @returns {object[]}   every plan for `world`, in creation (append) order. [] if none. */
export function listPlansForWorld(world) {
  return readPlans(world);
}

/**
 * Idempotent: adding an already-present sceneId is a no-op (no duplicate
 * entry), still returns the current plan.
 *
 * @param {string} world
 * @param {string} planId
 * @param {string} sceneId
 * @returns {object}   the updated Plan
 */
export function addSceneToPlan(world, planId, sceneId) {
  const plans = readPlans(world);
  const plan = plans.find((p) => p.id === planId);
  if (!plan) {
    throw new Error(`No plan found: world="${world}" planId="${planId}"`);
  }
  if (!plan.sceneIds.includes(sceneId)) {
    plan.sceneIds.push(sceneId);
    writePlans(world, plans);
  }
  return plan;
}

/**
 * Idempotent: removing an absent sceneId is a safe no-op, not an error.
 * Removal is scoped to THIS plan only — a scene shared with another Plan
 * keeps its membership there completely untouched (§26.D's whole point).
 *
 * @param {string} world
 * @param {string} planId
 * @param {string} sceneId
 * @returns {object}   the updated Plan
 */
export function removeSceneFromPlan(world, planId, sceneId) {
  const plans = readPlans(world);
  const plan = plans.find((p) => p.id === planId);
  if (!plan) {
    throw new Error(`No plan found: world="${world}" planId="${planId}"`);
  }
  const nextIds = plan.sceneIds.filter((id) => id !== sceneId);
  if (nextIds.length !== plan.sceneIds.length) {
    plan.sceneIds = nextIds;
    writePlans(world, plans);
  }
  return plan;
}

/**
 * Phase 28 task 28.2, §E: persists a full reorder of a Plan's own scenes.
 * `orderedSceneIds` must be a PERMUTATION of the plan's current `sceneIds`
 * (same elements, same length, no additions/removals/duplicates dropped) --
 * a mismatch throws a clear Error rather than silently reconciling, since a
 * partial/stale client-side array here would otherwise silently drop or
 * duplicate a scene's membership. A plain ↑/↓ swap (the frontend's own
 * baseline reorder gesture) is just a two-element instance of this same
 * call, mirroring scene-elements.mjs's reorderElements own "simple ↑/↓ swap
 * is a two-element instance of the general reorder-by-array" precedent.
 *
 * @param {string} world
 * @param {string} planId
 * @param {string[]} orderedSceneIds
 * @returns {object}   the updated Plan
 */
export function reorderPlanScenes(world, planId, orderedSceneIds) {
  const plans = readPlans(world);
  const plan = plans.find((p) => p.id === planId);
  if (!plan) {
    throw new Error(`No plan found: world="${world}" planId="${planId}"`);
  }
  const current = [...plan.sceneIds].sort();
  const proposed = [...(orderedSceneIds ?? [])].sort();
  const isSamePermutation =
    current.length === proposed.length && current.every((id, i) => id === proposed[i]);
  if (!isSamePermutation) {
    throw new Error(
      `reorderPlanScenes: orderedSceneIds must be a permutation of the plan's current sceneIds. ` +
      `current=${JSON.stringify(plan.sceneIds)} proposed=${JSON.stringify(orderedSceneIds)}`
    );
  }
  plan.sceneIds = [...orderedSceneIds];
  writePlans(world, plans);
  return plan;
}

/**
 * Phase 28 task 28.1: removes ONLY the Plan record itself — every scene it
 * referenced is completely untouched (this store never touches scenes.mjs
 * anyway, so there is nothing else for a delete to cascade into). Idempotent:
 * deleting an already-deleted/unknown planId is a safe no-op, never throws.
 *
 * @param {string} world
 * @param {string} planId
 * @returns {{deleted:boolean}}
 */
export function deletePlan(world, planId) {
  const plans = readPlans(world);
  const next = plans.filter((p) => p.id !== planId);
  const deleted = next.length !== plans.length;
  if (deleted) writePlans(world, next);
  return { deleted };
}

/**
 * Phase 28 task 28.1: every FULL Plan record whose `sceneIds` includes
 * `sceneId`, in `listPlansForWorld`'s own stable append order (the scene
 * page's breadcrumb-back-btn contract depends on this exact ordering being
 * "first plan created that contains this scene").
 *
 * @param {string} world
 * @param {string} sceneId
 * @returns {object[]}   [] for a scene that belongs to no Plan -- never throws.
 */
export function plansContainingScene(world, sceneId) {
  return listPlansForWorld(world).filter((p) => p.sceneIds.includes(sceneId));
}

export { ConcurrentWriteError };
