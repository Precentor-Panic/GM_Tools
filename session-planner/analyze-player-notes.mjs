/**
 * Analyze player notes (GM-only, truth-aware) — a sibling of session-wrap.mjs's
 * suggestWrapTransitions.
 *
 * Players take notes in Foundry (bridged out to world-fabric-player-notes.json,
 * bridge contract §4). This reads those notes and runs ONE cheap (haiku-tier)
 * LLM pass to flag each note as:
 *   - "confusion"      — the player is lost/mixed-up, or asks an open question;
 *   - "close-to-truth" — the note is getting warm on a STILL-WITHHELD truth
 *                        (revealState hidden/unrevealed/hinted) — the truth-aware
 *                        early-warning that a reveal may be imminent;
 *   - "thread"         — a player-driven hook worth following next session.
 *
 * GM-SIDE ONLY. Like the wrap-transitions prompt, this call is handed the full
 * GM-only narrative-state truth so it can judge "close-to-truth" — so its output
 * and its prompt must NEVER reach a table-facing surface. It NEVER writes canon
 * (persisting the RESULT is a separate explicit saveAnalysis call, the same
 * discipline suggestWrapTransitions follows). Absence of notes = zero LLM spend.
 *
 * Deliberately NO "wrong-assumption" kind (Russell 2026-09-07): letting players
 * be wrong is fine; a trivial future add if wanted (same truth comparison).
 */
import { listNarrativeState } from "../mutation-engine/narrative-state.mjs";
import { renderGmTruthBlock } from "../mutation-engine/narrative-gate.mjs";
import { callModelDetailed, fillTemplate, parseJsonResponse } from "../mutation-engine/llm-call.mjs";
import { loadSnapshot, loadPlayerNotes } from "../wf-mcp-server/lib/snapshot.mjs";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ANALYZE_PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "analyze-player-notes.md"), "utf8");

// Cheap "did the note brush up against X" skim — same tier/rationale as the
// wrap suggester, not creative generation.
export const DEFAULT_ANALYZE_MODEL = "claude-haiku-4-5";
export const ANALYZE_KINDS = new Set(["confusion", "close-to-truth", "thread"]);

function renderNoteBlock(note) {
  const author = note.authorName ?? note.authorId ?? "unknown";
  return `--- noteId: ${note.noteId}\nauthor: ${author}\ntitle: ${note.title ?? "(untitled)"}\n${String(note.text ?? "").trim()}`;
}

/**
 * Roster the model sees: a full id/name/type index of every entity (so a flag
 * can reference any of them and validation has the complete id set), plus the
 * GM-only truth block for every still-withheld entity (the close-to-truth
 * targets). Injecting all withheld truth is cheap at this project's world size;
 * narrow with the name-similarity pre-pass only if a world grows large.
 */
function renderEntityRoster(entities, withheldRecords, entityById) {
  const index = entities.length
    ? entities.map((e) => `  ${e.id} · ${e.name} · ${e.type ?? "?"}`).join("\n")
    : "  (no entities in the graph yet)";

  const truthBlocks = withheldRecords
    .map((r) => {
      const name = entityById.get(r.entityId)?.name ?? r.entityId;
      const block = renderGmTruthBlock(r, { name });
      if (!block) return null;
      return `entityId: ${r.entityId}\n${block}`;
    })
    .filter(Boolean);

  const truthSection = truthBlocks.length
    ? truthBlocks.join("\n\n")
    : "(no withheld truths recorded — nothing can be 'close-to-truth' yet)";

  return `ENTITY INDEX (id · name · type):\n${index}\n\nGM-ONLY WITHHELD TRUTHS:\n${truthSection}`;
}

/**
 * @param {string} dir
 * @param {string} world
 * @param {object} [opts]  {client?, apiKey?, model?, maxTokens?}
 * @returns {Promise<{flags: Array<{noteId,authorId,entityId,kind,detail}>, dropped: Array<{noteId,entityId,kind,reason}>, noteCount:number}>}
 */
export async function analyzePlayerNotes(dir, world, opts = {}) {
  const { notes } = loadPlayerNotes(dir, world);
  if (!notes.length) {
    return { flags: [], dropped: [], noteCount: 0 };
  }

  // Snapshot is best-effort for names/ids; a missing snapshot degrades to an
  // empty entity set (flags can still be confusion/thread with entityId null).
  let entities = [];
  try {
    entities = loadSnapshot(dir, world).snapshot.entities ?? [];
  } catch {
    entities = [];
  }
  const entityById = new Map(entities.map((e) => [e.id, e]));
  const entityIds = new Set(entities.map((e) => e.id));

  const withheldRecords = listNarrativeState(dir, world).filter((r) => r.revealState !== "revealed");

  const noteById = new Map(notes.map((n) => [n.noteId, n]));
  const noteIds = new Set(notes.map((n) => n.noteId));

  const prompt = fillTemplate(ANALYZE_PROMPT_TEMPLATE, {
    entityRoster: renderEntityRoster(entities, withheldRecords, entityById),
    playerNotes: notes.map(renderNoteBlock).join("\n\n")
  });

  const { text } = await callModelDetailed(prompt, {
    client: opts.client,
    apiKey: opts.apiKey,
    model: opts.model ?? DEFAULT_ANALYZE_MODEL,
    maxTokens: opts.maxTokens ?? 1536
  });

  const parsed = parseJsonResponse(text);
  const rawFlags = Array.isArray(parsed?.flags) ? parsed.flags : [];

  const flags = [];
  const dropped = [];
  for (const f of rawFlags) {
    const noteId = f?.noteId;
    const entityId = f?.entityId ?? null;
    const kind = f?.kind;

    if (typeof noteId !== "string" || !noteIds.has(noteId)) {
      dropped.push({ noteId, entityId, kind, reason: "unknown noteId" });
      continue;
    }
    if (!ANALYZE_KINDS.has(kind)) {
      dropped.push({ noteId, entityId, kind, reason: "invalid kind" });
      continue;
    }
    // entityId: optional for confusion/thread; REQUIRED and real for
    // close-to-truth (it's inherently about a specific withheld truth).
    if (entityId != null && !entityIds.has(entityId)) {
      dropped.push({ noteId, entityId, kind, reason: "unknown entityId" });
      continue;
    }
    if (kind === "close-to-truth" && (entityId == null || !entityIds.has(entityId))) {
      dropped.push({ noteId, entityId, kind, reason: "close-to-truth needs a real entityId" });
      continue;
    }
    flags.push({
      noteId,
      authorId: noteById.get(noteId)?.authorId ?? null, // attribution from the note, never the model
      entityId,
      kind,
      detail: String(f?.detail ?? "")
    });
  }

  return { flags, dropped, noteCount: notes.length };
}
