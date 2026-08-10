import assert from "node:assert/strict";
import {
  groupByRegion,
  textureRegion,
  textureBatch,
  TextureValidationError,
  DEFAULT_TEXTURE_MODEL
} from "../mutation-engine/texture.mjs";

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

const entities = [
  { id: "alvor", name: "Alvor", type: "person", importance: 0.5, summary: "A smith." },
  { id: "gerdur", name: "Gerdur", type: "person", importance: 0.5, summary: "A miller." },
  { id: "distant", name: "Whiterun", type: "place", importance: 0.8, summary: "A city." }
];
const edges = [
  { id: "e4", sourceId: "alvor", targetId: "gerdur", relationshipType: "kinship", strength: 0.8 }
];

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

// --------------------------------------------------------------- groupByRegion

test("groupByRegion: only needsLLM:true deltas are grouped", () => {
  const deltas = [
    { kind: "seed-propagated", entityId: "alvor", impactScore: 0.6, needsLLM: true },
    { kind: "seed-propagated", entityId: "distant", impactScore: 0.05, needsLLM: false }
  ];
  const regions = groupByRegion(deltas, edges);
  const allDeltas = regions.flatMap((r) => r.deltas);
  assert.equal(allDeltas.length, 1);
  assert.equal(allDeltas[0].entityId, "alvor");
});

test("groupByRegion: connected affected entities land in the same region (cost-control behavior)", () => {
  const deltas = [
    { kind: "seed-propagated", entityId: "alvor", impactScore: 0.6, needsLLM: true },
    { kind: "seed-propagated", entityId: "gerdur", impactScore: 0.4, needsLLM: true }
  ];
  const regions = groupByRegion(deltas, edges);
  assert.equal(regions.length, 1, "alvor and gerdur are edge-connected -> one region, one API call");
  assert.equal(regions[0].deltas.length, 2);
});

test("groupByRegion: disconnected affected entities land in separate regions", () => {
  const deltas = [
    { kind: "seed-propagated", entityId: "alvor", impactScore: 0.6, needsLLM: true },
    { kind: "seed-propagated", entityId: "distant", impactScore: 0.6, needsLLM: true }
  ];
  const regions = groupByRegion(deltas, edges); // alvor--gerdur edge only; distant is isolated here
  assert.equal(regions.length, 2);
});

// -------------------------------------------------------- textureRegion (mocked)

test("textureRegion: validates a well-formed model response on the first attempt", async () => {
  const goodResponse = JSON.stringify([
    { op: "upsert_entity", id: "alvor", data: { description: "Shaken by the news." }, rationale: "The siege reached his forge." }
  ]);
  const client = mockClient([goodResponse]);
  const region = { regionId: "region-0", entityIds: ["alvor"], deltas: [{ kind: "seed-propagated", entityId: "alvor", impactScore: 0.6, needsLLM: true }] };
  const mutations = await textureRegion(
    region,
    { entities, edges, world: "wf-test", batchId: "batch1", sourceKind: "seeded-propagation" },
    { client }
  );
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].op, "upsert_entity");
  assert.equal(mutations[0].batchId, "batch1");
  assert.equal(mutations[0].sourceKind, "seeded-propagation");
  assert.equal(mutations[0].regionId, "region-0");
  assert.ok(mutations[0].impactScore > 0);
  assert.equal(mutations[0].entityContext.name, "Alvor");
});

test("textureRegion: strips markdown code fences before parsing", async () => {
  const fenced = "```json\n" + JSON.stringify([
    { op: "upsert_entity", id: "alvor", data: {}, rationale: "x" }
  ]) + "\n```";
  const client = mockClient([fenced]);
  const region = { regionId: "region-0", entityIds: ["alvor"], deltas: [] };
  const mutations = await textureRegion(
    region,
    { entities, edges, world: "wf-test", batchId: "batch1", sourceKind: "manual" },
    { client }
  );
  assert.equal(mutations.length, 1);
});

test("textureRegion: retries once on invalid JSON, succeeds on second attempt", async () => {
  const badResponse = "not valid json at all";
  const goodResponse = JSON.stringify([
    { op: "upsert_entity", id: "alvor", data: {}, rationale: "Recovered on retry." }
  ]);
  const client = mockClient([badResponse, goodResponse]);
  const region = { regionId: "region-0", entityIds: ["alvor"], deltas: [] };
  const mutations = await textureRegion(
    region,
    { entities, edges, world: "wf-test", batchId: "batch1", sourceKind: "manual" },
    { client }
  );
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].rationale, "Recovered on retry.");
});

