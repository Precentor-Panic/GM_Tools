/**
 * Session Wrap — pure orchestration, no HTTP/route plumbing of its own.
 *
 * The post-session flow that closes the loop the narrative-state sidecar
 * (mutation-engine/narrative-state.mjs) opened: after a session, the GM
 * reviews which withheld truths the table actually learned, applies reveal
 * transitions for those entities, and gets a player-facing "truth notes"
 * recap to hand out. Three steps, three exported functions:
 *
 *   listWrapCandidates    -- pure read: every not-yet-fully-revealed record
 *   suggestWrapTransitions -- ONE cheap (haiku) LLM call: SUGGESTS forward
 *                             moves given this session's notes; never writes
 *   applyWrapTransitions   -- the GM's approved decisions, written directly
 *   generateTruthNotes     -- ONE sonnet LLM call over ONLY the entities the
 *                             GM just revealed; persists via truth-notes.mjs
 *
 * WRITE DISCIPLINE (read this before touching anything below): reveal
 * transitions applied by `applyWrapTransitions` are DIRECT sidecar writes,
 * with NO review-state batch in between -- unlike every graph-mutation flow
 * in this codebase. This is not a shortcut around the no-silent-auto-write
 * invariant; that invariant governs writes to the World Fabric GRAPH, and
 * this flow never touches the graph at all (same precedent narrative-
 * state.mjs's own header already establishes for setRevealState in
 * general). The GM's own approval step in the Wrap UI -- picking which
 * suggested transitions to accept, then calling applyWrapTransitions with
 * exactly those decisions -- IS the review gate for this flow, playing the
 * same role a batch accept plays elsewhere. The LLM call in
 * suggestWrapTransitions only ever SUGGESTS (returned to the caller, never
 * applied here); nothing moves a reveal state until the GM's own decisions
 * reach applyWrapTransitions explicitly.
 *
 * PLAYER-SAFETY SPLIT ACROSS THE TWO PROMPTS (read prompts/wrap-transitions.md
 * and prompts/truth-notes.md's own headers too): suggestWrapTransitions is a
 * GM-ONLY prompt and deliberately includes full truth text for every
 * withheld candidate -- narrative-gate.mjs's allusion/withheld-guidance
 * machinery does not apply to it, because nothing in that prompt or its
 * response is ever shown to a player. generateTruthNotes is the opposite:
 * its prompt is built from ONLY the entities in the `revealedEntityIds` the
 * GM just approved -- no still-withheld record's name or truth may enter
 * that prompt at all. This is the one invariant a code change to this file
 * must never weaken.
 */
import { getWorldClock } from "./world-clock.mjs";
import { assembleWriteupTextForPlan } from "./plan-updates.mjs";
import { saveTruthNotes } from "./truth-notes.mjs";
import {
  RevealState,
  listNarrativeState,
  getNarrativeState,
  setRevealState
} from "../mutation-engine/narrative-state.mjs";
import { commitWorldTimeline } from "../mutation-engine/world-timeline.mjs";
import { callModelDetailed, fillTemplate, parseJsonResponse } from "../mutation-engine/llm-call.mjs";
import { loadSnapshot } from "../wf-mcp-server/lib/snapshot.mjs";
import { findEntity } from "../wf-mcp-server/lib/graph.mjs";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAP_TRANSITIONS_PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "wrap-transitions.md"), "utf8");
const TRUTH_NOTES_PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "truth-notes.md"), "utf8");

// Cheap-suggester tier (a "did the notes brush this?" skim, not creative
// generation) vs. the genuine player-facing prose tier -- same two-tier split
// as every other LLM-backed module in this project (see element-assist.mjs).
export const DEFAULT_WRAP_SUGGEST_MODEL = "claude-haiku-4-5";
export const DEFAULT_TRUTH_NOTES_MODEL = "claude-sonnet-5";

function formatClockSummary(clock) {
  if (!clock) return null;
  return clock.cadence ? `${clock.value}/${clock.max} (${clock.cadence})` : `${clock.value}/${clock.max}`;
}

/**
 * Every narrative-state record not yet fully `revealed`, with names joined
 * from the live snapshot where available.
 *
 * @param {string} dir
 * @param {string} world
 * @returns {{candidates: Array<{entityId:string, entityName:string, revealState:string, stance?:string, truth?:string, clockSummary?:string}>}}
 */
