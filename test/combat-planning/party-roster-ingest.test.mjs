import assert from "node:assert/strict";

/**
 * CONTRACT UNDER TEST — combat-planning/party-roster-ingest.mjs (Phase 18
 * task 18.2). This module does not exist yet; this file is the interface
 * spec for it, per plans/phase-18-tasks.md task 18.0. It is expected to fail
 * with "Cannot find module" until 18.2 lands.
 *
 * Same extraction-ONLY shape as combat-planning/bestiary-ingest.mjs (18.1),
 * applied to PC character sheets instead of monster stat blocks. Design
 * record §1b: extracted fields split into TWO STRUCTURALLY SEPARATE groups
 * with two different downstream consumers -- this is a hard requirement
 * (task 18.2's own acceptance criterion: "structurally distinguishable in
 * the stored shape, not just informally documented"), not a naming
 * convention within one flat object:
 *   - combatRelevant  -> feeds combat-planning/action-economy.mjs +
 *                        the encounter heuristic (18.3-18.5)
 *   - buildRelevant    -> feeds getPartyContext() (18.6) ONLY, never the
 *                        combat heuristic
 *
 * RawPartyMemberFields shape (the LLM extraction's ONLY output -- no
 * score/threat field anywhere, same "extraction returns raw fields, scoring
 * is a separate pure function" split as bestiary ingestion):
 *   {
 *     name: string,
 *     combatRelevant: {
 *       class: string,
 *       level: number,
 *       ac: number,
 *       hp: number,
 *       attackBonus?: number,
 *       damagePerRoundEstimate?: number,     // dice-string-derived estimate, not pre-scored
 *       saveDCs?: Record<string, number>,    // e.g. {"wisdom": 15}
 *       notableAbilities?: string[]          // ability/feature NAMES only (fed to effect-impact.mjs
 *                                             // taxonomy later if relevant -- never scored here)
 *     },
 *     buildRelevant: {
 *       skills?: string[],
 *       expertise?: string[],
 *       notableTraits?: string[],
 *       backstoryHooks?: string[]
 *     }
 *   }
 *
 * ---------------------------------------------------------------------------
 * proposePartyMemberFromText(text, opts)
 * ---------------------------------------------------------------------------
 * Same retry-once-on-truncation, retry-once-on-validation-failure-then-typed-
 * error convention as bestiary-ingest.mjs / graph-import/writeup-import.mjs.
 * @param {string} text
 * @param {object} [opts]           same shape as bestiary-ingest.mjs's opts
 * @returns {Promise<RawPartyMemberFields>}
 * @throws {PartyRosterExtractionValidationError}
 *
 * ---------------------------------------------------------------------------
 * proposePartyMemberFromPdf(pdfBase64, opts)
 * ---------------------------------------------------------------------------
 * Same document-content-block shape as bestiary-ingest.mjs's
 * proposeBestiaryEntryFromPdf -- an array with a `{type:"document",
 * source:{type:"base64", media_type:"application/pdf", data}}` block plus a
 * trailing text block, passed straight through callModelDetailed's `prompt`
 * parameter (which becomes the SDK's `content` field).
 * @returns {Promise<RawPartyMemberFields>}
 * @throws {PartyRosterExtractionValidationError}
 *
 * ---------------------------------------------------------------------------
 * PartyRosterExtractionValidationError
 * ---------------------------------------------------------------------------
 * Same shape as BestiaryExtractionValidationError / WriteupImportValidationError:
 * `.name === "PartyRosterExtractionValidationError"`, constructed as
 * `new PartyRosterExtractionValidationError(message, {attempts, lastError, rawResponse})`.
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

const GOOD_RAW_FIELDS = {
  name: "Kessa Windrider",
  combatRelevant: {
    class: "Ranger",
    level: 5,
    ac: 15,
    hp: 44,
    attackBonus: 7,
    damagePerRoundEstimate: 18,
    saveDCs: { wisdom: 14 },
    notableAbilities: ["Hunter's Mark"]
  },
  buildRelevant: {
    skills: ["Survival", "Stealth"],
    expertise: ["Survival"],
    notableTraits: ["Grew up in the Ashfen Marsh"],
    backstoryHooks: ["Estranged from a ranger lodge she left under a cloud"]
  }
};

(async () => {
  const {
    proposePartyMemberFromText,
    proposePartyMemberFromPdf,
    PartyRosterExtractionValidationError
  } = await import("../../combat-planning/party-roster-ingest.mjs");

  test("proposePartyMemberFromText: returns combatRelevant/buildRelevant as STRUCTURALLY SEPARATE top-level keys, no score field", async () => {
    const client = mockClient([JSON.stringify(GOOD_RAW_FIELDS)]);
    const raw = await proposePartyMemberFromText("Kessa Windrider character sheet text...", { client });
    assert.ok(raw.combatRelevant, "must have a combatRelevant object");
    assert.ok(raw.buildRelevant, "must have a buildRelevant object");
    assert.equal(raw.combatRelevant.class, "Ranger");
    assert.ok(raw.buildRelevant.skills.includes("Survival"));
    assert.ok(!("score" in raw), "extraction output must never carry a score field");
    assert.ok(!("score" in raw.combatRelevant), "combatRelevant must never carry a score field -- scoring is 18.3's job");
  });

  test("proposePartyMemberFromText: combat-relevant and build-relevant fields don't leak into each other's group", async () => {
    const client = mockClient([JSON.stringify(GOOD_RAW_FIELDS)]);
    const raw = await proposePartyMemberFromText("...", { client });
    assert.ok(!("skills" in raw.combatRelevant), "build-relevant fields (skills) must not appear inside combatRelevant");
    assert.ok(!("ac" in raw.buildRelevant), "combat-relevant fields (ac) must not appear inside buildRelevant");
  });

  test("proposePartyMemberFromText: retries once on truncation, doubling maxTokens", async () => {
    const client = mockClient([
      { text: '{"name":"Kessa"', stopReason: "max_tokens" },
      JSON.stringify(GOOD_RAW_FIELDS)
    ]);
    const raw = await proposePartyMemberFromText("...", { client, maxTokens: 256 });
    assert.equal(raw.name, "Kessa Windrider");
    assert.equal(client.calls.length, 2);
    assert.ok(client.calls[1].max_tokens > client.calls[0].max_tokens);
  });

  test("proposePartyMemberFromText: throws PartyRosterExtractionValidationError after two failed attempts", async () => {
    const client = mockClient(["nope", "still nope"]);
    await assert.rejects(
      () => proposePartyMemberFromText("garbled", { client }),
      (err) => {
        assert.equal(err.name, "PartyRosterExtractionValidationError");
        assert.equal(err.attempts, 2);
        return true;
      }
    );
  });

  test("proposePartyMemberFromPdf: sends a document content-block array, not a plain string", async () => {
    const client = mockClient([JSON.stringify(GOOD_RAW_FIELDS)]);
    await proposePartyMemberFromPdf("ZmFrZS1zaGVldC1ieXRlcw==", { client });
    const sentContent = client.calls[0].messages[0].content;
    assert.ok(Array.isArray(sentContent));
    const docBlock = sentContent.find((b) => b.type === "document");
    assert.ok(docBlock);
    assert.equal(docBlock.source.media_type, "application/pdf");
    assert.equal(docBlock.source.data, "ZmFrZS1zaGVldC1ieXRlcw==");
  });

  await Promise.all(pending);
  console.log(`\n${passed} passed`);
})();
