/**
 * Scope resolution — pure, Foundry-free, unit-testable.
 *
 * Extracted from wf-mcp-server/index.mjs's wf_propose_mutations handler
 * (Phase 2 task 2.0) into a reusable library function so no future front-end
 * (wf-mcp-server, a future review-ui/) has to reimplement scope-mode
 * branching (see gm-tools-conventions: "front-ends are thin wrappers, never
 * logic duplicators").
 *
 * resolveScope(snapshot, scopeSpec) takes a snapshot's {entities, edges} and
 * a scope spec, and returns the candidate delta list (mutation-engine/
 * propagate.mjs's candidateDeltas shape) for that scope. Field names on
 * scopeSpec intentionally match wf_propose_mutations's existing live tool
 * input exactly (mode, anchorId, depth, tag, elapsedSessions, seeds) — this
 * tool is already in conversational use, nothing here renames its contract.
 *
 * Task 2.0 extracted the three modes that already existed (seed/ambient/tag),
 * byte-identical in behavior. Task 2.1 (below the "--- Phase 2.1 ---" marker)
 * adds region and contained-in.
 */
import { candidateDeltas } from "../mutation-engine/propagate.mjs";
import { neighborhood } from "../wf-mcp-server/lib/graph.mjs";

export const SCOPE_MODES = ["seed", "ambient", "tag", "region", "contained-in"];

const DEFAULT_SEED_DEPTH = 3;
const DEFAULT_REGION_DEPTH = 2;
// "contained-in" wants effectively-unbounded depth (a district -> building ->
// room chain is the multi-hop case this mode exists for, per phase-2-tasks.md
// task 2.1) -- a large finite cap rather than Infinity so neighborhood()'s
// depth-bounded loop still terminates in a predictable number of iterations
// on a pathological/cyclic graph.
export const CONTAINED_IN_DEFAULT_DEPTH = 1000;

/**
 * Resolve a scope spec against a snapshot into a flat candidateDeltas list.
 *
 * @param {{entities:object[], edges:object[]}} snapshot
 * @param {object} scopeSpec
 * @param {'seed'|'ambient'|'tag'|'region'|'contained-in'} scopeSpec.mode
 * @param {string} [scopeSpec.anchorId]         mode='seed' (single-seed shorthand), 'region', 'contained-in'
 * @param {number} [scopeSpec.depth]            mode='seed' (BFS hops, default 3), 'region' (default 2),
 *                                               'contained-in' (default effectively-unbounded)
 * @param {string} [scopeSpec.tag]              mode='tag'
 * @param {number} [scopeSpec.elapsedSessions]  mode='ambient'/'tag'/'region'/'contained-in' (ambient-decay half-life calc, default 1)
 * @param {Array<{entityId:string, magnitude:number}>} [scopeSpec.seeds]  mode='seed' (multi-seed); also usable
 *                                               within 'region'/'contained-in' to seed-propagate scoped to that subgraph
 * @returns {{deltas: Array}}
 */
export function resolveScope(snapshot, scopeSpec) {
  const { entities, edges } = snapshot;
  const { mode } = scopeSpec;

  if (mode === "seed") {
    return { deltas: resolveSeedDeltas(entities, edges, scopeSpec) };
  }

  if (mode === "ambient") {
    return { deltas: candidateDeltas(entities, edges, { elapsedSessions: scopeSpec.elapsedSessions ?? 1 }) };
  }

  if (mode === "tag") {
    return { deltas: resolveTagDeltas(entities, edges, scopeSpec) };
  }

  // --- Phase 2.1 ---

  if (mode === "region") {
    return { deltas: resolveRegionDeltas(entities, edges, scopeSpec) };
  }

  if (mode === "contained-in") {
    return { deltas: resolveContainedInDeltas(entities, edges, scopeSpec) };
  }

  throw new Error(`Unknown scope.mode: ${mode}`);
}

// ------------------------------------------------------------ mode: seed

function resolveSeedDeltas(entities, edges, scopeSpec) {
  const seedList = scopeSpec.seeds?.length
    ? scopeSpec.seeds
    : scopeSpec.anchorId
      ? [{ entityId: scopeSpec.anchorId, magnitude: 1.0 }]
      : [];
  if (!seedList.length) throw new Error("scope.mode='seed' requires scope.anchorId or seeds[]");

  const merged = new Map();
  for (const s of seedList) {
    const d = candidateDeltas(entities, edges, {
      seedId: s.entityId,
      seedMagnitude: s.magnitude,
      depth: scopeSpec.depth ?? DEFAULT_SEED_DEPTH
    });
    for (const delta of d) {
      const existing = merged.get(delta.entityId);
      if (!existing || delta.impactScore > existing.impactScore) merged.set(delta.entityId, delta);
    }
  }
  return [...merged.values()];
}

// ------------------------------------------------------------ mode: tag

