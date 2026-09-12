/**
 * Participant selector — WS-4 (opforce-plan-2026-09-12.md §3). PURE, no I/O,
 * no LLM call (`selectParticipants` itself never imports the shared
 * model-call plumbing module living at mutation-engine/ under the name
 * "llm(hyphen)call.mjs", nor the model vendor's own SDK — the module's own test file
 * greps this source directly to confirm it, the same convention
 * encounter-heuristic.mjs's own test file already established, including
 * this comment's own trick of not spelling that filename out verbatim so it
 * doesn't trip the same grep). Builds on combat-planning/
 * encounter-heuristic.mjs's already-tested `scoreCombination` rather than
 * re-deriving any scoring math of its own — this file is search/selection
 * strategy ONLY, never a second scoring implementation.
 *
 * `selectParticipants({party, candidatePool, targetDifficulty, tags, knobs, k})`
 * returns up to `k` DIVERSE compositions for the same target difficulty, via
 * a small beam search over `(entryId, count)` states:
 *   - Every state is scored by `scoreCombination` — the identical math
 *     `suggestEncounter`/a DM's manual roster edit already use, so a
 *     composition this returns is exactly as trustworthy as any other
 *     encounter-heuristic output, never a parallel/drifting number.
 *   - A THEMATIC PREFILTER runs first, deterministically, via tags.mjs's own
 *     `filterByTagsAnd` (AND semantics) when `tags` is given — the SAME
 *     prefilter mechanism the rest of the Library already uses, not a new
 *     matching scheme.
 *   - DIVERSITY is enforced by ARCHETYPE, not by brute permutation: every
 *     finished state classifies as exactly one of `"solo"` (1 unit total),
 *     `"duo"` (2 units total, same or different entryId), `"swarm"` (3+
 *     units, all the SAME entryId), or `"mixed"` (3+ units, 2+ distinct
 *     entryIds) — a pure function of the composition's own shape, never a
 *     tag or a caller hint. The result picks AT MOST ONE composition per
 *     archetype (the closest-to-target one in that archetype) unless `k`
 *     exceeds the 4 available archetypes, in which case additional picks
 *     cycle through archetypes again taking each one's next-best.
 *   - DETERMINISTIC given the same inputs: every sort has an explicit,
 *     total tie-break key (a canonical `entryId×count` string), and nothing
 *     in this file calls `Math.random`/`Date.now` — two calls with identical
 *     arguments return byte-identical output.
 *
 * `knobs` (all optional, additive to encounter-heuristic.mjs's own knobs,
 * which are forwarded to `scoreCombination` unchanged):
 *   - `maxMonsters` (default 8) — hard cap on a composition's TOTAL unit
 *     count (sum of every unit's `count`), enforced during the search itself
 *     (a capped state is never expanded further), not filtered after the
 *     fact.
 *   - `allowSolo` (default true) — when `false`, no returned composition is
 *     ever a single lone monster (the "solo" archetype is excluded from
 *     selection outright; states with a single unit are still generated and
 *     scored internally as search stepping-stones toward duo/swarm/mixed,
 *     they are just never THEMSELVES offered as a result).
 *   - `preferTags` (default []) — a soft tie-break only: among
 *     otherwise-equally-close-to-target expansions during the search, one
 *     whose candidate entry carries more of these tags (checked on both the
 *     entry's own top-level `tags[]`, tags.mjs's convention, and
 *     `rawFields.tags[]`, the Plutonium-index convention) is preferred. This
 *     NEVER changes any composition's `score` — only which entryIds the
 *     search reaches for when multiple choices score identically.
 */
import { scoreCombination } from "./encounter-heuristic.mjs";
import { computeActionEconomyScore } from "./action-economy.mjs";
import { filterByTagsAnd } from "./tags.mjs";

const DEFAULT_K = 3;
const DEFAULT_MAX_MONSTERS = 8;
const BEAM_WIDTH = 6;
// A finished state whose OWN score already overshoots the target by more
// than this much is never expanded further (adding more units can only grow
// the score) -- mirrors encounter-heuristic.mjs's buildCombination's own
// 20%-overshoot-ceiling guard, loosened slightly (30%) since this search
// also needs room to reach swarm/mixed archetypes past the single best-fit
// count.
const OVERSHOOT_CEILING_PCT = 1.3;

// Fixed enumeration order -- see the module header. Exactly 4 archetypes,
// which is where the "k exceeds 4" language in the task spec comes from.
const ARCHETYPE_ORDER = ["solo", "duo", "swarm", "mixed"];

/** PURE. A composition's units[] -> its archetype, by shape alone. */
export function classifyArchetype(units) {
  const totalCount = units.reduce((sum, u) => sum + u.count, 0);
  const distinctTypes = units.length;
  if (totalCount <= 1) return "solo";
  if (totalCount === 2) return "duo";
  return distinctTypes === 1 ? "swarm" : "mixed";
}

