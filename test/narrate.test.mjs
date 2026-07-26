import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Phase 10: narrateEntity persists via entity-narration.mjs on success --
// isolate both review-state.mjs (entity-narration.mjs reuses its withLock)
// and entity-narration.mjs's own root before importing narrate.mjs (which
// imports entity-narration.mjs), same isolation pattern as
// test/entity-narration.test.mjs.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-narrate-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");

const {
  narrateBatch,
  narrateEntity,
  assertBatchNarratable,
  assertMutationNarratable,
  buildAdjacencyContext,
  DEFAULT_ENTITY_NARRATE_DEPTH,
  NarrationGateError,
  NarrationError,
  DEFAULT_NARRATE_MODEL
} = await import("../mutation-engine/narrate.mjs");
const { getCurrentEntityNarration, getEntityNarrationHistory } = await import("../mutation-engine/entity-narration.mjs");

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push(
    (async () => {
      try {
        await fn();
        passed++;
        console.log(`  ok  ${name}`);
      } catch (err) {
        console.error(`FAIL  ${name}`);
        console.error(err.stack || err.message);
        process.exitCode = 1;
      }
    })()
  );
}

// A response entry is normally a plain string (or a function of params -> string).
// It can also be `{ text, stopReason }` to simulate a real Anthropic stop_reason
// other than a normal finish -- used to test the truncation-handling path
// (see callModelDetailed in mutation-engine/llm-call.mjs), matching the
// convention test/writeup-import.test.mjs's own mockClient established.
function mockClient(responses) {
  let call = 0;
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        const resp = responses[Math.min(call, responses.length - 1)];
        call++;
        if (resp && typeof resp === "object" && !Array.isArray(resp) && "text" in resp) {
          const text = typeof resp.text === "function" ? resp.text(params) : resp.text;
          return { content: [{ type: "text", text }], stop_reason: resp.stopReason ?? "end_turn" };
        }
        return {
          content: [{ type: "text", text: typeof resp === "function" ? resp(params) : resp }],
          stop_reason: "end_turn"
        };
      }
    }
  };
}

function acceptedBatch(overrides = {}) {
  return {
    id: "batch1",
    world: "wf-test",
    createdAt: new Date().toISOString(),
    scope: { mode: "seed", anchorId: "alvor" },
    elapsedTimeDescriptor: "right now",
    status: "open",
    mutations: [
      {
        op: "upsert_entity",
        id: "alvor",
        data: { description: "Shaken by the news." },
        rationale: "The siege reached his forge.",
        batchId: "batch1",
        sourceKind: "seeded-propagation",
        impactScore: 0.7,
        mutationId: "m0",
        status: "accepted",
        regionId: "region-0",
        entityContext: { name: "Alvor", importance: 0.5, tags: [] },
        diff: [{ field: "description", from: "A smith.", to: "Shaken by the news." }]
      }
    ],
    ...overrides
  };
}

// --------------------------------------------------- assertBatchNarratable (the hard gate)

test("assertBatchNarratable: passes silently when every mutation is accepted", () => {
  assert.doesNotThrow(() => assertBatchNarratable(acceptedBatch()));
});

test("assertBatchNarratable: throws NarrationGateError when a mutation is still pending", () => {
  const batch = acceptedBatch();
  batch.mutations.push({ ...batch.mutations[0], mutationId: "m1", id: "gerdur", status: "pending" });
  assert.throws(
    () => assertBatchNarratable(batch),
    (err) => {
      assert.ok(err instanceof NarrationGateError);
      assert.equal(err.batchId, "batch1");
      assert.equal(err.notAccepted.length, 1);
      assert.equal(err.notAccepted[0].mutationId, "m1");
      assert.equal(err.notAccepted[0].status, "pending");
      assert.match(err.message, /m1 \(pending\)/);
      return true;
    }
  );
});

test("assertBatchNarratable: throws NarrationGateError listing ALL non-accepted mutations, not just the first", () => {
  const batch = acceptedBatch();
  batch.mutations.push({ ...batch.mutations[0], mutationId: "m1", id: "gerdur", status: "pending" });
  batch.mutations.push({ ...batch.mutations[0], mutationId: "m2", id: "sven", status: "rejected" });
  try {
    assertBatchNarratable(batch);
    assert.fail("should have thrown");
  } catch (err) {
    assert.equal(err.notAccepted.length, 2);
    assert.deepEqual(
      err.notAccepted.map((n) => n.mutationId).sort(),
      ["m1", "m2"]
    );
  }
});

