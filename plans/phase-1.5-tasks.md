# GM_Tools — Phase 1.5 Task Plan: World Fabric Containment/Presence Split

**Status:** ready to execute. **Prerequisite reading:** `GM_Tools/CLAUDE.md` → `GM_Tools/PLAN.md` → this file → `GM_Tools/.claude/skills/gm-tools-conventions/SKILL.md`. This phase also touches `/home/russell/foundry_worldFabric/` (a separate project) — read its own `CLAUDE.md`/`PLAN.md` if present, and follow its existing conventions (migration pattern in `module.mjs`, test style) rather than GM_Tools' conventions for that half of the work.

**Why this phase exists, out of numeric order:** a design review found that World Fabric's `location` relationship type conflates two genuinely different kinds of fact — structural/compositional (a building is part of a district; shouldn't erode over time) and temporal/presence (where an actor has recently been; should decay). GM_Tools' own `ambientDecay` mechanism (built in Phase 1) will misbehave against the current schema — given a long enough campaign, it will eventually produce a spurious "this building stopped being in its district" mutation, because decay is monotonic regardless of how long the configured half-life is. This must be fixed before Phase 2's `contained-in` scope mode is built on top of it, and before more real campaign data accumulates under the conflated schema. Full reasoning is in the systems-architecture review this phase implements — ask for it if you need the "why," this file is the "what."

**Scope discipline:** this phase is the schema/decay-correctness fix only. It does **not** include building the actual containment-traversal query or wiring a `contained-in` scope mode into `time-skip/scope.mjs` — that's Phase 2 work, deliberately sequenced after this phase and after a fresh review of Phase 2's plan.

---

## Task list

### 1.5.1 — Add `containment` relationship type to World Fabric
**File:** `/home/russell/foundry_worldFabric/scripts/constants.mjs`

- Add `containment` to `RELATIONSHIP_TYPES` (currently a `{ location: "location", ... }`-shaped map at ~line 43) — follow the exact existing pattern for the new entry.
- Check for a parallel strength/weight-default map (there's one near line 64, e.g. `location: "tight"`) — add a matching default for `containment` (structural facts should default to a strong, stable tie — `"tight"` or equivalent, matching `location`'s current default for these same derive-edge cases).
- Retarget two `deriveEdge` declarations from `relationshipType: "location"` to `relationshipType: "containment"`:
  - `place.region` (~line 135) — a place's parent region is structural containment.
  - `faction.headquarters` (~line 158) — a faction's HQ is structural containment.
- **Do not** change `person.homeLocation`'s (~line 98) or `event.location`'s (~line 204) `deriveEdge` — verify what each actually represents before touching it. Per the design review: `event.location` is a fixed historical fact (leave as `location`, out of scope). `person.homeLocation`'s correct final type is `presence` per task 1.5.2 below — but confirm this against how it's actually used (is it durable-but-changeable like presence, or more like a fixed structural fact?) before moving it; if the code doesn't clearly support the review's assumption, flag it rather than forcing the change.

**Acceptance criteria:** confirm (via existing test infra or a quick manual check) that after this change, loading/deriving a place with a `region` attribute and a faction with a `headquarters` attribute now produces `containment`-typed edges, not `location`-typed ones. Since derived edges are recomputed on every load (per `interchange.mjs`'s `applyDerivation`, which discards and rebuilds the derived set), this should require no explicit migration for the derived cases — verify that's actually true rather than assuming it.

---

### 1.5.2 — Rename the presence-tracking use of `location` to `presence`
**Files:** `/home/russell/foundry_worldFabric/scripts/constants.mjs`, `/home/russell/foundry_worldFabric/scripts/data/world-scan.mjs`

- Add `presence` to `RELATIONSHIP_TYPES` (same pattern as 1.5.1) with a default strength matching `location`'s current default for these edges (check `world-scan.mjs`'s `reconcileLocationDecay`/`sceneTokenEdges` for the actual current default).
- `world-scan.mjs`'s token-placement edges (`sceneTokenEdges`, and wherever `scan:loc:*`-prefixed edge ids or `reconcileLocationDecay` set `relationshipType: "location"`) should now use `relationshipType: "presence"`. This is the "an actor was recently at this place, weakening over time" behavior — keep the accumulate-and-decay logic itself exactly as-is (it's correct for presence), only the type label changes.
- If `person.homeLocation` (from 1.5.1) is confirmed to be presence-like rather than structural, retarget its `deriveEdge` to `presence` here instead of leaving it on `location`.

