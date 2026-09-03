import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST -- Aureus table wave B1 (G2), the scene LIFECYCLE
 * routes over wf-mcp-server/lib/foundry-push-ops.mjs's new lifecycle
 * exports: activate-scene, remove-scene, the DELETE-route Foundry hook
 * (handleFoundrySceneOnDelete), and the stale-scene sweep (stale-scenes /
 * remove-stale). Real HTTP requests via fetch() against an in-process
 * server.listen(0), same pattern as foundry-push-routes.test.mjs /
 * foundry-stage-and-flush-routes.test.mjs (this feature's siblings).
 *
 * Deliberately does NOT arm a fake Foundry-ops watcher here (unlike
 * foundry-push-routes.test.mjs) -- every case below either fails BEFORE any
 * ops-file write (confirm refusal, no-foundrySceneRef activate, unknown
 * world) or takes the alsoRemoveFromFoundry-absent delete path (orphan
 * capture only, no writeFoundryOps call at all). The "watcher answers and a
 * removal/activation actually applies" happy path is covered by
 * review-ui/test/e2e/scene-lifecycle.e2e.mjs instead, which needs a live
 * server + browser anyway.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-scene-lifecycle-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_FOUNDRY_ORPHANS_DIR = join(scratchDir, "foundry-orphans");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "scene-lifecycle-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { createReviewServer } = await import("../server.mjs");
const { createScene, getScene, updateScene } = await import("../../session-planner/scenes.mjs");

let server, base;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function del(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

// Gives a scene a pushed-looking foundrySceneRef directly (no real Foundry
// bridge round trip needed -- these routes only ever read/write that field
// through the same store updateScene/getScene already use elsewhere).
function pushedScene(overrides = {}) {
  const scene = createScene(WORLD, { objectiveNote: "Lifecycle route test scene" });
  return updateScene(WORLD, scene.id, { foundrySceneRef: "Scene.lifecycle-test-1", stagedForFoundry: true, ...overrides });
}

// ---------------------------------------------------------------------------
// Confirm-refusal 400s
// ---------------------------------------------------------------------------

test("POST /api/foundry/remove-scene without confirm:true -> 400, no Foundry work attempted", async () => {
  const scene = pushedScene();
  const { status, body } = await postJson("/api/foundry/remove-scene", { world: WORLD, sceneId: scene.id });
  assert.equal(status, 400);
  assert.match(body.error, /confirm/i);
  // Untouched -- the ref is still there since nothing ran.
  assert.equal(getScene(WORLD, scene.id).foundrySceneRef, "Scene.lifecycle-test-1");
});

test("POST /api/foundry/remove-scene with confirm:false explicitly -> 400", async () => {
  const scene = pushedScene();
  const { status, body } = await postJson("/api/foundry/remove-scene", { world: WORLD, sceneId: scene.id, confirm: false });
  assert.equal(status, 400);
  assert.match(body.error, /confirm/i);
});

test("POST /api/foundry/remove-stale without confirm:true -> 400", async () => {
  const { status, body } = await postJson("/api/foundry/remove-stale", { world: WORLD, targets: [{ kind: "orphan", id: "orph_x" }] });
  assert.equal(status, 400);
  assert.match(body.error, /confirm/i);
});

test("POST /api/foundry/remove-stale with confirm:true but an empty targets array -> 400", async () => {
  const { status, body } = await postJson("/api/foundry/remove-stale", { world: WORLD, targets: [], confirm: true });
  assert.equal(status, 400);
  assert.match(body.error, /targets/i);
});

test("POST /api/foundry/remove-stale with confirm:true but targets missing entirely -> 400", async () => {
  const { status, body } = await postJson("/api/foundry/remove-stale", { world: WORLD, confirm: true });
  assert.equal(status, 400);
  assert.match(body.error, /targets/i);
});

// ---------------------------------------------------------------------------
// Activate on a never-pushed scene -> clean error status
// ---------------------------------------------------------------------------

test("POST /api/foundry/activate-scene on a scene with no foundrySceneRef -> clean 400, not a crash", async () => {
  const scene = createScene(WORLD, { objectiveNote: "Never pushed" });
  const { status, body } = await postJson("/api/foundry/activate-scene", { world: WORLD, sceneId: scene.id });
  assert.equal(status, 400);
  assert.match(body.error, /foundrySceneRef/);
  assert.match(body.error, /push it to Foundry first/i);
});

test("POST /api/foundry/activate-scene missing sceneId -> 400", async () => {
  const { status, body } = await postJson("/api/foundry/activate-scene", { world: WORLD });
  assert.equal(status, 400);
  assert.match(body.error, /sceneId/);
});

test("POST /api/foundry/remove-scene confirm:true on a scene with no foundrySceneRef -> clean 400 (removeSceneFromFoundry's own guard)", async () => {
  const scene = createScene(WORLD, { objectiveNote: "Never pushed, remove attempt" });
  const { status, body } = await postJson("/api/foundry/remove-scene", { world: WORLD, sceneId: scene.id, confirm: true });
  assert.equal(status, 400);
  assert.match(body.error, /foundrySceneRef/);
});

// ---------------------------------------------------------------------------
// Delete route -- orphan capture (default alsoRemoveFromFoundry:false/absent
// path, no Foundry ops-file round trip needed)
// ---------------------------------------------------------------------------

test("DELETE .../scenes/:id on a pushed scene, no alsoRemoveFromFoundry flag -> foundry:'orphaned', and it shows up in a follow-up stale-scenes GET", async () => {
  const scene = pushedScene({ foundrySceneRef: "Scene.orphan-capture-1" });
  const { status, body } = await del(`/api/session-planner/scenes/${scene.id}`, { world: WORLD });
  assert.equal(status, 200);
  assert.equal(body.deleted, true);
  assert.deepEqual(body.foundry, { foundry: "orphaned" });

  const { status: staleStatus, body: staleBody } = await getJson(`/api/foundry/stale-scenes?world=${WORLD}`);
  assert.equal(staleStatus, 200);
  assert.ok(
    staleBody.orphans.some((o) => o.foundrySceneRef === "Scene.orphan-capture-1"),
    `expected the deleted scene's ref to appear as an orphan -- got: ${JSON.stringify(staleBody.orphans)}`
  );
});

test("DELETE .../scenes/:id on a scene that was never pushed -> foundry:'none', unchanged cascade behavior", async () => {
  const scene = createScene(WORLD, { objectiveNote: "Delete, never pushed" });
  const { status, body } = await del(`/api/session-planner/scenes/${scene.id}`, { world: WORLD });
  assert.equal(status, 200);
  assert.equal(body.deleted, true);
  assert.deepEqual(body.foundry, { foundry: "none" });
});

test("DELETE .../scenes/:id on an unknown sceneId stays idempotent ({deleted:false}) plus foundry:'none' -- byte-identical `deleted` field to pre-G2 behavior", async () => {
  const { status, body } = await del("/api/session-planner/scenes/does-not-exist-lifecycle", { world: WORLD });
  assert.equal(status, 200);
  assert.equal(body.deleted, false);
  assert.deepEqual(body.foundry, { foundry: "none" });
});

// ---------------------------------------------------------------------------
// GET /api/foundry/stale-scenes
// ---------------------------------------------------------------------------

test("GET /api/foundry/stale-scenes on a fresh world -> empty orphans and unstagedWithRef", async () => {
  const freshWorld = "scene-lifecycle-routes-fresh-world";
  const { status, body } = await getJson(`/api/foundry/stale-scenes?world=${freshWorld}`);
  assert.equal(status, 200);
  assert.deepEqual(body.orphans, []);
  assert.deepEqual(body.unstagedWithRef, []);
});

test("GET /api/foundry/stale-scenes lists an unstaged-but-still-pushed scene", async () => {
  const scene = pushedScene({ foundrySceneRef: "Scene.unstaged-with-ref-1", stagedForFoundry: false });
  const { status, body } = await getJson(`/api/foundry/stale-scenes?world=${WORLD}`);
  assert.equal(status, 200);
  assert.ok(
    body.unstagedWithRef.some((s) => s.id === scene.id && s.foundrySceneRef === "Scene.unstaged-with-ref-1"),
    `expected the unstaged pushed scene to appear -- got: ${JSON.stringify(body.unstagedWithRef)}`
  );
});

// ---------------------------------------------------------------------------
// SECURITY: path-traversal-shaped world id -> 400, checked before any file read
// ---------------------------------------------------------------------------

test("SECURITY: POST /api/foundry/activate-scene rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await postJson("/api/foundry/activate-scene", { world: "../../../../etc", sceneId: "whatever" });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: POST /api/foundry/remove-scene rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await postJson("/api/foundry/remove-scene", { world: "../../../../etc", sceneId: "whatever", confirm: true });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: GET /api/foundry/stale-scenes rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await getJson("/api/foundry/stale-scenes?world=../../../../etc");
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: POST /api/foundry/remove-stale rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await postJson("/api/foundry/remove-stale", { world: "../../../../etc", targets: [{ kind: "orphan", id: "x" }], confirm: true });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

void __dirname;
