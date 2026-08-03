// Phase 23 task 23.0, REQUIRED SCENARIO 5 -- "Develop-node vs. Develop-scene
// as genuine peer buttons: both visible, neither default/automatic;
// Develop-scene triggers the real batch orchestrator and surfaces PER-NODE
// review (accept/discard), never a silent whole-batch auto-apply -- assert
// the existing accept/discard gate is what actually commits each node's
// result, not a bypass." Read scene-construction-fixture.mjs's header first
// (§4 is this file's own section). EXPECTED TO FAIL right now with a
// Playwright selector-not-found/timeout error -- none of this DOM exists
// yet. That failure is the deliverable of this task, not a bug in this file.
//
// EVERY prep-content route in this file is MOCKED via page.route()
// (route.fulfill()) -- this environment has no ANTHROPIC_API_KEY
// (combat-planning-fixture.mjs's own established header note), and
// prep-content-ops.mjs's propose-framings/generate calls are real LLM calls.
// This matches this project's established "unit/e2e test with the LLM call
// mocked at the HTTP boundary" convention (see
// combat-planning-loading-scope.e2e.mjs's own identical approach). The
// mocked routes are call-count-and-payload SPIES (assert.equal on how many
// times / with what body each was hit), not just stubs -- this is what lets
// this file actually prove "the existing accept/discard gate is what
// commits, not a bypass": if the implementation ever called some OTHER,
// new route to accept a batch result, these intercepts (scoped to the exact
// existing `/api/entities/:id/prep/*` paths) would simply never fire and the
// assertions on their call counts would fail loudly.
//
// FIXTURE: one scene, anchor "develop-anchor" plus one 1-hop satellite
// "develop-satellite" (both real graph entities, real edge) -- exactly 2
// scene members, so develop-scene's own memberEntityIds payload has a
// small, exactly-assertable expected set.
//
// ***EXTENDED by Phase 27 task 27.0*** (F9: an "only undeveloped nodes"
// option on develop-scene). Read phase27-fixture.mjs's header §5 for the
// contract. EXPECTED TO FAIL right now -- `develop-scene-undeveloped-only-
// toggle` doesn't exist yet, and onDevelopScene's real memberIds computation
// (confirmed fresh against the real session-planner-view.js) always sends
// the FULL member set regardless of contentFlag, so the filtered-payload
// assertion below currently fails. Fixture extended with a THIRD member,
// "develop-satellite-developed" (also 1-hop, real edge), pre-seeded with
// real entity narration via mutation-engine/entity-narration.mjs's
// saveEntityNarration (so its own contentFlag.flagged reads false, "already
// developed") -- "develop-anchor"/"develop-satellite" both stay genuinely
// UNDEVELOPED (no narration ever seeded for them), giving this file a
// real, deterministic flagged/unflagged split to filter against.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupSceneConstructionEnv, cleanupScratchEnv, DESKTOP_VIEWPORT, createSceneViaRoute, primeWorldSelection } from "./scene-construction-fixture.mjs";

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-scconstruct-develop-");
const WORLD = "e2e-scconstruct-develop-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "develop-anchor", name: "Develop Anchor", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "develop-satellite", name: "Develop Satellite", type: "person", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "develop-satellite-developed", name: "Develop Satellite Already-Developed", type: "person", importance: 0.5 } },
  { op: "upsert_edge", data: { id: "develop-e0", sourceId: "develop-anchor", targetId: "develop-satellite", relationshipType: "unspecified" } },
  { op: "upsert_edge", data: { id: "develop-e1", sourceId: "develop-anchor", targetId: "develop-satellite-developed", relationshipType: "unspecified" } }
]);

const { saveEntityNarration } = await import("../../../mutation-engine/entity-narration.mjs");
saveEntityNarration(WORLD, "develop-satellite-developed", { prose: "Already fully written up." });

let server, base, browser, page;
let scene;

const FAKE_FRAMINGS = [{ id: "a", sentence: "Framing A" }, { id: "b", sentence: "Framing B" }];

function mockPrepRoutes(pg, calls) {
  return pg.route("**/api/entities/*/prep/**", async (route) => {
    const url = new URL(route.request().url());
    const entityId = decodeURIComponent(url.pathname.split("/")[3]);
    const action = url.pathname.split("/").pop();
    calls.push({ entityId, action, body: route.request().postDataJSON?.() ?? null });
    if (action === "propose-framings") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ framings: FAKE_FRAMINGS, framingRound: 1 }) });
    }
    if (action === "generate") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "proposed", framingUsed: "Framing A", fields: { description: `Generated content for ${entityId}` } }) });
    }
    if (action === "accept") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "accepted", framingUsed: "Framing A", fields: { description: `Generated content for ${entityId}` } }) });
    }
    if (action === "discard") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    return route.continue();
  });
}