test("textureRegion: retries once on schema-invalid JSON (missing rationale), succeeds on second attempt", async () => {
  const invalidShape = JSON.stringify([{ op: "upsert_entity", id: "alvor", data: {} }]); // missing rationale
  const validShape = JSON.stringify([{ op: "upsert_entity", id: "alvor", data: {}, rationale: "Fixed." }]);
  const client = mockClient([invalidShape, validShape]);
  const region = { regionId: "region-0", entityIds: ["alvor"], deltas: [] };
  const mutations = await textureRegion(
    region,
    { entities, edges, world: "wf-test", batchId: "batch1", sourceKind: "manual" },
    { client }
  );
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].rationale, "Fixed.");
});

test("textureRegion: a truncated first attempt (stop_reason max_tokens) doubles the token budget and retries, rather than resending the same budget (matches graph-import/writeup-import.mjs's fix for the same bug class)", async () => {
  const goodResponse = JSON.stringify([
    { op: "upsert_entity", id: "alvor", data: {}, rationale: "Recovered after truncation." }
  ]);
  const client = mockClient([
    { text: "[{\"op\": \"upsert_entity\", \"id\": \"alvor", stopReason: "max_tokens" },
    goodResponse
  ]);
  const region = { regionId: "region-0", entityIds: ["alvor"], deltas: [] };
  const mutations = await textureRegion(
    region,
    { entities, edges, world: "wf-test", batchId: "batch1", sourceKind: "manual" },
    { client, maxTokens: 100 }
  );
  assert.equal(mutations[0].rationale, "Recovered after truncation.");
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].max_tokens, 100, "first attempt uses the requested budget");
  assert.equal(client.calls[1].max_tokens, 200, "second attempt doubles the budget after truncation, not a blind retry");
});

test("textureRegion: truncated on both attempts throws a TextureValidationError that says so, not a generic JSON parse error", async () => {
  const client = mockClient([
    { text: "[{\"op\": \"upsert_entity\"", stopReason: "max_tokens" },
    { text: "[{\"op\": \"upsert_entity\"", stopReason: "max_tokens" }
  ]);
  const region = { regionId: "region-0", entityIds: ["alvor"], deltas: [] };
  await assert.rejects(
    textureRegion(
      region,
      { entities, edges, world: "wf-test", batchId: "batch1", sourceKind: "manual" },
      { client, maxTokens: 100 }
    ),
    (err) => {
      assert.ok(err instanceof TextureValidationError);
      assert.match(err.message, /truncated/i);
      assert.equal(client.calls.length, 2);
      assert.equal(client.calls[1].max_tokens, 200);
      return true;
    }
  );
});

test("textureRegion: throws a typed TextureValidationError after a second failure, does not silently drop the batch", async () => {
  const client = mockClient(["still not json", "still not json either"]);
  const region = { regionId: "region-0", entityIds: ["alvor"], deltas: [] };
  await assert.rejects(
    () =>
      textureRegion(
        region,
        { entities, edges, world: "wf-test", batchId: "batch1", sourceKind: "manual" },
        { client }
      ),
    TextureValidationError
  );
});

test("textureRegion: passes the reviewer note through to the prompt on regenerate", async () => {
  let capturedPrompt = "";
  const client = mockClient([
    (params) => {
      capturedPrompt = params.messages[0].content;
      return JSON.stringify([{ op: "upsert_entity", id: "alvor", data: {}, rationale: "x" }]);
    }
  ]);
  const region = { regionId: "region-0", entityIds: ["alvor"], deltas: [] };
  await textureRegion(
    region,
    { entities, edges, world: "wf-test", batchId: "batch1", sourceKind: "manual", note: "make it darker" },
    { client }
  );
  assert.ok(capturedPrompt.includes("make it darker"));
});

// ---------------------------------------------------------- textureBatch (mocked)

test("textureBatch: one API call per region, not per node (cost-control acceptance criterion)", async () => {
  let callCount = 0;
  const client = {
    messages: {
      create: async () => {
        callCount++;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify([{ op: "upsert_entity", id: "alvor", data: {}, rationale: "x" }])
            }
          ]
        };
      }
    }
  };
  const deltas = [
    { kind: "seed-propagated", entityId: "alvor", impactScore: 0.6, needsLLM: true },
    { kind: "seed-propagated", entityId: "gerdur", impactScore: 0.4, needsLLM: true } // same region as alvor (edge-connected)
  ];
  const { mutations, regions } = await textureBatch(
    deltas,
    { entities, edges, world: "wf-test", batchId: "batch1" },
    { client }
  );
  assert.equal(regions.length, 1);
  assert.equal(callCount, 1, "two entities in one connected region should cost exactly one API call");
  assert.equal(mutations.length, 1);
});

test("DEFAULT_TEXTURE_MODEL is claude-sonnet-5 per the phase-1 task spec", () => {
  assert.equal(DEFAULT_TEXTURE_MODEL, "claude-sonnet-5");
});

