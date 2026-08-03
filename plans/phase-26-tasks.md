# GM_Tools — Phase 26 Task Plan: Plans, Scene Linking, and Real-Usage Remediation

**Status:** ready to execute. No separate design record — per the project owner's explicit choice, this phase went straight from real hands-on feedback (post-Phase-25 manual testing of both the construction UI and Table Mode) to this task plan, same precedent as Phases 13/14/20. The grounding and architectural decisions below were worked out directly with the project owner in conversation, not through a persona review round; treat them as settled, not open.

**Prerequisite reading, in order:** `CLAUDE.md` → `PLAN.md` → `plans/phase-21-review.md` (§2's original "scenes stay out of the graph" reasoning — §26.G below explicitly revisits and reaffirms this) → `plans/phase-22-tasks.md` → `plans/phase-23-tasks.md` → `plans/phase-25-review.md`/`plans/phase-25-tasks.md` → this file → `.claude/skills/gm-tools-conventions/SKILL.md` → `.claude/skills/gm-tools-verification/SKILL.md`.

**Scope:** touches both the construction/prep view (`session-planner-view.js`'s chain display, Phase 23) and Table Mode (same file, Phase 25) — several of these fixes apply to both since they share rendering functions and both were independently reported to have the same problems. New engine work is real but small and reuses existing, already-hardened machinery wherever possible (see §26.D/§26.E below) — this is not a repeat of Phase 22's scale.

---

## Grounding — decisions settled in conversation, confirmed against real code

### §26.A — Scene creation always requires a place; linking is offered either way

Today, `POST /api/session-planner/scenes` accepts an optional `locationEntityId` — quick-gen (task 22.6/25.7) calls it with NONE at all, producing a genuinely untethered scene with no anchor. **This was found to be a real bug, not a documented feature.** Going forward: every path that creates a scene must supply a place — either pick an *existing* place entity (reuse `buildEntityPicker`) or create a *new* one inline.

When the place is new (or even when it's existing and not yet graph-adjacent to a relevant other place), **separately offer a link/no-link choice** — the project owner's own words: *"if I'm just considering this to be a 'hop' and the two locations are pretty far apart, then I don't want to link them, and we might just hand wave travel. If, however, they are close... then we can link them and optionally note the rough distance."* Confirmed: this offer applies **whether the place was newly created or picked from existing** — not just the new-place case.

This needs **zero new engine work** — confirmed directly by reading the code: `wf-mcp-server/lib/manual-edit-ops.mjs`'s `addNodeOp` (create the place) and `addEdgeOp` (create the link) both already exist, are both already live HTTP routes (`review-ui/server.mjs` ~line 1091/1100), and `addEdgeOp`'s existing `label`/`notes` fields already accommodate a "rough distance" note (`graph-service.mjs`'s `upsertEdge`: `label`, `notes` both already on the allowlist). This is pure UI composition over two already-shipped primitives, not a new "anchor-linking primitive" (an earlier framing of this task that the project owner explicitly corrected — there is no special relationship between "the current scene's anchor" and this mechanism beyond it being the natural default link target when the flow is triggered from within a scene).

### §26.B — "+Scene" replaces "+ Insert Scene Here"

The existing `insert-scene-control`/`insert-scene-picker` (Phase 23 task 23.3, `buildInsertSceneControl`, ~line 1298 of `session-planner-view.js`) lets a DM insert a new scene between two arbitrary existing chain positions regardless of whether those scenes' anchors are actually graph-connected — confirmed to be the direct cause of the reported confusion ("are all the nodes you listed with + add scene here between them actually adjacent? ... Wouldn't it be adding a location?"). **Remove this mechanism entirely** (both its construction-view instance and anything equivalent already built in Table Mode). Replace with a single **"+Scene"** action living at the bottom of every scene's own box/card (both views), which runs §26.A's place-required-plus-optional-link flow, then optionally §26.C's scene-link creation.

### §26.C — Scene-to-scene linking: a dedicated store, NOT graph entities ("Path B")

The project owner explicitly proposed making scenes real World Fabric graph entities, linked via real edges to their member nodes. **Considered and explicitly rejected in favor of a smaller alternative**, for reasons worth restating since they reopen (and reaffirm) `plans/phase-21-review.md` §2's original decision:

- Scenes get forked, rolled back, and discarded (`mutation-engine/scene-undo.mjs`) in ways real graph entities aren't built for.
- A new "scene" entity type would hit the exact type-enum-duplicated-across-4-files risk that made "transit" avoid a new type (`plans/phase-21-review.md` §12) — mitigable the same way (`type:X` + `attributes.isScene`), but avoidable entirely by not going this route.

**Adopted instead:** a new, dedicated store — `session-planner/scene-links.mjs`, sibling to `scene-membership.mjs`/`scene-linkage.mjs`'s existing per-world flat-JSON pattern — recording explicit `{sceneId, linkedSceneId, reason?}` records, entirely outside the WF graph. Two scenes become linked whenever "+Scene" or "link to an existing scene" is used **from within** a scene, *regardless of whether their underlying places got graph-linked* — the project owner's own reasoning: *"even if the place doesn't get linked-on-creation, the scenes are linked because they are tied together in a plan... the DM should get value out of being able to quickly navigate related scenes."* Bidirectional for query purposes (linking A→B means both "scenes linked to A" and "scenes linked to B" surface it), but store as a single record per link (not two), matching `scene-membership.mjs`'s own economical convention.

### §26.D — Plan store: a named, reusable, many-to-many collection of scenes

New `session-planner/plans.mjs`, same per-world flat-JSON convention as every sibling store in this directory. A Plan is `{id, name, sceneIds: []}` — **a scene's id can appear in any number of Plans** (many-to-many, no back-reference stored on the Scene record itself; the project owner's own framing: *"like a linked list? Or list of pointers"*). Real example that must work: a "key events" Plan holds recurring story-arc scenes; a session-specific Plan can pull in one of those same scenes by reference, without duplicating it, and a forked-but-unused scene path from one Plan can be added to a different, future Plan later.

Within a Plan, "next scene" candidates are discovered by composing what already exists: `session-planner/scene-linkage.mjs`'s `linkedScenesForScene` (graph-hop-distance-based) for physically-adjacent options, plus §26.C's new scene-link store for explicitly-linked-but-not-necessarily-adjacent options — both surfaced together, not one replacing the other.

### §26.E — Post-session graph update from scene notes: reuse `importWriteup`, don't reinvent it

The project owner's own proposed shape: after a session, take the collected scene notes (Add Event notes, already scene-scoped via `session-notes.mjs`'s existing `sceneId` field) plus their associated scenes' context, run one LLM call proposing graph updates, and route it through the **existing** DM review/accept/reject workflow — *"that way, scenes aren't tied directly to the graph, but they do impact the graph where appropriate."*

Confirmed directly: `graph-import/writeup-import.mjs`'s `importWriteup(world, text, existingSnapshot, opts)` already does exactly this shape end to end (LLM extraction → dry-run merge/dedup via `interchange.mjs`'s `importGraph` → a normal `review-state.mjs` batch, full accept/reject/regenerate). It's already live over HTTP as `POST /api/writeup-propose { world, dataDir, text, mode }` (`review-ui/server.mjs` ~line 1251). **This task is a thin composition, not new LLM plumbing**: assemble a Plan's (or an explicit scene-id set's) notes into writeup-shaped text — grouped by scene, each scene's notes prefixed with its name and anchor-location name for grounding — and call the existing route. No new engine module beyond the text-assembly step and its own thin server route (`POST /api/scene-planning/plans/:planId/propose-updates` or similar, resolving the Plan's scenes' notes and delegating straight to `importWriteup`/`/api/writeup-propose`'s existing logic — do not duplicate that logic, call it).

### §26.F — "Drop this into Foundry" replaces the `playerKnown` reveal gate

Confirmed via direct code reading that `buildPlayerKnownGate` (`session-planner-view.js` ~line 2002, "Reveal player-known status…") is a pure read-only status display with no real action behind it — the project owner's own assessment: *"I don't care if I know that they know about some element or not... nor do I know how this ... would even know to tell me this information."* Replace it with a genuine action: pushing an entity's description text into the live Foundry chat, gated behind a real confirm.

**Not a big feature** — confirmed by reading the actual existing mechanism at `foundry_worldFabric/gm/gm-say.mjs`: a small script that launches headless Chromium, logs into the local Foundry instance (`http://localhost:30000`) as the Gamemaster user, and calls Foundry's own `ChatMessage.create({content, speaker, type})` directly in-page. No entity docs, no `foundryRef` write-back, no sync/bridge machinery — this project already floated a much bigger "Graph Push to Foundry" feature (`PLAN.md`'s Tool 1, explicitly never built, filed as a separate feature request) and that is explicitly **not** what this task is — don't build that.

Two deliberate, flagged deviations, not oversights:
- `playwright` is currently a **devDependency only** in `review-ui` (Phase 15's explicit "never imported by server.mjs or any runtime code path" constraint). This task promotes it to a real runtime dependency — state this explicitly in the commit, don't slide it in silently.
- Launching headless Chromium + logging in takes real seconds, not milliseconds — this gets the same loading-affordance treatment (`withSlowNotice`-style) as this app's other genuinely slow actions (develop-scene, quick-gen), not a bare instant button.

### §26.G — Drop tags from the roster detail expand

The project owner's own assessment: *"the tags are relatively meaningless... I'm going to let an LLM deal with the tags."* Remove `tags` from `buildTableRosterDetail`'s rendered fields (Table Mode's member-roster nested expand, `session-planner-view.js` ~line 1988 area) — `description`/`summary`/`imageUrl` stay, `tags` doesn't. Leave the underlying `graphNodePayload`/entity data untouched (still fetched, just not rendered here) — this is a display change, not a data-removal.

### §26.H — Two bugs to live-reproduce, not guess-fix

1. **Table Mode's "All scenes" `<details>` won't re-collapse.** Reported repro: open the full scene list, jump to a scene via a list item, the disclosure stays open when it shouldn't (or doesn't behave as a real open/close toggle). Static reading didn't find an obvious cause (the element is native `<details>`, freshly rebuilt on every `loadAndRenderTableMode` call via `container.innerHTML = ""`) — the leading hypothesis is either stale DOM surviving a render that should have cleared it, or the same "idempotent-open, not a strict toggle" pattern Phase 24's Scenes tab deliberately adopted (`scenes-view.js`) resurfacing here unintentionally. **Confirm the actual root cause via a real running instance before fixing it** — don't patch based on the hypothesis alone.
2. **Tripled "Add Event" panel, first instance showing truncated/garbled text.** No obvious duplicate-render call site was found by reading `buildTableActionsBar`/`mountAddEventControl` statically (only one call site exists, `openNotePanels` keying looks correct). Leading hypothesis: stale DOM from a render that didn't fully clear, possibly related to bug #1's same root cause. **Reproduce directly, don't guess-patch.**

---

## Task list

### 26.0 — QE e2e test-authoring pass (runs first, standalone)
**Files:** new `review-ui/test/e2e/plans-*.e2e.mjs`, `review-ui/test/e2e/table-mode-v2-*.e2e.mjs` (or extend existing `table-mode-*.e2e.mjs` files where a scenario is a genuine extension of prior coverage, not a new concern — use judgment, but keep one-scenario-group-per-file as the default per this project's established convention)

Define and test, contract-first, against DOM selectors/routes that don't exist yet:
1. Scene creation (both construction view and Table Mode) requires a place; picking existing vs. creating new both work; link/no-link offered in both cases; a rough-distance note on a created link round-trips through the real `addEdgeOp` route.
2. Quick-gen no longer produces an untethered scene — it goes through the same place-required flow, asserted against the real created scene's `locationEntityId`.
3. "+Scene" renders at the bottom of every scene box in both views; `insert-scene-control`/`insert-scene-picker` no longer exist anywhere in either view (a real DOM-absence assertion, not just "not tested").
4. "Beyond this path" no longer renders (`beyond-corridor-summary` DOM-absence); its former space now hosts connect-existing-scene / create-ad-hoc-scene actions.
5. Scene-link store round-trip: linking two scenes via "+Scene"/an explicit "link to existing scene" action persists a real record (assert via the store's own routes, not just UI state) and survives even when the underlying places were explicitly NOT graph-linked.
6. Plan CRUD round-trips through real routes: create a Plan, add/remove a scene (the SAME scene added to two different Plans, asserting both memberships persist independently), list Plans for a world.
7. Table Mode is Plan-scoped: "Start new plan" / active Plan's scenes (current expanded, rest collapsed) / other Plans (collapsed) — replaces the old flat "all scenes" list contract from `table-mode-navigation.e2e.mjs`/`table-mode-search.e2e.mjs` (update or replace those files' now-stale assumptions rather than leaving contradictory frozen contracts).
8. Post-session graph-update: seed scene notes across 2+ scenes in a Plan, trigger the propose-updates action, assert it produces a real review-state batch reachable through the existing Batch Review screen (mocked LLM call, matching this project's established convention).
9. "Drop this into Foundry" renders in place of the old `playerKnown` gate, gated behind a real confirm step, shows a loading state during the (mocked) push, and the old `player-known-gate`/`Reveal player-known status` DOM is gone entirely.
10. Tags are absent from the roster detail expand DOM (not just visually hidden).
11. The two live-repro bugs (§26.H): write tests that would catch each once its real root cause is understood — coordinate with whoever picks up 26.10 below, since the exact assertion shape depends on the confirmed root cause, not the hypothesis. If the root cause isn't confirmed before this task needs to complete, write the test asserting the CORRECT end-state behavior (re-collapses; exactly one Add Event panel with correct full text) even before the fix exists — that's the normal red-before-green case, not a blocker.

**Acceptance criteria:** every new/changed test fails against the current UI with a clear selector-not-found/timeout/DOM-presence error; the full existing suite (root, `wf-mcp-server`, `review-ui` deterministic, all currently-passing e2e) stays green except for files this task deliberately updates because their old contract is now stale (state exactly which and why in the commit).

---

### 26.1 — Plan store
**Files:** new `session-planner/plans.mjs`, routes in `review-ui/server.mjs`

Per §26.D. `createPlan(world, {name})`, `addSceneToPlan(world, planId, sceneId)`, `removeSceneFromPlan(world, planId, sceneId)`, `listPlansForWorld(world)`, `getPlan(world, planId)`. Routes under `/api/scene-planning/plans/*`, matching this file's established prefix/style.

**Acceptance criteria:** 26.0's Plan-CRUD test passes.

---

### 26.2 — Scene naming
**Files:** `session-planner/scenes.mjs`, `review-ui/server.mjs` (scene create/update routes), `review-ui/public/session-planner-view.js` (`resolveSceneDisplayName` and every render site that currently falls back to anchor-name-only)

Add optional `name` to the Scene shape; user-editable; display falls back to anchor-location name when unset. This is what makes two scenes at Grand Stadium distinguishable.

**Acceptance criteria:** creating/renaming a scene with a bespoke name persists and displays correctly in both views.

---

### 26.3 — Scene-link store
**Files:** new `session-planner/scene-links.mjs`, routes in `review-ui/server.mjs`

Per §26.C. `linkScenes(world, sceneIdA, sceneIdB, reason?)`, `unlinkScenes(...)`, `getLinkedScenes(world, sceneId)` (bidirectional query over single-direction-stored records).

**Acceptance criteria:** 26.0's scene-link round-trip test passes, including the "linked despite unlinked places" case.

---

### 26.4 — Place-required scene creation, link-or-not either way
**Files:** `review-ui/public/session-planner-view.js` (both views), reuses existing `addNodeOp`/`addEdgeOp` routes directly, no new engine code per §26.A

New shared UI flow: pick-existing-or-create-new place, then offer link/no-link (with optional distance/relationship note going into the real edge's `label`/`notes`), used everywhere a scene needs a place (§26.5/26.6/26.8 all depend on this).

**Acceptance criteria:** 26.0's place-required-creation test passes for both new and existing places, both linked and unlinked.

---

### 26.5 — Quick-gen uses 26.4's flow
**Files:** `review-ui/public/session-planner-view.js` (`buildTableQuickGenControl` and its construction-view equivalent if one exists)

Quick-gen's scene-creation step goes through 26.4 instead of omitting `locationEntityId` entirely.

**Acceptance criteria:** 26.0's quick-gen test passes — no more untethered scenes.

---

### 26.6 — "+Scene" replaces "+ Insert Scene Here"
**Files:** `review-ui/public/session-planner-view.js` (both views)

Per §26.B. Remove `buildInsertSceneControl`/`insert-scene-control`/`insert-scene-picker` entirely (construction view) and any equivalent already built in Table Mode. Add a "+Scene" action to the bottom of every scene box (both views), running 26.4's flow, then optionally 26.3's scene-link creation when triggered from within an existing scene.

**Acceptance criteria:** 26.0's "+Scene renders, insert-scene-control is gone" test passes in both views.

---

### 26.7 — Remove "beyond this path"; repurpose the space
**Files:** `review-ui/public/session-planner-view.js` (`renderBeyondCorridorSummary` and its call site ~line 1541)

Per §26.B. Remove the collapsed content/structural-count summary entirely. Its former space now hosts: connect-to-an-existing-scene (surfacing both `scene-linkage.mjs`'s hop-based candidates and §26.3's explicitly-linked scenes) and create-ad-hoc-scene (26.6's "+Scene") as quick, visible options — not buried behind a `<details>`.

**Acceptance criteria:** 26.0's beyond-corridor-removal test passes; the connect-existing/create-ad-hoc actions are reachable from the repurposed space.

---

### 26.8 — Plan-scoped Table Mode
**Files:** `review-ui/public/session-planner-view.js`

Per §26.D. Replace the flat "all scenes" list with: "Start new plan" / active Plan's scenes (current one expanded, rest collapsed) / other Plans (collapsed, their own scenes revealed on expand). Update or intentionally replace `table-mode-navigation.e2e.mjs`/`table-mode-search.e2e.mjs`'s now-superseded assumptions (flag this explicitly in the commit, don't silently leave contradictory frozen tests).

**Acceptance criteria:** 26.0's Plan-scoped Table Mode test passes.

---

### 26.9 — Post-session graph update from scene notes
**Files:** new thin composition function (co-locate with `session-planner/plans.mjs` or a new small module, builder's judgment), one new route in `review-ui/server.mjs` delegating to the existing `/api/writeup-propose`/`importWriteup` logic (no duplication), a UI trigger (e.g., a "Propose graph updates from this plan's notes" action on the Plan view)

Per §26.E. Assemble a Plan's scenes' notes into writeup-shaped text (grouped by scene, each group prefixed with scene name + anchor location name for grounding), call the existing writeup-import pipeline, land in the existing Batch Review screen.

**Acceptance criteria:** 26.0's post-session graph-update test passes; confirm by reading `graph-import/writeup-import.mjs`/the `/api/writeup-propose` route fresh that this task calls that logic rather than reimplementing any part of it.

---

### 26.10 — "Drop this into Foundry" replaces the `playerKnown` gate
**Files:** `review-ui/public/session-planner-view.js` (`buildPlayerKnownGate` and its call site), new route in `review-ui/server.mjs`, `review-ui/package.json` (promote `playwright` to a real dependency — flag this explicitly)

Per §26.F. New route wrapping a reusable version of `foundry_worldFabric/gm/gm-say.mjs`'s logic (headless Chromium login + `ChatMessage.create`), triggered by a real confirm step, with a loading affordance during the (real, multi-second) push. Remove `buildPlayerKnownGate` entirely.

**Acceptance criteria:** 26.0's Foundry-push test passes (mocked at the route boundary, matching this project's established LLM/slow-call test convention); confirm the old `playerKnown`-reveal DOM is gone.

---

### 26.11 — Drop tags from roster detail
**Files:** `review-ui/public/session-planner-view.js` (`buildTableRosterDetail`)

Per §26.G. Remove tags rendering only — data fetch untouched.

**Acceptance criteria:** 26.0's tags-absent test passes.

---

### 26.12 — Live-repro and fix the two Table Mode bugs
**Files:** `review-ui/public/session-planner-view.js`, TBD pending root cause

Per §26.H. Drive a real running instance to confirm the actual root cause of both bugs before fixing either — do not patch based on the hypotheses in §26.H alone. Document the confirmed root cause in the commit message, matching this project's established discipline (see Phase 23's `insert-between`/`loading-scope` root-causing as the model to follow).

**Acceptance criteria:** 26.0's corresponding tests (or tests written fresh once the root cause is confirmed, if 26.0 couldn't pin the exact assertion shape in advance) pass.

---

## How to work

- Task 26.0 must fully complete, commit, and be confirmed red before 26.1 starts.
- 26.1–26.3 (the three new stores) have no UI dependency on each other and can be built in any order, but should land before 26.4 onward since the UI tasks consume them.
- 26.4 is a shared dependency for 26.5/26.6 — build it once, don't duplicate the place-required-creation flow.
- Ground every implementation detail in the actual current code — re-locate exact lines/routes/selectors fresh, per `gm-tools-verification`'s own standing guidance.
- Commit after each completed task, clean incremental history. Stage files explicitly, never `git add -A`.
- No `foundry_worldFabric` changes anywhere in this phase, **except** reading (never modifying) `gm/gm-say.mjs` as a reference for 26.10 — confirm `git -C /opt/dev/foundry_worldFabric status --short` unchanged before and after every task regardless.
- Self-review remediation pass at the end: run the full test suite (exact commands from `gm-tools-verification`), re-confirm both live-repro'd bugs stay fixed, re-confirm no `insert-scene-control`/`beyond-corridor-summary`/tags/`playerKnown`-gate DOM survives anywhere, take real desktop + tablet + phone screenshots of the new Plan-scoped Table Mode and the "+Scene" flow.

## Definition of done for Phase 26

- [ ] 26.0's Playwright tests committed, confirmed red before any implementation exists.
- [ ] Plan store (26.1), scene naming (26.2), scene-link store (26.3).
- [ ] Place-required scene creation with link-or-not either way (26.4), quick-gen using it (26.5).
- [ ] "+Scene" replacing "+ Insert Scene Here" everywhere (26.6).
- [ ] "Beyond this path" removed, space repurposed (26.7).
- [ ] Plan-scoped Table Mode (26.8).
- [ ] Post-session graph update from scene notes, reusing `importWriteup` (26.9).
- [ ] "Drop this into Foundry" replacing the `playerKnown` gate (26.10).
- [ ] Tags removed from roster detail (26.11).
- [ ] Both live-repro'd bugs confirmed root-caused and fixed (26.12).
- [ ] Full existing test suite (root + `wf-mcp-server` + `review-ui` deterministic + all e2e) passes, with any deliberately-superseded test files explicitly flagged and updated, not left silently contradictory.
- [ ] `foundry_worldFabric` confirmed untouched throughout.
- [ ] Self-review remediation pass run and reported, including real screenshots.
