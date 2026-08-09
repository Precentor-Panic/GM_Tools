import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — Phase 35 task 35.1's new review-ui/server.mjs
 * routes, §7/§8 of review-ui/test/e2e/phase35-fixture.mjs (THE WRITTEN
 * CONTRACT): the shared scene tray (session-planner/scene-tray.mjs) plus
 * this file's own pinned creature-drop route-level composition (create/
 * reuse a stat-carrying kind:'local' scene element on FIRST drop, dedup via
 * fields.bestiaryEntryId, roster-only stacking on repeat drops; hero/asset
 * drops touch no scene elements).
 *
 * Real HTTP requests via fetch() against an in-process server.listen(0),
 * same pattern as review-ui/test/scene-planning-routes.test.mjs. Bootstraps
 * a real snapshot (bootstrapSnapshot) since createScene/createElement don't
 * themselves require one, but this mirrors the project's own established
 * per-file convention for any file touching session-planner/scene-elements.mjs.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-scene-tray-routes-test-"));
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

const WORLD = "scene-tray-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../server.mjs");
const { createScene, getScene } = await import("../../session-planner/scenes.mjs");
const { saveBestiaryEntry } = await import("../../combat-planning/bestiary-store.mjs");
const { savePartyMember } = await import("../../combat-planning/party-roster-store.mjs");
const { saveItem } = await import("../../combat-planning/item-store.mjs");
const { saveStagecraftAsset } = await import("../../session-planner/stagecraft-store.mjs");
const { listElementsForScene } = await import("../../session-planner/scene-elements.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

let server, base, scene;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  scene = createScene(WORLD, {}, { makeId: () => "scene-tray-route-test" });
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

test("GET .../tray?world= NEVER 404s for a fresh scene -- returns {roster:[], xpBudget:null}", async () => {
  const { status, body } = await getJson(`/api/scene-planning/scenes/${scene.id}/tray?world=${WORLD}`);
  assert.equal(status, 200);
  assert.deepEqual(body, { roster: [], xpBudget: null });
});

test("GET .../tray?world= for a completely unknown sceneId ALSO never 404s", async () => {
  const { status, body } = await getJson(`/api/scene-planning/scenes/never-created-scene/tray?world=${WORLD}`);
  assert.equal(status, 200);
  assert.deepEqual(body, { roster: [], xpBudget: null });
});

test("POST .../tray/budget persists an xpBudget without touching the roster", async () => {
  const { status, body } = await postJson(`/api/scene-planning/scenes/${scene.id}/tray/budget`, { world: WORLD, xpBudget: 900 });
  assert.equal(status, 200);
  assert.equal(body.xpBudget, 900);
  assert.deepEqual(body.roster, []);

  const reread = await getJson(`/api/scene-planning/scenes/${scene.id}/tray?world=${WORLD}`);
  assert.equal(reread.body.xpBudget, 900);
});

test("POST .../tray/drop {kind:'creature'}: FIRST drop creates a kind:'local' scene element carrying a stat block from the bestiary entry's rawFields", async () => {
  const entry = saveBestiaryEntry(
    { rawFields: { name: "Ogrekin Skirmisher", hp: 85, ac: 16, challengeRating: 5 }, foundryActorRef: "Actor.ogrekin" },
    { makeId: () => "bst-tray-1" }
  );

  const first = await postJson(`/api/scene-planning/scenes/${scene.id}/tray/drop`, { world: WORLD, kind: "creature", id: entry.id });
  assert.equal(first.status, 200);
  assert.ok(first.body.element, "the FIRST creature drop must create/return a real scene element");
  assert.equal(first.body.element.kind, "local", "no graph link exists yet to reuse -- kind:'local', per §7's own pin");
  assert.equal(first.body.element.name, "Ogrekin Skirmisher");
  assert.equal(first.body.element.fields.bestiaryEntryId, entry.id);
  assert.equal(first.body.element.stat.ac, 16);
  assert.equal(first.body.element.stat.hp, 85);
  assert.equal(first.body.element.stat.cr, 5);
  assert.equal(first.body.element.stat.foundryActor, "Actor.ogrekin");
  assert.deepEqual(first.body.roster, [{ id: entry.id, n: 1, kind: "creature" }]);

  const elementsAfterFirst = listElementsForScene(WORLD, scene.id).length;

  const second = await postJson(`/api/scene-planning/scenes/${scene.id}/tray/drop`, { world: WORLD, kind: "creature", id: entry.id });
  assert.equal(second.status, 200);
  assert.equal(second.body.element, null, "the SECOND drop of the same creature must NOT create a second element");
  assert.equal(second.body.roster.find((r) => r.id === entry.id).n, 2, "the second drop stacks the roster to n:2");
  assert.equal(listElementsForScene(WORLD, scene.id).length, elementsAfterFirst, "the scene's element COUNT must not grow on a stacking drop");
});

test("POST .../tray/drop {kind:'hero'}: display-only -- creates NO scene element, roster n always resets to 1 on repeat", async () => {
  const member = savePartyMember(WORLD, { name: "Kestrel Windrider", combatRelevant: {}, buildRelevant: {} }, { makeId: () => "pm-tray-1" });
  const elementsBefore = listElementsForScene(WORLD, scene.id).length;

  const first = await postJson(`/api/scene-planning/scenes/${scene.id}/tray/drop`, { world: WORLD, kind: "hero", id: member.id });
  assert.equal(first.status, 200);
  assert.equal(first.body.element, null);
  assert.ok(first.body.roster.some((r) => r.id === member.id && r.kind === "hero" && r.n === 1));

  const second = await postJson(`/api/scene-planning/scenes/${scene.id}/tray/drop`, { world: WORLD, kind: "hero", id: member.id });
  assert.equal(second.body.element, null);
  assert.equal(second.body.roster.find((r) => r.id === member.id).n, 1, "hero drops never stack");

  assert.equal(listElementsForScene(WORLD, scene.id).length, elementsBefore, "a hero drop must never touch scene-elements.mjs at all");
});

test("POST .../tray/drop {kind:'asset'}: resolves item-store-first, then stagecraft-store; the roster row itself IS the scene-asset link", async () => {
  const item = saveItem(WORLD, { name: "Bag of Holding", type: "equipment" }, { makeId: () => "it-tray-1" });
  const asset = saveStagecraftAsset(WORLD, { kind: "map", name: "Some Map" }, { makeId: () => "sc-tray-1" });

  const itemDrop = await postJson(`/api/scene-planning/scenes/${scene.id}/tray/drop`, { world: WORLD, kind: "asset", id: item.id });
  assert.equal(itemDrop.status, 200);
  assert.equal(itemDrop.body.element, null);
  assert.ok(itemDrop.body.roster.some((r) => r.id === item.id && r.kind === "asset"));

  const assetDrop = await postJson(`/api/scene-planning/scenes/${scene.id}/tray/drop`, { world: WORLD, kind: "asset", id: asset.id });
  assert.equal(assetDrop.status, 200);
  assert.ok(assetDrop.body.roster.some((r) => r.id === asset.id && r.kind === "asset"), "resolves via stagecraft-store when item-store doesn't have it");

  const removed = await deleteJson(`/api/scene-planning/scenes/${scene.id}/tray/asset/${item.id}`, { world: WORLD });
  assert.equal(removed.status, 200);
  assert.ok(!removed.body.roster.some((r) => r.id === item.id && r.kind === "asset"), "removing the roster row removes the entire scene-asset link");
});

test("POST .../tray/drop: an unresolvable creature id never 500s (cleanly rejected)", async () => {
  const { status } = await postJson(`/api/scene-planning/scenes/${scene.id}/tray/drop`, { world: WORLD, kind: "creature", id: "bst_does_not_exist" });
  assert.notEqual(status, 500);
  assert.notEqual(status, 200);
});

test("POST .../tray/drop: an unresolvable asset id (neither item-store nor stagecraft-store has it) never 500s", async () => {
  const { status } = await postJson(`/api/scene-planning/scenes/${scene.id}/tray/drop`, { world: WORLD, kind: "asset", id: "no-such-asset" });
  assert.notEqual(status, 500);
  assert.notEqual(status, 200);
});

test("DELETE .../tray/:kind/:id is idempotent -- removing an already-absent row is a safe 200 no-op, not an error", async () => {
  const { status, body } = await deleteJson(`/api/scene-planning/scenes/${scene.id}/tray/creature/never-dropped`, { world: WORLD });
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.roster));
});

