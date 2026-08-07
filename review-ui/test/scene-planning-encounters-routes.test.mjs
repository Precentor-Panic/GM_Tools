import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — Phase 22 ADDENDUM's new `review-ui/server.mjs`
 * routes wrapping combat-planning/saved-encounter.mjs ("Add Encounter"
 * persistence, plans/phase-21-review.md §6's equal-weight sibling of "Add
 * Event"/session-notes.mjs's captureNote, wired the same
 * `/api/scene-planning/scenes/:sceneId/*` way as this file's sibling
 * `scene-planning-routes.test.mjs` tests the `.../members` routes).
 *
 * A clearly-named SIBLING file, not an edit to `scene-planning-routes.test.mjs`
 * itself -- same real-HTTP-request-against-an-in-process-server pattern
 * (node:test's test/before/after, fetch()), same scratch-dir/env-var
 * isolation convention, same security-case coverage convention as that file
 * and as `routes.test.mjs`'s own established pattern -- extended here, not a
 * new testing style invented for this addendum.
 *
 * ---------------------------------------------------------------------------
 * POST /api/scene-planning/scenes/:sceneId/encounters   { world, name?, combination, knobs?, scoreSnapshot? }
 * ---------------------------------------------------------------------------
 * Thin wrapper over combat-planning/saved-encounter.mjs's
 * saveEncounter(w, sceneId, {name, combination, knobs, scoreSnapshot}).
 * Response 200: { encounter }.
 *
 * ---------------------------------------------------------------------------
 * GET /api/scene-planning/scenes/:sceneId/encounters?world=
 * ---------------------------------------------------------------------------
 * Thin wrapper over listEncountersForScene(w, sceneId). Response 200:
 * { encounters: [...] }.
 *
 * ---------------------------------------------------------------------------
 * DELETE /api/scene-planning/scenes/:sceneId/encounters/:encounterId   { world } (query or body, matching /api/scene-planning/scenes/:sceneId/members/:entityId's own established convention)
 * ---------------------------------------------------------------------------
 * Phase 27 (task 27.2, F11): REDEFINED as detach-from-this-scene -- a thin
 * wrapper over detachEncounterFromScene(w, encounterId, sceneId). Removes
 * ONLY this scene's membership; a shared definition still referenced by
 * another scene survives. Response 200: { encounter } (the updated record,
 * or null if the id was already gone -- a safe, idempotent no-op).
 *
 * ---------------------------------------------------------------------------
 * SECURITY (every route above, per review-ui/test/routes.test.mjs's own
 * established convention, extended here -- not a new convention invented):
 * ---------------------------------------------------------------------------
 *   - A path-traversal-shaped `world` id is rejected with 400 ("Invalid
 *     world id"), never silently resolved into a file path.
 *   - A client-supplied `dataDir` is NEVER honored by any route here --
 *     resolveDir() is parameterless everywhere a dataDir would matter; these
 *     routes in particular never even touch a live WF snapshot at all
 *     (saved-encounter.mjs is a standalone store), so there is no dataDir
 *     concept for a client to smuggle in the first place -- covered instead
 *     by a "the client-supplied field is silently ignored" style check.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-scene-planning-encounters-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_SCENE_UNDO_DIR = join(scratchDir, "scene-undo");
process.env.GM_TOOLS_SAVED_ENCOUNTERS_DIR = join(scratchDir, "saved-encounters");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "scene-planning-encounters-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../server.mjs");
const { createScene } = await import("../../session-planner/scenes.mjs");
const { getSavedEncounter } = await import("../../combat-planning/saved-encounter.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "enc-anchor", name: "Anchor Town", type: "place", importance: 0.6 } }
]);

let scene;
let server;
let base;

before(async () => {
  scene = createScene(WORLD, { locationEntityId: "enc-anchor" });
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
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}
async function deleteJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

// ------------------------------------------------------------ functional flow

test("POST /api/scene-planning/scenes/:id/encounters saves a real encounter, persisted via saved-encounter.mjs directly", async () => {
  const { status, body } = await postJson(`/api/scene-planning/scenes/${scene.id}/encounters`, {
    world: WORLD,
    name: "Ambush",
    combination: [{ entryId: "wolf-1", count: 3 }],
    knobs: { minionRules: false },
    scoreSnapshot: { expectedScore: 30, burstCeiling: 5, snowballDelta: {}, asymmetricRiskFlag: false }
  });
  assert.equal(status, 200);
  assert.ok(body.encounter?.id);
  assert.deepEqual(body.encounter.sceneIds, [scene.id]); // Phase 27: encounters are shared multi-scene definitions (sceneIds[])
  assert.equal(body.encounter.name, "Ambush");
  assert.deepEqual(body.encounter.combination, [{ entryId: "wolf-1", count: 3 }]);

  // Confirm the route is a THIN wrapper -- the same record is directly
  // readable through the underlying store module, not some route-local copy.
  const direct = getSavedEncounter(WORLD, body.encounter.id);
  assert.deepEqual(direct, body.encounter);
});

test("POST /api/scene-planning/scenes/:id/encounters defaults name when omitted", async () => {
  const { status, body } = await postJson(`/api/scene-planning/scenes/${scene.id}/encounters`, {
    world: WORLD,
    combination: []
  });
  assert.equal(status, 200);
  assert.equal(body.encounter.name, "Encounter");
});

test("GET /api/scene-planning/scenes/:id/encounters lists only that scene's saved encounters", async () => {
  const otherScene = createScene(WORLD, { locationEntityId: "enc-anchor" });
  await postJson(`/api/scene-planning/scenes/${otherScene.id}/encounters`, { world: WORLD, name: "Other Scene's Fight", combination: [] });

  const { status, body } = await getJson(`/api/scene-planning/scenes/${scene.id}/encounters?world=${WORLD}`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.encounters));
  assert.ok(body.encounters.every((e) => e.sceneIds.includes(scene.id))); // Phase 27: membership via sceneIds[]
  assert.ok(body.encounters.some((e) => e.name === "Ambush"));
  assert.ok(!body.encounters.some((e) => e.name === "Other Scene's Fight"));
});

test("DELETE /api/scene-planning/scenes/:id/encounters/:encounterId removes it, then it's gone from the list", async () => {
  const created = await postJson(`/api/scene-planning/scenes/${scene.id}/encounters`, { world: WORLD, name: "To Delete", combination: [] });
  const encounterId = created.body.encounter.id;

  const del = await deleteJson(`/api/scene-planning/scenes/${scene.id}/encounters/${encounterId}`, { world: WORLD });
  assert.equal(del.status, 200);
  assert.equal(del.body.encounter.id, encounterId);

  const { body } = await getJson(`/api/scene-planning/scenes/${scene.id}/encounters?world=${WORLD}`);
  assert.ok(!body.encounters.some((e) => e.id === encounterId));
});

test("DELETE /api/scene-planning/scenes/:id/encounters/:encounterId on an already-removed id is a safe no-op, echoes null, not an error", async () => {
  const { status, body } = await deleteJson(`/api/scene-planning/scenes/${scene.id}/encounters/never-existed`, { world: WORLD });
  assert.equal(status, 200);
  assert.equal(body.encounter, null);
});

// -------------------------------------------------------------------- SECURITY

const MALICIOUS_WORLD = "../../../../etc";

test("SECURITY: POST /api/scene-planning/scenes/:id/encounters rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await postJson(`/api/scene-planning/scenes/${scene.id}/encounters`, {
    world: MALICIOUS_WORLD,
    combination: []
  });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: GET /api/scene-planning/scenes/:id/encounters rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await getJson(`/api/scene-planning/scenes/${scene.id}/encounters?world=${encodeURIComponent(MALICIOUS_WORLD)}`);
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: DELETE /api/scene-planning/scenes/:id/encounters/:encounterId rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await deleteJson(`/api/scene-planning/scenes/${scene.id}/encounters/x`, { world: MALICIOUS_WORLD });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: a client-supplied dataDir is never honored by POST /api/scene-planning/scenes/:id/encounters -- resolves from server-side env config regardless (and this route has no snapshot/dataDir concept at all to begin with)", async () => {
  const { status, body } = await postJson(`/api/scene-planning/scenes/${scene.id}/encounters`, {
    world: WORLD,
    dataDir: "../../../etc",
    name: "Dir Ignored",
    combination: []
  });
  assert.equal(status, 200, "must still succeed, completely ignoring the bogus client-supplied dataDir field");
  assert.equal(body.encounter.name, "Dir Ignored");

  // Prove the bogus dataDir had zero effect: the record is readable back
  // through the SAME server-side-resolved store, not some other location.
  const direct = getSavedEncounter(WORLD, body.encounter.id);
  assert.ok(direct, "the saved record must be reachable via the real, server-side-resolved saved-encounters store");
});

test("SECURITY: a client-supplied dataDir is never honored by GET /api/scene-planning/scenes/:id/encounters -- resolves from server-side env config regardless", async () => {
  const { status, body } = await getJson(
    `/api/scene-planning/scenes/${scene.id}/encounters?world=${WORLD}&dataDir=${encodeURIComponent("../../../etc")}`
  );
  assert.equal(status, 200, "must still succeed against the REAL configured store, completely ignoring the bogus client-supplied one");
  assert.ok(Array.isArray(body.encounters));
});

console.log("scene-planning-encounters-routes.test.mjs: done");
