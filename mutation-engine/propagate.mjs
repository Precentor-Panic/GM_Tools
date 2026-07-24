/**
 * Propagation engine — pure, Foundry-free, unit-testable.
 *
 * Two deterministic (non-LLM) mechanisms, config-driven:
 *   - propagateSeed:  weighted BFS diffusion of an impact score outward from
 *     an event epicenter ("blast radius" impact, not just reachability).
 *   - ambientDecay:   per-relationshipType half-life decay of edge strength
 *     over elapsed sessions (time-skip mode). Reuses the decay-formula shape
 *     `foundry_worldFabric/scripts/data/llm-context.mjs`'s `recencyScore()`
 *     already established: `Math.pow(0.5, elapsed / halfLife)`.
 *
 * candidateDeltas() combines both into the flat list mutation-engine/texture.mjs
 * consumes to decide what's even worth an LLM call.
 *
 * NOTE (stop-and-check gate, non-blocking per gm-tools-conventions): the
 * constants below are plausible starting values, not calibrated against a
 * real campaign. Shipped as prototype defaults per task 1.3's own text —
 * Russell has deferred tuning to a future step once live playtest data
 * exists. See this repo's Phase 1 closing report for the explicit flag.
 */

// World Fabric's Phase 1.5 split the old catch-all "location" relationship
// type into "containment" (structural, e.g. place.region/faction.headquarters
// — shouldn't erode over time) and "presence" (temporal, e.g. an actor's
// recent whereabouts — should decay). See GM_Tools/plans/phase-1.5-tasks.md.
// "presence" replaces "location" below (same weight/half-life, a rename not
// a behavior change). "containment" is still a normal weight for
// propagateSeed (a seeded event legitimately ripples through containment —
// "the district burned" should still reach the buildings within it) but is
// hard-excluded from ambientDecay entirely, below — its DECAY_HALF_LIFE_SESSIONS
// entry is therefore moot but kept for documentation/completeness.
export const EDGE_TYPE_WEIGHT = {
  causal: 1.0,
  fealty: 0.9,
  kinship: 0.85,
  membership: 0.7,
  ownership: 0.6,
  containment: 0.6,
  presence: 0.55,
  knowledge: 0.5,
  social: 0.4,
  unspecified: 0.3
};

export const DECAY_HALF_LIFE_SESSIONS = {
  fealty: 8,
  kinship: 10,
  membership: 6,
  causal: 12,
  ownership: 6,
  presence: 4,
  knowledge: 5,
  social: 2,
  unspecified: 3
  // containment: intentionally absent -- ambientDecay hard-excludes
  // "containment" edges entirely (see below), so no half-life applies.
};

export const IMPACT_THRESHOLD = 0.15;
export const IMPORTANCE_FLOOR = 0.2;
export const PRUNE_FLOOR = 0.01;

const DEFAULT_MAX_DEPTH = 3;

/**
 * Weighted BFS diffusion of an impact score outward from a seed entity.
 * Edges are treated as undirected for propagation purposes (an event's
 * ripple doesn't respect authored edge direction), same convention
 * `closeness.mjs` already uses for proximity scoring.
 *
 * Processes strictly layer-by-layer (one layer per hop, capped at
 * maxDepth) rather than a pure Dijkstra relaxation, so "hop distance from
 * seed" is well-defined and impact is guaranteed non-increasing as hop
 * distance increases — the shape the review/grain layer depends on.
 * Within a layer, when multiple frontier nodes reach the same not-yet-visited
 * entity, the strongest (max-product) incoming edge wins.
 *
 * @param {object[]} entities
 * @param {object[]} edges
 * @param {string} seedId
 * @param {number} seedMagnitude  starting impact score at the seed, typically in [0,1]
 * @param {number} [maxDepth=3]
 * @returns {Map<string, number>}  entityId -> impactScore, including the seed itself (impactScore = seedMagnitude)
 */
export function propagateSeed(entities, edges, seedId, seedMagnitude, maxDepth = DEFAULT_MAX_DEPTH) {
  const adj = buildUndirectedAdjacency(edges);

  const impact = new Map([[seedId, seedMagnitude]]);
  const visited = new Set([seedId]);
  let frontier = [seedId];

  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const layerBest = new Map(); // entityId -> best candidate score reached this layer

    for (const fromId of frontier) {
      const fromImpact = impact.get(fromId);
      for (const { to, relationshipType, strength } of adj.get(fromId) ?? []) {
        if (visited.has(to)) continue; // already settled at a shorter (or equal) hop distance
        const weight = EDGE_TYPE_WEIGHT[relationshipType] ?? EDGE_TYPE_WEIGHT.unspecified;
        const candidate = fromImpact * weight * clamp01(strength);
        if (candidate < PRUNE_FLOOR) continue;
        const best = layerBest.get(to);
        if (best === undefined || candidate > best) layerBest.set(to, candidate);
      }
    }

    const next = [];
    for (const [id, score] of layerBest) {
      impact.set(id, score);
      visited.add(id);
      next.push(id);
    }
    frontier = next;
  }

  return impact;
}

