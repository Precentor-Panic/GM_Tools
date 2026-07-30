import assert from "node:assert/strict";

/**
 * CONTRACT UNDER TEST — combat-planning/thematic-filter.mjs (Phase 18 task
 * 18.5). This module does not exist yet; this file is the interface spec for
 * it, per plans/phase-18-tasks.md task 18.0. It is expected to fail with
 * "Cannot find module" until 18.5 lands.
 *
 * THE ONE LLM-TOUCHING PIECE OF 18.5, DELIBERATELY KEPT IN ITS OWN SEPARATE
 * MODULE (task 18.5's own instruction) so combat-planning/encounter-
 * heuristic.mjs's deterministic core stays LLM-free and independently
 * testable without mocking a client. Design record §2's closing paragraph:
 * "given the current scene's context (location, active threat, faction
 * present -- pulled straight from the graph, the same grounding pattern
 * narrate.mjs's buildAdjacencyContext already uses), suggest which bestiary
 * tags/types fit thematically. It narrows the candidate pool by fit; the
 * heuristic picks the actual roster by math. The LLM never decides final
 * difficulty or composition."
 *
 * Same callModelDetailed/client-injection convention as every other
 * LLM-touching module in this codebase.
 *
 * ---------------------------------------------------------------------------
 * proposeThematicTags(sceneContext, candidatePool, opts)
 * ---------------------------------------------------------------------------
 * @param {{entityLabel:string, neighborDescriptions:string[]}} sceneContext
 *   the SAME shape mutation-engine/narrate.mjs's buildAdjacencyContext
 *   returns -- this module never builds its own grounding context, it
 *   consumes buildAdjacencyContext's output as-is (the caller, e.g. a future
 *   review-ui route, is responsible for calling buildAdjacencyContext first).
 * @param {Array<{entryId:string, rawFields:object}>} candidatePool
 *   the full bestiary library (or a caller-narrowed subset) to filter BY FIT
 *   -- this function narrows, it does not invent new monsters.
 * @param {object} [opts]
 * @param {object} [opts.client]
 * @param {string} [opts.apiKey]
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{filteredEntryIds: string[], rationale: string}>}
 *   filteredEntryIds is always a SUBSET of candidatePool's own entryIds
 *   (never an id the model invents that wasn't in the input pool) -- this
 *   function NEVER decides final difficulty or composition (design record's
 *   own explicit boundary), it only narrows by thematic fit.
 * @throws {ThematicFilterValidationError}  model output never validates after one retry (same typed-error convention as every other LLM-touching module in this codebase)
 */

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

const SCENE_CONTEXT = {
  entityLabel: "The Ashfen Marsh (place)",
  neighborDescriptions: ["Bog Wraith Warren (containment)", "Drowned Shrine (presence)"]
};

const CANDIDATE_POOL = [
  { entryId: "wolf-1", rawFields: { name: "Wolf", type: "beast" } },
  { entryId: "bog-wraith-1", rawFields: { name: "Bog Wraith", type: "undead" } },
  { entryId: "desert-scorpion-1", rawFields: { name: "Giant Scorpion", type: "beast" } }
];

(async () => {
  const { proposeThematicTags, ThematicFilterValidationError } =
    await import("../../combat-planning/thematic-filter.mjs");

  test("proposeThematicTags: returns filteredEntryIds as a SUBSET of the candidate pool's own ids", async () => {
    const client = mockClient([JSON.stringify({
      filteredEntryIds: ["bog-wraith-1"],
      rationale: "A marsh/undead-themed location fits the Bog Wraith; the desert scorpion and generic wolf don't."
    })]);
    const result = await proposeThematicTags(SCENE_CONTEXT, CANDIDATE_POOL, { client });
    assert.deepEqual(result.filteredEntryIds, ["bog-wraith-1"]);
    const poolIds = new Set(CANDIDATE_POOL.map((c) => c.entryId));
    for (const id of result.filteredEntryIds) {
      assert.ok(poolIds.has(id), `filteredEntryIds must only ever contain ids from the input candidatePool, got "${id}"`);
    }
    assert.equal(typeof result.rationale, "string");
  });

  test("proposeThematicTags: never invents an entryId that wasn't in the input pool -- a model hallucinating an unknown id is a validation failure, not silently passed through", async () => {
    const client = mockClient([
      JSON.stringify({ filteredEntryIds: ["totally-made-up-id"], rationale: "..." }),
      JSON.stringify({ filteredEntryIds: ["bog-wraith-1"], rationale: "corrected" })
    ]);
    const result = await proposeThematicTags(SCENE_CONTEXT, CANDIDATE_POOL, { client });
    assert.deepEqual(result.filteredEntryIds, ["bog-wraith-1"]);
    assert.equal(client.calls.length, 2, "an out-of-pool id must trigger the same retry-once convention as any other validation failure");
  });

  test("proposeThematicTags: throws ThematicFilterValidationError after two failed attempts", async () => {
    const client = mockClient(["not json", "still not json"]);
    await assert.rejects(
      () => proposeThematicTags(SCENE_CONTEXT, CANDIDATE_POOL, { client }),
      (err) => {
        assert.equal(err.name, "ThematicFilterValidationError");
        return true;
      }
    );
  });

  await Promise.all(pending);
  console.log(`\n${passed} passed`);
})();