// ===========================================================================
// Phase 36 task 36.2, §3 -- touchSceneSafely additions: every tray mutation
// (drop of every kind, including a creature's stacking 2nd+ drop / remove /
// budget) bumps the scene's own updatedAt, and stagecraft-accept fans out a
// touch to every scene whose tray roster references the just-accepted
// asset. Uses a FRESH scene per test (not the shared `scene` above, whose
// updatedAt has already been bumped many times by earlier tests) so each
// assertion has an unambiguous "before" baseline.
// ===========================================================================

test("POST .../tray/drop {kind:'creature'}: bumps the scene's updatedAt, including on the SECOND (stacking-only) drop", async () => {
  const touchScene1 = createScene(WORLD, {}, { makeId: () => "scene-touch-drop-creature", now: "2026-08-07T00:00:00.000Z" });
  const entry = saveBestiaryEntry({ rawFields: { name: "Touch Test Creature" } }, { makeId: () => "bst-touch-1" });

  await postJson(`/api/scene-planning/scenes/${touchScene1.id}/tray/drop`, { world: WORLD, kind: "creature", id: entry.id });
  const afterFirst = getScene(WORLD, touchScene1.id).updatedAt;
  assert.notEqual(afterFirst, "2026-08-07T00:00:00.000Z", "the first drop (new element) must bump updatedAt");

  await new Promise((r) => setTimeout(r, 2));
  await postJson(`/api/scene-planning/scenes/${touchScene1.id}/tray/drop`, { world: WORLD, kind: "creature", id: entry.id });
  const afterSecond = getScene(WORLD, touchScene1.id).updatedAt;
  assert.ok(afterSecond > afterFirst, "the SECOND drop (roster-stacking only, no new element) must ALSO bump updatedAt -- unconditional, per §3");
});

