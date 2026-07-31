# GM_Tools — Phase 19 Task Plan: Encounter Builder UI

**Status:** ready to execute. **Prerequisite reading, in order:** `CLAUDE.md` → `PLAN.md` → `plans/phase-18-review.md` + `plans/phase-18-tasks.md` (the engine/API this UI consumes) → `plans/phase-19-review.md` in full (this phase's design record — read before this file, this file assumes it) → this file → `.claude/skills/gm-tools-conventions/SKILL.md`.

**Scope:** frontend only. No new server routes — Phase 18 already shipped everything this UI consumes (`POST /api/combat-planning/bestiary/ingest`, `GET /api/combat-planning/bestiary`, `POST /api/combat-planning/bestiary/:id/accept`, `POST /api/combat-planning/bestiary/:id/discard`, `POST /api/combat-planning/party-roster/ingest`, `GET /api/combat-planning/party-roster?world=...`, `POST /api/combat-planning/encounter-suggest`). All new work is in `review-ui/public/`.

**Process, same as Phase 16/17/18:** tests before implementation. Task 19.0 writes Playwright e2e tests against DOM selectors that don't exist yet — same discipline as Phase 17.0, but note this is genuinely new UI with no prior-bug history to regress-test against. Required coverage instead targets the design record's own stated hard requirements (the round-3 DM refinements and the explicitly-resolved tensions in `plans/phase-19-review.md`) — these are correctness properties the design is built around, not incidental details, and deserve the same proactive-test treatment this project gives a previously-found bug.

---

## Grounding — what already exists, confirmed live

- **`combat-planning/*.mjs`** exact current exports (re-verify fresh, this may have drifted): `suggestEncounter({ targetDifficulty, candidatePool, party, knobs = {} })` (`encounter-heuristic.mjs`), `computeSnowballDelta(partyMembers, computeEncounterScore)` (two-candidate output), `computeBurstCeiling(components)`, `computeActionEconomyScore(rawFields)`, `scoreEffect`/`EFFECT_TAXONOMY`/`aggregateAxisScores` (`effect-impact.mjs`), `proposeBestiaryEntryFromText/FromPdf` + `BestiaryExtractionValidationError` + `RawBestiaryFields` (`bestiary-ingest.mjs`), `saveBestiaryEntry`/`listBestiaryEntries`/`acceptBestiaryEntry`/`discardBestiaryEntry`/`checkBestiaryOutliers` (`bestiary-store.mjs`), `proposePartyMemberFromText/FromPdf` (`party-roster-ingest.mjs`), `savePartyMember(world, {...})`/`listPartyMembers(world)` (`party-roster-store.mjs`), `proposeThematicTags(sceneContext, candidatePool, opts)` (`thematic-filter.mjs`).
- **`review-ui/server.mjs`**'s existing `/api/combat-planning/*` routes (grep the file fresh — around line 1390+ as of this writing) — bestiary routes are library-wide (no `world` param), party-roster and encounter-suggest routes take `world`.
- **`review-ui/public/session-planner-view.js`** — the freshest precedent in this codebase for a new, standalone view module (own file, talks to `app.js` only through the established nav/render-dispatch convention, no framework). Follow this file's shape for the new `combat-planning-view.js`, not `graph-view.js`'s older conventions.
- **`review-ui/public/debounced-save.mjs`** — reusable if any part of this UI needs debounced input (unlikely here, but check before writing a new debounce helper from scratch).
- **`review-ui/public/app.js`** — hash-router (`parseHash`/`navigate`/`renderCurrentView`), `withWorld`/`api` helpers, the `activeScanController`/`cancelActiveScan` pattern (for the two LLM-call sites this phase has — ingestion, the theme box — matching how Phase 16/17 handled request cancellation on navigation).
- **`review-ui/public/graph-view.js`**'s `withSlowNotice` — the "still working" pattern for the ~1.5s+ latency the ingestion screen and theme box (the only two LLM call sites in this phase, per design record §2) need; nothing else in this UI should ever show a loading state.
- **List/Graph toggle and `localStorage`-persisted view state** (both referenced in the design record as precedents for the Plain/Precise toggle and Adjust/Why-panel open-state) — re-locate the actual current implementation before copying the pattern.
- Re-verify all of the above fresh — this grounding may have drifted by the time each task starts.

---

## Task list

### 19.0 — QE e2e test-authoring pass (runs first, standalone)
**Files:** new `review-ui/test/e2e/combat-planning-*.e2e.mjs`, possibly a `test/combat-planning/*-format.test.mjs` for any pure-JS formatting/scoring-display helper extracted as DOM-free logic

Define and test the design record's own hard requirements, each as a real Playwright scenario driving an actual running server against real fixture data (seed bestiary/party-roster entries via the real ingestion API in test setup, not hand-built fixture JSON):

1. **Live recompute, no stale caching** — toggle a roster attendance chip, add/remove a catalog monster, and open the Adjust panel and change a knob; assert the score band's rendered value changes each time and never reflects a prior state after any of the three mutation types.
2. **Individual-vs-group add fork** — click `+Add` on the same catalog row twice: assert two individually-tracked combatant rows exist (not one row with count 2). Then click the `+/−` stepper on an already-present group: assert the count increments in place, no new row created. Both code paths in one test file, since they're the two halves of one requirement.
3. **Confidence-encoded score format, three states in the same layout slot** — a full-profile entry renders a solid decimal; a crude-fallback entry renders a dashed/banded range WITH a one-line "why fuzzy" note directly attached (not a separate tooltip requiring hover-to-discover); an unscoreable entry renders the "Unscored — reference only" pill in the identical DOM position/size as the other two states (assert via bounding-box comparison, matching this project's established real-measurement convention from Phase 15's touch-target work, not just presence).
4. **Catalog score chips are intrinsic, never party-relative** — assert the catalog's per-row score chip renders identically regardless of which roster attendance chips are checked (toggle attendance, confirm the catalog score doesn't change) — this is the direct test of design record §1's explicitly-resolved West-Marches-DM tension.
5. **Ingestion inline low-confidence field flagging** — seed an extraction result with at least one low-confidence field (however `checkBestiaryOutliers`/the extraction validation surfaces this — check the real shape before writing the test) and assert the review screen flags that SPECIFIC field inline, not a single page-level "review this" banner.
6. **Plain-mode default and permanent fixtures** — a fresh browser session (no `localStorage` state) lands on Plain mode by default; assert the snowball-delta callout and burst-ceiling indicator are present regardless of Plain/Precise mode (toggle both ways, confirm both remain visible in some form).
7. **Attendance-staleness line suppressed at full attendance** — assert the "as of tonight's roster..." line is absent when every chip is checked, and present with the correct names/count when at least one is unchecked.
8. **HP-staleness visual threshold** — assert the sync-timestamp indicator's styling changes (not just its text) once staleness crosses whatever threshold gets implemented — confirm via a real class/style assertion, not just checking the timestamp text exists.
9. **Adjust-panel trigger has no provisional-sounding copy** — a lighter check: a source-text scan of the rendered disclosure trigger asserting it does NOT contain phrasing implying more/better options exist (e.g. no "N more options," "try adjusting," etc.) — this is a copy-discipline requirement, test it as a simple string-absence check against the rendered DOM text.
10. **The two LLM call sites, and only those two, show any loading affordance** — assert `withSlowNotice`-style "still working" UI appears for the ingestion submit and the theme-box submit, and does NOT appear anywhere else in this view (difficulty click, catalog add/remove, knob changes, attendance toggle) — direct test of design record §2's latency-treatment scope.

