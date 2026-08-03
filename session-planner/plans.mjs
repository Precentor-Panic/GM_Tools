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

export { ConcurrentWriteError };
