import assert from "node:assert/strict";
import {
  narrateBatch,
  assertBatchNarratable,
  NarrationGateError,
  NarrationError,
  DEFAULT_NARRATE_MODEL
} from "../mutation-engine/narrate.mjs";

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
        return { content: [{ type: "text", text: typeof resp === "function" ? resp(params) : resp }] };
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

test("DEFAULT_NARRATE_MODEL is claude-sonnet-5, matching this project's other LLM call sites", () => {
  assert.equal(DEFAULT_NARRATE_MODEL, "claude-sonnet-5");
});

await Promise.all(pending);
console.log(`\n${passed} passed`);
