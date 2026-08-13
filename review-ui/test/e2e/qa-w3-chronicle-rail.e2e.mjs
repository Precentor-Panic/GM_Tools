// QA re-pass wave W3, finding 3: Chronicle rail tightening.
//   (a) stale awaiting-review count -- accepting every proposal in
//       What-changed must refresh the rail's counts immediately, even under
//       the overlapping-accept race "Accept all shown" (and two fast
//       individual clicks) can produce.
//   (b) ordering -- GET /api/chronicle/log's entries[] (and, downstream,
//       fillHistory's per-section partition) must be strictly newest-first,
//       with a just-landed batch at the TOP of its section immediately.
//   (c) push-to-top + bulk resolve -- a fresh run/receive lands at the top
//       of its section without a reload, and "Accept all shown" resolves
//       every currently-displayed proposal in one action (reusing the Wrap
//       rail's own accept-all precedent: each card's own Accept button).
//
// Real, unmocked server + real headless Chromium, same convention as every
// other Chronicle e2e file in this project.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase37Env,
  cleanupScratchEnv,
  primeWorldSelection,
  DESKTOP_VIEWPORT,
  fetchChronicleLogViaRoute,
  fetchBatchDetailViaRoute
} from "./phase37-fixture.mjs";

const { scratchDir, dataDir } = setupPhase37Env("gm-tools-e2e-qaw3-rail-");
const WORLD = "e2e-qaw3-chronicle-rail";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { createBatch } = await import("../../../mutation-engine/review-state.mjs");
const { attachDiffs } = await import("../../../time-skip/run.mjs");
const { recordChronicleRun } = await import("../../../session-planner/chronicle-run.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
const ENTITIES = [
  { id: "qaw3r-forge", name: "Gorrim's Forge", type: "place", importance: 0.6 },
  { id: "qaw3r-gorrim", name: "Gorrim the Smith", type: "person", importance: 0.7 }
];
applyHeadless(snapPath, ENTITIES.map((data) => ({ op: "upsert_entity", data })));

/** Directly constructs a real, persisted, two-mutation batch with a chronicle-run sidecar -- the same shape a real Composer run produces, without paying for a real/offline LLM call. */
function makeTwoMutationBatch(promptSummary) {
  const mutations = attachDiffs([
    { op: "upsert_entity", id: "qaw3r-forge", data: { description: `${promptSummary} -- the forge changes.` }, rationale: "test", sourceKind: "manual" },
    { op: "upsert_entity", id: "qaw3r-gorrim", data: { description: `${promptSummary} -- Gorrim changes.` }, rationale: "test", sourceKind: "manual" }
  ], ENTITIES, []);
  const batch = createBatch(WORLD, { mode: "branches", branchIds: ["qaw3r-forge", "qaw3r-gorrim"], elapsedSessions: 1 }, promptSummary, mutations);
  recordChronicleRun(WORLD, batch.id, { span: { spanId: "week" }, fortuneAtRun: "middling", elapsedSessions: 1, promptSummary });
  return batch;
}

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

// ---------------------------------------------------------------------------
// (b) ordering -- route level, distinct timestamps, mixed pending/accepted.
// ---------------------------------------------------------------------------
test("GET /api/chronicle/log's entries[] are strictly newest-first, both overall and within each of the awaiting/accepted partitions fillHistory renders as sections", async () => {
  const b1 = makeTwoMutationBatch("First batch, oldest");
  await new Promise((r) => setTimeout(r, 15));
  const b2 = makeTwoMutationBatch("Second batch, middle");
  await new Promise((r) => setTimeout(r, 15));
  const b3 = makeTwoMutationBatch("Third batch, newest");

  // b1 fully accepted (old, resolved); b2 and b3 left pending (awaiting).
  for (const mid of b1.mutations.map((m) => m.mutationId)) {
    const res = await fetch(`${base}/api/batches/${b1.id}/accept`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ world: WORLD, scope: "entity", id: mid })
    });
    assert.equal(res.status, 200);
  }

  const { body } = await fetchChronicleLogViaRoute(base, WORLD);
  const order = body.entries.map((e) => e.batchRef);
  const i1 = order.indexOf(b1.id), i2 = order.indexOf(b2.id), i3 = order.indexOf(b3.id);
  assert.ok(i1 >= 0 && i2 >= 0 && i3 >= 0, `expected all three batches present -- got ${JSON.stringify(order)}`);
  assert.ok(i3 < i2, "the newest batch (b3) must sort before the middle one (b2) -- strictly newest-first");
  assert.ok(i2 < i1, "the middle batch (b2) must sort before the oldest (b1) -- strictly newest-first, regardless of accepted/pending status");

  // fillHistory's own partition (awaiting: acceptedCount===0; accepted: acceptedCount>0)
  const awaiting = body.entries.filter((e) => (e.mutationCount ?? 0) > 0 && (e.acceptedCount ?? 0) === 0);
  const accepted = body.entries.filter((e) => (e.acceptedCount ?? 0) > 0);
  const awaitingOrder = awaiting.map((e) => e.batchRef);
  assert.ok(awaitingOrder.indexOf(b3.id) < awaitingOrder.indexOf(b2.id), "within 'awaiting', b3 (newest) must be strictly before b2");
  assert.ok(accepted.map((e) => e.batchRef).includes(b1.id), "b1 (fully accepted) must be in the 'accepted' partition");
});

