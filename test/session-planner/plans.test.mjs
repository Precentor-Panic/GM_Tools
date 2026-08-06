import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — session-planner/plans.mjs (Phase 26 task 26.1, F1;
 * `deletePlan`/`plansContainingScene` added Phase 28 task 28.1). This is the
 * first dedicated unit-test file for this module (it previously had only
 * route-level/e2e coverage) — added while extending it with `deletePlan`/
 * `plansContainingScene`, per gm-tools-conventions' "deterministic logic must
 * have unit tests before done" and phase-28-tasks.md 28.1's own instruction
 * to extend (or, since it didn't exist yet, add) this file.
 *
 * Plan shape: `{id, world, name, sceneIds:[], createdAt}` — a named,
 * reusable, many-to-many collection of scene ids. deletePlan(world, planId)
 * removes ONLY the Plan record (idempotent — an unknown/already-deleted
 * planId returns {deleted:false}, never throws); the scenes it referenced
 * are completely untouched (this store never touches scenes.mjs at all).
 * plansContainingScene(world, sceneId) returns every FULL Plan record whose
 * sceneIds includes sceneId, in listPlansForWorld's own stable append order
 * — [] for a scene that belongs to no Plan, never throws.
 */

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

// Isolate BOTH review-state.mjs (plans.mjs reuses its withLock) and
// plans.mjs's own root BEFORE importing either -- same pattern as
// test/session-planner/scene-links.test.mjs.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-plans-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PLANS_DIR = join(scratchDir, "session-plans");

const REPO_DEFAULT_ROOT = join(new URL("../../session-plans", import.meta.url).pathname);
const before = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();

const WORLD = "plans-test-world";

const { createPlan, getPlan, listPlansForWorld, addSceneToPlan, removeSceneFromPlan, reorderPlanScenes, deletePlan, plansContainingScene, renamePlan, plansRoot } =
  await import("../../session-planner/plans.mjs");

test("directory isolation: plansRoot() honors GM_TOOLS_PLANS_DIR, never the repo's real default", () => {
  assert.equal(plansRoot(), process.env.GM_TOOLS_PLANS_DIR);
  assert.notEqual(plansRoot(), REPO_DEFAULT_ROOT);
});

test("listPlansForWorld: [] for a world with no plans yet -- not an error", () => {
  assert.deepEqual(listPlansForWorld("a-totally-new-plans-world"), []);
});

test("createPlan: creates a plan with empty sceneIds", () => {
  const plan = createPlan(WORLD, { name: "Session 1" }, { makeId: () => "plan-1", now: "2026-08-01T00:00:00.000Z" });
  assert.equal(plan.id, "plan-1");
  assert.equal(plan.world, WORLD);
  assert.equal(plan.name, "Session 1");
  assert.deepEqual(plan.sceneIds, []);
  assert.equal(plan.createdAt, "2026-08-01T00:00:00.000Z");
});

test("getPlan: round-trips a created plan by id, throws a clear error for an unknown id", () => {
  createPlan(WORLD, { name: "Round Trip" }, { makeId: () => "plan-roundtrip" });
  assert.equal(getPlan(WORLD, "plan-roundtrip").name, "Round Trip");
  assert.throws(() => getPlan(WORLD, "does-not-exist"), /does-not-exist/);
});

test("addSceneToPlan/removeSceneFromPlan: idempotent add and remove, scoped to ONE plan only", () => {
  const planA = createPlan(WORLD, { name: "A" }, { makeId: () => "plan-scenes-a" });
  const planB = createPlan(WORLD, { name: "B" }, { makeId: () => "plan-scenes-b" });
  addSceneToPlan(WORLD, planA.id, "scene-shared");
  addSceneToPlan(WORLD, planA.id, "scene-shared"); // idempotent, no duplicate
  addSceneToPlan(WORLD, planB.id, "scene-shared");
  assert.deepEqual(getPlan(WORLD, planA.id).sceneIds, ["scene-shared"]);
  assert.deepEqual(getPlan(WORLD, planB.id).sceneIds, ["scene-shared"]);

  removeSceneFromPlan(WORLD, planA.id, "scene-shared");
  assert.deepEqual(getPlan(WORLD, planA.id).sceneIds, [], "removed from planA only");
  assert.deepEqual(getPlan(WORLD, planB.id).sceneIds, ["scene-shared"], "planB's own membership untouched");

  removeSceneFromPlan(WORLD, planA.id, "scene-never-there"); // safe no-op
});

// ------------------------------------------------- Phase 28 task 28.2, §E

test("reorderPlanScenes: happy-path permutation persists as the new sceneIds order", () => {
  const plan = createPlan(WORLD, { name: "Reorder Me" }, { makeId: () => "plan-reorder-happy" });
  addSceneToPlan(WORLD, plan.id, "scene-r1");
  addSceneToPlan(WORLD, plan.id, "scene-r2");
  addSceneToPlan(WORLD, plan.id, "scene-r3");
  assert.deepEqual(getPlan(WORLD, plan.id).sceneIds, ["scene-r1", "scene-r2", "scene-r3"]);

  const updated = reorderPlanScenes(WORLD, plan.id, ["scene-r3", "scene-r1", "scene-r2"]);
  assert.deepEqual(updated.sceneIds, ["scene-r3", "scene-r1", "scene-r2"]);
  assert.deepEqual(getPlan(WORLD, plan.id).sceneIds, ["scene-r3", "scene-r1", "scene-r2"], "persisted, not just returned in-memory");

  // A plain up/down swap is just a two-element instance of the same call.
  const swapped = reorderPlanScenes(WORLD, plan.id, ["scene-r1", "scene-r3", "scene-r2"]);
  assert.deepEqual(swapped.sceneIds, ["scene-r1", "scene-r3", "scene-r2"]);
});

test("reorderPlanScenes: rejects a non-permutation (missing/extra/duplicate id) with a clear error, leaves the stored order untouched", () => {
  const plan = createPlan(WORLD, { name: "Reject Bad Reorder" }, { makeId: () => "plan-reorder-reject" });
  addSceneToPlan(WORLD, plan.id, "scene-x1");
  addSceneToPlan(WORLD, plan.id, "scene-x2");

  assert.throws(
    () => reorderPlanScenes(WORLD, plan.id, ["scene-x1"]), // missing scene-x2
    /permutation/
  );
  assert.throws(
    () => reorderPlanScenes(WORLD, plan.id, ["scene-x1", "scene-x2", "scene-never-a-member"]), // extra id
    /permutation/
  );
  assert.throws(
    () => reorderPlanScenes(WORLD, plan.id, ["scene-x1", "scene-x1"]), // duplicate, still missing scene-x2
    /permutation/
  );
  assert.throws(() => reorderPlanScenes(WORLD, "plan-does-not-exist", ["a"]), /plan-does-not-exist/);

  assert.deepEqual(getPlan(WORLD, plan.id).sceneIds, ["scene-x1", "scene-x2"], "a rejected reorder must not mutate the stored order");
});

// ------------------------------------------------- Phase 28 task 28.1

test("deletePlan: removes ONLY the plan record, returns {deleted:true}", () => {
  const plan = createPlan(WORLD, { name: "To Delete" }, { makeId: () => "plan-delete-1" });
  assert.ok(getPlan(WORLD, plan.id), "sanity: plan exists before delete");

  const result = deletePlan(WORLD, plan.id);
  assert.deepEqual(result, { deleted: true });
  assert.throws(() => getPlan(WORLD, plan.id), /plan-delete-1/);
  assert.ok(!listPlansForWorld(WORLD).some((p) => p.id === plan.id));
});

test("deletePlan: idempotent -- deleting an unknown/already-deleted planId returns {deleted:false}, never throws", () => {
  assert.deepEqual(deletePlan(WORLD, "plan-never-existed"), { deleted: false });

  const plan = createPlan(WORLD, { name: "Double Delete" }, { makeId: () => "plan-double-delete" });
  assert.deepEqual(deletePlan(WORLD, plan.id), { deleted: true });
  assert.deepEqual(deletePlan(WORLD, plan.id), { deleted: false }, "a second delete of the same id must not throw");
});

test("deletePlan: does not touch any scene record -- this store has no scene-record access at all (structural, confirmed by import grep below)", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../../session-planner/plans.mjs", import.meta.url), "utf8");
  assert.ok(!/from ".\/scenes\.mjs"/.test(src), "plans.mjs must never import session-planner/scenes.mjs -- it only ever holds scene id pointers");
});

