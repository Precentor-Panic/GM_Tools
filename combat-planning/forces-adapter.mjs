/**
 * Forces adapter — WS-4 (opforce-plan-2026-09-12.md §3). Two independent
 * pieces sharing this file because they're both "the GM_Tools <-> rl-combat
 * boundary," never because they share logic:
 *
 *   1. `toForces(composition, {party, positions})` — PURE, no I/O. Converts
 *      a combat-planning/participant-select.mjs composition (or any
 *      `{units:[{entryId,count}]}`-shaped object, including a raw
 *      encounter-heuristic.mjs `combination` array) plus a party roster into
 *      the `{blue, red}` forces shape `rl-combat/training/eval.py`'s
 *      `_stage_to_forces` and `rl-combat/sim/n20_env.py`'s `reset()` both
 *      accept: `{blue:[{name,actorName,x,y}], red:[...]}`.
 *
 *   2. `scoreWithSimulator(forces, map, {endpoint})` — the OPTIONAL
 *      simulation-scoring hook (design record §2/§7, "simulate-to-score was
 *      designed and deferred ... pending this RL work"). POSTs to an
 *      rl-combat `training/score_encounter.py --serve` HTTP endpoint IF
 *      `endpoint` is configured, over plain `fetch()` — the same boundary
 *      mechanism `bin/gen-splash.mjs` already uses for an outbound HTTP call
 *      from this codebase (no MCP client library, no new dependency).
 *      Returns `null` on ANY failure (no endpoint configured, network
 *      error, timeout, a non-2xx response, or a malformed body) — NEVER
 *      throws, so a caller can unconditionally do
 *      `const sim = await scoreWithSimulator(...); if (sim) {...}` and the
 *      deterministic heuristic path in encounter-heuristic.mjs/
 *      participant-select.mjs is completely untouched either way. Per
 *      GM_Tools' own localhost:30000/:30001 hazard note, this NEVER points
 *      at a Foundry instance directly — `endpoint` is rl-combat's own
 *      scoring server, a different machine/port entirely, and is only ever
 *      contacted when the caller explicitly configures one.
 *
 *      The result is meant to be folded into combat-planning/
 *      saved-encounter.mjs's `scoreSnapshot` ADDITIVELY (that field is
 *      already free-form JSON, no schema change needed) — e.g.
 *      `saveEncounter(world, sceneId, { ..., scoreSnapshot: { ...heuristicScore, simulatorResult } })`.
 *      This module deliberately does not import saved-encounter.mjs itself
 *      (a caller composes the two, same "don't reach across store
 *      boundaries" convention every other pure scoring module here follows).
 */

const ACTOR_PREFIX = "Actor.";

/** PURE, internal. Foundry's own "Actor.<id>" UUID convention -> the bare id; anything else passed through unchanged. */
function stripActorPrefix(value) {
  return typeof value === "string" && value.startsWith(ACTOR_PREFIX) ? value.slice(ACTOR_PREFIX.length) : value;
}

/**
 * PURE, internal. One composition unit `{entryId, count, name?, actorName?}`
 * -> `count` expanded, numbered `{label, actorName}` entries ("Goblin 1",
 * "Goblin 2", ...; unnumbered when count is 1). `name`/`actorName`, when the
 * caller has already resolved them from the unit's bestiary entry, win
 * outright; otherwise both fall back to the bare `entryId` -- a composition
 * fresh off `selectParticipants` (which only ever carries `{entryId,count}`)
 * still produces a usable, if less pretty, forces list.
 */
function expandUnit(unit) {
  const baseLabel = typeof unit.name === "string" && unit.name ? unit.name : unit.entryId;
  const actorName = stripActorPrefix(unit.actorName ?? unit.foundryActorRef ?? unit.name ?? unit.entryId);
  const count = Number.isFinite(unit.count) && unit.count > 0 ? Math.floor(unit.count) : 1;
  return Array.from({ length: count }, (_, i) => ({
    name: count > 1 ? `${baseLabel} ${i + 1}` : baseLabel,
    actorName
  }));
}

/**
 * PURE, internal. A simple two-line default layout: `blue` on the left
 * column, `red` on the right column, spaced two grid units apart down the
 * y-axis -- the same left-column/right-column convention
 * `rl-combat/sim/bench.py`'s and `training/eval.py`'s own force fixtures
 * already use.
 */
function defaultPositions(count, side, { grid_w = 20 } = {}) {
  const x = side === "blue" ? 2 : Math.max(grid_w - 3, 3);
  return Array.from({ length: count }, (_, i) => ({ x, y: i * 2 }));
}

