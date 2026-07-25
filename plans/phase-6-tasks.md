# GM_Tools — Phase 6 Task Plan: Dedicated Web Review UI

**Status:** ready to execute. **Prerequisite reading:** `CLAUDE.md` → `PLAN.md` → this file → `plans/phase-6-review.md` (the full design reasoning — read it before building anything visual, its specific choices are settled, not a starting point to redesign from) → `.claude/skills/gm-tools-conventions/SKILL.md`.

**What this is:** the actual visual interface for everything built in Phases 1-5 — deliberately deferred since Phase 1 for exactly this moment. Everyone who's used this project so far has done so through conversational MCP tool calls; this phase makes it a thing you look at and click.

**The good news, confirmed by reading the actual codebase before writing this file:** every library function this UI needs already exists, is pure/Foundry-free, and is already tested. This phase is a thin HTTP layer over existing code plus the frontend described in `phase-6-review.md` — **not** new backend logic. Specifically, already built and ready to import directly:
- `mutation-engine/review-state.mjs` — `listBatches`, `loadBatch`, `saveBatch`, `updateMutationStatus`
- `mutation-engine/grain.mjs` — `summarizeBatch`, `renderHeadline`/`renderRegionDiff`/`renderEntityDiff`, `HEADLINE_IMPORTANCE_THRESHOLD`
- `mutation-engine/narrate.mjs` — `narrateBatch`, `assertBatchNarratable` (the accept-gate — the frontend must never be able to request narration for an unaccepted batch; rely on this existing gate, don't reimplement the check)
- `mutation-engine/rollback.mjs` — `rollbackBatch`
- `mutation-engine/pending-ledger.mjs` — `listPendingEntities`, `readPending`/`readAvailablePending`
- `time-skip/resolve-pending.mjs` — `resolvePending`
- `mutation-engine/human-review.mjs` — `findUnreviewedEntities`, `getHumanReviewState`, `markHumanReviewed`
- `wf-mcp-server`'s existing `applyMutationsWithHeadlessFallback`-style dual-path apply (Phase 4) for sync status

**No framework, no build step — vanilla HTML/CSS/JS + a small local Node HTTP server, per the project's established convention** (confirmed still the right call by the HMI design pass, which designed specifically within this constraint — native `<details>/<summary>` for inline expansion, plain `fetch()`, no component library).

---

## Task list

### 6.1 — HTTP server + core routes
**Files:** `review-ui/server.mjs` (new), `review-ui/package.json` (new, its own dependency scope — matching `wf-mcp-server`'s own-package-json precedent rather than adding a web-server dependency to the shared root)

- A small local HTTP server (bare `node:http` or a minimal framework — your call, but keep the dependency footprint proportionate to this project's existing minimal-dependency ethos; document whichever you pick and why) importing the library modules above **directly** — no MCP round-trip, no requirement that a Claude Code session be open. This is the same architectural point made when headless-apply was designed: reviewing shouldn't require a live chat session.
- Routes needed (exact paths/methods are your call, but cover this functionality): list pending batches (for the Queue view); get one batch's full detail (headline + all region/entity diffs, for the Review view); accept/reject at entity, region, or whole-batch grain; regenerate-with-note at any grain; request narration for an accepted batch (must 4xx cleanly if the batch isn't fully accepted, surfacing `narrate.mjs`'s own `assertBatchNarratable` error, not a generic 500); trigger sync (headless/live dual-path); list/search pending-ledger entities and resolve one; list unreviewed-accumulation-flagged entities; rollback the most recent batch.
- Serve the frontend (task 6.2-6.5's static files) from the same server.

**Acceptance criteria:** a smoke test (real HTTP requests against a running instance of this server, not mocked) exercising each route against a fixture world: list batches, get one, accept a mutation, request narration on a fully-accepted batch (succeeds) and on a partially-accepted one (clean error, not a crash), resolve a pending-ledger entry, rollback.

---

### 6.2 — Queue view
**Files:** `review-ui/public/index.html` (new — shared shell for all four views), `review-ui/public/app.js`, `review-ui/public/style.css`

- Per `phase-6-review.md`: pending batches first (explicitly-requested work), then unreviewed-accumulation-flagged entities. No charts, no graph preview. A true empty state — one line, not a big dashboard shell that still LOOKS like a dashboard when there's nothing in it.
- This task establishes the shared shell (`showView(id)` hash-based view switching, no router library) that tasks 6.3-6.5 plug into as additional `<section>`s.

**Acceptance criteria:** manually verified (start the server per the `run` skill's pattern, open in a real browser via `claude-in-chrome`, actually look at it) — an empty queue reads as "nothing pending" cleanly, and a queue with fixture batches lists them sensibly sorted.

---

### 6.3 — Batch Review view
**File:** `review-ui/public/app.js`/`style.css` (extend), new `<section id="review">` in `index.html`

This is the core of the phase — implement `phase-6-review.md`'s Batch Review section precisely:
- One row per entity mutation: checkbox (outside the `<summary>` so it doesn't trigger expansion) + plain-language headline line + native `<details>/<summary>` disclosure.
- Sticky action bar at the top of the list: Accept Selected / Reject Selected / Select All Boring (pre-checks everything below `HEADLINE_IMPORTANCE_THRESHOLD`).
- Diff rendering: two-column `field : before → after`, monospace values only, changed cells visually distinct, unchanged fields omitted, `(created)` as a recognizable badge not a blank.
- Regenerate-with-note: input + button inside the expanded row's own `<details>`, below its diff; regenerating swaps just that row's content via `fetch`.
- **Narration gating and styling — get this exactly right, it's the single most emphasized point in the design doc:** narration must never render before that mutation's batch is accepted. Once accepted, narration replaces that row's action area, styled distinctly per the doc (serif font, parchment/cream background tint — `#faf3e6` light, a warm dark-brown equivalent in dark mode, larger line-height, no label) — visibly different from the rationale's plain sans-serif card at a glance, not just via a text label.
- Unreviewed-accumulation flag treatment: 1px amber left border + small filled dot before the headline text on flagged rows, forced into the list regardless of importance (query `human-review.mjs`'s `findUnreviewedEntities` server-side, mark those rows). Expanding shows "Never reviewed — accumulated N changes since cycle X."
- Call `markHumanReviewed` (or whatever the actual review-status update hook is, per Phase 4's `human-review.mjs`) when a row is individually expanded/reviewed or acted on at region/entity grain — **not** on a batch-level accept-all, matching Phase 4's own established distinction exactly.

**Acceptance criteria:** manually verified in a real browser (`run` + `claude-in-chrome`, actual screenshots looked at, not assumed) — take a screenshot of an expanded row showing rationale, and a screenshot after accepting showing narration, and confirm by looking at them that the visual distinction is actually real, not just present in the CSS source. Also a scripted test confirming narration requests against a non-fully-accepted batch are rejected (reuses 6.1's route-level test, extend if needed).

---

### 6.4 — Deferred Debt tab
**File:** new `<section id="debt">`, `review-ui/server.mjs` (extend with the search/resolve routes from 6.1)

- Search box filtering a flat pending-entity list client-side (fetch the full list once, filter in JS — no need for server-side search at this scale).
- Selecting a result inline-expands (same `<details>` pattern as 6.3) showing accumulated tags as a plain list, each labeled with its cycle, plus one `[Resolve Now]` button.
- Resolving fires `resolve-pending.mjs`'s `resolvePending`, then swaps the tag list for a normal diff view in place — reuse 6.3's diff-rendering code, don't build a second diff renderer.

**Acceptance criteria:** manual verification against a fixture world with real accumulated pending entries (reuse a fixture similar to Phase 3.5's own multi-cycle test if one exists) — confirm search finds an entity, resolve produces a real diff inline, and the resolved entries no longer show as pending afterward.

---

### 6.5 — Settings/Sync + Rollback + Graph-browser link
**File:** new `<section id="settings">`

- Gear icon (or equivalent) reaching a corner-anchored settings view: sync status (small colored dot + "Foundry: live" / "Headless" text, pulled from whatever the existing dual-path apply already reports), one "Undo Last Batch" button (plain `window.confirm`, calls `rollback.mjs`'s `rollbackBatch` via 6.1's route — no visible history/log, per the design doc's explicit instruction), and a link to a genuinely separate full-page graph browser.
- **The graph browser itself is explicitly out of scope for this task** — it's a "maybe once a month" tool per the design doc, not something this phase needs to build out. A stub page or a clear "not yet built" link is fine; don't invest real effort here.

**Acceptance criteria:** manual verification that sync status reflects the real dual-path state, and that rollback actually works end-to-end from this UI (not just the underlying function).

---

### 6.6 — Polish: the HMI persona's own flagged additions
**Files:** `review-ui/public/app.js`/`style.css` (extend)

- Undo toast after any accept/reject: inline "Undo" link visible for ~8 seconds, calls the same rollback path as 6.5's button.
- Keyboard shortcuts on the Review view: `j`/`k` move focus between rows, `space` toggles the focused row's checkbox, `enter` expands/collapses it.

**Acceptance criteria:** manually verified in a real browser that both work as described.

---

## How to work

- **Actually look at what you build.** This phase is explicitly about the visual surface — use the `run` skill to launch the server and the `claude-in-chrome` skill to open it in a real browser, click through the flows, and take screenshots. Report what you actually saw, not what the code should render. This matters more here than in any prior phase.
- Write backend tests in the project's existing style (`node --test`, no framework). The frontend has no automated test framework in scope for this phase — manual, screenshot-verified checks are the acceptance mechanism for visual/interaction correctness, per the task-level acceptance criteria above.
- Commit after each completed task, clean incremental history.
- Budget a self-review remediation pass at the end, same as every phase since Phase 2 — for this phase, specifically re-check the narration-gating logic and the accept-vs-review distinction (task 4.2's `human-review.mjs` hook), since those are the two places a subtle bug would be easy to miss and hard to notice without deliberately checking.

## Definition of done for Phase 6

- [ ] All four views built and reachable via the shared shell, no separate pages except the (stubbed) graph browser.
- [ ] Narration never renders before acceptance — verified by an actual test, not just code review.
- [ ] Narration and rationale are visually distinguishable at a glance — verified by looking at a real screenshot, not just reading the CSS.
- [ ] Unreviewed-accumulation flags are forced into the headline view and visually marked, per the design doc's exact treatment.
- [ ] `markHumanReviewed` fires on individual review actions, not on batch-accept-all — verified by test, matching Phase 4's own established distinction.
- [ ] Deferred-debt search-and-resolve-in-place works end-to-end.
- [ ] Rollback and sync status work from the UI, not just the underlying library functions.
- [ ] Full test suite (existing `npm test` suites) still passes; new backend routes have their own tests.
