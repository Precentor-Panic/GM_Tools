import assert from "node:assert/strict";

/**
 * CONTRACT UNDER TEST — combat-planning/reskin-suggest.mjs (Phase 37.6b).
 * "Wear it as something else":
 *  - grounds the prompt in a compact, non-numeric flavor line derived from
 *    the entry's rawFields (bestiary-store.mjs's compactStatFlavorLine --
 *    the actual numbers never reach the model) + graph context
 *    (buildAdjacencyContext around the entry's promoted node when it has
 *    one, else graph-import/writeup-import.mjs's renderExistingWorldSummary)
 *    + the GM's own optional one-line vision,
 *  - calls the model through the SAME opts.client injection seam every
 *    other outbound-LLM call site in this project uses,
 *  - returns `{ suggestions: [...] }` (2-3 {name,description,habitatHint})
 *    and NEVER writes anywhere -- accepting one is a SEPARATE, explicit step
 *    (bestiary-store.mjs's createReskinnedBestiaryEntry, its own test file).
 *
 * Per gm-tools-conventions' LLM-code rule: this is the mocked-client unit
 * test (orchestration/validation/shaping); the real round trip is the
 * documented manual smoke test in the module's own header, not run here.
 */

const { suggestReskins, DEFAULT_RESKIN_SUGGEST_MODEL, MIN_RESKIN_SUGGESTIONS, MAX_RESKIN_SUGGESTIONS } =
  await import("../combat-planning/reskin-suggest.mjs");

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

const ENTRY = {
  id: "bst-goblin-1",
  rawFields: {
    name: "Test Goblin", type: "humanoid (goblinoid)", challengeRating: "1/4", alignment: "neutral evil",
    hp: 7, ac: 15, attacks: [{ name: "Scimitar", toHitBonus: 4, damageDice: "1d6+2", damageType: "slashing" }]
  },
  graphEntityId: null
};

const TWO_SUGGESTIONS = {
  suggestions: [
    { name: "Ashfen Cur", description: "A mangy, ash-grey stray that hunts the ruined quarter after dark.", habitatHint: "Urban ruins, at dusk." },
    { name: "Whistling Reed-Sneak", description: "A reed-thin marsh raider who signals its pack with an eerie whistle.", habitatHint: "Coastal marshland." }
  ]
};

await testAsync("returns 2-3 suggestions, grounded in the flavor line, vision, and graph context; NEVER leaks the literal damage dice into the prompt", async () => {
  const capture = {};
  const client = fakeClient(TWO_SUGGESTIONS, capture);
  const entities = [{ id: "place-market", name: "The Rustwater Market", type: "place", description: "A sprawling flea market." }];

  const out = await suggestReskins(ENTRY, entities, [], "closer to a court intriguer than a brute", { client });

  assert.equal(out.suggestions.length, 2);
  assert.deepEqual(out.suggestions[0], TWO_SUGGESTIONS.suggestions[0]);
  assert.equal(capture.model, DEFAULT_RESKIN_SUGGEST_MODEL);
  assert.match(capture.prompt, /Test Goblin/, "the creature's own name grounds the prompt");
  assert.match(capture.prompt, /humanoid \(goblinoid\)/, "the flavor line grounds the prompt");
  assert.match(capture.prompt, /CR 1\/4/);
  assert.match(capture.prompt, /closer to a court intriguer than a brute/, "the GM's own vision reaches the prompt");
  assert.doesNotMatch(capture.prompt, /1d6\+2/, "the literal damage dice must never reach the model");
  assert.doesNotMatch(capture.prompt, /\bhp\b.*7\b/i, "the literal hp number must never reach the model");
});

await testAsync("no graph link on the entry: falls back to a compact whole-world summary (renderExistingWorldSummary), not an entity-centric walk", async () => {
  const capture = {};
  const client = fakeClient(TWO_SUGGESTIONS, capture);
  const entities = [{ id: "e1", name: "Rustwater Market", type: "place" }, { id: "e2", name: "The Drowned Choir", type: "faction" }];

  await suggestReskins(ENTRY, entities, [], undefined, { client });

  assert.match(capture.prompt, /isn't linked to the world graph yet/i);
  assert.match(capture.prompt, /Rustwater Market \(place\)/);
  assert.match(capture.prompt, /The Drowned Choir \(faction\)/);
});

await testAsync("a promoted entry (graphEntityId set) grounds on ITS real graph neighborhood via buildAdjacencyContext", async () => {
  const capture = {};
  const client = fakeClient(TWO_SUGGESTIONS, capture);
  const linkedEntry = { ...ENTRY, graphEntityId: "npc-goblin-1" };
  const entities = [
    { id: "npc-goblin-1", name: "Test Goblin", type: "person" },
    { id: "place-warren", name: "The Warren", type: "place" }
  ];
  const edges = [{ id: "edge-1", sourceId: "npc-goblin-1", targetId: "place-warren", relationshipType: "containment" }];

  await suggestReskins(linkedEntry, entities, edges, undefined, { client });

  assert.match(capture.prompt, /already linked to the world graph/i);
  assert.match(capture.prompt, /The Warren \(containment\)/);
});

await testAsync("empty/omitted vision still succeeds -- the model is told to surprise the GM instead of erroring like developDescription's required vision", async () => {
  const capture = {};
  const client = fakeClient(TWO_SUGGESTIONS, capture);
  await suggestReskins(ENTRY, [], [], "   ", { client });
  assert.match(capture.prompt, /no specific steer from the GM/i);
});

await testAsync("throws a clear error for a missing/invalid entry (rawFields required) -- no API call is made", async () => {
  let called = false;
  const client = { messages: { async create() { called = true; return { content: [{ type: "text", text: "{}" }], stop_reason: "end_turn" }; } } };
  await assert.rejects(() => suggestReskins(null, [], [], "", { client }), /requires a BestiaryEntry/);
  await assert.rejects(() => suggestReskins({}, [], [], "", { client }), /requires a BestiaryEntry/);
  assert.equal(called, false, "the model must never be called for a malformed entry");
});

await testAsync("throws a clear error when the model returns fewer than MIN_RESKIN_SUGGESTIONS usable suggestions", async () => {
  const client = fakeClient({ suggestions: [{ name: "Only One", description: "x", habitatHint: "y" }] });
  await assert.rejects(() => suggestReskins(ENTRY, [], [], "", { client }), /at least 2/);
});

await testAsync("drops malformed suggestion entries (missing name/description/habitatHint) rather than crashing, still requiring the minimum count from what's left", async () => {
  const client = fakeClient({
    suggestions: [
      { name: "Good One", description: "x", habitatHint: "y" },
      { name: "", description: "missing name -- dropped", habitatHint: "z" },
      { name: "Also Good", description: "w", habitatHint: "v" }
    ]
  });
  const out = await suggestReskins(ENTRY, [], [], "", { client });
  assert.equal(out.suggestions.length, 2);
  assert.equal(out.suggestions.every((s) => s.name), true);
});

await testAsync(`caps at MAX_RESKIN_SUGGESTIONS (${MAX_RESKIN_SUGGESTIONS}) even if the model returns more`, async () => {
  const client = fakeClient({
    suggestions: Array.from({ length: 5 }, (_, i) => ({ name: `Suggestion ${i}`, description: "x", habitatHint: "y" }))
  });
  const out = await suggestReskins(ENTRY, [], [], "", { client });
  assert.equal(out.suggestions.length, MAX_RESKIN_SUGGESTIONS);
});

console.log(`\nreskin-suggest: ${passed} passed`);