/**
 * PURE, internal. One party member -> a blue unit's `{name, actorName}`.
 * `actorName` prefers `combatRelevant.class` (a system-agnostic "what kind
 * of fighter is this" label, e.g. "Fighter"/"Rogue"/"Cleric" --
 * party-roster-ingest.mjs's own field), then a Foundry actor ref
 * (Actor.-prefix stripped), then the member's own name.
 */
function blueUnitFor(member, index) {
  const name = typeof member?.name === "string" && member.name ? member.name : `PC ${index + 1}`;
  const actorName = stripActorPrefix(member?.combatRelevant?.class || member?.foundryActorRef || name);
  return { name, actorName };
}

/**
 * @param {{units: Array<{entryId:string, count:number, name?:string, actorName?:string}>}} composition
 *   a combat-planning/participant-select.mjs composition, or any
 *   `{units:[...]}`-shaped object (an encounter-heuristic.mjs `combination`
 *   array works too if wrapped as `{units: combination}`).
 * @param {object} [opts]
 * @param {Array<object>} [opts.party]   party-roster-store.mjs PartyMember-shaped entries (or {name, combatRelevant, foundryActorRef} subsets) -- becomes `blue`, in roster order
 * @param {object} [opts.positions]      optional explicit coordinates: `{blue:[{x,y},...], red:[{x,y},...]}`, one entry per EXPANDED unit (not per composition unit); either side omitted falls back to the two-line default. `{grid_w, grid_h}` on this same object sizes that default layout (default 20x20).
 * @returns {{blue: Array<{name:string, actorName:string, x:number, y:number}>, red: Array<{name:string, actorName:string, x:number, y:number}>}}
 */
export function toForces(composition, { party = [], positions = {} } = {}) {
  const redExpanded = (composition?.units ?? []).flatMap(expandUnit);
  const bluePositions = positions?.blue ?? defaultPositions(party.length, "blue", positions);
  const redPositions = positions?.red ?? defaultPositions(redExpanded.length, "red", positions);

  const blue = party.map((member, i) => ({
    ...blueUnitFor(member, i),
    x: bluePositions[i]?.x ?? 0,
    y: bluePositions[i]?.y ?? 0
  }));

  const red = redExpanded.map((unit, i) => ({
    ...unit,
    x: redPositions[i]?.x ?? 0,
    y: redPositions[i]?.y ?? 0
  }));

  return { blue, red };
}

const REQUIRED_SIM_RESULT_KEYS = ["win_rate", "mean_rounds", "p_any_pc_down", "p_tpk"];

/** PURE, internal. A parsed response body has exactly the four required numeric fields (extra fields are fine and passed through; a missing/non-numeric one fails validation). */
function isWellFormedSimResult(data) {
  return !!data && typeof data === "object" && REQUIRED_SIM_RESULT_KEYS.every((k) => typeof data[k] === "number");
}

/**
 * Optional simulation-scoring hook. See the module header. NEVER throws.
 * @param {{blue:Array, red:Array}} forces         toForces()'s own output shape
 * @param {object} map                             the §2 map dict `{grid_w, grid_h, walls, difficult}`
 * @param {object} [opts]
 * @param {string} [opts.endpoint]                 e.g. "http://127.0.0.1:8765/score" (rl-combat's `training.score_encounter --serve` server) -- when falsy, this returns null immediately without any network attempt
 * @param {number} [opts.episodes]
 * @param {string} [opts.policyPath]                forwarded as `policy_path`
 * @param {number} [opts.timeoutMs=10000]
 * @returns {Promise<{win_rate:number, mean_rounds:number, p_any_pc_down:number, p_tpk:number}|null>}
 */
export async function scoreWithSimulator(forces, map, opts = {}) {
  const { endpoint, episodes, policyPath, seed, timeoutMs = 10000 } = opts;
  if (!endpoint) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        forces,
        map,
        ...(episodes != null ? { episodes } : {}),
        ...(policyPath != null ? { policy_path: policyPath } : {}),
        ...(seed != null ? { seed } : {})
      }),
      signal: controller.signal
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!isWellFormedSimResult(data)) return null;
    return {
      win_rate: data.win_rate,
      mean_rounds: data.mean_rounds,
      p_any_pc_down: data.p_any_pc_down,
      p_tpk: data.p_tpk
    };
  } catch {
    // Connection refused, DNS failure, timeout/abort, malformed JSON -- any
    // of these degrade to "no simulator available," never a thrown error.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
