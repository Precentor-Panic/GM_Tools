// Friction Wave 1 -- the W1 review-card cluster driven END TO END in real
// headless Chromium against a fixture world modeled on the Kilmarn seed-3a
// batch (the real duplicate-create + orphan-edge shapes from the friction
// log): near-match chips (W1a), convert-create-to-update with batch-wide
// edge re-pointing (W1b), reject-cascade with undo + accept-connections
// (W1d), edge legibility/nesting with shared twin state (W1g), and the
// accept→apply banner wired to the existing sync route (W1h), finishing
// with a REAL apply and on-disk snapshot assertions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase37Env,
  cleanupScratchEnv,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase37-fixture.mjs";

const { scratchDir, dataDir } = setupPhase37Env("gm-tools-e2e-w1cluster-");
const WORLD = "e2e-w1-cluster";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { createBatch, loadBatch } = await import("../../../mutation-engine/review-state.mjs");
const { attachDiffs } = await import("../../../time-skip/run.mjs");

const liveEntities = [
  { id: "vane", name: "Master Aldric Vane", type: "person", importance: 0.7, description: "Guildmaster of the weavers." },
  { id: "skein", name: "The Skein", type: "place", importance: 0.5, description: "The weavers' quarter." },
  { id: "council", name: "Kilmarn Trade Council", type: "faction", importance: 0.6, description: "Merchants who run the docks." }
];
const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, liveEntities.map((e) => ({ op: "upsert_entity", data: e })));

function wm(extra) {
  return { rationale: "from the writeup", batchId: "placeholder", sourceKind: "writeup-import", ...extra };
}
// m0 create "Master Vane" (dup of canon vane) · m1 create "Thread T-1" ·
// m2 edge m0->m1 · m3 edge m1->skein · m4 create "Trade Council" (dup of
// canon council) · m5 edge m4->skein
const batch = createBatch(
  WORLD,
  { mode: "writeup-import", text: "seed 3a" },
  undefined,
  attachDiffs(
    [
      wm({ op: "upsert_entity", id: "wf_new_vane", data: { name: "Master Vane", type: "person", description: "Placed the fate-threads over three years." } }),
      wm({ op: "upsert_entity", id: "wf_new_t1", data: { name: "Thread T-1", type: "object", description: "A strand of slightly-wrong color." } }),
      wm({ op: "upsert_edge", id: "wf_e_0", data: { sourceId: "wf_new_vane", targetId: "wf_new_t1", relationshipType: "placed" } }),
      wm({ op: "upsert_edge", id: "wf_e_1", data: { sourceId: "wf_new_t1", targetId: "skein", relationshipType: "hidden-in" } }),
      wm({ op: "upsert_entity", id: "wf_new_tc", data: { name: "Trade Council", type: "faction", description: "They set the mooring fees." } }),
      wm({ op: "upsert_edge", id: "wf_e_2", data: { sourceId: "wf_new_tc", targetId: "skein", relationshipType: "controls" } })
    ],
    liveEntities,
    []
  )
);

let server, base, browser, page;
const card = (mid) => `[data-testid="proposal-card"][data-mutation-id="${mid}"]`;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#chronicle/batch/${batch.id}`);
  await page.locator(card("m0")).first().waitFor({ state: "visible", timeout: 20000 });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("W1a: duplicate creates carry near-match chips right on the card; clean creates carry none", async () => {
  const m0Chips = page.locator(`${card("m0")} [data-testid="proposal-card-near-match"]`);
  assert.equal(await m0Chips.count(), 1);
  assert.equal(await m0Chips.first().getAttribute("data-entity-id"), "vane");
  await m0Chips.first().locator("span").nth(1).waitFor();
  assert.match(await m0Chips.first().innerText(), /Master Aldric Vane/);

  const m4Chips = page.locator(`${card("m4")} [data-testid="proposal-card-near-match"]`);
  assert.equal(await m4Chips.count(), 1);
  assert.equal(await m4Chips.first().getAttribute("data-entity-id"), "council");

  assert.equal(await page.locator(`${card("m1")} [data-testid="proposal-card-near-matches"]`).count(), 0, "a genuinely-new create shows no chips");

  // W1e rides along: the duplicate creates are tagged possible-duplicate.
  assert.equal(await page.locator(`${card("m0")} [data-testid="proposal-card-triage-tag"]`).first().getAttribute("data-triage"), "possible-duplicate");
});

