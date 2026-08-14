import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Friction Wave 1, W5a — containment-cycle detection in the World tab's tree
 * builder (review-ui/public/world-tree.mjs, extracted DOM-free from
 * world-view.js precisely so this file can pin it under plain Node).
 *
 * REGRESSION FIXTURE: the exact Kilmarn <-> The Underbreach disappearance
 * from the 2026-08-14 friction log. The stage-1 writeup-import emitted
 * "Kilmarn has five quarters" edges INVERTED (Kilmarn -> quarter, semantic
 * "contains"); a later import added the correctly-directed The Underbreach
 * -> Kilmarn edge, closing a containment cycle. Under the pre-fix builder
 * (no cycle handling), neither Kilmarn nor the Underbreach is a root and no
 * walk from the roots ever reaches them — both silently vanish from "Where
 * things are", along with everything underneath.
 *
 * VERIFIED AGAINST THE PRE-FIX BUILDER: with detectAndBreakCycles disabled
 * (returning an empty map, i.e. the exact pre-W5a derivation), the
 * "cycle members must still be reachable" assertions below fail with
 * kilmarn/underbreach missing from the walk — reproduced before the fix was
 * kept, per the wave's regression-test bar.
 */
const { buildDerived, LOYALTY_PARENT_EDGE } = await import("../public/world-tree.mjs");

// The reachable-row walk world-view.js's visibleRows() performs: roots, then
// children, transitively. What this returns is literally "what the tree can
// ever render".
function reachableIds(derived) {
  const roots = [...derived.nodesById.keys()].filter((id) => {
    const p = derived.parentOf.get(id);
    return !(p != null && derived.nodesById.has(p));
  });
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const kid of derived.childrenOf.get(id) || []) {
      if (derived.nodesById.has(kid)) walk(kid);
    }
  };
  for (const r of roots) walk(r);
  return seen;
}

// The pre-fix cyclic fixture, reconstructed per the friction log: two
// opposite containment edges between two places (the inverted "Kilmarn has
// quarters" edge + the later, correct Underbreach -> Kilmarn edge), plus a
// child hanging under the cycle ("disappearing everything underneath").
const KILMARN_CYCLE_GRAPH = {
  nodes: [
    { id: "kilmarn", name: "Kilmarn", type: "place" },
    { id: "underbreach", name: "The Underbreach", type: "place" },
    { id: "charter", name: "Founding Charter", type: "object" },
    { id: "span", name: "The Span", type: "place" }
  ],
  edges: [
    // INVERTED: "Kilmarn has quarters" extracted as Kilmarn -> Underbreach.
    { id: "e-bad", sourceId: "kilmarn", targetId: "underbreach", relationshipType: "containment" },
    // Correct: the Underbreach is a quarter of Kilmarn.
    { id: "e-good", sourceId: "underbreach", targetId: "kilmarn", relationshipType: "containment" },
    // Hangs under the cycle — vanished along with it pre-fix.
    { id: "e-charter", sourceId: "charter", targetId: "underbreach", relationshipType: "containment" },
    // A healthy sibling root, untouched by any of this.
    { id: "e-unrelated", sourceId: "span", targetId: "missing-parent", relationshipType: "containment" }
  ]
};

test("W5a regression: the Kilmarn↔Underbreach containment cycle renders instead of silently vanishing", () => {
  const derived = buildDerived(KILMARN_CYCLE_GRAPH);
  const reachable = reachableIds(derived);

  // Pre-fix, these three assertions fail: kilmarn + underbreach hang off no
  // root and charter hangs under them.
  assert.ok(reachable.has("kilmarn"), "Kilmarn must be reachable from the roots");
  assert.ok(reachable.has("underbreach"), "The Underbreach must be reachable from the roots");
  assert.ok(reachable.has("charter"), "everything underneath the cycle must render too");
  assert.ok(reachable.has("span"), "healthy nodes unaffected");
  assert.equal(reachable.size, 4, "NOTHING vanishes");
});

test("W5a: the cycle is broken at a deterministic representative that carries the naming metadata for the badge", () => {
  const derived = buildDerived(KILMARN_CYCLE_GRAPH);

  // Representative: first cycle member by case-insensitive name — "Kilmarn"
  // beats "The Underbreach", so Kilmarn roots the branch (the natural read).
  assert.equal(derived.cycleBreaks.size, 1);
  assert.ok(derived.cycleBreaks.has("kilmarn"), "Kilmarn is the cycle's representative root");
  const info = derived.cycleBreaks.get("kilmarn");
  assert.deepEqual(new Set(info.memberIds), new Set(["kilmarn", "underbreach"]));
  assert.equal(info.memberIds[0], "kilmarn", "the representative leads the member list");
  assert.deepEqual(info.memberNames, ["Kilmarn", "The Underbreach"], "names, not ids, for the badge");

  // The break is in the DERIVED maps only: Kilmarn became a root, the
  // Underbreach stays its child.
  assert.equal(derived.parentOf.get("kilmarn"), undefined, "the representative's parent link is removed");
  assert.equal(derived.parentOf.get("underbreach"), "kilmarn", "the rest of the cycle chains under it");
  assert.ok(!(derived.childrenOf.get("underbreach") || []).includes("kilmarn"),
    "the representative is no longer listed among its former parent's children");
});

