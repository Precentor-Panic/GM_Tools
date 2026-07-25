/**
 * Writeup-import — pure Node, but NOT Foundry-free in the strict "no
 * outbound network call" sense (proposeWfiFromWriteup drives a real
 * Anthropic API call, same as mutation-engine/texture.mjs and
 * time-skip/resolve-seed.mjs).
 *
 * Phase 5 ("bring your own world"): given freeform text, propose a
 * WFI-shaped document (task 5.1), dry-run it through
 * foundry_worldFabric/scripts/data/interchange.mjs's importGraph() WITHOUT
 * persisting (task 5.2), and convert the dry-run's effective changes into a
 * normal review-state.mjs batch — the same review gate (diff, headline/grain,
 * accept/reject/regenerate, dual-path commit) every other mutation batch in
 * this project already goes through.
 *
 * importGraph already does name-based dedup (findExisting: case-insensitive
 * name+type match against existing entities), stub-entity creation for
 * edges referencing not-yet-described endpoints by name (resolveEndpoint),
 * and a derivation pass (runDerivation) — this module does NOT reimplement
 * any of that (see plans/phase-5-tasks.md's own reasoning). It only (a)
 * gets an LLM to produce a WFI-shaped proposal in importGraph's own
 * hand-authorable, name-referencing format, and (b) routes importGraph's
 * OUTPUT back into StoredMutation-shaped entries for review, using the SAME
 * name+type key importGraph's own findExisting/addToIndexes already use
 * (interchange.mjs's `${type}::${name.trim().toLowerCase()}` convention) —
 * purely to relate a proposal item back to which merged result it produced,
 * never to make an independent merge decision of its own.
 *
 * Edge dedup note (a real finding from reading importGraph closely, not
 * assumed): importGraph has NO edge-level dedup at all. normalizeEdge always
 * assigns `id: e.id ?? makeId()`, and this module's proposal never supplies
 * an edge id (edges only ever reference endpoints by NAME, per WFI's own
 * hand-authorable convention) — so every wfi.edges entry importGraph
 * processes is unconditionally a fresh id, meaning `edges.has(norm.id)` is
 * always false and `summary.edgesUpdated` never increments for anything
 * this module proposes. Every edge this module's dry run produces is
 * therefore always a CREATE, never an update — confirmed by reading
 * importGraph's edge loop, not assumed. Re-importing the same writeup twice
 * would create duplicate edges; this is importGraph's own existing,
 * unmodified behavior, not a gap introduced here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { callModel, fillTemplate as fillTemplateShared, parseJsonResponse } from "../mutation-engine/llm-call.mjs";
import { createBatch } from "../mutation-engine/review-state.mjs";
import { summarizeBatch, renderHeadline } from "../mutation-engine/grain.mjs";
import { attachDiffs } from "../time-skip/run.mjs";
import { importGraph, WFI_VERSION } from "../../foundry_worldFabric/scripts/data/interchange.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "writeup-import.md"), "utf8");

export const DEFAULT_WRITEUP_IMPORT_MODEL = "claude-sonnet-5";

// Simple v1 length guard (gm-tools-conventions / task 5.1: "a simple length
// guard with a clear error is enough for v1, don't over-build a chunking
// system speculatively"). ~40k characters is comfortably within any current
// Claude model's context window on the input side; the real risk this
// guards against is a huge, unbounded EXTRACTION (and therefore output
// token count / cost / validation-reliability) from a truly massive wiki
// export, not literally exceeding context.
export const MAX_WRITEUP_CHARS = 40000;

// All mutations from one writeup-import call land in a single synthetic
// region — there is no BFS/connectivity clustering concept for a holistic
// text-extraction pass the way there is for texture.mjs's propagated
// deltas. Matches the precedent of other synthetic single-region ids in
// this codebase (e.g. pending-ledger's "region-pending-sweep").
export const WRITEUP_IMPORT_REGION_ID = "writeup-import";

export class WriteupTooLargeError extends Error {
  constructor(message, { length, max } = {}) {
    super(message);
    this.name = "WriteupTooLargeError";
    this.length = length;
    this.max = max;
  }
}

export class WriteupImportValidationError extends Error {
  constructor(message, { attempts, lastError, rawResponse } = {}) {
    super(message);
    this.name = "WriteupImportValidationError";
    this.attempts = attempts;
    this.lastError = lastError;
    this.rawResponse = rawResponse;
  }
}

/**
 * Thrown by the wf_regenerate dispatch (wf-mcp-server/index.mjs) when asked
 * to regenerate a writeup-import batch at scope='entity' — see
 * regenerateWriteupImport's own doc comment for why that granularity isn't
 * supported.
 */
