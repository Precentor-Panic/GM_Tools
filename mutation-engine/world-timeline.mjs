/**
 * World timeline — a bandaid, not a history system. One git commit per
 * synced mutation batch inside `<dataDir>/worlds/<world>/`, so a commit is a
 * slice of world time and a git branch is an alternate timeline a GM can
 * check out to explore a "what if" without losing the mainline. That's the
 * entire feature. This is deliberately NOT a full undo/redo/history engine,
 * not a replacement for `mutation-engine/rollback.mjs` (the app's own,
 * review-state-aware rollback), and not a place to grow branch-merge/diff
 * tooling — see `plans/world-timeline.md` for the boundary and the caveats a
 * GM needs before ever touching this repo by hand.
 *
 * THE NEVER-THROWS CONTRACT: `commitWorldTimeline` must never throw. It is
 * called from the sync path (see wf-mcp-server/lib/mutation-ops.mjs, wired
 * separately from this module), and a sync must never fail — or even
 * degrade its own real result — because the timeline commit had a bad day
 * (git missing, repo locked, nothing staged, whatever). Every failure mode
 * is a normal, valid return value: `{committed:false, warning:"<why>"}`.
 * There is no case in which a caller needs to wrap this in try/catch.
 *
 * THE LIVE-PATH STALENESS CAVEAT: on a live Foundry sync, `world-fabric-
 * snapshot.json` is re-exported by the Foundry client asynchronously after
 * the mutation bridge file is polled and applied — this module has no way
 * to block on that export finishing. A commit taken right after a live sync
 * can therefore capture the PREVIOUS snapshot content one beat behind the
 * mutations that were just applied. This is a known, accepted lag, not a
 * bug: the next commit (the next synced batch, or a later manual re-sync)
 * always settles it, because `git add -A` + `git status --porcelain` only
 * ever commits whatever the snapshot file actually contains on disk at call
 * time. The headless-apply path (graph-import/headless-apply.mjs) has no
 * such lag — it writes the snapshot synchronously before returning.
 *
 * Repo boundary: this module only ever touches `<dataDir>/worlds/<world>/`
 * as its own independent git repo (lazily `git init`-ed the first time a
 * commit is attempted there) — never the GM_Tools source tree, never a
 * parent directory. The repo's own `.gitignore` is a deny-all allowlist
 * (written once, never clobbered if a GM has hand-edited it) so Foundry's
 * binary LevelDB (`data/`, LOCKed while Foundry runs) and the regenerated/
 * transient bridge files (`world-fabric-foundry-index.json`,
 * `world-fabric-mutations.json`, `world-fabric-foundry-ops.json`,
 * `world-fabric-foundry-results.json`) never enter history — only
 * `world-fabric-snapshot.json` and the `narrative-state/` sidecar tree are
 * ever tracked.
 *
 * Pure fs + child_process; no new dependency. Git identity is always passed
 * explicitly on the commit invocation (`-c user.name=... -c user.email=...`)
 * so this never depends on — or silently uses — whatever `git config
 * user.*` happens to be set globally on the machine running GM_Tools.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getChronicleRun } from "../session-planner/chronicle-run.mjs";
import { getWorldClock } from "../session-planner/world-clock.mjs";

// The time-skip batch producers that always represent world time moving
// forward, regardless of whether a chronicle-run sidecar exists for the
// batch (chronicle-run.mjs's own sidecar is written ONLY by Chronicle's own
// composer route — see that module's header — so a batch created by any
// other path, including these, has no sidecar to consult at all).
const TIME_SKIP_SCOPE_MODES = new Set(["seed", "ambient", "branches", "region"]);

// Deny-all allowlist: block everything, then explicitly re-admit exactly the
// World Fabric state this timeline is for. Written verbatim, once, only when
// no `.gitignore` already exists in the repo dir (see step 3 of
// commitWorldTimeline) — never overwrites a GM's own hand edits to it.
const GITIGNORE_CONTENT = `# world-timeline allowlist -- deny everything, then admit only World Fabric state.
# data/ is Foundry's own LevelDB (binary, churning, LOCKed while Foundry runs);
# the index/mutations/ops/results files are regenerated or transient bridge channels.
/*
!.gitignore
!world-fabric-snapshot.json
!narrative-state/
!narrative-state/**
`;

/**
 * Whether a synced batch represents world time moving forward — used to
 * pick `time:moved` vs `time:static` in the commit message. True when
 * EITHER: the batch has a chronicle-run sidecar record (session-planner/
 * chronicle-run.mjs's `getChronicleRun`) with `elapsedSessions !== null ||
 * span !== null` (a real Chronicle run that advanced the clock, per that
 * module's own nullable-fields contract — an intake batch has both null and
 * is correctly NOT "moved time" by this check); OR `scopeMode` is one of the
 * time-skip batch producers (`seed`/`ambient`/`branches`/`region`), which
 * always advance world time even when composed outside Chronicle's UI (so
 * they never get a chronicle-run sidecar at all).
 *
 * The chronicle-run lookup is wrapped in try/catch: any failure reading it
 * (corrupt sidecar, unexpected env state, whatever) falls back to relying
 * on the `scopeMode` check alone rather than propagating an error out of a
 * pure classification helper.
 *
 * @param {string} world
 * @param {string} batchId
 * @param {string} [scopeMode]
 * @returns {boolean}
 */
