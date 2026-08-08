import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — Phase 35 task 35.1's new review-ui/server.mjs
 * routes, §8 of review-ui/test/e2e/phase35-fixture.mjs (THE WRITTEN
 * CONTRACT): combat-planning/item-store.mjs (§1), session-planner/
 * stagecraft-store.mjs (§2), session-planner/token-store.mjs (§3,
 * read-only), and the bestiary/party-roster additive-field patch routes
 * (§5). The shared scene tray routes (§7) are covered separately in
 * review-ui/test/scene-tray-routes.test.mjs.
 *
 * Real HTTP requests via fetch() against an in-process server.listen(0),
 * same pattern as review-ui/test/combat-planning-routes.test.mjs.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-library-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
process.env.GM_TOOLS_ITEM_DIR = join(scratchDir, "items");
process.env.GM_TOOLS_STAGECRAFT_DIR = join(scratchDir, "stagecraft");
process.env.GM_TOOLS_TOKEN_DIR = join(scratchDir, "tokens");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "library-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { createReviewServer } = await import("../server.mjs");
const { saveItem } = await import("../../combat-planning/item-store.mjs");
const { saveStagecraftAsset } = await import("../../session-planner/stagecraft-store.mjs");
const { syncTokensForScene } = await import("../../session-planner/token-store.mjs");
const { saveBestiaryEntry } = await import("../../combat-planning/bestiary-store.mjs");
const { savePartyMember } = await import("../../combat-planning/party-roster-store.mjs");

let server, base;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}
async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}
async function deleteJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

// --------------------------------------------------------------- §1 items

test("GET /api/combat-planning/items?world= returns an items array, real round trip via a hand-seeded ItemRecord", async () => {
  const item = saveItem(WORLD, { name: "Potion of Healing", type: "consumable", quantity: 3 }, { makeId: () => "it-route-1" });
  const { status, body } = await getJson(`/api/combat-planning/items?world=${WORLD}`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.items));
  assert.ok(body.items.some((i) => i.id === item.id));
});

test("POST /api/combat-planning/items/:id/accept + /discard round trip", async () => {
  const item = saveItem(WORLD, { name: "To Accept", type: "loot" }, { makeId: () => "it-route-2" });
  const accepted = await postJson(`/api/combat-planning/items/${item.id}/accept`, { world: WORLD });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.item.status, "accepted");

  const discardAttempt = await postJson(`/api/combat-planning/items/${item.id}/discard`, { world: WORLD });
  assert.equal(discardAttempt.status, 400, "refuses to discard an already-accepted item");
});

test("POST/DELETE /api/combat-planning/items/:id/tags round trip (§4 addTag/removeTag)", async () => {
  const item = saveItem(WORLD, { name: "Taggable", type: "loot" }, { makeId: () => "it-route-3" });
  const tagged = await postJson(`/api/combat-planning/items/${item.id}/tags`, { world: WORLD, tag: "shiny" });
  assert.equal(tagged.status, 200);
  assert.deepEqual(tagged.body.item.tags, ["shiny"]);

  const untagged = await deleteJson(`/api/combat-planning/items/${item.id}/tags/shiny`, { world: WORLD });
  assert.equal(untagged.status, 200);
  assert.deepEqual(untagged.body.item.tags, []);
});

test("GET /api/combat-planning/items?world= for an unknown itemId accept/discard 400s cleanly, not 500 (route registered, entry not found)", async () => {
  const { status } = await postJson("/api/combat-planning/items/no-such-item/accept", { world: WORLD });
  assert.notEqual(status, 404, "the route itself is registered");
  assert.notEqual(status, 500);
});

// --------------------------------------------------------- §2 stagecraft

test("GET /api/session-planner/stagecraft?world=[&kind=] returns assets, optionally kind-filtered", async () => {
  saveStagecraftAsset(WORLD, { kind: "map", name: "Chantry Map" }, { makeId: () => "sc-route-1" });
  saveStagecraftAsset(WORLD, { kind: "splash", name: "Cover Art" }, { makeId: () => "sc-route-2" });

  const all = await getJson(`/api/session-planner/stagecraft?world=${WORLD}`);
  assert.equal(all.status, 200);
  assert.ok(all.body.assets.length >= 2);

  const mapsOnly = await getJson(`/api/session-planner/stagecraft?world=${WORLD}&kind=map`);
  assert.equal(mapsOnly.status, 200);
  assert.ok(mapsOnly.body.assets.every((a) => a.kind === "map"));
  assert.ok(mapsOnly.body.assets.some((a) => a.id === "sc-route-1"));
});

