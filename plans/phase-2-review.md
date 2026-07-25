# Phase 2 Task Plan — Re-Review (post-Phase-1/1.5/1.5b)

**Why this document exists:** before executing Phase 2, Russell asked for a technical review pass — the original task plan predated Phase 1's actual implementation and the Phase 1.5/1.5b/1.5c schema work, and he'd already flagged it as likely bloated. Two reviews ran: a re-review of the task plan itself, and a systems-architecture pass resolving an open design question (`contained-in` scope semantics) the plan depended on. Both found real issues — this is the record of what they found and why `plans/phase-2-tasks.md` now reads the way it does. Decision made: apply the restructured plan with `contained-in` folded in as resolved, rather than deferred further.

---

**Verdict, upfront: needed restructuring before execution — not a rubber stamp, and not primarily for the reasons the retrospective flagged.** The retrospective's two named additions (LLM seed inference, `contained-in` scope) were real, but re-reading `plans/phase-2-tasks.md` against what actually shipped surfaced a bigger issue: **Phase 1's `wf_propose_mutations` already built a substantial chunk of what task 2.1/2.2 assumed still needed building.** That was the headline finding, not the two known additions.

This review was grounded in the live repo: `wf-mcp-server/index.mjs`'s actual `wf_propose_mutations` handler (lines ~358–463), the full git log (16 commits, including 3 remediation commits), `plans/phase-1.5-tasks.md`'s own documented retrospective, `mutation-engine/README.md`, and a live test run (85 assertions passing, up from the 63 cited at Phase 1's original close — growth from Phase 1.5/1.5b's added coverage, all green).

---

## The finding that reshaped the plan: architecture duplication risk

The original `plans/phase-2-tasks.md` specced `time-skip/scope.mjs`'s `resolveScope()` with modes `whole-graph | region | tag`, and `time-skip/run.mjs` as a from-scratch orchestrator: resolve scope → `propagate.mjs` → group → `texture.mjs` → `review-state.mjs`. That's a reasonable design *in isolation* — but it was written before Phase 1 existed, against an assumed architecture.

What actually shipped in Phase 1 task 1.8 (`wf_propose_mutations`) is not just a thin conversational wrapper around a separate orchestrator — it **is** the orchestrator, built directly into the MCP tool handler:

