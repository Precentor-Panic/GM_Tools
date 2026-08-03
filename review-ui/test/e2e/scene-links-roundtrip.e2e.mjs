// Phase 26 task 26.0, REQUIRED SCENARIO 5 -- "Scene-link store round-trip:
// linking two scenes via '+Scene'/an explicit 'link to existing scene'
// action persists a real record (assert via the store's own routes, not
// just UI state) and survives even when the underlying places were
// explicitly NOT graph-linked." Read phase26-fixture.mjs's header FIRST
// (§2 is this file's own section). EXPECTED TO FAIL right now with a real
// HTTP 404/500 -- none of `/api/scene-planning/scene-links*` exists yet
// (session-planner/scene-links.mjs doesn't exist, per plans/phase-26-tasks
// .md task 26.3). That failure is the deliverable of this task, not a bug
// in this file.
//
// Pure route-level round-trip -- this scenario's own wording ("assert via
// the store's own routes, not just UI state") is what this file tests
// directly, matching plans-crud.e2e.mjs's own established no-browser-needed
// precedent for this suite's pure-store scenarios.
//
// FIXTURE: two place entities with DELIBERATELY NO EDGE between them at all
// ("scenelink-place-a", "scenelink-place-b") -- the strongest, least-
// ambiguous "underlying places explicitly NOT graph-linked" case this
// suite's own linkage query (scene-linkage.mjs's linkedScenesForScene) can
// recognize, so a scene-link recorded between the two scenes anchored to
// these places can only be explained by the NEW scene-link store, never by
// graph adjacency being mistaken for it.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {
  setupPhase26Env,
  cleanupScratchEnv,
  createSceneViaRoute
} from "./phase26-fixture.mjs";

const { scratchDir, dataDir } = setupPhase26Env("gm-tools-e2e-scenelinks-");
const WORLD = "e2e-scenelinks-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "scenelink-place-a", name: "Scene-Link Place A", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "scenelink-place-b", name: "Scene-Link Place B", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "scenelink-place-c", name: "Scene-Link Place C", type: "place", importance: 0.5 } }
  // deliberately: ZERO edges anywhere in this fixture.
]);

let server, base;
let sceneA, sceneB, sceneC;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  sceneA = await createSceneViaRoute(base, WORLD, { locationEntityId: "scenelink-place-a" });
  sceneB = await createSceneViaRoute(base, WORLD, { locationEntityId: "scenelink-place-b" });
  sceneC = await createSceneViaRoute(base, WORLD, { locationEntityId: "scenelink-place-c" });

  // Sanity check on the real, already-shipped linkage route: confirm the
  // fixture's own premise BEFORE testing the new scene-link store -- if this
  // fails, the bug is in this test's fixture, not the thing under test.
  const linkageRes = await fetch(`${base}/api/scene-planning/linkage?world=${WORLD}&sceneId=${sceneA.id}`);
  const linkageBody = await linkageRes.json();
  assert.equal(linkageRes.status, 200, `sanity check on the real linkage route failed: ${JSON.stringify(linkageBody)}`);
  assert.equal(linkageBody.linked.length, 0, "sanity: scene A must have zero graph-adjacency-derived linked scenes -- confirms this fixture's places are genuinely NOT graph-linked");
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("POST /api/scene-planning/scene-links creates a real link record", async () => {
  const res = await fetch(`${base}/api/scene-planning/scene-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sceneIdA: sceneA.id, sceneIdB: sceneB.id, reason: "Same faction storyline" })
  });
  const body = await res.json();
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.link, "must return the created link record");
});

test("GET /api/scene-planning/scene-links?sceneId= is genuinely BIDIRECTIONAL -- querying from EITHER side of the original pair surfaces the other", async () => {
  await fetch(`${base}/api/scene-planning/scene-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sceneIdA: sceneA.id, sceneIdB: sceneC.id, reason: "Bidirectional check" })
  });

  const fromA = await (await fetch(`${base}/api/scene-planning/scene-links?world=${WORLD}&sceneId=${sceneA.id}`)).json();
  assert.ok(fromA.linked.some((l) => l.sceneId === sceneC.id), "querying from the scene stored as sceneIdA must surface sceneIdB as a linked scene");

  const fromC = await (await fetch(`${base}/api/scene-planning/scene-links?world=${WORLD}&sceneId=${sceneC.id}`)).json();
  assert.ok(fromC.linked.some((l) => l.sceneId === sceneA.id), "querying from the scene stored as sceneIdB must ALSO surface sceneIdA -- bidirectional for query purposes, per §26.C, even though only ONE record was ever written");
});