test("W1g: edge cards read with real names and nest under BOTH touched node cards", async () => {
  // m2 (wf_new_vane -> wf_new_t1) renders under m0's nest AND m1's nest.
  const m2Instances = page.locator(card("m2"));
  assert.equal(await m2Instances.count(), 2, "an edge touching two displayed nodes shows under both");
  assert.equal(await page.locator(`[data-testid="chronicle-nested-edges"][data-under="m0"] ${card("m2")}`).count(), 1);
  assert.equal(await page.locator(`[data-testid="chronicle-nested-edges"][data-under="m1"] ${card("m2")}`).count(), 1);
  const targetText = await m2Instances.first().locator('[data-testid="proposal-card-target"]').innerText();
  assert.equal(targetText, "Master Vane —placed→ Thread T-1", "names, never raw wf-ids");
  assert.ok(!/wf_new/.test(await m2Instances.first().innerText()), "no raw id leaks into the card");
});

test("W1b: converting the duplicate create re-targets it AND re-points its pending edges, live in the UI", async () => {
  await page.locator(`${card("m0")} [data-testid="proposal-card-convert-btn"][data-entity-id="vane"]`).click();
  // The convert triggers a full re-fetch/repaint -- wait for the card to read as canon.
  await page.waitForFunction((sel) => {
    const el = document.querySelector(`${sel} [data-testid="proposal-card-target"]`);
    return el && el.textContent === "Master Aldric Vane";
  }, card("m0"), { timeout: 20000 });
  // innerText arrives CSS-uppercased (the badge's text-transform) -- compare case-insensitively.
  assert.equal((await page.locator(`${card("m0")} [data-testid="proposal-card-kind-badge"]`).first().innerText()).toLowerCase(), "field edit", "the create card became an update card");

  // Server truth: m0 targets vane; the pending edge m2 re-pointed to vane.
  const saved = loadBatch(WORLD, batch.id);
  assert.equal(saved.mutations.find((m) => m.mutationId === "m0").id, "vane");
  assert.equal(saved.mutations.find((m) => m.mutationId === "m2").data.sourceId, "vane");

  // And the edge card now reads with the canon name.
  const m2Text = await page.locator(card("m2")).first().locator('[data-testid="proposal-card-target"]').innerText();
  assert.equal(m2Text, "Master Aldric Vane —placed→ Thread T-1");
});

test("W1d: rejecting a create greys its pending edges (undoable), and the undo restores them", async () => {
  await page.locator(card("m4")).first().locator('[data-testid="proposal-card-reject-btn"]').click();
  await page.waitForSelector(`${card("m4")}[data-decided="no"]`, { timeout: 15000 });
  // The cascade greyed m5 everywhere it renders, without a click on it.
  await page.waitForSelector(`${card("m5")}[data-decided="no"]`, { timeout: 15000 });
  const notice = page.locator('[data-testid="chronicle-cascade-notice"][data-for="m4"]');
  await notice.waitFor({ state: "visible", timeout: 15000 });
  assert.match(await notice.innerText(), /Also greyed 1 connected edge/);
  let saved = loadBatch(WORLD, batch.id);
  assert.equal(saved.mutations.find((m) => m.mutationId === "m5").status, "rejected");
  assert.equal(saved.mutations.find((m) => m.mutationId === "m5").entityContext.cascadeRejectedWith, "m4");

  // Undo restores the edges (the create's own reject stands).
  await notice.locator('[data-testid="chronicle-cascade-undo-btn"]').click();
  await page.waitForSelector(`${card("m5")}[data-decided=""]`, { timeout: 15000 });
  saved = loadBatch(WORLD, batch.id);
  assert.equal(saved.mutations.find((m) => m.mutationId === "m5").status, "pending");
  assert.equal(saved.mutations.find((m) => m.mutationId === "m4").status, "rejected");
});

