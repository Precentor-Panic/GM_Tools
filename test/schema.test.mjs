import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  Mutation,
  Batch,
  ReviewState,
  MutationOp,
  SourceKind,
  BatchStatus
} from "../mutation-engine/schema.mjs";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.message);
    process.exitCode = 1;
  }
}

test("SCHEMA_VERSION is exported and is 1", () => {
  assert.equal(SCHEMA_VERSION, 1);
});

// --------------------------------------------------------------- Mutation

test("Mutation: valid upsert_entity mutation parses", () => {
  const good = {
    op: "upsert_entity",
    id: "ent1",
    data: { importance: 0.6 },
    rationale: "The party's raid weakened the guild's grip on the docks.",
    batchId: "batch1",
    sourceKind: "seeded-propagation",
    impactScore: 0.42
  };
  const parsed = Mutation.parse(good);
  assert.equal(parsed.op, "upsert_entity");
  assert.equal(parsed.rationale, good.rationale);
});

test("Mutation: id and impactScore are optional (new-entity create case)", () => {
  const good = {
    op: "upsert_entity",
    data: { name: "New Rumor" },
    rationale: "A new rumor spreads.",
    batchId: "batch1",
    sourceKind: "manual"
  };
  assert.doesNotThrow(() => Mutation.parse(good));
});

test("Mutation: missing rationale is rejected", () => {
  const bad = {
    op: "upsert_entity",
    id: "ent1",
    data: {},
    batchId: "batch1",
    sourceKind: "manual"
  };
  const result = Mutation.safeParse(bad);
  assert.equal(result.success, false);
});

test("Mutation: invalid op is rejected", () => {
  const bad = {
    op: "explode_entity",
    rationale: "boom",
    batchId: "batch1",
    sourceKind: "manual"
  };
  const result = Mutation.safeParse(bad);
  assert.equal(result.success, false);
});

test("Mutation: invalid sourceKind is rejected", () => {
  const bad = {
    op: "upsert_entity",
    rationale: "boom",
    batchId: "batch1",
    sourceKind: "made-up-kind"
  };
  const result = Mutation.safeParse(bad);
  assert.equal(result.success, false);
});

test("Mutation: passthrough preserves extra bookkeeping fields review-state attaches", () => {
  const withEnvelope = {
    op: "upsert_entity",
    id: "ent1",
    data: {},
    rationale: "x",
    batchId: "batch1",
    sourceKind: "manual",
    mutationId: "m0",
    status: "pending",
    regionId: "region-0"
  };
  const parsed = Mutation.parse(withEnvelope);
  assert.equal(parsed.mutationId, "m0");
  assert.equal(parsed.status, "pending");
  assert.equal(parsed.regionId, "region-0");
});

// ----------------------------------------------------------------- Batch

test("Batch: valid batch parses", () => {
  const good = {
    id: "batch1",
    world: "wf-test",
    createdAt: new Date().toISOString(),
    scope: { mode: "seed", anchorId: "ent1", depth: 2 },
    elapsedTimeDescriptor: "2 sessions",
    mutations: [
      {
        op: "upsert_entity",
        id: "ent1",
        data: { importance: 0.6 },
        rationale: "x",
        batchId: "batch1",
        sourceKind: "manual"
      }
    ],
    status: "open"
  };
  assert.doesNotThrow(() => Batch.parse(good));
});

test("Batch: invalid status is rejected", () => {
  const bad = {
    id: "batch1",
    world: "wf-test",
    createdAt: new Date().toISOString(),
    scope: {},
    mutations: [],
    status: "not-a-real-status"
  };
  const result = Batch.safeParse(bad);
  assert.equal(result.success, false);
});

test("Batch: missing required id is rejected", () => {
  const bad = {
    world: "wf-test",
    createdAt: new Date().toISOString(),
    scope: {},
    mutations: [],
    status: "open"
  };
  const result = Batch.safeParse(bad);
  assert.equal(result.success, false);
});

// ------------------------------------------------------------ ReviewState

test("ReviewState: all five documented statuses are valid", () => {
  for (const s of ["pending", "accepted", "rejected", "regenerate-requested", "rolled-back"]) {
    assert.doesNotThrow(() => ReviewState.parse(s));
  }
});

test("ReviewState: unknown status rejected", () => {
  const result = ReviewState.safeParse("unknown");
  assert.equal(result.success, false);
});

test("MutationOp / SourceKind / BatchStatus enums cover the documented values", () => {
  for (const op of ["upsert_entity", "upsert_edge", "delete_entity", "delete_edge", "upsert_type", "upsert_relationship_type"]) {
    assert.doesNotThrow(() => MutationOp.parse(op));
  }
  for (const k of ["ambient-decay", "seeded-propagation", "manual"]) {
    assert.doesNotThrow(() => SourceKind.parse(k));
  }
  for (const s of ["open", "synced", "rolled-back"]) {
    assert.doesNotThrow(() => BatchStatus.parse(s));
  }
});

console.log(`\n${passed} passed`);
