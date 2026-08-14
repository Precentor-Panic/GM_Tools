// Friction Wave 1, W1f -- REGRESSION TEST, written to fail against the
// pre-fix code (verified by actually running it there, per this repo's
// culture): the Chronicle review-mode toggle ("Every change" <-> "Triaged")
// is a VIEW filter and must never lose accept/reject selections already
// made. Pre-fix mechanism (root-caused by reading proposal-card.js): each
// card's decide() updated only its own closure-local `decided` and painted
// itself -- it never wrote the decision back onto the shared
// state.proposals mutation object -- so paintReviewToggle -> paintProposals
// re-rendered every card from the STALE pre-decision statuses and the
// just-made selections visually vanished (the reported "toggling it seems
// to clear accept/reject selections already made"). The server state was
// never wrong; the view was.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase37Env,
  cleanupScratchEnv,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase37-fixture.mjs";

const { scratchDir, dataDir } = setupPhase37Env("gm-tools-e2e-w1f-");
const WORLD = "e2e-w1f-triage-toggle";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { createBatch, loadBatch } = await import("../../../mutation-engine/review-state.mjs");
const { attachDiffs } = await import("../../../time-skip/run.mjs");

const liveEntities = [
  { id: "vane", name: "Master Aldric Vane", type: "person", importance: 0.7, description: "Guildmaster of the weavers." },
  { id: "skein", name: "The Skein", type: "place", importance: 0.5, description: "The weavers' quarter." }
];
const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, liveEntities.map((e) => ({ op: "upsert_entity", data: e })));

function wm(extra) {
  return { rationale: "from the writeup", batchId: "placeholder", sourceKind: "writeup-import", ...extra };
}
const batch = createBatch(
  WORLD,
  { mode: "writeup-import", text: "seed" },
  undefined,
  attachDiffs(
    [
      wm({ op: "upsert_entity", id: "wf_new_0", data: { name: "The Underbreach", type: "place", description: "A sunken quarter." } }),
      wm({ op: "upsert_entity", id: "vane", data: { description: "Guildmaster of the weavers. Also placed the fate-threads." } }),
      wm({ op: "upsert_entity", id: "skein", data: { description: "Now hung with wrong-colored thread." } })
    ],
    liveEntities,
    []
  )
);
const [mCreate, mAppend, mReplace] = batch.mutations.map((m) => m.mutationId);

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

test("[W1f REGRESSION] the Triaged toggle never clears accept/reject selections already made", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#chronicle/batch/${batch.id}`);

  const cardSel = (mid) => `[data-testid="proposal-card"][data-mutation-id="${mid}"]`;
  await page.locator(cardSel(mCreate)).waitFor({ state: "visible", timeout: 15000 });

  // Make two real decisions in list ("Every change") mode.
  await page.locator(`${cardSel(mCreate)} [data-testid="proposal-card-accept-btn"]`).click();
  await page.waitForSelector(`${cardSel(mCreate)}[data-decided="yes"]`, { timeout: 15000 });
  await page.locator(`${cardSel(mReplace)} [data-testid="proposal-card-reject-btn"]`).click();
  await page.waitForSelector(`${cardSel(mReplace)}[data-decided="no"]`, { timeout: 15000 });

  // Server state really did persist (the pre-fix bug is view-only).
  const persisted = loadBatch(WORLD, batch.id);
  assert.equal(persisted.mutations.find((m) => m.mutationId === mCreate).status, "accepted");
  assert.equal(persisted.mutations.find((m) => m.mutationId === mReplace).status, "rejected");

  // Flip the VIEW filter to Triaged -- the decisions must survive the re-render.
  await page.locator('[data-testid="chronicle-review-mode-btn"][data-mode="triage"]').click();
  await page.locator('[data-testid="chronicle-triage-bucket"]').first().waitFor({ state: "visible", timeout: 15000 });
  await page.waitForSelector(cardSel(mCreate), { timeout: 15000 });
  assert.equal(await page.locator(cardSel(mCreate)).getAttribute("data-decided"), "yes",
    "the accepted card must still read accepted after toggling to Triaged (pre-fix: cleared to '')");
  assert.equal(await page.locator(cardSel(mReplace)).getAttribute("data-decided"), "no",
    "the rejected card must still read rejected after toggling to Triaged (pre-fix: cleared to '')");
  assert.equal(await page.locator(cardSel(mAppend)).getAttribute("data-decided"), "",
    "the undecided card stays undecided -- no false carry-over either");

  // And back to the flat list -- still intact.
  await page.locator('[data-testid="chronicle-review-mode-btn"][data-mode="list"]').click();
  await page.waitForSelector(cardSel(mCreate), { timeout: 15000 });
  assert.equal(await page.locator(cardSel(mCreate)).getAttribute("data-decided"), "yes");
  assert.equal(await page.locator(cardSel(mReplace)).getAttribute("data-decided"), "no");

  await page.close();
});

test("[W1f] Triaged mode groups a risk-bearing batch into more than one bucket (the 'appears broken' half)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#chronicle/batch/${batch.id}`);
  await page.locator('[data-testid="proposal-card"]').first().waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="chronicle-review-mode-btn"][data-mode="triage"]').click();
  const buckets = page.locator('[data-testid="chronicle-triage-bucket"]');
  await buckets.first().waitFor({ state: "visible", timeout: 15000 });
  // The fixture spans a create ('look'-stamped), an append ('safe'), and a
  // destructive replace (W1e-upgraded to 'contradict') -- with W1e's
  // effective risk these must land in DIFFERENT buckets, not one lump.
  assert.ok((await buckets.count()) >= 2, "a mixed batch must group into at least two triage buckets");
  await page.close();
});