test("assertBatchNarratable: throws NarrationGateError for an empty batch (nothing to narrate)", () => {
  const batch = acceptedBatch({ mutations: [] });
  assert.throws(() => assertBatchNarratable(batch), NarrationGateError);
});

// --------------------------------------------------- narrateBatch: the rejection path (not just happy path)

test("narrateBatch: refuses to call the model at all if any mutation is pending (rejection path, not silent no-op)", async () => {
  const batch = acceptedBatch();
  batch.mutations.push({ ...batch.mutations[0], mutationId: "m1", id: "gerdur", status: "pending" });
  const client = mockClient(["should never be reached"]);
  await assert.rejects(() => narrateBatch(batch, {}, { client }), NarrationGateError);
  assert.equal(client.calls.length, 0, "the model must never be called when the batch isn't fully accepted");
});

test("narrateBatch: refuses to call the model if any mutation was rejected", async () => {
  const batch = acceptedBatch();
  batch.mutations[0].status = "rejected";
  const client = mockClient(["should never be reached"]);
  await assert.rejects(() => narrateBatch(batch, {}, { client }), NarrationGateError);
  assert.equal(client.calls.length, 0);
});

// --------------------------------------------------- narrateBatch: happy path

test("narrateBatch: returns trimmed prose for a fully-accepted batch", async () => {
  const client = mockClient(["  The forge falls silent as word spreads through Riverwood.  "]);
  const result = await narrateBatch(acceptedBatch(), {}, { client });
  assert.equal(result.batchId, "batch1");
  assert.equal(result.prose, "The forge falls silent as word spreads through Riverwood.");
});

test("narrateBatch: builds the prompt from the batch's post-mutation diffs, not the raw delta objects", async () => {
  let capturedPrompt = "";
  const client = mockClient([
    (params) => {
      capturedPrompt = params.messages[0].content;
      return "Some prose.";
    }
  ]);
  await narrateBatch(acceptedBatch(), {}, { client });
  assert.ok(capturedPrompt.includes("Alvor"), "should reference the entity's name");
  assert.ok(capturedPrompt.includes("description is now"), "should describe the post-mutation diff field");
  assert.ok(capturedPrompt.includes("Shaken by the news."), "should include the post-mutation (to) value, not the pre-mutation value");
  assert.ok(!capturedPrompt.includes("A smith."), "should not surface the pre-mutation (from) value as if it were current");
});

test("narrateBatch: describes a delete_entity/delete_edge mutation as removed/destroyed, not as missing detail (found in self-review: attachDiffs never computes a diff for delete ops)", async () => {
  let capturedPrompt = "";
  const client = mockClient([
    (params) => {
      capturedPrompt = params.messages[0].content;
      return "Some prose.";
    }
  ]);
  const batch = acceptedBatch();
  batch.mutations[0].op = "delete_entity";
  delete batch.mutations[0].data;
  delete batch.mutations[0].diff;
  await narrateBatch(batch, {}, { client });
  assert.ok(capturedPrompt.includes("removed/destroyed"));
  assert.ok(!capturedPrompt.includes("no field-level detail recorded"));
});

test("narrateBatch: includes currentLocation/reachableAreas grounding context when provided", async () => {
  let capturedPrompt = "";
  const client = mockClient([
    (params) => {
      capturedPrompt = params.messages[0].content;
      return "Some prose.";
    }
  ]);
  await narrateBatch(acceptedBatch(), { currentLocation: "Riverwood's forge", reachableAreas: ["the mill", "the inn"] }, { client });
  assert.ok(capturedPrompt.includes("Riverwood's forge"));
  assert.ok(capturedPrompt.includes("the mill, the inn"));
});

test("narrateBatch: regenerate-with-note passes the note through to the prompt", async () => {
  let capturedPrompt = "";
  const client = mockClient([
    (params) => {
      capturedPrompt = params.messages[0].content;
      return "Some prose.";
    }
  ]);
  await narrateBatch(acceptedBatch(), { note: "make it more ominous" }, { client });
  assert.ok(capturedPrompt.includes("make it more ominous"));
});

