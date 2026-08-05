# GM_Tools — Phase 29 Task Plan: Adopt the Claude-Designer Session Planner front end (scoped)

**Status:** approved, ready to execute. Design record (context, decisions, grounding, full task breakdown): `/home/russell/.claude/plans/ok-i-m-back-with-dazzling-newt.md` — **read it first.** Visual source of truth: `design/session-planner/` (README.md + the two `*.dc.html` prototypes — open them in a browser to match pixels; `support.js` was throwaway and is not included). This file is the execution checklist.

**Prerequisite reading, in order:** `CLAUDE.md` → `PLAN.md` (Phase 29 row) → the design record above → `design/session-planner/README.md` → `.claude/skills/gm-tools-conventions/SKILL.md` → `.claude/skills/gm-tools-verification/SKILL.md`.

**Why:** Phase 28 shipped the functional plan-construction rebuild; Russell then ran a Claude-Designer pass and returned a high-fidelity handoff. Phase 29 wires that polished design onto the Phase 28 backend + DOM contract, faithfully.

## Settled decisions (do not relitigate — from Russell, 2026-08-05)
- **Session Planner first**; the net-new **World Graph** view is a follow-on phase (Phase 30, outlined in the design record, not built here).
- **Stat blocks** = an optional `stat` object **on `SceneElement`** (matches the prototype's `element.stat`), NOT a new store, NOT saved-encounter (library-scoped/mechanically-scored/Foundry-blind — poor fit).
- **New visual system scoped to the Session Planner surfaces only** (global `style.css` tokens untouched; Queue/Review/Import/Encounter-Builder/Scenes keep current styling). Russell will migrate/remove old surfaces over time.
- **Keep the Phase 28 click-to-edit textarea-swap mechanism + every `data-testid`** — visually identical to the prototype's `contenteditable` at rest, and it keeps Phase 28's 59/59 e2e green. Recreate the *look*; add features behind *new* testids, QE-first.
- **`foundryActor` is stored only** — no push wired (consistent with "Drop into Foundry" staying out, per phase-28-tasks.md).
- **Fonts self-hosted** (Spectral / IBM Plex Sans / IBM Plex Mono woff2 under `review-ui/public/fonts/`) to keep the app self-contained/offline — flag if Russell prefers the Google-Fonts CDN link.

## Grounded reuse (already exists — confirmed in exploration; see the design record for file:line)
Scene page + testids (`review-ui/public/session-planner-view.js`), plan shelf/runsheet (`plans-view.js`), `showUndoToast`/`mountEditableList`, `createFlushableDebounce`; `SceneElementFields` already matches the design vocabulary; element + graph-node routes; the full Wrap review pipeline (`GET /api/batches/:batchId` per-mutation `op`/`diff`/`status`, `accept|reject {scope:'entity',id}`, `/sync`) — the inline Wrap rail needs **no new backend**.

## Tasks (QE-first; details + acceptance in the design record §"Phase 29 tasks")
- **29.0** (Sonnet) — scoped oklch tokens + self-hosted fonts (light+dark); `phase29-fixture.mjs` locking the new-feature DOM/route contract, confirmed **red**.
- **29.1** (Sonnet) — backend: `SceneElement.stat` + StatBlock zod + PATCH `{stat}`; `attachExistingNodeAsElement` + from-graph route; element **reorder** route (store op exists, unwired); `updateScene({name?,objectiveNote?})` + route. Deterministic unit tests.
- **29.2** (Opus) — re-skin shelf/runsheet/scene page (tokens/type/spacing/halos/KEY-MUNDANE weight). No DOM/testid changes; Phase 28 e2e stays green.
- **29.3** (Opus) — place-description grid (`editNodeOp`) + missing-desc banner + draft-read-aloud ghost link; objective inline edit; Suggest-dressing (client keyword sets from the prototype); From-graph picker.
- **29.4** (Opus) — stat blocks (AC/HP/Speed/CR + raw paste + foundryActor + count stepper) + `+ STAT BLOCK` chip + `▣ NPC or creature` button.
- **29.5** (Opus/Sonnet) — Page|Cards layout toggle + Prep|Run mode (run hides edit chrome, MUNDANE→Gives, read-aloud 20px, Wrap force-closed); mode/layout view-local, URL stays location source of truth.
- **29.6** (Opus) — reshaped inline Wrap rail (proposal cards from the batch, per-card accept/reject + Apply N via `/sync`; keep the promote checklist). No new backend; no-silent-auto-write preserved.
- **29.7** (Sonnet) — fidelity/responsive/dark polish + desktop/tablet/phone/dark screenshots for Russell.

## Dependency / tiering
| Task | Tier | Deps |
|---|---|---|
| 29.0 tokens+fonts+QE | Sonnet | — |
| 29.1 backend | Sonnet | 29.0 |
| 29.2 re-skin | Opus | 29.0 |
| 29.3 place/objective/dressing/from-graph | Opus | 29.1, 29.2 |
| 29.4 stat blocks | Opus | 29.1, 29.2 |
| 29.5 layout + run mode | Opus/Sonnet | 29.2 |
| 29.6 Wrap rail | Opus | 29.2 |
| 29.7 polish + screenshots | Sonnet | 29.3–29.6 |

**Concurrency:** 29.2–29.6 all edit `session-planner-view.js`; harness has no worktree isolation → **dispatch sequentially**, `git add` explicit paths, one e2e server at a time. Commit per task; orchestrator independently re-runs every suite (don't trust agent reports) per `gm-tools-verification`.

## Verification
QE-first `phase29-*.e2e.mjs` (red→green); **Phase 28's 59/59 stays green throughout**; a lone untouched-file 30s-timeout is a suspected parallel-load flake → re-run that file in isolation. Deterministic: root 64/65 (known `snowball-delta` only), `wf-mcp-server` 11/11, `review-ui` 150/150 + new tests. `foundry_worldFabric` untouched. Final gate: **Russell's hands-on browser pass.**
