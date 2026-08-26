import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST -- Briefing (2026-08-26): world-level front-matter
 * cards (session-planner/briefing-store.mjs) behind
 *   GET    /api/session-planner/briefing?world=            -> {cards}
 *   POST   /api/session-planner/briefing                    {world,title,eyebrow?,body?,span?} -> {card}
 *   POST   /api/session-planner/briefing/reorder            {world,cardIds} -> {cards}
 *   POST   /api/session-planner/briefing/:id                {world,title?,eyebrow?,body?,span?} -> {card}
 *   DELETE /api/session-planner/briefing/:id                {world} -> {deleted}
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-briefing-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_BRIEFING_DIR = join(scratchDir, "briefing");
process.env.WF_DATA_DIR = dataDir;
const WORLD = "briefing-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;
const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../server.mjs");
bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

let server, base;
before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(scratchDir, { recursive: true, force: true }); });
async function getJson(path) { const res = await fetch(`${base}${path}`); return { status: res.status, body: await res.json() }; }
async function postJson(path, body) { const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; }
async function deleteJson(path, body) { const res = await fetch(`${base}${path}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; }

test("briefing cards: create / list in order / patch / span / reorder / delete", async () => {
  assert.deepEqual((await getJson(`/api/session-planner/briefing?world=${WORLD}`)).body.cards, []);
  const a = (await postJson("/api/session-planner/briefing", { world: WORLD, title: "The Premise", eyebrow: "The con", body: "<p>Vane owes a debt.</p>", span: 2 })).body.card;
  const b = (await postJson("/api/session-planner/briefing", { world: WORLD, title: "Cast" })).body.card;
  assert.equal(a.span, 2); assert.equal(b.span, 1); assert.equal(b.eyebrow, null); assert.equal(b.body, "");
  let cards = (await getJson(`/api/session-planner/briefing?world=${WORLD}`)).body.cards;
  assert.deepEqual(cards.map((c) => c.title), ["The Premise", "Cast"]);

  const patched = (await postJson(`/api/session-planner/briefing/${b.id}`, { world: WORLD, body: "<ul><li>Vane</li></ul>", span: 2 })).body.card;
  assert.equal(patched.body, "<ul><li>Vane</li></ul>"); assert.equal(patched.span, 2); assert.equal(patched.title, "Cast", "untouched key stays");
  const bad = await postJson(`/api/session-planner/briefing/${b.id}`, { world: WORLD, title: "   " });
  assert.equal(bad.status, 400);

  cards = (await postJson("/api/session-planner/briefing/reorder", { world: WORLD, cardIds: [b.id, a.id] })).body.cards;
  assert.deepEqual(cards.map((c) => c.id), [b.id, a.id]);

  assert.equal((await deleteJson(`/api/session-planner/briefing/${a.id}`, { world: WORLD })).body.deleted, true);
  assert.equal((await deleteJson(`/api/session-planner/briefing/${a.id}`, { world: WORLD })).body.deleted, false);
  assert.equal((await getJson(`/api/session-planner/briefing?world=${WORLD}`)).body.cards.length, 1);
});

test("SECURITY: a path-traversal-shaped world id is rejected with 400", async () => {
  const res = await getJson(`/api/session-planner/briefing?world=${encodeURIComponent("../../etc")}`);
  assert.equal(res.status, 400);
});
