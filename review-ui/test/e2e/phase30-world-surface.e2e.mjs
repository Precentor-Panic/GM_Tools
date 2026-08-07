// Phase 30 task 30.0 -- World surface: light 30.0 contract (tree from
// GET /api/graph, node selection/detail, "Create a scene here", inspector
// "appears in") PLUS route-level proof of the two 30.1 World-backend routes.
// Read phase30-fixture.mjs's header FIRST -- especially Decision 7 and §5/§6.
//
// EXPECTED TO FAIL right now, UI-level: `[data-testid="world-surface-root"]`
// does not exist anywhere (no world-view.js, no `#world` dispatch branch) --
// every UI-level test below times out. That failure is the deliverable of
// this task, not a bug in this file.
//
// NOTE on the two route-level tests: task 30.1 (the World backend, a
// separate, parallel-safe task) landed CONCURRENTLY with this task, in this
// same working tree -- both `scenesForEntity` and `reparentNode` are REAL,
// shipped routes as of this run (confirmed directly, not assumed; an
// earlier draft of this suite guessed 404 and was corrected). Those two
// tests are therefore legitimately GREEN already, not red-for-a-reason like
// the rest of this suite -- kept here anyway to pin the exact response shape
// 30.4's World surface consumes, per phase30-fixture.mjs's own §6 note.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase30Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  scenesForEntityViaRoute,
  reparentNodeViaRoute,
  DESKTOP_VIEWPORT
} from "./phase30-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-p30-world-");
const WORLD = "e2e-p30-world-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "world-place-root", name: "The Drowned Archive", type: "place", importance: 0.6 } },
  { op: "upsert_entity", data: { id: "world-place-child", name: "The Lower Stacks", type: "place", importance: 0.4 } },
  { op: "upsert_entity", data: { id: "world-person-a", name: "Cinder Vell", type: "person", importance: 0.4 } },
  { op: "upsert_edge", data: { id: "world-edge-a", sourceId: "world-person-a", targetId: "world-place-root", relationshipType: "containment" } },
  { op: "upsert_edge", data: { id: "world-edge-b", sourceId: "world-place-child", targetId: "world-place-root", relationshipType: "containment" } }
]);

let server, base, browser;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("#world renders the containment tree from GET /api/graph, including seeded nodes", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  await page.goto(`${base}/#world`);
  const root = page.locator('[data-testid="world-surface-root"]');
  await root.waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="world-tree-row"][data-entity-id="world-place-root"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-testid="world-tree-row"][data-entity-id="world-person-a"]').waitFor({ state: "visible", timeout: 10000 });
  await page.close();
});

test("selecting a node shows its detail and updates the hash; a direct #world/<id> deep link opens it pre-selected", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  await page.goto(`${base}/#world`);
  await page.locator('[data-testid="world-tree-row"][data-entity-id="world-person-a"]').waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="world-tree-row"][data-entity-id="world-person-a"]').click();

  const detail = page.locator('[data-testid="world-detail"][data-entity-id="world-person-a"]');
  await detail.waitFor({ state: "visible", timeout: 10000 });
  assert.equal((await detail.locator('[data-testid="world-detail-name"]').textContent()).trim(), "Cinder Vell");
  assert.match((await detail.locator('[data-testid="world-detail-type"]').textContent()) || "", /person/i);
  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => location.hash === "#world/world-person-a", { timeout: 10000 });
  }, "selecting a node must update the hash to #world/<entityId>");

  const page2 = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page2, base, WORLD);
  await page2.goto(`${base}/#world/world-place-root`);
  await page2.locator('[data-testid="world-detail"][data-entity-id="world-place-root"]').waitFor({ state: "visible", timeout: 15000 });
  await page.close();
  await page2.close();
});

