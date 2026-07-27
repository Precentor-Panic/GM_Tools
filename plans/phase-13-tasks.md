# GM_Tools — Phase 13 Task Plan: Graph Editor Remediation (Round 2 Hands-On Feedback)

**Status:** ready to execute. **Prerequisite reading:** `CLAUDE.md` → `PLAN.md` → this file → `.claude/skills/gm-tools-conventions/SKILL.md`.

**What this is:** direct fixes for four real issues found in a second hands-on session with Phase 12's interactive graph editor. No new persona design round precedes this — the project owner's own feedback is concrete and decisive enough to build from directly, matching the same discipline as every prior "real gaps found in hands-on use" remediation round this project has done (see the commits following Phases 8, 10, and 12's own initial landing). Once this ships, a separate persona-driven QA pass (DM personas running through concrete test tasks) follows — see the note at the end; do not fold that into this task list.

**Confirmed by direct investigation before writing this plan** (do not re-derive, just verify still true when you start):
- Every one of `wf-mcp-server/lib/manual-edit-ops.mjs`'s six write functions (`addNodeOp`, `addEdgeOp`, `editNodeOp`, `editEdgeOp`, `deleteNodeOp`, `deleteEdgeOp`) plus the undo consumer call `applyMutationsWithHeadlessFallback` — the SAME live-Foundry-poll-then-headless-fallback function the Sync button uses, meaning every single micro-edit independently pays the full ~7s poll. This is the root cause of "takes way too long."
- `review-ui/public/graph-view.js`'s `LAYOUT_W = 960`/`LAYOUT_H = 620` are FIXED constants, never scaled by node count — the force simulation packs any number of nodes into the same fixed area, which is why nodes end up on top of each other as a graph grows. Panning today is native browser scroll only (`overflow: auto` on `.graph-view-container`), no drag-to-pan.
- The scan-for-mentioned-entities review flow (`graph-import/scan-mentions.mjs`) reuses writeup-import's exact name+type dedup and has no correction path today: a "propose new" row that should have matched an existing entity can only be accepted-as-new or rejected outright, never redirected to link to the entity it actually meant.
- Narration (Phase 10) is confirmed unaffected and fully working — it's simply not wired into the standalone Graph/manual-edit/develop-node surfaces at all, by original design (narration is entity-in-a-batch-scoped). Nothing to fix here; mentioned only so the executing agent doesn't go looking for a regression that isn't there.

---

## Task list

### 13.1 — Defer manual edits to headless-immediate + batched Foundry sync
**Files:** `wf-mcp-server/lib/manual-edit-ops.mjs`, `mutation-engine/review-state.mjs` (if needed), `review-ui/server.mjs`, `review-ui/public/app.js`

- **The core architectural change, directly requested**: manual edits should write to the headless snapshot immediately (fast, no live-Foundry-poll at all), and pushing to a live Foundry client becomes a separate, deferred, explicit action — mirroring the existing batch accept→sync pattern the project owner referenced directly ("like we do with the other updates").
- **Real risk to solve, not just defer blindly**: `applyMutationsWithHeadlessFallback`'s own existing doc comment already documents that if a live Foundry client later reopens a world that was headlessly edited, Foundry's own auto-export can overwrite the headless changes, since Foundry's `game.settings`-backed state never learned about them. Writing headless-only by default (rather than as today's rare fallback case) makes this far more likely to actually bite — do not ship a version of this fix that just writes headless and calls it done. The deferred sync step must genuinely push through the live-Foundry mutations-file bridge (the same path `applyMutationsWithHeadlessFallback`'s live branch already uses) when the user actually triggers it, not just re-export the headless snapshot.
- **Recommended mechanism** (your call on exact wiring, but this is the shape that reuses existing infrastructure rather than inventing a parallel system): route each manual edit's underlying mutation through `review-state.mjs`'s existing batch machinery, auto-accepted at creation (skip the pending→accept step manual edits don't need per Phase 12's own "no review gate" decision), applied headlessly right away via `applyHeadless` directly (not the dual-path function) for instant feedback. Because the batch's mutation is `status:'accepted'` but the batch itself stays `status:'open'`, it already surfaces via the Queue fix from earlier this session (`acceptedCount > 0` keeps a batch listed as needing attention) — and the *existing* Sync button/route (`syncOp`) already knows how to push an open batch's accepted-but-unsynced mutations through the real live-first dual-path apply. If this reuse genuinely works cleanly, you get the deferred-sync UI almost for free; confirm this by actually testing it, don't assume.
- Whatever mechanism you land on, the single-slot "Undo Last Manual Edit" from Phase 12 task 12.4 must keep working — re-verify all six action types remain undoable after this change, since the write path underneath them is changing.
- A standalone Graph view affordance showing "N manual edits not yet synced to Foundry" (mirroring the Review screen's existing sync bar) with a way to trigger the sync — reuse that bar's component/pattern if it fits rather than building a second one from scratch.

**Acceptance criteria:** a real timed test proving a manual node create now completes in well under a second (not ~7s); a real test proving a later explicit sync push genuinely goes through the live-Foundry mutations-file bridge (not just a headless no-op); all six undo action types re-verified working; manual visual verification that the "unsynced" indicator appears and clears correctly.

---

### 13.2 — Graph layout: let it sprawl, real panning
**Files:** `review-ui/public/graph-view.js`

- Make the logical layout area scale with node count instead of staying fixed at 960×620 — e.g. grow both dimensions with `sqrt(nodeCount)` or similar, tuned so a graph of a few dozen nodes has genuine room to spread out rather than being forced into the same small box a 2-node graph uses. Re-tune the force simulation's repulsion/iteration count if a bigger canvas alone doesn't fix visible overlap on a realistic-size test graph (build one with 15-20+ nodes to verify against, not just the existing 2-3-node fixtures).
- Add real click-and-drag panning for the standalone Graph view specifically (scoped there because batch mode's rubber-band-select already owns background-drag — don't touch that interaction). The existing zoom implementation was deliberately built as a CSS-size change rather than a viewBox/transform change specifically so the ratio-based coordinate math in `showPopover()`/`wireRubberBandSelection()` stays correct at any zoom level without modification — panning via `container.scrollLeft`/`scrollTop` (a drag gesture that programmatically scrolls, same effect as native scroll, just more discoverable and usable) keeps that same property; do not switch to a viewBox-based pan/zoom approach, it would reopen coordinate-math work that's already been debugged once.
- Zoom in/out/reset controls already exist (Phase 7/Phase-12-era work) — confirm they still work sensibly against the new, larger default canvas; adjust default zoom-to-fit behavior if the bigger canvas means 100% now shows too little on first load (your call whether an initial "fit to view" zoom level makes sense, but don't overbuild this if simple zoom-out-then-look-around is good enough once panning is real).

**Acceptance criteria:** real visual verification (screenshots) against a graph with 15-20+ nodes showing genuinely separated, non-overlapping nodes; confirm click-and-drag panning actually moves the visible viewport and reaches nodes that start off-screen; confirm zoom still works correctly at the new canvas size (reuse the existing popover-position and rubber-band-hit-testing checks from Phase 7/12's own verification, since those are exactly the things a canvas-size change could silently break).

---

### 13.3 — Correction path: redirect a "propose new" mention-scan result to an existing entity
**Files:** `graph-import/scan-mentions.mjs` or wherever the batch's mutations are stored, `wf-mcp-server/lib/mutation-ops.mjs` or a new small ops module, `review-ui/server.mjs`, `review-ui/public/app.js`

- Concrete scenario driving this: a "develop this node" pass generates content mentioning an entity the project owner already has in the graph; the scan-for-mentioned-entities pass misses the match and proposes it as a new entity instead of a link. Today there's no way to fix that at review time short of rejecting the whole thing.
- Add a per-row action on a mention-scan batch's **"propose new"** rows only (not present on "link" rows, which are already correct by definition): a "Link to existing instead" control — a searchable entity picker (reuse whatever search/filter pattern already exists, e.g. the standalone Graph view's own search box, or the Deferred Debt tab's search — don't build a third search UI from scratch) that, on selection, converts that row's mutation from an `upsert_entity` (create) into an `upsert_edge` (link to the chosen existing entity) — visually and functionally becoming a "link" row rather than a "new" row, badge and all.
- This is a correction to a *pending* (not yet accepted) mutation within an open batch — it should replace that one mutation in place, the same general shape as the existing regenerate-a-single-row mechanism elsewhere in this codebase (check `regenerateOp`'s scope='entity' path for the established pattern of swapping one mutation for another within a batch, reuse rather than invent a new replace mechanism if it fits).

**Acceptance criteria:** a real test proving a "propose new" row, once redirected, produces a genuine `upsert_edge` mutation targeting the chosen existing entity id (not a modified create) and that accepting the batch afterward creates the edge, not a duplicate entity; manual visual verification that the row's badge/border changes from "new" to "link" styling immediately after redirecting.

---

### 13.4 — Lightweight pre-pass to catch more existing-entity matches up front
**Files:** `graph-import/scan-mentions.mjs`

- The project owner's own observation: generated content tends to already use "the right names" (it's grounded in real graph context per Phase 10/11's adjacency-aware generation), so a cheap, deterministic pre-pass over the existing graph's entity names against the scan text — before or alongside the LLM-driven proposal — should catch some matches that today only get proposed as new because of an imperfect name/type match in the LLM's own output.
- Scope this modestly: a simple case-insensitive substring or fuzzy-name check (e.g. token overlap, or an edit-distance threshold — your call on the exact technique, but keep it simple and explainable, not a new dependency) run against the existing graph's entity names for names LLM mention-extraction found, surfaced as an additional signal alongside the LLM's own name+type dedup rather than replacing it. If the deterministic pre-pass finds a plausible match the LLM's own dedup missed, prefer it (a link) over a blind create.
- This task exists specifically to REDUCE how often task 13.3's correction path is needed, not to replace it — 13.3 must ship regardless of how good this pre-pass turns out to be, since perfect matching isn't realistic.

**Acceptance criteria:** a unit test constructing a case where the LLM's exact name+type dedup would miss a match (e.g. a minor name variation) but the pre-pass catches it; confirm this doesn't introduce false-positive links (a test with two genuinely different entities of similar name, confirming they're NOT incorrectly merged).

---

## How to work

- Actually look at what you build for 13.2/13.3 — both are visual/interaction-heavy. Use the `run` skill and either `claude-in-chrome` or (if unavailable, as in every prior UI phase in this project) real headless Chromium via Playwright, borrowed read-only from `foundry_worldFabric/node_modules`.
- Ground every claim in real code, especially task 13.1's Foundry-sync-reconciliation concern — read `applyMutationsWithHeadlessFallback` and its own doc comments fully before deciding the exact mechanism, don't guess at how the live/headless split actually behaves.
- Commit after each completed task, clean incremental history. Stage files explicitly, never `git add -A`.
- Self-review remediation pass at the end: specifically re-check (a) task 13.1's deferred sync genuinely reaches a live Foundry client through the real bridge mechanism when triggered, not just a no-op headless re-write, (b) all six Phase 12 undo action types still work after 13.1's write-path change, (c) task 13.2's panning and zoom don't break the existing popover-positioning/rubber-band-hit-testing correctness already verified once for Phase 7/12, and (d) task 13.4's pre-pass doesn't produce false-positive links.

## Definition of done for Phase 13

- [ ] Manual node/edge create/edit/delete complete in well under a second; a real, working deferred-sync action exists and genuinely pushes to a live Foundry client through the real bridge when triggered.
- [ ] Undo still covers all six action types after the write-path change.
- [ ] A realistic-size graph (15-20+ nodes) renders with visibly separated nodes, not overlapping.
- [ ] Real click-and-drag panning works in the standalone Graph view.
- [ ] A "propose new" mention-scan row can be redirected to link to an existing entity instead, verified end-to-end (not just UI-deep).
- [ ] The lightweight pre-pass catches at least the deliberately-constructed near-miss case in its own test, without false-positive merges.
- [ ] Full test suite (root + wf-mcp-server + review-ui) still passes.
- [ ] Self-review remediation pass run and reported.

---

## After this ships: persona QA pass (separate follow-up, not part of this task list)

The project owner has explicitly asked for a round of DM-persona-driven testing once these fixes land — several personas (including the one already used earlier in this project) running through concrete "test tasks" against the real running tool, catching bugs and gathering improvement suggestions to report back for the owner's own review (not auto-incorporated). Do not build this into Phase 13's own execution — it happens after, dispatched separately once Phase 13 is verified.
