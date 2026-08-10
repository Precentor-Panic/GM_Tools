// Phase 37 task 37.0 -- QE-first e2e contract, part 1: ROUTE-LEVEL only (no
// browser -- mirrors phase36-flush-ops-shapes.e2e.mjs/
// phase35-pull-and-persistence.e2e.mjs's own route-only *.e2e.mjs precedent).
// Read phase37-fixture.mjs FIRST (§1-§5, the full contract this file locks
// in): world-clock store + advance writer, fortune store, chronicle-log read
// layer, the pending-entities `type` decoration, and the `attachDiffs`
// `type`/`risk` stamping.
//
// EXPECTED-RED reasons (per test, confirmed by direct read before writing
// these): `/api/chronicle/world-clock`, `/api/chronicle/world-clock/advance`,
// `/api/chronicle/fortune`, `/api/chronicle/log` appear nowhere in
// server.mjs's route table (confirmed by grep) -- every call gets the
// generic `{error:"No route: METHOD path"}` 404 fallback. `pendingEntities
// Payload` (review-ui/server.mjs:668, read in full) returns `{entityId,
// name, entries}` only -- no `type` key -- so the pending-entities test is a
// clean assertion failure (`entry.type === undefined`) against the REAL,
// already-shipped route's CURRENT behavior, not a 404. `attachDiffs`
// (time-skip/run.mjs, read in full) returns each mutation with `diff`
// attached but no `type`/`risk` keys -- same clean-assertion-failure shape.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {
  setupPhase37Env,
  cleanupScratchEnv,
  SPAN_DAYS,
  spanToElapsedSessions,
  FORTUNE_STOPS,
  fetchWorldClockViaRoute,
  advanceWorldClockViaRoute,
  fetchFortuneViaRoute,
  setFortuneViaRoute,
  fetchChronicleLogViaRoute,
  fetchPendingEntitiesViaRoute
} from "./phase37-fixture.mjs";

const { scratchDir, dataDir } = setupPhase37Env("gm-tools-e2e-p37clock-");
const WORLD = "e2e-p37-clock-fortune-log";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { patchSettings } = await import("../../../session-planner/app-settings.mjs");
const { writePending } = await import("../../../mutation-engine/pending-ledger.mjs");
const { createBatch } = await import("../../../mutation-engine/review-state.mjs");
const { attachDiffs } = await import("../../../time-skip/run.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "p37-forge", name: "Gorrim's Forge", type: "place", importance: 0.6 } },
  { op: "upsert_entity", data: { id: "p37-gorrim", name: "Gorrim the Smith", type: "person", importance: 0.7 } }
]);
patchSettings(WORLD, { calendar: "The Marrow Reckoning (custom)" });

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
// §1/§2 world-clock
// ---------------------------------------------------------------------------

test("GET /api/chronicle/world-clock defaults to Day 0 / sessionNumber 0, and composes calendar from the EXISTING app-settings store", async () => {
  const { status, body } = await fetchWorldClockViaRoute(base, WORLD);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.currentDate, "Day 0", "a brand-new world's currentDate must default to the generic v1 fallback (§1's documented date-advance scope decision)");
  assert.equal(body.sessionNumber, 0);
  assert.equal(body.calendar, "The Marrow Reckoning (custom)", "calendar must be sourced from app-settings.mjs's own calendar field, never a separate world-clock copy (§1's single-source pin)");
});

