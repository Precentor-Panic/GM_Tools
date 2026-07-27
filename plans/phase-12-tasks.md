# GM_Tools — Phase 12 Task Plan: Interactive Graph Editor

**Status:** ready to execute. **Prerequisite reading:** `CLAUDE.md` → `PLAN.md` → this file → `plans/phase-12-review.md` (design record — read it before building anything, the DECIDED items and the confirmed metadata nominations are settled, not a starting point to redesign) → `.claude/skills/gm-tools-conventions/SKILL.md`.

**What this is:** turns the read-mostly graph view (Phase 7) into a real editing surface — manual node/edge create/edit/delete (immediate-write, no review gate), an LLM-assisted "scan for mentioned entities" workflow (goes through the existing accept/reject flow, like everything else AI-proposed), a narration reset control, four new World Fabric schema fields, and — flagged by the design review as the single most important piece — a dedicated undo mechanism for manual edits, since they bypass the batch/rollback system entirely.

**Real, unusual scope note for this phase**: task 12.1 requires making genuine additive changes to `/home/russell/foundry_worldFabric` — the FIRST time in this project's history an execution phase has needed to add code there rather than only read from it. That repo has its own pre-existing uncommitted changes (`package.json`, `scripts/apps/cockpit-app.mjs` modified; `setup-test.mjs`, `test/e2e-m13a.mjs` untracked) that are NOT yours — do not touch, revert, or commit them. Your own new changes there must be staged and committed explicitly by filename, never `git add -A`, and committed as their own commit(s) in that repo, separate from GM_Tools' own commits.

**Known, repeatedly-bitten risk in this exact codebase**: World Fabric's `module.mjs`'s `_runMigration` merges NEW attributeDef keys additively but has, twice before in this project's history (see `plans/phase-1.5-tasks.md`'s and its remediation notes), failed to retroactively update an *already-persisted* attributeDef on an existing world. For task 12.1's genuinely-new fields this is a lower-risk shape of change than those past cases (you're adding new keys, not changing what an existing key derives), but verify this directly against a real existing world (`wf-test`) rather than assuming — the established practice in this project is to always live-reverify a World Fabric schema/migration change, not just unit-test it.

---

## Task list

