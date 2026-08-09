import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — Phase 36 task 36.2, the quiet-push composer's
 * server-side wiring: `POST /api/session-planner/scenes/:id/stage` (§2) and
 * the FIRST of the two flush triggers, the debounced staged-scene-mutation
 * trigger (§5) -- `scheduleFlush`/`flushScheduled`, review-ui/server.mjs.
 * The 9 phase36 e2e reds deliberately exercise the SECOND trigger only
 * (`POST /api/foundry/sync-now`, since the debounced trigger has no
 * synchronous completion point a test can await from outside) -- this file
 * closes that gap deterministically: staging a scene (or dropping into an
 * already-staged one's tray) with NO explicit sync-now call must still
 * produce a written ops-channel batch, a short real-time tick later.
 *
 * Real HTTP requests via fetch() against an in-process server.listen(0),
 * same pattern as review-ui/test/scene-tray-routes.test.mjs.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-foundry-stage-flush-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
process.env.GM_TOOLS_ITEM_DIR = join(scratchDir, "items");
process.env.GM_TOOLS_STAGECRAFT_DIR = join(scratchDir, "stagecraft");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_SCENE_ELEMENTS_DIR = join(scratchDir, "scene-elements");
process.env.GM_TOOLS_SCENE_TRAY_DIR = join(scratchDir, "scene-tray");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "foundry-stage-flush-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath, foundryOpsPath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../server.mjs");
const { createScene, getScene } = await import("../../session-planner/scenes.mjs");
const { saveStagecraftAsset, acceptStagecraftAsset } = await import("../../session-planner/stagecraft-store.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

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

function readOps(world) {
  const path = foundryOpsPath(dataDir, world);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (!raw || raw === "[]") return [];
  return JSON.parse(raw);
}

async function waitUntil(predicate, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// §2 -- the stage route itself
// ---------------------------------------------------------------------------

test("POST /api/session-planner/scenes/:id/stage {staged:true} -> {scene} with stagedForFoundry:true, lastPushedAt:null", async () => {
  const scene = createScene(WORLD, { objectiveNote: "Route test" }, { makeId: () => "stage-route-1" });
  const { status, body } = await postJson(`/api/session-planner/scenes/${scene.id}/stage`, { world: WORLD, staged: true });
  assert.equal(status, 200);
  assert.equal(body.scene.stagedForFoundry, true);
  assert.equal(body.scene.lastPushedAt, null);
});

test("POST .../stage {staged:false} un-stages a previously-staged scene", async () => {
  const scene = createScene(WORLD, {}, { makeId: () => "stage-route-2" });
  await postJson(`/api/session-planner/scenes/${scene.id}/stage`, { world: WORLD, staged: true });
  const { body } = await postJson(`/api/session-planner/scenes/${scene.id}/stage`, { world: WORLD, staged: false });
  assert.equal(body.scene.stagedForFoundry, false);
});

test("POST .../stage on an unknown sceneId -> 400 with 'No scene found' (this project's REAL, established scene-route-error convention)", async () => {
  const { status, body } = await postJson("/api/session-planner/scenes/does-not-exist-stage/stage", { world: WORLD, staged: true });
  assert.equal(status, 400);
  assert.match(body.error, /No scene found/);
});

// ---------------------------------------------------------------------------
// §5 -- the DEBOUNCED auto-flush trigger (no sync-now call anywhere below)
// ---------------------------------------------------------------------------

test("staging a scene with an already-eligible map asset in its tray triggers a QUIET background flush -- no sync-now call needed", async () => {
  // Own world -- once the debounced flush writes an ops batch, nothing in
  // this suite ever clears it back to "[]" (no fake watcher armed), so a
  // SHARED world across these auto-flush tests would 409 on the second
  // one's own trigger (writeOpsFileChecked sees the first test's stale
  // batch still sitting there). Same isolation reasoning as
  // phase36-flush-ops-shapes.e2e.mjs's own separate-world 409 test.
  const autoflushWorld = "foundry-stage-flush-autoflush-world-1";
  const scene = createScene(autoflushWorld, { objectiveNote: "Auto-flush trigger test" }, { makeId: () => "stage-route-autoflush-1" });
  const asset = acceptStagecraftAsset(
    autoflushWorld,
    saveStagecraftAsset(autoflushWorld, { kind: "map", name: "Auto-Flush Map", source: "foundry", foundryRef: { imagePath: "scenes/auto-flush.webp" }, status: "proposed" }, { makeId: () => "sc-autoflush-1" }).id
  );
  await postJson(`/api/scene-planning/scenes/${scene.id}/tray/drop`, { world: autoflushWorld, kind: "asset", id: asset.id });

  // Staging is itself the trigger (no scene-record write after this touches
  // the tray again) -- the debounced flush must fire on ITS OWN, one
  // macrotask later, with no further action from this test.
  await postJson(`/api/session-planner/scenes/${scene.id}/stage`, { world: autoflushWorld, staged: true });

  const flushed = await waitUntil(() => {
    const ops = readOps(autoflushWorld);
    return ops.some((o) => o.kind === "create_scene" && o.data?.name === "Auto-flush trigger test");
  });
  assert.ok(flushed, `expected the debounced background flush to have written a create_scene op with no sync-now call -- ops on disk: ${JSON.stringify(readOps(autoflushWorld))}`);
});

test("a tray drop into an ALREADY-staged scene also triggers the debounced flush (touchSceneSafely's own trigger hook, §3)", async () => {
  const autoflushWorld = "foundry-stage-flush-autoflush-world-2";
  const scene = createScene(autoflushWorld, { objectiveNote: "Already staged, tray-triggered" }, { makeId: () => "stage-route-autoflush-2" });
  await postJson(`/api/session-planner/scenes/${scene.id}/stage`, { world: autoflushWorld, staged: true });

  // The stage call above ALSO triggers its own (empty-roster) flush --
  // without a live Foundry client, nothing ever clears world-fabric-
  // foundry-ops.json back to "[]" on its own, so a SECOND flush attempt
  // would 409 forever unless something plays "Foundry picked it up".
  // Waiting for the poll window to naturally resolve isn't enough (the
  // FILE stays stuck regardless of whether the writer's own await
  // returns) -- simulate the watcher directly: once the first flush's
  // batch lands on disk, clear it back to "[]" ourselves.
  const opsPath = foundryOpsPath(dataDir, autoflushWorld);
  const firstBatchWritten = await waitUntil(() => readOps(autoflushWorld).length > 0);
  assert.ok(firstBatchWritten, "sanity: the stage call's own flush must have written something first");
  writeFileSync(opsPath, "[]", "utf8"); // simulate "Foundry applied + cleared it"

  const asset = acceptStagecraftAsset(
    autoflushWorld,
    saveStagecraftAsset(autoflushWorld, { kind: "map", name: "Second Trigger Map", source: "foundry", foundryRef: { imagePath: "scenes/second-trigger.webp" }, status: "proposed" }, { makeId: () => "sc-autoflush-2" }).id
  );
  await postJson(`/api/scene-planning/scenes/${scene.id}/tray/drop`, { world: autoflushWorld, kind: "asset", id: asset.id });

  const flushed = await waitUntil(() => {
    const ops = readOps(autoflushWorld);
    return ops.some((o) => o.kind === "create_scene" && o.data?.background?.src === "scenes/second-trigger.webp");
  });
  assert.ok(flushed, `expected a tray drop into an already-staged scene to trigger a background flush picking up the new map -- ops on disk: ${JSON.stringify(readOps(autoflushWorld))}`);
});

void __dirname;