/** PURE, internal. A canonical, sorted string key for a units[] array -- the determinism/dedup backbone of the whole search. */
function combinationKey(units) {
  return units.map((u) => `${u.entryId}x${u.count}`).sort().join("|");
}

/** PURE, internal. How many of `preferTags` a candidate entry carries, checking both this module's own top-level `tags[]` convention and the Plutonium-index `rawFields.tags[]` one. */
function preferredTagMatchCount(entry, preferTags) {
  if (!preferTags.length) return 0;
  const entryTags = new Set([
    ...(Array.isArray(entry?.tags) ? entry.tags : []),
    ...(Array.isArray(entry?.rawFields?.tags) ? entry.rawFields.tags : [])
  ]);
  return preferTags.reduce((n, t) => n + (entryTags.has(t) ? 1 : 0), 0);
}

/**
 * PURE, internal. Whether this entry's threat is CR-derived rather than
 * attack-derived -- action-economy.mjs's own `breakdown.crFallbackApplied`,
 * preferring an already-attached `derivedScore` (bestiary-store.mjs's
 * acceptBestiaryEntry now always stamps this shape, WS-4 §0.7 defect fix
 * (b)/(c)) and falling back to a fresh compute for a candidate that has none
 * (matches encounter-heuristic.mjs's own candidateThreat fallback).
 */
function isCrDerived(entry) {
  const breakdown = entry?.derivedScore?.breakdown ?? computeActionEconomyScore(entry?.rawFields ?? {}).breakdown;
  return Boolean(breakdown?.crFallbackApplied);
}

/** PURE, internal. Short, deterministic human-readable notes for one finished, chosen composition. */
function buildNotes(units, archetype, candidateByEntryId, scored) {
  const totalCount = units.reduce((sum, u) => sum + u.count, 0);
  const notes = [
    `${archetype} composition: ${totalCount} unit${totalCount === 1 ? "" : "s"} across ${units.length} distinct type${units.length === 1 ? "" : "s"}.`
  ];
  const crDerivedCount = units.filter((u) => isCrDerived(candidateByEntryId.get(u.entryId))).length;
  if (crDerivedCount > 0) {
    notes.push(
      `${crDerivedCount} of ${units.length} type${units.length === 1 ? "" : "s"} ${crDerivedCount === 1 ? "has" : "have"} no attack data -- ` +
      `threat is CR-derived, not attack-derived (see action-economy.mjs's crFallbackApplied).`
    );
  }
  if (scored.asymmetricRiskFlag) {
    notes.push("Burst ceiling exceeds the party's risk threshold -- a synchronized worst-case round could hit hard.");
  }
  return notes;
}

/**
 * @param {object} args
 * @param {Array<object>} args.party            combat-planning/party-roster-store.mjs's PartyMember-shaped entries (or {combatRelevant} subsets), forwarded to scoreCombination unchanged
 * @param {Array<object>} args.candidatePool     bestiary entries {entryId, rawFields, derivedScore, tags?} -- already thematically filtered by the caller if desired, or left for this function's own `tags` filter below
 * @param {number} args.targetDifficulty         same arbitrary scale as encounter-heuristic.mjs's own targetDifficulty
 * @param {string[]} [args.tags]                 AND-filtered via tags.mjs's filterByTagsAnd before search starts
 * @param {object} [args.knobs]                  forwarded to scoreCombination, plus this module's own maxMonsters/allowSolo/preferTags (see header)
 * @param {number} [args.k=3]
 * @returns {Array<{archetype:"solo"|"duo"|"swarm"|"mixed", units:Array<{entryId:string,count:number}>, score:number, xpBudget:number, notes:string[]}>}
 */
