// Phase 29 task 29.6 -- the reshaped inline Wrap RAIL (§8), now GREEN. Read
// phase29-fixture.mjs's §8 header FIRST. NO NEW BACKEND -- this reuses the
// EXISTING GET /api/batches/:batchId + per-mutation accept|reject + /sync
// routes (confirmed live, unmodified). This suite was inverted from its 29.0
// RED form (which asserted the rail was ABSENT and that `buildWrapPanel` only
// linked out to #review): the inline proposal-card rail now renders once a
// real batch is reachable, so this file asserts the real behaviour --
// cards render with the right kind/diff, Accept flips a card + enables Apply,
// Apply calls /sync, and nothing hits GET /api/graph before Apply (the
// no-silent-auto-write invariant, all the way through the reshaped rail).
//
// A real, reachable batch is seeded via the EXISTING, unmodified
// importWriteup() with an injected mock LLM client -- the exact pattern
// phase28-wrap.e2e.mjs established; never a hand-built review-state record.
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

// The two proposed-but-not-yet-in-graph entities the seeded batch creates.
const SEXTON = "A gaunt sexton";
const ACOLYTE = "A drowned acolyte";

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

/** Seeds a REAL, reachable batch via importWriteup() with a mocked LLM client -- TWO entity creates, so Apply can be shown to sync only the accepted subset. */
async function seedRealBatch() {
  const { entities, edges, entityTypes } = loadSnapshot(dataDir, WORLD).snapshot;
  return importWriteup(
    WORLD,
    "The party found a gaunt sexton and a drowned acolyte tending the chapel's crypt.",
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
                    entities: [
                      { tempId: "e1", name: SEXTON, type: "person", description: "Tends the drowned chapel's crypt.", rationale: "Proposed from this scene's notes." },
                      { tempId: "e2", name: ACOLYTE, type: "person", description: "Kneels in the flooded nave.", rationale: "Also proposed from this scene's notes." }
                    ],
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
}

async function openWrapAndRunNoteIntake(scene, batchId) {
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);

  await page.route(`**/api/scene-planning/scenes/${scene.id}/propose-updates`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        batchId,
        mutationCount: 2,
        importSummary: { entitiesCreated: 2, entitiesMerged: 0, edgesCreated: 0 },
        suggestions: [],
        headline: "2 new entities proposed from this scene's notes."
      })
    })
  );

  await page.goto(`${base}/#session-planner/${scene.id}`);
  const root = page.locator(`[data-testid="scene-page"][data-scene-id="${scene.id}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });

  await root.locator('[data-testid="wrap-toggle-btn"]').click();
  const panel = page.locator(`[data-testid="wrap-panel"][data-scene-id="${scene.id}"]`);
  await panel.waitFor({ state: "visible", timeout: 5000 });
  // Opening Wrap / running note-intake must NOT navigate away from the scene.
  assert.equal(await page.evaluate(() => location.hash), `#session-planner/${scene.id}`);

  await panel.locator('[data-testid="wrap-note-intake-run-btn"]').click();
  return panel;
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

test("UI: the reshaped Wrap rail renders one proposal card per mutation with the derived kind badge + diff rows -- inline, no navigation to #review", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "wr-place-a" });
  const seeded = await seedRealBatch();
  const panel = await openWrapAndRunNoteIntake(scene, seeded.batchId);

  // Cards render automatically once note-intake succeeds -- no extra click.
  const cards = panel.locator(`[data-testid="wrap-proposal-card"][data-batch-id="${seeded.batchId}"]`);
  await cards.first().waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await cards.count(), 2, "one proposal card per mutation returned by GET /api/batches/:batchId");

  // The old link-out is deliberately GONE (28.4's #review link is replaced).
  assert.equal(await panel.locator('[data-testid="wrap-review-batch-link"]').count(), 0, "29.6 replaces the link-out to #review with the inline rail");

  // The sexton card: a brand-new entity -> kind badge "new node", an added
  // (+) diff row, and NO removed (-) row (no prior value for a create).
  const sextonCard = panel.locator('[data-testid="wrap-proposal-card"]', { hasText: SEXTON });
  await sextonCard.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(
    (await sextonCard.locator('[data-testid="wrap-proposal-kind-badge"]').textContent())?.trim(),
    "new node",
    "an upsert_entity carrying diff.mjs's (created) sentinel derives the 'new node' badge client-side"
  );
  assert.equal(await sextonCard.locator('[data-testid="wrap-proposal-diff-removed"]').count(), 0, "a create has no prior value -- README §D: only render the − row when there is one");
  assert.ok(await sextonCard.locator('[data-testid="wrap-proposal-diff-added"]').count() >= 1, "the + (added) row renders from the created entity's diff");

  await page.close();
});