export class WriteupImportRegenerateScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = "WriteupImportRegenerateScopeError";
  }
}

// The Layer-0 entity type vocabulary wf-mcp-server's own tools already
// constrain to (see index.mjs's wf_get_entities_by_type inputSchema) —
// reused here rather than inventing a second list.
const EntityType = z.enum(["person", "place", "faction", "object", "event", "concept"]);

const RawWfiEntity = z.object({
  name: z.string().min(1),
  type: EntityType,
  description: z.string().optional(),
  summary: z.string().optional(),
  importance: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  attributes: z.record(z.string(), z.any()).optional(),
  rationale: z.string()
});

const RawWfiEdge = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  relationshipType: z.string().optional(),
  label: z.string().optional(),
  strength: z.number().min(0).max(1).optional(),
  valence: z.enum(["positive", "negative", "neutral"]).optional(),
  notes: z.string().optional(),
  rationale: z.string()
});

const RawWfiProposal = z.object({
  entities: z.array(RawWfiEntity),
  edges: z.array(RawWfiEdge)
});

function fillTemplate(vars) {
  return fillTemplateShared(PROMPT_TEMPLATE, vars);
}

/**
 * Task 5.1: turn freeform text into a WFI-shaped proposal — entities/edges
 * in interchange.mjs's own hand-authorable, name-referencing format (never
 * an id), each carrying a `rationale` (WFI itself doesn't validate this
 * extra field; it's carried informally here until previewWriteupImport
 * converts each item into a real StoredMutation).
 *
 * Same retry-once -> typed-error-on-second-failure convention as
 * texture.mjs/resolve-seed.mjs.
 *
 * @param {string} writeupText
 * @param {object} [opts]
 * @param {string} [opts.note]  steering note for a regenerate (folded into the
 *                                same {{retryNote}} template slot texture.mjs uses)
 * @param {object} [opts.client]  injectable Anthropic-SDK-shaped client (for tests/DI)
 * @param {string} [opts.apiKey]
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{version:number, entities:object[], edges:object[]}>}
 * @throws {WriteupTooLargeError} writeupText exceeds MAX_WRITEUP_CHARS
 * @throws {WriteupImportValidationError} model output never validates after one retry
 */
export async function proposeWfiFromWriteup(writeupText, opts = {}) {
  if (typeof writeupText !== "string" || !writeupText.trim()) {
    throw new Error("proposeWfiFromWriteup requires non-empty writeupText.");
  }
  if (writeupText.length > MAX_WRITEUP_CHARS) {
    throw new WriteupTooLargeError(
      `Writeup is ${writeupText.length} characters, over the ${MAX_WRITEUP_CHARS}-character v1 guard. ` +
      `Trim it or split it into multiple smaller writeup-import calls — chunking isn't built yet.`,
      { length: writeupText.length, max: MAX_WRITEUP_CHARS }
    );
  }

  const basePrompt = fillTemplate({
    writeupText,
    retryNote: opts.note ? `Additional note from the reviewer: ${opts.note}` : ""
  });

  let prompt = basePrompt;
  let lastError;
  let lastRaw;
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = await callModel(prompt, {
      ...opts,
      model: opts.model ?? DEFAULT_WRITEUP_IMPORT_MODEL,
      maxTokens: opts.maxTokens ?? 4096
    });
    lastRaw = raw;
    try {
      const parsed = parseJsonResponse(raw);
      const validated = RawWfiProposal.parse(parsed);
      return { version: WFI_VERSION, entities: validated.entities, edges: validated.edges };
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        prompt =
          basePrompt +
          `\n\nYour previous response failed validation with this error — fix it and respond with ONLY ` +
          `the corrected JSON object, no prose:\n${err.message}\n\nYour previous response was:\n${raw}`;
      }
    }
  }

  throw new WriteupImportValidationError(
    `Writeup-import proposal failed validation twice: ${lastError?.message}`,
    { attempts: maxAttempts, lastError, rawResponse: lastRaw }
  );
}

/** Same key format interchange.mjs's own addToIndexes/findExisting use internally. */
function entityKey(type, name) {
  return `${type}::${String(name).trim().toLowerCase()}`;
}

// The reviewable field subset for an entity mutation's `data` — matches
// diff.mjs's ENTITY_DIFF_FIELDS plus the handful of extra fields
// prompts/texture.md's own "entity:" field list documents as settable,
// so a writeup-import mutation's `data` shape matches what every other
// producer in this codebase already writes.
function entityMutationData(entity) {
  const { name, type, description, summary, importance, imageUrl, tags, attributes, foundryRef, namespace } = entity;
  return { name, type, description, summary, importance, imageUrl, tags, attributes, foundryRef, namespace };
}