function resolveTagDeltas(entities, edges, scopeSpec) {
  if (!scopeSpec.tag) throw new Error("scope.mode='tag' requires scope.tag");
  const all = candidateDeltas(entities, edges, { elapsedSessions: scopeSpec.elapsedSessions ?? 1 });
  const taggedIds = new Set(entities.filter((e) => (e.tags ?? []).includes(scopeSpec.tag)).map((e) => e.id));
  const edgeMap = new Map(edges.map((e) => [e.id, e]));
  return all.filter((d) => {
    if (d.kind === "seed-propagated") return taggedIds.has(d.entityId);
    const edge = edgeMap.get(d.edgeId);
    return edge && (taggedIds.has(edge.sourceId) || taggedIds.has(edge.targetId));
  });
}

// ------------------------------------------------------------ mode: region

/**
 * BFS neighborhood from anchorId out to depth hops (reuses graph.mjs's
 * neighborhood() rather than reimplementing BFS), then runs ambientDecay
 * (or seeded propagation, if scopeSpec.seeds is also given) scoped to just
 * that neighborhood's own entities/edges -- a GM can time-skip one
 * region/faction without touching the rest of the graph.
 *
 * Generic all-types BFS is deliberate here (see plans/phase-2-review.md):
 * "region" answers "what's narratively/relationally near this anchor",
 * mirroring closeness.mjs's undirected, type-agnostic proximity convention
 * -- it is not attempting to be a containment tree, so it doesn't inherit
 * the old location-only-BFS bug that motivated contained-in's stricter
 * edge-type filter below.
 */
function resolveRegionDeltas(entities, edges, scopeSpec) {
  if (!scopeSpec.anchorId) throw new Error("scope.mode='region' requires scope.anchorId");
  const { entities: regionEntities, edges: regionEdges } = neighborhood(
    entities,
    edges,
    scopeSpec.anchorId,
    scopeSpec.depth ?? DEFAULT_REGION_DEPTH
  );

  if (scopeSpec.seeds?.length) {
    return resolveSeedDeltas(regionEntities, regionEdges, scopeSpec);
  }
  return candidateDeltas(regionEntities, regionEdges, { elapsedSessions: scopeSpec.elapsedSessions ?? 1 });
}

// ------------------------------------------------------------ mode: contained-in

/**
 * Plain reachability BFS from anchorId, filtered to containment-typed edges
 * ONLY -- never origin (biographical: "who's from this place", a different
 * question than "what's structurally inside this place right now"; folding
 * it in here would repeat, one layer up, the exact category error the
 * containment/presence/origin schema split was fixing -- see
 * plans/phase-2-review.md). Never presence either (temporal "recent
 * whereabouts", not structural composition).
 *
 * Does not assume a strict single-parent tree -- nothing in the schema
 * enforces that for any relationship type (confirmed against
 * graph-service.mjs), so this reuses a visited-set BFS shape (same as
 * neighborhood()'s own), which handles a DAG/cycle safely without needing
 * tree validation. Default depth is a very high cap, not region's shallow
 * default -- a district -> building -> room chain is exactly the multi-hop
 * case this mode exists for.
 *
 * IMPORTANT (found during Phase 2's remediation pass, via the manual
 * round-trip check): the containment-only filter above governs the BFS
 * TRAVERSAL only -- i.e. what new entities you can reach, and how ("what's
 * inside this place" must not be inferred through an origin/presence hop).
 * It must NOT also become the edge set handed to candidateDeltas/
 * ambientDecay/propagateSeed once the entity set is settled. containment
 * edges are themselves hard-excluded from ambientDecay entirely
 * (NON_DECAYING_RELATIONSHIP_TYPES, propagate.mjs) -- so if the only edges
 * ever passed downstream were the containment ones used to discover the
 * entities, "contained-in" + ambient mode (no seeds) would be a PERMANENT
 * no-op: zero possible decay candidates, always, for any world. Once the
 * entity set is fixed via the containment-only BFS, this instead gathers
 * ALL real edges (any type) between two already-in-scope entities from the
 * full graph, so a time-skip over "everything inside this district" still
 * sees e.g. a fealty bond or social standing fraying between two buildings
 * both structurally inside it -- exactly what a GM time-skipping a region
 * would expect to happen. This does not reopen the origin/presence
 * traversal question above: an origin/presence edge only shows up here if
 * BOTH its endpoints were already reached via containment alone, never as a
 * new entity discovered through it.
 */
function resolveContainedInDeltas(entities, edges, scopeSpec) {
  if (!scopeSpec.anchorId) throw new Error("scope.mode='contained-in' requires scope.anchorId");
  const containmentEdges = edges.filter((e) => e.relationshipType === "containment");
  const { entities: containedEntities } = neighborhood(
    entities,
    containmentEdges,
    scopeSpec.anchorId,
    scopeSpec.depth ?? CONTAINED_IN_DEFAULT_DEPTH
  );
  const containedIds = new Set(containedEntities.map((e) => e.id));
  const containedEdges = edges.filter((e) => containedIds.has(e.sourceId) && containedIds.has(e.targetId));

  if (scopeSpec.seeds?.length) {
    return resolveSeedDeltas(containedEntities, containedEdges, scopeSpec);
  }
  return candidateDeltas(containedEntities, containedEdges, { elapsedSessions: scopeSpec.elapsedSessions ?? 1 });
}
