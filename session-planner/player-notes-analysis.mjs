/**
 * Player-notes-analysis store — pure, Foundry-free, unit-testable.
 *
 * Persists the RESULT of analyze-player-notes.mjs (the flagged confusion /
 * close-to-truth / thread items) so the GM can revisit it. The player notes
 * THEMSELVES are NOT stored here — they live in Foundry and arrive via the
 * world-fabric-player-notes.json bridge each flush; the durable artifact worth
 * keeping is the analysis, not a second copy of the notes.
 *
 * Storage: one JSON file per world — `<root>/<world>.json`, a flat array of
 * PlayerNotesAnalysisEntry. Default root GM_Tools/player-notes-analysis/;
 * override with GM_TOOLS_PLAYER_NOTES_ANALYSIS_DIR (tests use this for
 * isolation, same no-leak regression-test convention as test/user-settings.test.mjs).
 *
 * HISTORY, not a single overwritten latest: every save marks any existing
 * `status:'current'` entry `'superseded'` and appends the new one. Nothing is
 * ever deleted. Clones truth-notes.mjs's shape exactly.
 *
 * Concurrency: reuses review-state.mjs's withLock/ConcurrentWriteError.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "player-notes-analysis");

export const SCHEMA_VERSION = 1;

export const AnalysisStatus = z.enum(["current", "superseded"]);

export const AnalysisFlag = z.object({
  noteId: z.string(),
  authorId: z.string().nullable(),
  entityId: z.string().nullable(),
  kind: z.enum(["confusion", "close-to-truth", "thread"]),
  detail: z.string()
}).strict();

export const PlayerNotesAnalysisEntry = z.object({
  id: z.string(),
  createdAt: z.string(),
  sessionNumber: z.number().nullable(),
  flags: z.array(AnalysisFlag),
  noteCount: z.number(),
  status: AnalysisStatus
}).strict();

export function playerNotesAnalysisRoot() {
  return process.env.GM_TOOLS_PLAYER_NOTES_ANALYSIS_DIR || DEFAULT_ROOT;
}

function analysisFilePath(world) {
  return join(playerNotesAnalysisRoot(), `${world}.json`);
}

export function makeAnalysisId() {
  return `pna_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Full history for a world, oldest-first. [] if never saved — not an error. */
export function getAnalysisHistory(world) {
  const filePath = analysisFilePath(world);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** The one entry with status:'current', or null (absence is valid). */
export function getCurrentAnalysis(world) {
  return getAnalysisHistory(world).find((e) => e.status === "current") ?? null;
}

function writeHistory(world, entries) {
  const validated = entries.map((e) => PlayerNotesAnalysisEntry.parse(e));
  const filePath = analysisFilePath(world);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(validated, null, 2), "utf8");
  });
  return validated;
}

/**
 * Record a new analysis for a world: supersedes the prior current entry,
 * appends the new one as current.
 *
 * @param {string} world
 * @param {{sessionNumber:number|null, flags:object[], noteCount:number}} data
 * @param {object} [opts]  {makeId?, now?}
 * @returns {object} the newly-saved current entry
 */
export function saveAnalysis(world, { sessionNumber, flags, noteCount }, opts = {}) {
  const makeId = opts.makeId ?? makeAnalysisId;
  const now = opts.now ?? new Date().toISOString();
  const existing = getAnalysisHistory(world).map((e) =>
    e.status === "current" ? { ...e, status: "superseded" } : e
  );
  const entry = {
    id: makeId(),
    createdAt: now,
    sessionNumber: sessionNumber ?? null,
    flags: flags ?? [],
    noteCount: noteCount ?? 0,
    status: "current"
  };
  writeHistory(world, [...existing, entry]);
  return entry;
}

export { ConcurrentWriteError };
