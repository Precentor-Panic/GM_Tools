// Phase 26 task 26.0, REQUIRED SCENARIO 8 -- "Post-session graph-update:
// seed scene notes across 2+ scenes in a Plan, trigger the propose-updates
// action, assert it produces a real review-state batch reachable through
// the existing Batch Review screen (mocked LLM call, matching this
// project's established convention)." Read phase26-fixture.mjs's header
// FIRST (§8 is this file's own section). EXPECTED TO FAIL right now with a
// real HTTP 404 -- `POST /api/scene-planning/plans/:planId/propose-updates`
// doesn't exist yet (per plans/phase-26-tasks.md task 26.9). That failure
// is the deliverable of this task, not a bug in this file.
//
// Per §26.E: this task is "a thin composition, not new LLM plumbing" --
// this file's route-level test therefore does NOT re-verify writeup-import
// .mjs's own LLM-extraction correctness (already covered by that module's
// own tests) -- it verifies ONLY the NEW assembly/delegation contract:
// resolving a Plan's scenes' notes, assembling writeup-shaped text, and
// landing a real batch reachable via the EXISTING, unmodified Batch Review
// screen. The underlying LLM call is injected via the SAME
// opts.llmOpts.client dependency-injection seam graph-import/writeup-import
// .mjs's own real proposeWfiFromWriteup already accepts (confirmed live) --
// this suite is NOT the first to use it (mirrors this project's established
// convention for testing writeup-import-backed routes without a real
// ANTHROPIC_API_KEY), so this is reusing prior art, not inventing a new
// test-only backdoor.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase26Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase26-fixture.mjs";

const { scratchDir, dataDir } = setupPhase26Env("gm-tools-e2e-postsession-");
const WORLD = "e2e-postsession-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "postsession-anchor-1", name: "Postsession Anchor One", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "postsession-anchor-2", name: "Postsession Anchor Two", type: "place", importance: 0.5 } }
]);

