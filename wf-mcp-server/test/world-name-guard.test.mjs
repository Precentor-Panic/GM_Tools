import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Friction Wave 1, W5c — the world-name guard (mutation-ops.mjs's
// worldNameCollisionsForBatch): a NON-blocking, read-time advisory for any
// pending entity mutation named exactly like the world id/name
// (case-insensitive). The real trigger: world `kilmarn` + place "Kilmarn" —
// innocent, but ambiguous enough that Russell's live diagnosis of the W5a
// containment bug detoured through it.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-w5c-guard-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = scratchDir;

const { worldNameCollisionsForBatch } = await import("../lib/mutation-ops.mjs");

function m(extra) {
  return { rationale: "r", batchId: "b", sourceKind: "writeup-import", status: "pending", ...extra };
}

test("W5c: a pending create named exactly like the world is flagged, case-insensitively", () => {
  const batch = {
    mutations: [
      m({ mutationId: "m0", op: "upsert_entity", data: { name: "Kilmarn", type: "place" } }),
      m({ mutationId: "m1", op: "upsert_entity", data: { name: "The Underbreach", type: "place" } }),
      m({ mutationId: "m2", op: "upsert_edge", data: { sourceId: "a", targetId: "b", relationshipType: "containment" } })
    ]
  };
  const result = worldNameCollisionsForBatch(batch, "kilmarn");
  assert.deepEqual(Object.keys(result), ["m0"]);
  assert.equal(result.m0.name, "Kilmarn");
});

test("W5c: settled rows, no-name updates and a blank world produce no flags", () => {
  const batch = {
    mutations: [
      m({ mutationId: "m0", op: "upsert_entity", data: { name: "Kilmarn", type: "place" }, status: "accepted" }),
      m({ mutationId: "m1", op: "upsert_entity", id: "x", data: { description: "no name field on an update" } })
    ]
  };
  assert.deepEqual(worldNameCollisionsForBatch(batch, "kilmarn"), {});
  assert.deepEqual(worldNameCollisionsForBatch({ mutations: [m({ mutationId: "m2", op: "upsert_entity", data: { name: "Kilmarn" } })] }, ""), {});
});

test("W5c: a nameless update targeting a same-named entity is caught via entityContext.name", () => {
  const batch = {
    mutations: [
      m({ mutationId: "m0", op: "upsert_entity", id: "wf_x", data: { description: "new text" }, entityContext: { name: "KILMARN" } })
    ]
  };
  const result = worldNameCollisionsForBatch(batch, "kilmarn");
  assert.equal(result.m0.name, "KILMARN");
});
