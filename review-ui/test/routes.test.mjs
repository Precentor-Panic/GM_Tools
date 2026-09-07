import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";

/**
 * Task 6.1's acceptance criterion: "a smoke test (real HTTP requests against
 * a running instance of this server, not mocked) exercising each route
 * against a fixture world: list batches, get one, accept a mutation, request
 * narration on a fully-accepted batch (succeeds) and on a partially-accepted
 * one (clean error, not a crash), resolve a pending-ledger entry, rollback."
 *
 * This file covers everything from that list EXCEPT the two cases that
 * require a real, billed Anthropic API call (narration actually succeeding,
 * and resolving a pending-ledger entry, both of which make a real
 * textureRegion/narrateBatch call) -- those are covered by the sibling
 * routes-live.smoke.mjs, matching this project's own established split
 * between a deterministic *.test.mjs (mocked/no-LLM) and a real-API
 * *.smoke.mjs (see gm-tools-conventions: "LLM-dependent code gets a unit
 * test with the API call mocked ... plus a documented ... smoke test that
 * makes a real API call" -- narrateOp/resolvePending's underlying
 * narrateBatch/textureRegion calls have no test-time client-injection seam
 * threaded through the HTTP layer at all, same as the original
 * wf_narrate_batch/wf_resolve_pending MCP tool handlers this was extracted
 * from, so a real call is the only way to prove the success path here, same
 * as wf-mcp-server/test/live-diff-narrate.smoke.mjs already does at the MCP
 * layer). What IS proven here, deterministically: the narration GATE itself
 * (empty batch, partially-accepted batch) -- the single most important
 * correctness requirement in this phase -- never needs an API call to fail
 * cleanly, since assertBatchNarratable() runs before any prompt is built.
 *
 * Real HTTP requests via fetch() against an in-process server.listen(0)
 * (ephemeral port) -- no subprocess needed (unlike wf-mcp-server's MCP
 * tests, which need a real stdio transport): server.mjs's route handlers
 * read process.env directly (via resolveWorld/resolveDir and each library
 * module's own env-var convention), so setting env vars in this same
 * process before each request is sufficient, no spawn required.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-review-ui-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_PLAYER_NOTES_ANALYSIS_DIR = join(scratchDir, "player-notes-analysis");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "review-ui-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch, loadBatch } = await import("../../mutation-engine/review-state.mjs");
const { writePending } = await import("../../mutation-engine/pending-ledger.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });

// mutation-engine/human-review.mjs's tracking is keyed by (world, entityId)
// and persists across every batch touching that entity within this test
// file's shared world -- so each test that asserts on human-review state
// (reviewed vs. not) needs its OWN, never-before-touched pair of entities,
// not the same "alvor"/"riverwood" reused everywhere (a genuine cross-test
// contamination bug found while writing this file, not a product bug --
// fixed here by minting a fresh entity pair per call, suffixed by a counter).
let entityCounter = 0;
function makeTwoMutationBatch() {
  const suffix = entityCounter++;
  const idA = `alvor-${suffix}`;
  const idB = `riverwood-${suffix}`;
  applyHeadless(snapPath, [
    { op: "upsert_entity", data: { id: idA, name: `Alvor ${suffix}`, type: "person", importance: 0.5 } },
    { op: "upsert_entity", data: { id: idB, name: `Riverwood ${suffix}`, type: "place", importance: 0.7 } }
  ]);
  const batch = createBatch(WORLD, { mode: "manual" }, "a test session", [
    {
      op: "upsert_entity",
      id: idA,
      data: { importance: 0.6 },
      rationale: "Alvor's standing shifts.",
      batchId: "placeholder",
      sourceKind: "manual",
      entityContext: { name: `Alvor ${suffix}`, importance: 0.6, tags: [] }
    },
    {
      op: "upsert_entity",
      id: idB,
      data: { importance: 0.8 },
      rationale: "Riverwood grows more prominent.",
      batchId: "placeholder",
      sourceKind: "manual",
      entityContext: { name: `Riverwood ${suffix}`, importance: 0.8, tags: [] }
    }
  ]);
  return { ...batch, idA, idB };
}

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
async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

test("GET / serves the static shell", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
});

test("SECURITY: a client-supplied dataDir is never honored -- GET /api/worlds ignores it and resolves from server-side env config regardless", async () => {
  // Real security-review finding: resolveDir(explicit) used to pass this
  // straight through into every downstream file path. This server has no
  // auth layer of its own (see server.mjs's own top-of-file comment), so
  // the fix is to never forward a client-supplied dataDir at all, not to
  // validate the string -- confirm the route reports the REAL configured
  // dataDir, not the (nonsense, traversal-shaped) one a client sent.
  const { status, body } = await getJson(`/api/worlds?dataDir=${encodeURIComponent("../../../etc")}`);
  assert.equal(status, 200);
  assert.equal(body.dataDir, dataDir, "must resolve from WF_DATA_DIR, completely ignoring the client-supplied dataDir");
  assert.ok(body.worlds.includes(WORLD), "still finds the real fixture world under the real dataDir");
});

test("SECURITY: a path-traversal-shaped world id is rejected with a clean error, not silently resolved into a file path", async () => {
  const { status, body } = await getJson(`/api/batches?world=${encodeURIComponent("../../../../etc")}`);
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("GET /api/worlds lists the fixture world", async () => {
  const { status, body } = await getJson("/api/worlds");
  assert.equal(status, 200);
  assert.ok(body.worlds.includes(WORLD));
});

test("GET /api/batches lists a created batch", async () => {
  const batch = makeTwoMutationBatch();
  const { status, body } = await getJson(`/api/batches?world=${WORLD}`);
  assert.equal(status, 200);
  const found = body.batches.find((b) => b.id === batch.id);
  assert.ok(found, "created batch should appear in the list");
  assert.equal(found.pendingCount, 2);
  assert.equal(found.status, "open");
});

test("GET /api/batches/:id returns full batch detail with per-entity status and narratable=false", async () => {
  const batch = makeTwoMutationBatch();
  const { status, body } = await getJson(`/api/batches/${batch.id}?world=${WORLD}`);
  assert.equal(status, 200);
  assert.equal(body.batch.id, batch.id);
  assert.equal(body.narratable, false, "nothing accepted yet -- must not be narratable");
  const allEntities = body.regions.flatMap((r) => r.entities);
  assert.equal(allEntities.length, 2);
  assert.ok(allEntities.every((e) => e.status === "pending"));
});

test("POST /api/batches/:id/narrate on a batch with NOTHING accepted is rejected cleanly (409, not a crash)", async () => {
  const batch = makeTwoMutationBatch();
  const { status, body } = await postJson(`/api/batches/${batch.id}/narrate`, { world: WORLD });
  assert.equal(status, 409);
  assert.equal(body.name, "NarrationGateError");
  assert.equal(body.notAccepted.length, 2);
});

test("POST /api/batches/:id/accept scope='entity' accepts one mutation and marks it human-reviewed", async () => {
  const batch = makeTwoMutationBatch();
  const { status, body } = await postJson(`/api/batches/${batch.id}/accept`, { world: WORLD, scope: "entity", id: "m0" });
  assert.equal(status, 200);
  assert.deepEqual(body.accepted, ["m0"]);
  assert.equal(body.batchStatus, "open");

  const { body: unreviewed } = await getJson(`/api/unreviewed-entities?world=${WORLD}`);
  assert.ok(!unreviewed.entities.some((e) => e.entityId === batch.idA), "a scoped ('entity') accept must count as a genuine review");
});

test("POST /api/batches/:id/narrate on a PARTIALLY-accepted batch is rejected cleanly (409), naming the still-pending mutation", async () => {
  const batch = makeTwoMutationBatch();
  await postJson(`/api/batches/${batch.id}/accept`, { world: WORLD, scope: "entity", id: "m0" });

  const { status, body } = await postJson(`/api/batches/${batch.id}/narrate`, { world: WORLD });
  assert.equal(status, 409);
  assert.equal(body.name, "NarrationGateError");
  assert.equal(body.notAccepted.length, 1);
  assert.equal(body.notAccepted[0].mutationId, "m1");
  assert.equal(body.notAccepted[0].status, "pending");
});

test("POST /api/batches/:id/accept scope='batch' (accept-all) does NOT mark entities as human-reviewed -- the accept-vs-review distinction", async () => {
  const batch = makeTwoMutationBatch();
  const { status, body } = await postJson(`/api/batches/${batch.id}/accept`, { world: WORLD, scope: "batch" });
  assert.equal(status, 200);
  assert.equal(body.accepted.length, 2);

  const { body: unreviewed } = await getJson(`/api/unreviewed-entities?world=${WORLD}`);
  const flaggedIds = unreviewed.entities.map((e) => e.entityId);
  assert.ok(flaggedIds.includes(batch.idA) && flaggedIds.includes(batch.idB), "a whole-batch accept-all must NOT count as review -- both entities should still be flagged");
});

test("GET /api/unreviewed-entities includes each flagged entity's real name, not just its raw id (task 14.6 regression, confirmed independently by both QA personas)", async () => {
  const batch = makeTwoMutationBatch();
  await postJson(`/api/batches/${batch.id}/accept`, { world: WORLD, scope: "batch" }); // accept-all -- does NOT count as review, both entities stay flagged

  const { body } = await getJson(`/api/unreviewed-entities?world=${WORLD}`);
  const entryA = body.entities.find((e) => e.entityId === batch.idA);
  const entryB = body.entities.find((e) => e.entityId === batch.idB);
  assert.ok(entryA, "precondition: idA should be flagged");
  assert.ok(entryB, "precondition: idB should be flagged");
  assert.ok(entryA.name && entryA.name !== entryA.entityId, `entry should carry a real display name distinct from its raw id, got name="${entryA.name}"`);
  assert.ok(entryA.name.startsWith("Alvor "), `expected the real entity name ("Alvor <suffix>"), got "${entryA.name}"`);
  assert.ok(entryB.name.startsWith("Riverwood "), `expected the real entity name ("Riverwood <suffix>"), got "${entryB.name}"`);
});

test("POST /api/unreviewed-entities/:entityId/mark-reviewed dismisses a flag with no batch context required -- real gap found via hands-on use (a flagged entity with no open batch had no way to be acknowledged)", async () => {
  const batch = makeTwoMutationBatch();
  await postJson(`/api/batches/${batch.id}/accept`, { world: WORLD, scope: "batch" });

  const before = await getJson(`/api/unreviewed-entities?world=${WORLD}`);
  assert.ok(before.body.entities.map((e) => e.entityId).includes(batch.idA), "precondition: idA must be flagged before dismissal");

  const { status, body } = await postJson(`/api/unreviewed-entities/${batch.idA}/mark-reviewed`, { world: WORLD });
  assert.equal(status, 200);
  assert.equal(body.marked, true);

  const after = await getJson(`/api/unreviewed-entities?world=${WORLD}`);
  const afterIds = after.body.entities.map((e) => e.entityId);
  assert.ok(!afterIds.includes(batch.idA), "idA must no longer be flagged after mark-reviewed");
  assert.ok(afterIds.includes(batch.idB), "idB was untouched -- must still be flagged");
});

test("bulk-accept with an explicit reviewedMutationIds subset splits reviewed vs unreviewed per mutation", async () => {
  const batch = makeTwoMutationBatch();
  const { status, body } = await postJson(`/api/batches/${batch.id}/bulk-accept`, {
    world: WORLD,
    mutationIds: ["m0", "m1"],
    reviewedMutationIds: ["m0"] // m0 was individually expanded/read; m1 was only swept in via bulk select
  });
  assert.equal(status, 200);
  assert.equal(body.accepted.length, 2);

  const { body: unreviewed } = await getJson(`/api/unreviewed-entities?world=${WORLD}`);
  const flaggedIds = unreviewed.entities.map((e) => e.entityId);
  assert.ok(!flaggedIds.includes(batch.idA), "m0 was in reviewedMutationIds -- must count as reviewed");
  assert.ok(flaggedIds.includes(batch.idB), "m1 was NOT in reviewedMutationIds -- must NOT count as reviewed");
});

test("self-review remediation: bulk-accept OMITTING reviewedMutationIds entirely defaults to nothing-reviewed (safe default), not everything-reviewed", async () => {
  const batch = makeTwoMutationBatch();
  const { status, body } = await postJson(`/api/batches/${batch.id}/bulk-accept`, {
    world: WORLD,
    mutationIds: ["m0", "m1"]
    // reviewedMutationIds deliberately omitted -- must NOT silently credit both as reviewed
  });
  assert.equal(status, 200);
  assert.equal(body.accepted.length, 2);

  const { body: unreviewed } = await getJson(`/api/unreviewed-entities?world=${WORLD}`);
  const flaggedIds = unreviewed.entities.map((e) => e.entityId);
  assert.ok(flaggedIds.includes(batch.idA) && flaggedIds.includes(batch.idB), "omitting reviewedMutationIds must be the conservative default -- neither entity should count as reviewed");
});

test("bulk-reject accepts a plain mutationIds array and rejects each", async () => {
  const batch = makeTwoMutationBatch();
  const { status, body } = await postJson(`/api/batches/${batch.id}/bulk-reject`, {
    world: WORLD,
    mutationIds: ["m0", "m1"]
  });
  assert.equal(status, 200);
  assert.deepEqual(body.rejected.sort(), ["m0", "m1"]);
  const reloaded = loadBatch(WORLD, batch.id);
  assert.ok(reloaded.mutations.every((m) => m.status === "rejected"));
});

test("full accept -> sync (headless) -> rollback round trip via the HTTP API", async () => {
  const batch = makeTwoMutationBatch();
  await postJson(`/api/batches/${batch.id}/accept`, { world: WORLD, scope: "batch" });

  const detail = await getJson(`/api/batches/${batch.id}?world=${WORLD}`);
  assert.equal(detail.body.narratable, true, "fully-accepted batch should report narratable=true");

  const sync = await postJson(`/api/batches/${batch.id}/sync`, { world: WORLD });
  assert.equal(sync.status, 200);
  assert.equal(sync.body.path, "headless", "no live Foundry client in this test -- must fall back to headless");
  assert.equal(sync.body.status, "applied");

  const onDiskAfterSync = JSON.parse(readFileSync(snapPath, "utf8")).snapshot.entities;
  assert.equal(onDiskAfterSync.find((e) => e.id === batch.idA).importance, 0.6);
  assert.equal(onDiskAfterSync.find((e) => e.id === batch.idB).importance, 0.8);

  const lastRollbackable = await getJson(`/api/last-rollbackable-batch?world=${WORLD}`);
  assert.equal(lastRollbackable.status, 200);
  assert.equal(lastRollbackable.body.batch.id, batch.id);

  const rollback = await postJson(`/api/batches/${batch.id}/rollback`, { world: WORLD });
  assert.equal(rollback.status, 200);
  assert.equal(rollback.body.path, "headless");

  const onDiskAfterRollback = JSON.parse(readFileSync(snapPath, "utf8")).snapshot.entities;
  assert.equal(onDiskAfterRollback.find((e) => e.id === batch.idA).importance, 0.5, "rollback should restore the pre-accept importance");
  assert.equal(onDiskAfterRollback.find((e) => e.id === batch.idB).importance, 0.7, "rollback should restore the pre-accept importance");
});

test("GET /api/pending-entities lists an entity with an available ledger backlog", async () => {
  applyHeadless(snapPath, [{ op: "upsert_entity", data: { id: "pending-fixture-npc", name: "Borin", type: "person", importance: 0.3 } }]);
  writePending(WORLD, "pending-fixture-npc", {
    causeTag: "Borin: raided (cycle 1)",
    impactScore: 0.4,
    sourceBatchId: "batch_fixture",
    cycleDescriptor: "cycle 1"
  });
  const { status, body } = await getJson(`/api/pending-entities?world=${WORLD}`);
  assert.equal(status, 200);
  const found = body.entities.find((e) => e.entityId === "pending-fixture-npc");
  assert.ok(found, "the fixture entity should be listed as having a pending backlog");
  assert.equal(found.name, "Borin");
  assert.equal(found.entries.length, 1);
  assert.equal(found.entries[0].cycleDescriptor, "cycle 1");
});

test("an unknown route returns a clean 404, not a crash", async () => {
  const { status, body } = await getJson("/api/does-not-exist");
  assert.equal(status, 404);
  assert.ok(body.error);
});

test("POST /api/batches/:id/narrate on a batch with zero mutations is also rejected cleanly (409)", async () => {
  const batch = createBatch(WORLD, { mode: "manual" }, undefined, []);
  const { status, body } = await postJson(`/api/batches/${batch.id}/narrate`, { world: WORLD });
  assert.equal(status, 409);
  assert.equal(body.name, "NarrationGateError");
});

// ---------------------------------------------------------------------------
// Phase 37 task 37.2: the "add an intent by hand" flow (phase37-fixture.mjs
// §5, the piece 37.1 deferred). POST /api/chronicle/intents resolves a
// free-typed name into an entityId (dedup-or-create) then writePending with
// the pinned sentinels. Deterministic -- no LLM anywhere on this path.
// ---------------------------------------------------------------------------
test("POST /api/chronicle/intents creates a minimal concept entity for a brand-new name and queues it as a Manual pending entry", async () => {
  const name = "Sella's brother's ring — who has it now?";
  const { status, body } = await postJson("/api/chronicle/intents", { world: WORLD, name });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.name, name);
  assert.equal(body.type, "concept", "a hand-typed intent with no graph match becomes a minimal concept entity");
  assert.ok(body.entityId && body.entityId.length > 0);
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].sourceBatchId, "manual", "the pinned sentinel");
  assert.equal(body.entries[0].cycleDescriptor, "Manual", "matches the prototype's own Manual source label");

  // Surfaces through the EXISTING deferred-lane route the same as any wrap-up intent.
  const pending = await getJson(`/api/pending-entities?world=${encodeURIComponent(WORLD)}`);
  assert.ok(pending.body.entities.some((e) => e.entityId === body.entityId), "the hand-added intent must appear in /api/pending-entities");
});

test("POST /api/chronicle/intents dedups onto an existing entity by case-insensitive name match instead of creating a duplicate", async () => {
  applyHeadless(snapPath, [{ op: "upsert_entity", data: { id: "intent-existing-forge", name: "Gorrim's Forge", type: "place", importance: 0.5 } }]);
  const { status, body } = await postJson("/api/chronicle/intents", { world: WORLD, name: "gorrim's forge", tags: ["livelihood"] });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.entityId, "intent-existing-forge", "a name match must reuse the existing entity id, not mint a new one");
  assert.equal(body.type, "place", "the matched entity's real type is returned, not 'concept'");
  assert.deepEqual(body.entries[0].tags, ["livelihood"], "tags are forwarded onto the pending entry");
});

test("POST /api/chronicle/intents rejects a blank name cleanly (no silent no-op)", async () => {
  const { status, body } = await postJson("/api/chronicle/intents", { world: WORLD, name: "   " });
  assert.equal(status, 400);
  assert.ok(body.error && /name/i.test(body.error));
});

// QA W2 fix (Group B #12): same 200-char name cap as POST /api/graph/nodes.
test("POST /api/chronicle/intents rejects a name over 200 characters with a clear 400", async () => {
  const { status, body } = await postJson("/api/chronicle/intents", { world: WORLD, name: "x".repeat(201) });
  assert.equal(status, 400);
  assert.ok(/200 characters/.test(body.error), `expected a clear length-cap message, got: ${body.error}`);
});

// Player-notes analysis routes (GM-only). Keyless-degrade + world-id hardening.
test("POST /api/player-notes/analyze degrades cleanly with no API key (offline:true, empty)", async () => {
  const { status, body } = await postJson("/api/player-notes/analyze", { world: WORLD });
  assert.equal(status, 200);
  assert.equal(body.offline, true, "no ANTHROPIC_API_KEY in test env -> offline stamp");
  assert.deepEqual(body.flags, [], "offline pass yields no flags");
  assert.ok("noteCount" in body);
});

test("GET /api/player-notes/analysis returns {current, history} (absence is valid, not a 404)", async () => {
  const { status, body } = await getJson(`/api/player-notes/analysis?world=${WORLD}`);
  assert.equal(status, 200);
  assert.ok("current" in body && "history" in body);
  assert.ok(Array.isArray(body.history));
});

test("SECURITY: player-notes/analysis rejects a malicious world id", async () => {
  const { status } = await getJson(`/api/player-notes/analysis?world=${encodeURIComponent("../../../../etc")}`);
  assert.notEqual(status, 200, "a traversal-shaped world id must not resolve");
});