function mockSceneDevelopRoute(pg, calls) {
  return pg.route("**/api/scene-planning/scenes/*/develop", async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    const url = new URL(route.request().url());
    const sceneIdFromUrl = decodeURIComponent(url.pathname.split("/")[4]); // /api/scene-planning/scenes/:sceneId/develop
    const results = (body.memberEntityIds ?? []).map((entityId) => ({ entityId, ok: true, stage: "framed", framings: FAKE_FRAMINGS }));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sceneId: sceneIdFromUrl, results }) });
  });
}

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "develop-anchor" });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("develop-node and develop-scene are both visible peer buttons; neither fires a network call on plain scene load", async () => {
  const prepCalls = [];
  const developCalls = [];
  await mockPrepRoutes(page, prepCalls);
  await mockSceneDevelopRoute(page, developCalls);

  await page.goto(`${base}/#session-planner/${scene.id}`);
  const anchorCard = page.locator(`[data-testid="location-card"][data-entity-id="develop-anchor"]`);
  await anchorCard.waitFor({ state: "visible", timeout: 15000 });

  const developNodeBtn = anchorCard.locator('[data-testid="develop-node-btn"]');
  const developSceneBtn = page.locator(`[data-testid="develop-scene-btn"][data-scene-id="${scene.id}"]`);
  await developNodeBtn.waitFor({ state: "visible", timeout: 5000 });
  await developSceneBtn.waitFor({ state: "visible", timeout: 5000 });

  assert.equal(await developNodeBtn.isEnabled(), true, "develop-node must be immediately usable, not gated behind develop-scene");
  assert.equal(await developSceneBtn.isEnabled(), true, "develop-scene must be immediately usable, not gated behind develop-node");

  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(prepCalls.length, 0, "no prep route may fire just from loading the scene view");
  assert.equal(developCalls.length, 0, "the batch develop route must never fire automatically on scene load");

  await page.unroute("**/api/entities/*/prep/**");
  await page.unroute("**/api/scene-planning/scenes/*/develop");
});