// Edge mutation `data` — EDGE_DIFF_FIELDS plus sourceId/targetId, which a
// CREATE needs (applyHeadless's own upsert_edge path requires them when
// there's no existing edge to merge onto — see headless-apply.mjs).
function edgeMutationData(edge) {
  const { sourceId, targetId, relationshipType, label, strength, valence, notes } = edge;
  return { sourceId, targetId, relationshipType, label, strength, valence, notes };
}

/**
 * Task 5.2: dry-run a WFI proposal through importGraph WITHOUT persisting,
 * and convert its effective changes into raw StoredMutation-shaped entries
 * (missing only what review-state.mjs's createBatch itself attaches:
 * mutationId/status; `batchId` is a placeholder, overwritten by createBatch).
 *
 * importGraph is pure (doesn't mutate `existingSnapshot`), so this is
 * inherently a safe, side-effect-free preview — nothing is written anywhere
 * by this function.
 *
 * ID-STABILITY NOTE (a real bug found and fixed via this phase's own
 * end-to-end smoke test, not assumed away): every OTHER mutation producer in
 * this codebase (texture.mjs, rollback.mjs's restore mutations) omits `id`
 * for a genuine create and lets it be assigned later, at actual apply time
 * (graph-import/headless-apply.mjs's own id-assignment-and-writeback
 * machinery, Phase 4 task 4.1) — safe for them because their candidateDeltas
 * only ever concern the graph's EXISTING structure; a batch never needs one
 * of its OWN creates to be referenced by another mutation in the SAME batch.
 * Writeup-import breaks that assumption: a writeup can introduce a brand-new
 * entity AND an edge to that same entity in one pass. If this function left
 * such a create's id unassigned, the create and the edge referencing it
 * would each get assigned a DIFFERENT id independently at apply time (the
 * create via headless-apply's own generator; the edge's sourceId/targetId
 * would still carry THIS function's dry-run-only id, now stale) — the edge
 * would dangle, and since importGraph's resolveEndpoint treats any
 * unresolvable ref as a NAME and auto-creates a stub for it, the result is a
 * phantom entity literally named after a stale id string. Confirmed via
 * wf-mcp-server/test/writeup-import-roundtrip.smoke.mjs before this fix
 * existed. The fix: this function pre-assigns and COMMITS to real, final ids
 * for every entity it creates (via importGraph's own makeId, injectable),
 * setting them as the mutation's top-level `id` — not omitted — so the same
 * id is reused consistently by the entity's own upsert and any edge
 * referencing it, regardless of which apply path (headless or live) or how
 * much later the batch is actually accepted+synced. This does not change
 * create-vs-update DISPLAY semantics anywhere downstream: attachDiffs/
 * rollback.mjs/grain.mjs all key off whether `id` resolves against the LIVE
 * snapshot, not off whether the mutation object carries an `id` field at
 * all, so a pre-assigned id that doesn't yet exist in the live graph still
 * renders as "(created)" and still rolls back via a genuine delete.
 *
 * @param {{entities:object[], edges:object[]}} proposal  proposeWfiFromWriteup's output
 * @param {{entities:object[], edges:object[], entityTypes?:object[]}} existingSnapshot
 * @param {object} [opts]
 * @param {"merge"|"replace"} [opts.mode="merge"]  passed to importGraph. NOTE: 'replace'
 *   only affects THIS preview's create/update classification (importGraph's own
 *   replace-mode semantics) — the actual commit path this batch is later applied through
 *   (wf_sync_to_foundry -> applyHeadless) always calls importGraph with mode:'merge'
 *   internally (see headless-apply.mjs), applying each mutation as an individual upsert.
 *   Choosing 'replace' here does NOT mean accepting this batch will delete anything from
 *   the real graph that isn't mentioned in it — see this module's own top-of-file note.
 * @param {() => string} [opts.makeId]  injectable id generator, for deterministic tests
 * @returns {{mutations:object[], summary:object, suggestions:Array}}
 */
