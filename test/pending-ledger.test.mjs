import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, openSync, closeSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate both review-state.mjs (pending-ledger.mjs reuses its withLock) and
// pending-ledger.mjs's own root before importing either — same isolation
// pattern as test/review-state.test.mjs.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-pending-ledger-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");

const {
  writePending,
  readPending,
  readAvailablePending,
  listPendingEntities,
  markProposed,
  markResolved,
  revertToPending,
  applyLedgerOutcome,
  sourceBatchHeadline,
  ConcurrentWriteError
} = await import("../mutation-engine/pending-ledger.mjs");
const { createBatch } = await import("../mutation-engine/review-state.mjs");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

const WORLD = "wf-test";

function baseEntry(overrides = {}) {
  return {
    causeTag: "ripple from events at Riverwood, month 3",
    impactScore: 0.3,
    sourceBatchId: "batch_abc",
    cycleDescriptor: "month 3",
    ...overrides
  };
}

// --------------------------------------------------------------- write/read

test("writePending/readPending: round-trip, entries accumulate in append order", () => {
  const entity = "ent-writeread";
  assert.deepEqual(readPending(WORLD, entity), [], "no file yet -- [] not an error");

  writePending(WORLD, entity, baseEntry(), { makeId: () => "p1" });
  writePending(WORLD, entity, baseEntry({ cycleDescriptor: "month 4" }), { makeId: () => "p2" });

  const entries = readPending(WORLD, entity);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].entryId, "p1");
  assert.equal(entries[1].entryId, "p2");
  assert.ok(entries.every((e) => e.status === "pending"));
  assert.ok(entries.every((e) => typeof e.createdAt === "string" && e.createdAt.length > 0));
});

test("writePending: throws on a malformed entry rather than persisting it", () => {
  const entity = "ent-malformed";
  assert.throws(() => writePending(WORLD, entity, { causeTag: "x" /* missing required fields */ }));
  assert.deepEqual(readPending(WORLD, entity), []);
});

// ------------------------------------------------------------ listPendingEntities

test("listPendingEntities: finds entities with a pending backlog, ignores those without", () => {
  writePending(WORLD, "ent-has-backlog", baseEntry(), { makeId: () => "lp1" });
  const list = listPendingEntities(WORLD);
  assert.ok(list.includes("ent-has-backlog"));
  assert.equal(list.includes("ent-never-touched"), false);
});

test("listPendingEntities: an entity whose only entries are 'proposed' (locked) does not count as an available backlog", () => {
  const entity = "ent-all-proposed";
  writePending(WORLD, entity, baseEntry(), { makeId: () => "ap1" });
  markProposed(WORLD, entity, ["ap1"]);
  assert.equal(listPendingEntities(WORLD).includes(entity), false);
  // But it's still readable -- not deleted, just not "available".
  assert.equal(readPending(WORLD, entity).length, 1);
  assert.equal(readPending(WORLD, entity)[0].status, "proposed");
});

test("listPendingEntities: empty for a world with no ledger directory yet", () => {
  assert.deepEqual(listPendingEntities("wf-nonexistent-world"), []);
});

// ------------------------------------------------------------ readAvailablePending

test("readAvailablePending: filters out 'proposed' entries, keeps only 'pending' ones", () => {
  const entity = "ent-available-filter";
  writePending(WORLD, entity, baseEntry(), { makeId: () => "avail1" });
  writePending(WORLD, entity, baseEntry({ cycleDescriptor: "month 4" }), { makeId: () => "avail2" });
  markProposed(WORLD, entity, ["avail1"]);

  const available = readAvailablePending(WORLD, entity);
  assert.equal(available.length, 1);
  assert.equal(available[0].entryId, "avail2");

  // readPending() itself is unfiltered -- both still present on disk.
  assert.equal(readPending(WORLD, entity).length, 2);
});

test("readAvailablePending: [] for an entity with no ledger file at all", () => {
  assert.deepEqual(readAvailablePending(WORLD, "ent-never-touched-2"), []);
});

// ------------------------------------------------------------ sourceBatchHeadline

test("sourceBatchHeadline: renders a real batch's headline", () => {
  const batch = createBatch(
    WORLD,
    { mode: "manual" },
    "a session",
    [{ op: "upsert_entity", id: "ent1", data: {}, rationale: "test", batchId: "placeholder", sourceKind: "manual" }],
    { makeId: () => "batch_headline_test" }
  );
  const headline = sourceBatchHeadline(WORLD, batch.id);
  assert.ok(headline.includes("batch_headline_test"), "should render the real batch's own headline text");
});

test("sourceBatchHeadline: degrades gracefully (placeholder, not a throw) for a missing/unreadable batch", () => {
  assert.doesNotThrow(() => sourceBatchHeadline(WORLD, "batch_does_not_exist"));
  const headline = sourceBatchHeadline(WORLD, "batch_does_not_exist");
  assert.match(headline, /unavailable/);
});

test("sourceBatchHeadline: an optional cache Map avoids recomputation for a repeated batchId", () => {
  const batch = createBatch(
    WORLD,
    { mode: "manual" },
    "a session",
    [{ op: "upsert_entity", id: "ent1", data: {}, rationale: "test", batchId: "placeholder", sourceKind: "manual" }],
    { makeId: () => "batch_cache_test" }
  );
  const cache = new Map();
  const first = sourceBatchHeadline(WORLD, batch.id, cache);
  assert.ok(cache.has(batch.id), "cache should be populated after the first call");
  // Poison the cache with a sentinel value -- if the second call actually
  // re-renders instead of reading the cache, this assertion would fail.
  cache.set(batch.id, "SENTINEL_FROM_CACHE");
  const second = sourceBatchHeadline(WORLD, batch.id, cache);
  assert.equal(second, "SENTINEL_FROM_CACHE", "second call should read from the cache, not re-render");
  assert.notEqual(first, "SENTINEL_FROM_CACHE");
});