test("W5a: a longer cycle (3 members) breaks once, keeps the chain, and non-members are untouched", () => {
  const graph = {
    nodes: [
      { id: "a", name: "Alpha", type: "place" },
      { id: "b", name: "Beta", type: "place" },
      { id: "c", name: "Gamma", type: "place" },
      { id: "leaf", name: "Leaf", type: "object" }
    ],
    edges: [
      { id: "e1", sourceId: "a", targetId: "b", relationshipType: "containment" },
      { id: "e2", sourceId: "b", targetId: "c", relationshipType: "containment" },
      { id: "e3", sourceId: "c", targetId: "a", relationshipType: "containment" },
      { id: "e4", sourceId: "leaf", targetId: "b", relationshipType: "containment" }
    ]
  };
  const derived = buildDerived(graph);
  assert.equal(derived.cycleBreaks.size, 1);
  assert.ok(derived.cycleBreaks.has("a"), "Alpha (first by name) is the representative");
  const reachable = reachableIds(derived);
  assert.equal(reachable.size, 4, "all four nodes render");
  // Exactly one parent link was cut — the other two cycle edges still chain.
  assert.equal(derived.parentOf.get("a"), undefined);
  assert.equal(derived.parentOf.get("b"), "c");
  assert.equal(derived.parentOf.get("c"), "a");
});

test("W5a: an acyclic graph derives byte-identically to the pre-fix behavior — empty cycleBreaks, same maps", () => {
  const graph = {
    nodes: [
      { id: "city", name: "City", type: "place" },
      { id: "gate", name: "Gate", type: "object" },
      { id: "guard", name: "Guard", type: "person" }
    ],
    edges: [
      { id: "e1", sourceId: "gate", targetId: "city", relationshipType: "containment" },
      { id: "e2", sourceId: "guard", targetId: "gate", relationshipType: "containment" },
      { id: "e3", sourceId: "guard", targetId: "city", relationshipType: "presence" }
    ]
  };
  const derived = buildDerived(graph);
  assert.equal(derived.cycleBreaks.size, 0);
  assert.equal(derived.parentOf.get("gate"), "city");
  assert.equal(derived.parentOf.get("guard"), "gate");
  assert.deepEqual(derived.childrenOf.get("city"), ["gate"]);
  assert.equal(derived.nonContainment.length, 1);
});

test("W5a: the Loyalty derivation inherits the same cycle protection", () => {
  const graph = {
    nodes: [
      { id: "h1", name: "House Marr", type: "faction" },
      { id: "h2", name: "House Tolvi", type: "faction" }
    ],
    edges: [
      { id: "e1", sourceId: "h1", targetId: "h2", relationshipType: "fealty" },
      { id: "e2", sourceId: "h2", targetId: "h1", relationshipType: "membership" }
    ]
  };
  const derived = buildDerived(graph, LOYALTY_PARENT_EDGE);
  assert.equal(derived.cycleBreaks.size, 1);
  const reachable = reachableIds(derived);
  assert.equal(reachable.size, 2, "both mutually-sworn factions still render in the Loyalty tree");
});

test("W5a: single-parent most-recent-wins is unchanged (updatedAt beats array order; ties go last-in-array)", () => {
  const graph = {
    nodes: [
      { id: "x", name: "X", type: "object" },
      { id: "p1", name: "P1", type: "place" },
      { id: "p2", name: "P2", type: "place" }
    ],
    edges: [
      { id: "e1", sourceId: "x", targetId: "p1", relationshipType: "containment", updatedAt: "2026-02-01T00:00:00Z" },
      { id: "e2", sourceId: "x", targetId: "p2", relationshipType: "containment", updatedAt: "2026-01-01T00:00:00Z" }
    ]
  };
  const derived = buildDerived(graph);
  assert.equal(derived.parentOf.get("x"), "p1", "the more recently updated edge wins regardless of array order");

  const tied = buildDerived({
    nodes: graph.nodes,
    edges: [
      { id: "e1", sourceId: "x", targetId: "p1", relationshipType: "containment" },
      { id: "e2", sourceId: "x", targetId: "p2", relationshipType: "containment" }
    ]
  });
  assert.equal(tied.parentOf.get("x"), "p2", "all-absent timestamps: last in array wins (pre-W5a behavior)");
});