export function selectParticipants({ party, candidatePool, targetDifficulty, tags, knobs = {}, k = DEFAULT_K }) {
  const maxMonsters = Number.isFinite(knobs.maxMonsters) && knobs.maxMonsters > 0
    ? Math.floor(knobs.maxMonsters)
    : DEFAULT_MAX_MONSTERS;
  const allowSolo = knobs.allowSolo !== false;
  const preferTags = Array.isArray(knobs.preferTags) ? knobs.preferTags : [];

  const pool = filterByTagsAnd(candidatePool ?? [], tags).filter((e) => e && typeof e.entryId === "string");
  const sortedPool = [...pool].sort((a, b) => a.entryId.localeCompare(b.entryId));
  if (sortedPool.length === 0 || k <= 0) return [];

  const candidateByEntryId = new Map(sortedPool.map((c) => [c.entryId, c]));
  const overshootCeiling = targetDifficulty * OVERSHOOT_CEILING_PCT;

  const scoreUnits = (units) => scoreCombination({ combination: units, candidatePool: sortedPool, party, knobs });

  // finished: combinationKey -> {units, scored} -- every state this search
  // EVER generates, regardless of whether it survived into the next beam.
  // Small/short-lived states (a swarm/mixed shape that never won the
  // closest-to-target race) still need to be selectable for diversity.
  const finished = new Map();
  const record = (units, scored) => {
    const key = combinationKey(units);
    if (!finished.has(key)) finished.set(key, { units, scored });
  };

  let beam = sortedPool.map((entry) => {
    const units = [{ entryId: entry.entryId, count: 1 }];
    const scored = scoreUnits(units);
    record(units, scored);
    return { units, scored };
  });

  for (let step = 1; step < maxMonsters; step++) {
    const expansions = [];
    for (const state of beam) {
      const totalCount = state.units.reduce((sum, u) => sum + u.count, 0);
      if (totalCount >= maxMonsters || state.scored.expectedScore >= overshootCeiling) continue;

      // Expansion A: one more copy of an entryId already in this state.
      for (const u of state.units) {
        const nextUnits = state.units.map((x) => (x.entryId === u.entryId ? { ...x, count: x.count + 1 } : x));
        expansions.push({ units: nextUnits, scored: scoreUnits(nextUnits) });
      }
      // Expansion B: a new distinct entryId at count 1.
      const present = new Set(state.units.map((u) => u.entryId));
      for (const entry of sortedPool) {
        if (present.has(entry.entryId)) continue;
        const nextUnits = [...state.units, { entryId: entry.entryId, count: 1 }];
        expansions.push({ units: nextUnits, scored: scoreUnits(nextUnits) });
      }
    }
    if (expansions.length === 0) break;
    for (const e of expansions) record(e.units, e.scored);

    // Rank: closest to target first, then the preferTags soft tie-break,
    // then the canonical key -- a total order, so the beam trim below is
    // deterministic even when several expansions score identically.
    const rank = (s) => {
      const closeness = Math.abs(s.scored.expectedScore - targetDifficulty);
      const prefBonus = -s.units.reduce((sum, u) => sum + preferredTagMatchCount(candidateByEntryId.get(u.entryId), preferTags), 0);
      return [closeness, prefBonus, combinationKey(s.units)];
    };
    expansions.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra[0] !== rb[0]) return ra[0] - rb[0];
      if (ra[1] !== rb[1]) return ra[1] - rb[1];
      return ra[2].localeCompare(rb[2]);
    });

    const seenKeys = new Set();
    beam = [];
    for (const e of expansions) {
      const key = combinationKey(e.units);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      beam.push(e);
      if (beam.length >= BEAM_WIDTH) break;
    }
  }

  // Group every finished state by archetype, each group sorted
  // closest-to-target first (canonical key as the final tie-break).
  const byArchetype = new Map(ARCHETYPE_ORDER.map((a) => [a, []]));
  for (const { units, scored } of finished.values()) {
    const archetype = classifyArchetype(units);
    if (archetype === "solo" && !allowSolo) continue;
    byArchetype.get(archetype).push({ units, scored, key: combinationKey(units), closeness: Math.abs(scored.expectedScore - targetDifficulty) });
  }
  for (const group of byArchetype.values()) {
    group.sort((a, b) => a.closeness - b.closeness || a.key.localeCompare(b.key));
  }

  // First pass: at most one composition per archetype (its own best fit),
  // in ARCHETYPE_ORDER -- this alone satisfies k <= 4 (the archetype count).
  const picked = [];
  const pickedKeys = new Set();
  const cursor = new Map(ARCHETYPE_ORDER.map((a) => [a, 0]));
  for (const archetype of ARCHETYPE_ORDER) {
    if (picked.length >= k) break;
    const group = byArchetype.get(archetype);
    if (group.length === 0) continue;
    picked.push(group[0]);
    pickedKeys.add(group[0].key);
    cursor.set(archetype, 1);
  }

  // Second pass, only when k exceeds the 4 available archetypes: cycle
  // through archetypes again taking each one's next-best not yet picked.
  let progressed = picked.length < k;
  while (picked.length < k && progressed) {
    progressed = false;
    for (const archetype of ARCHETYPE_ORDER) {
      if (picked.length >= k) break;
      const group = byArchetype.get(archetype);
      let idx = cursor.get(archetype);
      while (idx < group.length && pickedKeys.has(group[idx].key)) idx++;
      if (idx < group.length) {
        picked.push(group[idx]);
        pickedKeys.add(group[idx].key);
        cursor.set(archetype, idx + 1);
        progressed = true;
      } else {
        cursor.set(archetype, idx);
      }
    }
  }

  return picked.map(({ units, scored }) => ({
    archetype: classifyArchetype(units),
    units,
    score: scored.expectedScore,
    // The target this composition was built against, on encounter-heuristic
    // .mjs's own arbitrary scale -- NOT literal D&D XP (this heuristic never
    // claims to be XP-budget math, see encounter-heuristic.mjs's own header).
    xpBudget: targetDifficulty,
    notes: buildNotes(units, classifyArchetype(units), candidateByEntryId, scored)
  }));
}