- `scope.mode === 'ambient'` already runs `candidateDeltas()` with `elapsedSessions` across **every edge in the snapshot** — i.e., whole-graph time-skip already works today.
- `scope.mode === 'tag'` already filters candidates (seed- or ambient-derived) to entities/edges touching a tagged entity.
- `scope.mode === 'seed'` already supports **multiple simultaneous seeds**, merging results and keeping the strongest impact reaching each entity — this already covers a meaningful slice of what "seeded propagation within a time-skip batch" was meant to add.
- Texturing is already region-batched in a single `textureBatch()` call, not one-per-node (confirmed by `texture.test.mjs`'s own acceptance test: *"textureBatch: one API call per region, not per node (cost-control acceptance criterion)"*).
- The result is already written straight to a review batch via `createBatch()`.

So the original task 2.1 (`resolveScope` with `whole-graph|region|tag`) and roughly two-thirds of the original task 2.2 (`time-skip/run.mjs`'s orchestration: resolve → propagate → group → texture → persist) **already existed, live, tested, and in daily-usable form** — just not as a separate `time-skip/` module; as an MCP tool handler. Building 2.1/2.2 as originally speced would either (a) reimplement this logic a second time in a new location, directly violating `gm-tools-conventions`'s own stated rule ("front-ends are thin wrappers, never logic duplicators — if you find yourself writing the same logic twice for two different front-ends, stop"), or (b) get built and then silently never get used because `wf_propose_mutations` already does the job. Either outcome is a real defect in executing the file as it was originally written, not a hypothetical risk.

---

## Restructuring rationale, task by task

**2.0 (new, do first)** — extract the existing orchestration into a reusable `time-skip/` library, refactor-only. Skipping this means every later task builds on quicksand (two implementations of the same logic, drifting apart over time).

**2.1 (revised)** — add `region` (genuinely missing) and, per the resolved semantic question below, `contained-in`.

**2.2 (revised, narrower)** — resumability only; the one piece of the original 2.2 genuinely not built yet, and now more valuable than originally scoped since `ambient` mode already covers the whole graph today, meaning a real time-skip over a mature campaign could involve dozens of region-batched texture calls with no crash-safety.

**2.2b (new, kept separate)** — LLM-inferred seed resolution. Deliberately not a case inside `resolveScope()`: that function is pure/deterministic and cheap to verify (85 assertions, no mocking needed for the graph-math half) specifically *because* it's deterministic. Seed inference is a fundamentally different kind of work needing the `texture.mjs`-style test pattern (mocked-API unit test + manual smoke test), not `propagate.mjs`'s.

**2.3/2.4** — unchanged in substance; confirmed genuinely not started, no drift to correct.

---

## The `contained-in` semantic question — resolved

A parallel systems-architecture review answered the question the original task 2.1 left open: does `contained-in` mean `containment`-typed edges only, or `containment` + `origin` (e.g. "everyone *from* this region," regardless of current location)?

**Answer: `containment` only.** These are genuinely different query intents, not two names for one thing. `containment` answers "what currently structurally constitutes this place" (`place.region`, `faction.headquarters`). `origin` answers "who is biographically from this place, regardless of where they are now" (`person.homeLocation` — added in Phase 1.5b specifically to be excluded from decay as a permanent-but-not-structural fact). Folding `origin` into `contained-in` would mean an NPC born in a city forty years ago who's lived elsewhere the entire campaign gets swept into "everything currently inside this city" for a time-skip decay pass — wrong on its face for a spatial-containment operation, and the exact category error (conflating two kinds of fact under one traversal) that the `containment`/`presence`/`origin` split was fixing at the schema level. Doing it again one layer up in `scope.mjs` would undo that work.

Implementation notes from the same review: don't assume `containment` guarantees a strict single-parent tree — nothing in `graph-service.mjs` enforces that for *any* relationship type, so `contained-in` should do plain reachability BFS (same shape as `neighborhood()`, which already handles a DAG/cycle safely), not try to reconstruct/validate a tree. Depth should default to unbounded (or a very high cap), not the shallow depth `region` uses — a district→building→room chain is exactly the multi-hop case this mode exists for.

**`region` mode was also re-examined and found not to need changing.** Its generic all-types BFS is answering a different question than `contained-in` — "what's narratively/relationally near this anchor" — and mirrors `closeness.mjs`'s established precedent of undirected, type-agnostic proximity traversal. The original review's complaint about a `location`-only BFS wasn't "all-types BFS is bad," it was "a single overloaded type can't do double duty as both a proximity signal and a composition tree." That problem is solved at the type level now; `region` never needed to be a containment tree, so it doesn't inherit the old bug.

**Net verdict on the scope-mode set (`whole-graph`/`region`/`tag`/`contained-in`):** coherent, no restructuring needed beyond adding `contained-in`. Each mode answers a distinct GM intent — keep all four separate rather than collapsing or parameterizing one into covering the others.

---

## LOE — why the original estimate didn't hold

Two things the original estimate (~1–1.5 weeks) genuinely couldn't have accounted for: real architecture drift (2.0's extraction need, invisible until Phase 1 actually shipped and revealed where the orchestration logic landed), and a now-*demonstrated*, not merely hypothesized, execution pattern. Phase 1's real path was: one autonomous session built all 8 tasks cleanly → a code-review pass found two real issues (a passthrough-schema smell, `diff.mjs` built but never wired into the live path) → fixed in a follow-up session → then an *unplanned* three-round schema-correctness fix (1.5/1.5b/1.5c), the last round of which was caught only by live-verifying against the actual `wf-test` Foundry world, not by any automated test, because World Fabric's additive-only migration convention meant an earlier fix's "no migration needed" acceptance criterion was simply wrong on already-persisted data.

That's not one clean build. It's one build plus at least one review-driven remediation round, and — for this project specifically, where "does this correctly handle already-existing persisted state" is a recurring blind spot in automated tests — a real chance of a second remediation round triggered by something tests can't catch.

**Revised guidance:** budget one full remediation pass as a planned step, not a contingency. Schedule Phase 2 as "build, then review, then fix" as three separate steps from the start, the same shape Phase 1 actually took whether or not it was planned that way.

---

## Standing risks, not just for this phase

1. **Already-persisted-state blind spot.** Baked directly into 2.2 and 2.3's acceptance criteria this round (crash-and-resume against real written state, not in-process simulation; merge-into-existing-data tests, not just merge-into-empty). Worth treating as a standing checklist item for anything that touches persisted state going forward, not just these two tasks.
2. **World Fabric's additive-only migration convention.** Any future change to what an already-persisted field *means* (not just adding a new field) needs an explicit, live-verified migration step — never assumed safe because tests pass, since that exact assumption is what produced Phase 1.5c. Nothing in the current Phase 2 restructure obviously triggers this, but the next person who changes what an existing schema key means should expect to write one.
3. **This plan isn't locked either.** Phase 1's real path (1 → 1.5 → 1.5b → 1.5c, each round finding the next real thing) is evidence this project surfaces genuine unknowns mid-execution, not evidence of planning failure. If 2.0's extraction or 2.2b's seed-inference work surfaces another real gap, that's healthy discovery to act on with the same checkpoint-gated model as before — not a reason to have "gotten the plan right the first time."