**Acceptance criteria:** every new test file fails against the current (nonexistent) UI with clear selector-not-found/timeout errors; full existing suite (root, `wf-mcp-server`, `review-ui` deterministic + all existing e2e) still passes.

---

### 19.1 — Nav entry + ingestion review screens
**Files:** `review-ui/public/index.html`, `app.js`, new `review-ui/public/combat-planning-view.js`, `style.css`

- New `data-nav="combat-planning"` (or similar) topnav entry, following the exact existing pattern.
- Bestiary ingestion: paste-text or upload-PDF input → `POST /api/combat-planning/bestiary/ingest` → review screen showing extracted raw fields with inline per-field low-confidence flagging → accept (`POST .../accept`) or discard (`POST .../discard`).
- Party roster ingestion: same shape against the party-roster routes, `world`-scoped.
- Use `withSlowNotice` for both submit actions (the two LLM call sites in this phase).

**Acceptance criteria:** 19.0's ingestion-related tests pass.

---

### 19.2 — Roster/attendance strip + difficulty rail + suggestion wiring
**Files:** `combat-planning-view.js`

- Difficulty rail (Easy/Medium/Hard/Deadly large targets + click-to-edit numeric chip) as the screen's primary entry point.
- Roster strip: one checkbox chip per `listPartyMembers(world)` entry, checked by default, `localStorage`-persisted per world (matching `graph-view.js`'s cached-state convention).
- Clicking a difficulty tier calls `POST /api/combat-planning/encounter-suggest` with the currently-checked party and renders the suggested combination(s) — no separate confirm/generate step.
- This task establishes the live-recompute foundation (19.0 test 1's roster/attendance half) — catalog-driven recompute lands in 19.5.

**Acceptance criteria:** 19.0's live-recompute (attendance half), Plain-default, and attendance-staleness tests pass.

---

### 19.3 — Score band
**Files:** `combat-planning-view.js`, `style.css`

- Plain/Precise toggle (styled like the List/Graph toggle, `localStorage`-persisted), default Plain.
- Dominant expected-score bar/label; snowball-delta two-pill row (permanent, both modes); burst-ceiling corner badge (permanent presence when relevant, per design record's "absent, not just subtle, when never touched by tooling" requirement); attendance-staleness line; per-chip HP-staleness indicator with the gray→amber threshold shift.

**Acceptance criteria:** 19.0's permanent-fixtures, HP-staleness-threshold, and attendance-staleness tests pass.

---

### 19.4 — Two disclosures
**Files:** `combat-planning-view.js`

- `Adjust ▸`: all knobs (`minionRules`, `legendaryActions`, scaling, pack coefficient, player-tactics slider), closed by default, trigger copy carrying no provisional-sounding language (19.0 test 9).
- `Why this score? ▸`: read-only per-combatant contribution breakdown, closed by default, no editable controls anywhere inside it.
- Both are independent open/closed states — opening one must not open or affect the other.

**Acceptance criteria:** 19.0's disclosure-copy test passes; manual check confirms the two panels are genuinely independent.

---

### 19.5 — Catalog
**Files:** `combat-planning-view.js`, `style.css`

- Facets: creature type, CR-band, environment/region tag, System selector (reveals/hides system-specific facets rather than one shared schema — per design record §1).
- Six-axis "impact fingerprint" glyph per row, usable as a filter/sort dimension.
- Confidence-encoded score display per row (solid decimal / dashed banded range with attached "why fuzzy" note / "Unscored — reference only" pill — all three in the identical layout slot, per 19.0 test 3) — this chip is intrinsic (per-monster only), never computed against the current roster (19.0 test 4).
- Click-based `+Add`: repeated clicks on the same row create individually-tracked combatants; an existing group gets a `+/−` stepper instead (19.0 test 2).
- Optional theme text box wired to `proposeThematicTags`, narrowing `candidatePool` before `suggestEncounter` — left blank, never called (`withSlowNotice` only fires if used).
- Every catalog add/remove triggers the same live-recompute path established in 19.2 (19.0 test 1's catalog half).

**Acceptance criteria:** 19.0's add-fork, confidence-format, intrinsic-score, and remaining live-recompute tests pass; the loading-affordance-scope test (19.0 test 10) passes now that both LLM call sites in this phase exist.

---

### 19.6 — Resync-from-Foundry
**Files:** `combat-planning-view.js`

- A button on the roster strip re-reading current actor HP via the existing snapshot/file-bridge mechanism (the same one every other Foundry-touching feature in this stack already uses — re-locate and reuse it, don't build a new one) into the working session's `combatRelevant.hp`, not the persisted `PartyMember` record.
- Updates the per-chip staleness timestamp/color state established in 19.3.

**Acceptance criteria:** manual verification against a real (or realistically faked) Foundry snapshot that HP updates in the working session without mutating the persisted roster entry.

---

## How to work

- Task 19.0 must fully complete, commit, and be confirmed red before 19.1 starts.
- Ground every implementation task in the actual current code — re-locate exact lines/selectors/route shapes fresh.
- Commit after each completed task, clean incremental history. Stage files explicitly, never `git add -A`.
- No `foundry_worldFabric` changes anywhere in this phase except whatever 19.6's HP-resync read path already relies on (read-only, via the existing established mechanism — confirm no new write path is introduced). Verify `git -C /home/russell/foundry_worldFabric status --short` is unchanged before and after regardless.
- Self-review remediation pass at the end of 19.6: run the FULL suite (root, `wf-mcp-server`, `review-ui` deterministic + all e2e including the new ones), re-confirm the intrinsic-vs-party-relative score distinction holds, re-confirm the two-LLM-call-sites-only loading-affordance scope, and take real desktop + mobile-viewport screenshots (matching this project's established verification bar since Phase 15) of the ingestion screen, the difficulty-rail/suggestion view, and the catalog with all three confidence states visible.

## Definition of done for Phase 19

- [ ] 19.0's Playwright tests committed, confirmed red before any implementation exists.
- [ ] Nav entry + ingestion review screens (19.1), inline low-confidence flagging confirmed.
- [ ] Difficulty rail + attendance strip + suggestion wiring (19.2), Plain-default and staleness-line behavior confirmed.
- [ ] Score band (19.3): permanent snowball-delta/burst-ceiling fixtures, HP-staleness color threshold.
- [ ] Two independent disclosures (19.4), no provisional-sounding Adjust-panel copy.
- [ ] Catalog (19.5): facets, impact fingerprint, confidence-encoded format in one consistent slot, click-based add fork, optional theme box.
- [ ] Resync-from-Foundry (19.6), confirmed session-scoped not persisted-record-mutating.
- [ ] Full existing test suite (root + `wf-mcp-server` + `review-ui` deterministic + all e2e) still passes.
- [ ] `foundry_worldFabric` confirmed untouched (or read-only as designed) throughout.
- [ ] Self-review remediation pass run and reported, including real screenshots.