// ---------------------------------------------------------------------------
// (a)/(c) stale count + push-to-top -- browser-driven, real Accept clicks.
// ---------------------------------------------------------------------------
test("accepting every proposal in What-changed refreshes the rail's 'Awaiting review' count immediately -- no stale count, no reload", async () => {
  const batch = makeTwoMutationBatch("Stale-count repro batch");
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#chronicle/batch/${batch.id}`);
  await page.locator('[data-testid="chronicle-proposals"]').waitFor({ state: "visible", timeout: 15000 });

  const awaitingHeader = page.locator('[data-testid="chronicle-history-awaiting-header"]');
  await awaitingHeader.waitFor({ state: "visible", timeout: 10000 });
  const before = await awaitingHeader.innerText();
  // The header's real textContent is "Awaiting review (N)" -- style.css
  // uppercases it visually (text-transform), and innerText() reflects the
  // RENDERED (post-CSS) text, so match case-insensitively.
  assert.match(before, /awaiting review \((\d+)\)/i);
  const beforeCount = Number(before.match(/\((\d+)\)/)[1]);
  assert.ok(beforeCount >= 1, "this fresh, fully-pending batch must be counted in 'awaiting' before any decision");

  const cards = page.locator('[data-testid="proposal-card"]');
  assert.equal(await cards.count(), 2);
  await cards.nth(0).locator('[data-testid="proposal-card-accept-btn"]').click();
  await cards.nth(1).locator('[data-testid="proposal-card-accept-btn"]').click();

  // Both decisions must land server-side...
  await page.waitForFunction(async (args) => {
    const res = await fetch(`/api/batches/${args.batchId}?world=${args.world}`);
    const body = await res.json();
    const ents = (body.regions || []).flatMap((r) => r.entities || []);
    return ents.every((e) => e.status === "accepted");
  }, { batchId: batch.id, world: WORLD }, { timeout: 15000 });

  // ...and the rail's count must reflect it WITHOUT a reload: this batch
  // fully leaves "awaiting" (acceptedCount === mutationCount now), so the
  // count must strictly decrease by (at least) one full batch's worth.
  await page.waitForFunction((expected) => {
    const el = document.querySelector('[data-testid="chronicle-history-awaiting-header"]');
    if (!el) return true; // the whole section can legitimately disappear if this was the only awaiting entry
    const m = el.textContent.match(/\((\d+)\)/);
    return !m || Number(m[1]) < expected;
  }, beforeCount, { timeout: 10000 });

  const batchRow = page.locator(`[data-testid="chronicle-history-entry"][data-batch-id="${batch.id}"]`);
  await batchRow.waitFor({ state: "visible", timeout: 10000 });
  assert.ok((await batchRow.innerText()).includes("2 accepted"), "the rail row itself must reflect both real accepted mutations, not a frozen pre-decision snapshot");
  await page.close();
});

