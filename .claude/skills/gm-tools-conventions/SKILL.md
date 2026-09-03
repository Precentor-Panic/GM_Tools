---
name: gm-tools-conventions
description: Engineering conventions for GM_Tools — the mutation engine, propagation pass, review-state store, and MCP tool surface. Load before writing or modifying any code under mutation-engine/, time-skip/, graph-import/, wf-mcp-server/, or a future review-ui/. Covers test-writing pattern, schema-versioning discipline, the no-silent-auto-write invariant, concurrency-safety convention, and dependency choices already established in this codebase.
---

# GM_Tools Engineering Conventions

Read this before writing or modifying code anywhere in `GM_Tools/`. These are standing conventions established across the planning pass for this project — follow them rather than reinventing per-task.

## Module layout

- **Pure, Foundry-free library code** goes in `mutation-engine/`, `time-skip/`, `graph-import/` — plain importable Node modules with no dependency on an active MCP session, Claude Code, or a live Foundry client.
- **Front-ends are thin wrappers, never logic duplicators.** `wf-mcp-server/index.mjs`'s MCP tools, and any future `review-ui/` HTTP server, must call directly into the library modules above — they hold no independent business logic. If you find yourself writing the same diff/propagation/review-state logic twice for two different front-ends, stop — that's a sign the shared logic belongs in a library module you haven't extracted yet.
- Reuse existing primitives before writing new ones: `wf-mcp-server/lib/graph.mjs`'s `neighborhood()` for BFS traversal, `foundry_worldFabric/scripts/data/interchange.mjs`'s `importGraph`/`exportGraph` for merge semantics, `llm-context.mjs`'s decay-formula shape for anything recency/half-life-based. Check these before implementing a graph-traversal or decay function from scratch.

## Testing

- Mirror `foundry_worldFabric/test/m1.test.mjs`'s pattern: plain `node --test`-style unit tests, no Jest/Vitest, no test framework dependency.
- **Deterministic, non-LLM logic** (schema validation, diff computation, the propagation pass, review-state CRUD) must have unit tests before a task is considered done — this code has no excuse to be untested, since it's the easiest category of code in this project to verify.
- **LLM-dependent code** (the texturing pass, any future creative-generation call) gets: a unit test with the API call mocked, verifying orchestration/validation/retry logic; plus a documented manual or integration smoke test that makes a real (small, cheap) API call and confirms the output validates. Full automated coverage of LLM output quality is not expected or useful — don't try to assert on the exact text an LLM call produces.

## Schema versioning

Every new persisted format — the mutation schema, the review-state file format, any future WFI-adjacent format this project introduces — exports an explicit `SCHEMA_VERSION` (or equivalent) constant from the moment it's created, following the precedent `interchange.mjs`'s `WFI_VERSION` already set. Bump it and document the change in the module's own comments or a short README note on any breaking shape change. Don't let a format's shape drift silently across commits.

## The no-silent-auto-write invariant

No code path may write a proposed mutation to the World Fabric graph without it having passed through the review-state accept step (`review-state.mjs`'s status transition to `'accepted'`). This holds **even for**: low-importance entities that "obviously" don't need review, convenience shortcuts during development, test/dev tooling, or a task that seems to require bypassing it to move faster. If a task genuinely seems to require routing around this, **stop and flag it rather than implementing the bypass** — this invariant is the entire trust premise of the mutation engine; silently weakening it anywhere is a correctness bug, not a shortcut.

## Concurrency safety

Any code that writes `world-fabric-mutations.json` (the existing Foundry bridge file) or a `review-state/` batch file must check for an existing unflushed/in-progress marker before writing, not perform a blind overwrite. This matters once more than one tool surface can be active at once (e.g. a live-diff call and a sync action both writing near-simultaneously).

## Dependency and infrastructure choices already made — don't relitigate without flagging it first

- **Zod** for all schema validation. Don't introduce a second validation library.
- **`@anthropic-ai/sdk`** for outbound Claude API calls (first introduced for the texturing pass) — use it directly, don't wrap it in another abstraction layer without a specific reason.
- **Flat JSON files** for review-state and batch persistence. `node:sqlite` (built into Node 22+) is the pre-agreed upgrade path *if* query needs grow later — don't reach for it, or for any other database, before that need is concrete.
- **No job/queue runner.** A sequential loop + an incrementally-written status file is the established pattern for resumable batch work (time-skip orchestration) at this project's scale.
- **No frontend framework, no build step**, for anything UI-facing (should a web UI phase ever get picked up) — plain HTML/vanilla JS/`fetch()`.

If a task seems to call for deviating from any of the above (introducing a new dependency, a database, a build step, a queue system), that's a decision worth flagging explicitly in your report rather than making silently — these were deliberate choices made against this project's actual scale, not defaults left unexamined.

## Store-location convention — one deliberate exception

Sidecar stores default to a GM_Tools-side directory (`entity-narration/`,
`prep-content/`, `review-state/`, `truth-notes/`, …) with a
`GM_TOOLS_*_DIR` env override for test isolation. **The one deliberate
exception is `mutation-engine/narrative-state.mjs`**, whose default root is
the WORLD data dir (`<WF_DATA_DIR>/worlds/<world>/narrative-state/`): the
git world-timeline (`mutation-engine/world-timeline.mjs`) commits
`worlds/<world>/`, and a timeline branch must fork the graph AND what the
table knows in one atomic commit. Don't "fix" that store's location back to
the GM_Tools side, and don't move other stores into the world dir without
the same argument. Every new store still gets the env override, the
`.gitignore` entry (GM_Tools-side stores), and the no-leak-into-real-dirs
regression test.

## Where things live

- `PLAN.md` — architecture, the full tool list, current phase status.
- `plans/phase-N-tasks.md` — the current execution checklist (what an autonomous session should actually be working from).
- This skill — how to write code here, once you're executing a task from a phase plan.

## Stop-and-check gates

When a phase task file marks something as a "stop-and-check gate," treat it as **non-blocking by default**: finish the rest of the phase, flag the specific gated item clearly in your closing report, and move on — unless the gate's own text explicitly says it blocks further progress. Don't stall a whole phase on a judgment call that was deliberately deferred to Russell's review.
