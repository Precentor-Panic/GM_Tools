import assert from "node:assert/strict";

/**
 * CONTRACT UNDER TEST — mutation-engine/develop-description.mjs (Phase 37.6
 * task 3). The "✦ develop this place" assist:
 *  - grounds the prompt in the entity's own current description + its real
 *    graph neighborhood (buildAdjacencyContext, narrate.mjs's shared
 *    builder) + the GM's own one-line vision,
 *  - calls the model through the SAME opts.client injection seam every
 *    other outbound-LLM call site in this project uses,
 *  - returns a plain `{ suggestion }` string and NEVER writes anywhere.
 *
 * Per gm-tools-conventions' LLM-code rule: this is the mocked-client unit
 * test (orchestration/validation/shaping); the real round trip is the
 * documented manual smoke test in the module's own header, not run here.
 */

const { developDescription, DEFAULT_DEVELOP_DESCRIPTION_MODEL } = await import("../mutation-engine/develop-description.mjs");

let passed = 0;
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

/** A fake Anthropic-SDK-shaped client that returns a canned JSON body and records the prompt it saw. */
function fakeClient(jsonBody, capture = {}) {
  return {
    messages: {
      async create(args) {
        capture.model = args.model;
        capture.prompt = args.messages?.[0]?.content ?? "";
        return {
          content: [{ type: "text", text: typeof jsonBody === "string" ? jsonBody : JSON.stringify(jsonBody) }],
          stop_reason: "end_turn"
        };
      }
    }
  };
}

const entities = [
  { id: "place-crypt", name: "The Drowned Crypt", type: "place", description: "A flooded burial vault beneath the chapel." },
  { id: "npc-sexton", name: "Old Maur the Sexton", type: "person", description: "Keeps the crypt." }
];
const edges = [{ id: "edge-sexton-crypt", sourceId: "npc-sexton", targetId: "place-crypt", relationshipType: "containment" }];

await testAsync("returns a suggestion grounded in the current description, the vision, and the real graph neighborhood", async () => {
  const capture = {};
  const client = fakeClient({ suggestion: "Waterlines on the pillars mark where the flood has risen and fallen over decades." }, capture);

  const out = await developDescription(entities, edges, "place-crypt", "the water level rises and falls with the tide", { client });

  assert.equal(out.suggestion, "Waterlines on the pillars mark where the flood has risen and fallen over decades.");
  assert.equal(capture.model, DEFAULT_DEVELOP_DESCRIPTION_MODEL);
  assert.match(capture.prompt, /The Drowned Crypt/, "the entity's own label grounds the prompt");
  assert.match(capture.prompt, /flooded burial vault/, "the entity's current description grounds the prompt");
  assert.match(capture.prompt, /Old Maur the Sexton/, "the real graph neighbor grounds the prompt");
  assert.match(capture.prompt, /the water level rises and falls with the tide/, "the GM's own vision reaches the prompt");
});

await testAsync("throws a clear error for an unknown entity id -- no API call is made", async () => {
  let called = false;
  const client = { messages: { async create() { called = true; return { content: [{ type: "text", text: "{}" }], stop_reason: "end_turn" }; } } };
  await assert.rejects(
    () => developDescription(entities, edges, "no-such-entity", "a vision", { client }),
    /no entity found/
  );
  assert.equal(called, false, "the model must never be called for an unknown entity");
});

await testAsync("throws a clear error for an empty/whitespace-only vision -- no API call is made", async () => {
  let called = false;
  const client = { messages: { async create() { called = true; return { content: [{ type: "text", text: "{}" }], stop_reason: "end_turn" }; } } };
  await assert.rejects(
    () => developDescription(entities, edges, "place-crypt", "   ", { client }),
    /non-empty vision/
  );
  assert.equal(called, false, "the model must never be called for an empty vision");
});

await testAsync("throws a clear error when the model returns an empty/unusable suggestion", async () => {
  const client = fakeClient({ suggestion: "   " });
  await assert.rejects(
    () => developDescription(entities, edges, "place-crypt", "a vision", { client }),
    /no usable suggestion/
  );
});

await testAsync("tolerates an entity with no recorded description yet", async () => {
  const bareEntities = [{ id: "place-bare", name: "An Unmarked Cairn", type: "place" }];
  const capture = {};
  const client = fakeClient({ suggestion: "Loose stones, recently disturbed." }, capture);
  const out = await developDescription(bareEntities, [], "place-bare", "someone's been digging here", { client });
  assert.equal(out.suggestion, "Loose stones, recently disturbed.");
  assert.match(capture.prompt, /none recorded yet/i);
});

console.log(`\ndevelop-description: ${passed} passed`);
