/**
 * Shared player-notes operations — thin wrappers over
 * session-planner/analyze-player-notes.mjs + player-notes-analysis.mjs, called
 * identically by wf-mcp-server's MCP tool AND review-ui/server.mjs's HTTP route
 * (the "front-ends are thin wrappers" convention).
 *
 * GM-ONLY, NEVER TABLE-FACING. analyzePlayerNotes is handed the full GM-only
 * narrative-state truth (to judge "close-to-truth"), so its output and every
 * surface that renders it are GM-only. No route/tool here may ever reach a
 * player. It does not touch the graph, a Mutation, a review Batch, or any
 * Foundry sync path — it reads the player-notes bridge file + the sidecar and
 * (optionally) persists the ANALYSIS RESULT with history. The GM action is the
 * review; no silent-auto-write to canon is possible from here.
 */
import { analyzePlayerNotes } from "../../session-planner/analyze-player-notes.mjs";
import { saveAnalysis, getCurrentAnalysis, getAnalysisHistory } from "../../session-planner/player-notes-analysis.mjs";

/**
 * Analyze the world's current player notes and (by default) persist the result.
 * @returns {Promise<{flags, dropped, noteCount, saved:object|null}>}
 */
export async function analyzePlayerNotesOp(dir, world, { sessionNumber = null, persist = true } = {}, opts = {}) {
  const result = await analyzePlayerNotes(dir, world, opts);
  let saved = null;
  if (persist) {
    saved = saveAnalysis(world, {
      sessionNumber,
      flags: result.flags,
      noteCount: result.noteCount
    });
  }
  return { ...result, saved };
}

/** Read the current + full history of saved analyses for a world. */
export function getPlayerNotesAnalysisOp(_dir, world) {
  return { current: getCurrentAnalysis(world), history: getAnalysisHistory(world) };
}
