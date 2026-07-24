/**
 * Pure graph traversal over a snapshot's entities/edges arrays. Ported from
 * World Fabric's GraphService.neighborhood() — no Foundry runtime deps, so
 * it works standalone against the exported snapshot JSON.
 */
export function neighborhood(entities, edges, entityId, depth = 2) {
  const adj = new Map();
  for (const edge of edges) {
    if (!adj.has(edge.sourceId)) adj.set(edge.sourceId, []);
    if (!adj.has(edge.targetId)) adj.set(edge.targetId, []);
    adj.get(edge.sourceId).push({ to: edge.targetId, edgeId: edge.id });
    adj.get(edge.targetId).push({ to: edge.sourceId, edgeId: edge.id });
  }

  const visitedEntities = new Set([entityId]);
  const visitedEdges = new Set();
  let frontier = [entityId];

  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const uid of frontier) {
      for (const { to, edgeId } of adj.get(uid) ?? []) {
        visitedEdges.add(edgeId);
        if (!visitedEntities.has(to)) {
          visitedEntities.add(to);
          next.push(to);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }

  const entityMap = new Map(entities.map((e) => [e.id, e]));
  const edgeMap = new Map(edges.map((e) => [e.id, e]));
  return {
    entities: [...visitedEntities].map((id) => entityMap.get(id)).filter(Boolean),
    edges: [...visitedEdges].map((id) => edgeMap.get(id)).filter(Boolean)
  };
}

export function edgesFor(edges, entityId) {
  return edges.filter((e) => e.sourceId === entityId || e.targetId === entityId);
}

export function findEntity(entities, entityId) {
  return entities.find((e) => e.id === entityId) ?? null;
}

export function findEdge(edges, edgeId) {
  return edges.find((e) => e.id === edgeId) ?? null;
}

/** Case-insensitive name lookup, for when the caller has a name but not an ID. */
export function findEntityByName(entities, name) {
  const lower = name.toLowerCase();
  return entities.find((e) => e.name?.toLowerCase() === lower) ?? null;
}
