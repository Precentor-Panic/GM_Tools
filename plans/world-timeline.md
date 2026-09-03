# World Timeline

`mutation-engine/world-timeline.mjs` — a bandaid, not a history system.

## What it is

One git commit per synced mutation batch, taken inside the world's own
directory: `<dataDir>/worlds/<world>/`. A commit is a slice of world time; a
git branch off that history is an alternate timeline. That is the entire
feature. It is deliberately **not**:

- a replacement for `mutation-engine/rollback.mjs` (the app's own,
  review-state-aware, single-batch rollback — still the only supported way
  to undo a batch);
- a full undo/redo/audit-log system;
- a place to grow branch-merge/diff tooling later without a fresh design
  pass.

Two exports:

- `classifyMovedTime(world, batchId, scopeMode)` — pure boolean classifier.
  True when the batch's chronicle-run sidecar (`session-planner/
  chronicle-run.mjs`) shows `elapsedSessions !== null || span !== null` (a
  real Chronicle run that advanced the clock), OR `scopeMode` is one of the
  time-skip batch producers: `seed` / `ambient` / `branches` / `region`
  (these always move world time even when composed outside Chronicle's own
  UI, so they never get a chronicle-run sidecar to check). The chronicle-run
  read is wrapped in try/catch and falls back to the `scopeMode` check alone
  on any failure.
- `commitWorldTimeline(dir, world, {batchId, scopeMode, movedTime, worldDate,
  action})` — does the commit. **Never throws.** Every failure path returns
  `{committed:false, warning:"<why>"}`; success returns `{committed:true,
  sha}`.

## Commit message format

```
<action> <batchId> [time:moved|time:static] (<scopeMode>) — <worldDate>
```

- `action` is a free string, default `"wf-sync"` (also used: `"wf-rollback"`,
  `"session-wrap"`).
- The `(<scopeMode>)` segment is omitted entirely when `scopeMode` is
  undefined/null (most batches aren't time-skip batches).
- `worldDate` defaults to `getWorldClock(world).currentDate` (falls back to
  `"(no world clock)"` if that read fails for any reason) — it is the
  in-world date, not a real-world timestamp; git's own commit timestamp
  already covers real-world time.

## Repo boundary + allowlist

Each world gets its own independent git repo at `<dataDir>/worlds/<world>/`,
lazily `git init`-ed on the first commit attempt. This is **never** the
GM_Tools source tree, never a parent directory, and there is no
pre-existing `.git` anywhere under the data dir before this module creates
one.

The repo's `.gitignore` is a deny-all allowlist, written once and never
overwritten if a GM has hand-edited it:

```
/*
!.gitignore
!world-fabric-snapshot.json
!narrative-state/
!narrative-state/**
```

Why deny-all rather than a deny-list: the world directory also holds Foundry's
own LevelDB (`data/`, binary, churning, LOCKed while Foundry runs — must
never be committed, and could never usefully be diffed anyway) and several
regenerated-wholesale or purely transient bridge files
(`world-fabric-foundry-index.json`, `world-fabric-mutations.json`,
`world-fabric-foundry-ops.json`, `world-fabric-foundry-results.json`). An
allow-list is the safer default against a *future* file this module's author
didn't anticipate landing in that directory — it's excluded by default,
rather than silently committed by default.

## **The most important caveat: never touch this repo by hand while Foundry is open**

**Only ever run `git checkout` / `git branch` / `git switch` by hand inside a
world's timeline repo while the Foundry client for that world is CLOSED.**
A live Foundry client owns `world-fabric-snapshot.json` and re-exports it on
every graph write, on its own schedule, with no awareness that a GM just
checked out a different commit underneath it. Checking out an old commit
(or a branch) while Foundry is running will very likely have its snapshot
silently re-exported right back over the checked-out one the next time
anything in the graph changes — the "alternate timeline" your checkout was
supposed to represent gets clobbered by the live client without warning.

**Revert = the app's own rollback (`mutation-engine/rollback.mjs`), never
`git checkout`,** for any circumstance where review-state or another store
still references batch state you'd be discarding. This timeline's git
history is a read-mostly record for later browsing/branching between
sessions — not an in-session undo control. Manual `git checkout`/`branch`
work belongs strictly between sessions, with Foundry closed.

## Live-path staleness

On a live Foundry sync, `world-fabric-snapshot.json` is re-exported by the
Foundry client *asynchronously*, after the mutation bridge file is polled
and applied. `commitWorldTimeline` has no way to block on that export
finishing, so a commit taken immediately after a live sync can capture the
*previous* snapshot content — one export behind the mutations that were
just applied. This is a known, accepted lag, not a bug: the very next
commit (the next synced batch, or a later manual re-sync) always settles it,
since staging + committing only ever reflects whatever is actually on disk
at call time. The headless-apply path has no such lag (it writes the
snapshot synchronously before returning).

## Kill switch

Set `WF_TIMELINE_GIT=0` in the environment to disable this entirely — every
call to `commitWorldTimeline` then immediately returns
`{committed:false, warning:"timeline disabled (WF_TIMELINE_GIT=0)"}` without
touching the filesystem or invoking git at all. Useful for an environment
with no git binary, a read-only data dir, or simply while this feature is
being rolled out cautiously.

## Never-throws contract

`commitWorldTimeline` must never throw, because it is called from the sync
path (wired into `wf-mcp-server/lib/mutation-ops.mjs` separately from this
module) and a sync's real result must never be degraded by the timeline
commit having a bad day — git binary missing, the repo dir locked, nothing
staged (a normal case, not an error), or the commit itself failing for any
reason. Every one of those is a valid, quiet `{committed:false, warning}`
return. No caller needs to wrap this in try/catch.

## No schema-version constant

Unlike this project's other new stores (which get a `SCHEMA_VERSION`
constant per the project's schema-versioning discipline), this module has no
persisted JSON shape of its own to version — its only persisted artifact is
a git repository plus a fixed, checked-in-once `.gitignore` text file. The
commit *message format* is the closest thing to a versioned contract here;
if it ever needs to change shape, document the change and the reasoning
directly in this file and in `world-timeline.mjs`'s own header comment,
rather than adding a version constant with nothing to attach it to.
