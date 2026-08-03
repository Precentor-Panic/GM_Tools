// Phase 26 task 26.0, REQUIRED SCENARIO 6 -- "Plan CRUD round-trips through
// real routes: create a Plan, add/remove a scene (the SAME scene added to
// two different Plans, asserting both memberships persist independently),
// list Plans for a world." Read phase26-fixture.mjs's header FIRST (§1 is
// this file's own section). EXPECTED TO FAIL right now with a real HTTP
// 404/500 -- none of `/api/scene-planning/plans*` exists yet (session-
// planner/plans.mjs doesn't exist, per plans/phase-26-tasks.md task 26.1).
// That failure is the deliverable of this task, not a bug in this file.
//
// Pure route-level round-trip -- no browser needed (this scenario's own
// wording, "asserting via real routes," is what this file tests directly),
// matching this project's established convention of e2e-directory files
// that assert purely over fetch() when a scenario doesn't need real DOM
// interaction (scene-construction-insert-between.e2e.mjs's own final
// assertions do the same "confirm via the actual store" thing, just
// alongside a browser-driven first half).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {
  setupPhase26Env,
  cleanupScratchEnv,
  createSceneViaRoute
} from "./phase26-fixture.mjs";

const { scratchDir, dataDir } = setupPhase26Env("gm-tools-e2e-plans-crud-");
const WORLD = "e2e-plans-crud-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "plans-anchor-1", name: "Plans Anchor One", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "plans-anchor-2", name: "Plans Anchor Two", type: "place", importance: 0.5 } }
]);

let server, base;
let sceneOne, sceneTwo;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  sceneOne = await createSceneViaRoute(base, WORLD, { locationEntityId: "plans-anchor-1" });
  sceneTwo = await createSceneViaRoute(base, WORLD, { locationEntityId: "plans-anchor-2" });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("POST /api/scene-planning/plans creates a real Plan with an empty sceneIds list", async () => {
  const res = await fetch(`${base}/api/scene-planning/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, name: "Key Events" })
  });
  const body = await res.json();
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.plan?.id, "a created plan must have a real id");
  assert.equal(body.plan.name, "Key Events");
  assert.deepEqual(body.plan.sceneIds, [], "a freshly-created plan must start with an empty sceneIds list");
});

test("GET /api/scene-planning/plans?world= lists every plan created for that world", async () => {
  const createRes = await fetch(`${base}/api/scene-planning/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, name: "Listing Check Plan" })
  });
  const { plan } = await createRes.json();

  const listRes = await fetch(`${base}/api/scene-planning/plans?world=${WORLD}`);
  const listBody = await listRes.json();
  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray(listBody.plans), "must return a plans array");
  assert.ok(listBody.plans.some((p) => p.id === plan.id), "the just-created plan must appear in the world's plan list");
});