test("narrateBatch: throws NarrationError on an empty model response rather than returning blank prose", async () => {
  const client = mockClient(["   "]);
  await assert.rejects(() => narrateBatch(acceptedBatch(), {}, { client }), NarrationError);
});

// --------------------------------------------------- narrateBatch: truncation (found in QA pass alongside
// texture.mjs/resolve-seed.mjs's version of the same bug class -- narrateBatch is uniquely dangerous here
// since raw.trim() is non-empty for prose cut off mid-sentence, so without this check a truncated narration
// would silently reach a player at the table looking complete, with no error at all)

test("narrateBatch: a truncated first attempt (stop_reason max_tokens) doubles the token budget and retries, rather than silently returning cut-off prose", async () => {
  const client = mockClient([
    { text: "The forge falls silent as word spreads", stopReason: "max_tokens" },
    "The forge falls silent as word spreads through Riverwood, complete this time."
  ]);
  const result = await narrateBatch(acceptedBatch(), {}, { client, maxTokens: 50 });
  assert.equal(result.prose, "The forge falls silent as word spreads through Riverwood, complete this time.");
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].max_tokens, 50, "first attempt uses the requested budget");
  assert.equal(client.calls[1].max_tokens, 100, "second attempt doubles the budget after truncation, not a blind retry");
});

test("narrateBatch: truncated on both attempts throws a NarrationError that says so, not a silently-truncated result", async () => {
  const client = mockClient([
    { text: "The forge falls silent", stopReason: "max_tokens" },
    { text: "The forge falls silent as word spreads", stopReason: "max_tokens" }
  ]);
  await assert.rejects(
    narrateBatch(acceptedBatch(), {}, { client, maxTokens: 50 }),
    (err) => {
      assert.ok(err instanceof NarrationError);
      assert.match(err.message, /truncated/i);
      assert.equal(client.calls.length, 2);
      assert.equal(client.calls[1].max_tokens, 100);
      return true;
    }
  );
});

test("DEFAULT_NARRATE_MODEL is claude-sonnet-5, matching this project's other LLM call sites", () => {
  assert.equal(DEFAULT_NARRATE_MODEL, "claude-sonnet-5");
});

// =================================================================================
// Phase 10 task 10.2: narrateEntity -- the per-entity replacement for narrateBatch
// =================================================================================

// This file's own test() harness fires every test body concurrently
// (pushed into `pending`, awaited together at the bottom) -- fine when
// nothing touches shared state, but narrateEntity now does a REAL file
// write via entity-narration.mjs. Every test below that exercises
// narrateEntity's persistence therefore uses its own unique entity-id
// suffix (`fx(suffix)`) so concurrent tests never race on the same
// on-disk (world, entityId) file.
function fx(suffix) {
  const entities = [
    { id: `alvor-${suffix}`, name: "Alvor", type: "person", description: "The village smith." },
    { id: `gerdur-${suffix}`, name: "Gerdur", type: "person", description: "Alvor's sister, runs the mill." },
    { id: `riverwood-${suffix}`, name: "Riverwood", type: "place", description: "A small logging village." },
    { id: `sven-${suffix}`, name: "Sven", type: "person", description: "A hunter, unrelated to this narration." }
  ];
  const edges = [
    { id: `e1-${suffix}`, sourceId: `alvor-${suffix}`, targetId: `gerdur-${suffix}`, relationshipType: "kinship", strength: 0.9 },
    { id: `e2-${suffix}`, sourceId: `alvor-${suffix}`, targetId: `riverwood-${suffix}`, relationshipType: "containment", strength: 0.6 },
    // Two hops from alvor via riverwood/sven -- must NOT show up as an "immediate" neighbor of alvor.
    { id: `e3-${suffix}`, sourceId: `riverwood-${suffix}`, targetId: `sven-${suffix}`, relationshipType: "containment", strength: 0.5 }
  ];
  return { entities, edges };
}

const FIXTURE_ENTITIES = fx("shared").entities;
const FIXTURE_EDGES = fx("shared").edges;

