// Phase 26 task 26.0, REQUIRED SCENARIO 4 -- "'Beyond this path' no longer
// renders (beyond-corridor-summary DOM-absence); its former space now hosts
// connect-existing-scene / create-ad-hoc-scene actions." Read
// phase26-fixture.mjs's header FIRST (§6 is this file's own section).
//
// ***UPDATED by Phase 27 task 27.0*** (F4/F12: the green auto-surfaced
// `connect-existing-scene-list`/`connect-existing-scene-item`/`create-ad-
// hoc-scene-btn` zone this file used to assert RENDERS is now ITSELF
// retired entirely, replaced by the plan-scoped link/unlink list
// (`plan-scene-links-list`, see phase27-fixture.mjs's header §3 and the new
// plan-scoped-scene-links.e2e.mjs) -- scenes now start with NO links, and
// only show the OTHER scenes in the CURRENT PLAN, never graph-adjacency
// candidates auto-surfaced as a green link. This file's own two positive-
// behavior tests (asserting the OLD zone renders both linkage-derived and
// scene-link-derived candidates, and that create-ad-hoc-scene-btn aliases
// add-scene-btn) are RETIRED per this project's own "retire/replace the OLD
// green auto-link assertions" instruction -- replaced below by DOM-absence
// assertions for the entire zone, alongside the already-true (Phase 26)
// beyond-corridor-summary absence. EXPECTED TO FAIL right now: the CURRENT
// code still renders `connect-existing-scene-list`/`connect-existing-scene-
// item`/`create-ad-hoc-scene-btn` in exactly this DOM position (confirmed
// fresh against the real session-planner-view.js's buildConnectExisting
// SceneZone, still live), so the new absence assertions below currently
// fail. That failure is the deliverable of this task, not a bug in this
// file.
//
// FIXTURE: a scene ("beyondpath-anchor") plus a graph-adjacent OTHER scene
// ("beyondpath-hop1-anchor", 1 hop away via a real edge) AND a separately
// explicit-scene-linked scene ("beyondpath-linked-anchor", genuinely
// disconnected in the graph) -- kept from the original Phase 26 fixture
// (still useful: proves the retired zone's absence even in a world where
// its OLD candidate data genuinely exists, so the absence isn't a false
// pass from an empty-candidate-set coincidence).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase26Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  linkScenesViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase26-fixture.mjs";

const { scratchDir, dataDir } = setupPhase26Env("gm-tools-e2e-beyondpath-");
const WORLD = "e2e-beyondpath-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "beyondpath-anchor", name: "Beyond-Path Anchor", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "beyondpath-hop1-anchor", name: "Beyond-Path Hop-1 Anchor", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "beyondpath-linked-anchor", name: "Beyond-Path Explicitly-Linked Anchor", type: "place", importance: 0.5 } },
  { op: "upsert_edge", data: { id: "beyondpath-e0", sourceId: "beyondpath-anchor", targetId: "beyondpath-hop1-anchor", relationshipType: "unspecified" } }
]);

let server, base, browser, page;
let scene, hop1Scene, linkedScene;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "beyondpath-anchor" });
  hop1Scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "beyondpath-hop1-anchor" });
  linkedScene = await createSceneViaRoute(base, WORLD, { locationEntityId: "beyondpath-linked-anchor" });
  await linkScenesViaRoute(base, WORLD, scene.id, linkedScene.id, "explicitly linked, not graph-adjacent");

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("'beyond-corridor-summary' (and its two child counts) is DOM-absent entirely", async () => {
  await page.goto(`${base}/#session-planner/${scene.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"][data-current="true"]').length === 1, { timeout: 15000 });

  const summaryCount = await page.evaluate(() => document.querySelectorAll('[data-testid="beyond-corridor-summary"]').length);
  const contentCountEl = await page.evaluate(() => document.querySelectorAll('[data-testid="beyond-corridor-content-count"]').length);
  const structCountEl = await page.evaluate(() => document.querySelectorAll('[data-testid="beyond-corridor-structural-count"]').length);
  assert.equal(summaryCount, 0, "beyond-corridor-summary must be COMPLETELY REMOVED (§26.B) -- real DOM-absence, not just untested");
  assert.equal(contentCountEl, 0, "its child beyond-corridor-content-count must be gone too");
  assert.equal(structCountEl, 0, "its child beyond-corridor-structural-count must be gone too");
});

test("Phase 27 (F4/F12): the OLD green auto-link zone (connect-existing-scene-list/item, create-ad-hoc-scene-btn) is now ITSELF completely retired -- real DOM-absence, even though its own old candidate data (a graph-adjacent hop-1 scene AND an explicitly scene-linked scene) genuinely exists in this fixture", async () => {
  await page.goto(`${base}/#session-planner/${scene.id}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="scene-chain-item"][data-current="true"]').length === 1, { timeout: 15000 });

  const listCount = await page.evaluate(() => document.querySelectorAll('[data-testid="connect-existing-scene-list"]').length);
  const itemCount = await page.evaluate(() => document.querySelectorAll('[data-testid="connect-existing-scene-item"]').length);
  const adHocCount = await page.evaluate(() => document.querySelectorAll('[data-testid="create-ad-hoc-scene-btn"]').length);
  assert.equal(listCount, 0, "connect-existing-scene-list must be COMPLETELY REMOVED (Phase 27, F4) -- replaced by the plan-scoped link/unlink list, real DOM-absence not just untested");
  assert.equal(itemCount, 0, "connect-existing-scene-item must be COMPLETELY REMOVED too");
  assert.equal(adHocCount, 0, "create-ad-hoc-scene-btn must be COMPLETELY REMOVED too -- the plan-level +Scene control (F6) is the only scene-creation entry point now");

  // Sanity: this isn't a false pass from an empty-candidate-set coincidence
  // -- the fixture's own old-mechanism candidates genuinely exist (a real
  // hop-1 graph edge, a real explicit scene-link), so a re-introduced
  // version of the OLD zone would have real data to render here.
  const linkageRes = await fetch(`${base}/api/scene-planning/linkage?world=${WORLD}&sceneId=${scene.id}`);
  const linkageBody = await linkageRes.json();
  assert.ok(linkageBody.linked.some((l) => l.sceneId === hop1Scene.id), "sanity: the hop-1 graph-adjacency candidate this fixture seeded must still genuinely exist");
});