let server, base, browser, page;
let sceneOne, sceneTwo, plan;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  sceneOne = await createSceneViaRoute(base, WORLD, { locationEntityId: "postsession-anchor-1" });
  sceneTwo = await createSceneViaRoute(base, WORLD, { locationEntityId: "postsession-anchor-2" });
  plan = await createPlanViaRoute(base, WORLD, "Post-Session Update Plan");
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneOne.id);
  await addSceneToPlanViaRoute(base, WORLD, plan.id, sceneTwo.id);

  // Real Add Event notes, via the EXISTING captureNote route, across BOTH
  // scenes in the Plan -- exactly mirroring how Add Event itself already
  // captures notes.
  await fetch(`${base}/api/session-planner/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, text: "The party discovered a hidden shrine to a forgotten god.", anchorEntityId: "postsession-anchor-1", sceneId: sceneOne.id })
  });
  await fetch(`${base}/api/session-planner/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, text: "A local guard captain offered to join the party as an ally.", anchorEntityId: "postsession-anchor-2", sceneId: sceneTwo.id })
  });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("ROUTE-LEVEL: POST /api/scene-planning/plans/:planId/propose-updates assembles this Plan's notes (across 2+ scenes) into writeup-shaped text and delegates to the real importWriteup pipeline, landing a real review-state batch", async () => {
  const res = await fetch(`${base}/api/scene-planning/plans/${plan.id}/propose-updates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      world: WORLD,
      // The SAME injectable client seam proposeWfiFromWriteup's own tests
      // already use for a deterministic, API-key-free extraction result.
      llmOpts: {
        client: {
          async createMessage() {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  entities: [{ tempId: "e1", name: "Forgotten Shrine", type: "place", description: "A hidden shrine discovered by the party." }],
                  edges: [],
                  summary: "Post-session graph update from Plan notes."
                })
              }]
            };
          }
        }
      }
    })
  });
  const body = await res.json();
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.batchId, "must return a real batchId -- the SAME shape importWriteup() itself returns (batchId/mutationCount/importSummary/suggestions/headline), not a bespoke shape");
  assert.ok(body.mutationCount >= 0);

  // The resulting batch must be reachable through the EXISTING, completely
  // unmodified GET /api/batches/:batchId route -- never a second/parallel
  // review surface.
  const batchRes = await fetch(`${base}/api/batches/${body.batchId}`);
  const batchBody = await batchRes.json();
  assert.equal(batchRes.status, 200, `the produced batch must be a real, fetchable batch via the EXISTING /api/batches/:batchId route (got ${batchRes.status}: ${JSON.stringify(batchBody)})`);
  assert.ok(batchBody.batch, "the real batch record must exist and be loadable");

  // The assembled text passed to the LLM must have been grouped by scene,
  // each prefixed with that scene's display name -- confirmed indirectly by
  // checking the batch's own persisted scope.text (writeup-import.mjs's
  // established convention of storing the original source text on the
  // batch, confirmed live), per §26.E's explicit "grouped by scene, each
  // scene's notes prefixed with its name and anchor-location name" wording.
  assert.match(batchBody.batch.scope?.text ?? "", /Postsession Anchor One/, "the assembled writeup text must be grounded with scene one's own anchor location name");
  assert.match(batchBody.batch.scope?.text ?? "", /Postsession Anchor Two/, "the assembled writeup text must be grounded with scene two's own anchor location name");
  assert.match(batchBody.batch.scope?.text ?? "", /hidden shrine/i, "scene one's own note text must be present in the assembled writeup");
  assert.match(batchBody.batch.scope?.text ?? "", /guard captain/i, "scene two's own note text must be present in the assembled writeup");
});

test("UI-LEVEL (mocked route, matching this project's established convention): the Plan view's 'Propose graph updates' action calls the real route and navigates to the produced batch in Batch Review", async () => {
  // First, create a REAL batch (unmocked, real in-process call, injected
  // LLM client -- no ANTHROPIC_API_KEY needed) so there is a genuinely
  // reachable navigation target. The page-level mock below then stands in
  // for the (slow, real-LLM) network round trip itself, returning that
  // SAME real batchId -- proving the UI wires the button through to
  // wherever the route's response points, without this test needing the
  // browser to make a real LLM-backed call.
  const seedRes = await fetch(`${base}/api/scene-planning/plans/${plan.id}/propose-updates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      world: WORLD,
      llmOpts: {
        client: {
          async createMessage() {
            return { content: [{ type: "text", text: JSON.stringify({ entities: [], edges: [], summary: "seed" }) }] };
          }
        }
      }
    })
  });
  const { batchId: realBatchId } = await seedRes.json();
  assert.ok(realBatchId, "test setup itself must produce a real batchId -- broken test setup, not the thing under test");

  await page.route(`**/api/scene-planning/plans/${plan.id}/propose-updates`, async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        batchId: realBatchId,
        mutationCount: 1,
        importSummary: { entitiesCreated: 1, entitiesMerged: 0, edgesCreated: 0 },
        suggestions: [],
        headline: "1 new entity proposed from this Plan's session notes."
      })
    });
  });

  await page.goto(`${base}/#session-planner/${sceneOne.id}?mode=table`);
  await page.waitForSelector('[data-testid="table-mode-view"]', { timeout: 15000 });

  const proposeBtn = page.locator(`[data-testid="propose-graph-updates-btn"][data-plan-id="${plan.id}"]`);
  await proposeBtn.waitFor({ state: "visible", timeout: 10000 });
  await proposeBtn.click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (expected) => location.hash === `#review/${expected}`,
      realBatchId,
      { timeout: 10000 }
    );
  }, "clicking 'Propose graph updates' must navigate to the produced batch's Batch Review screen (#review/<batchId>), the EXISTING review surface -- never a second/parallel one");
});
