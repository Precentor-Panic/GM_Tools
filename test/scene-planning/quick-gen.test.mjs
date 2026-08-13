import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * CONTRACT UNDER TEST — new `mutation-engine/quick-gen.mjs` (Phase 22 task
 * 22.6). This module does not exist yet; this file is the interface spec
 * for it, per plans/phase-22-tasks.md task 22.0. Expected to fail with
 * "Cannot find module" until 22.6 lands.
 *
 * Implements plans/phase-21-review.md §7 and §12's second identified
 * engine-layer requirement: "A fast, single-shot ad-hoc generation
 * primitive for the mid-session '+' flow ... genuinely distinct from the
 * multi-round Q&A pattern, since 'one field, one button, fast' rules out
 * reusing the full reframe-round machinery." This is deliberately a MUCH
 * THINNER wrapper than wf-mcp-server/lib/prep-content-ops.mjs's flow -- not
 * a smaller version of it, a genuinely different, simpler primitive.
 *
 * ---------------------------------------------------------------------------
 * quickGenerate(prompt, opts = {})
 * ---------------------------------------------------------------------------
 *   @param {string} prompt          the FULLY-COMPOSED prompt text (this
 *                                   function does no templating/fillTemplate
 *                                   of its own -- the caller, e.g. a future
 *                                   review-ui route, builds the prompt
 *                                   string before calling this)
 *   @param {object} [opts.client]   injectable Anthropic-SDK-shaped client
 *                                   (same DI convention as EVERY other LLM
 *                                   call site in this project --
 *                                   mutation-engine/llm-call.mjs's
 *                                   callModelDetailed's own opts.client)
 *   @param {string} [opts.apiKey]
 *   @param {string} [opts.model]    defaults to DEFAULT_QUICK_GEN_MODEL
 *   @param {number} [opts.maxTokens]
 *   @returns {Promise<{text: string, truncated: boolean}>}
 *     THE SAME return shape callModelDetailed itself already returns --
 *     quickGenerate is a thin, ~1:1 pass-through, not a reshaping wrapper.
 *
 * export const DEFAULT_QUICK_GEN_MODEL = "claude-haiku-4-5"
 *   The same fast/cheap model choice Phase 8's rubber-duck framing calls
 *   already established for this project's "genuinely fast" bar (measured
 *   ~5-25s there vs. the real extraction's ~51-59s p50) -- reused here as
 *   the sensible default for an even smaller, single-field ad-hoc
 *   generation, not re-litigated from scratch.
 *
 * ---------------------------------------------------------------------------
 * THE SINGLE HIGHEST-VALUE PROPERTY (per 22.0's own explicit instruction):
 * quickGenerate makes EXACTLY ONE model call, no reframePrepFramingsOp-
 * style round-trip of ANY kind -- proven by asserting call COUNT against a
 * mocked client (matching this project's established convention for
 * testing latency-sensitive things deterministically, not via wall-clock
 * timing).
 * ---------------------------------------------------------------------------
 *
 * mutation-engine/llm-call.mjs REUSE (source-grep, matching
 * test/combat-planning/encounter-heuristic.mjs's own "confirmed by reading
 * the module's own source" pattern): quick-gen.mjs must call
 * callModelDetailed (imported from mutation-engine/llm-call.mjs) rather
 * than constructing its own Anthropic client / duplicating the JSON-fence-
 * stripping plumbing -- confirmed directly from this module's own source
 * text, independent of whether quick-gen.mjs exists yet.
 */

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
        return { content: [{ type: "text", text: resp.text }], stop_reason: resp.stopReason ?? "end_turn" };
      }
    }
  };
}