test("'Accept all shown' drives every currently-displayed card's own Accept button (one path, the Wrap rail's precedent) and the rail updates without reload", async () => {
  const batch = makeTwoMutationBatch("Accept-all-shown repro batch");
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#chronicle/batch/${batch.id}`);
  await page.locator('[data-testid="chronicle-proposals"]').waitFor({ state: "visible", timeout: 15000 });

  const acceptAllBtn = page.locator('[data-testid="chronicle-accept-all-btn"]');
  await acceptAllBtn.waitFor({ state: "visible", timeout: 10000 });
  await acceptAllBtn.click();

  const cards = page.locator('[data-testid="proposal-card"]');
  await page.waitForFunction(() => {
    const els = [...document.querySelectorAll('[data-testid="proposal-card"]')];
    return els.length > 0 && els.every((e) => e.getAttribute("data-decided") === "yes");
  }, { timeout: 15000 });
  assert.equal(await cards.count(), 2);

  const { body } = await fetchBatchDetailViaRoute(base, WORLD, batch.id);
  const ents = (body.regions || []).flatMap((r) => r.entities || []);
  assert.ok(ents.every((e) => e.status === "accepted"), "every mutation must be genuinely accepted server-side, not just visually");
  await page.close();
});

test("push-to-top: clicking 'Let time pass' in the SAME open page lands the new batch's rail entry at the TOP of the 'awaiting' section immediately, ahead of an older pending batch, with NO navigation/reload in between", async () => {
  const older = makeTwoMutationBatch("Older pending batch, pre-existing");

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#chronicle`);
  await page.locator('[data-testid="chronicle-composer"]').waitFor({ state: "visible", timeout: 15000 });
  const awaitingHost = page.locator('[data-testid="chronicle-history-awaiting"]');
  await awaitingHost.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction((id) => {
    const first = document.querySelector('[data-testid="chronicle-history-awaiting"] [data-testid="chronicle-history-entry"]');
    return first && first.getAttribute("data-batch-id") === id;
  }, older.id, { timeout: 10000 });

  // queued-intents + a typed prompt is the ONE scope proven (37.5's own
  // pinned test) to always yield >=1 real mutation even under the offline
  // degrade -- everything else in this file's fixture has no edges to
  // propagate across, so branches/whole-world offline runs can legitimately
  // yield zero regions (a real, separate deterministic-code behavior, not
  // what this test is about). No page navigation anywhere below -- runAdvance()
  // updates the rail via the SAME in-place applyBatchAsProposals() path the
  // Accept-flow tests above already exercise.
  await page.locator('[data-testid="chronicle-prompt-input"]').fill("A sudden storm floods the smithy overnight.");
  await page.locator('[data-testid="chronicle-run-btn"]').click();
  await page.locator('[data-testid="chronicle-proposals"]').waitFor({ state: "visible", timeout: 20000 });

  const firstEntry = awaitingHost.locator('[data-testid="chronicle-history-entry"]').first();
  await page.waitForFunction((olderId) => {
    const first = document.querySelector('[data-testid="chronicle-history-awaiting"] [data-testid="chronicle-history-entry"]');
    return first && first.getAttribute("data-batch-id") !== olderId;
  }, older.id, { timeout: 10000 });
  const topBatchId = await firstEntry.getAttribute("data-batch-id");
  assert.notEqual(topBatchId, older.id, "the freshly-run batch must overtake the older pending batch at the top of the awaiting section");
  assert.equal(await page.evaluate(() => location.hash), "#chronicle", "no navigation happened -- the rail updated in place");
  await page.close();
});