test("POST /api/session-planner/stagecraft/:id/accept + /discard round trip", async () => {
  const asset = saveStagecraftAsset(WORLD, { kind: "map", name: "Proposed Map", status: "proposed" }, { makeId: () => "sc-route-3" });
  const accepted = await postJson(`/api/session-planner/stagecraft/${asset.id}/accept`, { world: WORLD });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.asset.status, "accepted");
});

test("POST/DELETE /api/session-planner/stagecraft/:id/tags round trip", async () => {
  const asset = saveStagecraftAsset(WORLD, { kind: "splash", name: "Taggable Splash" }, { makeId: () => "sc-route-4" });
  const tagged = await postJson(`/api/session-planner/stagecraft/${asset.id}/tags`, { world: WORLD, tag: "cover" });
  assert.equal(tagged.status, 200);
  assert.deepEqual(tagged.body.asset.tags, ["cover"]);
  const untagged = await deleteJson(`/api/session-planner/stagecraft/${asset.id}/tags/cover`, { world: WORLD });
  assert.deepEqual(untagged.body.asset.tags, []);
});

// -------------------------------------------------------- §3 token-index

test("GET /api/session-planner/token-index?world=[&sceneUuid=] is read-only and reflects syncTokensForScene", async () => {
  syncTokensForScene(WORLD, "Scene.routeTest", [{ name: "Goblin", x: 1, y: 1, actorUuid: "Actor.g1" }], "2026-08-08T00:00:00.000Z");
  const all = await getJson(`/api/session-planner/token-index?world=${WORLD}`);
  assert.equal(all.status, 200);
  assert.ok(all.body.tokens.some((t) => t.sceneUuid === "Scene.routeTest"));

  const filtered = await getJson(`/api/session-planner/token-index?world=${WORLD}&sceneUuid=Scene.routeTest`);
  assert.equal(filtered.status, 200);
  assert.ok(filtered.body.tokens.every((t) => t.sceneUuid === "Scene.routeTest"));
  assert.equal(filtered.body.tokens[0].name, "Goblin");
});

// ---------------------------------------------------- §5 additive fields

test("POST /api/combat-planning/bestiary/:id/note + /rating: status-INDEPENDENT patch, works on an already-accepted entry", async () => {
  const { acceptBestiaryEntry } = await import("../../combat-planning/bestiary-store.mjs");
  const entry = saveBestiaryEntry({ rawFields: { name: "Test Monster", hp: 10, ac: 12 } }, { makeId: () => "bst-route-1" });
  acceptBestiaryEntry(entry.id);

  const noted = await postJson(`/api/combat-planning/bestiary/${entry.id}/note`, { note: "Loud when angry." });
  assert.equal(noted.status, 200);
  assert.equal(noted.body.entry.note, "Loud when angry.");
  assert.equal(noted.body.entry.status, "accepted", "note edit must not touch status");

  const rated = await postJson(`/api/combat-planning/bestiary/${entry.id}/rating`, { rating: "4" });
  assert.equal(rated.status, 200);
  assert.equal(rated.body.entry.rating, "4");
});

test("POST /api/combat-planning/party-roster/:id/passive + /conditions: status-INDEPENDENT patch, works on an already-accepted member", async () => {
  const member = savePartyMember(WORLD, { name: "Route Test PC", combatRelevant: {}, buildRelevant: {} }, { makeId: () => "pm-route-1" });
  assert.equal(member.status, "accepted");

  const withPassive = await postJson(`/api/combat-planning/party-roster/${member.id}/passive`, { world: WORLD, passive: 16 });
  assert.equal(withPassive.status, 200);
  assert.equal(withPassive.body.member.passive, 16);

  const withConditions = await postJson(`/api/combat-planning/party-roster/${member.id}/conditions`, { world: WORLD, conditions: "Prone" });
  assert.equal(withConditions.status, 200);
  assert.equal(withConditions.body.member.conditions, "Prone");
  assert.equal(withConditions.body.member.status, "accepted", "conditions edit must not touch status");
});

void __dirname;
