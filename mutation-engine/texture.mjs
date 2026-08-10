/**
 * Batched LLM texturing — the mutation engine's outward-facing Anthropic API
 * call. First place in GM_Tools that calls the Anthropic API outward
 * (everything else so far is called *by* Claude via MCP).
 *
 * Given candidateDeltas (mutation-engine/propagate.mjs) with needsLLM:true,
 * groups them by region/cluster (groupByRegion) and makes ONE structured
 * Anthropic API call per group — never one call per node, which is the
 * acceptance-critical cost-control behavior for this module. Each call's
 * output is validated against schema.mjs's Mutation shape; on validation
 * failure it retries once with the error appended to the prompt; on a
 * second failure it throws TextureValidationError rather than silently
 * dropping the batch or the region.
 *
 * Model default is claude-sonnet-5 per this repo's phase-1 task spec
 * (plans/phase-1-tasks.md task 1.5) — pass opts.model to override for
 * higher-stakes calls (not needed within Phase 1 itself; the parameter
 * exists for Phase 3/live-diff to use later).
 *
 * callModel/fillTemplate/JSON-fence-stripping are shared with time-skip/
 * resolve-seed.mjs (the mutation engine's second outward-facing LLM call
 * site) via ./llm-call.mjs, extracted during Phase 2's remediation pass —
 * see that module's own doc comment.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { Mutation, MutationOp } from "./schema.mjs";
import { callModelDetailed, fillTemplate as fillTemplateShared, parseJsonResponse } from "./llm-call.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "texture.md"), "utf8");

export const DEFAULT_TEXTURE_MODEL = "claude-sonnet-5";
// A busy region (several affected entities/edges, each producing its own
// mutation with a `data` payload and a `rationale`) can genuinely exceed
// llm-call.mjs's shared 2048-token default -- this call site never overrode
// that default explicitly before, so it was exposed to exactly the same
// silent-truncation failure mode graph-import/writeup-import.mjs's
// proposeWfiFromWriteup had before its own fix (see that module's own
// DEFAULT_WRITEUP_IMPORT_MAX_TOKENS comment and mutation-engine/llm-call.mjs's
// callModelDetailed doc comment for the full story). Given an explicit
// default here and truncation-aware doubling below, matching that fix.
export const DEFAULT_TEXTURE_MAX_TOKENS = 4096;

export class TextureValidationError extends Error {
  constructor(message, { attempts, lastError, rawResponse } = {}) {
    super(message);
    this.name = "TextureValidationError";
    this.attempts = attempts;
    this.lastError = lastError;
    this.rawResponse = rawResponse;
  }
}

// The creative subset of Mutation the LLM is asked to produce — texture.mjs
// fills in batchId/sourceKind/impactScore/regionId from context afterward,
// since the model has no way to know those bookkeeping values.
const RawMutation = z.object({
  op: MutationOp,
  id: z.string().optional(),
  data: z.record(z.string(), z.any()).optional(),
  rationale: z.string()
});
const RawMutationArray = z.array(RawMutation);

/**
 * Cluster needsLLM candidate deltas into regions so texturing makes one API
 * call per connected group of affected entities, not one per node. Two
 * affected entities land in the same region iff a direct edge in `edges`
 * connects them (transitively, via union-find) — a simple, cheap locality
 * heuristic appropriate at this project's graph scale.
 *
 * @param {Array} candidateDeltas
 * @param {object[]} edges
 * @returns {Array<{regionId:string, entityIds:string[], deltas:Array}>}
 */