export function previewWriteupImport(proposal, existingSnapshot, opts = {}) {
  const existing = {
    entities: existingSnapshot.entities ?? [],
    edges: existingSnapshot.edges ?? [],
    entityTypes: existingSnapshot.entityTypes ?? []
  };
  const wfi = { version: WFI_VERSION, entities: proposal.entities ?? [], edges: proposal.edges ?? [] };
  const importOpts = { mode: opts.mode ?? "merge", runDerivation: true };
  if (opts.makeId) importOpts.makeId = opts.makeId;
  const result = importGraph(wfi, existing, importOpts);

  const existingEntityIdSet = new Set(existing.entities.map((e) => e.id));
  const existingEdgeIdSet = new Set(existing.edges.map((e) => e.id));

  const resultEntityByKey = new Map();
  for (const e of result.entities) resultEntityByKey.set(entityKey(e.type, e.name), e);

  const entityMutations = [];
  const matchedResultIds = new Set();
  for (const pe of proposal.entities ?? []) {
    const resolved = resultEntityByKey.get(entityKey(pe.type, pe.name));
    if (!resolved) {
      throw new Error(
        `Internal error: proposal entity "${pe.name}" (${pe.type}) has no corresponding entity in importGraph's ` +
        `result — this should be impossible (importGraph either matches or creates every wfi.entities item).`
      );
    }
    matchedResultIds.add(resolved.id);
    // Always set `id` -- see this function's own ID-STABILITY doc comment
    // above for why writeup-import can't omit it for creates the way every
    // other producer does (a create and an edge referencing it, in the same
    // batch, must resolve to the SAME id at actual apply time).
    entityMutations.push({
      op: "upsert_entity",
      id: resolved.id,
      data: entityMutationData(resolved),
      rationale: pe.rationale,
      batchId: "placeholder",
      sourceKind: "writeup-import",
      regionId: WRITEUP_IMPORT_REGION_ID,
      entityContext: { name: resolved.name, importance: resolved.importance, tags: resolved.tags }
    });
  }

  // Stub entities: importGraph's own resolveEndpoint auto-creates one for an
  // edge endpoint named but not otherwise described by any proposal.entities
  // item (matches summary.stubsCreated). Anything in result.entities that
  // isn't pre-existing AND wasn't matched above must be one of these. Same
  // id-stability requirement applies -- a stub exists SPECIFICALLY because
  // an edge references it, so its id must be the same one that edge's
  // sourceId/targetId carries.
  const stubMutations = [];
  for (const e of result.entities) {
    if (existingEntityIdSet.has(e.id) || matchedResultIds.has(e.id)) continue;
    stubMutations.push({
      op: "upsert_entity",
      id: e.id,
      data: entityMutationData(e),
      rationale:
        `Stub entity auto-created because "${e.name}" is referenced by an edge in the writeup but not otherwise ` +
        `described — matches importGraph's existing referenced-but-undescribed-endpoint behavior.`,
      batchId: "placeholder",
      sourceKind: "writeup-import",
      regionId: WRITEUP_IMPORT_REGION_ID,
      entityContext: { name: e.name, importance: e.importance, tags: e.tags }
    });
  }

  // Edges: see this module's top-of-file note — importGraph never supplies
  // an id for one of our wfi.edges entries (we only ever reference
  // endpoints by name), so EVERY proposal edge is always classified a
  // CREATE, never an update. The filtered "new" edges below preserve
  // wfi.edges' original relative order: in merge mode, importGraph's
  // internal edges Map is populated with existing.edges first (their
  // original order), then wfi.edges are appended in wfi.edges' own order
  // (a Map.set on a brand-new key appends at the end of iteration order);
  // applyDerivation's `kept = edges.filter(e => e.source !== 'derived')`
  // preserves that relative order and only appends newly-computed derived
  // edges after. So filtering result.edges down to "not derived, not a
  // pre-existing id" yields exactly proposal.edges' own edges, in order.
  // This module's own RawWfiEdge schema requires non-empty source/target
  // strings, and previewWriteupImport always leaves createMissingEndpoints
  // at its default (true) — resolveEndpoint can only ever return null for
  // an empty ref, so with both of those true, importGraph can never skip
  // one of our edges. That makes the zip below exact, not a heuristic —
  // checked below rather than silently trusted.
  const newEdgeObjs = result.edges.filter((e) => e.source !== "derived" && !existingEdgeIdSet.has(e.id));
  const proposalEdges = proposal.edges ?? [];
  if (newEdgeObjs.length !== proposalEdges.length) {
    throw new Error(
      `Internal error: expected ${proposalEdges.length} newly-created edges from importGraph, found ` +
      `${newEdgeObjs.length}. This module's ordering/never-skipped assumptions (see its own doc comment) no ` +
      `longer hold — stopping rather than silently misattribute rationale to the wrong edge.`
    );
  }

  const edgeMutations = proposalEdges.map((pedge, i) => ({
    op: "upsert_edge",
    data: edgeMutationData(newEdgeObjs[i]),
    rationale: pedge.rationale,
    batchId: "placeholder",
    sourceKind: "writeup-import",
    regionId: WRITEUP_IMPORT_REGION_ID
  }));

  return {
    mutations: [...entityMutations, ...stubMutations, ...edgeMutations],
    summary: result.summary,
    suggestions: result.suggestions
  };
}

