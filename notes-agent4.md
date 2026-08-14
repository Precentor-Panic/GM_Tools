# Agent 4 handoff — W5 World tab structure (COMPLETE, incl. the W5d stretch)

All four tasks implemented, tested, and committed on `friction-wave-1`,
one commit per task:

| Task | Commit | Summary |
|------|--------|---------|
| W5a | `f59fbe1` | Containment hygiene, both halves. **Import**: `normalizeProposalContainmentDirection` (writeup-import.mjs), a deterministic pass run LAST in `normalizeProposalAgainstSnapshot` (after W2b/W2a, so endpoint names are already canon when the snapshot type-lookup runs). Confident flips only: parent-first labels ("contains"/"has"/"houses"…, the exact "Kilmarn has five quarters" shape) and label-less place→object/person type asymmetry; child-first labels ("located in"/"kept…"/"stands at…" — the real kilmarn labels) confidently keep. Low confidence (conflicting label, place-"inside"-faction/event/concept — the real lending-house→Fate-threads pollution was a mis-TYPED edge, so never auto-flipped) leaves direction ALONE and tags `containment-direction-uncertain`, via the same `entityContext.writeupNormalization` channel W2a/W2b use (edge mutations now carry `entityContext` when tagged; grain.mjs already surfaces it; proposal-card renders both new kinds). A flipped edge's free-text `label` is deliberately NOT rewritten — the card note explains instead. **Render**: tree derivation extracted to NEW DOM-free `review-ui/public/world-tree.mjs` (world-view.js touches `document` at import time, so this is what makes it unit-testable); `buildDerived` now detects parent-link cycles and breaks each (derived maps only, data never mutated) at a deterministic representative (first member by case-insensitive name → "Kilmarn" roots the real cycle), rendering the whole branch AT ROOT with a `⚠ cycle` badge naming the loop (`world-tree-cycle-badge`). Loyalty derivation inherits the protection. |
| W5b | `52e7ecd` | Rail redesign. New `.wv-subbar` under the World header (Library subbar chrome, 42px hairline, via --sp-* tokens): rail selector **Spatial \| Loyalty \| Graph** + "search the world" + the six icon type chips, both moved DOWN from the shell topbar's world slot (`mountWorldTopbar` removed; `clearWorldTopbar` still exported for app-shell). The old in-tree-head toggle — the one that clipped to "Spatial/Loya" — is gone; the clipping complaint dies with it. Rail selector keeps phase38's testids (`wv-tree-mode-toggle`/`-spatial-btn`/`-loyalty-btn`, aria-pressed contract) so `phase38-loyalty.e2e.mjs` passes UNCHANGED; new `wv-rail-graph-btn`. Left tree menu keeps "Where things are" / "+ add" / collapse-expand all. Graph mode mounts graph-view.js's `renderGraph` (the SAME shared implementation as the standalone Graph nav view, never a fork) over the already-cached world graph — per-world layout cacheKey `world-rail:<world>`, zoom/pan/popovers live; search+chips narrow BOTH tree and graph bodies. |
| W5c | `8f45e48` | World-name guard, non-blocking everywhere. `worldNameCollisionsForBatch(batch, worldId)` in mutation-ops.mjs (read-time, never persisted — same convention as nearMatches/triage), spread by `batchDetailPayload` as `worldNameCollision` (extending the ONE annotation path, per Agent 1's rule). proposal-card: subtle dashed "shares the world's name" header tag (`proposal-card-world-name-tag`). World tab: quiet `≙ world` marker on the entity's tree row (`world-name-marker`) + detail header (`world-name-marker-detail`) — deliberately quieter than the cycle badge. Case-insensitive; catches nameless updates via `entityContext.name`; clears once a row settles. |
| W5d | `c14c39e` | STRETCH BUILT. One-hop local graph in the detail pane — the only piece of round-3 item 6's panel that didn't already exist there (title/description/develop-hook/contents/action-buttons/loose-threads all predate this wave). Selected entity centered, neighbors on a radial ring (cap 12, "+N more" note), edges color-coded by relationship type via the shared `colorForType` hash, midpoint type labels + matching legend; neighbor click selects (`#world/<id>`). Tiny bespoke radial layout by design — NOT graph-view's force layout (nothing worth caching for a per-selection one-hop view). Edge EDITING deliberately not duplicated here (inspector "Tied to" ✕ + standalone Graph view already own it). |

## Test status

- **review-ui deterministic**: 315/315 (was 307 at Agent 3's handoff).
  New: `w5a-world-tree.test.mjs` (6 — the Kilmarn↔Underbreach regression
  **verified failing against the pre-fix builder**: with the cycle handling
  disabled, 4 tests fail with the exact silent-vanish symptom, then pass
  restored), `w5c-world-name-guard-routes.test.mjs` (2, incl.
  accept-never-blocked + advisory clearing on settle).
- **root**: 100/101 — the ONE failure is still the pre-existing, documented
  `test/combat-planning/snowball-delta.test.mjs` (confirmed at my baseline;
  untouched; W6c's to triage). New: `test/containment-direction.test.mjs`
  (8 — the real "Kilmarn has five quarters" flip, the real kilmarn
  child-first labels kept untagged, type-asymmetry flip, both uncertain
  cases, conservatism negatives, combined-pass ordering, and an importWriteup
  end-to-end proving the STORED edge mutation carries the flipped
  sourceId/targetId + the surfaced record).
- **wf-mcp-server**: 41 files / 43 tests, all pass. New:
  `world-name-guard.test.mjs` (3).
- **e2e (real headless Chromium, run in isolation per the standing flake
  note)**: NEW `w5a-cycle-render.e2e.mjs` (2 — cyclic fixture renders,
  nothing vanishes, badge on the representative + child indents under it),
  `w5b-world-rail.e2e.mjs` (5 — sub-bar + EMPTY shell-topbar slot + old
  toggle gone, Spatial→Graph→Spatial with both bodies genuinely mounting,
  search/filters from the new bar in tree AND graph modes, Loyalty
  reachable), `w5c-world-name-guard.e2e.mjs` (2), `w5d-local-graph.e2e.mjs`
  (2 — computed edge-stroke === legend-swatch color per type, neighbor
  click navigation, no-edges → no section). Affected-surface files re-run
  in isolation after EVERY task, all green: phase30-world-surface 7,
  phase30-shell 7, phase31-interactions 5, phase33-remove-from-graph 1,
  phase33-world-drop-to-planner 2, phase34-delta-fixes 12 (incl. the D9/D10
  chip/search pins, now asserting against the sub-bar copies),
  phase38-loyalty 4 (UNMODIFIED — the rail selector honors its testid
  contract), qa-w1-world-empty-add 3, qa-w1-fix4 1, w3-scene-map 4
  (Agent 3's tray chips intact), phase37-review-green-guard 4,
  phase37-chronicle-surface 7, w1-review-cluster 6, w1f 2,
  w2-normalization-notes 1. Did NOT run the full ~70-file suite (same
  parallel-load-flake reasoning as Agents 1–3).
- **Visual checks** (repo culture): spatial mode + graph mode + the W5d
  panel screenshotted and inspected — sub-bar layout matches Russell's
  request; cycle badge visible in-tree; W5d panel order matches his own
  top-to-bottom list.
- Real kilmarn data: READ ONLY throughout (modeled fixtures on the now-clean
  snapshot; never mutated).

## Stubbed / rough (for Russell's Designer pass)

1. **W5b Graph mode popovers are READ-ONLY** (name/type/meta + "Develop
   this node →" to the standalone entity page). No `editable` wiring — no
   node/edge edit/delete/edge-drawing in the World tab's graph mode. The
   standalone Graph nav view keeps the full manual-edit surface; duplicating
   the six edit callbacks + undo plumbing here was judged disproportionate
   for a rough pass. Wiring it later = pass `editable: true` + the six
   app.js handler equivalents into `renderWorldGraph()` (world-view.js).
2. **The whole W5b surface is rough-by-design** — mimics the Library subbar
   idiom with existing tokens. Per the Designer→Wire model this surface
   wants a `.dc.html` from Claude Designer as source of truth; everything is
   behind testids so a reskin won't break the pins.
3. **W5d cosmetic nit**: on a vertical edge the midpoint type label can
   overlap the center node's name label (seen in the screenshot; legend
   disambiguates). A Designer pass or a perpendicular label offset fixes it.
4. **W5a flip keeps the original free-text edge label** ("has five
   quarters" survives on the flipped edge). Deterministic label rewriting
   was judged riskier than the visible card note. The World tree never
   shows labels, so impact is graph-popover-only.
5. **W5a import pass covers the writeup-import path only** (where the real
   bug happened). Mention-scan/manual edges don't run it — manual edges are
   human-authored (and reparentNode always writes the right direction);
   flagged in case a future producer emits containment edges.

## Warnings for Agent 5 (W6)

1. **`review-ui/server.mjs`**: my only change is inside `batchDetailPayload`
   — a `worldNameCollisionsForBatch` call + one spread onto rows. The
   single-annotation-path rule stands.
2. **`app-shell.js` untouched** — Agent 3's `fillRunsheetRows` map chip and
   everything else is exactly as they left it. The rail redesign lives
   entirely in world-view.js/style.css.
3. **`world-tree.mjs` is the tree-derivation source of truth now**
   (`buildDerived`/`LOYALTY_PARENT_EDGE` + `cycleBreaks`). world-view.js
   imports from it; don't re-add a local copy. Its `cycleBreaks` is a
   `Map<representativeId, {memberIds, memberNames}>` — the derived maps are
   already broken/render-safe when you receive them.
4. **The shell topbar's world slot (`#shell-world-topbar-slot`) is now
   always empty** — world-view clears it on mount and app-shell still
   clears it on leaving. If W6 wants topbar real estate, the slot is free,
   but don't re-home the world search there (Russell explicitly moved it
   down).
5. **W6b SKILL.md rewrite**: no new MCP tools from W5 (deliberate). The
   review-ui surface gained no new routes either — W5c rides the existing
   batch-detail payload. Nothing W5 adds needs SKILL.md coverage beyond the
   World-tab UI description if you document surfaces.
6. **W6c final sweep numbers**: root 100/101 (`snowball-delta` pre-existing,
   still unfixed — it was Agents 1–3's baseline too), review-ui
   deterministic bar is now **315**, wf-mcp-server **41 files/43 tests**.
   My four e2e files (w5a/w5b/w5c/w5d) are fast (~2s each) and safe for any
   sweep — but as with everything, re-run in isolation before calling a
   parallel-load failure real.
7. Standing items inherited from Agents 1–3 still apply (chronicle-view TDZ,
   `rejectMutationIds` cascade, batchDetailPayload single path, e2e
   parallel-load flakes). None of my changes touch those surfaces beyond
   the noted batchDetailPayload extension.
