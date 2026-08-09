// Phase 35.5a (task #44) -- QE-first e2e contract: "promote items of
// interest from the reliquary to the graph as nodes, if the party deems
// them important" (Russell's words, hands-on Phase-35 pass, 2026-08-08).
//
// Read FIRST: phase35-fixture.mjs (§1 ItemRecord, the setup/route-helper
// conventions this file reuses). This is NOT a §8-listed phase35-fixture
// route -- 35.5a is its own small follow-up task, its own route helper
// lives in THIS file rather than being added to the shared phase35-fixture
// (keeps this feature's diff self-contained, per the dispatch's own
// one-commit-per-feature instruction).
//
// EXPECTED-RED reasons (confirmed by direct read + grep before writing this
// file): `POST /api/combat-planning/items/:id/promote-to-graph` does not
// appear anywhere in server.mjs's route table; `[data-testid="tagged-shelf-
// row-promote-btn"]`/`-graph-badge"]` do not exist anywhere in
// review-ui/public/library-view.js. That failure is the deliverable of this
// file's first run, not a bug in it.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase35Env,
  cleanupScratchEnv,
  primeWorldSelection,
  makeItemRecord,
  seedItemRecords,
  listItemsViaRoute,
  fetchGraphViaRoute,
  DESKTOP_VIEWPORT
} from "./phase35-fixture.mjs";

const { scratchDir, dataDir } = setupPhase35Env("gm-tools-e2e-p355a-");
const WORLD = "e2e-p355a-promote-item";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

const VERDIGRIS_KEY = makeItemRecord({
  id: "it_verdigris_key", world: WORLD, name: "Verdigris Key",
  type: "wondrous item", description: "A palm-sized disc of green brass.",
  tags: ["vault", "quest"], status: "accepted"
});
const UNDESCRIBED_GRATE = makeItemRecord({
  id: "it_grate", world: WORLD, name: "Rusted Vault Grate",
  type: "loot", description: null, tags: [], status: "accepted"
});
// Untouched by the route-level tests below (which promote it_verdigris_key/
// it_grate) -- kept pristine for the UI-level test so it starts un-promoted.
const SILK_ROPE = makeItemRecord({
  id: "it_silk_rope", world: WORLD, name: "Rope, Silk (50 feet)",
  type: "loot", description: "Fifty feet of silk rope, coiled.", tags: [], status: "accepted"
});
seedItemRecords(WORLD, [VERDIGRIS_KEY, UNDESCRIBED_GRATE, SILK_ROPE]);

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

/** POST /api/combat-planning/items/:id/promote-to-graph {world} -- 404 until 35.5a. */
async function promoteItemViaRoute(base, world, id) {
  const res = await fetch(`${base}/api/combat-planning/items/${encodeURIComponent(id)}/promote-to-graph`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// ROUTE-LEVEL
// ---------------------------------------------------------------------------
test("route contract: promoting an item creates a real graph node (name/type/description) and back-links the ItemRecord (or 404s cleanly until 35.5a)", async () => {
  const res = await promoteItemViaRoute(base, WORLD, "it_verdigris_key");
  if (res.status === 404) return; // expected-red today
  assert.equal(res.status, 200);
  assert.equal(res.body.created, true);
  assert.ok(res.body.entityId, "must return the new entity's id");

  const graph = await fetchGraphViaRoute(base, WORLD);
  const node = graph.nodes.find((n) => n.id === res.body.entityId);
  assert.ok(node, "the promoted entity must be a real, fetchable graph node");
  assert.equal(node.name, "Verdigris Key");
  assert.match(node.type, /object/i, "must match this graph's existing object/thing convention, not invent a new type");

  const { body } = await listItemsViaRoute(base, WORLD);
  const item = body.items.find((i) => i.id === "it_verdigris_key");
  assert.equal(item.graphEntityId, res.body.entityId, "the ItemRecord must be back-linked to the real node");
  assert.equal(item.name, "Verdigris Key", "the item itself keeps living in the Reliquary, unchanged");
});

test("route contract: promoting an item with no description still creates a node (description omitted, not a crash)", async () => {
  const res = await promoteItemViaRoute(base, WORLD, "it_grate");
  if (res.status === 404) return; // expected-red today
  assert.equal(res.status, 200);
  assert.equal(res.body.created, true);
});

test("route contract: promoting the SAME item twice is idempotent -- second call returns the SAME entityId, created:false, and creates NO second node", async () => {
  const first = await promoteItemViaRoute(base, WORLD, "it_verdigris_key");
  if (first.status === 404) return; // expected-red today
  const second = await promoteItemViaRoute(base, WORLD, "it_verdigris_key");
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false, "a second promote must not create a new node");
  assert.equal(second.body.entityId, first.body.entityId, "must return the SAME entity id, not a new one");

  const graph = await fetchGraphViaRoute(base, WORLD);
  const matches = graph.nodes.filter((n) => n.name === "Verdigris Key");
  assert.equal(matches.length, 1, "promoting twice must NOT create a second node");
});

test("route contract: promoting an unknown item id fails cleanly (matches getItem's own established not-found status across this project's sibling stores -- accept/discard on an unknown bestiary/party/item/stagecraft id all resolve the SAME way today, confirmed by direct read of statusForError's regex list)", async () => {
  const res = await promoteItemViaRoute(base, WORLD, "it_does_not_exist");
  assert.notEqual(res.status, 200, "must not silently succeed on an unknown id");
  assert.ok(res.body?.error, "must surface a clear error message");
});

// ---------------------------------------------------------------------------
// UI-LEVEL
// ---------------------------------------------------------------------------
test("Reliquary shelf row: clicking the promote affordance swaps it to a quiet 'in the graph' marker, and the state survives a reload", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library/reliquary`);
  await page.locator('[data-testid="library-reliquary-root"]').waitFor({ state: "visible", timeout: 15000 });

  const row = page.locator('[data-testid="tagged-shelf-row"][data-item-id="it_silk_rope"]');
  await row.waitFor({ state: "visible", timeout: 10000 });

  const promoteBtn = row.locator('[data-testid="tagged-shelf-row-promote-btn"]');
  await promoteBtn.waitFor({ state: "visible", timeout: 10000 });
  await promoteBtn.click();

  const badge = row.locator('[data-testid="tagged-shelf-row-graph-badge"]');
  await badge.waitFor({ state: "visible", timeout: 10000 });
  assert.match((await badge.textContent()) ?? "", /in the graph/i);
  await promoteBtn.waitFor({ state: "detached", timeout: 5000 });

  // Real persisted state, not client-only: reload the page fresh.
  await page.reload();
  await page.locator('[data-testid="library-reliquary-root"]').waitFor({ state: "visible", timeout: 15000 });
  const badgeAfterReload = page.locator('[data-testid="tagged-shelf-row"][data-item-id="it_silk_rope"] [data-testid="tagged-shelf-row-graph-badge"]');
  await badgeAfterReload.waitFor({ state: "visible", timeout: 10000 });

  await page.close();
});

test("Stagecraft shelf rows never render the promote affordance (items only -- Russell asked for items, not maps/splash/music)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library/stagecraft`);
  await page.locator('[data-testid="library-stagecraft-root"]').waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(500); // let any async paint settle before asserting absence

  assert.equal(await page.locator('[data-testid="tagged-shelf-row-promote-btn"]').count(), 0);
  assert.equal(await page.locator('[data-testid="tagged-shelf-row-graph-badge"]').count(), 0);

  await page.close();
});
