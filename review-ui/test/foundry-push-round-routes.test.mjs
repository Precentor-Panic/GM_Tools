import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — the push round's route surface (2026-10-07).
 *
 *   POST /api/foundry/flush-scenes          { world, sceneIds? }
 *   POST /api/foundry/refresh-scene-tokens  { world, sceneId }
 *   POST /api/foundry/sync-to-plans         { world, planIds, confirm?, force? }
 *
 * The first two are new. The third is NOT — it has shipped for a while and
 * has never had a route test at all, which is part of why the "it re-creates
 * the scenes it just deleted" defect survived: the only coverage was a
 * direct-call test using a clean scene, so its trailing flush never ran.
 *
 * Why `flush-scenes` exists: `push-scene` is a bare map-and-music path that
 * composes NO token ops, and it was what bin/foundry-push called. That is
 * the direct cause of session three landing with eight empty scenes. Scene
 * pushes go through composeSceneOps, which only flushDirtyStagedScenes
 * calls, so this is the route that carries a tray.
 *
 * Real HTTP against an in-process server.listen(0), real stores, a
 * background fake watcher standing in for Foundry — the established pattern
 * from foundry-push-routes.test.mjs.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-push-round-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_STAGECRAFT_DIR = join(scratchDir, "stagecraft");
process.env.GM_TOOLS_SCENE_TRAY_DIR = join(scratchDir, "scene-tray");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "push-round-routes-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { foundryOpsPath, foundryResultsPath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { createScene, getScene, updateScene, markScenePushed } = await import("../../session-planner/scenes.mjs");
const { createPlan, addSceneToPlan } = await import("../../session-planner/plans.mjs");
const { addToSceneTray } = await import("../../session-planner/scene-tray.mjs");
const { saveStagecraftAsset, acceptStagecraftAsset } = await import("../../session-planner/stagecraft-store.mjs");
const { saveBestiaryEntry, acceptBestiaryEntry, setBestiaryTokenImg, setBestiaryFoundryActorRef } = await import("../../combat-planning/bestiary-store.mjs");
const { createReviewServer } = await import("../server.mjs");

let server, base, watcher;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  clearInterval(watcher);
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

function seedFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
}

/** Answers every op in the file, then clears it. Fast enough to beat the routes' own ~500ms first tick. */
function armWatcher(world, { uuidFor = (op) => `Scene.${op.opId}` } = {}) {
  const opsPath = foundryOpsPath(dataDir, world);
  const resultsPath = foundryResultsPath(dataDir, world);
  clearInterval(watcher);
  watcher = setInterval(() => {
    if (!existsSync(opsPath)) return;
    let ops;
    try { ops = JSON.parse(readFileSync(opsPath, "utf8")); } catch { return; }
    if (!Array.isArray(ops) || !ops.length) return;
    const prior = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8") || "[]") : [];
    seedFile(resultsPath, [...prior, ...ops.map((o) => ({ opId: o.opId, ok: true, foundryUuid: uuidFor(o) }))]);
    writeFileSync(opsPath, "[]", "utf8");
  }, 20);
}

// A world per test. The swap route legitimately removes EVERY pushed scene
// that is not in the named plan, so a shared world makes one test's leftovers
// another test's remove set -- pollution that reads as a product bug.
let worldSeq = 0;
function freshWorld() { return `${WORLD}-${++worldSeq}`; }

function stagedScene(world, name) {
  const asset = saveStagecraftAsset(world, { kind: "map", name: `${name} map`, src: `scenes/${name.replace(/\W+/g, "-")}.webp`, provenance: "local" });
  acceptStagecraftAsset(world, asset.id);
  const s = createScene(world, { objectiveNote: name });
  updateScene(world, s.id, { name, stagedForFoundry: true, mapAssetId: asset.id });
  return getScene(world, s.id);
}

