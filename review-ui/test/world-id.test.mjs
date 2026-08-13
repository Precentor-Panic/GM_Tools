import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * QA W2 fix (Group C #14) — pin for the shared client-side world-id
 * validation/slugify helper (review-ui/public/world-id.js), used by both
 * connection-menu.js's create-world panel and app-shell.js's zero-worlds
 * landing CTA. The bug: creating "My First Campaign" used to round-trip to a
 * server 400 mentioning "directory names" with zero client-side guidance.
 */
const { isValidWorldId, slugifyWorldId, VALID_WORLD_ID } = await import("../public/world-id.js");

test("isValidWorldId: accepts lowercase letters, digits, hyphens, underscores", () => {
  assert.equal(isValidWorldId("wf-test"), true);
  assert.equal(isValidWorldId("rl_combat_2"), true);
  assert.equal(isValidWorldId("a1"), true);
});

test("isValidWorldId: rejects spaces, uppercase, punctuation, and empty/non-string input", () => {
  assert.equal(isValidWorldId("My First Campaign"), false);
  assert.equal(isValidWorldId("Campaign!"), false);
  assert.equal(isValidWorldId(""), false);
  assert.equal(isValidWorldId(null), false);
  assert.equal(isValidWorldId(undefined), false);
});

test("slugifyWorldId: \"My First Campaign\" becomes \"my-first-campaign\"", () => {
  assert.equal(slugifyWorldId("My First Campaign"), "my-first-campaign");
});

test("slugifyWorldId: collapses runs of invalid characters into one hyphen, trims leading/trailing hyphens", () => {
  assert.equal(slugifyWorldId("  Curse of the -- Sunken City!!  "), "curse-of-the-sunken-city");
});

test("slugifyWorldId: preserves existing hyphens/underscores/digits verbatim", () => {
  assert.equal(slugifyWorldId("wf-test_2"), "wf-test_2");
});

test("slugifyWorldId output is always itself a valid world id (round-trip guarantee)", () => {
  for (const raw of ["My First Campaign", "  ??? ", "Curse of the Sunken City", "wf-test"]) {
    const slug = slugifyWorldId(raw);
    if (slug) assert.ok(VALID_WORLD_ID.test(slug), `slug "${slug}" (from "${raw}") must itself be valid`);
  }
});
