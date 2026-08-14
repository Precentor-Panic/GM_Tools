// GM Review — Friction Wave 1 (W5a): the World tab's tree derivation, moved
// out of world-view.js into a DOM-free module so it can be unit-tested under
// plain Node (world-view.js touches `document` at import time — same reason
// world-id.js/debounced-save.mjs are standalone). world-view.js imports
// buildDerived/LOYALTY_PARENT_EDGE from here; behavior for acyclic graphs is
// byte-identical to the pre-W5a in-file implementation.
//
// KEY TRANSLATION (unchanged): the repo models containment as EDGES
// (relationshipType:"containment", child = sourceId -> parent = targetId).
// The tree is derived by grouping nodes under the parent their containment
// edge points at; a node that is no containment edge's sourceId is a root.
//
// W5a NEW — containment-CYCLE detection. The real Kilmarn bug: stage-1
// writeup-import emitted "Kilmarn has five quarters" edges inverted
// (Kilmarn -> quarter, semantic "contains"), a later import added the correct
// The Underbreach -> Kilmarn edge, closing a cycle (Kilmarn -> Underbreach ->
// Kilmarn). Cyclic nodes hang off no root, so BOTH silently vanished from
// "Where things are" — along with everything underneath them. Data bugs must
// never become silent disappearance: cycle members now RENDER, grouped at
// root under a deterministically-chosen representative that carries a visible
// warning badge naming the cycle (world-view.js's buildTreeRow reads
// `cycleBreaks`).
"use strict";

/**
 * Derived tree structure from a chosen set of "parent" EDGES. Defaults to
 * containment. Phase 38's Loyalty predicate (LOYALTY_PARENT_EDGE below)
 * reuses this same function to derive a second, independent tree over
 * {membership, fealty} edges.
 *
 * SINGLE-PARENT MOST-RECENT-WINS (unchanged from pre-W5a): for each source
 * node, the qualifying edge with the greatest `edge.updatedAt ?? createdAt`
 * (ISO-string comparison) wins; ties (including all-absent, the common case
 * for headless fixtures) go to the LAST one encountered in `graph.edges`.
 *
 * W5a: after the parent maps are built, containment cycles are detected and
 * BROKEN for rendering: each cycle's representative (first member by
 * case-insensitive name, then id — deterministic) has its parent link removed
 * so the whole cycle renders as a normal subtree at root, and is recorded in
 * `cycleBreaks` (Map<representativeId, {memberIds, memberNames}>) so the tree
 * can badge it. The underlying graph data is NEVER mutated — this is purely
 * the derived view refusing to lose nodes.
 *
 * @param {{nodes:object[], edges:object[]}} graph
 * @param {(e:object) => boolean} [isParentEdge]
 * @returns {{nodesById:Map, parentOf:Map, childrenOf:Map, nonContainment:object[],
 *            cycleBreaks:Map<string,{memberIds:string[], memberNames:string[]}>}}
 */
export function buildDerived(graph, isParentEdge = (e) => e.relationshipType === "containment") {
  const nodesById = new Map();
  for (const n of graph.nodes || []) nodesById.set(n.id, n);
  const parentOf = new Map();
  const childrenOf = new Map();
  const parentScoreOf = new Map();
  const nonContainment = [];
  for (const e of graph.edges || []) {
    if (!isParentEdge(e)) { nonContainment.push(e); continue; }
    const score = e.updatedAt ?? e.createdAt ?? "";
    const prevScore = parentScoreOf.get(e.sourceId);
    if (prevScore !== undefined && score < prevScore) continue; // an earlier, more-recent-scoring edge already won
    const oldParent = parentOf.get(e.sourceId);
    if (oldParent !== undefined) {
      const kids = childrenOf.get(oldParent);
      if (kids) childrenOf.set(oldParent, kids.filter((id) => id !== e.sourceId));
    }
    parentOf.set(e.sourceId, e.targetId);
    parentScoreOf.set(e.sourceId, score);
    if (!childrenOf.has(e.targetId)) childrenOf.set(e.targetId, []);
    childrenOf.get(e.targetId).push(e.sourceId);
  }

  const cycleBreaks = detectAndBreakCycles(nodesById, parentOf, childrenOf);
  return { nodesById, parentOf, childrenOf, nonContainment, cycleBreaks };
}

export const LOYALTY_PARENT_EDGE = (e) => e.relationshipType === "membership" || e.relationshipType === "fealty";

/**
 * W5a: find every parent-link cycle and break each one (in the DERIVED maps
 * only) at a deterministic representative so its members render at root
 * instead of silently vanishing.
 *
 * Walk each node's parent chain; a walk that revisits a node already on its
 * own path has found a new cycle (chains that terminate at a root, a missing
 * parent, or an already-processed node are fine). Every node is visited once
 * across all walks — O(nodes).
 */
function detectAndBreakCycles(nodesById, parentOf, childrenOf) {
  const cycleBreaks = new Map();
  const done = new Set();
  for (const startId of nodesById.keys()) {
    if (done.has(startId)) continue;
    const path = [];
    const indexOnPath = new Map();
    let cur = startId;
    while (cur != null && !done.has(cur) && !indexOnPath.has(cur)) {
      indexOnPath.set(cur, path.length);
      path.push(cur);
      const p = parentOf.get(cur);
      cur = p != null && nodesById.has(p) ? p : null;
    }
    if (cur != null && indexOnPath.has(cur)) {
      // A brand-new cycle: everything on the path from the revisited node on.
      const memberIds = path.slice(indexOnPath.get(cur));
      const displayName = (id) => {
        const n = nodesById.get(id);
        return (n && n.name) || id;
      };
      // Deterministic representative: first by case-insensitive display
      // name, id as the tiebreaker. (For the real Kilmarn <-> The
      // Underbreach cycle this roots "Kilmarn" — the natural read.)
      const rep = [...memberIds].sort((a, b) => {
        const an = displayName(a).toLowerCase();
        const bn = displayName(b).toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : a < b ? -1 : a > b ? 1 : 0;
      })[0];
      const repParent = parentOf.get(rep);
      parentOf.delete(rep);
      const kids = childrenOf.get(repParent);
      if (kids) childrenOf.set(repParent, kids.filter((id) => id !== rep));
      // Order memberIds so the representative leads, then follow the (still
      // intact) parent chain — reads as the actual loop in the badge title.
      const ordered = [rep];
      let walk = memberIds.includes(repParent) ? repParent : null;
      while (walk != null && walk !== rep && ordered.length < memberIds.length) {
        ordered.push(walk);
        const next = parentOf.get(walk);
        walk = next != null && memberIds.includes(next) ? next : null;
      }
      for (const id of memberIds) if (!ordered.includes(id)) ordered.push(id);
      cycleBreaks.set(rep, {
        memberIds: ordered,
        memberNames: ordered.map(displayName)
      });
    }
    for (const id of path) done.add(id);
  }
  return cycleBreaks;
}
