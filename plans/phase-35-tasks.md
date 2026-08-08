# GM_Tools — Phase 35 Task Plan: Library + the sync-IN experience (Foundry pull completed)

**Status:** approved, ready to execute. Design record (roadmap 34–37, decisions, persona adoptions, grounding): `/home/russell/.claude/plans/ok-i-m-back-with-dazzling-newt.md` — **read it first.** The design source is `design/session-planner/Library.dc.html` (pixel authority) + `README.md` (§Library, §shared scene tray). This file is the execution checklist.

**Prerequisite reading:** `CLAUDE.md` → `PLAN.md` (Phase 34+35 rows) → the design record → `design/session-planner/README.md` + `Library.dc.html` → `plans/phase-32-deferred.md` (§1 ItemRecord, §2 TokenRecord — the pre-designed store shapes) → `.claude/skills/gm-tools-conventions/SKILL.md` → `.claude/skills/gm-tools-verification/SKILL.md`.

## Settled decisions (do not relitigate — Russell 2026-08-07/08 + persona adoptions)
- **The knowledge graph stays GM_Tools-side** (Russell 2026-08-08): Foundry holds concrete play docs (actors/items/scenes); Library rows *reference* Foundry ids (`foundryActorRef`/`foundryRef`). No graph push to Foundry; no wf-module changes this phase.
- **Tray XP = literal CR→XP arithmetic** (client-side `CR_XP` lookup; EV→×40 bridge). NO verdict language ("deadly", "trivial") — the Encounter Builder stays the difficulty tool. Meter copy: `N / budget xp` + budget colors per prototype.
- **Hero conditions = one-click, always visible**; ratings/notes behind a click. Bestiary organized by **habitat tree** (graph places + `all`/`unplaced` buckets); tags-first Bestiary filtering is a noted-not-adopted future.
- **Music/playlist rows are hand-added only this phase** — playlists enter the foundry-index in 36.1 (the ONE wave allowed to touch `foundry_worldFabric`). This phase does NOT touch that repo (baseline HEAD `da0f249` + pre-existing tree).
- **All pulled content lands as proposals** (proposed/accepted gates, same as bestiary/party today) — nothing enters the Library without Russell's accept.
- **Retire-as-hit this phase: `#scenes`** (planner rail scene library + tray cover browsing; relocate `scene-delete`'s guarded flow into the planner rail or World appears-in BEFORE retiring — four-verbs rule). `#entity` stays unless trivially clean to retire.
- **Encounter Builder stays** (complement, not replaced) until Russell decides its Library fate — flag, don't remove.
- ONE tagged-shelf component serves Reliquary AND Stagecraft; ONE scene tray serves all four surfaces ("implement once" — README).

## 35.pre — wf-test-5e provisioning (IN FLIGHT, orchestrator-managed — not a farmed task)
The setup agent (approved by Russell 2026-08-08: "Restart; leave wf-test-5e active") is provisioning the real test bed: fresh `wf-test-5e` world (dnd5e 5.3.3, `rulesVersion:"legacy"` = **2014 SRD**, non-`24` packs only) with ~15 monsters CR 1/8–17 (≥2 legendary, inventory-carriers), ~10 items, 2-3 PCs + a player user, 2 scenes with backgrounds + placed tokens; then `reindexForGmTools()` + a proven pull (proposals left unaccepted). The dangling `world-fabric` symlink was repaired (→ `/opt/dev/foundry_worldFabric`). Its output feeds 35.1's sanitized real-index fixture and 35.4's acceptance. Live worlds `wf-test` + `rl-combat` untouched.

## Shapes to pin (35.0 formalizes these in the fixture header; 35.1 implements THE WRITTEN CONTRACT, not its own guesses)
Seed shapes from the prototype (Explorer-A extraction) + `phase-32-deferred.md`:
- **ItemRecord** (`combat-planning/item-store.mjs`): per deferred §1 + `tags[]` + alignment with the asset shape (`kind:"item"`); owner-link via `ownerFoundryActorUuid`; proposed/accepted status gate like bestiary.
- **StagecraftAsset** (`session-planner/stagecraft-store.mjs`): `{id, world, kind: "map"|"splash"|"music", name, source: "foundry"|"local", meta, desc, tags[], foundryRef: {sceneUuid?|imagePath?|playlistId?}, createdAt}`.
- **Token-index** per deferred §2 (`PlacedToken` has no stable id → **per-scene replace** semantics), sub-store or sibling of stagecraft.
- **Tags helpers**: ONE shared module (add/remove/index-with-counts) reused by item + stagecraft (+ bestiary if additive-safe). UI: per-row `tags[]`, left-rail counts, AND filter, `+tag` inline add.
- **Bestiary/party additive fields** (SCHEMA bumps + back-compat defaults): `note`, `rating` (user star/CR-override), `sourcePill` derivation (`foundry` if foundryActorRef, `mine` if hand-made, `srd` if flagged from SRD import); party adds `passive` + `conditions` (one-click-editable).
- **Pull-mapper extensions** folded into the existing `pull-actors` composition: `actors[].items[]` → Reliquary proposals (owner-linked); `scenes[]` → Stagecraft `map` refs (background.src + dims meta); `scenes[].tokens[]` → token-index (per-scene replace).
- **Tray roster persistence** (35.3 wires; 35.0 specs): `sceneId → [{id, n, kind: "creature"|"hero"|"asset"}]`; creature drop → KEY element **with `stat` populated from the bestiary entry** (graph-node creatures reuse the `attachExistingNodeAsElement`-style flow; others → local element + stat); hero → display-only roster entry; asset → a scene-asset link (small `sceneAssets` field or store — 35.0 decides and pins).
- Prototype card shapes for UI fidelity: creature `{defenses[[k,v]], abilities, lines, sections, appearances, note, ratingLabel CR|EV, source srd|ds|foundry|mine|reskin, habitats[]}`; hero `{hp:[cur,max], ac, passive, resources, saves, conditions, skills[[name,mod,expertise]], items[], note}`; asset `{kind, source, meta, desc, tags[]}`.

## Tasks
- **35.0** (Sonnet) — QE contract: `phase35-fixture.mjs` + `phase35-*.e2e.mjs`, red for the right reasons. Coverage: Library tabs render with counts; Bestiary habitat-tree filter + creature card + stat rail + rating stepper + note; Hero cards with one-click conditions; Reliquary/Stagecraft tagged shelves (tag add/remove/AND-filter/counts/search); the shared scene tray on all four pages (drop → roster `{id,n,kind}`, creature stacking ×N, XP meter `N / budget xp`, NO verdict language asserted); pull-extension route contracts (items→Reliquary, scenes/maps→Stagecraft `map` refs, tokens→token-index). **Formalize every shape above in the fixture header** — the orchestrator reviews it before 35.1 starts (35.0 → 35.1 is SEQUENTIAL; net-new stores need the written contract first). Existing suites stay green.
- **35.1** (Sonnet) — stores + pull extensions per the 35.0 contract: `item-store.mjs`, `stagecraft-store.mjs` (+ token-index), shared tags helpers, bestiary/party additive fields (SCHEMA bumps + back-compat defaults + migration-on-read like prior bumps), pull-mapper extensions in `pull-actors`. Deterministic tests vs the 32.0 fixtures **+ a NEW richer fixture snapshotted from the real `wf-test-5e` index (sanitized)** so tests reflect real dnd5e shapes. No frontend.
- **35.2** (Opus) — Library UI: `review-ui/public/library-view.js` replacing the scaffold, per `Library.dc.html` (pixel authority) — Bestiary (habitat tree, creature cards, full stat rail, rating stepper, source pills, note; reskin-suggester = stored-not-wired stub, flagged); Hero's Hall (Cards/Side-by-side, one-click conditions, resources, ✦ expertise); Reliquary + Stagecraft (the ONE tagged-shelf component: kind glyphs/accents, empty-desc italic, kind filter); the **shared scene tray** component `review-ui/public/scene-tray.js` (filter + recency scenes via existing `sort=recency` route, drop targets, rosters, XP meter) mounted in the Library rail AND exported for other surfaces. World's existing tray stays until 35.3 — flag, don't fork.
- **35.3** (Sonnet) — tray wiring + unification + retire-as-hit: persist tray drops per the pinned contract (creature→KEY element w/ stat; hero→roster; asset→scene-asset link); **unify** the World inspector's tray onto the shared component (one tray); retire `#scenes` (with the `scene-delete` guarded-flow relocation FIRST); `#entity` only if trivially clean. Full e2e green incl. the phase35 contract.
- **35.4** (orchestrator) — independent re-verification (all suites); then the REAL test: `POST /api/foundry/pull-actors {world:"wf-test-5e"}` → open the Library → 2014 SRD monsters/heroes/items/maps appear as proposals in the right tabs with sane fields (CR, hp/ac, items owner-linked, map dims). Screenshot gallery for Russell; PLAN.md flip. **Final gate: Russell's pass — Library browse + accept a few proposals + a tray drop into a real scene.**

## Dependency / tiering / concurrency
| Task | Tier | Deps |
|---|---|---|
| 35.0 QE contract | Sonnet | 35.pre (fixture realism helps but mock-shapes suffice if pending) |
| 35.1 stores + pull | Sonnet | **35.0 (hard — contract first)**, 35.pre (real-index fixture) |
| 35.2 Library UI | Opus | 35.0, 35.1 |
| 35.3 wiring + retire | Sonnet | 35.2 |
| 35.4 verify + acceptance | orch | all + 35.pre |
Strictly sequential (35.0 → 35.1 → 35.2 → 35.3 → 35.4): net-new stores need the written contract; UI needs the stores; wiring shares `world-view.js`/shell files with 35.2's output. `git add` explicit paths; commit per task; orchestrator independently re-runs root + wf-mcp + review-ui deterministic + full e2e per wave (lone untouched-file 30s timeout = suspected parallel-load flake → isolation re-run before calling regression). `foundry_worldFabric` untouched this phase.

## Verification
QE-first phase35 e2e red→green; existing suites stay green (post-Phase-34 baseline: root 66/67 known `snowball-delta`, wf-mcp 17/17, review-ui deterministic 189/189, e2e 97/97 + new). Grep-clean on the retired `#scenes` view. 35.4's real-content pull against `wf-test-5e` is the technical gate; **Russell's hands-on Library pass is the final gate.**