/**
 * Task 5.1 + 5.2 combined: propose from freeform text, dry-run the merge,
 * attach live-snapshot diffs (diff.mjs, via time-skip/run.mjs's attachDiffs —
 * the SAME diff path wf_propose_mutations uses, per task 5.2's own
 * instruction), and persist as a normal review-state.mjs batch. The full
 * pipeline wf_propose_from_writeup (task 5.3) calls into.
 *
 * @param {string} world
 * @param {string} text  the freeform writeup
 * @param {{entities:object[], edges:object[], entityTypes?:object[]}} existingSnapshot  the live snapshot
 * @param {object} [opts]
 * @param {"merge"|"replace"} [opts.mode]
 * @param {object} [opts.llmOpts]  forwarded to proposeWfiFromWriteup (injectable client, etc.)
 * @param {() => string} [opts.makeId]  batch id generator, injectable for tests
 * @returns {Promise<{batchId:string, mutationCount:number, importSummary:object, suggestions:Array, headline:string}>}
 */
export async function importWriteup(world, text, existingSnapshot, opts = {}) {
  const proposal = await proposeWfiFromWriteup(text, opts.llmOpts ?? {});
  const { mutations, summary, suggestions } = previewWriteupImport(proposal, existingSnapshot, { mode: opts.mode });
  const diffed = attachDiffs(mutations, existingSnapshot.entities ?? [], existingSnapshot.edges ?? []);

  const batch = createBatch(
    world,
    { mode: "writeup-import", text },
    opts.elapsedTimeDescriptor,
    diffed,
    opts.makeId ? { makeId: opts.makeId } : {}
  );
  const batchSummary = summarizeBatch(batch);

  return {
    batchId: batch.id,
    mutationCount: batch.mutations.length,
    importSummary: summary,
    suggestions,
    headline: renderHeadline(batchSummary)
  };
}

/**
 * Regenerate an ENTIRE writeup-import batch with a steering note — re-runs
 * task 5.1's LLM call against the batch's ORIGINALLY-STORED writeup text
 * (batch.scope.text, written by importWriteup above) plus `note`, then
 * re-runs task 5.2's dry-run against the CURRENT live snapshot, producing a
 * fresh mutation set that REPLACES the batch's existing writeup-import
 * mutations wholesale.
 *
 * Deliberately whole-batch only (see WriteupImportRegenerateScopeError):
 * writeup extraction is a single holistic pass over the whole source text,
 * not a per-entity delta the way texture.mjs's regenerate is — there's no
 * principled way to ask the model to "redo just this one extracted item"
 * without re-running the entire extraction, and re-running the entire
 * extraction can legitimately change WHICH entities/edges come out the
 * other end (not just their content), so a partial replace of "only the one
 * originally-targeted mutation" would be arbitrary/unsound. The caller
 * (wf-mcp-server's wf_regenerate dispatch) is responsible for rejecting
 * scope='entity' before calling this.
 *
 * @param {object} batch  the loaded Batch (must carry scope.text)
 * @param {string} note
 * @param {{entities:object[], edges:object[], entityTypes?:object[]}} existingSnapshot  the live snapshot
 * @param {object} [opts]
 * @param {"merge"|"replace"} [opts.mode]
 * @param {object} [opts.llmOpts]
 * @returns {Promise<{mutations:object[], summary:object, suggestions:Array}>}  diffed, NOT yet
 *   assigned mutationId/status — the caller merges these into the batch itself, mirroring
 *   wf_regenerate's existing textureRegion-based replace pattern.
 */
export async function regenerateWriteupImport(batch, note, existingSnapshot, opts = {}) {
  const originalText = batch.scope?.text;
  if (typeof originalText !== "string" || !originalText) {
    throw new Error(
      `Batch "${batch.id}" has no original writeup text recorded at batch.scope.text — cannot regenerate a ` +
      `writeup-import batch without it. (Expected for any batch created by importWriteup(); if this batch was ` +
      `hand-authored or predates Phase 5, regeneration isn't possible.)`
    );
  }
  const proposal = await proposeWfiFromWriteup(originalText, { ...(opts.llmOpts ?? {}), note });
  const { mutations, summary, suggestions } = previewWriteupImport(proposal, existingSnapshot, { mode: opts.mode });
  const diffed = attachDiffs(mutations, existingSnapshot.entities ?? [], existingSnapshot.edges ?? []);
  return { mutations: diffed, summary, suggestions };
}
