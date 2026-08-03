# GM_Tools — Phase 27 Task Plan: Plan-First Session-Planner Rework + UI Remediation

**Status:** ready to execute. Straight from real hands-on feedback (post-Phase-26 manual testing of the construction/session-planner view), no persona round — project owner's explicit choice, matching Phase 13/14/20/26 precedent. Grounding and decisions below were settled directly with the project owner and are captured durably in the design record `../.claude/plans/let-s-pull-up-the-warm-catmull.md` (feedback F1–F13, community-skills evaluation, resolved Decisions 1–3). Treat them as settled, not open.

**Prerequisite reading, in order:** `CLAUDE.md` → `PLAN.md` → `../.claude/plans/let-s-pull-up-the-warm-catmull.md` (the design record — F1–F13 + decisions) → `plans/phase-22-tasks.md` → `plans/phase-23-tasks.md` → `plans/phase-25-tasks.md` → `plans/phase-26-tasks.md` → this file → `.claude/skills/gm-tools-conventions/SKILL.md` → `.claude/skills/gm-tools-verification/SKILL.md`.

**Scope:** the bulk is the construction/session-planner view (`review-ui/public/session-planner-view.js`, 3189 lines) plus three small, well-specified store/route additions. Table Mode (Phase 25/26, same file) is **already Plan-scoped** (task 26.8) — this phase brings the *construction* view to plan-first parity, the view Russell reported as "arguably worse than the Scenes-tab scene viewer." New engine work is real but small; the hard task is the UI restructure (27.4), assigned to opus.

**Grounding — line numbers/functions confirmed against current code (they had NOT drifted meaningfully from the design record):**
- `session-planner/scenes.mjs`: exports `createScene`/`forkScene`/`getScene`/`renameScene`/`listScenesForWorld` (no delete). Scene CRUD routes live under the `/api/session-planner/scenes` prefix (`review-ui/server.mjs` ~1415–1438).
- `session-planner/scene-links.mjs`: `linkScenes(world, a, b, reason=null)` (~72), `unlinkScenes` (~96), `getLinkedScenes` (~113). No `graphEdgeId` field today. Routes under `/api/scene-planning/scene-links` (`server.mjs` ~1912–1935).
- `combat-planning/saved-encounter.mjs`: `readEncounters(world)` (~63, **not exported**), `listEncountersForScene`/`saveEncounter`/`getSavedEncounter`/`removeSavedEncounter` exported. Scene-scoped encounters routes at `/api/scene-planning/scenes/:sceneId/encounters` (`server.mjs` ~1836/1849/1856).
- `session-planner-view.js`: `resolveActivePlan` (179), `buildConnectExistingSceneZone` (713) — the green auto-link zone, `buildAddSceneControl` (1741), `buildPlaceRequiredFlow` (1558), `mountAddEncounterControl` (1174) — currently navigates straight to the builder, `mountAddNodeControl`/`mountAddEventControl` (1085/1127), `onDevelopScene` (1385) — builds `memberIds` from `extras.brief.locations` + `addedMembership`, `resolveSceneDisplayName` (1816), `buildSceneBodyInto` (1915) — the per-scene actions bar (`actionsBar.append(addNodeToggle, developSceneBtn, addEventBtn, addEncounterBtn, addSceneBtn)`, 1972), `buildChainItem` (1986), `renderBootstrap` (844), `loadAndRenderChain` (2071), `renderSessionPlanner` (3124). The `+ Quick add scene` control (`quick-add-scene-*`, ~1443) still exists. The two LLM-generated-name bug sites are `objectiveNote: \`${name} — ${genRes.text}\`` at **1512** and **2980**.
- `plans.mjs`: `createPlan`/`getPlan`/`listPlansForWorld`/`addSceneToPlan`/`removeSceneFromPlan`. Plan is `{id, name, sceneIds:[]}`, many-to-many. Routes under `/api/scene-planning/plans` (`server.mjs` ~1870+).

---

## Execution model (Decision 3)

Opus orchestrates design + independent verification. Sonnet agents do the QE-first contract pass and the bulk implementation; opus does the one hard restructure (27.4). Haiku is *flagged advisory* on 27.2/27.9 — if splitting them out adds more coordination than it saves, they fold into a sonnet pass (see the honest note in the design record). Commit per task. QE-first: 27.0 authors the e2e contract, confirmed red, before any implementation.