test("§26.C's own explicit requirement: a scene-link persists and is queryable even though the underlying PLACES were explicitly NOT graph-linked", async () => {
  await fetch(`${base}/api/scene-planning/scene-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sceneIdA: sceneB.id, sceneIdB: sceneC.id, reason: "Tied together in this plan, even though the places are far apart" })
  });

  // Re-confirm the underlying places are still genuinely unlinked in the
  // real graph (no side-effect graph edge was ever created by this route).
  const linkageRes = await fetch(`${base}/api/scene-planning/linkage?world=${WORLD}&sceneId=${sceneB.id}`);
  const linkageBody = await linkageRes.json();
  assert.equal(linkageBody.linked.length, 0, "creating a scene-link must NEVER create a real graph edge as a side effect -- the whole point of §26.C's 'dedicated store, not graph entities' decision");

  const linked = await (await fetch(`${base}/api/scene-planning/scene-links?world=${WORLD}&sceneId=${sceneB.id}`)).json();
  assert.ok(linked.linked.some((l) => l.sceneId === sceneC.id), "the scene-link itself must still be a real, queryable record despite the places never being graph-linked");
});

test("a scene-link record persists exactly ONE record per link, not two (asserted by confirming DELETE removes it from BOTH query directions in one call)", async () => {
  await fetch(`${base}/api/scene-planning/scene-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sceneIdA: sceneA.id, sceneIdB: sceneB.id, reason: "for deletion check" })
  });

  const delRes = await fetch(`${base}/api/scene-planning/scene-links`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sceneIdA: sceneA.id, sceneIdB: sceneB.id })
  });
  assert.equal(delRes.status, 200, `expected 200, got ${delRes.status}`);

  const fromA = await (await fetch(`${base}/api/scene-planning/scene-links?world=${WORLD}&sceneId=${sceneA.id}`)).json();
  const fromB = await (await fetch(`${base}/api/scene-planning/scene-links?world=${WORLD}&sceneId=${sceneB.id}`)).json();
  assert.ok(!fromA.linked.some((l) => l.sceneId === sceneB.id), "deleting the link must remove it when queried from side A");
  assert.ok(!fromB.linked.some((l) => l.sceneId === sceneA.id), "deleting the link must ALSO remove it when queried from side B -- a single DELETE call clears both query directions, confirming a single-record-per-link storage model");
});

// ---------------------------------------------------------------------------
// Phase 27 task 27.3 (F12 backend) -- the scene-link record gains an
// optional graphEdgeId, so a later unlink can target the SPECIFIC graph
// edge a link's own graph-push step created. EXPECTED TO FAIL right now:
// linkScenes(world, sceneIdA, sceneIdB, reason) has no graphEdgeId
// parameter yet, getLinkedScenes doesn't echo one, and unlinkScenes returns
// only {removed:boolean} today (confirmed fresh against the real
// session-planner/scene-links.mjs) -- so `entry.graphEdgeId` below is
// `undefined` and `delBody.link` is `undefined`, not a bug in this file.
// ---------------------------------------------------------------------------
test("POST /api/scene-planning/scene-links accepts and stores an optional graphEdgeId, echoed by GET", async () => {
  const res = await fetch(`${base}/api/scene-planning/scene-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sceneIdA: sceneA.id, sceneIdB: sceneB.id, reason: "graph-backed link", graphEdgeId: "edge_manual_test123" })
  });
  const body = await res.json();
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.link.graphEdgeId, "edge_manual_test123", "the created link record must echo the supplied graphEdgeId back in the POST response");

  const fromA = await (await fetch(`${base}/api/scene-planning/scene-links?world=${WORLD}&sceneId=${sceneA.id}`)).json();
  const entry = fromA.linked.find((l) => l.sceneId === sceneB.id);
  assert.ok(entry, "the link must be queryable");
  assert.equal(entry.graphEdgeId, "edge_manual_test123", "GET /scene-links must echo the stored graphEdgeId alongside every linked entry");
});

test("re-linking an already-linked pair (idempotent by unordered pair) UPDATES graphEdgeId rather than duplicating the record", async () => {
  await fetch(`${base}/api/scene-planning/scene-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sceneIdA: sceneA.id, sceneIdB: sceneC.id, reason: "first link, no edge yet" })
  });
  await fetch(`${base}/api/scene-planning/scene-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sceneIdA: sceneA.id, sceneIdB: sceneC.id, graphEdgeId: "edge_manual_test456" })
  });

  const fromA = await (await fetch(`${base}/api/scene-planning/scene-links?world=${WORLD}&sceneId=${sceneA.id}`)).json();
  const matches = fromA.linked.filter((l) => l.sceneId === sceneC.id);
  assert.equal(matches.length, 1, "re-linking an already-linked pair must never create a second record");
  assert.equal(matches[0].graphEdgeId, "edge_manual_test456", "re-linking must update the existing record's graphEdgeId, not silently keep the old one");
});

test("DELETE /api/scene-planning/scene-links returns the REMOVED record (including its graphEdgeId), so a caller can target the exact edge to delete", async () => {
  await fetch(`${base}/api/scene-planning/scene-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sceneIdA: sceneB.id, sceneIdB: sceneC.id, reason: "for delete-returns-record check", graphEdgeId: "edge_manual_test789" })
  });

  const delRes = await fetch(`${base}/api/scene-planning/scene-links`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sceneIdA: sceneB.id, sceneIdB: sceneC.id })
  });
  const delBody = await delRes.json();
  assert.equal(delRes.status, 200, `expected 200, got ${delRes.status}: ${JSON.stringify(delBody)}`);
  assert.equal(delBody.removed, true, "removed must still be true (unchanged shape)");
  assert.ok(delBody.link, "DELETE must return the removed link record itself, not just a boolean, so the caller can read its graphEdgeId");
  assert.equal(delBody.link.graphEdgeId, "edge_manual_test789", "the returned removed record must carry the exact graphEdgeId that was stored, so the caller can delete that specific graph edge");
});
