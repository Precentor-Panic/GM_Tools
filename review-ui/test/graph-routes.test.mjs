import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * Phase 7 task 7.1 — route-level tests for GET /api/graph, matching
 * review-ui/test/routes.test.mjs's established style (real HTTP requests
 * against an in-process server.listen(0), a fixture world built via
 * headless-apply + review-state directly, no mocking of the route layer
 * itself).
 *
 * Covers task 7.1's acceptance criteria verbatim:
 *   - batch-scoped query returns the batch's own entities plus real
 *     one-hop neighbors, NOT the whole graph (a far-away entity with no
 *     path to the batch must be absent).
 *   - standalone query with filter=unreviewed returns only flagged entities.
 *   - degree/status fields are correct against a real fixture.
 *   - (self-review requirement, task 7's "how to work" section) the
 *     standalone default (filter omitted) genuinely reduces the returned
 *     node COUNT versus filter=all — proving the server itself is doing
 *     the filtering, not just a client-side hide.
 *   - a node can carry BOTH flaggedUnreviewed AND hasDeferredDebt at once
 *     (the two independent visual channels the design doc requires).
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-graph-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "graph-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch } = await import("../../mutation-engine/review-state.mjs");
const { markHumanReviewed, recordUnreviewedAccept } = await import("../../mutation-engine/human-review.mjs");
const { writePending } = await import("../../mutation-engine/pending-ledger.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });

// A small hand-built graph: alvor -[kinship]- gerdur -[membership]- riverwood-guard,
// plus a completely disconnected "far-away" entity with no path to anything
// else -- the thing a whole-graph query would wrongly include but a
// batch-scoped context query must not.
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "alvor", name: "Alvor", type: "person", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "gerdur", name: "Gerdur", type: "person", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "riverwood-guard", name: "Riverwood Guard", type: "faction", importance: 0.4 } },
  { op: "upsert_entity", data: { id: "far-away-npc", name: "Far Away NPC", type: "person", importance: 0.3 } },
  { op: "upsert_edge", data: { sourceId: "alvor", targetId: "gerdur", relationshipType: "kinship" } },
  { op: "upsert_edge", data: { sourceId: "gerdur", targetId: "riverwood-guard", relationshipType: "membership" } }
]);

// alvor is flagged unreviewed (accumulated unreviewed-accept history --
// human-review.mjs's findUnreviewedEntities only flags entities with SOME
// tracked history, so a plain "never touched at all" entity doesn't count;
// this is the same "accumulated" path a real whole-batch accept-all
// produces) AND carries deferred debt -- the two-independent-channels
// co-occurrence case task 7.2 requires a screenshot proving. gerdur is
// reviewed (not flagged) with no debt.
for (let i = 0; i < 5; i++) recordUnreviewedAccept(WORLD, ["alvor"]);
markHumanReviewed(WORLD, ["gerdur"]);
writePending(WORLD, "alvor", {
  causeTag: "Alvor: a cycle passed",
  impactScore: 0.4,
  sourceBatchId: "batch_fixture",
  cycleDescriptor: "cycle 1"
});

let server;
let base;

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

