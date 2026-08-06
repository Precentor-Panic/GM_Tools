# GM_Tools — Phase 30 Task Plan: Adopt the designer app (shell + Session Planner + World), frontend rebuilt from the prototypes

**Status:** approved, ready to execute. Design record (context, decisions, IA, grounding, waves): `/home/russell/.claude/plans/ok-i-m-back-with-dazzling-newt.md` — **read it first.** Frontend source of truth: `design/session-planner/Session Planner.dc.html` + `World Graph.dc.html` (+ `README.md`). This file is the execution checklist.

**Prerequisite reading, in order:** `CLAUDE.md` → `PLAN.md` (Phase 30 row) → the design record above → `design/session-planner/*.dc.html` (open in a browser) → `.claude/skills/gm-tools-conventions/SKILL.md` → `.claude/skills/gm-tools-verification/SKILL.md`.

**Why:** Phase 29 skinned the planner as one tab inside the old GM Review multi-tab shell; the live app doesn't feel like the Designer output. The gap is the app **shell** (the Session planner|World toggle + persistent left rail + hyperlinked breadcrumb the designer built — no GM Review bar exists in the design) and the missing **World** surface + cross-surface interplay. Rebuild the frontend from the designer prototypes, wired to the tested backend.

## Settled decisions (do not relitigate — from Russell, 2026-08-05)
- **Designer `.dc.html` = frontend source of truth.** Port structure/layout/interactions faithfully to vanilla ES modules + the `--sp-*` token stylesheet (translate the prototype's `sc-for`/`sc-if`/`{{ }}` + inline styles). **No framework, no build.** Claude Code owns wiring + backend, not front-end authorship. Future model: Russell designs in Claude Designer → Claude Code ports + wires.
- **Retire the GM Review shell.** New nav = the **Session planner | World** toggle + left rail + breadcrumb only.
- **Shelve legacy tools** (Queue/Batch Review/Import/Framing/Debt/Settings/Encounter Builder/Entity) — dormant, reachable by hash, off the new nav, rendered without rail chrome. Nothing deleted.
- **Build World now** (from `World Graph.dc.html`) so the interplay is real.
- **Backend kept 100%.** Reuse Phase 29 *wiring logic* under the ported DOM; supersede Phase 29 hand-built DOM/CSS where it differs.
- **URL/hash is the source of truth for location**; preserve `localStorage["gmReview.world"]` (the world contract all view modules read).
- **Light-first exact fidelity; dark theme hand-waved.**

## Target IA (from the prototypes)
Top bar: `world · [Session planner | World] toggle · Plans / <plan> / <scene> breadcrumb (Plans+plan clickable) · mode toggles`. Planner left rail: **Session plans** (list + `＋`) + **Scene library** (list + per-row `＋` add-to-open-plan, dedupe+undo). Main column: `view ∈ {plans, plan, scene}`. World: same frame; left rail = containment tree (drag-drop reparent, unreviewed dots, child counts); center = node detail + "▸ Create a scene here" (places only); right 320px inspector = contained-in / tied-to / appears-in / drop-into-a-scene tray.

## Grounded reuse (see design record for file:line)
Backend routes (all — Session Planner done in Phase 29; graph CRUD; batch accept/reject/sync; `GET /api/graph`); graph data+ops; Phase 29 wiring logic (`createFlushableDebounce`, `showUndoToast`/`mountEditableList`, `buildEntityPicker`, `makeClickToEditField`, the Wrap rail → `/api/batches/*`, stat blocks, dressing, from-graph, draft-read-aloud in `session-planner-view.js`); the 4 nav-cancel hooks; the `--sp-*` tokens + self-hosted fonts (29.0).

## Tasks (QE-first; details + acceptance in the design record §Waves)
- **30.0** (Sonnet) — file-layout decision (new `app-shell.js` frame/router + surface modules; server.mjs untouched); new e2e contract for the shell (toggle, left-rail plans+scene-library, `＋` add-to-plan dedupe+undo, clickable breadcrumb, hash deep-links) + both surfaces' load-bearing flows; **retire the old-DOM planner/scene/graph/combat e2e** (keep backend/deterministic). Confirmed **red**.
- **30.1** (Sonnet) — World backend: `scenesForEntity` + route; scene `updatedAt`/recency; atomic `reparentNode` op + route; place-type guard for create-scene-here. Deterministic unit tests.
- **30.2** (Opus) — the shell: `index.html` frame + `app-shell.js` (top bar toggle + breadcrumb + world→localStorage; left rail plans+scene-library+add-to-plan; main-column view-enum over hash). Retire GM Review bar; shelve legacy views. Preserve nav-cancel hooks + world contract.
- **30.3** (Opus) — Session Planner surface ported faithfully into the main column, reusing Phase 29 behavior (shelf, runsheet+add-scene, scene page: place/objective/read-aloud, KEY/MUNDANE, add-field chips, Page/Cards, Prep/Run, stat blocks, Wrap rail, place-desc, dressing, from-graph).
- **30.4** (Opus) — World surface: tree + contents + loose threads + detail + scene tray + drag-drop reparent + create-scene-here, wired to `GET /api/graph` + graph ops + 30.1. Replaces force-directed `#graph`.
- **30.5** (Opus/Sonnet) — cross-surface interplay (create-scene-here→planner; add-existing-scene-to-plan; drop-node-into-scene); fidelity sweep (light-first); responsive; full screenshot set for Russell.

## Dependency / tiering
| Task | Tier | Deps |
|---|---|---|
| 30.0 QE reset + structure | Sonnet | — |
| 30.1 World backend | Sonnet | — (parallel-safe with 30.0) |
| 30.2 shell | Opus | 30.0 |
| 30.3 Session Planner surface | Opus | 30.2 |
| 30.4 World surface | Opus | 30.2, 30.1 |
| 30.5 interplay + fidelity | Opus/Sonnet | 30.3, 30.4 |

**Concurrency:** 30.2–30.4 share `index.html`/frontend modules → dispatch sequentially, `git add` explicit paths, one e2e server at a time. Commit per wave; orchestrator independently re-runs every suite (don't trust agent reports) per `gm-tools-verification`.

## Verification
Deterministic backend stays green (root 64/65 known `snowball-delta`, wf-mcp 11/11, review-ui unit 150/150 + World-backend tests). Fresh e2e for the new DOM red→green; old-DOM planner/scene/graph/combat e2e retired (QE reset). `foundry_worldFabric` untouched. **Final gate: Russell's hands-on browser pass** (he owns the design; expect a Designer→wire loop).