let passed = 0;
async function test(name, fn) {
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

(async () => {
  let mod;
  try {
    mod = await import("../../mutation-engine/quick-gen.mjs");
  } catch (err) {
    console.error("FAIL  import mutation-engine/quick-gen.mjs");
    console.error(err.stack || err.message);
    process.exitCode = 1;
    console.log(`\n${passed} test(s) passed.`);
    return;
  }
  const { quickGenerate, DEFAULT_QUICK_GEN_MODEL, groundPromptWithAnchor } = mod;

  await test("SOURCE GREP: quick-gen.mjs calls into mutation-engine/llm-call.mjs's callModelDetailed rather than constructing its own client/plumbing", () => {
    const src = readFileSync(new URL("../../mutation-engine/quick-gen.mjs", import.meta.url), "utf8");
    assert.ok(/callModelDetailed/.test(src), "must reuse the shared LLM-call plumbing");
    assert.ok(!/new Anthropic\(/.test(src), "must never construct its own Anthropic client directly -- that's callModelDetailed's job");
  });

  await test("SOURCE GREP: quick-gen.mjs never references reframePrepFramingsOp or prep-content-ops.mjs at all -- genuinely distinct from the multi-round Q&A pattern, not a thin call into it", () => {
    const src = readFileSync(new URL("../../mutation-engine/quick-gen.mjs", import.meta.url), "utf8");
    assert.ok(!/reframePrepFramingsOp/.test(src));
    assert.ok(!/prep-content-ops/.test(src));
  });

  await test("DEFAULT_QUICK_GEN_MODEL is exported and is the established fast/cheap model choice", () => {
    assert.equal(DEFAULT_QUICK_GEN_MODEL, "claude-haiku-4-5");
  });

  await test("EXACTLY ONE call: quickGenerate makes a single call to the mocked client, no round-trip", async () => {
    const client = mockClient([{ text: "A dusty crossroads shrine, half-collapsed." }]);
    const result = await quickGenerate("Describe a quick roadside landmark.", { client });
    assert.equal(client.calls.length, 1, "quickGenerate must call the client's messages.create exactly once");
    assert.equal(result.text, "A dusty crossroads shrine, half-collapsed.");
    assert.equal(result.truncated, false);
  });

  await test("returns {text, truncated} in the same shape callModelDetailed returns, including truncated:true when stop_reason is max_tokens", async () => {
    const client = mockClient([{ text: "cut off mid-sen", stopReason: "max_tokens" }]);
    const result = await quickGenerate("Describe something long.", { client });
    assert.equal(client.calls.length, 1, "still exactly one call even when the response was truncated -- quickGenerate never auto-retries with a bigger budget itself");
    assert.equal(result.truncated, true);
  });

  await test("forwards opts.model to the client call, defaulting to DEFAULT_QUICK_GEN_MODEL when omitted", async () => {
    const client = mockClient([{ text: "x" }]);
    await quickGenerate("prompt", { client });
    assert.equal(client.calls[0].model, DEFAULT_QUICK_GEN_MODEL);

    const client2 = mockClient([{ text: "y" }]);
    await quickGenerate("prompt", { client: client2, model: "claude-sonnet-5" });
    assert.equal(client2.calls[0].model, "claude-sonnet-5");
  });

  await test("calling quickGenerate twice in a row (two separate ad-hoc generations) makes exactly two TOTAL calls -- one per invocation, never a hidden extra round per call", async () => {
    const client = mockClient([{ text: "first" }, { text: "second" }]);
    const r1 = await quickGenerate("first prompt", { client });
    const r2 = await quickGenerate("second prompt", { client });
    assert.equal(client.calls.length, 2);
    assert.equal(r1.text, "first");
    assert.equal(r2.text, "second");
  });

  // Phase 37.6 task 4 (graph-context census): groundPromptWithAnchor -- pure,
  // no LLM call, additive/optional. quick-gen's route calls it when a caller
  // supplies an anchorEntityId; a byte-for-byte no-op otherwise, so every
  // EXISTING context-free call stays unaffected.
  const entities = [
    { id: "place-crossroads", name: "The Salt Crossroads", type: "place", description: "Where three trade roads meet." },
    { id: "npc-tollkeeper", name: "Ren the Tollkeeper", type: "person" }
  ];
  const edges = [{ id: "edge-1", sourceId: "npc-tollkeeper", targetId: "place-crossroads", relationshipType: "containment" }];

  await test("groundPromptWithAnchor: no anchorEntityId -> returns the prompt VERBATIM, byte-for-byte (every existing context-free call site unaffected)", () => {
    const out = groundPromptWithAnchor("Describe a quick roadside landmark.", entities, edges, undefined);
    assert.equal(out, "Describe a quick roadside landmark.");
  });

  await test("groundPromptWithAnchor: with an anchorEntityId -> prepends real graph context (entity name + its real neighbor) ahead of the caller's own prompt", () => {
    const out = groundPromptWithAnchor("Describe a quick roadside landmark.", entities, edges, "place-crossroads");
    assert.match(out, /The Salt Crossroads/, "the anchor entity's own label grounds the prompt");
    assert.match(out, /Ren the Tollkeeper/, "the anchor's real graph neighbor grounds the prompt");
    assert.ok(out.endsWith("Describe a quick roadside landmark."), "the caller's own prompt text survives verbatim, appended after the context block");
  });

  await test("groundPromptWithAnchor: an anchor with no recorded neighbors still grounds on its own label, no crash", () => {
    const lonely = [{ id: "place-lonely", name: "An Unmarked Cairn", type: "place" }];
    const out = groundPromptWithAnchor("prompt text", lonely, [], "place-lonely");
    assert.match(out, /An Unmarked Cairn/);
  });

  await test("EXACTLY ONE call: grounding the prompt then calling quickGenerate still makes a single client call", async () => {
    const client = mockClient([{ text: "A dusty crossroads shrine, half-collapsed." }]);
    const grounded = groundPromptWithAnchor("Describe a quick roadside landmark.", entities, edges, "place-crossroads");
    const result = await quickGenerate(grounded, { client });
    assert.equal(client.calls.length, 1);
    assert.match(client.calls[0].messages[0].content, /The Salt Crossroads/, "the grounded context actually reaches the model call");
    assert.equal(result.text, "A dusty crossroads shrine, half-collapsed.");
  });

  console.log(`\n${passed} test(s) passed.`);
})();
