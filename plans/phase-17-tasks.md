# GM_Tools — Phase 17 Task Plan: Session Planner UI

**Status:** ready to execute. **Prerequisite reading, in order:** `CLAUDE.md` → `PLAN.md` → `plans/phase-16-review.md` + `plans/phase-16-tasks.md` (the engine/API this phase builds on) → `plans/phase-17-review.md` (this phase's design record — read it before this file, this file assumes it) → this file → `.claude/skills/gm-tools-conventions/SKILL.md`.

**Scope:** frontend only. No new server routes — Phase 16 already shipped everything this UI needs to consume (`POST /api/session-planner/scenes`, `POST /api/session-planner/scenes/:id/fork`, `GET /api/session-planner/scenes/:id`, `GET /api/session-planner/brief`, `POST /api/session-planner/notes`, `POST /api/session-planner/notes/intake`). All new work is in `review-ui/public/`.

**Process, same as Phase 16:** tests before implementation. Task 17.0 is a QE pass that writes Playwright e2e tests against DOM structure (`data-testid` hooks, etc.) that doesn't exist yet — those hooks, defined in the test files' header comments, ARE the implementation contract, the same role Phase 16.0's test files played for module/function signatures. The tests are expected to fail (element-not-found) until 17.1+ land. Implement to make them green without loosening what they assert.

---

## Grounding — what already exists, confirmed live

- `review-ui/public/app.js`: hash-router (`parseHash`/`navigate`/`renderCurrentView`), each view is a render function doing a direct DOM rebuild of its container — no framework, no diffing. `withWorld(params)` appends the current world to API calls; `api(path, opts)` wraps `fetch`. The existing `window.addEventListener("hashchange", ...)` block already closes the mobile drawer and cancels an active scan (`cancelActiveScan()`) — this is the exact spot 17.3 and 17.5 hook into.
- `review-ui/public/graph-view.js`: `positionPopoverAt`/`clampPopoverIntoView` (positioning geometry only, not lifecycle management — do not assume leak-safety transfers for free), `withSlowNotice(statusEl, promise)` (the ~1.5s "still working" threshold this phase's debounce window must stay comfortably under), the `container._graphRubberBandWired`-style guard pattern for preventing duplicate listener registration across re-renders.
- `session-planner/brief.mjs`'s actual output shape — see `plans/phase-17-review.md` §2, copied from the real shipped code, not inferred.
- `review-ui/test/e2e/*.e2e.mjs`: the established Playwright convention — each spins up a real in-process server (`createReviewServer({port:0})`) against real fixture data, matching `test/routes.test.mjs`'s isolation pattern.
- Re-verify exact current line numbers/selectors fresh when implementing — this grounding may have drifted by the time each task starts.

---

## Task list

### 17.0 — QE e2e test-authoring pass (runs first, standalone)
**Files:** new `review-ui/test/e2e/session-planner-*.e2e.mjs`

Per `plans/phase-17-review.md` §11, exactly two behaviors earn a proactive test before first ship (both are direct siblings of bugs already found once in this project's history):

1. **`session-planner-flush-on-navigate.e2e.mjs`** — type into an inline-expanded note, trigger a hash navigation before the ~500ms debounce fires, assert the note's `POST /api/session-planner/notes` call still completes and the text is durably saved (verify via a subsequent fetch of the same scene/entity, not just "a network request was sent"). Sibling of Phase 15.3's mobile-drawer-close-on-hashchange fix.
2. **`session-planner-recenter-race.e2e.mjs`** — click the re-center control twice in fast succession; assert exactly one scene fork exists afterward and the rendered brief reflects the SECOND (later) click's target location, not a stale first-click response winning a race. Sibling of the already-fixed Phase 14.8 duplicate-batch-from-uncancelled-scan bug.

For each, define and document (in the test file's header comment) the exact `data-testid` (or equivalent stable selector) hooks the test needs — e.g., `[data-testid="session-planner-nav"]`, `[data-testid="location-note-toggle"]`, `[data-testid="recenter-input"]` — as the implementation contract for tasks 17.1–17.5. Be precise: name every selector you need, since these don't exist yet and 17.1+ will implement to match your file, not re-derive the design.

Also write **plain `node --test` unit tests** (not Playwright) for whatever pure, DOM-free helper function ends up implementing the debounce/flush-on-blur/flush-on-navigate logic (per `plans/phase-17-review.md` §6) — specify it as a small, isolated function (e.g., something shaped like `createFlushableDebounce(saveFn, { debounceMs })` returning `{ onInput, onBlur, flush }`) so its timing/flush-ordering logic is verifiable without a browser. Document the exact contract in a new `test/session-planner/debounced-save.test.mjs` header comment, mirroring Phase 16.0's convention.

**Acceptance criteria:** both e2e test files exist, fail against the current (nonexistent) UI with clear "selector not found" style errors; the debounce/flush unit test file exists and fails with "module not found"; a fresh run of the FULL existing suite (root, `wf-mcp-server`, `review-ui` deterministic + e2e) confirms nothing pre-existing broke.

---

### 17.1 — Nav entry + scene bootstrap flow
**Files:** `review-ui/public/index.html`, `app.js`, `style.css`

- Add a `data-nav="session-planner"` entry to the existing topnav, following the exact pattern of Queue/New Import/Deferred Debt/Graph.
- Empty state: if the world has no scenes yet (or none selected), show a lightweight "start planning a session" affordance — pick a starting location (this can reuse whatever combo-box/search pattern already exists elsewhere in the app for entity selection, don't invent a new one if a suitable pattern is already there), optional freeform objective note, calls `POST /api/session-planner/scenes`.
- Once a scene exists/is selected, fetch and hand off to 17.2's render function.

**Acceptance criteria:** nav entry reachable, empty state creates a real scene via the real API, no regression to existing nav items.

---

### 17.2 — Brief render: anchor + satellite cards
**Files:** `review-ui/public/app.js` (or a new `review-ui/public/session-planner-view.js`, your call — check whether `graph-view.js` being its own file vs. folded into `app.js` is the better precedent to follow given this view's size)

- Fetches `GET /api/session-planner/brief` for the active scene, renders `locations[]` per `plans/phase-17-review.md` §3–4:
  - Path locations (`distance: 0`) get a distinct anchor treatment; everything else renders as satellite cards.
  - **Render order must not correlate with `distance` or any other monotonic field** — shuffle or hash-order. This is a hard, testable requirement (17.0 or a follow-up test should assert render order isn't simply sorted by distance across multiple loads).
  - `digest` renders inline unconditionally; `digest: null` gets a conspicuous "not established yet" state, not blank space.
  - `contentFlag`/`structuralFlag` render as two distinct badges (icon/shape-coded, not color-only), never merged.
- Full-container rebuild on load — matches every other view's convention, no virtualization.

**Acceptance criteria:** a real brief renders correctly against fixture data with a mix of populated and thin (`digest: null`) entities and both flag combinations; a screenshot/visual check confirms the anchor/satellite distinction is visually real, not just structurally present in the DOM.

---

### 17.3 — Inline-expand notes with correct autosave
**Files:** same view file as 17.2

- Each nearby entity row gets its own note affordance (a small icon, per `plans/phase-17-review.md` §5 — NOT the entity name itself, to avoid accidental-edit-while-browsing).
- Click opens an inline textarea beneath the row (no popover, no positioning/clamping code) — pushes the rest of the card down, existing notes for that entity render the same way.
- Wires the debounce/flush helper from 17.0: debounce `input` (~500ms), flush immediately on `blur`, guaranteed flush on `hashchange` (extend the app's existing `hashchange` listener block, alongside `cancelActiveScan()` — add the flush call there, don't create a second navigation-hook mechanism).
- Shared save-slot semantics: if a second note is opened before the first's pending save flushes, flush the first before arming a timer for the second (prevents cross-entity misattribution).
- Explicitly do NOT trigger the 17.2 container rebuild on save success/error — only update a small inline "saved"/"error" indicator on the row itself.

**Acceptance criteria:** the 17.0 flush-on-navigate e2e test passes; a manual multi-entity test confirms no cross-entity text misattribution; confirm via direct inspection that a save success handler never calls the container-level render function.

---

### 17.4 — Beyond-corridor summary
**Files:** same view file

- Renders `beyondCorridor.contentReadinessCount` and `beyondCorridor.structuralUnderConnectionCount` as two separate figures, never summed (`plans/phase-17-review.md` §7).
- Collapsed by default, click-to-expand for whatever detail is genuinely cheap to show (if none is cheap, expand can just re-state the two split numbers more prominently — don't build new aggregation to have something to expand into).

**Acceptance criteria:** both counts render distinctly; collapse/expand works; no proactive e2e test required for this task (correctly reactive-only per the design record).

---

### 17.5 — Re-center control
**Files:** same view file

- Type-ahead/search-as-you-select location picker (reuse the same pattern as 17.1's scene-bootstrap location picker if it fits — don't build two different combo-box implementations in one phase).
- On selection: disable the control, call `POST /api/session-planner/scenes/:id/fork`, then `GET /api/session-planner/brief` for the new scene, replace the 17.2 render, re-enable the control.
- Race guard: a single shared, replaced-on-every-invocation abort slot (`activeRecenterController`, mirroring `activeScanController`'s exact pattern) — extend the existing `hashchange`/`renderCurrentView()` cancellation step (which already calls `cancelActiveScan()`) with a parallel `cancelActiveRecenter()`.
- Unlike 17.3's notes, this IS correct to abort on navigate-away/double-click — it's derived view state, not typed text.

**Acceptance criteria:** the 17.0 double-click-recenter e2e test passes; confirm via direct inspection that the disable-during-fetch guard and the abort-slot guard are both present (defense in depth, not either/or, per the design record).

---

## How to work

- 17.0 must fully complete, commit, and be confirmed red before 17.1 starts.
- Ground every implementation task in the actual current code — re-locate exact lines/selectors fresh.
- Commit after each completed task, clean incremental history. Stage files explicitly, never `git add -A`.
- No `foundry_worldFabric` changes anywhere in this phase — confirm `git -C /home/russell/foundry_worldFabric status --short` shows only its known pre-existing unrelated changes, before and after.
- Self-review remediation pass at the end of 17.5: run the FULL suite (root, `wf-mcp-server`, `review-ui` deterministic + e2e), re-confirm the render-order-isn't-sorted-by-distance requirement holds, re-confirm no note-save path calls the container-level rebuild, and take real desktop + mobile-viewport screenshots (matching Phase 15's verification bar) of the new view.

## Definition of done for Phase 17

- [ ] 17.0's Playwright + unit tests committed, confirmed red before any implementation exists.
- [ ] Nav entry + scene bootstrap (17.1) reachable and functional.
- [ ] Brief renders with correct anchor/satellite layout, non-monotonic render order, visible digest/flags (17.2).
- [ ] Inline-expand notes with correct debounce/blur/hashchange-flush semantics, no cross-entity misattribution, no container-rebuild-on-save (17.3).
- [ ] Beyond-corridor summary shows split (not summed) counts (17.4).
- [ ] Re-center works with both the abort-slot guard and the disable-during-fetch guard (17.5).
- [ ] Both proactive e2e tests green; full existing suite (root + `wf-mcp-server` + `review-ui` deterministic + e2e) still passes.
- [ ] `foundry_worldFabric` confirmed untouched throughout.
- [ ] Self-review remediation pass run and reported, including real screenshots.