function twoEntityAcceptedBatch(suffix, overrides = {}) {
  const batchId = `batch-entity-${suffix}`;
  return {
    id: batchId,
    world: "wf-test",
    createdAt: new Date().toISOString(),
    scope: { mode: "seed", anchorId: `alvor-${suffix}` },
    elapsedTimeDescriptor: "right now",
    status: "open",
    mutations: [
      {
        op: "upsert_entity",
        id: `alvor-${suffix}`,
        data: { description: "Shaken by the news." },
        rationale: "The siege reached his forge.",
        batchId,
        sourceKind: "seeded-propagation",
        impactScore: 0.7,
        mutationId: "m0",
        status: "accepted",
        regionId: "region-0",
        entityContext: { name: "Alvor", importance: 0.5, tags: [] },
        diff: [{ field: "description", from: "A smith.", to: "Shaken by the news." }]
      },
      {
        op: "upsert_entity",
        id: `gerdur-${suffix}`,
        data: { description: "Worried, watching the road." },
        rationale: "News of the siege reached the mill too.",
        batchId,
        sourceKind: "seeded-propagation",
        impactScore: 0.6,
        mutationId: "m1",
        status: "accepted",
        regionId: "region-0",
        entityContext: { name: "Gerdur", importance: 0.5, tags: [] },
        diff: [{ field: "description", from: "Runs the mill.", to: "Worried, watching the road." }]
      }
    ],
    ...overrides
  };
}

// --------------------------------------------------- the entity-grain gate

test("assertMutationNarratable: passes and returns the mutation when it's accepted", () => {
  const batch = twoEntityAcceptedBatch("gate1");
  const mutation = assertMutationNarratable(batch, "m0");
  assert.equal(mutation.id, "alvor-gate1");
});

test("assertMutationNarratable: throws NarrationGateError for a non-accepted mutation, WITHOUT requiring the rest of the batch to be accepted (the actual grain fix)", () => {
  const batch = twoEntityAcceptedBatch("gate2");
  batch.mutations[1].status = "pending"; // the OTHER mutation, not m0
  assert.doesNotThrow(() => assertMutationNarratable(batch, "m0"), "m0 is still accepted -- must not be blocked by m1's status");
  assert.throws(
    () => assertMutationNarratable(batch, "m1"),
    (err) => {
      assert.ok(err instanceof NarrationGateError);
      assert.equal(err.notAccepted.length, 1);
      assert.equal(err.notAccepted[0].mutationId, "m1");
      return true;
    }
  );
});

test("assertMutationNarratable: throws a plain Error for an unknown mutationId", () => {
  const batch = twoEntityAcceptedBatch("gate3");
  assert.throws(() => assertMutationNarratable(batch, "does-not-exist"), /No mutation with mutationId/);
});

test("narrateEntity: refuses to call the model at all if the targeted mutation isn't accepted, even though the batch has other accepted mutations", async () => {
  const { entities, edges } = fx("gate4");
  const batch = twoEntityAcceptedBatch("gate4");
  batch.mutations[0].status = "pending";
  const client = mockClient(["should never be reached"]);
  await assert.rejects(() => narrateEntity(batch, "m0", { entities, edges }, { client }), NarrationGateError);
  assert.equal(client.calls.length, 0, "the model must never be called for a non-accepted mutation");
});

// --------------------------------------------------- targeting via real adjacency

test("buildAdjacencyContext: labels the entity and lists its immediate neighbors with relationship types, excludes two-hop entities", () => {
  const { entityLabel, neighborDescriptions } = buildAdjacencyContext(FIXTURE_ENTITIES, FIXTURE_EDGES, "alvor-shared");
  assert.equal(entityLabel, "Alvor (person)");
  assert.ok(neighborDescriptions.includes("Gerdur (kinship)"));
  assert.ok(neighborDescriptions.includes("Riverwood (containment)"));
  assert.ok(!neighborDescriptions.some((d) => d.startsWith("Sven")), "Sven is two hops away via Riverwood, not an immediate neighbor of Alvor");
});

test("DEFAULT_ENTITY_NARRATE_DEPTH is 1 -- immediate neighbors only, not a wider blast-radius walk", () => {
  assert.equal(DEFAULT_ENTITY_NARRATE_DEPTH, 1);
});

