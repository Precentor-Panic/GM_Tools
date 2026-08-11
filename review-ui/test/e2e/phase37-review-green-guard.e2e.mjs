// Phase 37 task 37.0 -- QE-first e2e contract, part 4: a DELIBERATE GREEN
// PIN (mirrors phase38-fixture.mjs's own "plan-delete route" precedent),
// NOT a red-for-a-reason suite. Read phase37-fixture.mjs §9 first.
//
// Per the settled decision ("#queue/#review SCREENS retire once Chronicle's
// review subsumes them (batch ROUTES stay)"): this file protects the
// EXISTING, already-shipped `/api/batches/*` routes AND the legacy
// `#review/<batchId>` deep-link screen, so that 37.3's later retirement of
// the bare `#queue`/`#review` NAV entry points can be verified, later, to
// not have regressed the underlying capability a deep link or API client
// still depends on. Every assertion below is expected to PASS TODAY --
// if any of these go red, that is a real regression in this session's own
// work (or a pre-existing baseline issue), not an expected phase37 red.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase37Env,
  cleanupScratchEnv,
  primeWorldSelection,
  DESKTOP_VIEWPORT,
  fetchBatchesViaRoute,
  fetchBatchDetailViaRoute,
  acceptMutationViaRoute
} from "./phase37-fixture.mjs";

const { scratchDir, dataDir } = setupPhase37Env("gm-tools-e2e-p37greenguard-");
const WORLD = "e2e-p37-review-green-guard";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { createBatch } = await import("../../../mutation-engine/review-state.mjs");
const { attachDiffs } = await import("../../../time-skip/run.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "p37g-waystation", name: "Ashfen Waystation", type: "place", importance: 0.5, description: "A stone-and-timber roadhouse." } }
]);

const batch = createBatch(
  WORLD,
  { mode: "ambient", elapsedSessions: 1 },
  "a pre-existing, non-Chronicle batch (the kind #queue/#review already handle today)",
  attachDiffs(
    [{ op: "upsert_entity", id: "p37g-waystation", data: { description: "Running on salt fish and rainwater." }, rationale: "scarcity", batchId: "placeholder", sourceKind: "ambient-decay" }],
    [{ id: "p37g-waystation", name: "Ashfen Waystation", type: "place", description: "A stone-and-timber roadhouse." }],
    []
  )
);

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

test("[GREEN GUARD] GET /api/batches still lists the batch, unmodified", async () => {
  const { status, body } = await fetchBatchesViaRoute(base, WORLD);
  assert.equal(status, 200);
  assert.ok(body.batches.some((b) => b.id === batch.id), "the pre-existing batch must still be listed by the unmodified listBatches route");
});

test("[GREEN GUARD] GET /api/batches/:id still returns full batch detail, unmodified", async () => {
  const { status, body } = await fetchBatchDetailViaRoute(base, WORLD, batch.id);
  assert.equal(status, 200);
  assert.equal(body.batch.id, batch.id);
  assert.ok(Array.isArray(body.regions), "batch detail payload must still carry real region/mutation data");
});

test("[GREEN GUARD] POST /api/batches/:id/accept still works end to end, unmodified", async () => {
  const mutationId = batch.mutations[0].mutationId;
  const { status, body } = await acceptMutationViaRoute(base, WORLD, batch.id, { scope: "entity", id: mutationId });
  assert.equal(status, 200, `expected the existing accept route to keep working, got ${status}: ${JSON.stringify(body)}`);
  const detail = await fetchBatchDetailViaRoute(base, WORLD, batch.id);
  const stored = detail.body.regions.flatMap((r) => r.entities).find((e) => e.mutationId === mutationId);
  assert.ok(stored, `expected to find mutation ${mutationId} among the batch detail's region entities`);
  assert.equal(stored.status, "accepted");
});

// Phase 37 task 37.3 RECONCILIATION (retire-as-superseded): the legacy
// `#review/<batchId>` SCREEN retired -- graph review is now the Chronicle's
// job (the shared proposal-card). The capability this pin protects (a
// `#review/<batchId>` deep link / handoff still reaches the real batch) is
// PRESERVED, just relocated: `#review/<batchId>` now hash-redirects to
// `#chronicle/batch/<batchId>`, which renders that same batch's detail through
// the shared proposal-card in Chronicle's "What changed" panel. Replacement
// asserted below. The route-level pins above (GET /api/batches[/:id],
// accept) are UNCHANGED -- those are the batch-ROUTE guards that must stay.
test("[GREEN GUARD] the legacy #review/<batchId> deep link redirects into Chronicle's batch detail and renders the real batch through the shared proposal-card", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#review/${batch.id}`);
  // Keep-by-hash redirect: the old deep link lands on the new home.
  await page.waitForFunction((id) => location.hash === `#chronicle/batch/${id}`, batch.id, { timeout: 15000 });
  // The shell (Chronicle surface) is the active root, not the legacy main.
  await page.locator('[data-testid="chronicle-surface-root"]').waitFor({ state: "visible", timeout: 15000 });
  // The real batch's mutation renders through the ONE shared proposal-card.
  const mutationId = batch.mutations[0].mutationId;
  await page.locator(`[data-testid="proposal-card"][data-mutation-id="${mutationId}"]`).waitFor({ state: "visible", timeout: 15000 });
  await page.close();
});
