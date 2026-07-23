import assert from "node:assert/strict";
import { diffEntity, diffEdge } from "../mutation-engine/diff.mjs";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.message);
    process.exitCode = 1;
  }
}

// --------------------------------------------------------------- diffEntity

const baseEntity = {
  id: "e1",
  name: "Riverwood",
  type: "place",
  description: "A quiet village.",
  summary: "A quiet village on the river.",
  importance: 0.5,
  imageUrl: null,
  tags: ["village"],
  attributes: { population: 200 },
  foundryRef: null,
  namespace: "campaign",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

test("diffEntity: changed fields produce {field, from, to} entries", () => {
  const after = { ...baseEntity, importance: 0.7, description: "A burned-out village." };
  const changes = diffEntity(baseEntity, after);
  assert.equal(changes.length, 2);
  const byField = Object.fromEntries(changes.map((c) => [c.field, c]));
  assert.deepEqual(byField.importance, { field: "importance", from: 0.5, to: 0.7 });
  assert.deepEqual(byField.description, { field: "description", from: "A quiet village.", to: "A burned-out village." });
});

test("diffEntity: no-change case returns []", () => {
  const after = { ...baseEntity };
  assert.deepEqual(diffEntity(baseEntity, after), []);
});

test("diffEntity: id/createdAt/updatedAt changes are excluded even if different", () => {
  const after = { ...baseEntity, id: "e1-renamed", createdAt: "later", updatedAt: "later" };
  assert.deepEqual(diffEntity(baseEntity, after), []);
});

test("diffEntity: before === null produces a single (created) marker", () => {
  const after = { ...baseEntity };
  const changes = diffEntity(null, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, "(created)");
  assert.equal(changes[0].from, null);
  assert.deepEqual(changes[0].to, after);
});

test("diffEntity: array field (tags) changes are detected by value, not reference", () => {
  const after = { ...baseEntity, tags: ["village"] }; // same contents, new array instance
  assert.deepEqual(diffEntity(baseEntity, after), []);
  const changed = { ...baseEntity, tags: ["village", "pin-review"] };
  const changes = diffEntity(baseEntity, changed);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, "tags");
});

test("diffEntity: nested object field (attributes) changes are detected by value", () => {
  const after = { ...baseEntity, attributes: { population: 250 } };
  const changes = diffEntity(baseEntity, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, "attributes");
  assert.deepEqual(changes[0].from, { population: 200 });
  assert.deepEqual(changes[0].to, { population: 250 });
});

// ----------------------------------------------------------------- diffEdge

const baseEdge = {
  id: "edge1",
  sourceId: "a",
  targetId: "b",
  relationshipType: "social",
  label: "knows",
  strength: 0.6,
  valence: "neutral",
  notes: null
};

test("diffEdge: changed fields produce {field, from, to} entries", () => {
  const after = { ...baseEdge, strength: 0.3, valence: "negative" };
  const changes = diffEdge(baseEdge, after);
  assert.equal(changes.length, 2);
  const byField = Object.fromEntries(changes.map((c) => [c.field, c]));
  assert.deepEqual(byField.strength, { field: "strength", from: 0.6, to: 0.3 });
  assert.deepEqual(byField.valence, { field: "valence", from: "neutral", to: "negative" });
});

test("diffEdge: no-change case returns []", () => {
  assert.deepEqual(diffEdge(baseEdge, { ...baseEdge }), []);
});

test("diffEdge: sourceId/targetId changes are excluded (not in the diffed field set)", () => {
  const after = { ...baseEdge, sourceId: "z" };
  assert.deepEqual(diffEdge(baseEdge, after), []);
});

test("diffEdge: before === null produces a single (created) marker", () => {
  const changes = diffEdge(null, baseEdge);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, "(created)");
  assert.equal(changes[0].from, null);
  assert.deepEqual(changes[0].to, baseEdge);
});

console.log(`\n${passed} passed`);