test("batch-scoped /api/graph returns the batch's own proposed entities plus one-hop persisted neighbors, not the whole graph", async () => {
  // A batch that only touches "riverwood-guard" (an update). Its one-hop
  // neighbor is "gerdur"; "alvor" is two hops away and "far-away-npc" has no
  // path at all -- neither should appear at depth=1.
  const batch = createBatch(WORLD, { mode: "manual" }, "a test session", [
    {
      op: "upsert_entity",
      id: "riverwood-guard",
      data: { importance: 0.6 },
      rationale: "The guard grows more prominent.",
      batchId: "placeholder",
      sourceKind: "manual",
      entityContext: { name: "Riverwood Guard", importance: 0.6, tags: [] }
    }
  ]);

  const { status, body } = await getJson(`/api/graph?world=${WORLD}&batchId=${batch.id}&depth=1`);
  assert.equal(status, 200);
  const ids = body.nodes.map((n) => n.id);
  assert.ok(ids.includes("riverwood-guard"), "the batch's own target entity must be present");
  assert.ok(ids.includes("gerdur"), "riverwood-guard's real one-hop neighbor must be present");
  assert.ok(!ids.includes("alvor"), "a two-hop-away entity must NOT be present at depth=1");
  assert.ok(!ids.includes("far-away-npc"), "an entity with no path from the batch must never appear -- this is not a whole-graph query");

  const target = body.nodes.find((n) => n.id === "riverwood-guard");
  assert.equal(target.proposed, true, "the batch's own target entity must be marked proposed");
  const neighbor = body.nodes.find((n) => n.id === "gerdur");
  assert.equal(neighbor.proposed, false, "a purely-contextual neighbor must be marked NOT proposed (persisted)");
});

test("batch-scoped /api/graph expanding depth=2 pulls in the second-hop neighbor", async () => {
  const batch = createBatch(WORLD, { mode: "manual" }, "a test session", [
    {
      op: "upsert_entity",
      id: "riverwood-guard",
      data: { importance: 0.6 },
      rationale: "The guard grows more prominent.",
      batchId: "placeholder",
      sourceKind: "manual",
      entityContext: { name: "Riverwood Guard", importance: 0.6, tags: [] }
    }
  ]);
  const { body } = await getJson(`/api/graph?world=${WORLD}&batchId=${batch.id}&depth=2`);
  const ids = body.nodes.map((n) => n.id);
  assert.ok(ids.includes("alvor"), "expanding to depth=2 should pull in the second-hop neighbor");
});

test("a batch mutation touching a brand-new (not-yet-persisted) entity renders a synthetic node", async () => {
  const batch = createBatch(WORLD, { mode: "manual" }, "a test session", [
    {
      op: "upsert_entity",
      // deliberately no `id` -- a texture.mjs-style LLM-authored create,
      // which schema.mjs allows to omit id (unlike writeup-import's own
      // guaranteed-id convention).
      data: { name: "Brand New NPC", type: "person" },
      rationale: "A brand-new consequence of the scene.",
      batchId: "placeholder",
      sourceKind: "seeded-propagation"
    }
  ]);
  const { status, body } = await getJson(`/api/graph?world=${WORLD}&batchId=${batch.id}`);
  assert.equal(status, 200);
  assert.equal(body.nodes.length, 1);
  assert.equal(body.nodes[0].name, "Brand New NPC");
  assert.equal(body.nodes[0].type, "person");
  assert.equal(body.nodes[0].proposed, true);
});

test("standalone /api/graph with filter=unreviewed returns only flagged entities", async () => {
  const { status, body } = await getJson(`/api/graph?world=${WORLD}&filter=unreviewed`);
  assert.equal(status, 200);
  const ids = body.nodes.map((n) => n.id);
  assert.ok(ids.includes("alvor"), "alvor is never-reviewed -- must be included");
  assert.ok(!ids.includes("gerdur"), "gerdur was explicitly marked reviewed -- must NOT be included under filter=unreviewed");
});

test("standalone /api/graph DEFAULT (filter omitted) returns EVERYTHING, same as filter=all -- reversed from task 7.4's original flagged-only default per real-usage feedback", async () => {
  const omitted = await getJson(`/api/graph?world=${WORLD}`);
  const everything = await getJson(`/api/graph?world=${WORLD}&filter=all`);
  assert.equal(omitted.status, 200);
  assert.equal(everything.status, 200);
  assert.deepEqual(
    omitted.body.nodes.map((n) => n.id).sort(),
    everything.body.nodes.map((n) => n.id).sort(),
    "omitting the filter param must return the identical node set to filter=all"
  );
  const everythingIds = everything.body.nodes.map((n) => n.id);
  assert.ok(everythingIds.includes("far-away-npc"), "the default must include even a fully disconnected entity");
});