test("POST /api/foundry/flush-scenes: pushes a staged scene WITH its tray tokens, and sceneIds scopes it", async () => {
  const W = freshWorld();
  const wanted = stagedScene(W, "Wanted scene");
  const other = stagedScene(W, "Other staged scene");

  const entry = saveBestiaryEntry({ world: W, rawFields: { name: "A collector", ac: 13, hp: 11 }, provenance: { source: "hand" } });
  acceptBestiaryEntry(entry.id);
  setBestiaryFoundryActorRef(entry.id, "Actor.COLLECTOR");
  setBestiaryTokenImg(entry.id, "gm-tools/tokens/x/collector.webp");
  addToSceneTray(W, wanted.id, { kind: "creature", id: entry.id });

  // Capture what actually went down the wire before the watcher clears it.
  // Create-path tokens ride INSIDE the create_scene op as `data.tokens[]`,
  // not as separate create_token ops -- the module's create_token creator
  // resolves sceneUuid via fromUuid() and cannot accept a correlation id for
  // a scene that does not exist yet, so the contract puts them inline and
  // Foundry batch-places them after Scene.create.
  const opsPath = foundryOpsPath(dataDir, W);
  let tokensOnWire = null;
  const sniff = setInterval(() => {
    if (!existsSync(opsPath)) return;
    try {
      const ops = JSON.parse(readFileSync(opsPath, "utf8"));
      const create = Array.isArray(ops) && ops.find((o) => o.kind === "create_scene");
      if (create?.data?.tokens) tokensOnWire = create.data.tokens;
    } catch { /* mid-write */ }
  }, 5);

  armWatcher(W);
  const { status, body } = await postJson("/api/foundry/flush-scenes", { world: W, sceneIds: [wanted.id] });
  clearInterval(sniff);

  assert.equal(status, 200);
  assert.equal(body.flushed, 1, `only the named scene: ${JSON.stringify(body)}`);
  assert.ok(getScene(W, wanted.id).foundrySceneRef, "the named scene was pushed");
  assert.equal(getScene(W, other.id).foundrySceneRef, null, "the unnamed staged scene was left alone");
  assert.ok(tokensOnWire, "THE WHOLE POINT: this route carries tokens — push-scene does not, which is why scenes landed empty");
  assert.deepEqual(tokensOnWire.map((t) => t.actorUuid), ["Actor.COLLECTOR"]);
  assert.equal(tokensOnWire[0].img, "gm-tools/tokens/x/collector.webp", "and the accepted face rides with it");
});

test("POST /api/foundry/refresh-scene-tokens: patches tokens in place on an already-pushed scene, never deleting it", async () => {
  const W = freshWorld();
  const scene = stagedScene(W, "A dressed scene");
  markScenePushed(W, scene.id, { foundrySceneRef: "Scene.DRESSED", lastPushedAt: new Date().toISOString() });

  const entry = saveBestiaryEntry({ world: W, rawFields: { name: "Bashir", ac: 10, hp: 6 }, provenance: { source: "hand" } });
  acceptBestiaryEntry(entry.id);
  setBestiaryFoundryActorRef(entry.id, "Actor.BASHIR");
  setBestiaryTokenImg(entry.id, "gm-tools/tokens/x/bashir.webp");
  addToSceneTray(W, scene.id, { kind: "creature", id: entry.id });

  const opsPath = foundryOpsPath(dataDir, W);
  let kinds = [];
  const sniff = setInterval(() => {
    if (!existsSync(opsPath)) return;
    try {
      const ops = JSON.parse(readFileSync(opsPath, "utf8"));
      if (Array.isArray(ops) && ops.length) kinds = ops.map((o) => o.kind);
    } catch { /* mid-write */ }
  }, 5);

  armWatcher(W, { uuidFor: () => "Token.X" });
  const { status, body } = await postJson("/api/foundry/refresh-scene-tokens", { world: W, sceneId: scene.id });
  clearInterval(sniff);

  assert.equal(status, 200);
  assert.equal(body.ops.length, 1);
  assert.deepEqual(kinds, ["update_token"], "update_token ONLY — no delete_scene, no create_scene");
  assert.equal(getScene(W, scene.id).foundrySceneRef, "Scene.DRESSED",
    "the scene survives untouched: Russell places tokens and sets starting views by hand");
});

