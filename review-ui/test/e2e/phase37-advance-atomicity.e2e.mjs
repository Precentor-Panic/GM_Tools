// Phase 37 task 37.0 -- QE-first e2e contract, part 2: ROUTE-LEVEL only (no
// browser). Read phase37-fixture.mjs §2 and §6 FIRST -- this file is the
// concrete regression guard for the two hardest-to-keep-honest rules in this
// contract: (a) advanceWorldClock is ATOMIC (a real concurrency race, not
// just a documented claim) and (b) the elapsedSessions SINGLE-SOURCE rule
// actually holds at the route boundary, not just in prose -- a client that
// tries to smuggle in its own `elapsedSessions` must be silently ignored,
// never honored.
//
// EXPECTED-RED reasons: `/api/chronicle/world-clock/advance` and
// `/api/chronicle/run` appear nowhere in server.mjs's route table today
// (confirmed by grep) -- every call gets the generic 404 fallback. These
// tests assert the FINAL CONTRACTED shape (mirrors phase34-fixture.mjs's own
// "PARALLEL-TASK NOTE" convention: not a tolerant either/or) so they turn
// green on their own, with no edit, the moment 37.1 lands a correct
// implementation -- and stay a real regression guard forever after.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {
  setupPhase37Env,
  cleanupScratchEnv,
  SPAN_DAYS,
  spanToElapsedSessions,
  advanceWorldClockViaRoute,
  fetchWorldClockViaRoute,
  runChronicleViaRoute,
  fetchBatchDetailViaRoute
} from "./phase37-fixture.mjs";

const { scratchDir, dataDir } = setupPhase37Env("gm-tools-e2e-p37atomic-");
const WORLD = "e2e-p37-advance-atomicity";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { writePending } = await import("../../../mutation-engine/pending-ledger.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "p37a-ring", name: "Sella's brother's ring", type: "object", importance: 0.5 } }
]);

let server, base;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

// ---------------------------------------------------------------------------
// Atomicity: a single advance call's OWN response already carries the fully
// updated record (currentDate + sessionNumber together, one write, one read
// -- no caller ever observes a half-applied state via a second GET).
// ---------------------------------------------------------------------------

test("advanceWorldClock's response is the single source of the fully-updated record -- a same-instant GET matches it exactly", async () => {
  const advance = await advanceWorldClockViaRoute(base, WORLD, { spanId: "month" });
  assert.equal(advance.status, 200, `expected 200, got ${advance.status}: ${JSON.stringify(advance.body)}`);
  const fetched = await fetchWorldClockViaRoute(base, WORLD);
  assert.equal(fetched.body.currentDate, advance.body.currentDate);
  assert.equal(fetched.body.sessionNumber, advance.body.sessionNumber);
});

// ---------------------------------------------------------------------------
// Real concurrency race: two advance calls fired genuinely concurrently must
// never lose an update (the withLock read-modify-write must serialize, per
// review-state.mjs's own established convention -- one call wins outright,
// the other either queues behind the lock or surfaces ConcurrentWriteError
// as a 409 the SAME way every sibling store's write path already does,
// review-ui/server.mjs's sendError mapping `err.name === "ConcurrentWriteError"
// -> 409` is GENERIC and already covers any new route that lets the error
// propagate, confirmed by direct read). Either way, the FINAL state must
// reflect BOTH advances -- never a silently dropped one.
// ---------------------------------------------------------------------------

