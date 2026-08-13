// Phase 37.6b -- QE-first e2e contract: wire the two Library Bestiary stubs
// ("Promote to a named world figure" + "Wear it as something else"), and
// unlock phase35-fixture.mjs §7's own forward-compatible graph-linked
// creature tray-drop pin now that a bestiary entry CAN carry a graph link.
//
// Read FIRST: phase35-fixture.mjs (§7's own "FORWARD-COMPATIBLE PLUMBING
// ONLY" pin -- this file is the phase that exercises it for real) and
// phase35-5a-promote-item.e2e.mjs (the promote precedent this file mirrors
// for the Bestiary's own promote-to-graph route/UI). NOT itself a
// §8-listed phase35-fixture route -- 37.6b is its own follow-up task, its
// own route/UI helpers live in THIS file, same one-commit-per-feature
// convention 35.5a's own header comment already established.
//
// ANTHROPIC_API_KEY is not set in this build/test environment (PLAN.md's
// own standing note) -- every reskin-suggest assertion below exercises the
// OFFLINE DETERMINISTIC degrade path (review-ui/server.mjs's
// offlineReskinSuggestClient), same convention combat-planning-fixture.mjs's
// own header comment documents for this project's other LLM-touching routes.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase35Env,
  cleanupScratchEnv,
  primeWorldSelection,
  createSceneViaRoute,
  fetchGraphViaRoute,
  dropOnSceneTrayViaRoute,
  DESKTOP_VIEWPORT
} from "./phase35-fixture.mjs";
import { fullProfileRawFields } from "./combat-planning-fixture.mjs";