**Migration for existing persisted data:** literal, already-stored `location`-typed edges created by `world-scan.mjs` (not the derived ones — those regenerate automatically) need an actual one-time relabel. Follow the exact precedent in `/home/russell/foundry_worldFabric/scripts/module.mjs`'s `_runMigration` function (~line 187), which already did an equivalent reclassification (M12: `temporal` → `unspecified`, ~line 190-196). Add a new migration step in the same function: any persisted edge with `relationshipType === "location"` **and** an id/source pattern matching world-scan's presence edges (check the actual id/source convention `world-scan.mjs` uses — e.g. `scan:loc:*` or a `source` field value) gets relabeled to `"presence"`. Do not touch `location`-typed edges that don't match that pattern (those are the legitimate remaining `event.location` uses, or manually-authored edges — leave them alone unless you can confirm otherwise). Bump whatever migration-version marker this module already tracks, matching the existing pattern exactly.

**Acceptance criteria:** run World Fabric's own test suite (check its `package.json`/`CLAUDE.md` for the right command — likely `test/m1.test.mjs`-style unit tests plus the `test/e2e-m*.mjs` Playwright suites) and confirm nothing regresses, especially `test/e2e-m7.mjs`'s move/decay/re-scan assertions (these should now assert on `presence`-typed edges, update the test's expectations if it hardcodes `"location"`). Confirm the migration is idempotent (running it twice doesn't double-relabel or error).

---

### 1.5.3 — Exclude `containment` from ambient decay (GM_Tools side)
**File:** `/home/russell/GM_Tools/mutation-engine/propagate.mjs`

- `ambientDecay(edges, elapsedSessions)` currently applies `Math.pow(0.5, elapsed/halfLife)` decay to every edge unconditionally, keyed by `relationshipType`. Add a hard exclusion: skip any edge with `relationshipType === "containment"` entirely — no decay delta computed, no candidate produced for it, regardless of elapsed time or configured half-life. **Do this as an explicit skip, not a very-large half-life constant** — a half-life is still monotonic decay and will eventually misfire on a long enough campaign; an explicit exclusion is a one-line fix that also documents intent for the next reader.
- Update `EDGE_TYPE_WEIGHT` and `DECAY_HALF_LIFE_SESSIONS` in the same file (and wherever else these are duplicated, e.g. `PLAN.md`'s example config, `plans/phase-1-tasks.md`'s task 1.3 reference values) to rename the `location` key to `presence`, and add a `containment` key (its `DECAY_HALF_LIFE_SESSIONS` entry is moot given the hard exclusion, but keep `EDGE_TYPE_WEIGHT`'s `containment` entry — it's still relevant for seeded propagation, which is a different code path from ambient decay and should NOT be excluded the same way: a seeded event rippling through a `containment` edge is legitimate, e.g. "the district burned" should still propagate to buildings within it).

