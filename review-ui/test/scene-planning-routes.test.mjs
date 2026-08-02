import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — Phase 22 task 22.7's new `review-ui/server.mjs`
 * routes, wrapping session-planner/scene-linkage.mjs (22.1),
 * session-planner/transit-entity.mjs (22.2), session-planner/
 * scene-membership.mjs (22.3), mutation-engine/scene-undo.mjs (22.4),
 * mutation-engine/scene-develop.mjs (22.5), mutation-engine/quick-gen.mjs
 * (22.6). NONE of this exists yet -- expected to fail (a 404 "No route ..."
 * response where a real 200 status/body was asserted, matching
 * review-ui/test/session-planner-routes.test.mjs's own established
 * "expected to fail with a 404 unknown-route response" convention for this
 * exact situation) until 22.7 lands.
 *
 * Placed in review-ui/test/ (not wf-mcp-server/test/) to match where
 * session-planner-routes.test.mjs/combat-planning-routes.test.mjs/
 * routes.test.mjs actually live. Real HTTP requests via fetch() against an
 * in-process server.listen(0), same pattern as those sibling files.
 *
 * PREFIX CONVENTION (pinned): `/api/scene-planning/*` -- matching
 * session-planner's own `/api/session-planner/*` and combat-planning's own
 * `/api/combat-planning/*` precedent exactly, one segment per feature area.
 *
 * ---------------------------------------------------------------------------
 * GET /api/scene-planning/linkage?world=&sceneId=&maxHops=
 * ---------------------------------------------------------------------------
 * Thin wrapper: loads the live snapshot (resolveDir(), no client override)
 * then calls session-planner/scene-linkage.mjs's
 * linkedScenesForScene(w, sceneId, {entities,edges}, {maxHops: Number(maxHops)||undefined}).
 * Response 200: { linked: [...] }.
 *
 * ---------------------------------------------------------------------------
 * POST /api/scene-planning/transit-entity   { world, fromEntityId, toEntityId, name? }
 * ---------------------------------------------------------------------------
 * Thin wrapper over session-planner/transit-entity.mjs's
 * createTransitEntity(dir, w, {fromEntityId, toEntityId, name}). Response
 * 200: { entity: { entityId, name, type:"place", isTransit:true } }.
 *
 * ---------------------------------------------------------------------------
 * POST /api/scene-planning/scenes/:sceneId/members   { world, entityId }
 * ---------------------------------------------------------------------------
 * Thin wrapper over session-planner/scene-membership.mjs's
 * addNodeToScene(w, sceneId, entityId). Response 200: { membership }.
 *
 * ---------------------------------------------------------------------------
 * DELETE /api/scene-planning/scenes/:sceneId/members/:entityId   { world } (query or body, matching /api/graph/nodes/:id's own established convention)
 * ---------------------------------------------------------------------------
 * Thin wrapper over removeNodeFromScene(w, sceneId, entityId). Response
 * 200: { membership }.
 *
 * ---------------------------------------------------------------------------
 * GET /api/scene-planning/scenes/:sceneId/intervening-offer?world=&targetEntityId=
 * ---------------------------------------------------------------------------
 * Loads the scene (getScene, for its anchor/locationEntityId) and the live
 * snapshot, then wraps scene-membership.mjs's offerInterveningNodes(entities,
 * edges, scene.locationEntityId, targetEntityId). Response 200: { offer:
 * {reachable, interveningEntityIds} }.
 *
 * ---------------------------------------------------------------------------
 * POST /api/scene-planning/scenes/:sceneId/undo/start   { world }
 * GET  /api/scene-planning/scenes/:sceneId/undo?world=            (peek/list)
 * POST /api/scene-planning/scenes/:sceneId/undo/record  { world, action }
 * POST /api/scene-planning/scenes/:sceneId/undo/last    { world }
 * POST /api/scene-planning/scenes/:sceneId/undo/all     { world }
 * POST /api/scene-planning/scenes/:sceneId/undo/clear   { world }
 * ---------------------------------------------------------------------------
 * Thin wrappers over mutation-engine/scene-undo.mjs's
 * startSceneUndoSession/listSceneUndoActions/recordSceneUndoAction/
 * undoLastSceneAction/undoAllSceneActions/clearSceneUndoSession
 * respectively. Responses 200: {session}/{actions}/{session}/{action}/
 * {actions}/{ok:true}.
 *
 * ---------------------------------------------------------------------------
 * POST /api/scene-planning/scenes/:sceneId/develop   { world, memberEntityIds, selections?, reframeMemberIds?, priorRoundCounts? }
 * ---------------------------------------------------------------------------
 * Thin wrapper over mutation-engine/scene-develop.mjs's developScene(dir, w,
 * sceneId, memberEntityIds, {selections, reframeMemberIds, priorRoundCounts}).
 * Makes real LLM calls transitively (via prep-content-ops.mjs), so
 * (matching this project's established test/smoke split for every other
 * LLM-touching route) this file only exercises this route's SECURITY
 * behavior, not a real successful develop round trip (that belongs in a
 * companion *.smoke.mjs, not here).
 *
 * ---------------------------------------------------------------------------
 * POST /api/scene-planning/quick-gen   { world, prompt }
 * ---------------------------------------------------------------------------
 * Thin wrapper over mutation-engine/quick-gen.mjs's quickGenerate(prompt,
 * {}). Makes a real LLM call -- SECURITY-only coverage here, same reasoning
 * as the develop route above.
 *
 * ---------------------------------------------------------------------------
 * SECURITY (every route above, per review-ui/test/routes.test.mjs's own
 * established convention -- extended to cover these new routes, not a new
 * convention invented):
 * ---------------------------------------------------------------------------
 *   - A path-traversal-shaped `world` id is rejected with 400 ("Invalid
 *     world id"), never silently resolved into a file path -- checked
 *     BEFORE any LLM call is ever made for the develop/quick-gen routes.
 *   - A client-supplied `dataDir` is NEVER honored by any route here --
 *     every route resolves dataDir (where it needs one at all) from
 *     server-side env config (resolveDir() with no argument), exactly like
 *     every existing route.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-scene-planning-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_SCENE_MEMBERSHIP_DIR = join(scratchDir, "scene-membership");
process.env.GM_TOOLS_SCENE_UNDO_DIR = join(scratchDir, "scene-undo");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "scene-planning-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../server.mjs");
const { createScene } = await import("../../session-planner/scenes.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "sp-anchor", name: "Anchor Town", type: "place", importance: 0.6 } },
  { op: "upsert_entity", data: { id: "sp-mid", name: "Waypoint", type: "place", importance: 0.4 } },
  { op: "upsert_entity", data: { id: "sp-target", name: "Far Keep", type: "place", importance: 0.5 } },
  { op: "upsert_edge", data: { id: "sp-e1", sourceId: "sp-anchor", targetId: "sp-mid", relationshipType: "unspecified" } },
  { op: "upsert_edge", data: { id: "sp-e2", sourceId: "sp-mid", targetId: "sp-target", relationshipType: "unspecified" } }
]);