test("POST /api/foundry/refresh-scene-tokens: a scene that was never pushed is a clean 400, not a 500", async () => {
  const W = freshWorld();
  const scene = stagedScene(W, "Never pushed");
  const { status, body } = await postJson("/api/foundry/refresh-scene-tokens", { world: W, sceneId: scene.id });
  assert.equal(status, 400);
  assert.match(body.error, /push it first/);
});

test("POST /api/foundry/refresh-scene-tokens: a missing sceneId is a clean 400", async () => {
  const W = freshWorld();
  const { status, body } = await postJson("/api/foundry/refresh-scene-tokens", { world: W });
  assert.equal(status, 400);
  assert.match(body.error, /requires sceneId/);
});

test("POST /api/foundry/sync-to-plans: dry run by DEFAULT — it reports the sets and writes nothing", async () => {
  const W = freshWorld();
  const keep = stagedScene(W, "Plan scene");
  const drop = stagedScene(W, "Out-of-plan scene");
  markScenePushed(W, drop.id, { foundrySceneRef: "Scene.OUT", lastPushedAt: new Date(Date.now() + 60000).toISOString() });
  const plan = createPlan(W, { name: "This week" });
  addSceneToPlan(W, plan.id, keep.id);

  const { status, body } = await postJson("/api/foundry/sync-to-plans", { world: W, planIds: [plan.id] });
  assert.equal(status, 200);
  assert.equal(body.status, "dry-run");
  assert.deepEqual(body.remove.map((r) => r.sceneId), [drop.id]);
  assert.deepEqual(body.push.map((p) => p.sceneId), [keep.id]);
  assert.equal(getScene(W, drop.id).foundrySceneRef, "Scene.OUT", "nothing was written without confirm");
});

test("POST /api/foundry/sync-to-plans: a typo'd plan id is a clean 400 — the guard that stops a swap deleting everything", async () => {
  const W = freshWorld();
  const { status, body } = await postJson("/api/foundry/sync-to-plans", { world: W, planIds: ["plan_typo"], confirm: true });
  assert.equal(status, 400);
  assert.match(body.error, /No plan found/i);
});

test("POST /api/foundry/sync-to-plans: naming NO plan is refused — it would remove every scene", async () => {
  const W = freshWorld();
  const { status, body } = await postJson("/api/foundry/sync-to-plans", { world: W, planIds: [] });
  assert.equal(status, 400);
  assert.match(body.error, /at least one plan/i);
});

test("POST /api/foundry/sync-to-plans: confirm:true removes the out-of-plan scene and does NOT re-create it", async () => {
  const W = freshWorld();
  const keep = stagedScene(W, "Keeper");
  const drop = stagedScene(W, "Goner");
  markScenePushed(W, keep.id, { foundrySceneRef: "Scene.KEEPER", lastPushedAt: new Date(Date.now() + 60000).toISOString() });
  markScenePushed(W, drop.id, { foundrySceneRef: "Scene.GONER", lastPushedAt: new Date(Date.now() + 60000).toISOString() });
  const plan = createPlan(W, { name: "Tonight only" });
  addSceneToPlan(W, plan.id, keep.id);

  armWatcher(W);
  const { status, body } = await postJson("/api/foundry/sync-to-plans", { world: W, planIds: [plan.id], confirm: true });
  assert.equal(status, 200);
  assert.equal(body.status, "applied", JSON.stringify(body));
  assert.deepEqual(body.removed.map((r) => r.sceneId), [drop.id]);

  const after = getScene(W, drop.id);
  assert.equal(after.foundrySceneRef, null);
  assert.equal(after.stagedForFoundry, false,
    "unstaged, so the trailing flush cannot re-create it — the defect this route shipped with");
});
