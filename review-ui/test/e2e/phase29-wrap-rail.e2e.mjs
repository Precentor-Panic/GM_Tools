// Phase 29 task 29.0 -- reshaped inline Wrap rail (§8): proposal cards from
// the batch, per-card accept/reject, "Apply N to graph". Read
// phase29-fixture.mjs's header FIRST. NO NEW BACKEND -- this reuses the
// EXISTING GET /api/batches/:batchId + accept|reject + /sync routes
// (confirmed live, unmodified). EXPECTED TO FAIL right now: `buildWrapPanel`
// (session-planner-view.js, confirmed by direct read) renders ONLY a
// `wrap-review-batch-link` pointing out to `#review/<batchId>` -- there is
// no inline mutation rendering at all, so `wrap-proposal-card` never
// appears. That real DOM-absence is the deliverable of this task, not a bug
// in this file. Mirrors phase28-wrap.e2e.mjs's own established "mock the
// propose-updates route boundary, seed a REAL batch via importWriteup" -- a
// hand-built review-state batch record is never used.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase29Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase29-fixture.mjs";

const { scratchDir, dataDir } = setupPhase29Env("gm-tools-e2e-wraprail-");
const WORLD = "e2e-wraprail-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath, loadSnapshot } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { importWriteup } = await import("../../../graph-import/writeup-import.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "wr-place-a", name: "The Drowned Chapel", type: "place", importance: 0.5 } }
]);

let server, base, browser, page;

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

/** Seeds a REAL, reachable batch via the existing importWriteup() with a mocked LLM client -- same pattern phase28-wrap.e2e.mjs already established. Returns {batchId, mutationCount}. */
async function seedRealBatch() {
  const { entities, edges, entityTypes } = loadSnapshot(dataDir, WORLD).snapshot;
  const result = await importWriteup(
    WORLD,
    "The party found a gaunt sexton tending the drowned chapel's crypt.",
    { entities, edges, entityTypes },
    {
      llmOpts: {
        client: {
          messages: {
            async create() {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    entities: [{ tempId: "e1", name: "A gaunt sexton", type: "person", description: "Tends the drowned chapel's crypt.", rationale: "Proposed from this scene's notes." }],
                    edges: [],
                    summary: "Wrap note-intake proposal."
                  })
                }],
                stop_reason: "end_turn"
              };
            }
          }
        }
      }
    }
  );
  return result;
}

test("ROUTE LEVEL: GET /api/batches/:batchId already returns everything a proposal-card rail needs -- op/diff/rationale/status per mutation (proves this task genuinely needs NO new backend)", async () => {
  const seeded = await seedRealBatch();
  assert.ok(seeded.batchId, "test setup itself must produce a real batchId -- broken test setup, not the thing under test");

  const res = await fetch(`${base}/api/batches/${encodeURIComponent(seeded.batchId)}?world=${encodeURIComponent(WORLD)}`);
  assert.equal(res.status, 200, "the EXISTING batch-detail route must already work, unmodified");
  const body = await res.json();
  const allEntities = body.regions.flatMap((r) => r.entities);
  assert.ok(allEntities.length >= 1, "the seeded batch must carry at least one mutation for the rail to render");
  const entry = allEntities[0];
  assert.ok(entry.mutationId, "each entry needs a mutationId for the per-card accept/reject buttons to target");
  assert.equal(entry.op, "upsert_entity", "the seeded mutation's own op, sourced from the SAME existing review-state record");
  assert.ok(Array.isArray(entry.diff) && entry.diff.some((d) => d.field === "(created)"), "a brand-new entity's diff must carry diff.mjs's own '(created)' sentinel -- the client-side signal the new kind-badge derivation (§8) keys off for 'new node'");
});

test("UI (RED): Wrap panel does not render an inline proposal-card rail yet -- it only links out to #review", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "wr-place-a" });
  const seeded = await seedRealBatch();

  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  await page.route(`**/api/scene-planning/scenes/${scene.id}/propose-updates`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        batchId: seeded.batchId,
        mutationCount: 1,
        importSummary: { entitiesCreated: 1, entitiesMerged: 0, edgesCreated: 0 },
        suggestions: [],
        headline: "1 new entity proposed from this scene's notes."
      })
    })
  );

  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  await root.locator('[data-testid="wrap-toggle-btn"]').click();
  const panel = page.locator(`[data-testid="wrap-panel"][data-scene-id="${scene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });

  await panel.locator('[data-testid="wrap-note-intake-run-btn"]').click();
  // Today's implementation surfaces only wrap-review-batch-link -- this
  // suite proves the NEW proposal-card rail is genuinely absent, not that
  // note-intake itself is broken (phase28-wrap.e2e.mjs already covers the
  // link-out behaviour, unchanged, still green).
  await assert.rejects(
    async () => panel.locator(`[data-testid="wrap-proposal-card"][data-batch-id="${seeded.batchId}"]`).first().waitFor({ state: "visible", timeout: 5000 }),
    /Timeout/,
    "29.6: `wrap-proposal-card` must render once a real batch is reachable -- RED today, buildWrapPanel only renders a link out to #review, no inline mutation rendering exists"
  );

  await assert.rejects(
    async () => panel.locator('[data-testid="wrap-apply-btn"]').waitFor({ state: "visible", timeout: 3000 }),
    /Timeout/,
    "29.6: `wrap-apply-btn` ('Apply N to graph') must render in the rail footer -- RED today, absent from the DOM"
  );
  await page.close();
});
