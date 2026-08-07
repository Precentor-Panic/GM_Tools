import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — Phase 32 task 32.3's new review-ui/server.mjs
 * route, a thin wrapper over wf-mcp-server/lib/foundry-push-ops.mjs's
 * pushSceneToFoundry. Real HTTP requests via fetch() against an in-process
 * server.listen(0), same pattern as review-ui/test/foundry-pull-routes.test.mjs
 * (this route's PULL-direction sibling) and session-planner-routes.test.mjs
 * (scene fixture setup convention).
 *
 * ---------------------------------------------------------------------------
 * POST /api/foundry/push-scene   { world, sceneId, mapSrc, name?, width?, height? }
 * ---------------------------------------------------------------------------
 * Response 200 either way: {status:'queued', sceneId, opId, note} or
 * {status:'applied', sceneId, opId, ok, foundryUuid?, scene?, error?}.
 * World-scoped (resolveWorld(body.world)), no client-supplied dataDir
 * honored, `sceneId`/`mapSrc` are required (thrown -> 400 via statusForError,
 * same convention as every other route in this file).
 *
 * The "applied" case here uses a background fake watcher (a setInterval in
 * this test process polling the real ops file) instead of a fixed-opId
 * seed, since the route generates its own opId internally and doesn't take
 * an override over HTTP (unlike the direct-call unit tests in
 * wf-mcp-server/test/foundry-push-ops.test.mjs, which inject a deterministic
 * one) -- it watches for whatever opId the route actually writes, then
 * answers it. It also doesn't expose pollMs/timeoutMs overrides over HTTP
 * (production defaults apply, same as every other Foundry-bridge sync/
 * rollback route in this file), so this fake watcher polls fast (20ms) to
 * reliably beat the route's own first ~500ms poll tick.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-foundry-push-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "foundry-push-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { foundryOpsPath, foundryResultsPath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { createScene, getScene } = await import("../../session-planner/scenes.mjs");
const { createReviewServer } = await import("../server.mjs");

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

async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

function seedFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
}

test("POST /api/foundry/push-scene: real round trip, a fake watcher applies -> ok:true, foundryUuid, scene.foundrySceneRef set, and it round-trips via a fresh getScene read", async () => {
  const scene = createScene(WORLD, { objectiveNote: "Ashwood Ambush Site" });
  const opsPath = foundryOpsPath(dataDir, WORLD);
  const resultsPath = foundryResultsPath(dataDir, WORLD);

  const watcherInterval = setInterval(() => {
    if (!existsSync(opsPath)) return;
    let ops;
    try {
      ops = JSON.parse(readFileSync(opsPath, "utf8"));
    } catch {
      return; // mid-write or already cleared -- try again next tick
    }
    if (Array.isArray(ops) && ops.length && ops[0].kind === "create_scene") {
      clearInterval(watcherInterval);
      seedFile(resultsPath, [{ opId: ops[0].opId, ok: true, foundryUuid: "Scene.route123" }]);
      writeFileSync(opsPath, "[]", "utf8");
    }
  }, 20);

  const { status, body } = await postJson("/api/foundry/push-scene", { world: WORLD, sceneId: scene.id, mapSrc: "scenes/ashwood.webp" });
  clearInterval(watcherInterval);

  assert.equal(status, 200);
  assert.equal(body.status, "applied");
  assert.equal(body.ok, true);
  assert.equal(body.foundryUuid, "Scene.route123");
  assert.equal(body.scene.foundrySceneRef, "Scene.route123");

  const reread = getScene(WORLD, scene.id);
  assert.equal(reread.foundrySceneRef, "Scene.route123");
});

test("POST /api/foundry/push-scene: missing sceneId -> 400", async () => {
  const { status, body } = await postJson("/api/foundry/push-scene", { world: WORLD, mapSrc: "scenes/x.webp" });
  assert.equal(status, 400);
  assert.match(body.error, /sceneId/);
});

test("POST /api/foundry/push-scene: missing mapSrc -> 400", async () => {
  const scene = createScene(WORLD, { objectiveNote: "No map given" });
  const { status, body } = await postJson("/api/foundry/push-scene", { world: WORLD, sceneId: scene.id });
  assert.equal(status, 400);
  assert.match(body.error, /mapSrc/);
});

test("POST /api/foundry/push-scene: unknown sceneId -> 400 (matches the existing getScene error convention, same as every other session-planner route)", async () => {
  const { status, body } = await postJson("/api/foundry/push-scene", { world: WORLD, sceneId: "scene_does_not_exist", mapSrc: "scenes/x.webp" });
  assert.equal(status, 400);
  assert.match(body.error, /No scene found/);
});

test("SECURITY: POST /api/foundry/push-scene rejects a path-traversal-shaped world id with 400 (checked before any file read)", async () => {
  const { status, body } = await postJson("/api/foundry/push-scene", { world: "../../../../etc", sceneId: "whatever", mapSrc: "scenes/x.webp" });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

void __dirname;
