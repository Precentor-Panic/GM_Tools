import assert from "node:assert/strict";
import { mkdtempSync, rmSync, openSync, closeSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the store root (and review-state, whose withLock it reuses) BEFORE
// importing — the standing "no write leaked into a real directory" pattern
// from test/user-settings.test.mjs. narrative-state's DEFAULT root lives in
// the WORLD DATA DIR (call A), so the leak guard below watches a fake dataDir
// world dir rather than a GM_Tools-side default.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-narrative-state-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_NARRATIVE_STATE_DIR = join(scratchDir, "narrative-state");

const {
  SCHEMA_VERSION,
  narrativeStateRoot,
  getNarrativeState,
  listNarrativeState,
  getRevealStates,
  setNarrativeTruth,
  setStance,
  setRevealState,
  setClock,
  tickClock,
  ConcurrentWriteError
} = await import("../mutation-engine/narrative-state.mjs");

// A dataDir that must NEVER be written to while the env override is set.
const untouchedDataDir = join(scratchDir, "fake-wf-data");
const DIR = untouchedDataDir; // every call passes it; override must win
const W = "testworld";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

// ------------------------------------------------------------------- basics

test("schema version exported", () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test("directory isolation: narrativeStateRoot honors GM_TOOLS_NARRATIVE_STATE_DIR (world subdir applied), never the dataDir default", () => {
  assert.equal(narrativeStateRoot(DIR, W), join(process.env.GM_TOOLS_NARRATIVE_STATE_DIR, W));
  assert.ok(!narrativeStateRoot(DIR, W).startsWith(untouchedDataDir));
});

test("default (no override) root lives in the WORLD data dir per call A", () => {
  const saved = process.env.GM_TOOLS_NARRATIVE_STATE_DIR;
  delete process.env.GM_TOOLS_NARRATIVE_STATE_DIR;
  try {
    assert.equal(narrativeStateRoot("/data", "kilmarn"), join("/data", "worlds", "kilmarn", "narrative-state"));
  } finally {
    process.env.GM_TOOLS_NARRATIVE_STATE_DIR = saved;
  }
});

test("getNarrativeState: absent record returns null (null = fully open, zero gating)", () => {
  assert.equal(getNarrativeState(DIR, W, "nobody"), null);
});

test("setNarrativeTruth creates a record at 'unrevealed' with a from:null creation transition", () => {
  const r = setNarrativeTruth(DIR, W, "e1", "He is the siphon's architect.", {}, { now: "2026-09-02T10:00:00.000Z" });
  assert.equal(r.revealState, "unrevealed");
  assert.equal(r.truth, "He is the siphon's architect.");
  assert.deepEqual(r.transitions, [
    { from: null, to: "unrevealed", at: "2026-09-02T10:00:00.000Z", sessionNumber: null, source: "manual" }
  ]);
  assert.equal(r.createdAt, "2026-09-02T10:00:00.000Z");
});

test("setNarrativeTruth meta carries stance and provenance; null truth clears the field", () => {
  setNarrativeTruth(DIR, W, "e2", "hidden agenda", { stance: "concealing", sourceBatchId: "b1", sourceMutationId: "m1" }, { now: "2026-09-02T10:00:00.000Z" });
  let r = getNarrativeState(DIR, W, "e2");
  assert.equal(r.stance, "concealing");
  assert.equal(r.sourceBatchId, "b1");
  assert.equal(r.sourceMutationId, "m1");
  r = setNarrativeTruth(DIR, W, "e2", null, {}, { now: "2026-09-02T11:00:00.000Z" });
  assert.equal(r.truth, undefined);
  assert.equal(r.stance, "concealing", "clearing truth must not clear stance");
  assert.equal(r.updatedAt, "2026-09-02T11:00:00.000Z");
});

test("setStance: sets, clears with null, rejects a bad value", () => {
  let r = setStance(DIR, W, "e3", "unaware", { now: "2026-09-02T10:00:00.000Z" });
  assert.equal(r.stance, "unaware");
  assert.equal(r.revealState, "unrevealed", "create-on-first-touch default");
  r = setStance(DIR, W, "e3", null, { now: "2026-09-02T10:01:00.000Z" });
  assert.equal(r.stance, undefined);
  assert.throws(() => setStance(DIR, W, "e3", "sneaky"));
});

// -------------------------------------------------------------- transitions

test("setRevealState on a fresh entity creates the record directly at the target state", () => {
  const r = setRevealState(DIR, W, "e4", "hidden", { source: "intake" }, { now: "2026-09-02T10:00:00.000Z" });
  assert.equal(r.revealState, "hidden");
  assert.deepEqual(r.transitions, [
    { from: null, to: "hidden", at: "2026-09-02T10:00:00.000Z", sessionNumber: null, source: "intake" }
  ]);
});

test("setRevealState appends transitions (append-only history) and stamps source/sessionNumber/note", () => {
  setRevealState(DIR, W, "e5", "unrevealed", {}, { now: "2026-09-02T10:00:00.000Z" });
  setRevealState(DIR, W, "e5", "hinted", { source: "manual", note: "dropped the ledger clue" }, { now: "2026-09-02T11:00:00.000Z" });
  const r = setRevealState(DIR, W, "e5", "revealed", { source: "wrap", sessionNumber: 3 }, { now: "2026-09-02T12:00:00.000Z" });
  assert.equal(r.revealState, "revealed");
  assert.equal(r.transitions.length, 3);
  assert.deepEqual(r.transitions[1], {
    from: "unrevealed", to: "hinted", at: "2026-09-02T11:00:00.000Z", sessionNumber: null, source: "manual", note: "dropped the ledger clue"
  });
  assert.deepEqual(r.transitions[2], {
    from: "hinted", to: "revealed", at: "2026-09-02T12:00:00.000Z", sessionNumber: 3, source: "wrap"
  });
});

test("setRevealState same-state is a no-op: nothing written, no transition appended", () => {
  setRevealState(DIR, W, "e6", "hinted", {}, { now: "2026-09-02T10:00:00.000Z" });
  const before = JSON.stringify(getNarrativeState(DIR, W, "e6"));
  const r = setRevealState(DIR, W, "e6", "hinted", { source: "wrap" }, { now: "2026-09-02T11:00:00.000Z" });
  assert.equal(r.transitions.length, 1);
  assert.equal(JSON.stringify(getNarrativeState(DIR, W, "e6")), before, "file on disk unchanged");
});

test("setRevealState rejects an invalid state", () => {
  assert.throws(() => setRevealState(DIR, W, "e6", "obliterated"));
});

// -------------------------------------------------------------------- clocks

test("setClock validates and stores; tickClock advances and clamps at max", () => {
  setClock(DIR, W, "e7", { value: 0, max: 6, cadence: "per session" }, { now: "2026-09-02T10:00:00.000Z" });
  let r = tickClock(DIR, W, "e7", 2, { now: "2026-09-02T11:00:00.000Z" });
  assert.equal(r.clock.value, 2);
  r = tickClock(DIR, W, "e7", 99, { now: "2026-09-02T12:00:00.000Z" });
  assert.equal(r.clock.value, 6, "clamped at max");
  r = tickClock(DIR, W, "e7", -99, { now: "2026-09-02T13:00:00.000Z" });
  assert.equal(r.clock.value, 0, "clamped at 0");
  assert.equal(r.clock.cadence, "per session", "tick preserves the rest of the clock");
});

test("setClock null clears; tickClock without a clock throws (not a quiet success)", () => {
  setClock(DIR, W, "e7", null, { now: "2026-09-02T14:00:00.000Z" });
  assert.equal(getNarrativeState(DIR, W, "e7").clock, null);
  assert.throws(() => tickClock(DIR, W, "e7"), /no clock to tick/);
  assert.throws(() => tickClock(DIR, W, "never-existed"), /no clock to tick/);
});

test("setClock rejects a malformed clock (negative value, missing max)", () => {
  assert.throws(() => setClock(DIR, W, "e8", { value: -1, max: 4 }));
  assert.throws(() => setClock(DIR, W, "e8", { value: 1 }));
});

// ------------------------------------------------------------- bulk + list

test("getRevealStates returns a Map with records only for entities that have one", () => {
  const map = getRevealStates(DIR, W, ["e1", "e4", "nobody-at-all"]);
  assert.equal(map.size, 2);
  assert.equal(map.get("e1").revealState, "unrevealed");
  assert.equal(map.get("e4").revealState, "hidden");
  assert.ok(!map.has("nobody-at-all"), "absent entities are absent — callers treat absence as open");
});

test("listNarrativeState scans the world and filters by revealState", () => {
  const all = listNarrativeState(DIR, W);
  assert.ok(all.length >= 6);
  const hidden = listNarrativeState(DIR, W, { revealState: "hidden" });
  assert.ok(hidden.every((r) => r.revealState === "hidden"));
  assert.ok(hidden.some((r) => r.entityId === "e4"));
  assert.deepEqual(listNarrativeState(DIR, "empty-world"), [], "missing world dir is [] not an error");
});

// -------------------------------------------------------------- concurrency

test("concurrent write: an existing lock file throws ConcurrentWriteError and leaves disk untouched", () => {
  setRevealState(DIR, W, "e9", "unrevealed", {}, { now: "2026-09-02T10:00:00.000Z" });
  const filePath = join(narrativeStateRoot(DIR, W), "e9.json");
  const before = readFileSync(filePath, "utf8");
  const fd = openSync(`${filePath}.lock`, "wx");
  try {
    assert.throws(() => setRevealState(DIR, W, "e9", "revealed", {}, { now: "2026-09-02T11:00:00.000Z" }), ConcurrentWriteError);
    assert.equal(readFileSync(filePath, "utf8"), before);
  } finally {
    closeSync(fd);
    rmSync(`${filePath}.lock`, { force: true });
  }
});

// ------------------------------------------------------------------- hygiene

test("stored file parses back strict (schema round-trip, no extra keys)", () => {
  const raw = JSON.parse(readFileSync(join(narrativeStateRoot(DIR, W), "e5.json"), "utf8"));
  assert.deepEqual(Object.keys(raw).sort(), ["createdAt", "entityId", "revealState", "transitions", "updatedAt"]);
});

test("no write in this file leaked into the fake dataDir (the env override always won)", () => {
  assert.ok(!existsSync(untouchedDataDir) || readdirSync(untouchedDataDir).length === 0,
    `nothing may be written under ${untouchedDataDir}`);
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