test("SELF-REVIEW REMEDIATION: buildAdjacencyContext grounds an EDGE mutation in its own two endpoints, not a hollow raw-id-with-no-neighbors result", () => {
  // e1-shared connects alvor-shared <-kinship-> gerdur-shared; gerdur-shared
  // also connects onward to riverwood-shared via e2-shared.
  const { entityLabel, neighborDescriptions } = buildAdjacencyContext(FIXTURE_ENTITIES, FIXTURE_EDGES, "e1-shared");
  assert.equal(entityLabel, "Alvor ↔ Gerdur (kinship)", "the relationship's own two endpoints, not the raw edge id");
  assert.ok(neighborDescriptions.some((d) => d.includes("Riverwood") && d.includes("containment")), "should surface Gerdur's OTHER real connection (to Riverwood) as further grounding");
  assert.ok(!neighborDescriptions.some((d) => d.includes("e1-shared")), "must not describe the edge as its own neighbor");
});

test("buildAdjacencyContext: an unknown id (neither entity nor edge) degrades to the raw id with no neighbors, rather than throwing", () => {
  const { entityLabel, neighborDescriptions } = buildAdjacencyContext(FIXTURE_ENTITIES, FIXTURE_EDGES, "does-not-exist");
  assert.equal(entityLabel, "does-not-exist");
  assert.deepEqual(neighborDescriptions, []);
});

test("narrateEntity: an upsert_edge mutation is grounded in its real endpoints, not the raw edge id (real-shaped prompt check)", async () => {
  let capturedPrompt = "";
  const client = mockClient([
    (params) => {
      capturedPrompt = params.messages[0].content;
      return "Some prose.";
    }
  ]);
  const { entities, edges } = fx("edgecase");
  const batch = {
    id: "batch-edge-1",
    world: "wf-test",
    createdAt: new Date().toISOString(),
    scope: { mode: "manual" },
    elapsedTimeDescriptor: "right now",
    status: "open",
    mutations: [
      {
        op: "upsert_edge",
        id: `e1-edgecase`,
        data: { strength: 0.95 },
        rationale: "Their bond strengthens under threat.",
        batchId: "batch-edge-1",
        sourceKind: "manual",
        mutationId: "m0",
        status: "accepted",
        regionId: "region-0",
        entityContext: { name: "Alvor -> Gerdur (kinship)", importance: 0.5, tags: [] },
        diff: [{ field: "strength", from: 0.8, to: 0.95 }]
      }
    ]
  };
  await narrateEntity(batch, "m0", { entities, edges }, { client });
  assert.ok(capturedPrompt.includes("Alvor ↔ Gerdur (kinship)"), "should ground on the edge's real endpoints");
  assert.ok(!capturedPrompt.includes("e1-edgecase"), "must not surface the raw internal edge id as if it were a place/entity name");
});

test("narrateEntity: THE ACTUAL REGRESSION FIX -- targeting context is built from this entity's real adjacent-entity data, not left empty, and different entities in the same batch get different grounding", async () => {
  let capturedPrompts = [];
  const client = mockClient([
    (params) => {
      capturedPrompts.push(params.messages[0].content);
      return "Some prose.";
    }
  ]);
  const { entities, edges } = fx("regression");
  const batch = twoEntityAcceptedBatch("regression");

  await narrateEntity(batch, "m0", { entities, edges }, { client });
  await narrateEntity(batch, "m1", { entities, edges }, { client });

  const [alvorPrompt, gerdurPrompt] = capturedPrompts;
  assert.ok(alvorPrompt.includes("Alvor (person)"), "alvor's own narration should be grounded in Alvor as the current entity");
  assert.ok(alvorPrompt.includes("Gerdur (kinship)"), "alvor's grounding should list his real neighbor Gerdur");
  assert.ok(gerdurPrompt.includes("Gerdur (person)"), "gerdur's own narration should be grounded in Gerdur, not Alvor");
  assert.ok(gerdurPrompt.includes("Alvor (kinship)"), "gerdur's grounding should list her real neighbor Alvor");
  assert.notEqual(alvorPrompt, gerdurPrompt, "two different entities in the same batch must NOT receive the same prompt/context");
});

test("narrateEntity: falls back to '(not specified)' grounding when no entities/edges are supplied, rather than crashing", async () => {
  let capturedPrompt = "";
  const client = mockClient([
    (params) => {
      capturedPrompt = params.messages[0].content;
      return "Some prose.";
    }
  ]);
  const batch = twoEntityAcceptedBatch("fallback");
  await narrateEntity(batch, "m0", {}, { client });
  assert.ok(capturedPrompt.includes("(not specified)"));
});

