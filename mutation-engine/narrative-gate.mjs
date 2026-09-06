/**
 * Narrative gate — the pure helpers that keep unrevealed truths out of
 * table-facing prompts. No fs, no store access: reveal-state records arrive
 * injected (narrative-state.mjs's getRevealStates Map, or any object keyed by
 * entity id), so callers at the narrate.mjs level stay snapshot-in/prompt-out
 * testable.
 *
 * The gate is exactly two behaviors, not a redaction engine (adjudicated
 * call B): after the truth/surface split, a graph entity's `description` IS
 * surface — player-safe by definition, since truth only ever lives in the
 * narrative-state sidecar and no table-facing builder reads that field.
 * So table prompts need only:
 *   1. `hidden` entities excluded entirely — their names must not appear
 *      (players don't know they exist); and
 *   2. `unrevealed`/`hinted` entities that hold something (a truth, or a
 *      stance signaling "there's a there there") listed in a standing
 *      allude-don't-disclose block.
 * Absence of a record = zero gating — the fast gin-up flow is sacred.
 *
 * STANCE CROSSES THE GATE; TRUTH DOES NOT (call C): the stance enum carries
 * zero truth content, so it travels into table prompts as roleplay guidance
 * ("actively concealing — deflect, never invent the secret") while the truth
 * text stays structurally unreachable. `hidden` entities' stances never
 * travel — they are excluded before the withheld list is built.
 */

const WITHHELD_STATES = new Set(["unrevealed", "hinted"]);

function stateFor(statesById, id) {
  if (!statesById) return undefined;
  return typeof statesById.get === "function" ? statesById.get(id) : statesById[id];
}

function entityIdOf(entity) {
  return entity?.id ?? entity?.entityId;
}

/**
 * Split a set of graph entities for a TABLE-facing prompt.
 *
 * @param {object[]} entities   graph entities (need `.id`/`.entityId`, `.name`)
 * @param {Map|object} statesById  entityId -> narrative-state record ({revealState, truth?, stance?})
 * @returns {{visible: object[], withheld: {id,name,revealState,stance?}[]}}
 *   visible:  every entity except `hidden` ones — safe to pass to the builder
 *   withheld: the allusion-block roster (per call C: unrevealed/hinted AND
 *             (truth OR stance present)); always a subset of visible.
 */
export function partitionForTable(entities, statesById) {
  const visible = [];
  const withheld = [];
  for (const entity of entities || []) {
    const record = stateFor(statesById, entityIdOf(entity));
    if (record?.revealState === "hidden") continue; // excluded entirely — name never appears
    visible.push(entity);
    if (record && WITHHELD_STATES.has(record.revealState) && (record.truth || record.stance)) {
      withheld.push({
        id: entityIdOf(entity),
        name: entity.name ?? entityIdOf(entity),
        revealState: record.revealState,
        ...(record.stance ? { stance: record.stance } : {})
      });
    }
  }
  return { visible, withheld };
}

/**
 * A GM-only edge: a relationship whose LABEL itself encodes truth-tier
 * material between entities that are individually visible ("on the payroll
 * of", "double policy scandal"). The intake stamps these `notes: "GM-only
 * truth."` — an entity's truth text is structurally unreachable from table
 * prompts, but an edge label rides into adjacency context unless filtered
 * here. Found live in the Aureus seed verify (2026-09-06): five such edges
 * between non-hidden entities would have leaked through every table-facing
 * prompt. The marker is the notes prefix, not a schema field, deliberately —
 * no interchange/migration change for a v1 predicate one grep can audit.
 */
const GM_ONLY_EDGE_RE = /^\s*GM-only/i;
export function isGmOnlyEdge(edge) {
  return GM_ONLY_EDGE_RE.test(edge?.notes ?? "");
}

