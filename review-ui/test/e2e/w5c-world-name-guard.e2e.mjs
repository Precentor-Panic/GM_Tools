// Friction Wave 1, W5c — the world-name guard, browser half: a subtle
// marker in the World tab (tree row + detail header) for an entity named
// exactly like the world, and the "shares the world's name" advisory tag on
// its review card. Non-blocking everywhere — the real kilmarn/"Kilmarn"
// shape is legitimate; the guard only kills the ambiguity during diagnosis.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase38Env,
  cleanupScratchEnv,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase38-fixture.mjs";

const { scratchDir, dataDir } = setupPhase38Env("gm-tools-e2e-w5c-guard-");
const WORLD = "kilmarn-e2e-guard";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../../mutation-engine/review-state.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  // Named exactly like the world (different casing) — the real kilmarn shape.
  { op: "upsert_entity", data: { id: "w5c-city", name: "Kilmarn-E2E-Guard", type: "place", importance: 0.8 } },
  { op: "upsert_entity", data: { id: "w5c-other", name: "The Lowway", type: "place", importance: 0.5 } }
]);

const CREATED = (data) => [{ field: "(created)", from: null, to: data }];
const batch = createBatch(
  WORLD,
  { mode: "writeup-import", text: "seed" },
  undefined,
  [
    { op: "upsert_entity", id: "wf_new_0", data: { name: "Kilmarn-E2E-Guard", type: "place", description: "The city again." }, diff: CREATED({ name: "Kilmarn-E2E-Guard" }), rationale: "r", batchId: "placeholder", sourceKind: "writeup-import" },
    { op: "upsert_entity", id: "wf_new_1", data: { name: "Harbor Shrine", type: "place", description: "A shrine." }, diff: CREATED({ name: "Harbor Shrine" }), rationale: "r", batchId: "placeholder", sourceKind: "writeup-import" }
  ],
  { makeId: () => "batch_w5c_e2e" }
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

test("W5c: the World tab marks the world-named entity in the tree and its detail header — subtle, on that entity only", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#world`);
  await page.locator('[data-testid="world-tree-row"][data-entity-id="w5c-city"]').waitFor({ state: "visible", timeout: 15000 });

  const marker = page.locator('[data-testid="world-name-marker"]');
  await marker.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await marker.count(), 1, "exactly one marked row");
  const markedRow = page.locator('[data-testid="world-tree-row"][data-entity-id="w5c-city"] [data-testid="world-name-marker"]');
  assert.equal(await markedRow.count(), 1, "…and it is the world-named entity's row");

  await page.locator('[data-testid="world-tree-row"][data-entity-id="w5c-city"]').click();
  await page.locator('[data-testid="world-name-marker-detail"]').waitFor({ state: "visible", timeout: 10000 });

  // The ordinary entity carries no marker anywhere.
  await page.locator('[data-testid="world-tree-row"][data-entity-id="w5c-other"]').click();
  await page.locator('[data-testid="world-detail"][data-entity-id="w5c-other"]').waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator('[data-testid="world-name-marker-detail"]').count(), 0);
  await page.close();
});

test("W5c: the review card renders the 'shares the world's name' tag on the world-named row only", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#chronicle/batch/${batch.id}`);
  const flagged = page.locator(`[data-testid="proposal-card"][data-mutation-id="${batch.mutations[0].mutationId}"]`);
  await flagged.waitFor({ state: "visible", timeout: 15000 });

  const tag = flagged.locator('[data-testid="proposal-card-world-name-tag"]');
  await tag.waitFor({ state: "visible", timeout: 10000 });
  assert.match(await tag.textContent(), /shares the world's name/);

  const plain = page.locator(`[data-testid="proposal-card"][data-mutation-id="${batch.mutations[1].mutationId}"]`);
  await plain.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await plain.locator('[data-testid="proposal-card-world-name-tag"]').count(), 0);
  await page.close();
});
