# GM_Tools — Phase 33 Task Plan: Unify scene contents (World↔Planner) + World "Remove from graph"

**Status:** approved, ready to execute. Design record (full context, grounding file:line, decisions): `/home/russell/.claude/plans/ok-i-m-back-with-dazzling-newt.md` — **read it first.** This file is the checklist.

**Prerequisite reading:** `CLAUDE.md` → `PLAN.md` (Phase 33 row) → the design record → `.claude/skills/gm-tools-conventions/SKILL.md` → `.claude/skills/gm-tools-verification/SKILL.md`. Also the Phase-31 UX audit `plans/phase-31-ux-audit.md` (the drag-drop + open-full-page findings this phase finishes).

**Why:** (1) a node dragged into a scene on the World surface never shows in the Session Planner — because the World drop writes the **scene-membership** store while the Planner scene page reads **scene-elements** (two parallel stores). (2) Two designer deviations: add a **"Remove from graph"** action in the World node inspector, recycling the dead **"Open full page →"** screenspace.

## Settled decisions (do not relitigate — from Russell, 2026-08-06/07)
- **Unify scene contents as referenced elements**: a World drop creates the SAME graph-referencing element the scene page's "◇ From graph" picker makes (`attachExistingNodeAsElement`/`from-graph`), so it appears in the Planner as a KEY element; **retire the vestigial scene-membership store**. NOT a scenes-as-graph-entities rearchitecture (rejected Phase 26). Scene records unchanged.
- **"Remove from graph"**: guarded delete (reuse `deleteNodeOp`), **warn-and-leave references by default**, with an **opt-in "also remove from all N scenes"** (so a deleted node doesn't leave orphaned KEY elements silently demoted to dressing). Undo restores the graph node/edges (atomic slot); the opt-in scene-reference removal is a deliberate cleanup not covered by that undo (surface honestly).

## Grounded reuse (EXISTS; file:line in the design record)
Part A: `attachExistingNodeAsElement` (`scene-elements.mjs:288`) + `POST .../elements/from-graph` (`server.mjs:2213`); scene page renders graph-elements KEY (`session-planner-view.js:1164/1194`); scene-page "◇ From graph" already calls the same route (`:2396`); `touchScene` already wired into element routes; `scenesForEntity` counts graph-elements (`scene-lookup.mjs:41`). scene-membership live consumers = World drop + `scenesForEntity` member role only (`/intervening-offer` orphaned) → cleanly retireable.
Part B: inert `wv-inspector-openfull` span (`world-view.js:760`, CSS `style.css:2959`); `deleteNodeOp` (`manual-edit-ops.mjs:465`, returns `cascadeEdgeCount`, atomic undo) via `DELETE /api/graph/nodes/:entityId` (`server.mjs:1230`); confirm/cascade pattern in `buildBeyondRoomDrawer` (`session-planner-view.js:1469-1577`); "used in N scenes" via `scenesForEntity` already in the inspector's Appears-in (`world-view.js:814`); re-render via `reload()` (`world-view.js:1088`); scene page tolerates dangling refs (`:1181/2761`).

## Tasks (QE-first; details + acceptance in the design record §Waves)
- **33.0** (Sonnet) — e2e red: (a) a World scene-tray drop → node appears on the Planner scene page as a KEY element; (b) World inspector "Remove from graph" in the recycled slot + guarded confirm (cascade + used-in-N-scenes) + opt-in "remove from all scenes". Native DnD + click per `phase31-interactions.e2e.mjs` DataTransfer pattern; inspector-scoped like `phase30-world-surface.e2e.mjs`. Confirmed red for the right reason.
- **33.1** (Sonnet) — Part A: dedupe in `attachExistingNodeAsElement`; redirect `world-view.js` `addToScene` → from-graph (+ element-delete undo, "already in scene" on dedupe); `sceneContentCount`/`recomputeUsedInScene` → elements/anchors; retire scene-membership (`git rm` store + `test/session-planner/scene-membership.test.mjs`; drop `/members` GET/POST/DELETE + `/intervening-offer` routes `server.mjs:1918-1947`); drop `scenesForEntity` member role + update `scene-lookup` tests. Deterministic + 33.0 drag e2e green.
- **33.2** (Opus) — Part B: repurpose the span → "Remove from graph" button; inline confirm mirroring beyond-room (danger/cancel + `data-cascade-edge-count` from the DELETE response + used-in-N-scenes); NEW `removeEntityFromAllScenes(world, entityId)` op (per `scenesForEntity`: `removeElement` graph-elements + `updateScene` clear anchors→Unplaced) + route + deterministic test; opt-in checkbox; `reload()` + `showUndoToast`. 33.0 delete e2e green.

## Dependency / tiering
| Task | Tier | Deps |
|---|---|---|
| 33.0 QE contract | Sonnet | — |
| 33.1 Part A | Sonnet | 33.0 |
| 33.2 Part B | Opus | 33.0 (33.1 preferred first — both edit world-view.js/server.mjs) |

**Concurrency:** 33.1 and 33.2 both edit `world-view.js` + `server.mjs` → **sequential** (33.1 then 33.2). `git add` explicit paths; commit per task; orchestrator independently re-runs suites per `gm-tools-verification`.

## Verification
- Deterministic: root (65/66 known `snowball-delta`, minus retired scene-membership test + new tests), `wf-mcp-server` (+ `removeEntityFromAllScenes` test), `review-ui` (deterministic + e2e green incl. the two new phase33 flows). Lone untouched-file 30s e2e timeout = known parallel-load flake → isolation re-run.
- **`foundry_worldFabric` untouched** (Phase-32 baseline HEAD `da0f249`; this phase changes nothing there).
- Grep-clean: no live references to scene-membership / `/members` / `wv-inspector-openfull`-as-openfull.
- **Final gate: Russell's hands-on browser pass** (World drop → shows as KEY element in Planner; select node → Remove from graph → guarded confirm → optional remove-from-all-scenes → undo restores).