test("adding a scene to a Plan persists via POST, removing it via DELETE persists too", async () => {
  const { plan } = await (await fetch(`${base}/api/scene-planning/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, name: "Add-Remove Check" })
  })).json();

  const addRes = await fetch(`${base}/api/scene-planning/plans/${plan.id}/scenes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sceneId: sceneOne.id })
  });
  const addBody = await addRes.json();
  assert.equal(addRes.status, 200, `expected 200, got ${addRes.status}: ${JSON.stringify(addBody)}`);
  assert.ok(addBody.plan.sceneIds.includes(sceneOne.id), "the added sceneId must appear in the plan's sceneIds after POST");

  // Re-fetch from a fresh GET, not just trusting the POST response, to
  // confirm this genuinely PERSISTED rather than being an echo of the input.
  const reGet1 = await (await fetch(`${base}/api/scene-planning/plans/${plan.id}?world=${WORLD}`)).json();
  assert.ok(reGet1.plan.sceneIds.includes(sceneOne.id), "a fresh GET must also show the added scene -- real persistence, not just an echoed response");

  const delRes = await fetch(`${base}/api/scene-planning/plans/${plan.id}/scenes/${sceneOne.id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD })
  });
  const delBody = await delRes.json();
  assert.equal(delRes.status, 200, `expected 200, got ${delRes.status}: ${JSON.stringify(delBody)}`);
  assert.ok(!delBody.plan.sceneIds.includes(sceneOne.id), "the removed sceneId must be gone from the plan's sceneIds after DELETE");

  const reGet2 = await (await fetch(`${base}/api/scene-planning/plans/${plan.id}?world=${WORLD}`)).json();
  assert.ok(!reGet2.plan.sceneIds.includes(sceneOne.id), "a fresh GET must also confirm the removal persisted");
});

test("adding the same sceneId to a Plan twice is idempotent -- no duplicate entries", async () => {
  const { plan } = await (await fetch(`${base}/api/scene-planning/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, name: "Idempotent Add Check" })
  })).json();

  await fetch(`${base}/api/scene-planning/plans/${plan.id}/scenes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sceneId: sceneOne.id })
  });
  const secondRes = await fetch(`${base}/api/scene-planning/plans/${plan.id}/scenes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sceneId: sceneOne.id })
  });
  const secondBody = await secondRes.json();
  assert.equal(secondRes.status, 200);
  const occurrences = secondBody.plan.sceneIds.filter((id) => id === sceneOne.id).length;
  assert.equal(occurrences, 1, "adding the same sceneId twice must not create a duplicate entry in sceneIds");
});

test("REAL EXAMPLE FROM §26.D: the SAME scene added to TWO different Plans persists independently in both, and removing it from one Plan leaves the other's membership completely untouched", async () => {
  const { plan: keyEvents } = await (await fetch(`${base}/api/scene-planning/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, name: "Key Events (recurring story arc)" })
  })).json();
  const { plan: sessionSpecific } = await (await fetch(`${base}/api/scene-planning/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, name: "Session 12 (this week)" })
  })).json();

  await fetch(`${base}/api/scene-planning/plans/${keyEvents.id}/scenes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sceneId: sceneTwo.id })
  });
  await fetch(`${base}/api/scene-planning/plans/${sessionSpecific.id}/scenes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, sceneId: sceneTwo.id })
  });

  const keyEventsAfter = await (await fetch(`${base}/api/scene-planning/plans/${keyEvents.id}?world=${WORLD}`)).json();
  const sessionSpecificAfter = await (await fetch(`${base}/api/scene-planning/plans/${sessionSpecific.id}?world=${WORLD}`)).json();
  assert.ok(keyEventsAfter.plan.sceneIds.includes(sceneTwo.id), "the shared scene must be a real member of the Key Events plan");
  assert.ok(sessionSpecificAfter.plan.sceneIds.includes(sceneTwo.id), "the SAME scene must ALSO be a real member of the Session-Specific plan -- many-to-many, not a move");

  // Now remove from ONE plan only.
  await fetch(`${base}/api/scene-planning/plans/${keyEvents.id}/scenes/${sceneTwo.id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD })
  });

  const keyEventsFinal = await (await fetch(`${base}/api/scene-planning/plans/${keyEvents.id}?world=${WORLD}`)).json();
  const sessionSpecificFinal = await (await fetch(`${base}/api/scene-planning/plans/${sessionSpecific.id}?world=${WORLD}`)).json();
  assert.ok(!keyEventsFinal.plan.sceneIds.includes(sceneTwo.id), "removal from Key Events must actually remove it there");
  assert.ok(sessionSpecificFinal.plan.sceneIds.includes(sceneTwo.id), "removal from ONE plan must NEVER affect the other plan's own independent membership record -- no back-reference on the Scene, no shared mutable state between Plans");
});

test("security: a path-traversal-shaped world id is rejected, never accepted, matching this project's established route-security convention", async () => {
  const res = await fetch(`${base}/api/scene-planning/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: "../../etc", name: "Malicious" })
  });
  assert.notEqual(res.status, 200, "a malicious/traversal-shaped world id must never be accepted by a Plans route");
});