test("plansContainingScene: [] for a scene that belongs to no plan -- never throws", () => {
  assert.deepEqual(plansContainingScene(WORLD, "scene-orphan-1"), []);
});

test("plansContainingScene: returns every FULL plan record containing the scene, in listPlansForWorld's own append order", () => {
  const world = "plans-containing-scene-world";
  const planX = createPlan(world, { name: "X" }, { makeId: () => "plan-contains-x" });
  const planY = createPlan(world, { name: "Y" }, { makeId: () => "plan-contains-y" });
  const planZ = createPlan(world, { name: "Z" }, { makeId: () => "plan-contains-z" }); // does not contain the scene
  addSceneToPlan(world, planX.id, "scene-in-two-plans");
  addSceneToPlan(world, planY.id, "scene-in-two-plans");
  void planZ;

  const found = plansContainingScene(world, "scene-in-two-plans");
  assert.deepEqual(found.map((p) => p.id), ["plan-contains-x", "plan-contains-y"], "creation/append order, planZ excluded");
  assert.equal(found[0].name, "X", "returns FULL plan records, not just ids");
});

test("plansContainingScene: a plan containing a scene, then having it removed, no longer appears", () => {
  const world = "plans-containing-scene-removed-world";
  const plan = createPlan(world, { name: "Removable" }, { makeId: () => "plan-contains-removed" });
  addSceneToPlan(world, plan.id, "scene-removed-later");
  assert.equal(plansContainingScene(world, "scene-removed-later").length, 1);

  removeSceneFromPlan(world, plan.id, "scene-removed-later");
  assert.deepEqual(plansContainingScene(world, "scene-removed-later"), []);
});

