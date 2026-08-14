# Agent 3 handoff — W3 scene↔map association + W4 Plutonium source layer (COMPLETE)

All six tasks (W3a–W3c, W4a–W4c) implemented, tested, and committed on
`friction-wave-1`, one commit per task:

| Task | Commit | Summary |
|------|--------|---------|
| W3a | `f686324` | `stagecraftAsset.src` — additive-optional file-path/URL field (null default, kilmarn's records read as null), status-INDEPENDENT `updateStagecraftAssetSrc` patch (bestiary note/rating convention, NOT the proposed-only re-ingest guard), hand-add accepts it, NEW `POST /api/session-planner/stagecraft/:id/src` edit route, Stagecraft shelf renders a click-to-edit src line (Foundry-pulled assets show `foundryRef.imagePath` as a read-only hint). DISTINCT from Phase 36's `localFilePath` (outside-dataDir file the flush composer copies in): `src` is Foundry-resolvable, used as-is — both fields documented against each other in stagecraft-store.mjs's header. |
| W3b | `73d87c6` | `scene.mapAssetId` — additive-optional on the Scene record; joins `updateScene`'s patch vocabulary; **inherited by forkScene** like locationEntityId (same place → same map), deliberately unlike foundrySceneRef/stagedForFoundry. Cross-store validation AT THE ROUTE (scenes.mjs stays pure): unknown asset or non-`map` kind → clean 400, nothing written. UI chips: scene page gets an ALWAYS-visible map chip (`scene-map-chip`, green `data-has-map="true"` when linked, muted "No map linked" otherwise — absence is visible, not inferred) + a picker (`scene-map-picker`) over existing map assets showing name — src; scene tray rows (Library + World) get a `scene-tray-map-chip` glyph; run-sheet rows get `planner-runsheet-map-chip`. Edit affordance hidden in Run mode. |
| W3c | `10476dd` | `pushSceneToFoundry`'s `mapSrc` is now an OPTIONAL override — defaults from `scene.mapAssetId` → `asset.src`, else `asset.foundryRef.imagePath`; explicit mapSrc always wins; neither resolves (no link / dangling link / pathless asset) → clear error naming both fixes (still matches the old tests' `/mapSrc/`). Header's "caller-supplied for now" doc replaced. ALSO additive: the flush composer's `resolveAssetSrc` gained the `src` middle tier (imagePath > src > localFilePath-copy) — byte-identical for pre-W3a records. Route comment updated; `POST /api/foundry/push-scene` no longer requires mapSrc. |
| W4a | `a9a5662` | `combat-planning/plutonium-source.mjs` — READ-ONLY indexer of `<dataDir>/modules/plutonium/data/bestiary/bestiary-*.json` (dataDir always via resolveDir()/WF_DATA_DIR at the route, never client-supplied). Compact rows: name/source/page/cr(+crNum)/type/tags/size/ac/hp/environment/legendary; handles cr string|{cr}, type string|{type,tags}, ac array-of-number|{ac}, hp.average, skips `_copy` reprint shells and corrupt files. Coarse cache: dir mtimeMs + bestiary file count (`clearPlutoniumIndexCache()` is the test seam). Graceful `{installed:false}`. Route `GET /api/combat-planning/plutonium` — server-side query/CR-range/type/source filter + offset/limit window (default 50, cap 500) + whole-index facets. Verified read-only against the REAL install: 127 files / 4,126 creatures / 191ms cold / cached instant; Arcanaloth MM p313 CR 12 (the friction note's own finding). |
| W4b | `eb0b0a9` | "Available via Plutonium" shelf in the Bestiary tab, BELOW the curated grid, never mixed into its data (the hard rule; read-only proven by test). Distinct rust "Plutonium" `SOURCE_PILL`, text search (debounced), CR min/max (CR ladder), type/source facet dropdowns, windowed 50-row pages + "Show more" (the 4k index never lands in the DOM at once), "Plutonium isn't installed" empty state. Testids: `plutonium-shelf`, `plutonium-row`, `plutonium-search-input`, `plutonium-cr-min/max`, `plutonium-type-filter`, `plutonium-source-filter`, `plutonium-show-more-btn`, `plutonium-not-installed`. |
| W4c | `d9dbde5` | `POST /api/combat-planning/bestiary/add-from-plutonium {name, source}` — the ONE bridge onto the curated shelf: ACCEPTED entry (hand-add reasoning), real stats in rawFields, "SOURCE pPAGE via Plutonium" as note AND sourceText; `deriveSourcePill` gained the `plutonium` branch (after foundry/reskin, BEFORE srd). Dedupe guard: same (name, source) → 409 ("already exists" → statusForError), discarded copies don't block a re-add. UI: `plutonium-row-add-btn` → success re-renders Bestiary (curated card shows the Plutonium pill); already-added rows show `plutonium-row-on-shelf`. Button title + shelf blurb both state: importing the actor into Foundry stays a manual Plutonium act at prep time. |

## Test status

- **review-ui deterministic**: 307/307 (`npm test`; was 285 at Agent 2's
  handoff). New files: `w3a-stagecraft-src-routes` (5),
  `w3b-scene-map-link-routes` (5), `w3c-push-default-mapsrc-routes` (4,
  incl. a real captured-op round trip), `w4a-plutonium-index-routes` (4),
  `w4c-add-from-plutonium-routes` (4).
- **wf-mcp-server**: 40/40 files (`npm test`).
  `foundry-push-ops.test.mjs` +7 (W3c defaults/override/imagePath tier/
  dangling link/error copy + the composer's src tier).
- **root**: 92/93 — the ONE failure is the pre-existing, documented
  `test/combat-planning/snowball-delta.test.mjs` (untouched; still W6c's to
  triage). New: `test/combat-planning/plutonium-source.test.mjs` (11);
  `test/session-planner/stagecraft-store.test.mjs` +4 and
  `scenes.test.mjs` +3 (incl. explicit legacy-record back-compat tests that
  delete the new keys from disk and re-read).
- **e2e (real headless Chromium, run in isolation per the standing flake
  note)**: NEW `w3-scene-map.e2e.mjs` (4/4 — no-map chip visible → picker
  link persists → tray glyph chip → push with NO mapSrc composes the
  defaulted background.src, captured+answered by a fake watcher, no live
  Foundry) and `w4-plutonium-shelf.e2e.mjs` (4/4 — fixture module dir:
  shelf+pill+read-only guarantee, server-side search, add-to-shelf landing
  a store-asserted accepted entry with the Plutonium pill + "on shelf"
  flip, manual-import copy). Affected-surface files re-run in isolation,
  all green: phase36-stage-route-and-ui 6/6, phase36-stage-dressing 4/4,
  phase36-flush-ops-shapes 6/6, phase36-pull-imagepath 2/2,
  phase30-planner-scene 17/17, phase30-plan-runsheet 8/8,
  phase35-scene-tray 6/6, phase35-tagged-shelf 10/10,
  phase35-library-tabs + phase37-6b-bestiary-library 17/17,
  phase38-catalog-tier 1/1, phase38-import-on-accept 3/3,
  phase38-pull-extension 3/3. Did NOT run the full ~70-file suite (same
  parallel-load-flake reasoning as Agents 1/2).
- **Real kilmarn data (READ ONLY, verified, never mutated)**: all 9 scenes
  + all 193 stagecraft assets load through the updated stores; every legacy
  record reads `mapAssetId`/`src` as null; `isSceneDirty` evaluates over
  the real records; both files byte-identical before/after. The "MAP: ..."
  objectiveNote workaround lines are untouched (obsolete going forward,
  never migrated — deliberately).

## Skipped / deferred (deliberate)

- **Quiet-flush composer still sources `background` from TRAY roster map
  assets, not `scene.mapAssetId`.** W3c's scope was the push-scene route's
  default; re-pointing `composeSceneOps` at the scene link would change
  phase36's pinned flush contract (§5 roster-first-map + skip reasons).
  Flagged as a natural follow-up: prefer `scene.mapAssetId` in
  `composeSceneOps`, falling back to the roster scan.
- **No data migration of kilmarn's workarounds** (desc-paths → src,
  "MAP:" lines → mapAssetId). The stores now support the real thing going
  forward; rewriting Russell's live records was explicitly out of scope
  ("never mutate the real kilmarn stores").
- **No MCP tool surface** for any of this (per scope; W6b is rewriting
  SKILL.md to the real HTTP surface anyway — the new routes belong in that
  rewrite: stagecraft `:id/src`, scene patch `mapAssetId`, push-scene's
  now-optional mapSrc, `GET/POST` plutonium routes).
- **Scene create route** doesn't take mapAssetId (store-level createScene
  does); the patch route is the linking path, per the task text.

