/**
 * Path-corridor traversal engine — pure, Foundry-free, unit-testable.
 *
 * Phase 16 task 16.1. Design record §2.1/§4: session planning needs
 * "distance from the party's path of travel," not a semantic goal-adjacency
 * walk — one traversal, one metric (hop distance), no new World Fabric
 * relationship type. This module is the generalization of `neighborhood()`
 * (wf-mcp-server/lib/graph.mjs) from a single point to a multi-point path: a
 * corridor is the union of that same BFS radius around every node on the
 * path, each returned node tagged with its minimum hop-distance to the
 * nearest path node. A single-node path degenerates to a literal call to
 * `neighborhood()` at the same depth — not just a similar result, the exact
 * same function call unioned over a one-element set.
 *
 * Pure functions only — no store I/O, no Foundry/LLM calls, matching
 * mutation-engine/propagate.mjs's convention exactly. Zero imports beyond
 * wf-mcp-server/lib/graph.mjs.
 */
import { neighborhood } from "../wf-mcp-server/lib/graph.mjs";

/**
 * Undirected BFS shortest path between two entity ids. Edges are treated as
 * undirected, matching neighborhood()'s own established convention for this
 * codebase.
 *
 * @param {object[]} entities
 * @param {object[]} edges
 * @param {string} fromId
 * @param {string} toId
 * @returns {string[]|null}   ordered list of entity ids from fromId to toId
 *                            INCLUSIVE, or null if toId is unreachable.
 */
export function shortestPath(entities, edges, fromId, toId) {
  if (fromId === toId) return [fromId];

  const adj = buildAdjacency(edges);
  const visited = new Set([fromId]);
  const prev = new Map();
  let frontier = [fromId];

  while (frontier.length) {
    const next = [];
    for (const uid of frontier) {
      for (const to of adj.get(uid) ?? []) {
        if (visited.has(to)) continue;
        visited.add(to);
        prev.set(to, uid);
        if (to === toId) return reconstructPath(prev, fromId, toId);
        next.push(to);
      }
    }
    frontier = next;
  }

  return null;
}

/**
 * Chains shortestPath() across a multi-stop route, deduping each leg's
 * shared endpoint so it appears exactly once in the merged path.
 *
 * @param {object[]} entities
 * @param {object[]} edges
 * @param {string[]} orderedLocationIds   1 or more location entity ids, in
 *                                        route order. A single-id array is
 *                                        the home-base-only case.
 * @returns {string[]|null}   the full merged path, or null if ANY leg is
 *                            unreachable — routePath never returns a partial
 *                            route.
 */
export function routePath(entities, edges, orderedLocationIds) {
  if (!orderedLocationIds || orderedLocationIds.length === 0) return null;
  if (orderedLocationIds.length === 1) return [orderedLocationIds[0]];

  let merged = null;
  for (let i = 0; i < orderedLocationIds.length - 1; i++) {
    const leg = shortestPath(entities, edges, orderedLocationIds[i], orderedLocationIds[i + 1]);
    if (!leg) return null; // whole route is invalid, never a partial route
    merged = merged === null ? [...leg] : [...merged, ...leg.slice(1)];
  }
  return merged;
}

/**
 * Path-corridor traversal (design record §2.1/§4): unions
 * neighborhood(entities, edges, nodeId, tolerance) for every node in `path`,
 * producing one deduped node set where each node is tagged with its MINIMUM
 * hop-distance to the nearest node in `path` (0 for a node on the path
 * itself). A node beyond `tolerance` hops of every path node is excluded
 * entirely — corridor membership is binary, severity scoping is the brief
 * assembler's (16.5) job, not this function's.
 *
 * @param {object[]} entities
 * @param {object[]} edges
 * @param {string[]} path         non-empty; typically routePath()'s output,
 *                                or a single-id array for the home-base case
 * @param {number} tolerance      corridor width in hops
 * @returns {{entities: Array<{id:string, distance:number, entity:object}>, edges: object[]}}
 */
export function corridorNodes(entities, edges, path, tolerance) {
  const entityUnion = new Map();
  const edgeUnion = new Map();

  for (const nodeId of path) {
    const { entities: es, edges: ed } = neighborhood(entities, edges, nodeId, tolerance);
    for (const e of es) entityUnion.set(e.id, e);
    for (const e of ed) edgeUnion.set(e.id, e);
  }

  const distances = multiSourceDistances(edges, path, tolerance);

  const resultEntities = [...entityUnion.values()].map((entity) => ({
    id: entity.id,
    distance: distances.has(entity.id) ? distances.get(entity.id) : tolerance,
    entity
  }));

  return { entities: resultEntities, edges: [...edgeUnion.values()] };
}

// --- helpers -----------------------------------------------------------------

function buildAdjacency(edges) {
  const adj = new Map();
  for (const edge of edges) {
    if (!adj.has(edge.sourceId)) adj.set(edge.sourceId, []);
    if (!adj.has(edge.targetId)) adj.set(edge.targetId, []);
    adj.get(edge.sourceId).push(edge.targetId);
    adj.get(edge.targetId).push(edge.sourceId);
  }
  return adj;
}

function reconstructPath(prev, fromId, toId) {
  const path = [toId];
  let cur = toId;
  while (cur !== fromId) {
    cur = prev.get(cur);
    path.push(cur);
  }
  return path.reverse();
}

/** Multi-source BFS distance (in hops) from the nearest of `sourceIds`, capped at maxDepth. */
function multiSourceDistances(edges, sourceIds, maxDepth) {
  const adj = buildAdjacency(edges);
  const distance = new Map();
  for (const id of sourceIds) {
    if (!distance.has(id)) distance.set(id, 0);
  }
  let frontier = [...distance.keys()];
  for (let d = 0; d < maxDepth; d++) {
    const next = [];
    for (const uid of frontier) {
      for (const to of adj.get(uid) ?? []) {
        if (!distance.has(to)) {
          distance.set(to, d + 1);
          next.push(to);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return distance;
}
