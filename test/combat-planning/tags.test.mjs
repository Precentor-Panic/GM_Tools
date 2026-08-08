import assert from "node:assert/strict";

/**
 * CONTRACT UNDER TEST — combat-planning/tags.mjs (Phase 35 task 35.1, §4 of
 * review-ui/test/e2e/phase35-fixture.mjs). PURE functions, no I/O.
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

const { addTag, removeTag, tagIndex, filterByTagsAnd } = await import("../../combat-planning/tags.mjs");

function records() {
  return [
    { id: "a", tags: ["loot", "magic"] },
    { id: "b", tags: ["loot"] },
    { id: "c", tags: [] }
  ];
}

// ------------------------------------------------------------- addTag

test("addTag: adds a trimmed tag to the matching record, returns a NEW array", () => {
  const before = records();
  const after = addTag(before, "c", "  new-tag  ");
  assert.notEqual(after, before, "must return a new array on a real change");
  assert.deepEqual(after.find((r) => r.id === "c").tags, ["new-tag"]);
  assert.deepEqual(before.find((r) => r.id === "c").tags, [], "the input array's own records must never be mutated in place");
});

test("addTag: no-op (SAME array reference) when the tag is empty/whitespace-only", () => {
  const before = records();
  assert.equal(addTag(before, "a", ""), before);
  assert.equal(addTag(before, "a", "   "), before);
});

test("addTag: no-op when the record already carries this exact (trimmed) tag", () => {
  const before = records();
  assert.equal(addTag(before, "a", "loot"), before);
  assert.equal(addTag(before, "a", "  loot  "), before, "trimmed comparison, not just exact string match");
});

test("addTag: no-op when the id isn't found", () => {
  const before = records();
  assert.equal(addTag(before, "no-such-id", "x"), before);
});

// ------------------------------------------------------------- removeTag

test("removeTag: removes the tag from the matching record, returns a NEW array", () => {
  const before = records();
  const after = removeTag(before, "a", "magic");
  assert.notEqual(after, before);
  assert.deepEqual(after.find((r) => r.id === "a").tags, ["loot"]);
});

test("removeTag: no-op when the record or the tag isn't present", () => {
  const before = records();
  assert.equal(removeTag(before, "no-such-id", "loot"), before);
  assert.equal(removeTag(before, "a", "no-such-tag"), before);
});

// ------------------------------------------------------------- tagIndex

test("tagIndex: every distinct tag mapped to its record count, untagged records contribute nothing", () => {
  assert.deepEqual(tagIndex(records()), { loot: 2, magic: 1 });
});

test("tagIndex: [] input -> {}", () => {
  assert.deepEqual(tagIndex([]), {});
});

// ------------------------------------------------------------- filterByTagsAnd

test("filterByTagsAnd: AND semantics -- a record must carry EVERY selected tag", () => {
  const filtered = filterByTagsAnd(records(), ["loot", "magic"]);
  assert.deepEqual(filtered.map((r) => r.id), ["a"]);
});

test("filterByTagsAnd: a single tag filter returns every record carrying it", () => {
  const filtered = filterByTagsAnd(records(), ["loot"]);
  assert.deepEqual(filtered.map((r) => r.id), ["a", "b"]);
});

test("filterByTagsAnd: empty/omitted tags[] is vacuously true -- the whole set passes through unchanged", () => {
  const all = records();
  assert.equal(filterByTagsAnd(all, []), all);
  assert.equal(filterByTagsAnd(all, undefined), all);
});

test("filterByTagsAnd: a tag no record carries returns []", () => {
  assert.deepEqual(filterByTagsAnd(records(), ["nonexistent"]), []);
});

console.log(`\n${passed} passed`);
