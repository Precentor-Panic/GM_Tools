# GM_Tools — Phase 28 Task Plan: Scrap-and-Rebuild the Plan-Construction UI

**Status:** approved, ready to execute. Design record (context, requirements, persona synthesis, full design): `/home/russell/.claude/plans/i-m-still-not-sure-compressed-pizza.md` — **read it first.** This file is the execution checklist.

**Prerequisite reading, in order:** `CLAUDE.md` → `PLAN.md` → the design record above → `.claude/skills/gm-tools-conventions/SKILL.md` → `.claude/skills/gm-tools-verification/SKILL.md` (+ `gm-tools-persona-review` if another review round is needed).

**Why:** post-Phase-27 hands-on use — "too busy, too many buttons, confused navigation." Root cause (confirmed): three competing renderers (`loadAndRenderChain`/`loadAndRenderPlan`/`loadAndRenderTableMode`) + scene↔scene linking + localStorage where-am-I guessing. Fix: one renderer, one navigation model, **URL as the single source of truth**, and a reframed **scene = one place + interactable elements** (adventure-module model) presented as **one edit-in-place page that reads like a printed module**.

## Settled decisions (do not relitigate — from Russell + the persona round)
- **One view, no modes.** The printed page IS the editor: transparent auto-grow `<textarea>` per value, invisible at rest, **click-to-edit** (not focus-to-edit), autosave via `createFlushableDebounce`; no Edit/Save buttons, no modals. Never full-re-render on keystroke.
- **Actions live ON the object**, not a top toolbar. Scene page top-right = only `Wrap ▸` + `…`.
- **Scene = one place + elements.** Elements KEY (graph node, glyph + accent rule + graph badge, full field-lines) vs MUNDANE (scene-local, hollow bullet, one shape-capped line). **New elements default to MUNDANE/scene-local**; promotion to graph is opt-in (per-element `⭑` AND batched in Wrap). Never classify importance at creation.
- **Minimal fields, show-only-if-filled.** Core always: **Trigger** + **Gives (payload)**. Optional (render only if present): Looks, Means, Checks (Skill+DC→purpose), Function; NPC adds Wants/Secret + collapsed stat block. Never render an empty box.
- **Deletes never auto-touch the graph.** Remove-from-plan (unlink, undo toast) ≠ Delete-scene (guarded, Scenes tab) ≠ Delete-plan (`deletePlan`) ≠ Delete-node-from-graph (explicit, guarded `deleteNodeOp`, warns if referenced).
- **Scenes shared-by-reference across plans** (`plans.mjs` `sceneIds[]`). Show THIS scene's narration only; shared-place plumbing stays backstage.
- **LLM additive/interruptible, never a gate**; functional-prep prompt (not verbose prose). Scene runnable with hand-typed elements + zero round-trips.
- **Keep `#session-planner/<sceneId>`** as the scene hash (Scenes tab + Encounter Builder return depend on it). New: `#plans`, `#plans/<planId>`.
- **No** drag-drop library, rich-text editor, per-keystroke sync, or modals for reversible actions. ↑↓ reorder baseline (native `draggable` optional).
- **"Drop into Foundry" (Phase 26 chat-push) stays OUT of the rebuild for now** (Russell's call, 2026-08-04). Its backend `foundry-push.mjs` survives untouched but gets NO UI on the new scene page (not even in the `…` overflow) — revisit in a later phase once construction feels right. Keeps 28.3 lean.

## Grounded reuse (already exists — confirmed in exploration)
`deleteNodeOp` + `DELETE /api/graph/nodes/:id` (guarded node delete, cascades edges + atomic undo, `wf-mcp-server/lib/manual-edit-ops.mjs:348`); `containment` relationship type (`foundry_worldFabric/scripts/constants.mjs`, default strength `tight`) via `addEdgeOp`; `addNodeOp({type:"place"})` (template `transit-entity.mjs`); `importWriteup` + review-batch pipeline (`graph-import/writeup-import.mjs`) with plan-scoped `assembleWriteupTextForPlan`/`proposeUpdatesForPlan` (`session-planner/plan-updates.mjs`); per-scene `SessionNote.sceneId` (`session-notes.mjs`); `saved-encounter.mjs` `sceneIds[]` attach/detach; `createFlushableDebounce` (`review-ui/public/debounced-save.mjs`); `buildEntityPicker`/`renderLocationCard` + `location-card*`/`place-required-flow` CSS + design tokens; `buildAmbientDigestEntry` (`session-planner/digest.mjs`); `prep-content.mjs` (candidate field vehicle for KEY nodes). `plans.mjs`/`scenes.mjs`/`scene-membership.mjs` reused.

---

## Tasks

### 28.0 — QE-first e2e contract (Sonnet)
Contract-first Playwright e2e in `review-ui/test/e2e/`, **confirmed red** before any implementation, documenting the new DOM/route contract (a `phase28-fixture.mjs` interface spec, mirroring `phase27-fixture.mjs`). Cover:
- **Navigation spine**: `#plans` list + New plan; `#plans/<planId>` scene rows (add/reorder/remove-from-plan + undo toast); open scene → `#session-planner/<sceneId>`; breadcrumb + prev/next.
- **Scene page**: place header + this-scene narration; element list KEY vs MUNDANE; **click-to-edit → autosave** (assert a value persists via the store route, and that focus alone does NOT enter edit); only-non-empty fields render.
- **Elements**: `+ add element` (defaults MUNDANE), per-element `⭑` promote (creates graph node + containment edge), demote (no node delete), hover-✕ remove + undo.
- **Wrap**: `Wrap ▸` panel proposes scene note-intake updates + element→graph promotions (mocked LLM), review-gated (proposes, no auto-write).
- **Deletes**: remove-from-plan (scene survives) vs delete-scene (guarded, place node survives) vs delete-plan; guarded node-delete warns if referenced.
- **Scenes tab**: "In plans:" chip row (replaces linked-scenes).
Update/retire stale existing e2e whose contract this phase changes (the Phase-23–27 construction/table-mode/scene-link e2e that target scrapped surfaces). **Acceptance:** every new test red for the right reason (missing route/DOM), orchestrator-confirmed; stale e2e updated, not deleted wholesale where an assertion still reflects intended behavior.

### 28.1 — Backend stores + routes (Sonnet)
- `session-planner/scene-elements.mjs` — per-scene ordered elements `{id, sceneId, kind:'local'|'graph', graphEntityId?, name, fields:{trigger?,gives?,looks?,means?,checks?,function?,wants?,secret?,statblockRef?}, order}`; ops create/list(byScene)/update/remove/reorder/promote/demote; `SCHEMA_VERSION`. Promote = `addNodeOp` + `addEdgeOp({relationshipType:"containment"})` to the scene's place, set `kind:'graph'`+`graphEntityId`; demote clears kind, **never** deletes the node. + routes under `/api/scene-planning/scenes/:sceneId/elements*`.
- `session-planner/scene-narration.mjs` — `sceneId`-keyed history/supersede store mirroring `entity-narration.mjs`; get/save/supersede/history + routes.
- `session-planner/plan-updates.mjs`: add `assembleWriteupTextForScene(world, sceneId, names)` + `proposeUpdatesForScene(dir, world, sceneId, opts)` (mirror the plan versions; zero change to `importWriteup`) + route.
- `deletePlan(world, planId)` in `plans.mjs` + `DELETE /api/scene-planning/plans/:planId`; `plansContainingScene(world, sceneId)` + `GET /api/scene-planning/scenes/:sceneId/plans`.
- Remove `scene-links.mjs` + its routes + `deleteScene`'s scene-link cascade import.
- **Acceptance:** deterministic unit tests for every new store/op before done (per conventions); route wrappers thin; 28.0 route-level tests green; root + wf-mcp-server suites pass.

### 28.2 — Navigation spine + `mountEditableList` (Sonnet; depends 28.1)
`review-ui/public/` new/rebuilt views: `#plans` (plan shelf) and `#plans/<planId>` (scene-row runsheet), wired in `app.js` (`parseHash`/dispatch). One reusable `mountEditableList` helper (ghost-row add, hover-✕ remove + undo toast, ↑↓ reorder, click-to-open) instantiated for plan-scene-rows and, later, element-rows. **Rip out** the localStorage where-am-I heuristics (`resolveActivePlan`/`loadActivePlanId`/`loadLastSceneId`) and the old renderers/routes for the scrapped surfaces. Keep `#session-planner/<sceneId>` valid (route it to the new scene page in 28.3). **Acceptance:** 28.0 spine tests green; URL is the sole source of location; Encounter-Builder return + Scenes-tab open still resolve.

### 28.3 — The Scene page (Opus; depends 28.1, 28.2) — the hardest task
The single edit-in-place page at `#session-planner/<sceneId>`: place header (name click-to-edit) + this-scene narration (serif read-aloud, autosave) + element list (KEY/MUNDANE field-lines, transparent-textarea inline edit via `createFlushableDebounce`, click-to-edit, only-non-empty fields, never full-re-render); `+ add element` (default MUNDANE) + per-element `⭑`/hover-✕; inline events/encounters/notes (reuse `saved-encounter` attach + open-builder, `SessionNote`); disclosure only for stat blocks / narration history / a bottom "beyond this room" drawer. Breadcrumb + prev/next + `[`/`]`/`Esc`. **Acceptance:** 28.0 scene-page + element tests green; resting state has no visible edit chrome; autosave persists; a scene renders/edits with zero LLM calls.

### 28.4 — Wrap + LLM assist (Opus; depends 28.1, 28.3)
`Wrap ▸` slide-down: scene-scoped note-intake proposals (`proposeUpdatesForScene`) + element→graph promotion proposals (pre-selected/skimmable/reject-easy), all review-gated. Inline `✦` ghost links (propose elements / draft fields) — additive, interruptible. **Rewrite the LLM prompt instructions** to concise functional prep (Looks/Means/Checks/Gives/Function/Trigger) grounded in good one-page-dungeon/module craft; de-prioritize verbose prose. **Acceptance:** 28.0 wrap tests green (mocked LLM); proposes-never-auto-writes; scene runnable without any LLM call.

### 28.5 — Scenes tab tweak + deletes + scrap (Sonnet; depends 28.1, 28.2)
`scenes-view.js`: "linked scenes" panel → read-only **"In plans:"** chip row (`plansContainingScene`). Two delete verbs + guarded node-delete + undo toasts wired. **Scrap**: Table Mode + construction chain + scene-link UI code and their `table-*`/scene-link CSS; retire the now-dead app.js nav-cancel hooks for removed features. **Acceptance:** 28.0 scenes-tab + delete tests green; no dead references to scrapped surfaces (grep-clean); pre-existing Scenes-tab/graph/encounter e2e still green.

### 28.6 — Printed-page design pass + responsive (Sonnet or orchestrator; depends 28.3)
Author/apply a `gm-tools-frontend`-style pass on the scene page + spine: typography/hierarchy for the printed-module aesthetic, the `.pf-line` field-line component, KEY/MUNDANE weights, responsive (scale, no reflow), light/dark tokens. **Acceptance:** real screenshots desktop/tablet/phone; resting state reads like a page, not a form.

## Dependency / tiering summary
| Task | Scope | Tier | Deps |
|---|---|---|---|
| 28.0 QE e2e contract | `test/e2e/` | Sonnet | — |
| 28.1 stores + routes | `session-planner/*`, `server.mjs` | Sonnet | 28.0 |
| 28.2 navigation spine + `mountEditableList` | `public/*`, `app.js` | Sonnet | 28.1 |
| 28.3 **the Scene page** | `public/*` | **Opus** | 28.1, 28.2 |
| 28.4 Wrap + LLM assist + prompt rewrite | `public/*`, `plan-updates.mjs`, prompts | **Opus** | 28.1, 28.3 |
| 28.5 Scenes-tab + deletes + scrap | `scenes-view.js`, `public/*`, CSS | Sonnet | 28.1, 28.2 |
| 28.6 design/CSS pass + responsive | `style.css`, `.claude/skills/` | Sonnet/orch | 28.3 |

## Verification (per `.claude/skills/gm-tools-verification`)
`node` at `/home/russell/.local/node/bin`. Orchestrator independently re-runs root + `wf-mcp-server` + `review-ui` deterministic + full e2e after each wave; known pre-existing failures accounted for (`snowball-delta`; the 2 `scene-construction-add-node` corridor defects — but note many old construction/table-mode e2e are being retired here, so the baseline shifts). `foundry_worldFabric` confirmed untouched. Final gate: **Russell's hands-on browser pass.**
