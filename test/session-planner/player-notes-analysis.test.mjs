import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CONTRACT — session-planner/player-notes-analysis.mjs (analysis-result store).
 * Clones truth-notes.mjs's history/supersede shape. Pins: SCHEMA_VERSION,
 * history not overwrite, and the no-leak-into-the-repo-default regression
 * (test/user-settings.test.mjs convention).
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-pna-test-"));
process.env.GM_TOOLS_PLAYER_NOTES_ANALYSIS_DIR = join(scratchDir, "player-notes-analysis");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");

const {
  SCHEMA_VERSION,
  saveAnalysis,
  getCurrentAnalysis,
  getAnalysisHistory,
  playerNotesAnalysisRoot
} = await import("../../session-planner/player-notes-analysis.mjs");

const WORLD = "pna-world";
const FLAG = { noteId: "n1", authorId: "u1", entityId: "e1", kind: "thread", detail: "d" };

test("SCHEMA_VERSION is exported", () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test("directory isolation honors the env override, never the repo default", () => {
  assert.equal(playerNotesAnalysisRoot(), process.env.GM_TOOLS_PLAYER_NOTES_ANALYSIS_DIR);
  const repoDefault = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "player-notes-analysis");
  assert.notEqual(playerNotesAnalysisRoot(), repoDefault);
});

test("saveAnalysis: history, supersede, only one current", () => {
  const a = saveAnalysis(WORLD, { sessionNumber: 1, flags: [FLAG], noteCount: 3 }, { makeId: () => "pna-1", now: "2026-09-07T00:00:00.000Z" });
  assert.equal(a.status, "current");
  assert.equal(a.noteCount, 3);
  const b = saveAnalysis(WORLD, { sessionNumber: 2, flags: [], noteCount: 0 }, { makeId: () => "pna-2", now: "2026-09-07T01:00:00.000Z" });
  assert.equal(b.status, "current");
  const history = getAnalysisHistory(WORLD);
  assert.equal(history.length, 2);
  assert.equal(history.filter((e) => e.status === "current").length, 1, "exactly one current");
  assert.equal(getCurrentAnalysis(WORLD).id, "pna-2");
  assert.equal(history.find((e) => e.id === "pna-1").status, "superseded", "nothing deleted, prior superseded");
});

test("getCurrentAnalysis is null for an unseen world (absence is valid)", () => {
  assert.equal(getCurrentAnalysis("never-saved-world"), null);
  assert.deepEqual(getAnalysisHistory("never-saved-world"), []);
});

test("no-leak: nothing was written into the repo's real default directory", () => {
  const repoDefault = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "player-notes-analysis");
  // Only .gitkeep may exist there; no world file leaked.
  if (existsSync(repoDefault)) {
    const leaked = readdirSync(repoDefault).filter((f) => f.endsWith(".json"));
    assert.deepEqual(leaked, [], "no analysis JSON leaked into the repo default dir");
  }
});

test("cleanup", () => {
  rmSync(scratchDir, { recursive: true, force: true });
});
