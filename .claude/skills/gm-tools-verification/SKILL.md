---
name: gm-tools-verification
description: How to independently verify GM_Tools work (yours or a dispatched agent's) without rediscovering environment quirks each time — node's actual binary path, the real per-package test commands, and which failures are pre-existing and safe to ignore. Load before running any test suite in this repo, or before verifying an agent's completion report.
---

# GM_Tools Verification

This project's standing discipline is: after any agent dispatch, re-run the real test suites yourself rather than trusting a summary, and spot-check load-bearing claims against actual source. That discipline has repeatedly caught real problems (a skipped QE pass, stale-DOM test flakiness, a persistence gap). This skill exists so *executing* that discipline doesn't cost a fresh round of environment rediscovery every time.

## Environment: `node` is not on the default shell PATH

`which node` will fail in a fresh Bash tool call. The real binary lives at `/home/russell/.local/node/bin`. Prefix every command:

```bash
export PATH="/home/russell/.local/node/bin:$PATH"
```

## The real test commands (copy these, don't reconstruct from `node --test`)

Reconstructing a bare `node --test` at a package root silently picks up the wrong file set (it'll glob `test/fixtures/*.mjs` as if they were tests, or skip subdirectories, or include `.smoke.mjs`/`.e2e.mjs` files that need a live API key or a running server) — always read the package's own `package.json` `"scripts"` block and run that exact command, not a guess. As of this writing:

- **Root** (`/opt/dev/GM_Tools`): `node --env-file-if-exists=.env --test test/*.test.mjs test/session-planner/*.test.mjs test/combat-planning/*.test.mjs test/scene-planning/*.test.mjs`
- **`wf-mcp-server/`**: `node --env-file-if-exists=../.env --test test/*.test.mjs test/session-planner/*.test.mjs test/combat-planning/*.test.mjs test/scene-planning/*.test.mjs`
- **`review-ui/`** deterministic: `node --test test/*.test.mjs` (flat, non-recursive — all deterministic route tests live directly in `review-ui/test/`, no subdirectories as of this writing)
- **`review-ui/`** e2e: `npm run test:e2e` (runs `node --test test/e2e/*.e2e.mjs`) — this spins up Playwright + a real server; give it a long timeout (background it) and capture full output to a file rather than piping through `tail`, or you'll lose the summary line (`ℹ tests N / pass N / fail N`) that a truncated tail cuts off.

Don't just check the process exit code as pass/fail — a piped command's exit code reflects the last pipe stage, not necessarily the test runner. Grep the actual summary lines (`^ℹ (tests|pass|fail)`) from real output.

## Known pre-existing failures — don't re-investigate these from scratch

- Root suite: `test/combat-planning/snowball-delta.test.mjs` fails independent of any of this project's recent phases. Confirm the count (currently 60/61) rather than assuming a single failure is *this* one — but if it's the only failure and it's this file, it's the known one.

If a new failure shows up that isn't this file, treat it as real and investigate — don't assume every failure is "the known one."

## `foundry_worldFabric` must stay untouched

GM_Tools work should never modify the sibling `foundry_worldFabric` repo. Before and after any dispatched work, diff:

```bash
cd /opt/dev/foundry_worldFabric && git status --short
```

The current baseline (as of this writing) is: `package.json` and `scripts/apps/cockpit-app.mjs` modified, `setup-test.mjs` and `test/e2e-m13a.mjs` untracked — all pre-existing, unrelated to GM_Tools work. If the diff grows beyond this baseline, something touched the wrong repo — stop and investigate before proceeding.

## When verifying a dispatched agent's completion report

1. `git log --oneline` / `git show --stat <claimed commit>` — confirm the commit actually exists with the claimed file list, don't take "committed as X" on faith.
2. `git status --short` — confirm nothing is left uncommitted or staged outside what was claimed.
3. Re-run the actual test suites yourself (above) and compare exact counts to the report's claimed counts — don't just check "tests passed" as a boolean.
4. For any specific technical claim the report makes about *why* a failure is safe/expected (e.g. "this is a pre-existing fixture conflict, not a real bug"), read the actual test source and error output yourself before accepting it — this project has a track record of that exact kind of claim needing to actually check out, not just sound plausible.
5. Check `foundry_worldFabric` per above.
