import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate every store this module reads from (chronicle-run, world-clock,
// app-settings) BEFORE importing — the standing "no write leaked into a
// real directory" pattern from test/user-settings.test.mjs /
// test/narrative-state.test.mjs. world-timeline.mjs's OWN target (a world's
// dataDir subtree) is created fresh per test below, since that subtree IS
// the thing under test, not a leak to guard against.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-world-timeline-test-"));
process.env.GM_TOOLS_CHRONICLE_RUN_DIR = join(scratchDir, "chronicle-run");
process.env.GM_TOOLS_WORLD_CLOCK_DIR = join(scratchDir, "world-clock");
process.env.GM_TOOLS_APP_SETTINGS_DIR = join(scratchDir, "app-settings");

const { classifyMovedTime, commitWorldTimeline } = await import("../mutation-engine/world-timeline.mjs");
const { recordChronicleRun } = await import("../session-planner/chronicle-run.mjs");

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

// ------------------------------------------------------------- test helpers

function freshDataDir() {
  return mkdtempSync(join(scratchDir, "data-"));
}

function makeWorldDir(dataDir, world) {
  const repoDir = join(dataDir, "worlds", world);
  mkdirSync(repoDir, { recursive: true });
  return repoDir;
}

function writeSnapshot(repoDir, content) {
  writeFileSync(join(repoDir, "world-fabric-snapshot.json"), content, "utf8");
}

function gitLogSubjects(repoDir, n = 20) {
  return execFileSync("git", ["log", `-n`, String(n), "--format=%s"], { cwd: repoDir })
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
}

function gitLsFiles(repoDir) {
  return execFileSync("git", ["ls-files"], { cwd: repoDir }).toString("utf8").split("\n").filter(Boolean);
}

function gitStatusPorcelain(repoDir) {
  return execFileSync("git", ["status", "--porcelain"], { cwd: repoDir }).toString("utf8");
}

function gitLogCount(repoDir) {
  return execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: repoDir }).toString("utf8").trim();
}

// ---------------------------------------------------------- basic commit + message format

test("first commit lazily inits the repo, writes the allowlist .gitignore, commits, returns {committed:true, sha}", () => {
  const dataDir = freshDataDir();
  const repoDir = makeWorldDir(dataDir, "w1");
  writeSnapshot(repoDir, JSON.stringify({ v: 1 }));

  assert.ok(!existsSync(join(repoDir, ".git")), "precondition: no repo yet");

  const result = commitWorldTimeline(dataDir, "w1", {
    batchId: "batch-001",
    scopeMode: "region",
    movedTime: true,
    worldDate: "Day 10",
    action: "wf-sync"
  });

  assert.equal(result.committed, true);
  assert.ok(typeof result.sha === "string" && result.sha.length > 0);
  assert.ok(existsSync(join(repoDir, ".git")), "git init happened");
  assert.ok(existsSync(join(repoDir, ".gitignore")), ".gitignore written");

  const realSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoDir }).toString("utf8").trim();
  assert.equal(result.sha, realSha);

  const subjects = gitLogSubjects(repoDir);
  assert.equal(subjects.length, 1);
  assert.equal(subjects[0], "wf-sync batch-001 [time:moved] (region) — Day 10");
});

test("message format: time:static variant, and scopeMode segment omitted when undefined", () => {
  const dataDir = freshDataDir();
  const repoDir = makeWorldDir(dataDir, "w2");
  writeSnapshot(repoDir, JSON.stringify({ v: 1 }));

  const result = commitWorldTimeline(dataDir, "w2", {
    batchId: "batch-002",
    movedTime: false,
    worldDate: "Day 5",
    action: "wf-rollback"
  });

  assert.equal(result.committed, true);
  const subjects = gitLogSubjects(repoDir);
  assert.equal(subjects[0], "wf-rollback batch-002 [time:static] — Day 5");
});

