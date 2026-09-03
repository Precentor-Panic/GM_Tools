/**
 * Narrative-state store — the "Layer 2" sidecar: per-entity reveal state,
 * GM-only truth, stance, and clocks. Pure, Foundry-free, unit-testable.
 *
 * Design record: plans/ontology-assessment-2026-09-02.md (§6.1) and the
 * approved narrative-state plan. The graph records what is TRUE; this store
 * records where the TABLE is relative to that truth — what has been revealed,
 * what is still withheld, and how far a pending threat has advanced. Nothing
 * here ever syncs to the World Fabric graph or to Foundry.
 *
 * STORE LOCATION — deliberate divergence from the sibling sidecar stores
 * (entity-narration/, prep-content/ live under GM_Tools/): records live in
 * the WORLD DATA DIR, `<dataDir>/worlds/<world>/narrative-state/<id>.json`,
 * beside world-fabric-snapshot.json. Reason (adjudicated call A): the git
 * world-timeline commits `worlds/<world>/`, and a timeline branch must fork
 * the world AND what the table knows in one atomic commit — a snapshot that
 * captures the graph but not reveal state fails the timeline's purpose.
 * Consequence: every function here takes `dir` (the WF data dir) first,
 * unlike entity-narration.mjs. Test isolation via GM_TOOLS_NARRATIVE_STATE_DIR
 * (which replaces everything up to the per-world segment).
 *
 * WRITE DISCIPLINE (adjudicated call E): these are direct GM writes, sidecar
 * class — the no-silent-auto-write invariant governs GRAPH writes, and this
 * store never touches the graph (precedent: prep-content-ops.mjs, which
 * deliberately carries no batchId anywhere). The one flow that lands here
 * from a review batch (writeup-import truth via entityContext.narrativeState)
 * only fires AFTER the GM accepts the mutation — the review gate still holds.
 *
 * Never-delete convention: reveal TRANSITIONS are an append-only history.
 * `truth`/`stance`/`clock` are mutable GM-authored fields (call G — matching
 * scene-element fields, not entity-narration's full-history shape; a
 * truthHistory is a cheap later add if wanted).
 *
 * Concurrency: reuses review-state.mjs's withLock/ConcurrentWriteError, per
 * gm-tools-conventions and every sibling store's precedent.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";
import { withLock, ConcurrentWriteError } from "./review-state.mjs";

// v1. `stance` is metadata about the TRUTH, not the holder — why the truth is
// withheld: "concealing" (someone knows and actively hides it), "unaware"
// (the holder doesn't know it themselves; for non-agents, no one living
// knows), "undisclosed" (merely obscure; it just hasn't come up). That
// framing is what lets stance safely cross the knowledge gate into
// table-facing prompts as roleplay guidance while the truth text never does
// (narrative-gate.mjs).
export const SCHEMA_VERSION = 1;

export const RevealState = z.enum(["hidden", "unrevealed", "hinted", "revealed"]);
export const TruthStance = z.enum(["concealing", "unaware", "undisclosed"]);
export const TransitionSource = z.enum(["manual", "wrap", "intake"]);

export const ClockSchema = z.object({
  value: z.number().int().min(0),
  max: z.number().int().min(1),
  cadence: z.string().optional() // freeform display hint ("per session", "on rest") — no auto-tick in v1
}).strict();

export const RevealTransition = z.object({
  from: RevealState.nullable(), // null = record creation
  to: RevealState,
  at: z.string(),
  sessionNumber: z.number().nullable(),
  source: TransitionSource,
  note: z.string().optional()
}).strict();

export const NarrativeStateRecord = z.object({
  entityId: z.string(),
  revealState: RevealState,
  truth: z.string().optional(),  // GM-only prose; absent = no truth split for this entity
  stance: TruthStance.optional(),
  clock: ClockSchema.nullable().optional(),
  transitions: z.array(RevealTransition),
  createdAt: z.string(),
  updatedAt: z.string(),
  sourceBatchId: z.string().optional(),
  sourceMutationId: z.string().optional()
}).strict();

/**
 * Per-world store directory. Default lives in the WORLD DATA DIR (see the
 * header's call-A rationale); GM_TOOLS_NARRATIVE_STATE_DIR overrides the root
 * (world subdir still applied) for test isolation.
 */
export function narrativeStateRoot(dir, world) {
  const override = process.env.GM_TOOLS_NARRATIVE_STATE_DIR;
  return override ? join(override, world) : join(dir, "worlds", world, "narrative-state");
}

function recordFilePath(dir, world, entityId) {
  return join(narrativeStateRoot(dir, world), `${entityId}.json`);
}

/** The entity's narrative-state record, or null — and null means FULLY OPEN: no gating anywhere. */
export function getNarrativeState(dir, world, entityId) {
  const filePath = recordFilePath(dir, world, entityId);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** Every record in a world (readdir scan), optionally filtered by revealState. [] when none. */
export function listNarrativeState(dir, world, { revealState } = {}) {
  const root = narrativeStateRoot(dir, world);
  if (!existsSync(root)) return [];
  const records = readdirSync(root)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(root, f), "utf8")));
  return revealState ? records.filter((r) => r.revealState === revealState) : records;
}

/**
 * Bulk reveal-state lookup for gating and tab-seeding: Map<entityId, record>.
 * Entities with no record are simply absent from the map — callers treat
 * absence as fully open (the gin-up-protecting hard requirement).
 */