// ---------------------------------------------- Phase 37 task 37.1: fortune-bias / nudge-tags prompt plumbing
// Deterministic PROMPT-SNAPSHOT tests: no live API, mirrors this file's own
// mockClient + "textureRegion: passes the reviewer note through to the
// prompt on regenerate" pattern above (capture params.messages[0].content,
// assert on substrings) -- never asserting on model-authored TEXT quality,
// only on what THIS codebase deterministically puts into the prompt.

test("textureRegion: an OMITTED fortuneBias/nudgeTags renders NO tone line at all -- every pre-Phase-37 caller is byte-for-byte unaffected", async () => {
  let capturedPrompt = "";
  const client = mockClient([
    (params) => {
      capturedPrompt = params.messages[0].content;
      return JSON.stringify([{ op: "upsert_entity", id: "alvor", data: {}, rationale: "x" }]);
    }
  ]);
  const region = { regionId: "region-0", entityIds: ["alvor"], deltas: [] };
  await textureRegion(region, { entities, edges, world: "wf-test", batchId: "batch1", sourceKind: "manual" }, { client });
  assert.ok(!capturedPrompt.includes("Overall fortune"), "no fortuneBias given -- no fortune line expected");
  assert.ok(!capturedPrompt.includes("Nudge this pass"), "no nudgeTags given -- no nudge line expected");
});

test("textureRegion: fortuneBias + fortuneLabel render a tone line in the prompt", async () => {
  let capturedPrompt = "";
  const client = mockClient([
    (params) => {
      capturedPrompt = params.messages[0].content;
      return JSON.stringify([{ op: "upsert_entity", id: "alvor", data: {}, rationale: "x" }]);
    }
  ]);
  const region = { regionId: "region-0", entityIds: ["alvor"], deltas: [] };
  await textureRegion(
    region,
    { entities, edges, world: "wf-test", batchId: "batch1", sourceKind: "manual", fortuneBias: -2, fortuneLabel: "Ruinous" },
    { client }
  );
  assert.ok(capturedPrompt.includes("Overall fortune"), `expected a fortune tone line, got:\n${capturedPrompt}`);
  assert.ok(capturedPrompt.includes("-2"), "expected the numeric bias in the prompt");
  assert.ok(capturedPrompt.includes("Ruinous"), "expected the fortune stop's own label in the prompt");
});

test("textureRegion: nudgeTags render a 'Nudge this pass toward' line in the prompt", async () => {
  let capturedPrompt = "";
  const client = mockClient([
    (params) => {
      capturedPrompt = params.messages[0].content;
      return JSON.stringify([{ op: "upsert_entity", id: "alvor", data: {}, rationale: "x" }]);
    }
  ]);
  const region = { regionId: "region-0", entityIds: ["alvor"], deltas: [] };
  await textureRegion(
    region,
    { entities, edges, world: "wf-test", batchId: "batch1", sourceKind: "manual", nudgeTags: ["decay", "feud"] },
    { client }
  );
  assert.ok(capturedPrompt.includes("Nudge this pass toward: decay, feud."), `expected the nudge line, got:\n${capturedPrompt}`);
});

test("textureRegion: nudgeTags are stamped onto an emitted upsert_entity mutation's own data.tags, deduplicated against any tags the model itself proposed", async () => {
  const goodResponse = JSON.stringify([
    { op: "upsert_entity", id: "alvor", data: { description: "x", tags: ["existing", "decay"] }, rationale: "x" }
  ]);
  const client = mockClient([goodResponse]);
  const region = { regionId: "region-0", entityIds: ["alvor"], deltas: [] };
  const [mutation] = await textureRegion(
    region,
    { entities, edges, world: "wf-test", batchId: "batch1", sourceKind: "manual", nudgeTags: ["decay", "feud"] },
    { client }
  );
  assert.deepEqual(mutation.data.tags, ["existing", "decay", "feud"], "nudge tags merge in, deduplicated against any the model already proposed");
});

test("textureRegion: nudgeTags are NEVER stamped onto a non-entity mutation (e.g. upsert_edge -- edges have no `tags` field in this codebase's vocabulary)", async () => {
  const goodResponse = JSON.stringify([{ op: "upsert_edge", id: "e4", data: { strength: 0.1 }, rationale: "x" }]);
  const client = mockClient([goodResponse]);
  const region = { regionId: "region-0", entityIds: ["alvor", "gerdur"], deltas: [] };
  const [mutation] = await textureRegion(
    region,
    { entities, edges, world: "wf-test", batchId: "batch1", sourceKind: "manual", nudgeTags: ["decay"] },
    { client }
  );
  assert.equal(mutation.data.tags, undefined);
});

await Promise.all(pending);
console.log(`\n${passed} passed`);