test("default action is wf-sync; worldDate defaults to getWorldClock(world).currentDate when omitted", () => {
  const dataDir = freshDataDir();
  const repoDir = makeWorldDir(dataDir, "w3");
  writeSnapshot(repoDir, JSON.stringify({ v: 1 }));

  const result = commitWorldTimeline(dataDir, "w3", { batchId: "batch-003", movedTime: true, scopeMode: "seed" });
  assert.equal(result.committed, true);
  const subjects = gitLogSubjects(repoDir);
  // A fresh world-clock (no advance recorded) starts at "Day 0" per
  // session-planner/world-clock.mjs's defaultRecord().
  assert.equal(subjects[0], "wf-sync batch-003 [time:moved] (seed) — Day 0");
});

// --------------------------------------------------------------- allowlist

test("allowlist: only .gitignore, world-fabric-snapshot.json, and narrative-state/* are ever tracked; status is clean after commit", () => {
  const dataDir = freshDataDir();
  const repoDir = makeWorldDir(dataDir, "w4");
  writeSnapshot(repoDir, JSON.stringify({ v: 1 }));

  // Plant everything that must NEVER be committed.
  mkdirSync(join(repoDir, "data"), { recursive: true });
  writeFileSync(join(repoDir, "data", "000005.ldb"), "binary-leveldb-stand-in");
  writeFileSync(join(repoDir, "data", "LOCK"), "");
  writeFileSync(join(repoDir, "world-fabric-foundry-index.json"), JSON.stringify({ huge: true }));
  writeFileSync(join(repoDir, "world-fabric-mutations.json"), JSON.stringify([]));
  writeFileSync(join(repoDir, "world-fabric-foundry-ops.json"), JSON.stringify([]));
  writeFileSync(join(repoDir, "world-fabric-foundry-results.json"), JSON.stringify([]));

  // Plant narrative-state sidecar files, which MUST be tracked.
  mkdirSync(join(repoDir, "narrative-state"), { recursive: true });
  writeFileSync(join(repoDir, "narrative-state", "e1.json"), JSON.stringify({ entityId: "e1" }));

  const result = commitWorldTimeline(dataDir, "w4", { batchId: "batch-004", movedTime: false, worldDate: "Day 1" });
  assert.equal(result.committed, true);

  const tracked = gitLsFiles(repoDir).sort();
  assert.deepEqual(tracked, [".gitignore", "narrative-state/e1.json", "world-fabric-snapshot.json"]);

  assert.equal(gitStatusPorcelain(repoDir), "", "nothing untracked-but-unignored after commit");
});

// -------------------------------------------------------------- idempotent

test("idempotent: a second commit call with no changes doesn't re-init or duplicate; returns nothing-to-commit", () => {
  const dataDir = freshDataDir();
  const repoDir = makeWorldDir(dataDir, "w5");
  writeSnapshot(repoDir, JSON.stringify({ v: 1 }));

  const first = commitWorldTimeline(dataDir, "w5", { batchId: "batch-005a", movedTime: true, worldDate: "Day 1" });
  assert.equal(first.committed, true);
  assert.equal(gitLogCount(repoDir), "1");

  const second = commitWorldTimeline(dataDir, "w5", { batchId: "batch-005b", movedTime: true, worldDate: "Day 2" });
  assert.equal(second.committed, false);
  assert.match(second.warning, /nothing to commit/);
  assert.equal(gitLogCount(repoDir), "1", "no duplicate/second commit");
});

// ------------------------------------------------------ pre-existing .gitignore

test("a pre-existing user .gitignore is NOT overwritten", () => {
  const dataDir = freshDataDir();
  const repoDir = makeWorldDir(dataDir, "w6");
  const userGitignore = "# hand-authored by the GM\n*.bak\n";
  writeFileSync(join(repoDir, ".gitignore"), userGitignore, "utf8");
  writeSnapshot(repoDir, JSON.stringify({ v: 1 }));

  const result = commitWorldTimeline(dataDir, "w6", { batchId: "batch-006", movedTime: false, worldDate: "Day 1" });
  assert.equal(result.committed, true);
  assert.equal(readFileSync(join(repoDir, ".gitignore"), "utf8"), userGitignore);
});