## Rhythm & verification (per `.claude/skills/gm-tools-verification`)

`node` at `/home/russell/.local/node/bin` (prefix every command: `export PATH="/home/russell/.local/node/bin:$PATH"`). Run the exact per-package scripts (root / `wf-mcp-server` / `review-ui` deterministic / `review-ui` e2e `npm run test:e2e`). Known-pre-existing failures to expect: root `snowball-delta.test.mjs` (60/61); e2e's 3 Phase-23 fixture defects (`scene-construction-add-node`, `scene-construction-loading-scope`). Confirm `foundry_worldFabric` stays at its documented baseline (`package.json` + `cockpit-app.mjs` modified, `setup-test.mjs` + `test/e2e-m13a.mjs` untracked) before and after. Independent re-run of every suite by the orchestrator, not trust in agent reports. Then a real hands-on browser pass by Russell.

---

## Tasks

### 27.0 — QE-first e2e contract (Sonnet)

Author contract-first Playwright e2e tests against the not-yet-built DOM/routes, **confirmed red** before any implementation. Update existing e2e files where the Phase-27 contract changes their assumptions. New/updated coverage:

- **Scene delete** (F1): a delete affordance on a scene removes the scene record, its plan memberships, and its scene-links; the place entity survives. New file, e.g. `scene-delete.e2e.mjs`.
- **Plan-first navigation** (F3): opening an existing plan shows that plan's scenes; a new/empty plan renders a screen whose only construction action is "+Add scene"; adding scenes attaches them to the active plan. New file, e.g. `plan-first-navigation.e2e.mjs`. Reconcile with `session-planner-resume-persistence`, `session-planner-flush-on-navigate`, `scene-construction-chain-display` where the entry path changes.
- **Plan-scoped link/unlink with graph push/break** (F4, F12): a scene shows the *other scenes in the active plan*, each with an explicit link/unlink toggle; link offers a graph push (`addEdgeOp`) and unlink offers a graph break (`deleteEdgeOp`) targeting the stored `graphEdgeId`. New file, e.g. `plan-scoped-scene-links.e2e.mjs`. Update `scene-links-roundtrip.e2e.mjs` and retire/replace the green auto-link assertions in `beyond-path-removed.e2e.mjs`/`add-scene-control.e2e.mjs` where they assert the old `buildConnectExistingSceneZone` behavior.
- **Encounter-link picker** (F11): add-encounter offers a picker over the world's saved encounters (`GET /api/scene-planning/encounters?world=`) plus an "open builder" button; picking one **attaches the same shared definition** (via `.../encounters/:encounterId/attach`) so it appears in both the origin and current scene's roster — assert the shared-reference behavior, not a copy; roster remove **detaches** without deleting the definition. New file, e.g. `encounter-link-picker.e2e.mjs`.
- **Develop-only-undeveloped** (F9): develop-scene exposes an "only undeveloped nodes" option that filters the member set client-side by `contentFlag.flagged` before the existing develop call. Extend `scene-construction-develop.e2e.mjs` or a new sibling.
- **Naming fix** (F2): a newly-created scene with no bespoke name shows the *place name*, never LLM-generated text. New/updated assertion (touches `scene-construction-quick-gen.e2e.mjs`).
- **+Scene at plan level, quick-add removed** (F5, F6): assert `quick-add-scene-*` testids are gone and the per-scene actions bar is `add-node / develop-scene / add-event / add-encounter` (no add-scene at per-scene level once it moves to plan level).

**Acceptance:** every new/updated test is red for the right reason (missing route/DOM, not a test bug), and the orchestrator independently confirms the red before implementation dispatches. Stale existing e2e updated, not deleted wholesale — preserve every assertion that still reflects true intended behavior.

### 27.1 — `deleteScene` + cascade + DELETE route (F1) — Sonnet

`deleteScene(world, sceneId)` in `session-planner/scenes.mjs` (sibling to the existing CRUD, same per-world flat-JSON + `ConcurrentWriteError` convention). Cascade: remove the scene record, its plan memberships (via `plans.mjs` — iterate `listPlansForWorld` × `removeSceneFromPlan`), and its scene-links (via `scene-links.mjs` — `getLinkedScenes` then `unlinkScenes` each pair, or a new `removeAllLinksForScene` helper). **Does NOT** delete the place entity or any graph edges (Decision 2). Add `DELETE /api/session-planner/scenes/:sceneId` (world via body or query, matching the members/plans DELETE convention). Thin route wrapper only, no logic in `server.mjs`.