**Acceptance criteria:** add/update unit tests in `test/propagate.test.mjs`: (a) `ambientDecay` produces zero candidates for `containment`-typed edges regardless of elapsed time (test with a very large elapsed-sessions value to prove it's a hard exclusion, not just a slow decay); (b) `presence`-typed edges (renamed from `location`) still decay exactly as `location`-typed edges did before this change — this is a rename, not a behavior change, verify by comparing against the pre-existing `location` test cases; (c) `propagateSeed` (seeded propagation, not ambient decay) still traverses `containment`-typed edges normally, confirming the exclusion is scoped to ambient decay only. Run the full suite (`npm test` from `/home/russell/GM_Tools`) after.

---

### 1.5.4 — Update project docs to reflect the split
**Files:** `GM_Tools/PLAN.md`, `mutation-engine/README.md`, and whatever World Fabric doc tracks its own sprint/change history (check for a `CLAUDE.md`/`PLAN.md` there; if one exists, add an entry there too following its existing convention rather than inventing a new format)

- `PLAN.md`'s example pipeline config (`edgeWeights`) should reflect the renamed/added types.
- `mutation-engine/README.md` should note the hard `containment` exclusion in `ambientDecay` and why (link back to this task file, don't re-explain the full reasoning inline).
- If World Fabric has its own tracked sprint/change history, add a short entry there for this change too — it's a real schema change to that project, not just an internal GM_Tools implementation detail, and a future session working on World Fabric directly should be able to find out why `containment`/`presence` exist without having to reconstruct this reasoning from GM_Tools' side.

---

## Definition of done for Phase 1.5

- [ ] `containment` and `presence` exist as real relationship types in World Fabric, with `place.region`/`faction.headquarters` deriving `containment` edges and world-scan's token-placement edges using `presence`.
- [ ] Existing persisted `location` edges representing presence are migrated to `presence`; edges that should remain `location` (event.location, and anything not matching the presence pattern) are untouched. Migration is idempotent.
- [ ] World Fabric's own test suite passes, including `test/e2e-m7.mjs`'s move/decay assertions (updated to expect `presence` where they previously expected `location`, if needed).
- [ ] GM_Tools' `ambientDecay` hard-excludes `containment` edges (verified with a large-elapsed-time test proving it's not just a slow decay), while `propagateSeed` still traverses `containment` normally.
- [ ] `presence`-typed edges decay in `ambientDecay` exactly as `location`-typed edges did before — behavior preserved under the rename.
- [ ] GM_Tools' full test suite (`npm test`) passes.
- [ ] Docs updated on both sides per task 1.5.4.
- [ ] Explicitly **not** done as part of this phase, confirmed not started: any `contained-in` scope mode, traversal helper, or changes to `time-skip/` — that's Phase 2, deliberately out of scope here.

---

## Phase 1.5b addendum — `person.homeLocation` resolved

Task 1.5.1/1.5.2 above flagged `person.homeLocation` rather than moving it, since the review's `presence` assumption wasn't supported by the code. Russell's call: `homeLocation` means origin/hometown — a fixed biographical fact, never decaying, but **not** structural containment either (a person isn't compositionally "part of" their hometown the way a place is part of a region — reusing `containment` would repeat the same modeling mistake this phase fixed, at smaller scale). Given its own type: `origin`.

- World Fabric: `origin` added to `RELATIONSHIP_TYPES`/`DEFAULT_STRENGTH_BY_TYPE`; `person.homeLocation`'s `deriveEdge` retargeted to it.
- **Migration was needed, contrary to task 1.5.1's "should require no explicit migration" acceptance-criteria text** — confirmed by inspection, not assumption. `CORE_ENTITY_TYPES` only seeds the `entityTypes` game.settings default on a brand-new world; once a world persists entityTypes (effectively every real world), `module.mjs`'s "merge new attributeDefs" step is additive-only and never overwrites an already-present attributeDef's `deriveEdge` — so the code-level type change alone would never reach an existing world. Verified directly against this project's own live `wf-test` world: its persisted entityTypes still had `place.region`/`faction.headquarters` frozen at `"location"` despite `constants.mjs` reading `"containment"` since this phase's original commit — the same latent gap, left unfixed there (out of scope) but proving the pattern. Added an idempotent `_runMigration` step that relabels `person.homeLocation`'s stored `deriveEdge.relationshipType` from `"location"` to `"origin"`; once that flips, the existing `dirty → graph._runDerivation()` path discards and rebuilds all derived edges, so no separate edge-level migration was needed on top of it.
- GM_Tools: `ambientDecay`'s hard exclusion refactored from a single `!== "containment"` check to a `NON_DECAYING_RELATIONSHIP_TYPES` set covering both `containment` and `origin`. `origin` added to `EDGE_TYPE_WEIGHT` (same weight as `containment`, `0.6`) since `propagateSeed` should still traverse it (e.g. news of a hometown's fall reaching someone who's from there). `origin` deliberately **not** added to `DECAY_HALF_LIFE_SESSIONS` — hard-excluded, a half-life value would be dead config.
- `event.location` was explicitly out of scope for 1.5b too, same as it was for 1.5 — left untouched.