// ------------------------------------------------------------ classifyMovedTime

test("classifyMovedTime: true via a real chronicle-run record with elapsedSessions set", () => {
  recordChronicleRun("chrono-world", "cr-batch-1", { span: null, fortuneAtRun: null, elapsedSessions: 13 });
  assert.equal(classifyMovedTime("chrono-world", "cr-batch-1"), true);
});

test("classifyMovedTime: true via a real chronicle-run record with span set (elapsedSessions null)", () => {
  recordChronicleRun("chrono-world", "cr-batch-2", { span: { spanId: "season" }, fortuneAtRun: "fair", elapsedSessions: null });
  assert.equal(classifyMovedTime("chrono-world", "cr-batch-2"), true);
});

test("classifyMovedTime: true via scopeMode 'region' with no chronicle-run record", () => {
  assert.equal(classifyMovedTime("chrono-world", "no-such-batch", "region"), true);
});

test("classifyMovedTime: false for scopeMode 'writeup-import' with no chronicle-run record", () => {
  assert.equal(classifyMovedTime("chrono-world", "no-such-batch-2", "writeup-import"), false);
});

test("classifyMovedTime: false for a chronicle-run record with both span and elapsedSessions null (e.g. an intake batch), and no time-skip scopeMode", () => {
  recordChronicleRun("chrono-world", "cr-batch-3", { span: null, fortuneAtRun: null, elapsedSessions: null });
  assert.equal(classifyMovedTime("chrono-world", "cr-batch-3"), false);
});

// -------------------------------------------------------------------- degrade

test("degrade: world directory doesn't exist -> {committed:false, warning}, never throws", () => {
  const dataDir = freshDataDir();
  assert.doesNotThrow(() => {
    const result = commitWorldTimeline(dataDir, "no-such-world", { batchId: "batch-x" });
    assert.equal(result.committed, false);
    assert.ok(typeof result.warning === "string" && result.warning.length > 0);
  });
});

test("degrade: git binary missing -> {committed:false, warning}, never throws", () => {
  const dataDir = freshDataDir();
  const repoDir = makeWorldDir(dataDir, "w7");
  writeSnapshot(repoDir, JSON.stringify({ v: 1 }));

  const emptyBinDir = mkdtempSync(join(scratchDir, "empty-bin-"));
  const savedPath = process.env.PATH;
  process.env.PATH = emptyBinDir;
  try {
    assert.doesNotThrow(() => {
      const result = commitWorldTimeline(dataDir, "w7", { batchId: "batch-007", movedTime: true, worldDate: "Day 1" });
      assert.equal(result.committed, false);
      assert.ok(typeof result.warning === "string" && result.warning.length > 0);
    });
  } finally {
    process.env.PATH = savedPath;
  }

  // Confirm this was a genuine "git could not run" case, not some other
  // early return, by proving a normal commit now succeeds with PATH restored.
  const retried = commitWorldTimeline(dataDir, "w7", { batchId: "batch-007b", movedTime: true, worldDate: "Day 1" });
  assert.equal(retried.committed, true);
});

// ------------------------------------------------------------------ kill switch

test("kill switch: WF_TIMELINE_GIT=0 -> {committed:false}, no .git created", () => {
  const dataDir = freshDataDir();
  const repoDir = makeWorldDir(dataDir, "w8");
  writeSnapshot(repoDir, JSON.stringify({ v: 1 }));

  const saved = process.env.WF_TIMELINE_GIT;
  process.env.WF_TIMELINE_GIT = "0";
  try {
    const result = commitWorldTimeline(dataDir, "w8", { batchId: "batch-008", movedTime: true, worldDate: "Day 1" });
    assert.equal(result.committed, false);
    assert.match(result.warning, /WF_TIMELINE_GIT=0/);
  } finally {
    if (saved === undefined) delete process.env.WF_TIMELINE_GIT;
    else process.env.WF_TIMELINE_GIT = saved;
  }

  assert.ok(!existsSync(join(repoDir, ".git")), "no repo was initialized while the kill switch was on");
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