test("UI: Accept flips a card + enables Apply; Apply calls /sync and writes only the accepted subset to the graph -- no-silent-auto-write preserved end to end", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "wr-place-a" });
  const seeded = await seedRealBatch();
  const panel = await openWrapAndRunNoteIntake(scene, seeded.batchId);

  const cards = panel.locator(`[data-testid="wrap-proposal-card"][data-batch-id="${seeded.batchId}"]`);
  await cards.first().waitFor({ state: "visible", timeout: 10000 });

  const applyBtn = panel.locator(`[data-testid="wrap-apply-btn"][data-batch-id="${seeded.batchId}"]`);
  await applyBtn.waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await applyBtn.isDisabled(), true, "Apply is disabled-looking until at least one card is accepted (README §D)");

  // Nothing has touched the graph yet -- neither proposed entity exists.
  {
    const { nodes } = await (await fetch(`${base}/api/graph?world=${WORLD}&filter=all`)).json();
    assert.ok(!nodes.some((n) => n.name === SEXTON), "opening/rendering the rail must not write -- the sexton is not in the graph yet");
    assert.ok(!nodes.some((n) => n.name === ACOLYTE), "nor the acolyte");
  }

  // Accept exactly ONE card (the sexton), leave the other pending.
  const sextonCard = panel.locator('[data-testid="wrap-proposal-card"]', { hasText: SEXTON });
  await sextonCard.locator('[data-testid="wrap-proposal-accept"]').click();

  // The card flips to its accepted state (green-bordered, status word).
  await sextonCard.locator('.wrap-proposal-card--accepted, [data-decision="accepted"]').first()
    .waitFor({ state: "visible", timeout: 5000 })
    .catch(() => {});
  await page.waitForFunction(
    () => document.querySelector('[data-testid="wrap-proposal-card"][data-decision="accepted"]') !== null,
    null,
    { timeout: 5000 }
  );

  // The REAL per-mutation accept route ran -- the batch's own status flips.
  {
    const body = await (await fetch(`${base}/api/batches/${encodeURIComponent(seeded.batchId)}?world=${WORLD}`)).json();
    const all = body.regions.flatMap((r) => r.entities);
    const accepted = all.filter((e) => e.status === "accepted");
    assert.equal(accepted.length, 1, "exactly one mutation is accepted after clicking a single card's Accept");
    assert.equal(accepted[0].name, SEXTON, "and it is the sexton -- the card whose Accept was clicked, via the same scope:'entity' route Batch Review uses");
  }

  // Apply is now enabled.
  assert.equal(await applyBtn.isDisabled(), false, "Apply enables once >=1 card is accepted");

  // Still nothing written -- Accept only sets status; the graph is untouched
  // until Apply.
  {
    const { nodes } = await (await fetch(`${base}/api/graph?world=${WORLD}&filter=all`)).json();
    assert.ok(!nodes.some((n) => n.name === SEXTON), "accept sets status only -- no graph write until Apply");
  }

  // Apply -> /sync applies ONLY the accepted subset.
  await applyBtn.click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="wrap-proposal-rail"]')?.getAttribute("data-applied") === "true",
    null,
    { timeout: 10000 }
  );

  {
    const { nodes } = await (await fetch(`${base}/api/graph?world=${WORLD}&filter=all`)).json();
    assert.ok(nodes.some((n) => n.name === SEXTON), "the accepted sexton is now in the graph after Apply");
    assert.ok(!nodes.some((n) => n.name === ACOLYTE), "the still-pending acolyte was NOT synced -- Apply writes only the accepted subset");
  }

  await page.close();
});
