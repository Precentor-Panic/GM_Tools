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
 * Task 2.0 extracts exactly the three modes that already existed
 * (seed/ambient/tag), byte-identical in behavior — refactor only, no new
 * modes here yet. Task 2.1 adds region and contained-in in a follow-up commit.
 */
import { candidateDeltas } from "../mutation-engine/propagate.mjs";

export const SCOPE_MODES = ["seed", "ambient", "tag"];

const DEFAULT_SEED_DEPTH = 3;

/**
 * Resolve a scope spec against a snapshot into a flat candidateDeltas list.
 *
 * @param {{entities:object[], edges:object[]}} snapshot
 * @param {object} scopeSpec
 * @param {'seed'|'ambient'|'tag'} scopeSpec.mode
 * @param {string} [scopeSpec.anchorId]         mode='seed' (single-seed shorthand)
 * @param {number} [scopeSpec.depth]            mode='seed' (BFS hops, default 3)
 * @param {string} [scopeSpec.tag]              mode='tag'
 * @param {number} [scopeSpec.elapsedSessions]  mode='ambient'/'tag' (ambient-decay half-life calc, default 1)
 * @param {Array<{entityId:string, magnitude:number}>} [scopeSpec.seeds]  mode='seed' (multi-seed)
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