// --------------------------------------------------------------- concurrency

test("concurrent write: an existing lock file causes writePending to be rejected, not silently clobbered", () => {
  const entity = "ent-concurrency";
  writePending(WORLD, entity, baseEntry(), { makeId: () => "cc1" });
  const originalRaw = JSON.stringify(readPending(WORLD, entity));

  const ledgerDir = join(process.env.GM_TOOLS_PENDING_LEDGER_DIR, WORLD);
  mkdirSync(ledgerDir, { recursive: true });
  const lockPath = join(ledgerDir, `${entity}.json.lock`);
  const fd = openSync(lockPath, "wx");
  closeSync(fd);

  try {
    assert.throws(
      () => writePending(WORLD, entity, baseEntry({ cycleDescriptor: "month 5" }), { makeId: () => "cc2" }),
      ConcurrentWriteError
    );
    const afterRaw = JSON.stringify(readPending(WORLD, entity));
    assert.equal(afterRaw, originalRaw, "ledger file must be unchanged after a rejected concurrent write");
  } finally {
    rmSync(lockPath, { force: true });
  }

  // Once the lock clears, a normal write succeeds.
  writePending(WORLD, entity, baseEntry({ cycleDescriptor: "month 5" }), { makeId: () => "cc2" });
  assert.equal(readPending(WORLD, entity).length, 2);
});

// --------------------------------------------------------- markResolved / revertToPending

test("markResolved: actually removes entries (terminal state), not just a status flag", () => {
  const entity = "ent-resolve";
  writePending(WORLD, entity, baseEntry(), { makeId: () => "r1" });
  writePending(WORLD, entity, baseEntry({ cycleDescriptor: "month 4" }), { makeId: () => "r2" });
  markProposed(WORLD, entity, ["r1"]);

  markResolved(WORLD, entity, ["r1"]);
  const remaining = readPending(WORLD, entity);
  assert.equal(remaining.length, 1, "resolved entry should be gone entirely, not flagged");
  assert.equal(remaining[0].entryId, "r2");
});

test("revertToPending: restores status to 'pending' without deleting anything (reject path)", () => {
  const entity = "ent-revert";
  writePending(WORLD, entity, baseEntry(), { makeId: () => "v1" });
  markProposed(WORLD, entity, ["v1"]);
  assert.equal(readPending(WORLD, entity)[0].status, "proposed");

  revertToPending(WORLD, entity, ["v1"]);
  const entries = readPending(WORLD, entity);
  assert.equal(entries.length, 1, "nothing deleted");
  assert.equal(entries[0].status, "pending");
  assert.ok(listPendingEntities(WORLD).includes(entity), "entity should be available again after revert");
});

// --------------------------------------------------------------- applyLedgerOutcome

test("applyLedgerOutcome: no-op (returns []) for a batch with no resolvedPendingEntries", () => {
  const batch = { world: WORLD, mutations: [{ mutationId: "m0", regionId: "region-0" }] };
  assert.deepEqual(applyLedgerOutcome(batch, ["m0"], "accepted"), []);
});

test("applyLedgerOutcome: accept resolves (removes) only the entries whose regionId was actually touched", () => {
  const entity = "ent-outcome-accept";
  writePending(WORLD, entity, baseEntry(), { makeId: () => "oa1" });
  markProposed(WORLD, entity, ["oa1"]);

  const otherEntity = "ent-outcome-untouched";
  writePending(WORLD, otherEntity, baseEntry(), { makeId: () => "oa2" });
  markProposed(WORLD, otherEntity, ["oa2"]);

  const batch = {
    world: WORLD,
    mutations: [
      { mutationId: "m0", regionId: "region-resolve-pending" },
      { mutationId: "m1", regionId: "region-other" }
    ],
    resolvedPendingEntries: [
      { regionId: "region-resolve-pending", entityId: entity, entryIds: ["oa1"] },
      { regionId: "region-other-sweep", entityId: otherEntity, entryIds: ["oa2"] }
    ]
  };

  const applied = applyLedgerOutcome(batch, ["m0"], "accepted");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].entityId, entity);
  assert.equal(readPending(WORLD, entity).length, 0, "touched region's entries should be resolved (removed)");
  assert.equal(readPending(WORLD, otherEntity).length, 1, "untouched region's entries must be left alone");
  assert.equal(readPending(WORLD, otherEntity)[0].status, "proposed");
});

test("applyLedgerOutcome: reject reverts the touched entries to 'pending', doesn't delete them", () => {
  const entity = "ent-outcome-reject";
  writePending(WORLD, entity, baseEntry(), { makeId: () => "or1" });
  markProposed(WORLD, entity, ["or1"]);

  const batch = {
    world: WORLD,
    mutations: [{ mutationId: "m0", regionId: "region-resolve-pending" }],
    resolvedPendingEntries: [{ regionId: "region-resolve-pending", entityId: entity, entryIds: ["or1"] }]
  };

  applyLedgerOutcome(batch, ["m0"], "rejected");
  const entries = readPending(WORLD, entity);
  assert.equal(entries.length, 1, "reverted entry must still exist");
  assert.equal(entries[0].status, "pending");
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