const { scratchDir, dataDir } = setupPhase35Env("gm-tools-e2e-p376b-");
const WORLD = "e2e-p376b-bestiary-library";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { saveBestiaryEntry, acceptBestiaryEntry, getBestiaryEntry, listBestiaryEntries } =
  await import("../../../combat-planning/bestiary-store.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

// A seed distinct from combat-planning-fixture.mjs's own "Test Goblin" so
// per-test entries are easy to eyeball apart in failure output.
function goblinRawFields(overrides = {}) {
  return fullProfileRawFields({ name: "Warren Goblin", ...overrides });
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

/** POST /api/combat-planning/bestiary/:id/promote-to-graph {world} -- 404 until 37.6b. */
async function promoteBestiaryViaRoute(base, world, id) {
  const res = await fetch(`${base}/api/combat-planning/bestiary/${encodeURIComponent(id)}/promote-to-graph`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** POST /api/combat-planning/bestiary/:id/reskin-suggest {world, vision?} -- 404 until 37.6b. */
async function reskinSuggestViaRoute(base, world, id, vision) {
  const res = await fetch(`${base}/api/combat-planning/bestiary/${encodeURIComponent(id)}/reskin-suggest`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world, vision })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** POST /api/combat-planning/bestiary/:id/reskin-accept {suggestion} -- 404 until 37.6b. */
async function reskinAcceptViaRoute(base, id, suggestion) {
  const res = await fetch(`${base}/api/combat-planning/bestiary/${encodeURIComponent(id)}/reskin-accept`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ suggestion })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// ROUTE-LEVEL -- "Promote to a named world figure"
// ---------------------------------------------------------------------------

test("route contract: promoting a bestiary entry creates a real graph node (type 'person', description seeded) and back-links the entry (or 404s cleanly until 37.6b)", async () => {
  const entry = saveBestiaryEntry({ rawFields: goblinRawFields({ name: "Verdigris Warren-Goblin" }) }, { makeId: () => "bst-p376b-promote-1" });
  const res = await promoteBestiaryViaRoute(base, WORLD, entry.id);
  if (res.status === 404) return; // expected-red today

  assert.equal(res.status, 200);
  assert.equal(res.body.created, true);
  assert.ok(res.body.entityId, "must return the new entity's id");

  const graph = await fetchGraphViaRoute(base, WORLD);
  const node = graph.nodes.find((n) => n.id === res.body.entityId);
  assert.ok(node, "the promoted entity must be a real, fetchable graph node");
  assert.equal(node.name, "Verdigris Warren-Goblin");
  assert.equal(node.type, "person", "the deliberate, documented choice -- see promoteBestiaryEntryToGraph's own doc comment");

  const reread = getBestiaryEntry(entry.id);
  assert.equal(reread.graphEntityId, res.body.entityId, "the BestiaryEntry must be back-linked to the real node");
  assert.equal(reread.rawFields.hp, entry.rawFields.hp, "the entry's own stat block is untouched by promotion");
});

test("route contract: promoting the SAME bestiary entry twice is idempotent -- second call returns the SAME entityId, created:false, no second node", async () => {
  const entry = saveBestiaryEntry({ rawFields: goblinRawFields({ name: "Ashwick Warren-Goblin" }) }, { makeId: () => "bst-p376b-promote-2" });
  const first = await promoteBestiaryViaRoute(base, WORLD, entry.id);
  if (first.status === 404) return; // expected-red today
  const second = await promoteBestiaryViaRoute(base, WORLD, entry.id);
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false, "a second promote must not create a new node");
  assert.equal(second.body.entityId, first.body.entityId, "must return the SAME entity id, not a new one");

  const graph = await fetchGraphViaRoute(base, WORLD);
  const matches = graph.nodes.filter((n) => n.name === "Ashwick Warren-Goblin");
  assert.equal(matches.length, 1, "promoting twice must NOT create a second node");
});

test("route contract: promoting an unknown bestiary entry id fails cleanly, no graph write", async () => {
  const res = await promoteBestiaryViaRoute(base, WORLD, "bst-does-not-exist");
  assert.notEqual(res.status, 200, "must not silently succeed on an unknown id");
  assert.ok(res.body?.error, "must surface a clear error message");
});

// ---------------------------------------------------------------------------
// ROUTE-LEVEL -- the §7 unlock: a graph-linked creature's tray-drop
// ---------------------------------------------------------------------------

test("§7 unlock: a bestiary entry WITHOUT a graph link still drops as a kind:'local' element carrying a stat block (baseline, unchanged from Phase 35.3)", async () => {
  const entry = saveBestiaryEntry({ rawFields: goblinRawFields({ name: "Unlinked Warren-Goblin" }) }, { makeId: () => "bst-p376b-unlinked" });
  acceptBestiaryEntry(entry.id);
  const scene = await createSceneViaRoute(base, WORLD, {});

  const drop = await dropOnSceneTrayViaRoute(base, WORLD, scene.id, { kind: "creature", id: entry.id });
  assert.equal(drop.status, 200);
  assert.equal(drop.body.element.kind, "local", "an un-promoted creature must still take the local+stat path");
  assert.equal(drop.body.element.stat.hp, entry.rawFields.hp);
});

test("§7 unlock: a bestiary entry WITH a graph link (promoted) drops as a REAL kind:'graph' element via the from-graph flow, and the stat still populates", async () => {
  const entry = saveBestiaryEntry({ rawFields: goblinRawFields({ name: "Cael the Reformed Goblin" }) }, { makeId: () => "bst-p376b-linked" });
  acceptBestiaryEntry(entry.id);
  const promoted = await promoteBestiaryViaRoute(base, WORLD, entry.id);
  if (promoted.status === 404) return; // expected-red today (promote not wired yet)

  const scene = await createSceneViaRoute(base, WORLD, {});
  const before = await fetchGraphViaRoute(base, WORLD);
  const beforeCount = before.nodes.length;

  const drop = await dropOnSceneTrayViaRoute(base, WORLD, scene.id, { kind: "creature", id: entry.id });
  assert.equal(drop.status, 200);
  assert.equal(drop.body.element.kind, "graph", "a graph-linked bestiary entry must attach via the from-graph flow, not local+stat");
  assert.equal(drop.body.element.graphEntityId, promoted.body.entityId, "must reference the ALREADY-promoted node, not create a new one");
  assert.equal(drop.body.element.stat.hp, entry.rawFields.hp, "the stat must still populate on the graph-linked path");
  assert.equal(drop.body.element.stat.ac, entry.rawFields.ac);

  const after = await fetchGraphViaRoute(base, WORLD);
  assert.equal(after.nodes.length, beforeCount, "the tray-drop itself must create NO new graph node -- attach-only, per attachExistingNodeAsElement's own contract");
});

test("§7 unlock: a repeat drop of a graph-linked creature only stacks the roster, no second element", async () => {
  const entry = saveBestiaryEntry({ rawFields: goblinRawFields({ name: "Repeat-Drop Goblin" }) }, { makeId: () => "bst-p376b-linked-repeat" });
  acceptBestiaryEntry(entry.id);
  const promoted = await promoteBestiaryViaRoute(base, WORLD, entry.id);
  if (promoted.status === 404) return; // expected-red today

  const scene = await createSceneViaRoute(base, WORLD, {});
  const first = await dropOnSceneTrayViaRoute(base, WORLD, scene.id, { kind: "creature", id: entry.id });
  const second = await dropOnSceneTrayViaRoute(base, WORLD, scene.id, { kind: "creature", id: entry.id });
  assert.ok(first.body.element, "first drop creates the element");
  assert.equal(second.body.element, null, "second drop of the SAME creature creates no element, only stacks the roster");
  const rosterRow = second.body.roster.find((r) => r.id === entry.id && r.kind === "creature");
  assert.equal(rosterRow.n, 2, "creature drops stack (n increments), per §7's own pinned STACKING rule");
});

// ---------------------------------------------------------------------------
// ROUTE-LEVEL -- "Wear it as something else"
// ---------------------------------------------------------------------------

test("route contract: reskin-suggest returns 2+ suggestions (offline deterministic degrade -- no ANTHROPIC_API_KEY in this environment) grounded in the creature's own name", async () => {
  const entry = saveBestiaryEntry({ rawFields: goblinRawFields({ name: "Skitter the Reskin Subject" }) }, { makeId: () => "bst-p376b-reskin-suggest" });
  const res = await reskinSuggestViaRoute(base, WORLD, entry.id, "closer to a court intriguer than a brute");
  if (res.status === 404) return; // expected-red today

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.suggestions));
  assert.ok(res.body.suggestions.length >= 2, "at least MIN_RESKIN_SUGGESTIONS suggestions");
  for (const s of res.body.suggestions) {
    assert.ok(s.name && s.description && s.habitatHint, "every suggestion must have all three fields");
  }
  assert.match(res.body.suggestions[0].name, /Skitter the Reskin Subject/, "the offline fallback must reflect the real creature name, not a generic placeholder");
});

test("route contract: reskin-suggest 404s cleanly for an unknown bestiary entry id", async () => {
  const res = await reskinSuggestViaRoute(base, WORLD, "bst-does-not-exist", "");
  assert.notEqual(res.status, 200);
  assert.ok(res.body?.error);
});

test("route contract: accepting a reskin suggestion creates a NEW bestiary entry with IDENTICAL rawFields except name, source pill 'reskin', status accepted, never foundry-linked", async () => {
  const source = saveBestiaryEntry(
    { rawFields: goblinRawFields({ name: "Original Goblin" }), foundryActorRef: "Actor.original" },
    { makeId: () => "bst-p376b-reskin-source" }
  );
  const suggestion = { name: "Marsh-Reed Goblin", description: "A reed-camouflaged raider who strikes from the shallows.", habitatHint: "Coastal marshland." };
  const res = await reskinAcceptViaRoute(base, source.id, suggestion);
  if (res.status === 404) return; // expected-red today

  assert.equal(res.status, 200);
  assert.equal(res.body.entry.rawFields.name, "Marsh-Reed Goblin");
  assert.equal(res.body.entry.rawFields.hp, source.rawFields.hp, "same numbers -- hp copied verbatim");
  assert.equal(res.body.entry.rawFields.ac, source.rawFields.ac, "same numbers -- ac copied verbatim");
  assert.equal(res.body.entry.status, "accepted");
  assert.equal(res.body.entry.foundryActorRef, null, "a reskin is never foundry-linked, even when its source was");
  assert.equal(res.body.entry.sourcePill, "reskin");
  assert.match(res.body.entry.note, /reed-camouflaged raider/);

  const inList = listBestiaryEntries().find((e) => e.id === res.body.entry.id);
  assert.ok(inList, "the new entry must be genuinely persisted, discoverable via the ordinary list");
  assert.equal(inList.sourcePill, "reskin");
});

// ---------------------------------------------------------------------------
// UI-LEVEL
// ---------------------------------------------------------------------------

test("Bestiary stat rail: clicking the promote affordance swaps it to a quiet 'in the graph' marker, and the state survives a reload", async () => {
  const entry = saveBestiaryEntry({ rawFields: goblinRawFields({ name: "UI Promote Goblin" }) }, { makeId: () => "bst-p376b-ui-promote" });
  acceptBestiaryEntry(entry.id);

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library`);
  await page.locator('[data-testid="library-bestiary-root"]').waitFor({ state: "visible", timeout: 15000 });

  const card = page.locator(`[data-testid="library-creature-card"][data-entry-id="${entry.id}"]`);
  await card.waitFor({ state: "visible", timeout: 10000 });
  await card.click();

  const statRail = page.locator('[data-testid="library-stat-rail"]');
  await statRail.waitFor({ state: "visible", timeout: 10000 });

  const promoteBtn = statRail.locator('[data-testid="library-bestiary-promote-btn"]');
  await promoteBtn.waitFor({ state: "visible", timeout: 10000 });
  await promoteBtn.click();

  const badge = statRail.locator('[data-testid="library-bestiary-graph-badge"]');
  await badge.waitFor({ state: "visible", timeout: 10000 });
  assert.match((await badge.textContent()) ?? "", /in the graph/i);

  // Real persisted state, not client-only: reload, re-select, re-check.
  await page.reload();
  await page.locator('[data-testid="library-bestiary-root"]').waitFor({ state: "visible", timeout: 15000 });
  await page.locator(`[data-testid="library-creature-card"][data-entry-id="${entry.id}"]`).click();
  await page.locator('[data-testid="library-bestiary-graph-badge"]').waitFor({ state: "visible", timeout: 10000 });

  await page.close();
});

test("Bestiary stat rail: 'Wear it as something else' renders suggestion cards, and accepting one creates a new catalogue entry with the 'Reskinned' pill", async () => {
  const entry = saveBestiaryEntry({ rawFields: goblinRawFields({ name: "UI Reskin Goblin" }) }, { makeId: () => "bst-p376b-ui-reskin" });
  acceptBestiaryEntry(entry.id);

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library`);
  await page.locator('[data-testid="library-bestiary-root"]').waitFor({ state: "visible", timeout: 15000 });

  const card = page.locator(`[data-testid="library-creature-card"][data-entry-id="${entry.id}"]`);
  await card.waitFor({ state: "visible", timeout: 10000 });
  await card.click();

  const statRail = page.locator('[data-testid="library-stat-rail"]');
  await statRail.waitFor({ state: "visible", timeout: 10000 });

  const suggestBtn = statRail.locator('[data-testid="library-reskin-suggest-btn"]');
  await suggestBtn.waitFor({ state: "visible", timeout: 10000 });
  await suggestBtn.click();

  const firstCard = statRail.locator('[data-testid="library-reskin-suggestion-card"]').first();
  await firstCard.waitFor({ state: "visible", timeout: 15000 });
  const cardCount = await statRail.locator('[data-testid="library-reskin-suggestion-card"]').count();
  assert.ok(cardCount >= 2, "at least MIN_RESKIN_SUGGESTIONS cards render");

  const acceptBtn = firstCard.locator('[data-testid="library-reskin-accept-btn"]');
  await acceptBtn.click();

  // Accepting reloads the whole Bestiary tab (a NEW catalogue entry now exists) --
  // wait for the root to repaint, then find the new card by its 'Reskinned' pill.
  await page.locator('[data-testid="library-bestiary-root"]').waitFor({ state: "visible", timeout: 15000 });
  const reskinnedCard = page.locator('[data-testid="library-creature-card"]').filter({ hasText: "Reskinned" });
  await reskinnedCard.first().waitFor({ state: "visible", timeout: 10000 });

  await page.close();
});