test("develop-scene surfaces per-node review; generating/accepting one node's result never affects the other node, and accept goes through the EXISTING single-node accept route", async () => {
  const prepCalls = [];
  const developCalls = [];
  await mockPrepRoutes(page, prepCalls);
  await mockSceneDevelopRoute(page, developCalls);

  await page.goto(`${base}/#session-planner/${scene.id}`);
  const developSceneBtn = page.locator(`[data-testid="develop-scene-btn"][data-scene-id="${scene.id}"]`);
  await developSceneBtn.waitFor({ state: "visible", timeout: 15000 });
  await developSceneBtn.click();

  assert.equal(developCalls.length >= 1, true, "develop-scene click must call the real batch develop route");
  assert.deepEqual(
    [...developCalls[0].memberEntityIds].sort(),
    // Phase 27 task 27.0 extended this file's own fixture with a third
    // member ("develop-satellite-developed", pre-seeded with real
    // narration) to give the NEW "only undeveloped nodes" test below a
    // real flagged/unflagged split -- the default (unchecked) develop-scene
    // call must still include EVERY member, unfiltered.
    ["develop-anchor", "develop-satellite", "develop-satellite-developed"],
    "the batch develop call must include every current scene member (default: unfiltered)"
  );

  const reviewPanel = page.locator(`[data-testid="develop-scene-review-panel"][data-scene-id="${scene.id}"]`);
  await reviewPanel.waitFor({ state: "visible", timeout: 10000 });

  const nodeAnchor = reviewPanel.locator('[data-testid="develop-scene-review-node"][data-entity-id="develop-anchor"]');
  const nodeSatellite = reviewPanel.locator('[data-testid="develop-scene-review-node"][data-entity-id="develop-satellite"]');
  await nodeAnchor.waitFor({ state: "visible", timeout: 5000 });
  await nodeSatellite.waitFor({ state: "visible", timeout: 5000 });

  // Nothing accepted/discarded yet -- pure propose-only results so far.
  const acceptCallsBefore = prepCalls.filter((c) => c.action === "accept").length;
  assert.equal(acceptCallsBefore, 0, "develop-scene's own propose pass must never call accept itself -- that would be a silent whole-batch auto-apply");

  // Pick a framing + generate for the ANCHOR node only.
  const anchorFraming = nodeAnchor.locator('[data-testid="develop-scene-review-framing-option"][data-framing-id="a"]');
  await anchorFraming.waitFor({ state: "visible", timeout: 5000 });
  await anchorFraming.click();
  await nodeAnchor.locator('[data-testid="develop-scene-review-generate-btn"]').click();

  await nodeAnchor.locator('[data-testid="develop-scene-review-content"]').waitFor({ state: "visible", timeout: 10000 });

  // The SATELLITE node must be entirely unaffected -- still just showing
  // its own framing picker, no content, no accept/discard controls yet.
  assert.equal(
    await nodeSatellite.locator('[data-testid="develop-scene-review-content"]').count(),
    0,
    "generating content for the anchor node must not also generate content for the satellite node"
  );

  const generateCallsForSatellite = prepCalls.filter((c) => c.entityId === "develop-satellite" && c.action === "generate");
  assert.equal(generateCallsForSatellite.length, 0, "no generate call should have been made for the satellite node yet");

  // Accept the anchor node's result -- must go through the EXISTING
  // single-node accept route, scoped to develop-anchor specifically.
  const acceptBtn = nodeAnchor.locator('[data-testid="develop-scene-review-accept-btn"]');
  await acceptBtn.waitFor({ state: "visible", timeout: 5000 });
  await acceptBtn.click();

  await assert.doesNotReject(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  const acceptCalls = prepCalls.filter((c) => c.action === "accept");
  assert.equal(acceptCalls.length, 1, "exactly one accept call must fire, for exactly the node that was accepted");
  assert.equal(acceptCalls[0].entityId, "develop-anchor");

  const satelliteAcceptCalls = prepCalls.filter((c) => c.entityId === "develop-satellite" && c.action === "accept");
  assert.equal(satelliteAcceptCalls.length, 0, "accepting the anchor node's result must never also accept the satellite node's -- proves no whole-batch auto-apply");

  await page.unroute("**/api/entities/*/prep/**");
  await page.unroute("**/api/scene-planning/scenes/*/develop");
});

// ---------------------------------------------------------------------------
// Phase 27 task 27.0 (F9) -- "only undeveloped nodes" option.
// ---------------------------------------------------------------------------
test("develop-scene's 'only undeveloped nodes' option filters memberEntityIds to the flagged (undeveloped) subset before the develop call fires", async () => {
  const prepCalls = [];
  const developCalls = [];
  await mockPrepRoutes(page, prepCalls);
  await mockSceneDevelopRoute(page, developCalls);

  await page.goto(`${base}/#session-planner/${scene.id}`);
  const actionsBar = page.locator(`[data-testid="scene-actions-bar"][data-scene-id="${scene.id}"]`);
  await actionsBar.waitFor({ state: "visible", timeout: 15000 });

  const toggle = actionsBar.locator(`[data-testid="develop-scene-undeveloped-only-toggle"][data-scene-id="${scene.id}"]`);
  await toggle.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await toggle.isChecked(), false, "the only-undeveloped option must default to UNCHECKED (unchanged default behavior)");
  await toggle.check();

  const developSceneBtn = page.locator(`[data-testid="develop-scene-btn"][data-scene-id="${scene.id}"]`);
  await developSceneBtn.click();

  await assert.doesNotReject(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  assert.equal(developCalls.length, 1, "develop-scene must still fire exactly one batch develop call with the toggle checked");
  assert.deepEqual(
    [...developCalls[0].memberEntityIds].sort(),
    ["develop-anchor", "develop-satellite"],
    "with 'only undeveloped nodes' checked, the develop call's memberEntityIds must be filtered to ONLY the members whose brief contentFlag.flagged is true -- 'develop-satellite-developed' (already-narrated) must be excluded"
  );

  await page.unroute("**/api/entities/*/prep/**");
  await page.unroute("**/api/scene-planning/scenes/*/develop");
});

test("develop-scene's default (unchecked) behavior is genuinely unchanged -- unfiltered, full member set", async () => {
  const prepCalls = [];
  const developCalls = [];
  await mockPrepRoutes(page, prepCalls);
  await mockSceneDevelopRoute(page, developCalls);

  await page.goto(`${base}/#session-planner/${scene.id}`);
  const developSceneBtn = page.locator(`[data-testid="develop-scene-btn"][data-scene-id="${scene.id}"]`);
  await developSceneBtn.waitFor({ state: "visible", timeout: 15000 });
  await developSceneBtn.click();

  await assert.doesNotReject(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  assert.deepEqual(
    [...developCalls[0].memberEntityIds].sort(),
    ["develop-anchor", "develop-satellite", "develop-satellite-developed"],
    "leaving the only-undeveloped option unchecked must send every current member, unfiltered -- unchanged default behavior"
  );

  await page.unroute("**/api/entities/*/prep/**");
  await page.unroute("**/api/scene-planning/scenes/*/develop");
});
