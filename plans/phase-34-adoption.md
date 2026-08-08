# Phase 34 task 34.0 — Adoption record: the NEW designer handoff as the final design doc

**Source:** `TTRPG Session Planning Tool.zip` (Russell's second Claude-Designer handoff, dated 2026-08-07, repo-root and Downloads copies identical) — extracted 2026-08-08 into `design/session-planner/`, replacing the two Phase-27-era prototypes (`Session Planner.dc.html`, `World Graph.dc.html`) and adding three new ones (`Chronicle.dc.html`, `Library.dc.html`, `Connection Menu.dc.html`) plus a refreshed `README.md`. `support.js` (the `.dc.html` runtime shim, not design content) is excluded, matching the original extraction's own convention. The zip itself stays gitignored — the extracted `.dc.html`/`README.md` files are the tracked, final design doc from this point forward.

**Grounding documents** (read in this order; this file distills them into an execution-ready record, it does not replace them):
1. `/home/russell/.claude/plans/ok-i-m-back-with-dazzling-newt.md` — the design record: the 3-explorer delta synthesis, persona-round adoptions, Russell's locked decisions. This adoption doc's §1–§3 below are a tightened, phase-34-scoped restatement of that record's own §Grounding/§Persona-round-adoptions/§Decisions-locked sections — read the original for the full reasoning, not just the conclusions reproduced here.
2. `plans/phase-34-tasks.md` — the execution checklist + the pre-specified route/store contract (§4 below is that contract copied verbatim, the single reference both 34.0 and 34.1 build against).
3. `design/session-planner/README.md` — the designer's own prose spec for the extracted `.dc.html` prototypes (stale in a few places per §2 below).

---

## §1. Delta list D1–D12 (new prototypes vs. what's built) + SAME items

Grounded verbatim in the design record's own "Grounding (3-explorer synthesis — EXISTS vs NEW)" section, tightened to the concrete DOM/behavior deltas this phase's QE contract (`review-ui/test/e2e/phase34-*.e2e.mjs`) pins.

| # | Delta | Today (built) | New prototype | Landing task |
|---|---|---|---|---|
| D1 | Nav | 2-way: Session planner · World (`shell-surface-toggle-planner`/`-world`) | 4-way: Session planner · World · **Chronicle** · **Library**, one visually-grouped nav strip (identical markup across all 4 `.dc.html` files' own top bars) | 34.2 |
| D2 | Connection Menu chip | Does not exist anywhere | A chip in every top bar (`⚙ Foundry · <world> · live · N actors` / `Not connected`), opens a 560px panel | 34.2 |
| D3 | `◇ In scene` rail toggle | Pre-existing gap (not newly introduced by this handoff) | — | Not this phase (flagged, unscheduled) |
| D4 | Scene prev/next | Generic `‹ Prev` / `Next ›`, OMITTED entirely at plan ends | `← <prevSceneName>` / `<nextSceneName> →`; `"Start of plan"` / `"End of plan"` rendered **disabled**, not omitted, at the ends | 34.3 |
| D5–D8 | Remove-from-graph | Phase 33's guarded confirm PANEL (separate element); `deleteNodeOp` cascades ALL edges — every child of the deleted node becomes a NEW ROOT | Design's inline two-click ARM (no separate panel); **HYBRID** (see §3) — children reparent UP one level instead of becoming roots | 34.1 (backend op+route) / 34.3 (frontend) |
| D9 | Type-filter chips | Glyph + text label (two child elements per chip) | Icon-only, 27px circles (glyph only) | 34.3 (Haiku, flagged-advisory) |
| D10 | World search box width | 240px | 220px | 34.3 (Haiku) |
| D11 | Tooltip copy | — (existing tooltips, minor wording only) | Refreshed copy per the prototype | 34.3 (Haiku) |
| D12 | Scene-tray hint copy | `"drag a node here → in the scene"`, no testid | `"Drop into a scene"` (new testid `world-scene-tray-hint` required) | 34.3 (Haiku) |
| — | `#settings` | Legacy standalone view (`view-settings`) | Folded into the Connection Menu panel's "Campaign & keys" section | 34.2 |
| — | `#import` | Legacy standalone view (`view-import`) | Folded into the Connection Menu panel's lore-intake section | 34.2 |

**SAME (byte-identical old→new, confirmed by direct comparison of `Session Planner.dc.html`/`World Graph.dc.html` against the shipped app — no changes required):**
- Scene page body: elements list, wrap rail, breadcrumb (aside from D4's own prev/next content change), Page|Cards / Prep|Run controls.
- Scene-tray drop → KEY-element behavior (Phase 33's own drop-to-planner fix, `phase33-world-drop-to-planner.e2e.mjs`, untouched by this phase).
- Tree hints, world inspector's "Contained in"/"Tied to"/"Appears in" sections (aside from D5-D8's own remove-from-graph slot).

---

## §2. Stale-README corrections

The new `design/session-planner/README.md` (extracted 2026-08-08) is the current spec, but four places in it describe the app as it stood at an EARLIER phase, not as it is post-Phase-33/34. Fold these corrections in when reading the README — do NOT regress shipped code to match the stale text:

1. **`scene-membership` is retired.** The README's own historical language around "scene membership" describes a store Phase 33 task 33.1 retired — scene contents are now unified as *referenced elements* (`attachExistingNodeAsElement`, `kind:"graph"` scene-elements), not a separate membership table. Any README passage implying a membership store is stale.
2. **`SceneElement.stat` is NOT new.** It shipped in Phase 29 (task 29.1/29.4) — stat blocks are an existing, built feature, not something this phase or a future one introduces.
3. **The push path is the Phase-32 file bridge**, not `foundry-push.mjs` as an older README passage implies. `POST /api/foundry/push-scene` (Phase 32 task 32.3) writes to `world-fabric-foundry-ops.json` and polls for the Foundry-side watcher to apply it — that's the real, current push mechanism.
4. **README §F is stale wherever the new prototype markup diverges from its own prose** — e.g. remove-from-graph replaced the old "Open full page →" span (§F's own prior description); search is 220px not the width §F may still describe; type chips are icon-only. **Files-note + markup win**: where the `.dc.html` markup and the README's own prose disagree, the markup is authoritative (this is the same rule Phase 29/30/33's own adoption passes used).

---

## §3. Persona adoptions + Russell's locked decisions (2026-08-07/08)

Reproduced from the design record's own "Persona-round adoptions" + "Decisions locked" sections, phase-34-scoped:

- **Remove-from-graph = HYBRID** (verbatim, locked): *"the design's inline two-click arm + children-reparent-up-one-level, with the Phase-33 safety folded into the armed state (consequence line 'reparents K inside · drops M links · used in N scenes' + opt-in remove-from-all-scenes; collapses to bare 'remove — sure?' when all counts are zero — the UX persona's progressive-disclosure spec)."* Undo restores the node + its edges (the atomic `remove-reparent-up` undo slot) — it does **not** restore the opt-in scene-cleanup separately; that's explicitly called out so nobody expects a "second" undo for the scene refs.
- **Sequencing = Foundry loop first**: 34 Foundation/front-door → 35 Library + sync-IN → 36 ready-to-run push → 37 Chronicle last.
- **Legacy views: keep by-hash, retire-as-replaced.** This phase retires `#settings` (→ Connection Menu panel) and `#import` (→ lore intake) with hash-redirects to their new homes — no tools menu, no dead nav entries.
- **Connection chip: 3 states** (live / stale-by-index-age / off) **+ a distinct sync-error badge** — "chip carries state, panel carries why." Launcher (34.4) is single-instance, health-check-first; first-run with no worlds lands on Create-World; a missing `ANTHROPIC_API_KEY` never gates launch (a notice, not a block).
- **Primary nav stays visually distinct** from in-page Prep|Run / Page|Cards controls — a UX-persona note against confusing the top-level surface switch with a page-local mode toggle.
- **Panel dismiss: Esc + click-outside**, standard modal-adjacent convention, no exceptions.
- **Chronicle-specific adoptions** (Phase 37 territory, recorded here for continuity since they were decided in the same persona round): entry point rides Wrap-up ("N threads waiting — pass time now?" → Composer pre-checked); default scope = queued intents only; branch scope = existing `contained-in` mode; duration is one source of truth (drives both calendar advance and `elapsedSessions` decay); one global fortune track now (per-branch fortune deferred); tray XP = literal CR→XP arithmetic, no verdict language (Encounter Builder remains the difficulty tool); Hero conditions = one-click always-visible, ratings/notes behind a click; Run mode hides the Chronicle route and collapses the connection chip to state-only.
- **Noted-not-adopted (future, explicitly out of scope):** tag-first Bestiary filtering; "everywhere-except-party" scope (a post-filter gap, flagged for a later phase, not silently dropped).

---

## §4. Pre-specified route/store contract (copied verbatim from `plans/phase-34-tasks.md`)

The single reference both 34.0's e2e contract (`phase34-fixture.mjs` §4) and 34.1's implementation build against, so a drift between the two documents is visible at a glance:

- `GET /api/foundry/connection?world=` → `{state:"live"|"stale"|"off", exportedAt, ageMs, staleThresholdMs, counts:{actors,items,scenes,journals}|null, lastSync:{at,ok,error?}|null, world}`. Derivation: `off` = no readable foundry-index; `stale` = index `exportedAt` older than threshold (default 15 min, overridable via settings); else `live`. `counts` from the index arrays. `lastSync` from a small per-world sync-log the sync route writes.
- `POST /api/foundry/sync-now {world}` → `{pulled:{bestiaryProposed,partyProposed,alreadyLinked}, indexAgeMs, state}` — composition: read index (do NOT block on Foundry being up; if index missing → `{state:"off"}` with a clear message) → `pullFoundryActorsToStores` → append the sync-log entry. (Reindex triggering stays Foundry-side via `api.reindexForGmTools()`; the route documents that.)
- Settings store `session-planner/app-settings.mjs` (per-world JSON, env `GM_TOOLS_APP_SETTINGS_DIR`, SCHEMA_VERSION): `{campaignName, gameSystem, calendar, proseModel, imageModel, staleThresholdMs}` — all optional strings/nums. Routes `GET/POST /api/settings?world=` (POST = patch). Only `campaignName` + `calendar` + `staleThresholdMs` are WIRED this phase; model rows stored-not-wired (flagged in UI copy).
- `POST /api/lore/worldanvil {world, url}` → server-side fetch of the URL (plain `fetch`, text/html → strip to text, cap at `MAX_WRITEUP_CHARS`) → delegate to `importWriteup` → same `{batchId, mutationCount, importSummary, headline}` shape as `/api/writeup-propose`. A paste route ALREADY exists (`/api/writeup-propose`) — the panel uses it for paste mode.
- `POST /api/graph/nodes/:entityId/remove-reparent-up {world}` → the 34.3 hybrid delete: reparent every containment-child to the node's parent (or unparent if none) THEN delete the node cascading its remaining edges — ONE atomic undo slot → `{entityId, reparentedChildren, droppedEdges}`. (Composes `reparentNode` + `deleteNodeOp` internals in `manual-edit-ops.mjs`.) The existing `remove-from-scenes` route is reused unchanged for the opt-in.

**Status at 34.0's own verification time (2026-08-08):** all five routes above were found ALREADY LANDED (34.1 ran concurrently in the same working tree and completed first) — confirmed genuinely 200/wired, not a stale guess, via `review-ui/test/e2e/phase34-nav-connection.e2e.mjs`'s and `phase34-delta-fixes.e2e.mjs`'s own route-level tests, which assert the FULL contracted shape above (not a tolerant 404-or-200 check) and pass. See the completion report for the exact assertions and observed responses.

---

## §5. QE contract this doc grounds

`review-ui/test/e2e/phase34-fixture.mjs` (the full DOM/route contract, testids chosen + documented) + `phase34-nav-connection.e2e.mjs` (4-way nav, Connection Menu chip/panel, `#settings`/`#import` redirects, route-level §4 pins) + `phase34-delta-fixes.e2e.mjs` (D4 named prev/next, D5–D8 hybrid remove-from-graph, D9/D10/D12 cosmetics). `phase33-remove-from-graph.e2e.mjs` is trimmed in the same commit — its five UI-level tests are retired-as-superseded by the HYBRID contract's own D5–D8 tests (its header now documents exactly what moved where and why); its one route-level test (`remove-from-scenes`, unchanged) is kept.