## Warnings for Agent 4 (W5, world-view/app-shell) and Agent 5 (W6)

1. **`app-shell.js` (shared with W5b's rail redesign)**: my only change is
   inside `fillRunsheetRows` — a lazy `mapAssetName` lookup + the
   `planner-runsheet-map-chip` span appended to each row's `metaLine`. If
   the rail redesign rebuilds runsheet rows, keep (or consciously move) the
   chip; `w3-scene-map.e2e.mjs` does NOT pin the runsheet chip (only the
   scene page + tray), so a redesign won't trip my e2e — check it visually.
2. **`review-ui/server.mjs` route groupings**: W3a's src route sits with
   the stagecraft block (~line 3130), W3b's validation lives inside the
   EXISTING length-4 scene patch route (~line 2030 — don't add a second
   scene-patch path), W4a/W4c sit together right after the bestiary
   accept/discard block (~line 2185). `statusForError` untouched — note the
   long-standing quirk (documented in phase36-stage-route-and-ui.e2e.mjs):
   "No scene found"/"No stagecraft asset found" are 400s, not 404s, by
   established convention.
3. **`scene-tray.js` rows** now render a map glyph chip off
   `scene.mapAssetId` — if W5 touches the World inspector's tray mount,
   nothing extra is needed (the chip is inside the shared `sceneRow`).
4. **Plutonium shelf facet dropdowns build ONCE** from the first response's
   whole-index facets (deliberate: a dropdown that only lists what already
   matches can't widen a search). If someone adds live re-faceting, keep
   that property.
5. **`deriveSourcePill` order is now foundry > reskin > plutonium > srd >
   mine** — anything stamping `sourceText` must not casually include the
   literal phrase "via Plutonium".
6. **W6c final sweep**: root's `snowball-delta.test.mjs` failure is still
   pre-existing (confirmed at my baseline and unchanged); review-ui
   deterministic bar is now **307**, wf-mcp-server 40 files. My two new
   e2e files (`w3-scene-map`, `w4-plutonium-shelf`) are fast (~2.5s each)
   and safe to include in any sweep, but like everything else they should
   be re-run in isolation before calling a parallel-load failure real.
7. Standing items inherited from Agents 1/2 still apply (chronicle-view
   TDZ, `rejectMutationIds` cascade, `batchDetailPayload` single-path
   rule) — none of my changes touch those surfaces.
