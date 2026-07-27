import assert from "node:assert/strict";
import { previewMentionScan, DEFAULT_MENTION_RELATIONSHIP } from "../graph-import/scan-mentions.mjs";

/**
 * Phase 12 task 12.5 -- deterministic (no API call) coverage for
 * previewMentionScan(), the dedup + mutation-shaping step. proposeMentionedEntities
 * itself (the LLM call) is covered by graph-import/scan-mentions.smoke.mjs
 * (a real API call, per gm-tools-conventions' LLM-dependent-code testing
 * split), same as writeup-import.mjs's own test/smoke split.
 */

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
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

console.log(`\n${passed} test(s) passed.`);
