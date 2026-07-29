/**
 * Notes-as-deferred-intake — Phase 16 task 16.4.
 *
 * Design record §6: notes are raw material for the EXISTING writeup-import/
 * scan-mentions pipeline, batched and deferred, never a new durable
 * "informal graph" layer. This module is a thin adapter over
 * graph-import/scan-mentions.mjs's real primitives (proposeMentionedEntities,
 * applyFuzzyPrepass, previewMentionScan) plus one NEW small deterministic
 * step (applyAnchorHint, below) that makes a note's capture-time anchor a
 * genuinely high-confidence resolution hint — a new intake INPUT-SHAPING
 * step feeding the same existing dedup machinery, not new intake logic.
 *
 * Storage: ONE JSON file per world — `<sessionNotesRoot>/<world>.json`, a
 * flat array of SessionNote objects (mirrors session-planner/scenes.mjs's
 * one-file-per-world choice for the same reason: listPendingNotes needs
 * "every unconsumed note in this world" as a first-class scan). Default
 * root GM_Tools/session-notes/; override with GM_TOOLS_SESSION_NOTES_DIR.
 * Reuses review-state.mjs's withLock (for this store's own writes) AND
 * review-state.mjs's createBatch (runBatchIntake's output lands as a normal
 * Batch).
 *
 * NEVER auto-writes to canon (design §6, ties to the project's standing
 * no-silent-write invariant, NFR7): captureNote is a pure append to this
 * module's own store, never touching review-state.mjs. runBatchIntake's
 * output batch is always status:'open' with every mutation status:'pending'
 * — this module never calls acceptMutations/updateMutationStatus itself.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, ConcurrentWriteError, createBatch } from "../mutation-engine/review-state.mjs";
import { summarizeBatch, renderHeadline } from "../mutation-engine/grain.mjs";
import { attachDiffs } from "../time-skip/run.mjs";
import { proposeMentionedEntities, applyFuzzyPrepass, previewMentionScan } from "../graph-import/scan-mentions.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "session-notes");

export function sessionNotesRoot() {
  return process.env.GM_TOOLS_SESSION_NOTES_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return join(sessionNotesRoot(), `${world}.json`);
}

function readNotes(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeNotes(world, notes) {
  const filePath = worldFilePath(world);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(notes, null, 2), "utf8");
  });
  return notes;
}

/** Generate a session-note id. Injectable (opts.makeId) for deterministic tests. */
export function makeNoteId() {
  return `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * ZERO-CEREMONY capture (design §6): no validation beyond the world-id
 * check already centralized in wf-mcp-server/lib/resolve.mjs (that's the
 * HTTP layer's job, task 16.6, not this function's). Never writes to
 * review-state.mjs, never touches canon.
 *
 * @param {string} world
 * @param {{text:string, anchorEntityId?:string|null, sceneId?:string|null}} fields
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object}   the created SessionNote, consumed:false
 */
export function captureNote(world, { text, anchorEntityId = null, sceneId = null } = {}, opts = {}) {
  const makeId = opts.makeId ?? makeNoteId;
  const now = opts.now ?? new Date().toISOString();
  const note = {
    id: makeId(),
    world,
    text,
    anchorEntityId: anchorEntityId ?? null,
    sceneId: sceneId ?? null,
    timestamp: now,
    consumed: false,
    consumedAt: null,
    consumedByBatchId: null
  };
  const notes = readNotes(world);
  writeNotes(world, [...notes, note]);
  return note;
}

/** @returns {object[]}   every SessionNote for `world` with consumed:false, in capture order. [] if none. */
export function listPendingNotes(world) {
  return readNotes(world).filter((n) => !n.consumed);
}

// --- applyAnchorHint ---------------------------------------------------------

// Same stopword-stripped tokenization scan-mentions.mjs's nameSimilarity
// already uses conceptually -- kept as a small local copy rather than an
// export scan-mentions.mjs doesn't offer (its own normalizeNameTokens is
// module-private), matching the "not new intake LOGIC" framing: this is a
// separate, more permissive check (subset/superset over one known anchor,
// not a graph-wide fuzzy threshold), not a re-derivation of the same rule.
const NAME_STOPWORDS = new Set(["the", "a", "an", "of", "de", "van", "der"]);

function normalizeNameTokens(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !NAME_STOPWORDS.has(t));
}

/** True if the smaller of the two non-empty token sets is fully contained in the larger (a non-empty subset OR superset relationship). */
function isSubsetOrSuperset(tokensA, tokensB) {
  const a = new Set(tokensA);
  const b = new Set(tokensB);
  if (a.size === 0 || b.size === 0) return false;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of smaller) {
    if (!larger.has(t)) return false;
  }
  return true;
}

/**
 * NEW deterministic pre-pass, pure, no I/O. Runs BEFORE
 * graph-import/scan-mentions.mjs's applyFuzzyPrepass in runBatchIntake's own
 * pipeline. For every mention whose normalized name-token set is a
 * non-empty SUBSET or SUPERSET of anchorEntity's own normalized name-token
 * set, rewrites that mention's `name` to anchorEntity.name EXACTLY (tagging
 * the original under `anchorMatchedFrom`, mirroring applyFuzzyPrepass's own
 * `fuzzyMatchedFrom` convention) so it resolves through previewMentionScan's
 * real dedup as a LINK to the real anchor entity, not a proposed duplicate.
 *
 * @param {Array<{name:string, type:string, description?:string}>} mentions
 * @param {object|null} anchorEntity   {id, name, type, ...} or null/undefined -- a no-op when there's no anchor.
 * @returns {Array<{name:string, type:string, description?:string, anchorMatchedFrom?:string}>}
 */
export function applyAnchorHint(mentions, anchorEntity) {
  if (!anchorEntity) return mentions;
  const anchorTokens = normalizeNameTokens(anchorEntity.name);
  return mentions.map((mention) => {
    const mentionTokens = normalizeNameTokens(mention.name);
    if (!isSubsetOrSuperset(mentionTokens, anchorTokens)) return mention;
    return { ...mention, name: anchorEntity.name, anchorMatchedFrom: mention.name };
  });
}

// --- runBatchIntake ----------------------------------------------------------

/**
 * The full deferred-intake pipeline (design §6). V1 SCOPE DECISION: every
 * noteId passed in MUST have a non-null anchorEntityId that resolves to a
 * real entity in existingSnapshot.entities — throws a clear error listing
 * the offending note id(s) otherwise.
 *
 * @param {string} world
 * @param {string[]} noteIds
 * @param {{entities:object[], edges:object[], entityTypes?:object[]}} existingSnapshot
 * @param {object} [opts]
 * @param {object} [opts.llmOpts]        forwarded to proposeMentionedEntities
 * @param {() => string} [opts.makeId]   batch id generator, injectable for tests
 * @returns {Promise<{batchId:string, mutationCount:number, linkCount:number, newCount:number, headline:string, consumedNoteIds:string[]}>}
 */
export async function runBatchIntake(world, noteIds, existingSnapshot, opts = {}) {
  const allNotes = readNotes(world);
  const notesById = new Map(allNotes.map((n) => [n.id, n]));
  const entityById = new Map((existingSnapshot.entities ?? []).map((e) => [e.id, e]));

  const selectedNotes = noteIds.map((id) => {
    const note = notesById.get(id);
    if (!note) throw new Error(`runBatchIntake: no session note found with id "${id}" in world "${world}".`);
    return note;
  });

  const offending = selectedNotes.filter((n) => !n.anchorEntityId || !entityById.has(n.anchorEntityId));
  if (offending.length) {
    throw new Error(
      `runBatchIntake requires every note to have an anchorEntityId that resolves to a real entity in the ` +
      `live graph (v1 scope decision, design record §6) -- missing/unresolved anchor for note id(s): ` +
      `${offending.map((n) => n.id).join(", ")}`
    );
  }

  // Group notes sharing the same anchorEntityId, in capture order, into one
  // combined scan text per group.
  const groupOrder = [];
  const groupsByAnchor = new Map();
  for (const note of selectedNotes) {
    if (!groupsByAnchor.has(note.anchorEntityId)) {
      groupsByAnchor.set(note.anchorEntityId, []);
      groupOrder.push(note.anchorEntityId);
    }
    groupsByAnchor.get(note.anchorEntityId).push(note);
  }

  const allMutations = [];
  let linkCount = 0;
  let newCount = 0;

  for (const anchorEntityId of groupOrder) {
    const groupNotes = groupsByAnchor.get(anchorEntityId);
    const anchorEntity = entityById.get(anchorEntityId);
    const combinedText = groupNotes.map((n) => n.text).join("\n\n");

    const { mentions } = await proposeMentionedEntities(
      combinedText,
      { name: anchorEntity.name, type: anchorEntity.type },
      opts.llmOpts ?? {}
    );
    const hinted = applyAnchorHint(mentions, anchorEntity);
    const prepassed = applyFuzzyPrepass(hinted, existingSnapshot.entities ?? []);
    const { mutations, linkCount: groupLinkCount, newCount: groupNewCount } =
      previewMentionScan(prepassed, anchorEntityId, existingSnapshot, {});

    allMutations.push(...mutations);
    linkCount += groupLinkCount;
    newCount += groupNewCount;
  }

  const diffed = attachDiffs(allMutations, existingSnapshot.entities ?? [], existingSnapshot.edges ?? []);

  const batch = createBatch(
    world,
    { mode: "session-notes-intake", noteIds: selectedNotes.map((n) => n.id) },
    undefined,
    diffed,
    opts.makeId ? { makeId: opts.makeId } : {}
  );
  const headline = renderHeadline(summarizeBatch(batch));

  // ONLY once createBatch succeeds: mark the consumed notes consumed:true
  // (never deleted -- matches entity-narration.mjs's supersede-not-delete
  // "nothing is silently lost" convention).
  const consumedNoteIds = selectedNotes.map((n) => n.id);
  const consumedIdSet = new Set(consumedNoteIds);
  const now = new Date().toISOString();
  const updated = allNotes.map((n) =>
    consumedIdSet.has(n.id) ? { ...n, consumed: true, consumedAt: now, consumedByBatchId: batch.id } : n
  );
  writeNotes(world, updated);

  return {
    batchId: batch.id,
    mutationCount: batch.mutations.length,
    linkCount,
    newCount,
    headline,
    consumedNoteIds
  };
}

export { ConcurrentWriteError };
