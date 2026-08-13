/**
 * Chronicle-run sidecar — Phase 37 task 37.1. A tiny per-batch file, 1:1
 * keyed to an EXISTING mutation-engine/review-state.mjs batch file (itself
 * the permanent record) — NOT a second event log. See
 * review-ui/test/e2e/phase37-fixture.mjs §4's own "SIDECAR DECISION" for the
 * full pinned reasoning: chronicle-log (a READ layer composed in
 * review-ui/server.mjs) needs two fields listBatches() has no source for —
 * `span` and `fortuneAtRun` — and this is the small enrichment file that
 * supplies them, the same "small enrichment file keyed to an existing
 * primary record" pattern time-skip/status.mjs already establishes for a
 * batch's own texturing progress, one level over.
 *
 * Storage: `<chronicleRunRoot>/<world>/<batchId>.json`
 * (GM_TOOLS_CHRONICLE_RUN_DIR), SCHEMA_VERSION 1, following
 * mutation-engine/pending-ledger.mjs's per-entity-file-under-a-world-subdir
 * layout convention (one level deeper here: per-batch, not per-entity).
 * Reuses review-state.mjs's withLock rather than a second file-locking
 * implementation.
 *
 * Phase 37 task 37.5 (Russell's pass-cleanup): adds `promptSummary` --
 * additive, optional (defaults to `null` so a pre-37.5 sidecar file still
 * parses unchanged; no SCHEMA_VERSION bump needed for an optional-with-
 * default field). The chronicle-log history rail (review-ui/server.mjs's
 * `chronicleLogPayload`) reads this as its entry title so the rail never
 * renders a raw batch id as the headline -- see review-ui/public/
 * chronicle-view.js's `historyTitle`.
 *
 * Written EXACTLY ONCE, by POST /api/chronicle/run, in the same request that
 * calls createBatch (via orchestrateBatch/orchestrateCycle). A batch created
 * by ANY OTHER path (a bare wf_propose_mutations/wf_run_cycle MCP call, a
 * writeup-import reached via the MCP surface, a mention-scan) has NO
 * sidecar — getChronicleRun returns `null`, a real, valid, distinguishable
 * state ("this batch didn't come from Chronicle's own composer"), never a
 * thrown error or a synthetic guessed value.
 *
 * QA W3 finding 2: Chronicle's own "Receive new information" intake (POST
 * /api/writeup-propose rubber-duck-off, POST /api/writeup-select-framing's
 * new-batch path) ALSO writes this sidecar now, from review-ui/server.mjs's
 * own route handlers (never from wf-mcp-server/lib/mutation-ops.mjs's shared
 * proposeFromWriteupOp/selectFramingForNewBatch -- an MCP-driven writeup
 * import stays sidecar-less, matching the pre-existing "only the ONE
 * UI-composed path gets a sidecar" rule). An intake batch has no duration or
 * fortune concept, so `span`/`fortuneAtRun`/`elapsedSessions` are now
 * NULLABLE (widened, not narrowed -- every pre-existing record still
 * validates, since a real chronicle/run always supplies all three) --
 * `promptSummary` is the one field an intake batch always has (the pasted
 * text's own first line), which is exactly what the history rail needs to
 * title it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withLock } from "../mutation-engine/review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "chronicle-run");

export const SCHEMA_VERSION = 1;

const ChronicleRunRecord = z
  .object({
    batchId: z.string(),
    // QA W3 finding 2: nullable -- an intake batch (no time-skip involved)
    // has no real span/fortune/elapsedSessions to report. `null` for those
    // three is a real, valid "not a time-advancing run" state, never a guess.
    span: z.record(z.string(), z.any()).nullable(),
    fortuneAtRun: z.string().nullable(),
    elapsedSessions: z.number().nullable(),
    createdAt: z.string(),
    // Phase 37 task 37.5: additive, defaults to null (absent on any sidecar
    // written before this task) -- a real, valid "no described event"
    // state, never a guess.
    promptSummary: z.string().nullable().default(null)
  })
  .strict();

export function chronicleRunRoot() {
  return process.env.GM_TOOLS_CHRONICLE_RUN_DIR || DEFAULT_ROOT;
}

function filePath(world, batchId) {
  return join(chronicleRunRoot(), world, `${batchId}.json`);
}

/**
 * Record a batch's Chronicle run-composition metadata. Written exactly once,
 * by POST /api/chronicle/run, right after the batch it describes is created.
 * @param {string} world
 * @param {string} batchId
 * @param {{span:object|null, fortuneAtRun:string|null, elapsedSessions:number|null, promptSummary?:string|null}} meta
 * @returns {object} the persisted record
 */
export function recordChronicleRun(world, batchId, { span, fortuneAtRun, elapsedSessions, promptSummary = null }) {
  const path = filePath(world, batchId);
  const record = ChronicleRunRecord.parse({
    batchId,
    span,
    fortuneAtRun,
    elapsedSessions,
    promptSummary,
    createdAt: new Date().toISOString()
  });
  withLock(path, () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
  });
  return record;
}

/**
 * Look up a batch's Chronicle run-composition metadata. Returns `null` for a
 * batch NOT created via Chronicle's own composer — a real, valid state, not
 * an error.
 * @param {string} world
 * @param {string} batchId
 * @returns {object|null}
 */
export function getChronicleRun(world, batchId) {
  const path = filePath(world, batchId);
  if (!existsSync(path)) return null;
  return ChronicleRunRecord.parse(JSON.parse(readFileSync(path, "utf8")));
}