test("narrateEntity: builds the prompt from only the ONE targeted mutation, not every mutation in the batch (the identical-text-across-every-row regression)", async () => {
  let capturedPrompt = "";
  const client = mockClient([
    (params) => {
      capturedPrompt = params.messages[0].content;
      return "Some prose.";
    }
  ]);
  const { entities, edges } = fx("onlyone");
  const batch = twoEntityAcceptedBatch("onlyone");
  await narrateEntity(batch, "m0", { entities, edges }, { client });
  assert.ok(capturedPrompt.includes("Shaken by the news."), "should include m0's own change");
  assert.ok(!capturedPrompt.includes("Worried, watching the road."), "must NOT include m1's change -- entity grain, not batch grain");
});

// --------------------------------------------------- persistence (the reload-survival fix)

test("narrateEntity: on success, persists via entity-narration.mjs's saveEntityNarration -- durable across a reload, not just returned", async () => {
  const client = mockClient(["The forge falls silent, and Gerdur watches the smoke rise."]);
  const { entities, edges } = fx("persist1");
  const batch = twoEntityAcceptedBatch("persist1");

  assert.equal(getCurrentEntityNarration("wf-test", "alvor-persist1"), null, "sanity: nothing persisted yet");

  const result = await narrateEntity(batch, "m0", { entities, edges }, { client });
  assert.equal(result.entityId, "alvor-persist1");
  assert.equal(result.mutationId, "m0");
  assert.equal(result.prose, "The forge falls silent, and Gerdur watches the smoke rise.");

  const current = getCurrentEntityNarration("wf-test", "alvor-persist1");
  assert.ok(current, "must be durably persisted, not just returned to the caller");
  assert.equal(current.prose, result.prose);
  assert.equal(current.sourceMutationId, "m0");
  assert.equal(current.sourceBatchId, "batch-entity-persist1");
});

test("narrateEntity: regenerating (a second call for the same entity) creates a NEW history entry, superseding the first -- not overwritten in place", async () => {
  const { entities, edges } = fx("regen1");
  const batch = twoEntityAcceptedBatch("regen1");
  const client1 = mockClient(["First narration for Alvor."]);
  await narrateEntity(batch, "m0", { entities, edges }, { client: client1 });

  const client2 = mockClient(["Second, regenerated narration for Alvor."]);
  await narrateEntity(batch, "m0", { entities, edges, note: "make it darker" }, { client: client2 });

  const history = getEntityNarrationHistory("wf-test", "alvor-regen1");
  assert.equal(history.length, 2, "both entries remain in history");
  assert.ok(history.some((e) => e.prose === "First narration for Alvor." && e.status === "superseded"));
  assert.ok(history.some((e) => e.prose === "Second, regenerated narration for Alvor." && e.status === "current"));
});

test("narrateEntity: throws NarrationError (never silently no-ops) for a mutation with no resolved entity id yet, and never persists garbage", async () => {
  const { entities, edges } = fx("noid");
  const batch = twoEntityAcceptedBatch("noid");
  batch.mutations[0].id = undefined; // simulate an accepted-but-not-yet-synced create
  const client = mockClient(["should never be reached, id check happens before the API call"]);
  await assert.rejects(() => narrateEntity(batch, "m0", { entities, edges }, { client }), NarrationError);
  assert.equal(client.calls.length, 0, "should fail fast before spending an API call on an unpersistable result");
});

test("narrateEntity: truncated on both attempts throws a NarrationError with the mutationId attached", async () => {
  const client = mockClient([
    { text: "The forge falls silent", stopReason: "max_tokens" },
    { text: "The forge falls silent as word", stopReason: "max_tokens" }
  ]);
  const { entities, edges } = fx("trunc1");
  const batch = twoEntityAcceptedBatch("trunc1");
  await assert.rejects(
    narrateEntity(batch, "m0", { entities, edges }, { client, maxTokens: 50 }),
    (err) => {
      assert.ok(err instanceof NarrationError);
      assert.equal(err.mutationId, "m0");
      assert.match(err.message, /truncated/i);
      return true;
    }
  );
});

await Promise.all(pending);
console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