test('"Create a scene here" appears only for a place node and calls the real scene-create route', async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  await page.goto(`${base}/#world/world-person-a`);
  await page.locator('[data-testid="world-detail"][data-entity-id="world-person-a"]').waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.locator('[data-testid="world-create-scene-here-btn"]').count(), 0, "a non-place node must not offer create-scene-here");

  await page.goto(`${base}/#world/world-place-root`);
  const btn = page.locator('[data-testid="world-create-scene-here-btn"][data-entity-id="world-place-root"]');
  await btn.waitFor({ state: "visible", timeout: 15000 });
  await btn.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(async () => {
      const res = await fetch(`/api/session-planner/scenes?world=${encodeURIComponent("e2e-p30-world-world")}`);
      if (!res.ok) return false;
      const body = await res.json();
      return (body.scenes || []).some((s) => s.locationEntityId === "world-place-root");
    }, { timeout: 10000 });
  }, "Create a scene here must create a REAL scene anchored to the selected place");

  // Phase 30.5 cross-surface seam: the button doesn't just toast a hint, it
  // JUMPS into the Session planner with the brand-new scene open.
  await page.waitForFunction(() => /^#planner\/scene\//.test(location.hash), null, { timeout: 10000 });
  await page.locator('[data-testid="planner-scene-view"]').waitFor({ state: "visible", timeout: 10000 });
  await page.close();
});

test("inspector's appears-in section renders a real scene appearance (backed by the now-live scenesForEntity route)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  // Anchor the scene at a DIFFERENT place, then attach world-person-a as a
  // real kind:'graph' scene-ELEMENT (Phase 33 task 33.1 retired the old
  // /members route -- scene contents are unified as scene-elements) -- keeps
  // the scene's own resolved display name ("The Sunken Chapel", via
  // resolveSceneDisplayName's anchor-place fallback) distinct from the
  // entity under inspection, so this assertion isn't accidentally trivial.
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "world-place-root" });
  await fetch(`${base}/api/scene-planning/scenes/${scene.id}/elements/from-graph`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, entityId: "world-person-a" })
  });

  await page.goto(`${base}/#world/world-person-a`);
  const inspector = page.locator('[data-testid="world-inspector"][data-entity-id="world-person-a"]');
  await inspector.waitFor({ state: "visible", timeout: 15000 });
  const appearsIn = inspector.locator('[data-testid="world-inspector-appears-in"]');
  await appearsIn.waitFor({ state: "visible", timeout: 10000 });
  assert.match(await appearsIn.textContent(), /The Drowned Archive/, "the appears-in section must reflect the seeded real scene appearance (resolved via its anchor place's name), not a placeholder");
  await page.close();
});

test("route-level: GET .../entities/:id/scenes (scenesForEntity) is a real, live route returning {appearances}", async () => {
  // Anchor at a PLACE -- 30.1 also landed a place-type guard on scene
  // creation itself (locationEntityId must resolve to a "place" entity,
  // confirmed by direct run: creating a scene anchored at the person
  // fixture used elsewhere in this file 400s), so this route-level check
  // seeds the anchor role against "world-place-root" rather than the
  // person fixture.
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "world-place-root" });
  const { status, body } = await scenesForEntityViaRoute(base, WORLD, "world-place-root");
  assert.equal(status, 200, `scenesForEntity is a shipped 30.1 route, got ${status}: ${JSON.stringify(body)}`);
  assert.ok(Array.isArray(body.appearances), "response must carry an appearances array");
  const found = body.appearances.find((a) => a.scene && a.scene.id === scene.id);
  assert.ok(found, "the seeded anchor scene must appear in the appearances list");
  assert.ok(found.roles.includes("anchor"), "an anchor scene must carry the 'anchor' role");
});

test("route-level: POST .../nodes/:id/reparent is a real, live route performing an atomic reparent", async () => {
  const { status, body } = await reparentNodeViaRoute(base, WORLD, "world-place-child", "world-person-a");
  assert.equal(status, 200, `reparentNode is a shipped 30.1 route, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.entityId, "world-place-child");
  assert.equal(body.parentId, "world-person-a");

  const { nodes: _n, edges } = await (async () => {
    const res = await fetch(`${base}/api/graph?world=${WORLD}&filter=all`);
    return res.json();
  })();
  const newContainment = edges.find((e) => e.sourceId === "world-place-child" && e.targetId === "world-person-a" && e.relationshipType === "containment");
  assert.ok(newContainment, "reparent must produce a real containment edge in the live graph");
});
