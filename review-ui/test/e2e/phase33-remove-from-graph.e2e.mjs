// Phase 33 task 33.0 -- QE-first e2e contract for Part B of the design record
// (`.claude/plans/ok-i-m-back-with-dazzling-newt.md`): a "Remove from graph"
// action in the World node inspector, recycling the dead `wv-inspector-
// openfull` span slot (`world-view.js:760`).
//
// ===========================================================================
// RETIRED-AS-SUPERSEDED (Phase 34 task 34.0): the five UI-level tests this
// file originally carried are REMOVED here, in the same commit as
// phase34-delta-fixes.e2e.mjs's own D5-D8 tests, which are their direct
// replacement -- NOT a coverage gap. What was retired and why:
//
//   1. '...renders a "Remove from graph" button...' -- superseded VERBATIM
//      (the button/testid/slot are UNCHANGED by the hybrid; phase34-delta-
//      fixes.e2e.mjs's own D5-D8 tests re-locate the SAME
//      `[data-testid="world-remove-from-graph-btn"]` and exercise it, so
//      re-asserting bare presence here would be pure duplication).
//   2. '...opens a guarded confirm panel warning the REAL cascade-edge
//      count...' -- superseded BEHAVIORALLY. Russell's locked HYBRID
//      decision (plans/phase-34-tasks.md's "Settled decisions") replaces the
//      SEPARATE `[data-testid="world-remove-from-graph-confirm-panel"]` this
//      test asserted with an IN-PLACE two-click arm (no second panel
//      element at all) -- the panel testid this test locates no longer
//      exists in the new contract, so keeping this test would either fail
//      forever (a copy of "the old spec was true") or need to be gutted into
//      the new one, which is exactly what phase34-delta-fixes.e2e.mjs's
//      "nonzero case" test now does, asserting the NEW consequence-line
//      contract instead.
//   3. '"Cancel" in the confirm panel closes it...' -- superseded. There is
//      no separate confirm panel/Cancel button in the hybrid design; its
//      replacement is phase34-delta-fixes.e2e.mjs's "clicking elsewhere...
//      DISARMS" test (click-elsewhere is the hybrid's own disarm gesture,
//      per Russell's locked decision text).
//   4. '...checkbox OFF deletes the node... children become roots...' --
//      superseded BEHAVIORALLY, and the OLD assertion is now actively WRONG:
//      Phase 33's `deleteNodeOp` made every child of the deleted node a NEW
//      ROOT (no reparent). The Phase 34 hybrid's entire point is that
//      children REPARENT UP to the grandparent instead -- a real behavior
//      CHANGE, not just a UI reskin. Replacement:
//      phase34-delta-fixes.e2e.mjs's "second click EXECUTES -- children
//      reparent to the GRANDPARENT" test, which asserts the NEW (correct)
//      topology.
//   5. '...checkbox ON... strips... from all N scenes...' -- superseded
//      UI-path only (the opt-in cleanup call itself -- `POST .../
//      remove-from-scenes`, test 6 below -- is UNCHANGED and still tested).
//      Replacement: phase34-delta-fixes.e2e.mjs's "checkbox ON also strips
//      the node's scene references" test, driving the SAME route through the
//      NEW in-place-arm UI path instead of the old confirm panel.
//
// Test 6 below (route-level, `POST /api/graph/nodes/:entityId/
// remove-from-scenes`) is KEPT UNCHANGED -- per plans/phase-34-tasks.md's own
// pre-specified route contract, "The existing remove-from-scenes route is
// reused unchanged for the opt-in," so its own pin has no reason to move.
//
// See phase34-fixture.mjs §6 for the full NEW hybrid contract these tests
// were replaced by, and phase-34-adoption.md for the design-record grounding
// (the HYBRID decision itself).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {
  setupPhase30Env,
  cleanupScratchEnv
} from "./phase30-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-p33b-");
const WORLD = "e2e-p33b-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "p33b-root", name: "The Salt Cistern", type: "place", importance: 0.6 } },
  { op: "upsert_entity", data: { id: "p33b-node", name: "Corwin Ashgrave", type: "person", importance: 0.4 } },
  { op: "upsert_entity", data: { id: "p33b-friend", name: "Wren Voss", type: "person", importance: 0.3 } },
  { op: "upsert_edge", data: { id: "p33b-e-node-root", sourceId: "p33b-node", targetId: "p33b-root", relationshipType: "containment" } },
  { op: "upsert_edge", data: { id: "p33b-e-node-friend", sourceId: "p33b-node", targetId: "p33b-friend", relationshipType: "ally" } }
]);

let server, base;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

// ---------------------------------------------------------------------------
// 6. Route-level: pins the route the opt-in cleanup needs -- UNCHANGED by
//    Phase 34 (reused verbatim by the new hybrid's checkbox-ON path).
// ---------------------------------------------------------------------------
test("route-level: POST /api/graph/nodes/:entityId/remove-from-scenes (the removeEntityFromAllScenes op) is genuinely wired -- returns the {removedElements, unanchoredScenes} summary, not a 404 'no route'", async () => {
  const res = await fetch(`${base}/api/graph/nodes/${encodeURIComponent("p33b-node")}/remove-from-scenes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD })
  });
  const body = await res.json().catch(() => null);
  assert.notEqual(res.status, 404, `the remove-from-scenes route must still be wired -- a 404 would mean it regressed. Got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(res.status, 200, `expected 200 from the wired removeEntityFromAllScenes route, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(typeof body?.removedElements, "number", "the route returns removeEntityFromAllScenes's summary with a numeric removedElements");
  assert.equal(typeof body?.unanchoredScenes, "number", "the route returns removeEntityFromAllScenes's summary with a numeric unanchoredScenes");
});
