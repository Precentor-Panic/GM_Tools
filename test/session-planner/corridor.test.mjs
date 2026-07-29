import assert from "node:assert/strict";
import { neighborhood } from "../../wf-mcp-server/lib/graph.mjs";

/**
 * CONTRACT UNDER TEST — session-planner/corridor.mjs (Phase 16 task 16.1).
 * This module does not exist yet; this file is the interface spec for it,
 * per plans/phase-16-tasks.md task 16.0. It is expected to fail with
 * "Cannot find module" until 16.1 lands.
 *
 * Pure functions only — zero store I/O, zero Foundry/LLM calls, matching
 * mutation-engine/propagate.mjs's convention exactly. The module's only
 * import should be wf-mcp-server/lib/graph.mjs (for neighborhood()) — no
 * other new dependency.
 *
 * ---------------------------------------------------------------------------
 * shortestPath(entities, edges, fromId, toId)
 * ---------------------------------------------------------------------------
 * Undirected BFS shortest path between two entity ids, over the SAME
 * adjacency neighborhood() already builds (edges treated as undirected,
 * matching neighborhood()'s and propagate.mjs's own established convention
 * for this codebase).
 *   @param {object[]} entities
 *   @param {object[]} edges        {id, sourceId, targetId, ...}
 *   @param {string} fromId
 *   @param {string} toId
 *   @returns {string[]|null}       ordered list of entity ids from fromId to
 *                                  toId INCLUSIVE (path.length === 1 when
 *                                  fromId === toId), or null if toId is not
 *                                  reachable from fromId at all.
 *
 * ---------------------------------------------------------------------------
 * routePath(entities, edges, orderedLocationIds)
 * ---------------------------------------------------------------------------
 * Chains shortestPath() across a multi-stop route: computes shortestPath for
 * each consecutive pair in orderedLocationIds, then concatenates the legs,
 * deduping each pair's shared endpoint (leg N's last id === leg N+1's first
 * id) so the shared waypoint appears exactly once in the merged path.
 *   @param {object[]} entities
 *   @param {object[]} edges
 *   @param {string[]} orderedLocationIds   1 or more location entity ids, in
 *                                          the order the party intends to
 *                                          visit them. A single-id array is
 *                                          the home-base-only case.
 *   @returns {string[]|null}   the full merged path (entity ids, in route
 *                              order, deduped at joins), or null if ANY leg
 *                              is unreachable (the whole route is invalid —
 *                              routePath never returns a partial route).
 *
 * ---------------------------------------------------------------------------
 * corridorNodes(entities, edges, path, tolerance)
 * ---------------------------------------------------------------------------
 * Path-corridor traversal (design record §2.1/§4): unions
 * neighborhood(entities, edges, nodeId, tolerance) for EVERY node in `path`,
 * producing one deduped node set where each node is tagged with its MINIMUM
 * hop-distance to the nearest node in `path` (0 for a node that's on the
 * path itself). This is what makes it a corridor rather than a single-point
 * radius: a node near path[0] but far from path[1] is still picked up, and
 * vice versa (multi-point route picks up nodes near ANY point on the path,
 * not just the path's own nodes).
 *
 * Degenerate case (home-base only, no multi-point route): when `path` has
 * exactly one node, corridorNodes(...) must be a REAL, not merely similar,
 * degeneration to neighborhood(entities, edges, path[0], tolerance) — same
 * entity ids, same edge ids, with distance equal to the true hop count from
 * that single point (0 for the point itself).
 *
 *   @param {object[]} entities
 *   @param {object[]} edges
 *   @param {string[]} path         non-empty; typically routePath()'s output,
 *                                  or a single-id array for the home-base case
 *   @param {number} tolerance      corridor width in hops (tunable per §4)
 *   @returns {{
 *     entities: Array<{ id: string, distance: number, entity: object }>,
 *     edges: object[]              deduped raw edge objects touched by the union
 *   }}
 *   A node further than `tolerance` hops from EVERY node in `path` is
 *   excluded entirely (not returned with a large distance) — this is what
 *   §4 means by "never double-counts into the edge-of-world flag": corridor
 *   membership is binary (in the returned set, or not), severity scoping is
 *   the brief assembler's (16.5) job, not this function's.
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

// -----------------------------------------------------------------------
// Fixture: a small line-with-branches graph.
//
//        d                    e
//        |                    |
//   a ---+--- b -------- c ---+
//
// a-b, b-c on the main line; a-d and c-e are branches off the line's own
// endpoints (NOT on the a->b->c path themselves); f is a fully isolated
// entity with no edges at all, for the unreachable-path case.
// -----------------------------------------------------------------------
function fixture() {
  const entities = [
    { id: "a", name: "Home Base", type: "place" },
    { id: "b", name: "Waypoint", type: "place" },
    { id: "c", name: "Destination", type: "place" },
    { id: "d", name: "Branch Near Home", type: "person" },
    { id: "e", name: "Branch Near Destination", type: "person" },
    { id: "f", name: "Isolated", type: "place" }
  ];
  const edges = [
    { id: "e1", sourceId: "a", targetId: "b", relationshipType: "unspecified" },
    { id: "e2", sourceId: "b", targetId: "c", relationshipType: "unspecified" },
    { id: "e3", sourceId: "a", targetId: "d", relationshipType: "unspecified" },
    { id: "e4", sourceId: "c", targetId: "e", relationshipType: "unspecified" }
  ];
  return { entities, edges };
}

(async () => {
  const { shortestPath, routePath, corridorNodes } = await import("../../session-planner/corridor.mjs");

  // ----------------------------------------------------------- shortestPath

  test("shortestPath: finds the ordered path a->b->c", () => {
    const path = shortestPath(fixture().entities, fixture().edges, "a", "c");
    assert.deepEqual(path, ["a", "b", "c"]);
  });

  test("shortestPath: from a node to itself is a single-element path", () => {
    const path = shortestPath(fixture().entities, fixture().edges, "a", "a");
    assert.deepEqual(path, ["a"]);
  });

  test("shortestPath: returns null for a genuinely unreachable target (the unreachable-path case)", () => {
    const path = shortestPath(fixture().entities, fixture().edges, "a", "f");
    assert.equal(path, null);
  });

  // --------------------------------------------------------------- routePath

  test("routePath: chains a multi-stop route, deduping shared waypoints", () => {
    const path = routePath(fixture().entities, fixture().edges, ["a", "b", "c"]);
    assert.deepEqual(path, ["a", "b", "c"], "b is the shared endpoint of both legs -- must appear exactly once");
  });

  test("routePath: a single-id route is just that one id (the home-base-only shape)", () => {
    const path = routePath(fixture().entities, fixture().edges, ["a"]);
    assert.deepEqual(path, ["a"]);
  });

  test("routePath: returns null (not a partial route) when any leg is unreachable", () => {
    const path = routePath(fixture().entities, fixture().edges, ["a", "f"]);
    assert.equal(path, null);
  });

  // ----------------------------------------------------------- corridorNodes

  test("corridorNodes: degenerates correctly to plain radius-from-point for a single-node path (design record §2.1/§4)", () => {
    const { entities, edges } = fixture();
    const direct = neighborhood(entities, edges, "a", 1);
    const corridor = corridorNodes(entities, edges, ["a"], 1);

    const corridorIds = corridor.entities.map((n) => n.id).sort();
    const directIds = direct.entities.map((e) => e.id).sort();
    assert.deepEqual(corridorIds, directIds, "same node set as a plain neighborhood() call at the same depth");

    const corridorEdgeIds = corridor.edges.map((e) => e.id).sort();
    const directEdgeIds = direct.edges.map((e) => e.id).sort();
    assert.deepEqual(corridorEdgeIds, directEdgeIds, "same edge set as a plain neighborhood() call");

    const byId = Object.fromEntries(corridor.entities.map((n) => [n.id, n]));
    assert.equal(byId.a.distance, 0, "the path's own single node is distance 0");
    assert.equal(byId.b.distance, 1);
    assert.equal(byId.d.distance, 1);
    assert.equal(byId.a.entity.name, "Home Base", "each tagged node carries the real resolved entity object");
  });

  test("corridorNodes: a multi-point route picks up nodes near ANY point on the path, not just the path's own nodes", () => {
    const { entities, edges } = fixture();
    const path = ["a", "b", "c"]; // the main line
    const corridor = corridorNodes(entities, edges, path, 1);

    const ids = corridor.entities.map((n) => n.id).sort();
    // d hangs off "a" only, e hangs off "c" only -- NEITHER is on the path
    // itself, and neither is within tolerance of the path's midpoint (b)
    // alone. A single-point-radius-from-the-route's-centroid approach would
    // miss at least one of these; the corridor (union over every path node)
    // must pick up BOTH.
    assert.deepEqual(ids, ["a", "b", "c", "d", "e"]);

    const byId = Object.fromEntries(corridor.entities.map((n) => [n.id, n]));
    assert.equal(byId.a.distance, 0);
    assert.equal(byId.b.distance, 0);
    assert.equal(byId.c.distance, 0);
    assert.equal(byId.d.distance, 1, "d is one hop off path-node 'a', not on the path itself");
    assert.equal(byId.e.distance, 1, "e is one hop off path-node 'c', not on the path itself");

    const edgeIds = corridor.edges.map((e) => e.id).sort();
    assert.deepEqual(edgeIds, ["e1", "e2", "e3", "e4"]);
  });

  test("corridorNodes: a node beyond tolerance of every path node is excluded entirely, not included with a large distance", () => {
    const { entities, edges } = fixture();
    const corridor = corridorNodes(entities, edges, ["a", "b", "c"], 0); // tolerance 0 -- only the path nodes themselves
    const ids = corridor.entities.map((n) => n.id).sort();
    assert.deepEqual(ids, ["a", "b", "c"], "with zero tolerance, only the path's own nodes qualify -- d and e must be entirely absent");
  });

  console.log(`\n${passed} passed`);
})();