test("standalone /api/graph with an unrecognized filter value falls back to show-everything, not flagged-only", async () => {
  const { status, body } = await getJson(`/api/graph?world=${WORLD}&filter=bogus`);
  const everything = await getJson(`/api/graph?world=${WORLD}&filter=all`);
  assert.equal(status, 200);
  assert.deepEqual(body.nodes.map((n) => n.id).sort(), everything.body.nodes.map((n) => n.id).sort());
});

test("a node can carry BOTH flaggedUnreviewed AND hasDeferredDebt at once -- two independent channels, not a combined enum", async () => {
  const { body } = await getJson(`/api/graph?world=${WORLD}&filter=all`);
  const alvor = body.nodes.find((n) => n.id === "alvor");
  assert.ok(alvor, "alvor should be present under filter=all");
  assert.equal(alvor.flaggedUnreviewed, true);
  assert.equal(alvor.hasDeferredDebt, true);

  const gerdur = body.nodes.find((n) => n.id === "gerdur");
  assert.equal(gerdur.flaggedUnreviewed, false);
  assert.equal(gerdur.hasDeferredDebt, false);
});

test("degree is computed from the FULL graph, not just the returned subset", async () => {
  const { body } = await getJson(`/api/graph?world=${WORLD}&filter=unreviewed`);
  const alvor = body.nodes.find((n) => n.id === "alvor");
  // alvor has exactly one persisted edge (to gerdur) in the fixture graph.
  assert.equal(alvor.degree, 1);
});

test("standalone /api/graph only returns edges whose BOTH endpoints are in the filtered node set (no dangling edges)", async () => {
  const { body } = await getJson(`/api/graph?world=${WORLD}&filter=unreviewed`);
  // alvor is the only flagged node; its only edge partner (gerdur) is not
  // flagged, so no edge should be returned at all.
  assert.equal(body.edges.length, 0);
});

// ---------------------------------------------------------------------------
// Phase 12 task 12.2 -- new node/edge metadata fields (importance, session-
// staleness, foundryRef presence, status/playerKnown/canonLocked/role).
// ---------------------------------------------------------------------------

test("Phase 12: node payload carries importance/hasFoundryRef/status/playerKnown/canonLocked/role", async () => {
  const { body } = await getJson(`/api/graph?world=${WORLD}&filter=all`);
  const alvor = body.nodes.find((n) => n.id === "alvor");
  assert.equal(alvor.importance, 0.5);
  assert.equal(alvor.hasFoundryRef, false);
  // The fixture's applyHeadless calls never set these four Phase-12 fields
  // explicitly, so interchange.mjs's normalizeEntity defaults apply:
  // person -> status:"alive", role:"npc"; playerKnown always null; canonLocked always false.
  assert.equal(alvor.status, "alive");
  assert.equal(alvor.role, "npc");
  assert.equal(alvor.playerKnown, null);
  assert.equal(alvor.canonLocked, false);
});

test("Phase 12: edge payload carries strength/valence/notes, needed by the new edge popover", async () => {
  const { body } = await getJson(`/api/graph?world=${WORLD}&filter=all`);
  const edge = body.edges.find((e) => e.sourceId === "alvor" && e.targetId === "gerdur");
  assert.ok(edge, "expected the alvor<->gerdur fixture edge");
  assert.equal(typeof edge.strength, "number");
  assert.ok("valence" in edge);
  assert.ok("notes" in edge);
});

test("Phase 12: a place entity gets a place-appropriate default status (not person's 'alive')", async () => {
  const { body } = await getJson(`/api/graph?world=${WORLD}&filter=all`);
  const guard = body.nodes.find((n) => n.id === "riverwood-guard");
  assert.ok(guard, "expected riverwood-guard fixture entity");
  // riverwood-guard is type:"faction" in this fixture -- faction defaults to "active".
  assert.equal(guard.status, "active");
  assert.equal(guard.role, null, "role only applies to person entities");
});