test("advanceWorldClock(span:{spanId:'week'}) atomically advances currentDate AND increments sessionNumber by spanToElapsedSessions(7)=1, returning both in ONE response", async () => {
  const { status, body } = await advanceWorldClockViaRoute(base, WORLD, { spanId: "week" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.currentDate, "Day 7");
  assert.equal(body.elapsedSessions, spanToElapsedSessions(SPAN_DAYS.week), "this call's own per-advance delta, not a cumulative total");
  assert.equal(body.sessionNumber, spanToElapsedSessions(SPAN_DAYS.week), "cumulative sessionNumber after exactly one advance equals that one advance's own delta");
});

test("a second advance (span:{spanId:'season'}) accumulates ON TOP of the first -- currentDate and sessionNumber both carry forward, never reset", async () => {
  const { status, body } = await advanceWorldClockViaRoute(base, WORLD, { spanId: "season" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  const expectedDays = SPAN_DAYS.week + SPAN_DAYS.season;
  const expectedSessions = spanToElapsedSessions(SPAN_DAYS.week) + spanToElapsedSessions(SPAN_DAYS.season);
  assert.equal(body.currentDate, `Day ${expectedDays}`);
  assert.equal(body.elapsedSessions, spanToElapsedSessions(SPAN_DAYS.season), "THIS call's own delta only");
  assert.equal(body.sessionNumber, expectedSessions, "cumulative total across both advances");
});

test("advanceWorldClock rejects a span with BOTH days and spanId, and a span with NEITHER -- fail loud, never silently guess", async () => {
  const both = await advanceWorldClockViaRoute(base, WORLD, { days: 10, spanId: "week" });
  assert.equal(both.status, 400, `both days+spanId must be rejected -- got ${both.status}: ${JSON.stringify(both.body)}`);
  const neither = await advanceWorldClockViaRoute(base, WORLD, {});
  assert.equal(neither.status, 400, `neither days nor spanId must be rejected -- got ${neither.status}: ${JSON.stringify(neither.body)}`);
});

test("advanceWorldClock also accepts an explicit {days:N} span (not just the named spanId shorthand)", async () => {
  const { status, body } = await advanceWorldClockViaRoute(base, "e2e-p37-explicit-days", { days: 14 });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.elapsedSessions, spanToElapsedSessions(14));
});

// ---------------------------------------------------------------------------
// §3 fortune
// ---------------------------------------------------------------------------

test("GET /api/chronicle/fortune defaults to 'middling'/bias 0", async () => {
  const { status, body } = await fetchFortuneViaRoute(base, WORLD);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.stopId, "middling");
  assert.equal(body.bias, 0);
});

test("POST /api/chronicle/fortune {stopId:'ruinous'} persists and reports the matching bias (-2), and a later GET reflects it", async () => {
  const posted = await setFortuneViaRoute(base, WORLD, "ruinous");
  assert.equal(posted.status, 200, `expected 200, got ${posted.status}: ${JSON.stringify(posted.body)}`);
  assert.equal(posted.body.stopId, "ruinous");
  assert.equal(posted.body.bias, -2);
  const refetched = await fetchFortuneViaRoute(base, WORLD);
  assert.equal(refetched.body.stopId, "ruinous");
});

test("POST /api/chronicle/fortune rejects an unknown stopId (400, not a silent fallback to middling)", async () => {
  const { status, body } = await setFortuneViaRoute(base, WORLD, "apocalyptic");
  assert.equal(status, 400, `expected 400 for an unknown stopId, got ${status}: ${JSON.stringify(body)}`);
});

test("FORTUNE_STOPS table has exactly the 5 prototype stops in prototype order with bounds -2..2", () => {
  assert.deepEqual(
    FORTUNE_STOPS.map((f) => f.stopId),
    ["bountiful", "fair", "middling", "lean", "ruinous"]
  );
  for (const f of FORTUNE_STOPS) assert.ok(f.bias >= -2 && f.bias <= 2, `bias out of bounds for ${f.stopId}: ${f.bias}`);
});

// ---------------------------------------------------------------------------
// §4 chronicle-log -- a READ layer over the EXISTING listBatches, no new
// event store. A batch created via the ordinary review-state.mjs path (no
// Chronicle sidecar) must still show up, with span/fortuneAtRun as a real,
// valid null -- "not a Chronicle-run batch" -- never a thrown error.
// ---------------------------------------------------------------------------

test("GET /api/chronicle/log composes listBatches -- a batch with NO chronicle-run sidecar renders span:null/fortuneAtRun:null, never throws", async () => {
  const batch = createBatch(
    WORLD,
    { mode: "ambient", elapsedSessions: 1 },
    "a plain non-Chronicle batch",
    attachDiffs(
      [{ op: "upsert_entity", id: "p37-gorrim", data: { description: "Has stopped asking about the fire." }, rationale: "test", batchId: "placeholder", sourceKind: "manual" }],
      [{ id: "p37-gorrim", name: "Gorrim the Smith", type: "person", description: "Wants to know who set the fire." }],
      []
    )
  );
  const { status, body } = await fetchChronicleLogViaRoute(base, WORLD);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  const entry = body.entries.find((e) => e.batchRef === batch.id);
  assert.ok(entry, `expected a chronicle-log entry for batch ${batch.id} -- entries: ${JSON.stringify(body.entries)}`);
  assert.equal(entry.span, null, "a batch created outside Chronicle's own composer must render span:null, not a guessed value");
  assert.equal(entry.fortuneAtRun, null);
  assert.deepEqual(entry.scope, batch.scope, "scope is sourced straight from the existing Batch.scope field, unmodified");
  assert.equal(entry.at, batch.createdAt);
  assert.ok(typeof entry.headline === "string" && entry.headline.length > 0, "headline must be rendered via grain.mjs's existing renderHeadline/summarizeBatch, not left blank");
});

// ---------------------------------------------------------------------------
// §5 pending-entities `type` decoration (reuse, not a new route)
// ---------------------------------------------------------------------------

test("GET /api/pending-entities gains a `type` field per entity (sourced from the live graph, additive to the EXISTING {entityId,name,entries} shape)", async () => {
  writePending(WORLD, "p37-gorrim", {
    causeTag: "Still doesn't know who set the fire. Suspicion should harden or break.",
    impactScore: 0.4,
    sourceBatchId: "manual",
    cycleDescriptor: "Wrap-up · session 11",
    status: "pending"
  });
  const { status, body } = await fetchPendingEntitiesViaRoute(base, WORLD);
  assert.equal(status, 200, `expected 200 (this route already exists), got ${status}: ${JSON.stringify(body)}`);
  const entry = body.entities.find((e) => e.entityId === "p37-gorrim");
  assert.ok(entry, `expected a pending-entities row for p37-gorrim -- got: ${JSON.stringify(body.entities)}`);
  assert.equal(entry.type, "person", "pendingEntitiesPayload must additively include the entity's real type from the live graph");
});

// ---------------------------------------------------------------------------
// §7 schema additions -- attachDiffs must stamp type/risk (both
// orchestrateBatch AND orchestrateCycle call this one function -- extending
// it here covers both for free, per the fixture's own reuse pin).
// ---------------------------------------------------------------------------

test("attachDiffs stamps `type` (from the live entity or the mutation's own proposed data) on every upsert_entity mutation", () => {
  const entities = [{ id: "p37-forge", name: "Gorrim's Forge", type: "place", description: "A stone-and-timber roadhouse." }];
  const mutations = [
    { op: "upsert_entity", id: "p37-forge", data: { description: "Dry for six weeks." }, rationale: "test", batchId: "b1", sourceKind: "ambient-decay" },
    { op: "upsert_entity", data: { name: "Quartermaster Ovid Rell", type: "person" }, rationale: "test", batchId: "b1", sourceKind: "seeded-propagation" }
  ];
  const [editMutation, createMutation] = attachDiffs(mutations, entities, []);
  assert.equal(editMutation.type, "place", "an EDIT's type must come from the live entity's own real type");
  assert.equal(createMutation.type, "person", "a CREATE's type must come from the mutation's own proposed data.type");
});

test("attachDiffs stamps `risk` per the pinned v1 heuristic: delete -> contradict, create -> look, plain low-impact edit -> safe", () => {
  const entities = [{ id: "p37-forge", name: "Gorrim's Forge", type: "place", description: "old text", importance: 0.3 }];
  const mutations = [
    { op: "delete_entity", id: "p37-forge", rationale: "gone", batchId: "b1", sourceKind: "manual" },
    { op: "upsert_entity", data: { name: "Quartermaster Ovid Rell", type: "person" }, rationale: "new", batchId: "b1", sourceKind: "seeded-propagation" },
    { op: "upsert_entity", id: "p37-forge", data: { description: "new text" }, rationale: "edit", batchId: "b1", sourceKind: "ambient-decay", impactScore: 0.1 }
  ];
  const [deleteMutation, createMutation, editMutation] = attachDiffs(mutations, entities, []);
  assert.equal(deleteMutation.risk, "contradict", "an outright delete must always be 'contradict', no exceptions");
  assert.equal(createMutation.risk, "look", "a brand-new node/edge must default to 'look'");
  assert.equal(editMutation.risk, "safe", "a plain, low-impact, non-flagged edit must be 'safe'");
});
