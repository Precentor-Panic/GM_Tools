import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  previewMentionScan,
  DEFAULT_MENTION_RELATIONSHIP,
  nameSimilarity,
  findFuzzyEntityMatch,
  applyFuzzyPrepass,
  FUZZY_MATCH_THRESHOLD,
  proposeMentionedEntities,
  scanForMentionedEntities,
  renderNeighborhoodContext
} from "../graph-import/scan-mentions.mjs";

// Phase 37.6 task 4 added real scanForMentionedEntities coverage below (it
// calls review-state.mjs's createBatch) -- isolate the store BEFORE that
// runs, same pattern test/writeup-import.test.mjs's own top-of-file note
// establishes (createBatch's root is read lazily at call time, so setting
// this here, after the static imports above, is still safe).
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-scan-mentions-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = scratchDir;

/**
 * Phase 12 task 12.5 -- deterministic (no API call) coverage for
 * previewMentionScan(), the dedup + mutation-shaping step. proposeMentionedEntities's
 * OWN output quality is covered by graph-import/scan-mentions.smoke.mjs (a
 * real API call, per gm-tools-conventions' LLM-dependent-code testing
 * split), same as writeup-import.mjs's own test/smoke split -- but Phase
 * 37.6 task 4's own prompt-plumbing (does the source entity's real graph
 * neighborhood actually reach the prompt?) is deterministic templating
 * logic, not model output quality, so it gets a real mocked-client test
 * below (the "texture-test precedent" the task's own QE section names).
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
        return { content: [{ type: "text", text: resp }], stop_reason: "end_turn" };
      }
    }
  };
}

const EXISTING_ENTITY_TYPES = [
  { id: "person", attributeDefs: [] },
  { id: "place", attributeDefs: [] },
  { id: "faction", attributeDefs: [] },
  { id: "object", attributeDefs: [] },
  { id: "event", attributeDefs: [] },
  { id: "concept", attributeDefs: [] }
];

function fixtureSnapshot() {
  return {
    entities: [
      { id: "gerdur-1", name: "Gerdur", type: "person", importance: 0.6, tags: [], attributes: {} },
      { id: "riverwood-1", name: "Riverwood", type: "place", importance: 0.8, tags: [], attributes: {} }
    ],
    edges: [],
    entityTypes: EXISTING_ENTITY_TYPES
  };
}

test("THE MIXED-INPUT TEST: a matched mention produces a LINK (edge-only), an unmatched one produces PROPOSE-NEW (entity+edge) -- reusing writeup-import's real dedup, not a second matcher", () => {
  const snapshot = fixtureSnapshot();
  const mentions = [
    { name: "Gerdur", type: "person", description: "The person who greeted them." }, // matches gerdur-1 by name+type
    { name: "Old Kellan", type: "person", description: "A gruff quartermaster." } // no match -- genuinely new
  ];
  const { mutations, linkCount, newCount } = previewMentionScan(mentions, "riverwood-1", snapshot);

  assert.equal(linkCount, 1);
  assert.equal(newCount, 1);

  const linkMutations = mutations.filter((m) => m.entityContext?.scanResultKind === "link");
  const newMutations = mutations.filter((m) => m.entityContext?.scanResultKind === "new");

  // LINK: exactly ONE mutation, an edge, no entity upsert at all.
  assert.equal(linkMutations.length, 1);
  assert.equal(linkMutations[0].op, "upsert_edge");
  assert.equal(linkMutations[0].data.sourceId, "riverwood-1");
  assert.equal(linkMutations[0].data.targetId, "gerdur-1", "must link to the REAL existing entity id, not create a duplicate");
  assert.equal(linkMutations[0].data.relationshipType, DEFAULT_MENTION_RELATIONSHIP);

  // PROPOSE-NEW: exactly TWO mutations, an entity create AND an edge to it -- a
  // structurally different shape from the link case above, not a relabeled copy.
  assert.equal(newMutations.length, 2);
  const createMutation = newMutations.find((m) => m.op === "upsert_entity");
  const edgeMutation = newMutations.find((m) => m.op === "upsert_edge");
  assert.ok(createMutation, "propose-new must include a real entity create");
  assert.ok(edgeMutation, "propose-new must also include an edge to the newly-created entity");
  assert.equal(createMutation.data.name, "Old Kellan");
  assert.equal(createMutation.data.type, "person");
  assert.equal(edgeMutation.data.sourceId, "riverwood-1");
  assert.equal(edgeMutation.data.targetId, createMutation.id, "the new edge must target the SAME id the create mutation produces");
});

test("dedup is case-insensitive and type-scoped, exactly matching importGraph's own findExisting behavior", () => {
  const snapshot = fixtureSnapshot();
  const mentions = [
    { name: "GERDUR", type: "person" }, // different case, same type -- should match
    { name: "Gerdur", type: "place" } // same name, DIFFERENT type -- should NOT match, treated as new
  ];
  const { mutations, linkCount, newCount } = previewMentionScan(mentions, "riverwood-1", snapshot);
  assert.equal(linkCount, 1);
  assert.equal(newCount, 1);
  const link = mutations.find((m) => m.entityContext?.scanResultKind === "link");
  assert.equal(link.data.targetId, "gerdur-1");
});

test("an empty mentions array produces no mutations at all, no crash", () => {
  const snapshot = fixtureSnapshot();
  const { mutations, linkCount, newCount } = previewMentionScan([], "riverwood-1", snapshot);
  assert.deepEqual(mutations, []);
  assert.equal(linkCount, 0);
  assert.equal(newCount, 0);
});

test("throws a clear error if the source entity itself doesn't exist in the live graph", () => {
  const snapshot = fixtureSnapshot();
  assert.throws(
    () => previewMentionScan([{ name: "X", type: "concept" }], "nonexistent-entity", snapshot),
    /No entity "nonexistent-entity"/
  );
});

test("every LINK/PROPOSE-NEW mutation carries sourceKind:'mention-scan' for auditability", () => {
  const snapshot = fixtureSnapshot();
  const mentions = [{ name: "Gerdur", type: "person" }, { name: "Old Kellan", type: "person" }];
  const { mutations } = previewMentionScan(mentions, "riverwood-1", snapshot);
  for (const m of mutations) assert.equal(m.sourceKind, "mention-scan");
});

test("multiple genuinely new mentions each get their own distinct entity + edge pair, all resolvable", () => {
  const snapshot = fixtureSnapshot();
  const mentions = [
    { name: "Old Kellan", type: "person", description: "A quartermaster." },
    { name: "The Sunken Bell", type: "place", description: "A tavern." }
  ];
  const { mutations, newCount } = previewMentionScan(mentions, "riverwood-1", snapshot);
  assert.equal(newCount, 2);
  const creates = mutations.filter((m) => m.op === "upsert_entity");
  const edgesOut = mutations.filter((m) => m.op === "upsert_edge");
  assert.equal(creates.length, 2);
  assert.equal(edgesOut.length, 2);
  const createIds = new Set(creates.map((m) => m.id));
  for (const e of edgesOut) {
    assert.equal(e.data.sourceId, "riverwood-1");
    assert.ok(createIds.has(e.data.targetId), "every edge must target one of the two real created ids, not a stale placeholder");
  }
  assert.equal(new Set(edgesOut.map((e) => e.data.targetId)).size, 2, "two distinct new entities must get two distinct edges, not collapsed into one");
});

// ---------------------------------------------------------------------------
// Phase 13 task 13.4: the lightweight deterministic pre-pass.
// ---------------------------------------------------------------------------

test("nameSimilarity: a dropped filler word scores well above threshold (token-overlap signal)", () => {
  const score = nameSimilarity("Gorrim Smith", "Gorrim the Smith");
  assert.ok(score >= FUZZY_MATCH_THRESHOLD, `expected >= ${FUZZY_MATCH_THRESHOLD}, got ${score}`);
});

test("nameSimilarity: a one-character spelling variant on a single-word name scores well above threshold (edit-distance signal)", () => {
  const score = nameSimilarity("Osrik", "Osric");
  assert.ok(score >= FUZZY_MATCH_THRESHOLD, `expected >= ${FUZZY_MATCH_THRESHOLD}, got ${score}`);
});

test("THE REQUIRED NEGATIVE CASE: two genuinely different but similarly-spelled single-word names score LOW, well under threshold", () => {
  const score = nameSimilarity("Kael", "Kaelen");
  assert.ok(score < FUZZY_MATCH_THRESHOLD, `expected < ${FUZZY_MATCH_THRESHOLD} (these must NOT be treated as a near-miss), got ${score}`);
});

test("nameSimilarity: two names sharing no tokens and not both single-word score 0, not a near-miss", () => {
  assert.equal(nameSimilarity("Gorrim the Smith", "Aela the Huntress"), 0);
});

test("findFuzzyEntityMatch: skips an EXACT match (that's findExisting's own job, not the pre-pass's)", () => {
  const existing = [{ id: "kael-1", name: "Kael", type: "person" }];
  assert.equal(findFuzzyEntityMatch("Kael", "person", existing), null);
});

test("findFuzzyEntityMatch: never matches across a DIFFERENT type, even with an identical name", () => {
  const existing = [{ id: "kael-place", name: "Kael", type: "place" }];
  assert.equal(findFuzzyEntityMatch("Kael", "person", existing), null);
});

test("findFuzzyEntityMatch: only the genuinely plausible candidate is returned, an implausible one alongside it is ignored", () => {
  const existing = [
    { id: "a", name: "Roderick", type: "person" }, // implausible -- must not qualify at all
    { id: "b", name: "Gorrim the Smith", type: "person" } // a real near-miss for "Gorrim Smith"
  ];
  const match = findFuzzyEntityMatch("Gorrim Smith", "person", existing);
  assert.ok(match);
  assert.equal(match.entity.id, "b");
});

test("findFuzzyEntityMatch: between two genuinely plausible candidates, the higher-scoring one wins", () => {
  // Both are one-edit-distance variants of the mention "Osrik", at
  // different similarity ratios: "Osric" differs at 1 of 5 positions
  // (1 - 1/5 = 0.8); "Osrikk" differs by one inserted char over 6
  // (1 - 1/6 = 0.833), the higher of the two.
  const candidates = [
    { id: "close", name: "Osric", type: "person" },
    { id: "closer", name: "Osrikk", type: "person" }
  ];
  const match = findFuzzyEntityMatch("Osrik", "person", candidates);
  assert.ok(match);
  assert.equal(match.entity.id, "closer", `expected the higher-scoring candidate to win; got ${JSON.stringify(match)}`);
});

test("applyFuzzyPrepass: THE POSITIVE CASE -- a deliberately-constructed near-miss the LLM's exact name+type dedup would miss becomes a LINK, not a create", () => {
  const snapshot = {
    entities: [
      { id: "riverwood-1", name: "Riverwood", type: "place", importance: 0.8 },
      { id: "gorrim-1", name: "Gorrim the Smith", type: "person", importance: 0.5 }
    ],
    edges: [],
    entityTypes: []
  };
  const mentions = [{ name: "Gorrim Smith", type: "person", description: "A blacksmith." }]; // missing "the" -- exact dedup alone would miss this
  const { mutations, linkCount, newCount } = previewMentionScan(mentions, "riverwood-1", snapshot);

  assert.equal(linkCount, 1, "the pre-pass must resolve this near-miss to a LINK");
  assert.equal(newCount, 0, "must NOT also propose a duplicate create");
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].op, "upsert_edge");
  assert.equal(mutations[0].data.targetId, "gorrim-1", "must link to the REAL existing entity, not a new one");
  assert.match(mutations[0].rationale, /name-similarity pre-pass/i, "the rationale should be honest that this came from the fuzzy pre-pass, not an exact match");
});

test("applyFuzzyPrepass: THE REQUIRED NEGATIVE CASE -- two genuinely different, similarly-named entities are NOT incorrectly merged", () => {
  const existingEntities = [{ id: "kael-1", name: "Kael", type: "person", importance: 0.5 }];
  const mentions = [{ name: "Kaelen", type: "person", description: "A completely different person who merely has a similar-sounding name." }];
  const prepassed = applyFuzzyPrepass(mentions, existingEntities);
  assert.equal(prepassed[0].name, "Kaelen", "the mention's name must be left UNCHANGED -- no false-positive rewrite to the existing entity's name");
  assert.equal(prepassed[0].fuzzyMatchedFrom, undefined);

  // End-to-end through previewMentionScan too: must genuinely propose Kaelen
  // as a NEW entity, not silently link it to Kael.
  const { mutations, linkCount, newCount } = previewMentionScan(mentions, "kael-1", {
    entities: existingEntities,
    edges: [],
    entityTypes: []
  });
  assert.equal(linkCount, 0);
  assert.equal(newCount, 1);
  const createMutation = mutations.find((m) => m.op === "upsert_entity");
  assert.equal(createMutation.data.name, "Kaelen", "a genuinely new, distinct entity must still be created -- not merged into Kael");
});

test("applyFuzzyPrepass: an already-exact match is left completely untouched (no interference with the existing exact-match path)", () => {
  const existingEntities = [{ id: "kael-1", name: "Kael", type: "person" }];
  const mentions = [{ name: "Kael", type: "person" }];
  const prepassed = applyFuzzyPrepass(mentions, existingEntities);
  assert.deepEqual(prepassed, mentions, "an exact match must pass through byte-identical -- the pre-pass has nothing to add here");
});

// Phase 37.6 task 4 (graph-context census): mocked-client, deterministic
// coverage of the NEW prompt-plumbing -- scan-mentions was context-free
// (only the raw scan text + the source entity's bare name/type ever reached
// the prompt); the source entity's own real graph neighborhood now grounds
// it too, via the shared buildAdjacencyContext (narrate.mjs).

test("renderNeighborhoodContext: no neighbors -> the honest fallback string", () => {
  assert.equal(renderNeighborhoodContext([]), "(no recorded graph connections)");
});

test("renderNeighborhoodContext: renders each neighbor description as its own bullet", () => {
  const out = renderNeighborhoodContext(["Gerdur (containment)", "Alvor (kinship)"]);
  assert.equal(out, "- Gerdur (containment)\n- Alvor (kinship)");
});

test("proposeMentionedEntities: opts.neighborhoodContext reaches the prompt; omitted falls back to the honest 'no connections' string", async () => {
  const client = mockClient([JSON.stringify({ mentions: [] })]);
  await proposeMentionedEntities("Some text.", { name: "Riverwood", type: "place" }, {
    client,
    neighborhoodContext: "- Gerdur (containment)"
  });
  assert.match(client.calls[0].messages[0].content, /- Gerdur \(containment\)/);

  const client2 = mockClient([JSON.stringify({ mentions: [] })]);
  await proposeMentionedEntities("Some text.", { name: "Riverwood", type: "place" }, { client: client2 });
  assert.match(client2.calls[0].messages[0].content, /no recorded graph connections/, "omitting it must not crash -- honest fallback, matching pre-task-4 callers");
});

test("scanForMentionedEntities: grounds the prompt in the REAL source entity's graph neighborhood pulled from the live snapshot", async () => {
  const client = mockClient([JSON.stringify({ mentions: [] })]);
  const snapshot = {
    entities: [
      { id: "riverwood-1", name: "Riverwood", type: "place", importance: 0.8, tags: [], attributes: {} },
      { id: "gerdur-1", name: "Gerdur", type: "person", importance: 0.6, tags: [], attributes: {} }
    ],
    edges: [{ id: "e1", sourceId: "gerdur-1", targetId: "riverwood-1", relationshipType: "containment" }],
    entityTypes: EXISTING_ENTITY_TYPES
  };
  await scanForMentionedEntities("scan-context-test-world", "riverwood-1", "Some prep content about the village.", snapshot, { llmOpts: { client } });
  assert.match(client.calls[0].messages[0].content, /Gerdur/, "riverwood-1's real graph neighbor (Gerdur) must ground the prompt");
});

await Promise.all(pending);
console.log(`\n${passed} test(s) passed.`);