test("POST .../tray/drop {kind:'hero'} and {kind:'asset'}: both bump the scene's updatedAt", async () => {
  const touchScene2 = createScene(WORLD, {}, { makeId: () => "scene-touch-drop-hero-asset" });
  const before = getScene(WORLD, touchScene2.id).updatedAt;
  const member = savePartyMember(WORLD, { name: "Touch Test Hero", combatRelevant: {}, buildRelevant: {} }, { makeId: () => "pm-touch-1" });

  await new Promise((r) => setTimeout(r, 2));
  await postJson(`/api/scene-planning/scenes/${touchScene2.id}/tray/drop`, { world: WORLD, kind: "hero", id: member.id });
  const afterHero = getScene(WORLD, touchScene2.id).updatedAt;
  assert.ok(afterHero > before, "a hero drop must bump updatedAt even though it touches no scene element");

  const item = saveItem(WORLD, { name: "Touch Test Item", type: "equipment" }, { makeId: () => "it-touch-1" });
  await new Promise((r) => setTimeout(r, 2));
  await postJson(`/api/scene-planning/scenes/${touchScene2.id}/tray/drop`, { world: WORLD, kind: "asset", id: item.id });
  const afterAsset = getScene(WORLD, touchScene2.id).updatedAt;
  assert.ok(afterAsset > afterHero, "an asset drop must ALSO bump updatedAt");
});

test("DELETE .../tray/:kind/:id: bumps the scene's updatedAt on a successful removal", async () => {
  const touchScene3 = createScene(WORLD, {}, { makeId: () => "scene-touch-remove" });
  const item = saveItem(WORLD, { name: "Touch Test Removable", type: "equipment" }, { makeId: () => "it-touch-2" });
  await postJson(`/api/scene-planning/scenes/${touchScene3.id}/tray/drop`, { world: WORLD, kind: "asset", id: item.id });
  const before = getScene(WORLD, touchScene3.id).updatedAt;

  await new Promise((r) => setTimeout(r, 2));
  await deleteJson(`/api/scene-planning/scenes/${touchScene3.id}/tray/asset/${item.id}`, { world: WORLD });
  const after = getScene(WORLD, touchScene3.id).updatedAt;
  assert.ok(after > before, "a tray removal must bump updatedAt");
});

test("POST .../tray/budget: bumps the scene's updatedAt on every call, uniformly with every other tray mutation", async () => {
  const touchScene4 = createScene(WORLD, {}, { makeId: () => "scene-touch-budget" });
  const before = getScene(WORLD, touchScene4.id).updatedAt;

  await new Promise((r) => setTimeout(r, 2));
  await postJson(`/api/scene-planning/scenes/${touchScene4.id}/tray/budget`, { world: WORLD, xpBudget: 500 });
  const after = getScene(WORLD, touchScene4.id).updatedAt;
  assert.ok(after > before, "a budget set must bump updatedAt, same as every other tray mutation (§3's own uniform-touch reasoning)");
});

test("POST /api/session-planner/stagecraft/:id/accept: FAN-OUT touch -- every scene whose tray roster references the just-accepted asset gets touched, an unrelated scene does not", async () => {
  const referencingScene = createScene(WORLD, {}, { makeId: () => "scene-touch-fanout-referencing" });
  const unrelatedScene = createScene(WORLD, {}, { makeId: () => "scene-touch-fanout-unrelated" });
  const asset = saveStagecraftAsset(WORLD, { kind: "map", name: "Fan-Out Map", status: "proposed" }, { makeId: () => "sc-touch-fanout-1" });

  await postJson(`/api/scene-planning/scenes/${referencingScene.id}/tray/drop`, { world: WORLD, kind: "asset", id: asset.id });
  const referencingBefore = getScene(WORLD, referencingScene.id).updatedAt;
  const unrelatedBefore = getScene(WORLD, unrelatedScene.id).updatedAt;

  await new Promise((r) => setTimeout(r, 2));
  const accepted = await postJson(`/api/session-planner/stagecraft/${asset.id}/accept`, { world: WORLD });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.asset.status, "accepted");

  const referencingAfter = getScene(WORLD, referencingScene.id).updatedAt;
  const unrelatedAfter = getScene(WORLD, unrelatedScene.id).updatedAt;
  assert.ok(referencingAfter > referencingBefore, "the scene whose roster references the accepted asset must be touched");
  assert.equal(unrelatedAfter, unrelatedBefore, "an unrelated scene (no reference to this asset) must NOT be touched");
});

void __dirname;
