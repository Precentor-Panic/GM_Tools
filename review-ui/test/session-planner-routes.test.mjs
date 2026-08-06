import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — Phase 16 task 16.6's new review-ui/server.mjs
 * routes, wrapping session-planner/scenes.mjs (16.2), session-planner/
 * brief.mjs (16.5), and session-planner/session-notes.mjs (16.4). None of
 * this exists yet -- expected to fail (a 404 "unknown route" response where
 * a real status/body was asserted, or a thrown error at import time if
 * server.mjs itself doesn't even export the right shape) until 16.6 lands.
 * Placed in review-ui/test/ (not wf-mcp-server/test/) to match where
 * routes.test.mjs actually lives -- session-planner routes are review-ui/
 * server.mjs routes, same as every other route this file's sibling covers.
 *
 * Real HTTP requests via fetch() against an in-process server.listen(0),
 * same pattern as review-ui/test/routes.test.mjs (no subprocess needed).
 *
 * ---------------------------------------------------------------------------
 * POST /api/session-planner/scenes   { world, locationEntityId?, objectiveNote? }
 * ---------------------------------------------------------------------------
 * Thin wrapper over session-planner/scenes.mjs's createScene(world, {
 * locationEntityId, objectiveNote }). Response 200: { scene }.
 *
 * ---------------------------------------------------------------------------
 * POST /api/session-planner/scenes/:id/fork   { world, locationEntityId?, objectiveNote? }
 * ---------------------------------------------------------------------------
 * Thin wrapper over forkScene(world, parts[3] /* the parent scene id from the
 * URL *\/, { locationEntityId, objectiveNote }). Response 200: { scene }.
 *
 * ---------------------------------------------------------------------------
 * GET /api/session-planner/scenes/:id?world=...
 * ---------------------------------------------------------------------------
 * Thin wrapper over getScene(world, parts[3]). Response 200: { scene }.
 *
 * ---------------------------------------------------------------------------
 * GET /api/session-planner/brief?world=...&sceneId=...&corridorTolerance=...
 * ---------------------------------------------------------------------------
 * Loads the scene (getScene) and the live snapshot (loadSnapshot(dir, w) --
 * resolveDir() with NO client-supplied override, same convention as every
 * existing route), then wraps session-planner/brief.mjs's buildSessionBrief(
 * w, snapshot, scene, { corridorTolerance: Number(q.get('corridorTolerance')) || undefined }).
 * Response 200: { brief }.
 *
 * ---------------------------------------------------------------------------
 * POST /api/session-planner/notes   { world, text, anchorEntityId?, sceneId? }
 * ---------------------------------------------------------------------------
 * Thin wrapper over session-planner/session-notes.mjs's captureNote. Response
 * 200: { note }.
 *
 * ---------------------------------------------------------------------------
 * POST /api/session-planner/notes/intake   { world, noteIds }
 * ---------------------------------------------------------------------------
 * Thin wrapper over runBatchIntake(w, noteIds, <live snapshot>, {}) -- makes
 * a real LLM call via proposeMentionedEntities, so (matching this project's
 * established test/smoke split for every other LLM-touching route) this
 * file only exercises this route's SECURITY behavior (malicious world id
 * rejected) deterministically; a real successful intake round trip over
 * HTTP belongs in a companion *.smoke.mjs, not here.
 *
 * ---------------------------------------------------------------------------
 * SECURITY (every route above, per review-ui/test/routes.test.mjs's own
 * established convention -- extended to cover these new routes, not a new
 * convention invented, per task 16.6's own explicit instruction):
 * ---------------------------------------------------------------------------
 *   - A path-traversal-shaped `world` id is rejected with 400 ("Invalid
 *     world id"), never silently resolved into a file path.
 *   - A client-supplied `dataDir` is NEVER honored by any route here --
 *     every route resolves dataDir (where it needs one at all -- only the
 *     brief route touches the live snapshot) from server-side env config
 *     (resolveDir() with no argument), exactly like every existing route.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-session-planner-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_SESSION_NOTES_DIR = join(scratchDir, "session-notes");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "session-planner-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "route-test-home", name: "Route Test Home Base", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "route-test-neighbor", name: "Route Test Neighbor", type: "person", importance: 0.4 } },
  { op: "upsert_edge", data: { sourceId: "route-test-home", targetId: "route-test-neighbor", relationshipType: "presence" } }
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
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

// ------------------------------------------------------------ functional flow

test("POST /api/session-planner/scenes creates a root scene", async () => {
  const { status, body } = await postJson("/api/session-planner/scenes", {
    world: WORLD,
    locationEntityId: "route-test-home",
    objectiveNote: "Find out what's been raiding the caravans."
  });
  assert.equal(status, 200);
  assert.ok(body.scene?.id);
  assert.equal(body.scene.locationEntityId, "route-test-home");
  assert.equal(body.scene.parentSceneId, null);
});

test("GET /api/session-planner/scenes/:id round-trips a created scene", async () => {
  const created = await postJson("/api/session-planner/scenes", { world: WORLD, locationEntityId: "route-test-home" });
  const { status, body } = await getJson(`/api/session-planner/scenes/${created.body.scene.id}?world=${WORLD}`);
  assert.equal(status, 200);
  assert.equal(body.scene.id, created.body.scene.id);
});

test("POST /api/session-planner/scenes/:id/fork carries forward the parent's location/objective metadata", async () => {
  const parent = await postJson("/api/session-planner/scenes", {
    world: WORLD,
    locationEntityId: "route-test-home",
    objectiveNote: "Investigate the missing shipment."
  });
  const { status, body } = await postJson(`/api/session-planner/scenes/${parent.body.scene.id}/fork`, { world: WORLD });
  assert.equal(status, 200);
  assert.equal(body.scene.parentSceneId, parent.body.scene.id);
  assert.equal(body.scene.locationEntityId, "route-test-home", "carried forward from the parent, not overridden");
  assert.equal(body.scene.objectiveNote, "Investigate the missing shipment.");
});

test("POST /api/session-planner/notes captures a note with zero ceremony", async () => {
  const { status, body } = await postJson("/api/session-planner/notes", {
    world: WORLD,
    text: "The neighbor mentioned strange lights at night.",
    anchorEntityId: "route-test-neighbor"
  });
  assert.equal(status, 200);
  assert.ok(body.note?.id);
  assert.equal(body.note.consumed, false);
});

test("GET /api/session-planner/brief returns a real brief for the created scene, with the notes attached", async () => {
  const scene = await postJson("/api/session-planner/scenes", { world: WORLD, locationEntityId: "route-test-home" });
  await postJson("/api/session-planner/notes", { world: WORLD, text: "A note anchored right at home base.", anchorEntityId: "route-test-home" });

  const { status, body } = await getJson(`/api/session-planner/brief?world=${WORLD}&sceneId=${scene.body.scene.id}&corridorTolerance=1`);
  assert.equal(status, 200);
  assert.equal(body.brief.sceneId, scene.body.scene.id);
  const locationIds = body.brief.locations.map((l) => l.entityId);
  assert.ok(locationIds.includes("route-test-home"));
  assert.ok(locationIds.includes("route-test-neighbor"), "the one-hop neighbor must be picked up by the corridor traversal");
});

// ---------------------------------------------------------------------------
// Phase 30 task 30.1 -- place-type guard on POST /api/session-planner/scenes:
// the World "create a scene here" affordance should only ever anchor a
// scene to a "place" node. scenes.mjs's own createScene stays pure (no
// graph access) -- the type lookup happens at the route layer.
// ---------------------------------------------------------------------------

test("POST /api/session-planner/scenes: a place locationEntityId is allowed through unchanged", async () => {
  const { status, body } = await postJson("/api/session-planner/scenes", { world: WORLD, locationEntityId: "route-test-home" });
  assert.equal(status, 200);
  assert.equal(body.scene.locationEntityId, "route-test-home");
});

test("POST /api/session-planner/scenes: no locationEntityId at all is allowed through unchanged (untethered scene)", async () => {
  const { status, body } = await postJson("/api/session-planner/scenes", { world: WORLD });
  assert.equal(status, 200);
  assert.equal(body.scene.locationEntityId, null);
});

test("POST /api/session-planner/scenes: a non-place locationEntityId is rejected with a clear 4xx error, not silently allowed", async () => {
  const { status, body } = await postJson("/api/session-planner/scenes", { world: WORLD, locationEntityId: "route-test-neighbor" });
  assert.ok(status >= 400 && status < 500, `expected a 4xx status, got ${status}`);
  assert.match(body.error, /place/i);
  assert.match(body.error, /route-test-neighbor/);
});

test("POST /api/session-planner/scenes: an UNKNOWN locationEntityId (not in the live snapshot at all) is still allowed through -- the guard only fires when the entity actually exists with a non-place type", async () => {
  const { status, body } = await postJson("/api/session-planner/scenes", { world: WORLD, locationEntityId: "totally-unknown-entity-id" });
  assert.equal(status, 200);
  assert.equal(body.scene.locationEntityId, "totally-unknown-entity-id");
});

// -------------------------------------------------------------------- SECURITY

test("SECURITY: POST /api/session-planner/scenes rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await postJson("/api/session-planner/scenes", { world: "../../../../etc", locationEntityId: "x" });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: POST /api/session-planner/scenes/:id/fork rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await postJson("/api/session-planner/scenes/some-id/fork", { world: "../../../../etc" });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: GET /api/session-planner/scenes/:id rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await getJson(`/api/session-planner/scenes/some-id?world=${encodeURIComponent("../../../../etc")}`);
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: GET /api/session-planner/brief rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await getJson(`/api/session-planner/brief?world=${encodeURIComponent("../../../../etc")}&sceneId=x`);
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: POST /api/session-planner/notes rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await postJson("/api/session-planner/notes", { world: "../../../../etc", text: "x" });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: POST /api/session-planner/notes/intake rejects a path-traversal-shaped world id with 400 (checked before any LLM call is ever made)", async () => {
  const { status, body } = await postJson("/api/session-planner/notes/intake", { world: "../../../../etc", noteIds: ["x"] });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: a client-supplied dataDir is never honored by GET /api/session-planner/brief -- resolves from server-side env config regardless", async () => {
  const scene = await postJson("/api/session-planner/scenes", { world: WORLD, locationEntityId: "route-test-home" });
  const { status, body } = await getJson(
    `/api/session-planner/brief?world=${WORLD}&sceneId=${scene.body.scene.id}&dataDir=${encodeURIComponent("../../../etc")}`
  );
  assert.equal(status, 200, "must still succeed against the REAL configured dataDir, completely ignoring the bogus client-supplied one");
  assert.ok(body.brief.locations.some((l) => l.entityId === "route-test-home"), "must resolve the REAL fixture world's real data, not error out or silently use the bogus path");
});

void __dirname;