export function getRevealStates(dir, world, entityIds) {
  const out = new Map();
  for (const id of entityIds) {
    const record = getNarrativeState(dir, world, id);
    if (record) out.set(id, record);
  }
  return out;
}

function writeRecord(dir, world, record) {
  const validated = NarrativeStateRecord.parse(record);
  const filePath = recordFilePath(dir, world, record.entityId);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(validated, null, 2), "utf8");
  });
  return validated;
}

/**
 * Load-or-create the working record. A record created as a side effect of
 * setting truth/stance/clock starts at "unrevealed" — whoever writes a truth
 * is by definition withholding it (adjudicated default) — and that creation
 * is itself logged as a from:null transition so provenance is never implicit.
 */
function loadOrCreate(dir, world, entityId, { now, source = "manual", sessionNumber = null, initialState = "unrevealed" }) {
  const existing = getNarrativeState(dir, world, entityId);
  if (existing) return { record: existing, created: false };
  return {
    record: {
      entityId,
      revealState: initialState,
      transitions: [{ from: null, to: initialState, at: now, sessionNumber, source }],
      createdAt: now,
      updatedAt: now
    },
    created: true
  };
}

/**
 * Set (or clear, with null) the GM-only truth prose. `meta` may carry
 * `stance`, provenance (`sourceBatchId`/`sourceMutationId`) and, for
 * record-creation, `source`/`sessionNumber` for the creation transition.
 */
export function setNarrativeTruth(dir, world, entityId, truth, meta = {}, opts = {}) {
  const now = opts.now ?? new Date().toISOString();
  const { record } = loadOrCreate(dir, world, entityId, { now, source: meta.source, sessionNumber: meta.sessionNumber });
  if (truth === null || truth === undefined) {
    delete record.truth;
  } else {
    record.truth = z.string().min(1).parse(truth);
  }
  if (meta.stance !== undefined) {
    if (meta.stance === null) delete record.stance;
    else record.stance = TruthStance.parse(meta.stance);
  }
  if (meta.sourceBatchId) record.sourceBatchId = meta.sourceBatchId;
  if (meta.sourceMutationId) record.sourceMutationId = meta.sourceMutationId;
  record.updatedAt = now;
  return writeRecord(dir, world, record);
}

/** Set (or clear, with null) the stance. Create-on-first-touch like the other setters. */
export function setStance(dir, world, entityId, stanceOrNull, opts = {}) {
  const now = opts.now ?? new Date().toISOString();
  const { record } = loadOrCreate(dir, world, entityId, { now, source: opts.source, sessionNumber: opts.sessionNumber });
  if (stanceOrNull === null) delete record.stance;
  else record.stance = TruthStance.parse(stanceOrNull);
  record.updatedAt = now;
  return writeRecord(dir, world, record);
}

/**
 * Move the reveal state, appending to the append-only transition history.
 * Same-state is a safe no-op (returns the record, writes nothing) so callers
 * can apply wrap decisions idempotently.
 */
export function setRevealState(dir, world, entityId, to, { source = "manual", note, sessionNumber = null } = {}, opts = {}) {
  RevealState.parse(to);
  const now = opts.now ?? new Date().toISOString();
  const existing = getNarrativeState(dir, world, entityId);
  if (existing) {
    if (existing.revealState === to) return existing; // no-op: unchanged, nothing written
    existing.transitions = [
      ...existing.transitions,
      { from: existing.revealState, to, at: now, sessionNumber, source, ...(note ? { note } : {}) }
    ];
    existing.revealState = to;
    existing.updatedAt = now;
    return writeRecord(dir, world, existing);
  }
  // Fresh record created directly at `to` — the creation IS the transition.
  return writeRecord(dir, world, {
    entityId,
    revealState: to,
    transitions: [{ from: null, to, at: now, sessionNumber, source, ...(note ? { note } : {}) }],
    createdAt: now,
    updatedAt: now
  });
}

/** Set (or clear, with null) the clock. Validated against ClockSchema. */
export function setClock(dir, world, entityId, clockOrNull, opts = {}) {
  const now = opts.now ?? new Date().toISOString();
  const { record } = loadOrCreate(dir, world, entityId, { now, source: opts.source, sessionNumber: opts.sessionNumber });
  if (clockOrNull === null) record.clock = null;
  else record.clock = ClockSchema.parse(clockOrNull);
  record.updatedAt = now;
  return writeRecord(dir, world, record);
}

/**
 * Advance (or rewind, with a negative delta) the entity's clock, clamped to
 * [0, max]. Throws for an entity with no clock set — ticking nothing is a
 * caller bug, not a quiet success.
 */
export function tickClock(dir, world, entityId, delta = 1, opts = {}) {
  const now = opts.now ?? new Date().toISOString();
  const record = getNarrativeState(dir, world, entityId);
  if (!record || !record.clock) {
    throw new Error(`Entity "${entityId}" in world "${world}" has no clock to tick — set one first (setClock).`);
  }
  record.clock = {
    ...record.clock,
    value: Math.min(record.clock.max, Math.max(0, record.clock.value + delta))
  };
  record.updatedAt = now;
  return writeRecord(dir, world, record);
}

export { ConcurrentWriteError };
