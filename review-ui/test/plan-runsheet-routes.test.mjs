import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * Phase 30 task 30.3 -- deterministic HTTP-route regression home for the
 * plan-runsheet + scene-page route wrappers whose ONLY prior route-level
 * coverage lived in the now-retired phase28/29 e2e fixtures' route helpers
 * (plans/phase-30-structure.md §7's "confirm the deterministic route tests
 * already cover it; if a gap exists, add a small deterministic route test").
 * The underlying STORE logic (session-planner/plans.mjs, scene-elements.mjs,
 * scene-narration.mjs) keeps its own unit tests; this file pins the thin
 * server.mjs HTTP wrappers those retired e2e files used to exercise:
 *   - plan CRUD + membership: create / get / list / addScene / reorder /
 *     removeScene / plansContainingScene / deletePlan
 *   - scene-elements CRUD: create / list / patch / promote / demote / remove
 *   - narration: save / get
 * Real in-process server + real fetch, same pattern as the sibling
 * scene-planning-routes.test.mjs.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-plan-runsheet-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_SCENE_MEMBERSHIP_DIR = join(scratchDir, "scene-membership");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "plan-runsheet-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "pr-place-a", name: "The Salt Archive", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "pr-place-b", name: "The Bell Tower", type: "place", importance: 0.4 } }
]);

let server;
let base;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}
async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}
async function deleteJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function makeScene(locationEntityId) {
  const { status, body } = await postJson("/api/session-planner/scenes", { world: WORLD, locationEntityId });
  assert.equal(status, 200);
  return body.scene;
}

test("plan CRUD + membership: create -> addScene -> reorder -> removeScene -> plansContainingScene -> deletePlan (real HTTP round trip)", async () => {
  const s1 = await makeScene("pr-place-a");
  const s2 = await makeScene("pr-place-b");

  const created = await postJson("/api/scene-planning/plans", { world: WORLD, name: "Runsheet Route Plan" });
  assert.equal(created.status, 200);
  const planId = created.body.plan.id;
  assert.equal(created.body.plan.name, "Runsheet Route Plan");

  // list + get
  const list = await getJson(`/api/scene-planning/plans?world=${WORLD}`);
  assert.equal(list.status, 200);
  assert.ok(list.body.plans.some((p) => p.id === planId));
  const got = await getJson(`/api/scene-planning/plans/${planId}?world=${WORLD}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.plan.sceneIds, []);

  // addScene x2
  await postJson(`/api/scene-planning/plans/${planId}/scenes`, { world: WORLD, sceneId: s1.id });
  const afterAdd = await postJson(`/api/scene-planning/plans/${planId}/scenes`, { world: WORLD, sceneId: s2.id });
  assert.deepEqual(afterAdd.body.plan.sceneIds, [s1.id, s2.id]);

  // reorder
  const reordered = await postJson(`/api/scene-planning/plans/${planId}/reorder`, { world: WORLD, sceneIds: [s2.id, s1.id] });
  assert.equal(reordered.status, 200);
  assert.deepEqual(reordered.body.plan.sceneIds, [s2.id, s1.id]);

  // plansContainingScene reflects membership
  const containing = await getJson(`/api/scene-planning/scenes/${s1.id}/plans?world=${WORLD}`);
  assert.equal(containing.status, 200);
  assert.ok(containing.body.plans.some((p) => p.id === planId));

  // removeScene (unlink only -- scene survives)
  const afterRemove = await deleteJson(`/api/scene-planning/plans/${planId}/scenes/${s1.id}`, { world: WORLD });
  assert.equal(afterRemove.status, 200);
  assert.deepEqual(afterRemove.body.plan.sceneIds, [s2.id]);
  const sceneSurvives = await getJson(`/api/session-planner/scenes/${s1.id}?world=${WORLD}`);
  assert.equal(sceneSurvives.status, 200);
  assert.equal(sceneSurvives.body.scene.id, s1.id);

  // deletePlan
  const deleted = await deleteJson(`/api/scene-planning/plans/${planId}`, { world: WORLD });
  assert.equal(deleted.status, 200);
  const afterDelete = await getJson(`/api/scene-planning/plans?world=${WORLD}`);
  assert.ok(!afterDelete.body.plans.some((p) => p.id === planId));
});

test("scene-elements CRUD: create -> list -> patch -> promote -> demote -> remove (real HTTP round trip)", async () => {
  const scene = await makeScene("pr-place-a");

  const created = await postJson(`/api/scene-planning/scenes/${scene.id}/elements`, {
    world: WORLD, name: "A brass grate", fields: { trigger: "PCs step on it", gives: "a metallic clang" }
  });
  assert.equal(created.status, 200);
  const elId = created.body.element.id;
  assert.equal(created.body.element.kind, "local");

  const listed = await getJson(`/api/scene-planning/scenes/${scene.id}/elements?world=${WORLD}`);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.elements.some((e) => e.id === elId));

  const patched = await postJson(`/api/scene-planning/scenes/${scene.id}/elements/${elId}`, {
    world: WORLD, fields: { looks: "rust-eaten iron" }
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.element.fields.looks, "rust-eaten iron");

  // promote -> becomes a KEY graph element (kind:"graph", real graphEntityId)
  const promoted = await postJson(`/api/scene-planning/scenes/${scene.id}/elements/${elId}/promote`, { world: WORLD });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.element.kind, "graph");
  assert.ok(promoted.body.element.graphEntityId);

  // demote -> back to local, graph node NOT deleted (bookkeeping cleared only)
  const demoted = await postJson(`/api/scene-planning/scenes/${scene.id}/elements/${elId}/demote`, { world: WORLD });
  assert.equal(demoted.status, 200);
  assert.equal(demoted.body.element.kind, "local");

  const removed = await deleteJson(`/api/scene-planning/scenes/${scene.id}/elements/${elId}`, { world: WORLD });
  assert.equal(removed.status, 200);
  const afterRemove = await getJson(`/api/scene-planning/scenes/${scene.id}/elements?world=${WORLD}`);
  assert.ok(!afterRemove.body.elements.some((e) => e.id === elId));
});

test("narration: save -> get round-trips the scene read-aloud text over HTTP", async () => {
  const scene = await makeScene("pr-place-b");
  const saved = await postJson(`/api/scene-planning/scenes/${scene.id}/narration`, {
    world: WORLD, text: "The bell hangs silent above cold stone."
  });
  assert.equal(saved.status, 200);
  const got = await getJson(`/api/scene-planning/scenes/${scene.id}/narration?world=${WORLD}`);
  assert.equal(got.status, 200);
  assert.match(got.body.narration.text, /bell hangs silent/);
});
