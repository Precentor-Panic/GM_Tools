# GM_Tools — Phase 32 Task Plan: The Foundry Bridge (plumbing, pull-first)

**Status:** approved, ready to execute. Design record (context, decisions, architecture, grounding): `/home/russell/.claude/plans/ok-i-m-back-with-dazzling-newt.md` — **read it first.** This file is the execution checklist.

**Prerequisite reading, in order:** `CLAUDE.md` → `PLAN.md` (Phase 32 row) → the design record above → `.claude/skills/gm-tools-conventions/SKILL.md` → `.claude/skills/gm-tools-verification/SKILL.md`.

**Why:** GM_Tools and the World Fabric Foundry v14 module (`/opt/dev/foundry_worldFabric`) share a world but have no real document bridge. Get the plumbing ready before the interface is finished: pull maps/monsters/players/items out of Foundry (populate bestiary/player-list/items), later push maps/splash/scenes + index tokens.

## Settled decisions (do not relitigate — from Russell, 2026-08-06)
- **Extend the Foundry module** (reuse the proven `FilePicker.upload`/5s-poll file bridge; add a PARALLEL Foundry-document channel; leave the existing graph-mutation bridge untouched). **This lifts the standing "never touch `foundry_worldFabric`" rule for this phase.**
- **Plumbing + prove with slices** — transport + schema/link fields + ONE pull slice + ONE thin push slice; design the rest.
- **Pull first** — Foundry actors → the EXISTING bestiary + party-roster stores.

## Architecture — the cross-repo file contract (decouples the repos; GM_Tools testable against fixtures, no live Foundry)
Three new files under `<foundryDataDir>/worlds/<world>/`, additive to the existing bridge, overwrite-to-signal (FilePicker can't delete):
- `world-fabric-foundry-index.json` (Foundry→GM_Tools, PULL): actors (name/img/uuid/`system` stats/embedded `items`), players (`game.users`+`user.character`), scenes (name/uuid/`background.src`/dims/token summaries), tokens. Versioned.
- `world-fabric-foundry-ops.json` (GM_Tools→Foundry, PUSH): `[{opId, kind, data}]`, applied via the document API. SEPARATE from `world-fabric-mutations.json`.
- `world-fabric-foundry-results.json` (Foundry→GM_Tools): `[{opId, ok, foundryUuid?, error?}]` for UUID write-back.

## Grounded reuse (EXISTS; file:line in the design record)
Foundry: `graph-service.mjs:238/274` (exportSnapshot + mutation-watcher — extend, don't replace); `cockpit-app.mjs:835` push (globalThis[Type].create — use `getDocumentClass` instead); `world-scan.mjs`/`pack-scan.mjs:105` pull (gaps: no inventory/system/players/scene-map/token-xy). GM_Tools: `wf-mcp-server/lib/mutation-ops.mjs:109/141` (file-bridge write+poll — mirror for the ops channel); `snapshot.mjs` (add index path+reader); bestiary `combat-planning/bestiary-store.mjs` + party roster `combat-planning/party-roster-store.mjs` (EXIST; add `foundryActorRef` + populate-from-Foundry); scenes `session-planner/scenes.mjs` (add `foundrySceneRef`). Items store + token index = NEW (designed in 32.4).

## Tasks (QE-first; details + acceptance in the design record §Waves)
- **32.0** (Sonnet) — `plans/phase-32-bridge-contract.md` (versioned index/ops/results schemas + `*_VERSION` + signal convention) + representative fixtures under `wf-mcp-server/test/fixtures/foundry-*`. Nothing regresses.
- **32.1** (Opus; **modifies `foundry_worldFabric`**) — `scripts/data/foundry-bridge.mjs`: pure `buildFoundryIndex(actors,users,scenes)` (Node-testable) + in-client wrapper (enumerate `game.actors`/`users`/`scenes` incl. `actor.items`/`actor.system`/`scene.tokens` → `FilePicker.upload` index on flush/ready + a "Reindex for GM_Tools" control) + a second watcher for `foundry-ops.json` (apply doc-ops via `getDocumentClass(...).create/update` + `createEmbeddedDocuments` → `foundry-results.json` UUIDs). Wire in `module.mjs`. Unit-test pure fns (`test/m*.test.mjs` pattern); documented live smoke; re-zip note.
- **32.2** (Sonnet; **primary**) — `wf-mcp-server/lib/foundry-index.mjs` reader + pure mappers actor→`RawBestiaryFields` (monsters) + actor→`RawPartyMemberFields` (PCs). `foundryActorRef` on bestiary+party-roster. Review-gated ingest (proposed→accept, no silent overwrite). Routes + MCP tool + deterministic tests vs 32.0 fixtures.
- **32.3** (Sonnet) — `foundry-ops` writer (mirror `mutation-ops.mjs` write+poll-results) + `create_scene` op (scene → Foundry Scene w/ `background.src`+name; write returned UUID → new `foundrySceneRef` on `scenes.mjs`). Route + tests vs fixtures/stubbed result.
- **32.4** (Sonnet/orch) — `plans/phase-32-deferred.md` (items/inventory + token-index stores [data layer], full scene push, UI surfaces — deferred); run live smoke; update `PLAN.md` + `gm-tools-verification`/memory re: `foundry_worldFabric` now modified.

## Dependency / tiering
| Task | Tier | Deps |
|---|---|---|
| 32.0 contract + fixtures | Sonnet | — |
| 32.1 Foundry-module bridge | Opus | 32.0 |
| 32.2 pull slice (primary) | Sonnet | 32.0 |
| 32.3 push slice (thin) | Sonnet | 32.0 |
| 32.4 design + smoke + docs | Sonnet/orch | 32.1–32.3 |

**Concurrency:** 32.2 and 32.3 both consume the 32.0 fixtures but edit disjoint GM_Tools files → can parallelize after 32.0; 32.1 is a different repo (foundry_worldFabric) → parallel-safe with 32.2/32.3. `git add` explicit paths; commit per task; orchestrator independently re-runs suites per `gm-tools-verification`.

## Verification
- GM_Tools side fully deterministic-testable against 32.0 fixtures (no live Foundry). Keep root (64/65 known `snowball-delta`), wf-mcp (11/11 + new), review-ui unit (167/167 + new), review-ui e2e (71/71) green.
- **`foundry_worldFabric` IS modified this phase** (untouched-rule lifted; new baseline = `scripts/data/foundry-bridge.mjs` + `module.mjs` wiring + tests). Unit-test extracted pure fns; in-client parts get a **documented live smoke** vs `localhost:30000` (no automated live-Foundry harness).
- **Final gate: Russell re-installs the updated module zip, runs the smoke** (reindex → rich `foundry-index.json`; push a scene → Foundry Scene w/ map appears + UUID round-trips), hands-on.