let anchoredScene;
let server;
let base;

before(async () => {
  anchoredScene = createScene(WORLD, { locationEntityId: "sp-anchor" });
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

test("GET /api/scene-planning/linkage returns linked scenes for a valid scene", async () => {
  const other = createScene(WORLD, { locationEntityId: "sp-mid" });
  const { status, body } = await getJson(`/api/scene-planning/linkage?world=${WORLD}&sceneId=${anchoredScene.id}`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.linked));
  assert.ok(body.linked.some((l) => l.sceneId === other.id));
});

test("POST /api/scene-planning/transit-entity creates a real place entity with attributes.isTransit", async () => {
  const { status, body } = await postJson("/api/scene-planning/transit-entity", {
    world: WORLD,
    fromEntityId: "sp-anchor",
    toEntityId: "sp-target",
    name: "The Old Toll Road"
  });
  assert.equal(status, 200);
  assert.ok(body.entity?.entityId);
  assert.equal(body.entity.type, "place");
  assert.equal(body.entity.isTransit, true);
});

test("POST /api/scene-planning/scenes/:id/members adds a node, GET intervening-offer reports the real intervening path", async () => {
  const add = await postJson(`/api/scene-planning/scenes/${anchoredScene.id}/members`, { world: WORLD, entityId: "sp-target" });
  assert.equal(add.status, 200);
  assert.ok(add.body.membership.entityIds.includes("sp-target"));

  const offer = await getJson(`/api/scene-planning/scenes/${anchoredScene.id}/intervening-offer?world=${WORLD}&targetEntityId=sp-target`);
  assert.equal(offer.status, 200);
  assert.equal(offer.body.offer.reachable, true);
  assert.deepEqual(offer.body.offer.interveningEntityIds, ["sp-mid"]);
});

test("DELETE /api/scene-planning/scenes/:id/members/:entityId removes a node", async () => {
  await postJson(`/api/scene-planning/scenes/${anchoredScene.id}/members`, { world: WORLD, entityId: "sp-to-remove" });
  const { status, body } = await deleteJson(`/api/scene-planning/scenes/${anchoredScene.id}/members/sp-to-remove`, { world: WORLD });
  assert.equal(status, 200);
  assert.ok(!body.membership.entityIds.includes("sp-to-remove"));
});

test("scene-undo session routes: start -> record -> peek -> last -> clear, real HTTP round trip", async () => {
  const start = await postJson(`/api/scene-planning/scenes/${anchoredScene.id}/undo/start`, { world: WORLD });
  assert.equal(start.status, 200);
  assert.deepEqual(start.body.session.actions, []);

  const record = await postJson(`/api/scene-planning/scenes/${anchoredScene.id}/undo/record`, {
    world: WORLD,
    action: { kind: "edit_node", description: "test action", graphMutations: [{ op: "discard_prep_content", entityId: "sp-target" }] }
  });
  assert.equal(record.status, 200);

  const peek = await getJson(`/api/scene-planning/scenes/${anchoredScene.id}/undo?world=${WORLD}`);
  assert.equal(peek.status, 200);
  assert.equal(peek.body.actions.length, 1);

  const last = await postJson(`/api/scene-planning/scenes/${anchoredScene.id}/undo/last`, { world: WORLD });
  assert.equal(last.status, 200);
  assert.equal(last.body.action.description, "test action");

  const clear = await postJson(`/api/scene-planning/scenes/${anchoredScene.id}/undo/clear`, { world: WORLD });
  assert.equal(clear.status, 200);
});

// -------------------------------------------------------------------- SECURITY

const MALICIOUS_WORLD = "../../../../etc";

test("SECURITY: GET /api/scene-planning/linkage rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await getJson(`/api/scene-planning/linkage?world=${encodeURIComponent(MALICIOUS_WORLD)}&sceneId=x`);
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: POST /api/scene-planning/transit-entity rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await postJson("/api/scene-planning/transit-entity", { world: MALICIOUS_WORLD, fromEntityId: "a", toEntityId: "b" });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: POST /api/scene-planning/scenes/:id/members rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await postJson(`/api/scene-planning/scenes/${anchoredScene.id}/members`, { world: MALICIOUS_WORLD, entityId: "x" });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: DELETE /api/scene-planning/scenes/:id/members/:entityId rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await deleteJson(`/api/scene-planning/scenes/${anchoredScene.id}/members/x`, { world: MALICIOUS_WORLD });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: GET /api/scene-planning/scenes/:id/intervening-offer rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await getJson(`/api/scene-planning/scenes/${anchoredScene.id}/intervening-offer?world=${encodeURIComponent(MALICIOUS_WORLD)}&targetEntityId=x`);
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: POST /api/scene-planning/scenes/:id/undo/start rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await postJson(`/api/scene-planning/scenes/${anchoredScene.id}/undo/start`, { world: MALICIOUS_WORLD });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: GET /api/scene-planning/scenes/:id/undo rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await getJson(`/api/scene-planning/scenes/${anchoredScene.id}/undo?world=${encodeURIComponent(MALICIOUS_WORLD)}`);
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: POST /api/scene-planning/scenes/:id/undo/record rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await postJson(`/api/scene-planning/scenes/${anchoredScene.id}/undo/record`, { world: MALICIOUS_WORLD, action: {} });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: POST /api/scene-planning/scenes/:id/undo/last rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await postJson(`/api/scene-planning/scenes/${anchoredScene.id}/undo/last`, { world: MALICIOUS_WORLD });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: POST /api/scene-planning/scenes/:id/undo/all rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await postJson(`/api/scene-planning/scenes/${anchoredScene.id}/undo/all`, { world: MALICIOUS_WORLD });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: POST /api/scene-planning/scenes/:id/undo/clear rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await postJson(`/api/scene-planning/scenes/${anchoredScene.id}/undo/clear`, { world: MALICIOUS_WORLD });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: POST /api/scene-planning/scenes/:id/develop rejects a path-traversal-shaped world id with 400, checked BEFORE any LLM call is ever made", async () => {
  const { status, body } = await postJson(`/api/scene-planning/scenes/${anchoredScene.id}/develop`, { world: MALICIOUS_WORLD, memberEntityIds: ["x"] });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: POST /api/scene-planning/quick-gen rejects a path-traversal-shaped world id with 400, checked BEFORE any LLM call is ever made", async () => {
  const { status, body } = await postJson("/api/scene-planning/quick-gen", { world: MALICIOUS_WORLD, prompt: "x" });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: a client-supplied dataDir is never honored by GET /api/scene-planning/linkage -- resolves from server-side env config regardless", async () => {
  const { status, body } = await getJson(
    `/api/scene-planning/linkage?world=${WORLD}&sceneId=${anchoredScene.id}&dataDir=${encodeURIComponent("../../../etc")}`
  );
  assert.equal(status, 200, "must still succeed against the REAL configured dataDir, completely ignoring the bogus client-supplied one");
  assert.ok(Array.isArray(body.linked));
});

test("SECURITY: a client-supplied dataDir is never honored by POST /api/scene-planning/transit-entity -- resolves from server-side env config regardless", async () => {
  const { status, body } = await postJson("/api/scene-planning/transit-entity", {
    world: WORLD,
    dataDir: "../../../etc",
    fromEntityId: "sp-anchor",
    toEntityId: "sp-mid"
  });
  assert.equal(status, 200, "must still succeed against the REAL configured dataDir, completely ignoring the bogus client-supplied one");
  assert.ok(body.entity?.entityId);
});