/**
 * Gate a whole snapshot slice for a TABLE-facing prompt: remove `hidden`
 * entities, every edge touching one, AND every GM-only-marked edge (see
 * isGmOnlyEdge above — the marker gates regardless of reveal records, since
 * the marker itself is the record). The edge filter matters as much as
 * the entity filter — buildAdjacencyContext degrades a neighbor missing
 * from the entities array to its raw id string, and ids are routinely
 * slugged from names, so an unfiltered edge would leak the hidden entity's
 * name-shaped id into the prompt.
 *
 * `keepIds`: entities kept visible even when hidden — the case where the GM
 * explicitly targeted a hidden entity (narrating it, anchoring a scene on
 * it); the caller then lists it in the allusion block instead of refusing.
 * keepIds never un-gates a GM-only edge: keeping a hidden entity visible is
 * a GM targeting decision about the entity, not license for truth labels.
 */
export function gateSnapshotForTable(entities, edges, statesById, { keepIds = [] } = {}) {
  const keep = new Set(keepIds);
  const hiddenIds = new Set();
  for (const entity of entities || []) {
    const id = entityIdOf(entity);
    if (!keep.has(id) && stateFor(statesById, id)?.revealState === "hidden") hiddenIds.add(id);
  }
  const hasGmOnlyEdge = (edges ?? []).some(isGmOnlyEdge);
  // Unmarked, record-free worlds return their inputs untouched — the pinned
  // zero-records byte-identical contract is preserved exactly.
  if (!hiddenIds.size && !hasGmOnlyEdge) return { entities: entities ?? [], edges: edges ?? [] };
  return {
    entities: (entities ?? []).filter((e) => !hiddenIds.has(entityIdOf(e))),
    edges: (edges ?? []).filter(
      (e) => !hiddenIds.has(e.sourceId) && !hiddenIds.has(e.targetId) && !isGmOnlyEdge(e)
    )
  };
}

// Per-stance table guidance. The prompt never holds the truth text, so even
// "undisclosed" (no in-fiction resistance) translates to defer-to-GM — the
// model must not invent an answer it does not have.
const STANCE_GUIDANCE = {
  concealing:
    "actively concealing it — deflection, plausible lies, and tells under pressure are in play; never state, confirm, or invent the hidden material.",
  unaware:
    "sincerely unaware of it — embody it without knowing; it cannot leak what it does not know, only be sincerely wrong; discovery must come from outside.",
  undisclosed:
    "holds it merely undisclosed — no dramatics, no resistance; if asked directly, leave space for the GM to supply the answer rather than inventing one."
};
const GENERIC_GUIDANCE =
  "holds something the players have not learned — allude and foreshadow only; never disclose, confirm, or invent specifics.";

/**
 * The standing allusion block for a table-facing prompt. "" when nothing is
 * withheld, so templates can carry an empty-default slot.
 */
export function renderAllusionInstruction(withheld) {
  if (!withheld || withheld.length === 0) return "";
  const lines = withheld.map((w) => {
    const guidance = STANCE_GUIDANCE[w.stance] ?? GENERIC_GUIDANCE;
    const hinted = w.revealState === "hinted" ? " The players have already caught a hint of this." : "";
    return `- ${w.name}: ${guidance}${hinted}`;
  });
  return [
    "UNREVEALED TRUTHS — the following hold information the players have NOT yet learned.",
    "Allude, foreshadow, and build tension, but NEVER reveal, confirm, or invent the withheld material; if play forces the topic, defer to the GM.",
    ...lines
  ].join("\n");
}

/**
 * The labeled GM-only block for a GM-facing (prep) prompt: stance + truth
 * together. "" when the record carries neither, so injection sites can append
 * unconditionally.
 */
export function renderGmTruthBlock(record, { name } = {}) {
  if (!record || (!record.truth && !record.stance)) return "";
  const label = name ? ` — ${name}` : "";
  const stanceLine = record.stance ? `\nStance: ${record.stance} (${STANCE_GUIDANCE[record.stance]})` : "";
  const truthLine = record.truth ? `\n${record.truth}` : "";
  return (
    `GM TRUTH${label} [reveal: ${record.revealState}]` +
    `\nGM-only — never shown to players; never restate it in player-facing surface text.` +
    stanceLine +
    truthLine
  );
}