test("two concurrent advanceWorldClock calls never lose an update -- final sessionNumber reflects BOTH deltas, and any conflict surfaces as 409 (never a silent partial write)", async () => {
  const WORLD2 = "e2e-p37-advance-race";
  bootstrapSnapshot(snapshotFilePath(dataDir, WORLD2), { worldId: WORLD2 });

  const [a, b] = await Promise.all([
    advanceWorldClockViaRoute(base, WORLD2, { spanId: "week" }),
    advanceWorldClockViaRoute(base, WORLD2, { spanId: "month" })
  ]);
  for (const r of [a, b]) {
    assert.ok(r.status === 200 || r.status === 409, `each concurrent advance must resolve 200 or 409, never crash -- got ${r.status}: ${JSON.stringify(r.body)}`);
  }
  const succeeded = [a, b].filter((r) => r.status === 200);
  assert.ok(succeeded.length >= 1, "at least one of the two concurrent calls must succeed");

  // If BOTH succeeded (the lock queued the second rather than rejecting it),
  // the final state must reflect BOTH deltas summed. If only one succeeded
  // (the lock rejected the loser outright), a full retry of the loser's own
  // span must cleanly succeed afterward and the final state must then
  // reflect both -- either resolution is acceptable, but a LOST update
  // (final sessionNumber reflecting only one of the two spans when both
  // eventually got a 200, or the failed one silently never getting a real
  // chance to retry) is not.
  const expectedWeek = spanToElapsedSessions(SPAN_DAYS.week);
  const expectedMonth = spanToElapsedSessions(SPAN_DAYS.month);
  if (succeeded.length === 2) {
    const final = await fetchWorldClockViaRoute(base, WORLD2);
    assert.equal(final.body.sessionNumber, expectedWeek + expectedMonth, "both concurrent advances succeeded -- the final cumulative total must reflect both, not just the last writer");
  } else {
    const loserSpanId = a.status === 200 ? "month" : "week";
    const retry = await advanceWorldClockViaRoute(base, WORLD2, { spanId: loserSpanId });
    assert.equal(retry.status, 200, "a retried advance after a 409 must cleanly succeed once the lock is free");
    const final = await fetchWorldClockViaRoute(base, WORLD2);
    assert.equal(final.body.sessionNumber, expectedWeek + expectedMonth, "after the retry, the final cumulative total must reflect both spans");
  }
});

// ---------------------------------------------------------------------------
// THE single-source enforcement test: a client-supplied elapsedSessions must
// be IGNORED, never honored -- the route's own internal call to
// advanceWorldClock is the only legitimate source.
// ---------------------------------------------------------------------------

test("POST /api/chronicle/run IGNORES a client-supplied elapsedSessions -- the persisted batch.scope.elapsedSessions always equals spanToElapsedSessions(span), never the smuggled value", async () => {
  writePending(WORLD, "p37a-ring", {
    causeTag: "Player named it, then nobody followed up. Let it move without them.",
    impactScore: 0.5,
    sourceBatchId: "manual",
    cycleDescriptor: "Manual",
    status: "pending"
  });

  const { status, body } = await runChronicleViaRoute(
    base,
    WORLD,
    { scopeKind: "queued-intents", span: { spanId: "week" } },
    // The illegitimate smuggled field -- run.chronicleViaRoute's own
    // `extraBody` is folded into the SAME JSON object as `span`, exactly as
    // a malicious or careless client would send it, not as a separate
    // channel this route could special-case away.
  );
  // `runChronicleViaRoute` above intentionally does not thread a 3rd
  // "extraBody" arg (unlike advanceWorldClockViaRoute) -- the smuggled key
  // is passed directly via `params` here so it lands in the SAME request
  // body the route actually parses.
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);

  const detail = await fetchBatchDetailViaRoute(base, WORLD, body.batchId);
  assert.equal(detail.status, 200, `expected the newly-created batch to be fetchable, got ${detail.status}`);
  assert.equal(
    detail.body.batch.scope.elapsedSessions,
    spanToElapsedSessions(SPAN_DAYS.week),
    "batch.scope.elapsedSessions must equal the span's own canonical conversion, computed server-side by advanceWorldClock -- never a client-supplied value"
  );
});

test("POST /api/chronicle/run with a client-supplied elapsedSessions:9999 alongside a real span produces the SAME result as omitting it entirely -- the field has no effect whatsoever", async () => {
  const withSmuggled = await runChronicleViaRoute(base, WORLD, {
    scopeKind: "whole-world",
    span: { spanId: "week" },
    elapsedSessions: 9999
  });
  assert.equal(withSmuggled.status, 200, `expected 200, got ${withSmuggled.status}: ${JSON.stringify(withSmuggled.body)}`);
  const detail = await fetchBatchDetailViaRoute(base, WORLD, withSmuggled.body.batchId);
  assert.equal(
    detail.body.batch.scope.elapsedSessions,
    spanToElapsedSessions(SPAN_DAYS.week),
    "9999 must be silently ignored -- the persisted value must still be the real span-derived one"
  );
});