export function classifyMovedTime(world, batchId, scopeMode) {
  let chronicleMoved = false;
  try {
    const record = getChronicleRun(world, batchId);
    chronicleMoved = !!record && (record.elapsedSessions !== null || record.span !== null);
  } catch {
    chronicleMoved = false; // fall back to the scopeMode check below
  }
  return chronicleMoved || TIME_SKIP_SCOPE_MODES.has(scopeMode);
}

function runGit(repoDir, args) {
  return execFileSync("git", args, {
    cwd: repoDir,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  }).toString("utf8");
}

/**
 * Commit the current on-disk state of `<dir>/worlds/<world>/` as one
 * world-timeline snapshot. NEVER THROWS — see this module's header. Every
 * failure path returns `{committed:false, warning:"<why>"}`; success
 * returns `{committed:true, sha}`.
 *
 * @param {string} dir     the Foundry data dir (dataDir)
 * @param {string} world   world id
 * @param {object} opts
 * @param {string} opts.batchId
 * @param {string} [opts.scopeMode]    time-skip scope mode, or undefined for a non-time-skip batch
 * @param {boolean} [opts.movedTime]   if omitted, computed via classifyMovedTime(world, batchId, scopeMode)
 * @param {string} [opts.worldDate]    if omitted, read from getWorldClock(world).currentDate
 * @param {string} [opts.action]       free string, default "wf-sync" ("wf-sync" | "wf-rollback" | "session-wrap")
 * @returns {{committed:boolean, sha?:string, warning?:string}}
 */
export function commitWorldTimeline(dir, world, opts = {}) {
  const { batchId, scopeMode, action = "wf-sync" } = opts;

  // 1. Kill switch.
  if (process.env.WF_TIMELINE_GIT === "0") {
    return { committed: false, warning: "timeline disabled (WF_TIMELINE_GIT=0)" };
  }

  // 2. Target repo dir must already exist — this module never creates the
  // world's own directory, only (lazily) a .git inside it.
  const repoDir = join(dir, "worlds", world);
  if (!existsSync(repoDir)) {
    return { committed: false, warning: `world directory does not exist: ${repoDir}` };
  }

  const movedTime = opts.movedTime !== undefined ? opts.movedTime : classifyMovedTime(world, batchId, scopeMode);

  let worldDate = opts.worldDate;
  if (worldDate === undefined) {
    try {
      worldDate = getWorldClock(world).currentDate;
    } catch {
      worldDate = "(no world clock)";
    }
  }

  // 3. Lazy init, then (init'd or not) ensure the allowlist .gitignore.
  try {
    if (!existsSync(join(repoDir, ".git"))) {
      runGit(repoDir, ["init"]);
    }
  } catch (err) {
    return { committed: false, warning: `git init failed: ${err.message}` };
  }

  try {
    const gitignorePath = join(repoDir, ".gitignore");
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, GITIGNORE_CONTENT, "utf8");
    }
  } catch (err) {
    return { committed: false, warning: `failed to write .gitignore: ${err.message}` };
  }

  // 4. Stage everything, then check whether there's anything to commit.
  try {
    runGit(repoDir, ["add", "-A"]);
  } catch (err) {
    return { committed: false, warning: `git add failed: ${err.message}` };
  }

  let status;
  try {
    status = runGit(repoDir, ["status", "--porcelain"]);
  } catch (err) {
    return { committed: false, warning: `git status failed: ${err.message}` };
  }
  if (!status.trim()) {
    // A NORMAL case (e.g. a live-path sync where Foundry hasn't re-exported
    // the snapshot yet) -- not an error, worded neutrally.
    return { committed: false, warning: "nothing to commit" };
  }

  // 5. Commit with an explicit identity, never the machine's global config.
  const timeSegment = movedTime ? "time:moved" : "time:static";
  const scopeSegment = scopeMode != null ? ` (${scopeMode})` : "";
  const message = `${action} ${batchId} [${timeSegment}]${scopeSegment} — ${worldDate}`;

  try {
    runGit(repoDir, [
      "-c", "user.name=GM Tools Timeline",
      "-c", "user.email=gm-tools@localhost",
      "commit", "-m", message
    ]);
  } catch (err) {
    return { committed: false, warning: `git commit failed: ${err.message}` };
  }

  // 6. Report back the new commit.
  try {
    const sha = runGit(repoDir, ["rev-parse", "--short", "HEAD"]).trim();
    return { committed: true, sha };
  } catch (err) {
    return { committed: false, warning: `git rev-parse failed: ${err.message}` };
  }
}