**Acceptance:** unit test for the cascade (scene gone, plan memberships gone, scene-links gone, place entity untouched) before done, per gm-tools-conventions; DELETE route wired; 27.0's scene-delete e2e green.

### 27.2 — encounters become **shared, multi-scene definitions** + `listEncountersForWorld` + routes (F11 backend) — Sonnet

**Data-model decision (project owner, this session): a saved encounter is a shared reference, not a per-scene copy.** Picking an already-built encounter for another scene must attach the *same definition*, not mint a duplicate snapshot. This makes the scene↔encounter relation many-to-many, mirroring Phase 26's plan↔scene precedent (`plans.mjs` stores `sceneIds[]`).

In `combat-planning/saved-encounter.mjs`:
- **Encounter record gains `sceneIds: []`** in place of the single `sceneId`. Add/export a `SCHEMA_VERSION` and **normalize legacy records on read** (a record with the old `sceneId` reads as `sceneIds: [sceneId]`) — no hard migration, per the project's schema-versioning discipline. `saveEncounter(world, sceneId, {...})` keeps its signature and creates with `sceneIds: [sceneId]` (the origin scene).
- **`listEncountersForScene(world, sceneId)`** → filter by membership (`(e.sceneIds ?? [e.sceneId]).includes(sceneId)`).
- **New ops:** `attachEncounterToScene(world, encounterId, sceneId)` (idempotent add to `sceneIds`) and `detachEncounterFromScene(world, encounterId, sceneId)` (idempotent remove). `export function listEncountersForWorld(world)` returns every definition once (each record appears a single time regardless of how many scenes reference it — clean for the picker, no dedup needed).

Routes (`review-ui/server.mjs`, thin wrappers only):
- `GET /api/scene-planning/encounters?world=` — the world picker feed (3-part path, distinct from the 5-part scene-scoped one).
- `POST /api/scene-planning/scenes/:sceneId/encounters/:encounterId/attach` — attach an existing definition to this scene.
- Redefine the existing `DELETE /api/scene-planning/scenes/:sceneId/encounters/:encounterId` as **detach-from-this-scene** (remove the membership), NOT delete-the-definition. **Default orphan semantics (settable):** when a detach empties `sceneIds`, keep the record as an unplaced library entry still reachable via the world picker for re-attach; a *separate* explicit delete-definition affordance (out of scope here unless trivial) would be the only thing that removes it everywhere.

**Acceptance:** unit tests cover — legacy `sceneId` normalizes to `sceneIds`; attach is idempotent and makes the same definition appear in two scenes' `listEncountersForScene`; detach removes it from one scene without affecting the other or duplicating; `listEncountersForWorld` returns each definition once. Existing saved-encounter tests still green (additive; legacy shape still reads). Feeds 27.6's picker.

### 27.3 — scene-link record gains optional `graphEdgeId` (F12 backend) — Sonnet

Extend `linkScenes` to accept and store an optional `graphEdgeId` on the record (`{sceneId, linkedSceneId, reason, graphEdgeId?}`); bump/note the store's shape per schema-versioning discipline. `getLinkedScenes` returns `graphEdgeId` alongside each entry; `unlinkScenes` returns the removed record (including `graphEdgeId`) so the caller can delete the specific edge. Thread `graphEdgeId` through the `POST`/`GET`/`DELETE /api/scene-planning/scene-links` routes. Preserve idempotency (re-linking updates the record, incl. `graphEdgeId`, without duplicating).

**Acceptance:** unit tests cover round-trip of `graphEdgeId` and that unlink returns the removed record; existing scene-links tests still green (additive, no shape break for records without the field).

### 27.4 — **Plan-first shell restructure** of the session-planner view (F3, F5, F6) — **Opus** (hardest task)

Rework `renderSessionPlanner` (3124) / `renderBootstrap` (844) / `loadAndRenderChain` (2071) so the construction view is **plan-first**, matching the Scenes-tab scene viewer Russell prefers. Reuse `plans.mjs` + `resolveActivePlan` (179) — the same active-plan machinery Table Mode (26.8) already uses; do not build a second plan-resolution path.

