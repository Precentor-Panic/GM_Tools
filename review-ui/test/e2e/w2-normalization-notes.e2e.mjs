// Friction Wave 1 -- W2a/W2b in real headless Chromium: the writeup-import
// pre-dry-run normalization notes actually RENDER on review cards. The batch
// is produced by the REAL importWriteup pipeline (mocked LLM client, real
// normalization + importGraph dry-run + diff) against a real on-disk
// snapshot, so what the cards show is exactly what a real Kilmarn resubmit
// would produce -- not hand-stamped display data.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase37Env,
  cleanupScratchEnv,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase37-fixture.mjs";

const { scratchDir, dataDir } = setupPhase37Env("gm-tools-e2e-w2norm-");
const WORLD = "e2e-w2-normalization";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath, loadSnapshot } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { importWriteup } = await import("../../../graph-import/writeup-import.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "wf_bridge", name: "Kilmarn Bridge", type: "object", importance: 0.6, description: "A stone bridge." } },
  { op: "upsert_entity", data: { id: "wf_lowway", name: "The Lowway", type: "place", importance: 0.6, description: "A sunken street." } }
]);

function mockClient(response) {
  return { messages: { create: async () => ({ content: [{ type: "text", text: response }], stop_reason: "end_turn" }) } };
}
const extraction = JSON.stringify({
  entities: [
    { name: "Kilmarn Bridge", type: "place", description: "A stone bridge. Threads are tied to the span.", rationale: "Ceremony site." },
    { name: "Lowway", type: "place", description: "A sunken street. Smugglers pass beneath.", rationale: "Mentioned in passing." },
    { name: "Brand-New Shrine", type: "place", description: "A new shrine.", rationale: "Introduced fresh." }
  ],
  edges: []
});
const { snapshot } = loadSnapshot(dataDir, WORLD);
const result = await importWriteup(WORLD, "seed text", snapshot, { llmOpts: { client: mockClient(extraction) } });

let server, base, browser, page;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#chronicle/batch/${result.batchId}`);
  await page.locator('[data-testid="proposal-card"]').first().waitFor({ state: "visible", timeout: 20000 });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("W2a/W2b: normalization notes render on the affected cards -- and only there", async () => {
  const notes = page.locator('[data-testid="proposal-card-normalization"]');
  assert.equal(await notes.count(), 2, "exactly the two normalized rows carry a note");

  const typeNote = page.locator('[data-testid="proposal-card-normalization"][data-normalization-kind="type-conflict-resolved"]');
  assert.equal(await typeNote.count(), 1);
  const typeText = await typeNote.innerText();
  assert.match(typeText, /same name, different type/i);
  assert.match(typeText, /already exists with type “object”/i);
  assert.match(typeText, /guessed “place”/i);

  const renameNote = page.locator('[data-testid="proposal-card-normalization"][data-normalization-kind="near-miss-rename"]');
  assert.equal(await renameNote.count(), 1);
  const renameText = await renameNote.innerText();
  assert.match(renameText, /matched to canon/i);
  assert.match(renameText, /“Lowway”/);
  assert.match(renameText, /“The Lowway”/);

  // The untouched brand-new create carries no note.
  const shrineCard = page.locator('[data-testid="proposal-card"]', { hasText: "Brand-New Shrine" });
  assert.equal(await shrineCard.locator('[data-testid="proposal-card-normalization"]').count(), 0);

  // Both normalized rows read as field edits of the EXISTING entities (the
  // whole point: update, not duplicate create).
  const bridgeCard = page.locator('[data-testid="proposal-card"]', { hasText: "Kilmarn Bridge" });
  assert.match(await bridgeCard.innerText(), /field edit/i, "the bridge row renders as an update, not a new node");
});