test("W1g shared state + W1d accept-connections: twin instances stay in sync; accepting a node offers its connections", async () => {
  // Accept ONE instance of the twin edge m2 -- the other instance follows.
  await page.locator(`[data-testid="chronicle-nested-edges"][data-under="m0"] ${card("m2")} [data-testid="proposal-card-accept-btn"]`).click();
  await page.waitForSelector(`[data-testid="chronicle-nested-edges"][data-under="m0"] ${card("m2")}[data-decided="yes"]`, { timeout: 15000 });
  await page.waitForSelector(`[data-testid="chronicle-nested-edges"][data-under="m1"] ${card("m2")}[data-decided="yes"]`, { timeout: 15000 });

  // Accept the Thread T-1 create -- its remaining pending connection (m3)
  // is offered for one-click accept.
  await page.locator(card("m1")).first().locator('[data-testid="proposal-card-accept-btn"]').click();
  const offer = page.locator('[data-testid="chronicle-accept-connections-notice"][data-for="m1"]');
  await offer.waitFor({ state: "visible", timeout: 15000 });
  assert.match(await offer.innerText(), /1 pending connection/);
  await offer.locator('[data-testid="chronicle-accept-connections-btn"]').click();
  await page.waitForSelector(`${card("m3")}[data-decided="yes"]`, { timeout: 15000 });
  const saved = loadBatch(WORLD, batch.id);
  assert.equal(saved.mutations.find((m) => m.mutationId === "m3").status, "accepted");
});

test("W1h: the accept→apply banner counts unapplied accepts and a real Apply lands them in the world", async () => {
  // Accept the converted update too -- 4 accepted total (m0, m1, m2, m3).
  await page.locator(card("m0")).first().locator('[data-testid="proposal-card-accept-btn"]').click();
  await page.waitForSelector(`${card("m0")}[data-decided="yes"]`, { timeout: 15000 });

  const banner = page.locator('[data-testid="chronicle-apply-banner"]');
  await banner.waitFor({ state: "visible", timeout: 15000 });
  assert.match(await banner.locator('[data-testid="chronicle-apply-banner-label"]').innerText(), /4 accepted mutations not yet applied/);

  // A REAL apply through the existing sync route: the live-bridge poll (7s)
  // falls back to headless in this env -- generous timeout, per repo culture.
  await banner.locator('[data-testid="chronicle-apply-now-btn"]').click();
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="chronicle-apply-banner-status"]');
    return el && /Applied 4/.test(el.textContent);
  }, undefined, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="chronicle-apply-banner"]').style.display === "none", undefined, { timeout: 15000 });

  // On-disk truth: the EXISTING entity updated (no "Master Vane" duplicate),
  // the genuinely-new entity created, the re-pointed edge landed on canon,
  // and the rejected Trade Council duplicate never materialized.
  const { snapshot } = JSON.parse(readFileSync(snapPath, "utf8"));
  const vane = snapshot.entities.find((e) => e.id === "vane");
  assert.equal(vane.description, "Placed the fate-threads over three years.");
  assert.equal(snapshot.entities.filter((e) => /Vane/.test(e.name ?? "")).length, 1, "no duplicate Vane entity");
  assert.ok(snapshot.entities.find((e) => e.name === "Thread T-1"));
  assert.equal(snapshot.entities.find((e) => e.name === "Trade Council"), undefined, "the rejected duplicate create never applied");
  assert.ok(snapshot.edges.find((e) => e.sourceId === "vane" && e.relationshipType === "placed"), "the re-pointed edge applied onto the existing entity");
  assert.equal(loadBatch(WORLD, batch.id).status, "synced");
});
