import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate both review-state.mjs (human-review.mjs reuses its withLock) and
// human-review.mjs's own root before importing either.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-human-review-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");

const {
  markHumanReviewed,
  recordUnreviewedAccept,
  getHumanReviewState,
  findUnreviewedEntities,
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_MAX_UNREVIEWED_ACCEPTS
} = await import("../mutation-engine/human-review.mjs");

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

const WORLD = "wf-test";

// ------------------------------------------------------------------- basics

test("getHumanReviewState: an untracked entity defaults to never-reviewed, zero unreviewed accepts", () => {
  const state = getHumanReviewState(WORLD, "never-touched");
  assert.deepEqual(state, { lastHumanReviewedAt: null, unreviewedAcceptCount: 0 });
});

test("markHumanReviewed: sets lastHumanReviewedAt and resets unreviewedAcceptCount to 0", () => {
  const entity = "alvor";
  recordUnreviewedAccept(WORLD, [entity]);
  recordUnreviewedAccept(WORLD, [entity]);
  assert.equal(getHumanReviewState(WORLD, entity).unreviewedAcceptCount, 2, "sanity: two unreviewed accepts recorded first");

  markHumanReviewed(WORLD, [entity], { now: "2026-01-01T00:00:00.000Z" });
  const state = getHumanReviewState(WORLD, entity);
  assert.equal(state.lastHumanReviewedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(state.unreviewedAcceptCount, 0, "a genuine review resets the accumulated-accept counter");
});

test("recordUnreviewedAccept: increments the counter without ever touching lastHumanReviewedAt", () => {
  const entity = "gerdur";
  assert.equal(getHumanReviewState(WORLD, entity).lastHumanReviewedAt, null);

  recordUnreviewedAccept(WORLD, [entity]);
  recordUnreviewedAccept(WORLD, [entity]);
  recordUnreviewedAccept(WORLD, [entity]);

  const state = getHumanReviewState(WORLD, entity);
  assert.equal(state.unreviewedAcceptCount, 3);
  assert.equal(state.lastHumanReviewedAt, null, "still never actually reviewed -- only auto-accepted");
});

test("markHumanReviewed / recordUnreviewedAccept: silently skip falsy entity ids (e.g. an id-less create)", () => {
  assert.doesNotThrow(() => markHumanReviewed(WORLD, [null, undefined, ""]));
  assert.doesNotThrow(() => recordUnreviewedAccept(WORLD, [null, undefined, ""]));
});

// --------------------------------------------- the core distinction (4.2's point)

test("THE CORE DISTINCTION: batch-accept-all does NOT count as review -- lastHumanReviewedAt stays null, only the count moves", () => {
  const entity = "riverwood";
  assert.equal(getHumanReviewState(WORLD, entity).lastHumanReviewedAt, null, "precondition: never reviewed");

  // Simulate a batch-scope accept-all touching this entity, repeatedly,
  // with NO individual review action ever happening in between.
  recordUnreviewedAccept(WORLD, [entity]);
  recordUnreviewedAccept(WORLD, [entity]);
  recordUnreviewedAccept(WORLD, [entity]);
  recordUnreviewedAccept(WORLD, [entity]);

  const state = getHumanReviewState(WORLD, entity);
  assert.equal(state.lastHumanReviewedAt, null, "batch-accept-all must NEVER set lastHumanReviewedAt, no matter how many times it happens");
  assert.equal(state.unreviewedAcceptCount, 4, "but the accumulation counter DOES move -- this is the debt the feature tracks");
});

test("an individual/scoped review action DOES update lastHumanReviewedAt (the positive case)", () => {
  const entity = "sven";
  recordUnreviewedAccept(WORLD, [entity]);
  assert.equal(getHumanReviewState(WORLD, entity).lastHumanReviewedAt, null);

  markHumanReviewed(WORLD, [entity], { now: "2026-03-01T00:00:00.000Z" });

  const state = getHumanReviewState(WORLD, entity);
  assert.equal(state.lastHumanReviewedAt, "2026-03-01T00:00:00.000Z");
  assert.equal(state.unreviewedAcceptCount, 0);
});

// -------------------------------------------------------------------- query

test("findUnreviewedEntities: finds an entity seeded with an old lastHumanReviewedAt, excludes a recently-reviewed one", () => {
  markHumanReviewed(WORLD, ["old-entity"], { now: "2020-01-01T00:00:00.000Z" });
  markHumanReviewed(WORLD, ["fresh-entity"], { now: "2026-07-20T00:00:00.000Z" });

  const flagged = findUnreviewedEntities(WORLD, { now: "2026-07-25T00:00:00.000Z" });
  const flaggedIds = flagged.map((f) => f.entityId);

  assert.ok(flaggedIds.includes("old-entity"), "an entity last reviewed years ago must be surfaced");
  assert.ok(!flaggedIds.includes("fresh-entity"), "an entity reviewed 5 days ago (well under the default threshold) must be excluded");

  const oldEntry = flagged.find((f) => f.entityId === "old-entity");
  assert.equal(oldEntry.reason, "stale");
});

test("findUnreviewedEntities: an entity that was never reviewed at all (only accepted) is flagged with reason 'never-reviewed'", () => {
  recordUnreviewedAccept(WORLD, ["never-reviewed-entity"]);

  const flagged = findUnreviewedEntities(WORLD, { now: "2026-07-25T00:00:00.000Z" });
  const entry = flagged.find((f) => f.entityId === "never-reviewed-entity");
  assert.ok(entry, "should be flagged");
  assert.equal(entry.reason, "never-reviewed");
});

test("findUnreviewedEntities: an entity with a recent review but a high accumulated unreviewed-accept count is flagged with reason 'accumulated'", () => {
  const entity = "accumulating-entity";
  markHumanReviewed(WORLD, [entity], { now: "2026-07-24T00:00:00.000Z" }); // reviewed yesterday -- not stale
  for (let i = 0; i < DEFAULT_MAX_UNREVIEWED_ACCEPTS; i++) recordUnreviewedAccept(WORLD, [entity]);

  const flagged = findUnreviewedEntities(WORLD, { now: "2026-07-25T00:00:00.000Z" });
  const entry = flagged.find((f) => f.entityId === entity);
  assert.ok(entry, "high accept-count since last review should be flagged even though the review itself was recent");
  assert.equal(entry.reason, "accumulated");
});

test("findUnreviewedEntities: an entity untouched by either primitive is never flagged -- no history to speak of", () => {
  const flagged = findUnreviewedEntities(WORLD, { now: "2026-07-25T00:00:00.000Z" });
  assert.ok(!flagged.some((f) => f.entityId === "completely-untracked-entity"));
});

test("findUnreviewedEntities: thresholds are configurable, not hardcoded", () => {
  const entity = "custom-threshold-entity";
  markHumanReviewed(WORLD, [entity], { now: "2026-07-20T00:00:00.000Z" }); // 5 days before 'now' below

  const withDefault = findUnreviewedEntities(WORLD, { now: "2026-07-25T00:00:00.000Z" });
  assert.ok(!withDefault.some((f) => f.entityId === entity), `5 days should be under the default (${DEFAULT_MAX_AGE_DAYS} days)`);

  const withTightWindow = findUnreviewedEntities(WORLD, { now: "2026-07-25T00:00:00.000Z", maxAgeDays: 3 });
  assert.ok(withTightWindow.some((f) => f.entityId === entity), "a caller-supplied 3-day window should flag the same 5-day-old review");
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