export function groupByRegion(candidateDeltas, edges) {
  const eligible = candidateDeltas.filter((d) => d.needsLLM);

  const affectedIds = new Set();
  const endpointsFor = (d) => {
    if (d.kind === "seed-propagated") return [d.entityId];
    const edge = edges.find((e) => e.id === d.edgeId);
    return edge ? [edge.sourceId, edge.targetId] : [d.edgeId];
  };
  for (const d of eligible) {
    for (const id of endpointsFor(d)) affectedIds.add(id);
  }

  const parent = new Map([...affectedIds].map((id) => [id, id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of edges) {
    if (affectedIds.has(e.sourceId) && affectedIds.has(e.targetId)) union(e.sourceId, e.targetId);
  }

  const clusters = new Map(); // root -> { entityIds: Set, deltas: [] }
  for (const d of eligible) {
    const endpoints = endpointsFor(d);
    const anchor = endpoints[0];
    const root = affectedIds.has(anchor) ? find(anchor) : anchor;
    if (!clusters.has(root)) clusters.set(root, { entityIds: new Set(), deltas: [] });
    const cluster = clusters.get(root);
    cluster.deltas.push(d);
    for (const id of endpoints) cluster.entityIds.add(id);
  }

  let i = 0;
  return [...clusters.values()].map((c) => ({
    regionId: `region-${i++}`,
    entityIds: [...c.entityIds],
    deltas: c.deltas
  }));
}

function renderRegionContext(entities, entityIds, edges) {
  const idSet = new Set(entityIds);
  const entityMap = new Map(entities.map((e) => [e.id, e]));
  const lines = [];
  for (const id of entityIds) {
    const e = entityMap.get(id);
    if (!e) continue;
    const desc = e.summary || e.description || "(no description)";
    lines.push(`${e.name} (${e.type}) [id=${e.id}] importance=${e.importance ?? 0.3}: ${desc}`);
  }
  for (const edge of edges) {
    if (idSet.has(edge.sourceId) && idSet.has(edge.targetId)) {
      const s = entityMap.get(edge.sourceId)?.name ?? edge.sourceId;
      const t = entityMap.get(edge.targetId)?.name ?? edge.targetId;
      lines.push(`  ${s} --${edge.relationshipType}(${edge.strength})--> ${t} [edgeId=${edge.id}]`);
    }
  }
  return lines.join("\n");
}

function renderDeltaSummary(deltas, entities) {
  const entityMap = new Map(entities.map((e) => [e.id, e]));
  return deltas
    .map((d) => {
      if (d.kind === "seed-propagated") {
        const name = entityMap.get(d.entityId)?.name ?? d.entityId;
        return `- ${name} [id=${d.entityId}]: impactScore=${d.impactScore.toFixed(3)} (seed-propagated)`;
      }
      return `- edge [id=${d.edgeId}] (${d.relationshipType}): strength ${d.from.toFixed(2)} -> ${d.to.toFixed(2)} (ambient-decay)`;
    })
    .join("\n");
}

/**
 * Phase 3.5: render a set of pending-ledger entries (mutation-engine/
 * pending-ledger.mjs), each already hydrated with its source batch's
 * headline text, into the same delta-summary-shaped text block
 * renderDeltaSummary produces for a fresh candidateDeltas pass — this is
 * what feeds textureRegion's ctx.deltaSummaryOverride (below) for a
 * deferred-resolution texturing call (time-skip/resolve-pending.mjs's
 * on-demand resolve, and time-skip/run-cycle.mjs's growth-bound sweep).
 * Lives alongside renderDeltaSummary rather than as a new, unrelated
 * rendering path (per task 3.5.3's own instruction to extend one of
 * grain.mjs/texture.mjs rather than invent a third one) — it plays the
 * exact same structural role, just sourced from ledger history instead of a
 * live delta.
 *
 * Sorted chronologically by `cycleDescriptor` (not insertion/createdAt
 * order) and each line explicitly labeled with its cycle, per the
 * architect's reasoning that a flat undated bullet dump reads as
 * "everything happened at once" instead of a sequence. Multi-cause entries
 * for one entity are never split across calls -- this renders the full set
 * handed to it in one text block, and the caller passes ALL entries for ALL
 * entities being resolved in a single resolve/sweep call.
 *
 * @param {Array<{entityId:string, entityName:string, cycleDescriptor:string, causeTag:string, impactScore:number, sourceBatchHeadline?:string}>} records
 * @returns {string}
 */
export function renderPendingResolutionSummary(records) {
  const sorted = [...records].sort((a, b) => {
    if (a.cycleDescriptor === b.cycleDescriptor) return 0;
    return a.cycleDescriptor < b.cycleDescriptor ? -1 : 1;
  });
  return sorted
    .map((r) => {
      const impact = typeof r.impactScore === "number" ? r.impactScore.toFixed(3) : "?";
      const context = r.sourceBatchHeadline ? ` — context: ${r.sourceBatchHeadline}` : "";
      return `- [${r.cycleDescriptor}] ${r.entityName} [id=${r.entityId}]: ${r.causeTag} (impactScore=${impact})${context}`;
    })
    .join("\n");
}

function fillTemplate(vars) {
  return fillTemplateShared(PROMPT_TEMPLATE, vars);
}

/**
 * Phase 37 task 37.1: render an additive "tone" cue block for the texturing
 * prompt from Chronicle's fortune bias + "nudge it further" tags. Returns
 * "" when neither is given -- an omitted-opts caller (every pre-Phase-37
 * call site) renders the identical prompt text this always has, modulo the
 * one placeholder line itself (see prompts/texture.md).
 *
 * @param {number} [fortuneBias]   -2..2, Chronicle's fortune-track bias
 * @param {string} [fortuneLabel]  the fortune stop's display label (e.g. "Ruinous")
 * @param {string[]} [nudgeTags]   Chronicle's "nudge it further" tag ids
 * @returns {string}
 */
function renderToneLine(fortuneBias, fortuneLabel, nudgeTags) {
  const lines = [];
  if (fortuneBias !== undefined && fortuneBias !== null) {
    const labelPart = fortuneLabel ? ` (${fortuneLabel})` : "";
    lines.push(
      `Overall fortune for this stretch of time: bias ${fortuneBias > 0 ? "+" : ""}${fortuneBias}${labelPart} on a ` +
        `-2..2 scale -- let this tilt how kind or harsh outcomes trend, without overriding what the deltas above ` +
        `actually call for.`
    );
  }
  if (Array.isArray(nudgeTags) && nudgeTags.length) {
    lines.push(`Nudge this pass toward: ${nudgeTags.join(", ")}.`);
  }
  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

/**
 * Merge Chronicle's "nudge it further" tag ids onto an entity's own `tags`
 * array, deduplicated. Deliberately CODE-SIDE, not reliant on the LLM
 * choosing to echo them back -- "these become tags on the graph, not prose"
 * per Chronicle.dc.html's own UI copy for this control.
 */
function mergeTags(existingTags, nudgeTags) {
  return [...new Set([...(Array.isArray(existingTags) ? existingTags : []), ...nudgeTags])];
}

/**
 * Texture a single region: one Anthropic API call, validate -> retry-once
 * -> typed-error-on-second-failure. A truncated response (stop_reason
 * max_tokens) is detected explicitly and treated as its own retry-worthy
 * case: the token budget doubles for the retry rather than resending the
 * identical prompt with the identical budget (which would just truncate at
 * the same point again) -- see graph-import/writeup-import.mjs's
 * proposeWfiFromWriteup for the real-world bug this convention was
 * established to fix.
 *
 * @param {{regionId:string, entityIds:string[], deltas:Array}} region
 * @param {object} ctx
 * @param {object[]} ctx.entities
 * @param {object[]} ctx.edges
 * @param {string} ctx.world
 * @param {string} ctx.batchId
 * @param {'ambient-decay'|'seeded-propagation'|'manual'|'deferred-resolution'} ctx.sourceKind
 * @param {string} [ctx.elapsedTimeDescriptor]
 * @param {string} [ctx.note]  appended for wf_regenerate's re-invocation path
 * @param {string} [ctx.deltaSummaryOverride]  Phase 3.5: if given, used verbatim as the prompt's delta-summary
 *                                              text instead of renderDeltaSummary(region.deltas, entities) --
 *                                              time-skip/resolve-pending.mjs and time-skip/run-cycle.mjs's
 *                                              growth-bound sweep pass renderPendingResolutionSummary()'s output
 *                                              here, since their "deltas" are pending-ledger history, not a fresh
 *                                              candidateDeltas pass. region.deltas is still supplied by those
 *                                              callers (as {impactScore} stubs) so the impactScore-max calc below
 *                                              is unaffected -- this override only changes what the model reads,
 *                                              not the bookkeeping.
 * @param {number} [ctx.fortuneBias]   Phase 37 task 37.1: Chronicle's fortune-track bias (-2..2), additive --
 *                                     an omitted ctx renders the identical prompt every pre-Phase-37 caller
 *                                     already gets.
 * @param {string} [ctx.fortuneLabel]  the fortune stop's display label (e.g. "Ruinous"), paired with fortuneBias.
 * @param {string[]} [ctx.nudgeTags]   Chronicle's "nudge it further" tag ids -- steers the prompt AND is stamped,
 *                                     deterministically, onto every emitted upsert_entity mutation's own data.tags.
 * @param {object} [opts]
 * @param {object} [opts.client]  injectable Anthropic-SDK-shaped client (for tests / DI)
 * @param {string} [opts.apiKey]
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<object[]>}  validated Mutation objects
 */
export async function textureRegion(region, ctx, opts = {}) {
  const { entities, edges, world, batchId, sourceKind, elapsedTimeDescriptor, note, deltaSummaryOverride, fortuneBias, fortuneLabel, nudgeTags } = ctx;
  const regionContext = renderRegionContext(entities, region.entityIds, edges) || "(no entities)";
  const deltaSummary = deltaSummaryOverride ?? (renderDeltaSummary(region.deltas, entities) || "(no deltas)");

  const basePrompt = fillTemplate({
    world,
    sourceKind,
    elapsedTimeDescriptor: elapsedTimeDescriptor ?? "(not specified)",
    regionContext,
    deltaSummary,
    toneLine: renderToneLine(fortuneBias, fortuneLabel, nudgeTags),
    retryNote: note ? `Additional note from the reviewer: ${note}` : ""
  });

  const entityMap = new Map(entities.map((e) => [e.id, e]));
  const impactScore = region.deltas.reduce(
    (max, d) => Math.max(max, d.impactScore ?? Math.abs(d.delta ?? 0)),
    0
  );

  let prompt = basePrompt;
  let lastError;
  let lastRaw;
  let maxTokens = opts.maxTokens ?? DEFAULT_TEXTURE_MAX_TOKENS;
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { text: raw, truncated } = await callModelDetailed(prompt, {
      ...opts,
      model: opts.model ?? DEFAULT_TEXTURE_MODEL,
      maxTokens
    });
    lastRaw = raw;

    if (truncated) {
      // Same reasoning as proposeWfiFromWriteup's own truncation handling --
      // a truncated response is a budget problem, not a content problem, so
      // resending the identical prompt with the identical maxTokens would
      // just truncate at the same point again. Double the budget and retry
      // with the SAME prompt (no point pasting back a response we know is
      // incomplete).
      lastError = new Error(
        `Model response was truncated at max_tokens=${maxTokens} before it finished -- the mutation set for ` +
        `region "${region.regionId}" was larger than the token budget allowed.`
      );
      if (attempt < maxAttempts) {
        maxTokens *= 2;
        continue;
      }
      break;
    }

    try {
      const parsed = parseJsonResponse(raw);
      const rawMutations = RawMutationArray.parse(parsed);
      return rawMutations.map((m) => {
        const entity = m.id ? entityMap.get(m.id) : undefined;
        // Validate the LLM-controlled core against the strict Mutation shape
        // first — this is still a "freshly proposed" mutation, not yet a
        // stored one. regionId/entityContext are our own trusted enrichment
        // (not model output), attached after validation rather than parsed
        // through Mutation itself; schema.mjs's StoredMutation validates the
        // fully-enriched object later, once review-state.mjs persists it.
        const validated = Mutation.parse({ ...m, batchId, sourceKind, impactScore });
        // Phase 37 task 37.1: stamp Chronicle's "nudge it further" tags onto
        // every emitted upsert_entity mutation's own data.tags, deterministically
        // (code-side, not reliant on the model choosing to echo them back).
        const tagged =
          Array.isArray(nudgeTags) && nudgeTags.length && validated.op === "upsert_entity"
            ? { ...validated, data: { ...(validated.data ?? {}), tags: mergeTags(validated.data?.tags, nudgeTags) } }
            : validated;
        return {
          ...tagged,
          regionId: region.regionId,
          ...(entity
            ? { entityContext: { name: entity.name, importance: entity.importance, tags: entity.tags } }
            : {})
        };
      });
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        prompt =
          basePrompt +
          `\n\nYour previous response failed validation with this error — fix it and respond with ONLY ` +
          `the corrected JSON array, no prose:\n${err.message}\n\nYour previous response was:\n${raw}`;
      }
    }
  }

  throw new TextureValidationError(
    `Texturing failed validation twice for region "${region.regionId}": ${lastError?.message}`,
    { attempts: maxAttempts, lastError, rawResponse: lastRaw }
  );
}

/**
 * Texture an entire batch of candidateDeltas: group into regions, one API
 * call per region, combine into a flat mutation list.
 *
 * @param {Array} candidateDeltas
 * @param {object} ctx  same shape as textureRegion's ctx minus sourceKind (derived per region)
 * @param {object} [opts]  same as textureRegion's opts
 * @returns {Promise<{mutations:object[], regions:Array}>}
 */
export async function textureBatch(candidateDeltas, ctx, opts = {}) {
  const { entities, edges, world, batchId, elapsedTimeDescriptor, note, fortuneBias, fortuneLabel, nudgeTags } = ctx;
  const regions = groupByRegion(candidateDeltas, edges);
  const mutations = [];
  for (const region of regions) {
    const sourceKind = region.deltas.some((d) => d.kind === "seed-propagated")
      ? "seeded-propagation"
      : "ambient-decay";
    const regionMutations = await textureRegion(
      region,
      { entities, edges, world, batchId, sourceKind, elapsedTimeDescriptor, note, fortuneBias, fortuneLabel, nudgeTags },
      opts
    );
    mutations.push(...regionMutations);
  }
  return { mutations, regions };
}
