import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Friction Wave 1, W1e -- deterministic triage tags. Pure-function tests
 * over deriveTriageTag/triageForBatch (no fs, no server): the four tags in
 * priority order, the diff-shrink "fights canon" heuristic (replace vs.
 * append), and the severity-merge rule for the effective risk.
 */
const { deriveTriageTag, triageForBatch } = await import("../lib/mutation-ops.mjs");

const CREATED_DIFF = [{ field: "(created)", from: null, to: { name: "X" } }];

function m(extra) {
  return { mutationId: "m0", status: "pending", rationale: "r", batchId: "b", sourceKind: "writeup-import", ...extra };
}

test("W1e: a CREATE with a near match is 'possible-duplicate'; without one, 'low-risk'", () => {
  const create = m({ op: "upsert_entity", id: "wf_new", data: { name: "Master Vane" }, diff: CREATED_DIFF });
  assert.equal(deriveTriageTag(create, [{ entityId: "vane" }]), "possible-duplicate");
  assert.equal(deriveTriageTag(create, []), "low-risk");
});

test("W1e: an update REPLACING nonempty text is 'fights-canon'; a genuine append is 'low-risk'", () => {
  const replace = m({
    op: "upsert_entity", id: "vane",
    diff: [{ field: "description", from: "Guildmaster of the weavers.", to: "A sinister thread-mage." }]
  });
  assert.equal(deriveTriageTag(replace), "fights-canon");

  const append = m({
    op: "upsert_entity", id: "vane",
    diff: [{ field: "description", from: "Guildmaster of the weavers.", to: "Guildmaster of the weavers. Also placed the fate-threads." }]
  });
  assert.equal(deriveTriageTag(append), "low-risk");

  const fillEmpty = m({
    op: "upsert_entity", id: "vane",
    diff: [{ field: "summary", from: "", to: "Fresh text where none existed." }]
  });
  assert.equal(deriveTriageTag(fillEmpty), "low-risk");
});

test("W1e: shrink counts as replace even when some words survive", () => {
  const shrink = m({
    op: "upsert_entity", id: "vane",
    diff: [{ field: "description", from: "Guildmaster of the weavers, keeper of the seal.", to: "Guildmaster." }]
  });
  assert.equal(deriveTriageTag(shrink), "fights-canon");
});

test("W1e: a brand-new edge is 'low-risk'; deletes and edge edits are 'needs-review'", () => {
  assert.equal(deriveTriageTag(m({ op: "upsert_edge", id: "e0", data: { sourceId: "a", targetId: "b" }, diff: CREATED_DIFF })), "low-risk");
  assert.equal(deriveTriageTag(m({ op: "delete_entity", id: "vane" })), "needs-review");
  assert.equal(deriveTriageTag(m({ op: "upsert_edge", id: "e0", diff: [{ field: "strength", from: 0.4, to: 0.9 }] })), "needs-review");
});

test("W1e: an update touching non-text fields is 'needs-review', not silently 'low-risk'", () => {
  const nonText = m({
    op: "upsert_entity", id: "vane",
    diff: [{ field: "importance", from: 0.5, to: 0.9 }]
  });
  assert.equal(deriveTriageTag(nonText), "needs-review");
});

test("W1e: triageForBatch severity-merges stamped risk with the triage-derived one (upgrade only)", () => {
  const batch = {
    mutations: [
      // stamped 'safe' by attachDiffs' impact heuristic, but a destructive
      // text replace -- triage upgrades the effective risk to 'contradict'.
      m({ mutationId: "m0", op: "upsert_entity", id: "vane", risk: "safe", diff: [{ field: "description", from: "Old lore.", to: "New unrelated lore." }] }),
      // stamped 'contradict' (flagged entity), triage says low-risk append --
      // NEVER downgraded.
      m({ mutationId: "m1", op: "upsert_entity", id: "vane", risk: "contradict", diff: [{ field: "description", from: "Old.", to: "Old. More." }] }),
      // no stamped risk at all (pre-Phase-37 batch, the Kilmarn case) --
      // the triage-derived risk fills in.
      m({ mutationId: "m2", op: "upsert_entity", id: "wf_new", data: { name: "Master Vane" }, diff: CREATED_DIFF })
    ]
  };
  const result = triageForBatch(batch, { m2: [{ entityId: "vane" }] });
  assert.deepEqual(result.m0, { triage: "fights-canon", risk: "contradict" });
  assert.deepEqual(result.m1, { triage: "low-risk", risk: "contradict" });
  assert.deepEqual(result.m2, { triage: "possible-duplicate", risk: "look" });
});