test("Phase 30 task 30.5: renamePlan persists a new name, and clears it when passed null; sceneIds untouched", () => {
  const world = "plans-rename-world";
  const plan = createPlan(world, { name: "First Draft" }, { makeId: () => "plan-rename-1" });
  addSceneToPlan(world, plan.id, "scene-keep");

  const renamed = renamePlan(world, "plan-rename-1", "The Real Session One");
  assert.equal(renamed.name, "The Real Session One");
  assert.deepEqual(renamed.sceneIds, ["scene-keep"], "renaming must not touch sceneIds");
  assert.equal(getPlan(world, "plan-rename-1").name, "The Real Session One", "persisted, not just returned");

  const cleared = renamePlan(world, "plan-rename-1", null);
  assert.equal(cleared.name, null);
  assert.equal(getPlan(world, "plan-rename-1").name, null);
});

test("Phase 30 task 30.5: renamePlan throws a clear error for an unknown planId", () => {
  assert.throws(() => renamePlan("plans-rename-world", "does-not-exist-rename", "X"), /does-not-exist-rename/);
});

test("no write in this file leaked into the repo's real default session-plans/ directory", () => {
  const after = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();
  const added = [...after].filter((f) => !before.has(f));
  assert.deepEqual(added, [], `this test run must not add new entries to ${REPO_DEFAULT_ROOT}, found: ${added}`);
});

console.log(`\n${passed} passed`);
rmSync(scratchDir, { recursive: true, force: true });