### 12.1 — World Fabric schema additions (cross-repo)
**Files:** `/home/russell/foundry_worldFabric/scripts/constants.mjs`, `scripts/module.mjs` (migration), and wherever entity attributeDefs are actually declared per-type (confirmed by reading the code, not assumed — check `constants.mjs`/`module.mjs`'s `game.settings.register` default and any schema file)

- Four new fields, all additive:
  1. **Status/lifecycle** — a type-appropriate enum (alive/dead for `person`; active/destroyed/lost for `place`/`object`; active/disbanded for `faction`). Confirm with real data whether `event`/`concept` need this at all (the design doc doesn't specify — use judgment, likely N/A for those two).
  2. **GM-only visibility flag** (`playerKnown` or similar) — boolean, distinct from the existing `namespace` field.
  3. **Canon-lock / draft-vs-confirmed flag** — distinct from the existing `source` (hand-authored vs. LLM-generated) field.
  4. **PC vs. NPC distinction** on `person` entities — a `role` attribute or equivalent.
- Migration: additive only, matching this project's own established convention — new fields default to a sensible "unknown/unset" value on existing entities, never require a destructive rewrite.
- **Live-reverify against the real `wf-test` world** (per this project's own established practice for any World Fabric schema/migration change) — confirm existing entities pick up the new fields with sensible defaults and nothing existing breaks.
- Update `graph-import/writeup-import.mjs`'s `RawWfiEntity` zod schema (GM_Tools side) to optionally accept these new fields where it makes sense for LLM-proposed content to set them (e.g. an extracted NPC could plausibly get a `role` guess) — additive, optional fields only, don't make extraction depend on them.

**Acceptance criteria:** a real test against a live-reloaded `wf-test` world (or the established pattern this project uses for that — check `plans/phase-1.5-tasks.md`'s verification approach) confirming the new fields exist with correct defaults on already-persisted entities, not just newly-created ones. GM_Tools-side unit tests for the schema extension.

---

### 12.2 — Surface existing + new fields in the graph UI
**Files:** `review-ui/public/graph-view.js` (extend node popover), `wf-mcp-server/lib/graph.mjs` or `review-ui/server.mjs`'s graph data route (extend node payload)

- Add `importance`, session-staleness (derived from `lastSession`/`sessionSeen` vs. the existing `staleThreshold` setting), `foundryRef` presence, and the four new fields from 12.1 to the node popover's displayed fields — pure UI wiring over already-fetchable data, no new backend logic beyond including these fields in the existing graph-data route's response.
- Confirmed explicitly NOT in scope: no "quick plot-relevance note" field — the project owner did not approve this nomination.

**Acceptance criteria:** route test confirming the new fields are present in `/api/graph`'s node payload; manual visual verification that the popover displays them sensibly (not a raw JSON dump).

---

### 12.3 — Manual node/edge create, edit, delete
**Files:** `review-ui/public/graph-view.js` (major extension), `review-ui/server.mjs` (new routes), possibly a new small library module for the direct-write path (your call — likely reuses `graph-import/headless-apply.mjs`'s `applyHeadless`/`applyMutationsWithHeadlessFallback` machinery directly, since a manual edit is structurally the same kind of write as a synced mutation, just without a review-state batch wrapping it first)

- **Add node**: toolbar "+ Add Node" → placement mode → click canvas → inline form (name/type/description) anchored at click point → writes immediately. Esc/click-outside cancels.
- **Add edge**: press-and-hold drag (~5px threshold) from a node → release on another node creates the edge with a default relationship type and opens an inline type/label/strength/notes prompt at the edge midpoint; release on empty space cancels. No self-loops. Re-dragging an existing same-type pair opens that edge for editing instead of duplicating.
- **Edit node/edge**: an Edit (pencil) icon in the node popover and the new edge popover (edge popover itself is new work — click an edge line to open it, mirroring the node popover's shape) turns static fields into the same inline-editable form used for creation. Writes immediately.
- **Delete node/edge**: a Delete (trash) icon in both popovers. Inline confirm within the popover showing the real cascade count for a node delete ("...and its N connected edges"), not a browser `confirm()`. Delete/Backspace as a secondary shortcut only when a popover's subject is the delete target.
- Manually-created/edited nodes render in the normal "reviewed" color, never the unreviewed-amber treatment.
- Cross-cutting: every new inline-edit surface treats Esc/click-outside as cancel.
- Explicitly deferred, do not build: bulk-select / multi-node actions (per the design doc's own reasoning — no existing multi-select model in this graph view, and it would need a real undo history first, not the single-slot mechanism this phase ships).

**Acceptance criteria:** route/unit tests for the new create/edit/delete endpoints (a delete's cascade behavior specifically — deleting a node must delete its own edges, matching `graph-service.mjs`'s existing live-Foundry delete_entity cascade behavior, and `applyHeadless`'s own existing delete cascade if that's the path reused). Real visual verification (headless Chromium, screenshots inspected): placing a node, drawing an edge with the type prompt, editing an existing node's fields, deleting a node and confirming its edges go with it.

---

### 12.4 — Undo Last Manual Edit
**Files:** likely `review-ui/server.mjs` (a new small server-side single-slot buffer, or client-side if the write itself returns enough pre-state to reconstruct an inverse — your call once in the code, but note this needs to survive a page reload per this project's own established "real persistence, not just in-memory" standard from Phase 10's narration bug, so lean server-side unless you have a specific reason not to), `review-ui/public/app.js`/`graph-view.js`

- **Flagged by the design review as the single most important piece of this phase — do not treat as optional or defer it.** Manual edits (task 12.3) bypass the batch/rollback system entirely, so without this, a bad manual delete is genuinely unrecoverable.
- Single slot, most-recent-manual-edit-only, no history list — deliberately mirrors `rollback.mjs`'s existing batch-rollback simplicity, applied to the new immediate-write path instead.
- Covers every immediate-write action from 12.3: add node, add edge, edit node, edit edge, delete node (cascade-deleted edges as one atomic undo unit), delete edge, plus narration reset (12.6).
- Surfaced two ways: a transient toast after each manual write with an inline "Undo" link (reuse the existing `showToast(message, undoFn)` helper from Phase 6/8/10 if its shape fits), and a persistent toolbar item, grayed out when the slot is empty.
- Any new manual edit overwrites the slot (last-write-wins, not a stack).

**Acceptance criteria:** a real test proving each of the six covered actions is genuinely undoable (the graph state after undo matches the state before the original edit, verified via the API, not just the DOM) and that a second manual edit correctly overwrites (not stacks onto) the undo slot.

---

### 12.5 — Scan for mentioned entities
**Files:** likely `graph-import/writeup-import.mjs` (extend — reuses its existing name+type dedup matching, confirm the exact function to reuse rather than reimplementing) or a new small sibling module, `wf-mcp-server/lib/`, `review-ui/server.mjs` (new routes), `review-ui/public/app.js` (frontend: trigger button + two-badge-type result review screen)

- Given a block of text (the primary case: Phase 11's already-displayed generated prep content), scan for entity mentions and produce two distinct result types: **links to existing entities** (name+type match against the live graph — reuse writeup-import's exact matching logic) and **proposed new entities** (unmatched names, with a guessed-but-editable type and a short description drawn from context).
- Trigger: primary on the entity content-generation panel (next to the displayed text), secondary as a "Scan this node's content" shortcut in the node popover — same underlying action, two entry points.
- Result review: routes through the **existing** accept/reject/regenerate review screen (this is a normal review-state batch, not a manual-edit-path write — matches decision 3's explicit requirement that LLM-proposed extensions stay gated). Each row carries a mandatory badge (link icon + "Existing" vs. plus icon + "New") and border accent. Split any "Accept All" into **"Accept all links"** and **"Accept all new entities"** as two separate actions.

**Acceptance criteria:** unit test confirming a mixed input (some mentioned names matching existing entities, some not) produces correctly-typed results of both kinds, reusing (not duplicating) writeup-import's dedup; a real-API smoke test with real generated-content-shaped text; manual visual verification that the two result types are genuinely visually distinguishable, not just labeled.

---

### 12.6 — Narration reset
**Files:** `mutation-engine/entity-narration.mjs` (extend), `wf-mcp-server`/`review-ui` routes, frontend

- A reset action appends a new **empty-content version** to the entity's existing narration history (Phase 10's versioning mechanism, unchanged) with a "reset" marker/reason, and moves the current pointer to it. Nothing is deleted — this is the existing "never silently deleted" rule applied to a blank value, not a new exception.
- Location: entity detail view (primary) and graph popover (secondary quick action).
- Confirmation: lighter-weight than delete's — inline confirm noting prior versions remain in history.
- Covered by task 12.4's undo mechanism (a reset is a manual-edit-shaped action even though it touches the Phase 10 narration store, not the graph itself).

**Acceptance criteria:** a test confirming reset produces a new empty `'current'` version while all prior versions remain queryable via the existing history endpoint (Phase 10's `getEntityNarrationHistory`) — reuse that test file's own established pattern.

---

## How to work

- **Actually look at what you build** — this phase is almost entirely new interaction surface. Use the `run` skill and either `claude-in-chrome` or (if unavailable, as in every prior UI phase) real headless Chromium via Playwright, borrowed read-only from `foundry_worldFabric/node_modules`.
- Ground every claim in the actual code — task 12.1 specifically requires reading World Fabric's real migration/attributeDef mechanics before writing anything, given this project's own repeated history of getting that wrong on first attempt.
- Commit after each completed task, clean incremental history, in **both** repos as applicable (GM_Tools for 12.2-12.6, GM_Tools + foundry_worldFabric for 12.1) — stage files explicitly by name in both, never `git add -A`, especially in `foundry_worldFabric` given its pre-existing unrelated uncommitted changes.
- Self-review remediation pass at the end: specifically re-check (a) the undo mechanism genuinely covers all six manual-write action types, not just node create/delete, (b) a node delete's edge cascade actually happens and is itself covered by the same undo action as one atomic unit, (c) the scan-for-mentioned-entities feature's two result types are genuinely using different code paths for "link" vs. "propose new," not a single path with cosmetic labeling, and (d) narration reset really does append rather than overwrite/delete in the history store.

## Definition of done for Phase 12

- [ ] Four new World Fabric fields added, additive migration verified live against `wf-test`, not just unit-tested.
- [ ] Existing + new fields surfaced in the graph popover.
- [ ] Manual add/edit/delete for both nodes and edges, immediate-write, no review gate — confirmed working via real visual verification.
- [ ] "Undo Last Manual Edit" covers all six manual-write action types, single-slot, verified via real API state comparison before/after undo.
- [ ] Scan-for-mentioned-entities produces correctly dedup'd link-vs-new results, routes through the existing review flow, visually distinguishable result types.
- [ ] Narration reset appends an empty version, never deletes history.
- [ ] Full test suite (root + wf-mcp-server + review-ui) still passes; World Fabric's own test suite (if one runs cleanly independent of its pre-existing uncommitted changes) not broken by the new migration.
- [ ] Self-review remediation pass run and reported.