- Entry: open an existing plan (or the active plan) → show that plan's scenes (current expanded with the full rich body via `buildSceneBodyInto`, others listed as chain items).
- New/empty plan → a screen whose only construction action is **"+Add scene"** (existing-or-new place, via `buildAddSceneControl`/`buildPlaceRequiredFlow`; default = hop workflow, no forced graph push, F13).
- Move **+Scene to the plan level** (F6); the per-scene actions bar becomes **add-node / develop-scene / add-event / add-encounter** (drop `addSceneBtn` from line 1972's append). **Remove "+ Quick add scene"** entirely (F5 — the `quick-add-scene-*` control ~1443 and its call site).
- Keep the rich per-scene body: add-node (F8), develop-scene, add-event, add-encounter, rollback panel (F7 — keep undo-last + reset-scene).

Preserve the Phase-23 lazy-load-on-expand chain behavior and the pre-existing recenter/resume/scenes-tab/flush-on-navigate test contracts (reconcile with 27.0's updates, don't regress them). This is a *plan-first shell around the existing rich body*, per Decision 1 — not a browse-only rework.

**Acceptance:** 27.0's plan-first-navigation e2e green; empty-plan screen shows only +Add scene; +Scene is plan-level; quick-add gone; per-scene actions bar is exactly the four listed; all pre-existing session-planner/scenes-tab e2e still green (or updated in 27.0 to reflect the new entry path, with every still-true assertion preserved).

### 27.5 — plan-scoped link/unlink list + graph push/break confirm (F4, F12) — Sonnet (depends on 27.3, 27.4)

Replace `buildConnectExistingSceneZone`'s (713) green auto-surfaced hop/scene-link candidates with a **plan-scoped scene-link list**: the *other scenes in the active plan*, each with an explicit link/unlink toggle on the right. Scenes start with **no** links (F4).

- **Link** → confirm: "push a graph link to tie the two locations together?" Yes → `addEdgeOp` between the two scenes' place entities; record the returned `graphEdgeId` on the scene-link (via 27.3's extended `linkScenes`/route). No → link the scenes without a graph edge (F12/§26.C: scenes are linked because they're tied together in a plan, regardless of graph adjacency).
- **Unlink** → confirm: "break the graph link?" Yes → `deleteEdgeOp` on the stored `graphEdgeId`, then remove the scene-link. No → remove the scene-link only, leave the edge.

**Acceptance:** 27.0's plan-scoped-scene-links e2e green — link/unlink toggles present per other-plan-scene, graph push creates+stores the edge id, graph break deletes that specific edge; no green auto-links remain.

### 27.6 — add-encounter → saved-encounter picker + open-builder button (F11 UI) — Sonnet (depends on 27.2)

Rework `mountAddEncounterControl` (1174) — currently a straight navigate to the builder — into a control offering (a) a **picker over the world's saved encounters** (`GET /api/scene-planning/encounters?world=`, 27.2) that **attaches the chosen definition to this scene** via `POST /scenes/:sceneId/encounters/:encounterId/attach` (27.2 — a shared reference, NOT a re-saved copy) so it appears in `renderSavedEncountersList`, and (b) an **"open Encounter Builder" button** preserving the current navigate-to-builder behavior. Reuse `buildEntityPicker`'s established picker pattern where it fits. The roster's per-encounter remove button now **detaches** (DELETE = detach-from-scene, per 27.2), leaving the definition intact for other scenes.

**Acceptance:** 27.0's encounter-link-picker e2e green — picker lists world encounters, selecting one attaches the *same* definition to the scene (verifiable: it now appears in both the origin scene's and this scene's roster), open-builder button still navigates, roster remove detaches without deleting the shared definition.

### 27.7 — develop-scene "only undeveloped nodes" option (F9) — Sonnet

Add an "only undeveloped nodes" option (checkbox/toggle) to the develop-scene control. When set, `onDevelopScene` (1385) filters `memberIds` client-side to members whose brief `location.contentFlag?.flagged` is true (undeveloped) before the existing `/develop` call — `developScene` already accepts any `memberEntityIds` subset, and `contentFlag` is already in the brief. No engine/route change.

**Acceptance:** 27.0's develop-only-undeveloped e2e green — with the option set, the develop call fires with only the flagged member ids; default (unset) behavior unchanged.

### 27.8 — scene delete button (F1 UI) — Sonnet (depends on 27.1)

Add a delete affordance to each scene (in `buildChainItem`/`buildSceneBodyInto`), behind a confirm, calling `DELETE /api/session-planner/scenes/:sceneId` (27.1) and removing the scene from the view (and from the active plan's rendered list). Handle deleting the currently-viewed scene gracefully (fall back to the plan's remaining scenes or the empty-plan +Add scene screen).

**Acceptance:** 27.0's scene-delete e2e green — delete removes the scene from the view and the record; no dead-end when the current scene is deleted.

### 27.9 — new-location default-naming fix (F2) + add-event textarea CSS (F10) — Haiku (mechanical; folds into a sonnet pass if coordination outweighs)

- **F2:** stop setting `objectiveNote` (or name) to LLM-generated text at the two quick-gen create sites (**1512**, **2980** — `objectiveNote: \`${name} — ${genRes.text}\``). Leave name/objectiveNote null so `resolveSceneDisplayName` (1816) falls back to the place name. (If the generated text is still wanted somewhere, it belongs in a note/description field the display-name resolver never reads — not the name path.)
- **F10:** low-priority CSS polish on the add-event textarea in `review-ui/public/style.css` (it's ill-formatted but acceptable/resizable — a light, non-disruptive cleanup, not a redesign).

**Acceptance:** 27.0's naming-fix e2e green — a fresh scene shows the place name, never LLM text; add-event textarea reads cleanly. Note: F5's quick-add removal (27.4) may retire one of the two objectiveNote sites — coordinate so this task fixes whatever create path survives.

### 27.10 — author a local `gm-tools-frontend` skill (+ optional one-time WCAG audit) — Sonnet (or orchestrator)

Author `.claude/skills/gm-tools-frontend/SKILL.md`: mine `frontend-design`'s two-pass "design-plan → critique → code" discipline and typography/layout/hierarchy hygiene (**minus** its "spend your boldness"/brutalist-branding push — this is a personal utility: clean, legible, fast-to-scan), plus the community accessibility/color-contrast/API-error-shape checklists (per the design record's community-skills evaluation — *mine, don't auto-install untrusted SKILL.md*). Optionally run a one-time WCAG pass over review-ui (alt text, heading hierarchy, contrast, ARIA, keyboard nav) and capture findings.

**Acceptance:** a scoped, authored local skill exists following the existing `gm-tools-*` skill conventions; no third-party skill auto-installed into `.claude/skills/`. WCAG audit optional — if run, findings recorded (fixes may defer to a later phase).

---

## Task dependency / tiering summary

| Task | Scope | Tier | Depends on |
|---|---|---|---|
| 27.0 QE e2e contract | new/updated `*.e2e.mjs` | Sonnet | — |
| 27.1 `deleteScene` + cascade + DELETE route (F1) | `scenes.mjs`, `server.mjs` | Sonnet | 27.0 |
| 27.2 encounters → shared multi-scene defs + `listEncountersForWorld` + attach/detach routes (F11 be) | `saved-encounter.mjs`, `server.mjs` | Sonnet | 27.0 |
| 27.3 scene-link `graphEdgeId` (F12 be) | `scene-links.mjs`, `server.mjs` | Sonnet | 27.0 |
| 27.4 **Plan-first shell restructure** (F3, F5, F6) | `session-planner-view.js` | **Opus** | 27.0 |
| 27.5 plan-scoped link/unlink + graph push/break (F4, F12) | `session-planner-view.js` | Sonnet | 27.3, 27.4 |
| 27.6 add-encounter picker + open-builder (F11 ui) | `session-planner-view.js` | Sonnet | 27.2, (27.4) |
| 27.7 develop-only-undeveloped (F9) | `session-planner-view.js` | Sonnet | 27.0, (27.4) |
| 27.8 scene delete button (F1 ui) | `session-planner-view.js` | Sonnet | 27.1, 27.4 |
| 27.9 naming fix (F2) + add-event CSS (F10) | `session-planner-view.js`, `style.css` | Haiku* | 27.4 (coordinate objectiveNote site) |
| 27.10 `gm-tools-frontend` skill (+ optional WCAG) | `.claude/skills/`, review-ui | Sonnet | — |

*Haiku flagged, not mandated — 27.9 is mechanical but still touches the QE contract and needs verification; if splitting adds more coordination than it saves, fold into a sonnet pass. (27.2 was re-tiered Haiku→Sonnet once the shared-reference data-model decision turned it from a one-liner into a real schema change.)

**Kept, unchanged (Russell liked these — do not regress):** add-node (F8), undo-last + reset-scene rollback panel (F7), dynamic new-location creation with default no-graph-push hop workflow (F13).