/**
 * Per-relationshipType half-life decay of edge strength over elapsed sessions.
 *
 * "containment" edges (structural facts, e.g. a place being part of a region)
 * are hard-excluded: no delta computed, no candidate produced, regardless of
 * elapsed time or configured half-life. This is a deliberate skip rather than
 * a very-large half-life constant -- a half-life is still monotonic decay and
 * would eventually misfire on a long enough campaign, spuriously implying
 * "this building stopped being in its district". See
 * GM_Tools/plans/phase-1.5-tasks.md task 1.5.3. Note this exclusion is scoped
 * to ambient decay only -- `propagateSeed` still traverses containment edges
 * normally, since a seeded event legitimately ripples through them.
 *
 * @param {object[]} edges
 * @param {number} elapsedSessions
 * @returns {{edgeId:string, relationshipType:string, from:number, to:number, delta:number}[]}
 */
export function ambientDecay(edges, elapsedSessions) {
  return edges
    .filter((edge) => edge.relationshipType !== "containment")
    .map((edge) => {
      const halfLife = DECAY_HALF_LIFE_SESSIONS[edge.relationshipType] ?? DECAY_HALF_LIFE_SESSIONS.unspecified;
      const from = clamp01(edge.strength);
      const to = clamp01(from * Math.pow(0.5, elapsedSessions / halfLife));
      return {
        edgeId: edge.id,
        relationshipType: edge.relationshipType,
        from,
        to,
        delta: to - from
      };
    });
}

/**
 * Combines propagateSeed + ambientDecay into a flat candidate-delta list,
 * flagging which ones clear the bar for an LLM texturing call.
 *
 * needsLLM policy:
 *  - seed-propagated: both the entity's impactScore AND its own `importance`
 *    must clear their respective floors. An unimportant entity getting
 *    lightly brushed by an event isn't worth an API call even if some
 *    impact reached it; a high-impact entity below IMPORTANCE_FLOOR
 *    (importance defaults to 0.3 when absent, matching interchange.mjs's
 *    normalizeEntity default) still doesn't clear the bar.
 *  - ambient-decay: the magnitude of the strength change must clear
 *    IMPACT_THRESHOLD — small decays aren't worth texturing.
 *
 * @param {object[]} entities
 * @param {object[]} edges
 * @param {object} [opts]
 * @param {string} [opts.seedId]
 * @param {number} [opts.seedMagnitude]
 * @param {number} [opts.depth=3]              max BFS hops for seed propagation
 * @param {number} [opts.elapsedSessions]
 * @returns {Array<object>}  flat list of {kind, ..., needsLLM}
 */
export function candidateDeltas(entities, edges, opts = {}) {
  const { seedId, seedMagnitude, depth = DEFAULT_MAX_DEPTH, elapsedSessions } = opts;
  const deltas = [];

  if (seedId != null && seedMagnitude != null) {
    const entityById = new Map(entities.map((e) => [e.id, e]));
    const impactMap = propagateSeed(entities, edges, seedId, seedMagnitude, depth);
    for (const [entityId, impactScore] of impactMap) {
      if (entityId === seedId) continue; // the seed itself is the event, not a ripple effect
      const entity = entityById.get(entityId);
      const importance = clamp01(entity?.importance ?? 0.3);
      const needsLLM = impactScore >= IMPACT_THRESHOLD && importance >= IMPORTANCE_FLOOR;
      deltas.push({
        kind: "seed-propagated",
        entityId,
        impactScore,
        importance,
        needsLLM
      });
    }
  }

  if (elapsedSessions != null && elapsedSessions > 0) {
    for (const d of ambientDecay(edges, elapsedSessions)) {
      const needsLLM = Math.abs(d.delta) >= IMPACT_THRESHOLD;
      deltas.push({ kind: "ambient-decay", ...d, needsLLM });
    }
  }

  return deltas;
}

// --- helpers -----------------------------------------------------------------

function buildUndirectedAdjacency(edges) {
  const adj = new Map();
  const add = (from, to, relationshipType, strength) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push({ to, relationshipType, strength });
  };
  for (const e of edges) {
    add(e.sourceId, e.targetId, e.relationshipType, e.strength);
    add(e.targetId, e.sourceId, e.relationshipType, e.strength);
  }
  return adj;
}

function clamp01(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