export function listWrapCandidates(dir, world) {
  const records = listNarrativeState(dir, world).filter((r) => r.revealState !== "revealed");

  // Snapshot lookup is best-effort: a missing/unreadable snapshot must never
  // block listing candidates -- it just means names fall back to raw ids.
  let entitiesById = new Map();
  try {
    const { entities } = loadSnapshot(dir, world).snapshot;
    entitiesById = new Map(entities.map((e) => [e.id, e]));
  } catch {
    entitiesById = new Map();
  }

  const candidates = records.map((r) => {
    const entity = entitiesById.get(r.entityId);
    const clockSummary = formatClockSummary(r.clock);
    return {
      entityId: r.entityId,
      entityName: entity?.name ?? r.entityId,
      revealState: r.revealState,
      ...(r.stance ? { stance: r.stance } : {}),
      ...(r.truth ? { truth: r.truth } : {}),
      ...(clockSummary ? { clockSummary } : {})
    };
  });

  return { candidates };
}

function renderCandidateRoster(candidates) {
  if (!candidates.length) return "(no withheld entities recorded yet)";
  return candidates
    .map((c) => {
      const lines = [`- entityId: ${c.entityId}`, `  name: ${c.entityName}`, `  revealState: ${c.revealState}`];
      if (c.stance) lines.push(`  stance: ${c.stance}`);
      if (c.truth) lines.push(`  truth: ${c.truth}`);
      if (c.clockSummary) lines.push(`  clock: ${c.clockSummary}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * ONE cheap (haiku-tier) LLM call: given this session's own scene notes
 * (assembleWriteupTextForPlan, reused verbatim -- never re-derived) and the
 * full withheld roster (GM-side, truth text included -- see this module's
 * header), suggest which entities' reveal states should move forward this
 * session. Validates every suggestion against the real candidate set before
 * returning it -- an invented entityId or an invalid revealState is DROPPED,
 * never invented/coerced, and reported back in `dropped` so the caller can
 * show the GM what was discarded and why.
 *
 * A roster with no candidates at all skips the LLM call entirely (there is
 * nothing to suggest over) rather than spending a real API call to learn
 * that -- a deliberate cost-avoidance call, not a spec requirement, and
 * byte-compatible with the documented return shape either way.
 *
 * @param {string} dir
 * @param {string} world
 * @param {string} planId
 * @param {object} [opts]
 * @param {object} [opts.client]   injectable Anthropic-SDK-shaped client (tests / DI); real client built from opts.apiKey otherwise
 * @param {string} [opts.apiKey]
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{suggestions: Array<{entityId:string, suggestedState:string, rationale:string}>, dropped: Array<{entityId:*, suggestedState:*, reason:string}>, candidateCount:number}>}
 */
export async function suggestWrapTransitions(dir, world, planId, opts = {}) {
  const { candidates } = listWrapCandidates(dir, world);
  if (!candidates.length) {
    return { suggestions: [], dropped: [], candidateCount: 0 };
  }

  const { entities } = loadSnapshot(dir, world).snapshot;
  const entityNameById = new Map(entities.map((e) => [e.id, e.name]));
  const { text: sessionNotes } = assembleWriteupTextForPlan(world, planId, entityNameById);

  const prompt = fillTemplate(WRAP_TRANSITIONS_PROMPT_TEMPLATE, {
    candidateRoster: renderCandidateRoster(candidates),
    sessionNotes: sessionNotes.trim() || "(no scene notes recorded for this plan yet)"
  });

  const { text } = await callModelDetailed(prompt, {
    client: opts.client,
    apiKey: opts.apiKey,
    model: opts.model ?? DEFAULT_WRAP_SUGGEST_MODEL,
    maxTokens: opts.maxTokens ?? 1024
  });

  const parsed = parseJsonResponse(text);
  const rawSuggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];

  const candidateIds = new Set(candidates.map((c) => c.entityId));
  const suggestions = [];
  const dropped = [];
  for (const s of rawSuggestions) {
    const entityId = s?.entityId;
    const suggestedState = s?.suggestedState;
    const validId = typeof entityId === "string" && candidateIds.has(entityId);
    const validState = RevealState.safeParse(suggestedState).success;
    if (validId && validState) {
      suggestions.push({ entityId, suggestedState, rationale: String(s?.rationale ?? "") });
    } else {
      dropped.push({ entityId, suggestedState, reason: !validId ? "unknown entityId" : "invalid revealState" });
    }
  }

  return { suggestions, dropped, candidateCount: candidates.length };
}

/**
 * Apply the GM's approved reveal-state decisions directly -- no review
 * batch (see this module's header for why that's correct here). Each
 * decision goes through narrative-state.mjs's own setRevealState, which
 * already guarantees same-state idempotency (a safe no-op, nothing
 * written) and appends to the append-only transition history.
 *
 * Best-effort commits the world timeline afterward (commitWorldTimeline
 * NEVER throws -- its own result, `{committed, warning}` or `{committed,
 * sha}`, is passed straight through as `timeline`) so a Wrap session's
 * reveal-state changes land in the same per-world git history as any other
 * batch, using the Plan id as the timeline's batchId label when available.
 *
 * @param {string} dir
 * @param {string} world
 * @param {Array<{entityId:string, to:string, note?:string}>} decisions
 * @param {object} [opts]
 * @param {string} [opts.planId]   used only for the timeline commit's batchId label
 * @param {string} [opts.now]      forwarded to setRevealState for deterministic tests
 * @returns {{applied: Array<{entityId:string, to:string}>, sessionNumber:number|null, timeline:object}}
 */
export function applyWrapTransitions(dir, world, decisions, opts = {}) {
  const sessionNumber = getWorldClock(world).sessionNumber ?? null;

  const applied = decisions.map((d) => {
    setRevealState(dir, world, d.entityId, d.to, { source: "wrap", note: d.note, sessionNumber }, { now: opts.now });
    return { entityId: d.entityId, to: d.to };
  });

  const timeline = commitWorldTimeline(dir, world, {
    batchId: opts.planId ?? "wrap",
    movedTime: false,
    action: "session-wrap"
  });

  return { applied, sessionNumber, timeline };
}

function renderRevealedRoster(records) {
  if (!records.length) return "(nothing was revealed this session)";
  return records
    .map((r) => {
      const lines = [`- ${r.name}`];
      if (r.stance) lines.push(`  stance: ${r.stance}`);
      if (r.truth) lines.push(`  truth: ${r.truth}`);
      if (r.description) lines.push(`  surface description (already known to the table): ${r.description}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * ONE sonnet-tier LLM call producing the player-facing "What you've
 * learned" recap. CRITICAL PLAYER-SAFETY INVARIANT (see this module's
 * header): the prompt is built from ONLY the entities named in
 * `revealedEntityIds` -- no still-withheld record's name or truth ever
 * enters this function's prompt, because nothing outside that explicit id
 * list is ever read into it.
 *
 * @param {string} dir
 * @param {string} world
 * @param {string} planId
 * @param {string[]} revealedEntityIds   exactly the entities the GM just approved as revealed
 * @param {object} [opts]
 * @param {object} [opts.client]
 * @param {string} [opts.apiKey]
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens]
 * @param {string} [opts.now]
 * @param {() => string} [opts.makeId]
 * @returns {Promise<object>}   the newly-saved, now-current truth-notes entry (session-planner/truth-notes.mjs's TruthNotesEntry shape)
 */
export async function generateTruthNotes(dir, world, planId, revealedEntityIds, opts = {}) {
  const { entities } = loadSnapshot(dir, world).snapshot;

  const records = revealedEntityIds.map((entityId) => {
    const entity = findEntity(entities, entityId);
    const narrativeRecord = getNarrativeState(dir, world, entityId);
    return {
      name: entity?.name ?? entityId,
      truth: narrativeRecord?.truth ?? "",
      stance: narrativeRecord?.stance ?? null,
      description: entity?.description ?? ""
    };
  });

  const prompt = fillTemplate(TRUTH_NOTES_PROMPT_TEMPLATE, {
    revealedRoster: renderRevealedRoster(records)
  });

  const { text } = await callModelDetailed(prompt, {
    client: opts.client,
    apiKey: opts.apiKey,
    model: opts.model ?? DEFAULT_TRUTH_NOTES_MODEL,
    maxTokens: opts.maxTokens ?? 1024
  });

  const parsed = parseJsonResponse(text);
  const markdown = String(parsed?.markdown ?? "").trim();

  const sessionNumber = getWorldClock(world).sessionNumber ?? null;
  return saveTruthNotes(world, planId, { sessionNumber, revealedEntityIds, markdown }, { now: opts.now, makeId: opts.makeId });
}
