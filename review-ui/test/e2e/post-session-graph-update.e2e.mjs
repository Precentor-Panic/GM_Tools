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
// .mjs's own real proposeWfiFromWriteup already accepts (confirmed live).
//
// ***FIX (found live while implementing 26.9, confirmed via direct
// empirical testing, not guesswork)***: this file's ORIGINAL "ROUTE-LEVEL"
// test injected `llmOpts.client` through a real `fetch()` HTTP POST body
// (`JSON.stringify({..., llmOpts: {client: {async createMessage(){...}}}})`)
// -- but a live JS function CANNOT survive real HTTP/JSON transport at all
// (JSON.stringify silently drops function properties), regardless of the
// mock's own shape/method-naming, so `body.llmOpts.client` always arrived
// server-side as `{}`, not a working mock -- confirmed directly by
// `review-ui/test/rubber-duck-routes.test.mjs`'s own explicit, pre-existing
// comment: "proposeFramingsFromWriteup/proposeWfiFromWriteup have no
// test-time client injection seam threaded through review-ui's HTTP layer."
// This is a genuine, established architectural constraint this test's own
// header assumed didn't apply here, not something 26.9 introduced. Fixed by
// exporting session-planner/plan-updates.mjs's proposeUpdatesForPlan as a
// directly-callable op (review-ui/server.mjs's route is a thin wrapper over
// it) and calling THAT in-process here -- exactly the same
// `client: { messages: { create: async (params) => {...} } }` shape this
// project's OWN dozen+ other LLM-mocking tests already use (grep
// `messages: {` across test/*.mjs), not the mismatched `createMessage`
// shape this file originally guessed at. The real HTTP route itself is
// still exercised too (GET /api/batches/:batchId, matching this suite's own
// "reachable through Batch Review" requirement).
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
const { proposeUpdatesForPlan } = await import("../../../session-planner/plan-updates.mjs");

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

test("ROUTE-LEVEL (in-process, real injected client -- see this file's own header fix note): proposeUpdatesForPlan assembles this Plan's notes (across 2+ scenes) into writeup-shaped text and delegates to the real importWriteup pipeline, landing a real review-state batch reachable via the real HTTP batch route", async () => {
  const body = await proposeUpdatesForPlan(dataDir, WORLD, plan.id, {
    // The SAME `client: {messages: {create}}` shape this project's own
    // dozen+ other LLM-mocking tests already use (grep `messages: {` across
    // test/*.mjs) -- a genuinely working mock, since this call is
    // in-process (no HTTP/JSON boundary to strip the function).
    llmOpts: {
      client: {
        messages: {
          async create() {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  entities: [{ tempId: "e1", name: "Forgotten Shrine", type: "place", description: "A hidden shrine discovered by the party.", rationale: "Mentioned in scene one's Add Event note." }],
                  edges: [],
                  summary: "Post-session graph update from Plan notes."
                })
              }],
              stop_reason: "end_turn"
            };
          }
        }
      }
    }
  });
  assert.ok(body.batchId, "must return a real batchId -- the SAME shape importWriteup() itself returns (batchId/mutationCount/importSummary/suggestions/headline), not a bespoke shape");
  assert.ok(body.mutationCount >= 0);

  // The resulting batch must be reachable through the EXISTING, completely
  // unmodified GET /api/batches/:batchId REAL HTTP route -- never a second/
  // parallel review surface. This part genuinely goes over HTTP (no
  // function injection needed for a plain GET).
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
  // browser to make a real LLM-backed call. Called IN-PROCESS (see this
  // file's own header fix note) -- a real HTTP fetch() cannot carry a live
  // injected client function at all.
  const seedResult = await proposeUpdatesForPlan(dataDir, WORLD, plan.id, {
    llmOpts: {
      client: {
        messages: {
          async create() {
            return { content: [{ type: "text", text: JSON.stringify({ entities: [], edges: [], summary: "seed" }) }], stop_reason: "end_turn" };
          }
        }
      }
    }
  });
  const realBatchId = seedResult.batchId;
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
