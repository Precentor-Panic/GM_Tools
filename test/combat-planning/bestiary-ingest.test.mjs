import assert from "node:assert/strict";

/**
 * CONTRACT UNDER TEST — combat-planning/bestiary-ingest.mjs (Phase 18 task
 * 18.1). This module does not exist yet; this file is the interface spec for
 * it, per plans/phase-18-tasks.md task 18.0. It is expected to fail with
 * "Cannot find module" until 18.1 lands.
 *
 * Design record §1a / §5's review: LLM extraction returns RAW FIELDS ONLY --
 * no action-economy score, no derived power stat of any kind. Scoring is a
 * separate, pure function (combat-planning/action-economy.mjs, task 18.3)
 * consuming this module's raw output. THE SINGLE MOST LOAD-BEARING CONTRACT
 * POINT IN THIS FILE: the shape returned by proposeBestiaryEntryFromText/
 * ProposeBestiaryEntryFromPdf below must never contain a `score`,
 * `actionEconomyScore`, `threatScore`, or any other derived-power key --
 * only the raw fields an LLM can honestly read off a stat block.
 *
 * Follows graph-import/writeup-import.mjs's proposeWfiFromWriteup shape
 * exactly: retry-once-on-truncation (doubling maxTokens), retry-once on a
 * validation failure (re-prompting with the error), THEN throw a typed
 * error. Same client-injection convention (opts.client, an
 * Anthropic-SDK-shaped mock -- see mockClient() below) as every other
 * callModelDetailed consumer in this codebase (graph-import/writeup-import.mjs,
 * mutation-engine/texture.mjs, mutation-engine/narrate.mjs).
 *
 * RawBestiaryFields shape (the LLM extraction's ONLY output, no score field
 * anywhere in this object):
 *   {
 *     name: string,
 *     type: string,                        // e.g. "beast", "humanoid" -- freeform, not a fixed enum (bring-your-own-system)
 *     challengeRating?: string|number,      // CR if the source states one
 *     level?: number,                       // for non-CR systems
 *     hp: number,
 *     ac: number,
 *     attacks: Array<{
 *       name: string,
 *       toHitBonus?: number,
 *       damageDice: string,                 // e.g. "2d6+3", left as a dice string, not pre-averaged
 *       damageType?: string
 *     }>,
 *     multiattack?: { count: number, attackNames?: string[] },
 *     rechargeAbilities?: Array<{
 *       name: string,
 *       rechargeOn: string,                 // e.g. "5-6", "6" -- a d6 recharge-roll range, as printed
 *       damageDice?: string
 *     }>,
 *     legendaryActions?: { count: number, costPerAction?: number },
 *     lairEffects?: boolean,
 *     auraEffects?: string[],
 *     appliedEffects?: string[]             // effect/condition NAMES this creature can inflict
 *                                            // (fed to combat-planning/effect-impact.mjs later, task 18.3 --
 *                                            // this module never scores them, just lists the names)
 *   }
 *
 * ---------------------------------------------------------------------------
 * proposeBestiaryEntryFromText(text, opts)
 * ---------------------------------------------------------------------------
 * @param {string} text                pasted stat-block text
 * @param {object} [opts]
 * @param {object} [opts.client]       injectable Anthropic-SDK-shaped client (mockClient() below)
 * @param {string} [opts.apiKey]
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens]
 * @param {string} [opts.note]         steering note for a regenerate
 * @returns {Promise<RawBestiaryFields>}   NEVER a score field, see above
 * @throws {BestiaryExtractionValidationError}  model output never validates after one retry
 *
 * ---------------------------------------------------------------------------
 * proposeBestiaryEntryFromPdf(pdfBase64, opts)
 * ---------------------------------------------------------------------------
 * Same contract as proposeBestiaryEntryFromText, but the prompt passed to
 * callModelDetailed is an ARRAY of Anthropic content blocks -- a `document`
 * block (`{type:"document", source:{type:"base64", media_type:"application/pdf",
 * data: pdfBase64}}`) plus a trailing `text` block with the extraction
 * instructions -- per mutation-engine/llm-call.mjs's callModelDetailed(prompt, opts)
 * passing `prompt` straight through as the SDK's `content` field (which
 * accepts either a string or a content-block array). NO new npm dependency
 * for PDF parsing (design record §1's explicit instruction) -- this sends the
 * PDF straight to the API. This test file only checks the PROMPT SHAPE this
 * function builds (mockClient below can inspect `calls[0].messages[0].content`);
 * it does NOT make a real API call -- that live verification is task 18.1's
 * own first-thing-to-do smoke check, not this contract-spec file's job.
 * @param {string} pdfBase64
 * @param {object} [opts]               same as proposeBestiaryEntryFromText
 * @returns {Promise<RawBestiaryFields>}
 * @throws {BestiaryExtractionValidationError}
 *
 * ---------------------------------------------------------------------------
 * BestiaryExtractionValidationError
 * ---------------------------------------------------------------------------
 * Matches graph-import/writeup-import.mjs's WriteupImportValidationError shape
 * exactly: `class BestiaryExtractionValidationError extends Error` with
 * `.name === "BestiaryExtractionValidationError"`, constructed as
 * `new BestiaryExtractionValidationError(message, {attempts, lastError, rawResponse})`.
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

// Same mock-client convention as test/writeup-import.test.mjs / test/narrate.test.mjs.
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

const GOOD_RAW_FIELDS = {
  name: "Dire Wolf",
  type: "beast",
  challengeRating: "1",
  hp: 37,
  ac: 14,
  attacks: [{ name: "Bite", toHitBonus: 5, damageDice: "2d6+3", damageType: "piercing" }],
  rechargeAbilities: [],
  appliedEffects: ["Prone"]
};

(async () => {
  const {
    proposeBestiaryEntryFromText,
    proposeBestiaryEntryFromPdf,
    BestiaryExtractionValidationError
  } = await import("../../combat-planning/bestiary-ingest.mjs");

  test("proposeBestiaryEntryFromText: returns raw fields with NO score/threat field anywhere", async () => {
    const client = mockClient([JSON.stringify(GOOD_RAW_FIELDS)]);
    const raw = await proposeBestiaryEntryFromText("Dire Wolf stat block text...", { client });
    assert.equal(raw.name, "Dire Wolf");
    assert.equal(raw.hp, 37);
    assert.ok(!("score" in raw), "extraction output must never carry a score field");
    assert.ok(!("actionEconomyScore" in raw), "extraction output must never carry a derived power stat");
    assert.ok(!("threatScore" in raw), "extraction output must never carry a derived power stat");
  });

  test("proposeBestiaryEntryFromText: retries once on truncation, doubling maxTokens, then succeeds", async () => {
    const client = mockClient([
      { text: '{"name":"Dire Wolf"', stopReason: "max_tokens" },
      JSON.stringify(GOOD_RAW_FIELDS)
    ]);
    const raw = await proposeBestiaryEntryFromText("Dire Wolf stat block text...", { client, maxTokens: 256 });
    assert.equal(raw.name, "Dire Wolf");
    assert.equal(client.calls.length, 2);
    assert.ok(client.calls[1].max_tokens > client.calls[0].max_tokens, "budget must double on a truncated first attempt");
  });

  test("proposeBestiaryEntryFromText: throws BestiaryExtractionValidationError (typed, matching WriteupImportValidationError's shape) after two failed attempts", async () => {
    const client = mockClient(["not json at all", "still not json"]);
    await assert.rejects(
      () => proposeBestiaryEntryFromText("garbled input", { client }),
      (err) => {
        assert.equal(err.name, "BestiaryExtractionValidationError");
        assert.ok(err instanceof Error);
        assert.equal(err.attempts, 2);
        return true;
      }
    );
  });

  test("proposeBestiaryEntryFromPdf: sends an Anthropic content-block ARRAY (a document block + a text block), not a plain string, per llm-call.mjs's content passthrough", async () => {
    const client = mockClient([JSON.stringify(GOOD_RAW_FIELDS)]);
    await proposeBestiaryEntryFromPdf("ZmFrZS1wZGYtYnl0ZXM=", { client });
    const sentContent = client.calls[0].messages[0].content;
    assert.ok(Array.isArray(sentContent), "PDF ingestion must pass an array of content blocks, not a plain string");
    const docBlock = sentContent.find((b) => b.type === "document");
    assert.ok(docBlock, "must include a document-type content block");
    assert.equal(docBlock.source.type, "base64");
    assert.equal(docBlock.source.media_type, "application/pdf");
    assert.equal(docBlock.source.data, "ZmFrZS1wZGYtYnl0ZXM=");
    assert.ok(sentContent.some((b) => b.type === "text"), "must also include a text block with extraction instructions");
  });

  test("proposeBestiaryEntryFromPdf: also returns raw fields only, no score", async () => {
    const client = mockClient([JSON.stringify(GOOD_RAW_FIELDS)]);
    const raw = await proposeBestiaryEntryFromPdf("ZmFrZS1wZGYtYnl0ZXM=", { client });
    assert.ok(!("score" in raw));
    assert.equal(raw.name, "Dire Wolf");
  });

  await Promise.all(pending);
  console.log(`\n${passed} passed`);
})();
