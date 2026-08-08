// Phase 35 task 35.0 -- shared setup + THE FULL CONTRACT for the Phase 35
// "Library + sync-IN" e2e suite (phase35-library-tabs.e2e.mjs,
// phase35-tagged-shelf.e2e.mjs, phase35-scene-tray.e2e.mjs,
// phase35-pull-and-persistence.e2e.mjs). NOT itself an *.e2e.mjs file (the
// `npm run test:e2e` glob is test/e2e/*.e2e.mjs), same exemption as
// fixture.mjs/phase2N-fixture.mjs/phase30-fixture.mjs/phase34-fixture.mjs --
// every Phase 35 *.e2e.mjs file imports what it needs from here rather than
// each re-deriving the shared contract independently.
//
// THIS IS THE WRITTEN CONTRACT task 35.1 (stores + pull extensions) and 35.2
// (Library UI) implement to match -- per plans/phase-35-tasks.md's own
// instruction ("35.1 implements THE WRITTEN CONTRACT, not its own guesses"),
// 35.0 -> 35.1 is SEQUENTIAL, this file is reviewed before 35.1 starts.
// Grounded in, in order: plans/phase-35-tasks.md (the "Shapes to pin"
// section this file formalizes), .claude/plans/
// ok-i-m-back-with-dazzling-newt.md (the Phase 35 design-record section),
// design/session-planner/README.md (§H Library, §"Ported once, used
// everywhere" -- the scene tray/tagged-shelf reuse discipline) +
// Library.dc.html (pixel/DOM authority -- every shape below is cross-checked
// against its own seed-data script, not just the prose), and
// plans/phase-32-deferred.md §1 ItemRecord / §2 TokenRecord (the
// pre-designed store shapes this task reuses verbatim where noted).
//
// Every route/DOM contract below is confirmed NOT to exist yet against the
// real, current app-shell.js/server.mjs/combat-planning/session-planner
// trees (re-verified by direct read AND grep before writing this file) --
// `library-surface-root` today is Phase 34's generic placeholder scaffold
// (app-shell.js's `renderScaffoldSurface`, `SCAFFOLD_COPY.library`) with NO
// tab/creature-card/tray DOM of any kind; none of the route paths in §8/§9
// below appear anywhere in server.mjs's route table (grep-confirmed). Every
// phase35 *.e2e.mjs UI-level scenario is therefore EXPECTED TO FAIL right
// now with a Playwright selector-not-found/timeout error, and every
// phase35 *.e2e.mjs route-level scenario is EXPECTED TO FAIL with a real
// HTTP 404 (`sendJson(res, 404, {error:"No route: METHOD path"})`, server.
// mjs's own last-resort fallback). That failure is the deliverable of task
// 35.0, not a bug in these files.
//
// ===========================================================================
// §1. ItemRecord (`combat-planning/item-store.mjs`, NET-NEW store)
// ===========================================================================
// Reuses `plans/phase-32-deferred.md` §1's ItemRecord verbatim, PLUS two
// additions this task's own "Shapes to pin" section calls for:
//   - `tags: string[]`               -- the tagged-shelf's own findability
//     model (README §H "Tags are the whole findability model"), default `[]`.
//   - `kind: "item"`                 -- a FIXED, always-"item" literal field
//     (never anything else on an ItemRecord) so a Reliquary row and a
//     Stagecraft row can render through the exact SAME shared shelf
//     component keyed off one `kind` field (`Library.dc.html`'s own `KINDS`
//     map has FOUR entries -- `item`/`map`/`splash`/`music` -- all rendered
//     by the identical shelf-row markup, confirmed by direct read of the
//     prototype's `KINDS` table and its shared `shelfRows` renderer).
//
// {
//   id: string,                       // it_<ts>_<rand>, injectable opts.makeId
//   world: string,
//   kind: "item",                     // FIXED literal -- see above
//   name: string,
//   type: string | null,              // dnd5e item type pass-through ("weapon"|"equipment"|"consumable"|"loot"|"tool"|...)
//   quantity: number | null,          // item.system.quantity, typeof-guarded
//   description: string | null,       // stripHtml(item.system.description.value)
//   tags: string[],                   // NEW this phase, default []
//   foundryItemRef: string | null,    // "Item.<id>" -- the embedded item's own uuid, dedup/upsert key
//   ownerFoundryActorUuid: string | null,   // the PC actor this item was embedded on at pull time
//   ownerPartyMemberId: string | null,      // best-effort resolved link into party-roster-store.mjs
//   sourceText: string | null,        // "Pulled from Foundry actor <ownerFoundryActorUuid>, item <foundryItemRef> (<name>)."
//   status: 'proposed' | 'accepted' | 'discarded',   // same status-gate convention as bestiary/party-roster
//   createdAt: string                 // ISO 8601
// }
//
// Storage: `<itemRoot>/<world>.json`, one JSON file per world (per-world
// scope, per phase-32-deferred's own reasoning -- an item's relevance is
// scoped to the campaign whose party holds it). Default root
// `GM_Tools/items/`, override `GM_TOOLS_ITEM_DIR` (§12 below).
//
// ===========================================================================
// §2. StagecraftAsset (`session-planner/stagecraft-store.mjs`, NET-NEW store)
// ===========================================================================
// Per the task plan's own pinned shape, PLUS one addition this file pins
// (flagged explicitly -- the task-plan shape omits it, but the phase's own
// locked decision "All pulled content lands as proposals" REQUIRES a status
// gate on anything a pull can create, and `scenes[]`-derived `map` assets
// ARE pull-created per §6 below):
//
// {
//   id: string,                       // sc_<ts>_<rand>, injectable opts.makeId
//   world: string,
//   kind: "map" | "splash" | "music",
//   name: string,
//   source: "foundry" | "local",
//   meta: string | null,              // e.g. "40x30 grid" for a map -- free-form display string, not parsed back
//   desc: string | null,
//   tags: string[],                   // default []
//   foundryRef: { sceneUuid?: string, imagePath?: string, playlistId?: string } | null,
//   status: 'proposed' | 'accepted' | 'discarded',   // NEW field this file adds to the task-plan's own pinned
//                                      // shape -- required by the locked "all pulled content lands as proposals"
//                                      // decision, since a pulled `scenes[]` map ref (§6) is exactly such content.
//                                      // A hand-added row (Russell typing in a splash/music reference) may be
//                                      // created directly as 'accepted' -- same "party-roster's own default-
//                                      // accepted-unless-Foundry-pull" convention (party-roster-store.mjs header).
//   createdAt: string
// }
//
// Storage: same per-world one-file convention, `<stagecraftRoot>/<world>.json`.
// Default root `GM_Tools/stagecraft/`, override `GM_TOOLS_STAGECRAFT_DIR`.
// Music rows are HAND-ADDED ONLY this phase (locked decision -- playlists
// enter the foundry-index in a later wave); this fixture never seeds a
// pulled `kind:"music"` row.
//
// ===========================================================================
// §3. Token-index (`session-planner/token-store.mjs`, NET-NEW store)
// ===========================================================================
// Reuses `plans/phase-32-deferred.md` §2 TokenRecord VERBATIM -- no changes
// this phase (grouped with `stagecraft-store.mjs` as a sibling, per the task
// plan's own "sub-store or sibling of stagecraft" phrasing):
//
// {
//   id: string,                // tok_<ts>_<rand>
//   world: string,
//   sceneUuid: string,          // the Foundry Scene uuid this token was placed on at capture time
//   sceneId: string | null,     // best-effort link into session-planner/scenes.mjs via foundrySceneRef; null
//                               // on a first-ever pull for any scene GM_Tools has never pushed (the common case)
//   name: string,
//   x: number | null,
//   y: number | null,
//   actorUuid: string | null,   // joins live against bestiary/party-roster's own foundryActorRef -- NOT pre-resolved
//   img: string | null,
//   capturedAt: string          // the index's own exportedAt this token was read from
// }
//
// Deliberately NO status/review-gate (a positional fact, not authored
// content -- per-scene REPLACE semantics on every pull, not upsert, per
// deferred §2's own reasoning: `PlacedToken` has no stable id).
// Storage: `<tokenRoot>/<world>.json`. Default root `GM_Tools/tokens/`,
// override `GM_TOOLS_TOKEN_DIR`.
//
// ===========================================================================
// §4. Tags helper API (ONE shared module, reused by item + stagecraft
//     (+ bestiary, additive-safe))
// ===========================================================================
// DECISION (open in the task plan, pinned here): lives at
// `combat-planning/tags.mjs` -- combat-planning/ already hosts 2 of its 3
// consumers (item-store.mjs, and bestiary-store.mjs if a future task wires
// bestiary tags); session-planner/stagecraft-store.mjs imports it
// cross-directory (`../combat-planning/tags.mjs`). No existing precedent
// governs this specific direction (grep-confirmed: neither directory
// imports from the other today), so this is a NEW but harmless precedent --
// flagged in this task's own completion report rather than silently
// invented. PURE functions, no I/O, operate on a plain array-of-taggable-
// records + know nothing about which store called them:
//
//   addTag(records, id, tag) -> records'      // trims tag, no-op (returns records unchanged) if already present
//                                              // or tag is empty/whitespace-only; the CALLER still persists the
//                                              // returned array via its own store write function.
//   removeTag(records, id, tag) -> records'   // no-op if the record or tag isn't present
//   tagIndex(records) -> {tag: count}          // every distinct tag across `records` (untagged records
//                                              // contribute nothing), counts records carrying it -- the
//                                              // left-rail "N" next to each tag chip.
//   filterByTagsAnd(records, tags[]) -> records'  // AND semantics: a record must carry EVERY tag in `tags[]`
//                                              // to survive (README §H: "selected tags AND together").
//
// Route-level, these are exposed as the mutation routes in §8 below (POST/
// DELETE .../tags[/:tag]) -- item-store.mjs/stagecraft-store.mjs each wrap
// addTag/removeTag around their own read-modify-write persistence, mirroring
// every other store's own "pure helper + a thin persisting wrapper" split.
//
// ===========================================================================
// §5. Bestiary/party additive fields (SCHEMA-bump-free -- additive-only,
//     matching bestiary-store.mjs's own already-documented convention)
// ===========================================================================
// Per bestiary-store.mjs's own header comment (already the established
// precedent for THIS exact store): "an ADDITIVE optional field on an
// existing flat-JSON shape needs [no SCHEMA_VERSION bump]." Every field
// below is optional/nullable with a safe default read via `?? fallback` at
// the read site (or a lazy migrate-on-read default, matching prior additive
// bumps in this project e.g. Phase 32's `foundryActorRef`) -- NOT a new
// required field, so every pre-Phase-35 entry keeps loading unmodified.
//
// BestiaryEntry gains:
//   note: string | null                        // free-form GM note, default null
//   rating: string | number | null             // user's own star/CR-override value (mirrors the design's
//                                               // `ratings[c.id]` map -- "at my table" stepper); null = "use
//                                               // the book value" (`rawFields.challengeRating`/`ratingBook`)
//   sourcePill: "foundry" | "mine" | "srd"      // DERIVED, not stored -- computed at read time:
//                                               // foundryActorRef != null -> "foundry"; sourceText contains
//                                               // "SRD"/sourcePdfName flags an SRD import -> "srd"; else "mine"
//                                               // (this field is a read-time projection, matching the design's
//                                               // own `source` field on the seed-data creature objects, which
//                                               // was never a persisted column there either -- 35.1 implements
//                                               // this as a pure function of already-stored fields, NOT a
//                                               // fifth persisted status value)
//
// PartyMember gains:
//   passive: number | null                     // passive Perception (or whichever skill the design's own
//                                               // `p.passiveText` cell shows) -- additive, default null
//   conditions: string                          // free-form, one-click-editable (design: "conditions =
//                                               // one-click, always visible" -- NOT behind a disclosure click,
//                                               // unlike ratings/notes). Default "" (design's own "—" placeholder
//                                               // for none is a UI-layer empty-string rendering choice, not a
//                                               // stored sentinel).
//
// Both fields are patched through each store's EXISTING update-if-proposed-
// style function is the WRONG reuse here (that function refuses on
// 'accepted', but a GM editing their own note/rating/conditions on an
// already-accepted entry is exactly the kind of ongoing table-use edit this
// field exists for) -- 35.1 must add a SEPARATE, status-independent
// `updateBestiaryEntryNote`/`updateBestiaryEntryRating` (bestiary) and
// `updatePartyMemberPassive`/`updatePartyMemberConditions` (party-roster)
// pair that patches regardless of status, mirroring `updateBestiaryEntryScore`'s
// own existing "no status check" convention (bestiary-store.mjs:218) rather
// than `updateBestiaryEntryRawFields`'s proposed-only guard.
//
// ===========================================================================
// §6. Pull-mapper extension outputs (folded into the EXISTING
//     `POST /api/foundry/pull-actors` composition -- NOT a new route)
// ===========================================================================
// `pullFoundryActorsToStores` (wf-mcp-server/lib/foundry-pull-ops.mjs) grows
// to also read `index.scenes[]` (already present on every index per the
// bridge contract §1.3 -- today's implementation reads ONLY `index.actors`)
// in the SAME pass. Response shape gains three new keys alongside the
// EXISTING `bestiaryProposed`/`partyProposed`/`alreadyLinked`/`skippedActors`
// (all four of which are UNCHANGED -- this is a strictly additive response
// shape, confirmed against foundry-pull-ops.mjs's own current JSDoc return
// type before writing this):
//
//   itemsProposed: object[]      // ItemRecord[] -- one per actors[].items[] entry belonging to a
//                                 // classifyActor(...)==="pc" actor (deferred §1's own scope rule --
//                                 // a monster's items[] feeds bestiary attack-derivation only, never
//                                 // Reliquary). owner-linked via ownerFoundryActorUuid = the PC actor's
//                                 // own uuid; ownerPartyMemberId resolved against the SAME pass's own
//                                 // upsertPartyMember result (deferred §1's "one click populates
//                                 // bestiary + roster + items together" ordering).
//   stagecraftProposed: object[] // StagecraftAsset[], kind:"map" -- one per index.scenes[] entry.
//                                 // foundryRef.sceneUuid = scene.uuid; meta is a derived display string
//                                 // from width/height/grid (e.g. "4000x3000, grid 100/5ft"); a scene with
//                                 // background:null is SKIPPED (nothing to reference yet -- README §H:
//                                 // "Rows are references only... this UI exists so the right [file] is
//                                 // findable", a null background has nothing findable).
//   tokensSynced: {sceneUuid:string, count:number}[]   // one entry per distinct sceneUuid touched, via
//                                 // token-store.mjs's syncTokensForScene (§3's per-scene REPLACE, not upsert)
//                                 // -- `count` is the number of TokenRecords now on file for that scene
//                                 // AFTER the replace (so a scene pulled with 0 tokens this run correctly
//                                 // reports `count:0`, distinguishing "still has tokens from before" (n/a --
//                                 // full replace wipes them) from "genuinely empty now").
//
// `alreadyLinked` gains a THIRD key, `items: string[]` (foundryItemRefs
// skipped because their ItemRecord is already `status:'accepted'`) --
// `alreadyLinked.bestiary`/`alreadyLinked.party` are UNCHANGED.
//
// dedup/upsert for items follows the EXACT SAME three-way branch as
// upsertBestiary/upsertPartyMember (keyed on foundryItemRef, not
// foundryActorRef) -- deferred §1's own instruction, reused verbatim, not
// reinvented. stagecraft `map` assets dedup/upsert on foundryRef.sceneUuid,
// same three-way branch, one more time.
//
// ===========================================================================
// §7. Tray roster persistence (35.3 WIRES this; 35.0 SPECS it -- every
//     decision below is THIS FILE's own pin, called out explicitly per the
//     task's instruction to "decide and pin")
// ===========================================================================
// Roster shape (Library.dc.html's own seed-data + drop-handler script,
// confirmed by direct read -- `rosters: {sceneId: [{id,n,kind}]}`,
// `drop:` handler at line ~1082 of Library.dc.html):
//
//   sceneId -> [{id: string, n: number, kind: "creature" | "hero" | "asset"}]
//
// `id` semantics per `kind` (a reader resolves against the right store --
// mirrors token-store's own "actorUuid is a join key, not a pre-resolved
// cache" reasoning, §3 above):
//   - "creature" -> a BestiaryEntry.id
//   - "hero"     -> a PartyMember.id
//   - "asset"    -> EITHER an ItemRecord.id OR a StagecraftAsset.id (the
//     prototype's own `ASSETS` array unifies items+maps+splash+music under
//     ONE `kind:"asset"` tray bucket, confirmed by direct read of
//     `Library.dc.html`'s own `KINDS` table having FOUR shelf-kinds --
//     item/map/splash/music -- all routed through the identical shared shelf
//     AND the identical tray-roster "asset" bucket; a reader tries
//     item-store first, falls back to stagecraft-store, matching the
//     established "reader does the join" convention rather than a second,
//     redundant type-tag field on the roster entry itself).
//
// STACKING (Library.dc.html's own `drop:` handler, read verbatim): "creature"
// drops INCREMENT an existing entry's `n` by 1 (`cur[at].n + 1`); "hero" and
// "asset" drops always RESET `n` to 1 on a repeat drop (never stack) --
// copied exactly, not reinterpreted.
//
// STORE: NEW `session-planner/scene-tray.mjs` -- per-world, one JSON file
// per world (`<sceneTrayRoot>/<world>.json`), a flat array of
// `{sceneId, world, roster:[{id,n,kind}], xpBudget:number|null, updatedAt}`
// records, one per (world, sceneId) that has EVER received a drop or an
// explicit budget set (a scene with no tray activity simply has no record --
// `GET .../tray` returns `{roster:[], xpBudget:null}` for it, never a 404).
// Default root `GM_Tools/scene-tray/`, override `GM_TOOLS_SCENE_TRAY_DIR`.
// Reuses review-state.mjs's withLock/ConcurrentWriteError, same as every
// other store in this project.
//
// XP BUDGET DECISION (open in the task plan, pinned here): the budget number
// is PERSISTED ON THE TRAY RECORD ITSELF (`xpBudget`), NOT a new field on
// `session-planner/scenes.mjs`'s own Scene record. Reasoning: an XP budget is
// tray/encounter-prep state, not a core scene property (a scene's name/
// objective/place has nothing to do with it), and keeping it on the NEW
// tray store avoids touching the EXISTING scenes.mjs/updateScene contract at
// all this phase (smaller, safer diff -- no existing consumer of
// `updateScene`'s patch-key allowlist needs to change). `xpBudget` starts
// `null` (no suggested-default computation is specced this phase -- 35.2's
// own UI concern, e.g. a party-level-derived suggestion -- this store only
// PERSISTS whatever number a GM sets). The literal CR->XP arithmetic itself
// (`CR_XP` lookup table + EV*40 bridge, Library.dc.html:757-761, copied
// verbatim below for 35.2's reference) stays CLIENT-SIDE per the locked
// decision ("tray XP = literal CR→XP arithmetic ... NO verdict language") --
// no backend route computes or returns an XP total; the meter text
// "N / budget xp" is composed entirely in the browser from the roster (via
// bestiary CR/rating lookups) + this stored `xpBudget`.
//
//   const CR_XP = {"0":10,"1/8":25,"1/4":50,"1/2":100,"1":200,"2":450,"3":700,
//                  "4":1100,"5":1800,"6":2300,"7":2900,"8":3900, ...};
//   xpOf(creature) = creature.ratingLabel === "EV" ? Number(creature.rating) * 40
//                                                    : CR_XP[String(creature.rating)] || 0;
//
// CREATURE DROP -> "KEY element w/ stat" DECISION (open in the task plan,
// pinned here -- this codebase's OWN established meaning of "KEY" is
// STRICTLY `kind:'graph'` on a SceneElement, confirmed by direct read of
// session-planner/scene-elements.mjs's header comment AND
// session-planner-view.js's `buildSceneElementRow`, which glyphs/badges
// PURELY off `element.kind === "graph"`. A bestiary entry has NO graph-node
// link of any kind as of this phase -- Library.dc.html's own "Promote to a
// named world figure" affordance, which WOULD create that link, is
// explicitly flagged stored-not-wired in the task plan. So: the "graph-node
// creatures reuse attachExistingNodeAsElement" branch the task plan
// describes is FORWARD-COMPATIBLE PLUMBING ONLY this phase -- it is never
// actually exercised by 35.3's own tray-drop route, because no bestiary
// entry can carry a graph link yet. Pinned behavior for THIS phase:
//   - EVERY creature drop creates/reuses a `kind:'local'` SceneElement (via
//     scene-elements.mjs's EXISTING `createElement`, reused unchanged) whose
//     `stat` object is populated from the bestiary entry's `rawFields`
//     (ac/hp/cr/etc, whatever subset scene-elements.mjs's own stat shape
//     already models -- Phase 29's `{count,ac,hp,speed,cr,raw,foundryActor}`,
//     README.md line 185's own stat-block shape, reused verbatim, no new
//     stat fields invented here).
//   - This DOES visually/functionally behave as a "KEY" row despite
//     `kind:'local'`: Phase 29 task 29.5 ALREADY established that a local
//     element carrying a non-null `stat` renders full (not Run-mode-
//     collapsed) exactly like a graph KEY row (session-planner-view.js's own
//     `data-has-stat` attribute, read by style.css) -- this phase's "KEY
//     element" language means "carries a stat block, not Run-mode-collapsed",
//     NOT literally `kind:'graph'`. Documented here explicitly so 35.2/35.3
//     don't misread the task plan's "KEY" as requiring a real graph write.
//   - Element creation happens ONLY on the FIRST drop of a given bestiary
//     entry into a given scene (dedup: an existing scene element whose
//     `fields.bestiaryEntryId === id` is reused, matching
//     attachExistingNodeAsElement's own "return the existing one, don't
//     duplicate" precedent one layer over) -- a SECOND drop of the SAME
//     creature only increments the roster `n` (stacking, per the design's
//     own handler above) and creates NO second element (a scene's element
//     list shows "3 goblins", not three separate goblin rows -- the roster
//     is where the count of 3 actually lives).
//   - `fields.bestiaryEntryId` (a NEW, scene-element-local field, additive
//     to the existing free-form `fields` object -- scene-elements.mjs's
//     `fields` is already an open bag per-element, no schema change needed)
//     is how the dedup lookup above works, and how a future "sync stat
//     block from the bestiary entry" refresh could find its way back.
//
// HERO DROP: roster entry ONLY (`kind:"hero"`, `n` always reset to 1) --
// creates NO SceneElement of any kind ("display-only", the design's own
// phrase, taken literally: nothing about a hero drop touches
// scene-elements.mjs at all).
//
// ASSET DROP -> "scene-asset link" DECISION (open in the task plan, pinned
// here): the roster entry ITSELF (`{id, n:1, kind:"asset"}` on the SAME
// scene-tray record) IS the scene-asset link -- NO separate `sceneAssets`
// field/store is introduced. Reasoning: the roster already has to carry
// `kind:"asset"` rows for XP-meter/prop-count purposes (README §H: "heroes
// and props ... are single and cost nothing ... the tray meta reads
// 'N creatures · N heroes · N props'"), and a second, independent
// "which assets are linked to this scene" field would just be a second
// place the SAME fact could drift from the first. Creates NO SceneElement
// (assets are not graph-linkable/interactable the way an NPC element is).
// FLAGGED, not built this phase: `session-planner/scenes.mjs`'s own
// `background`/`foundrySceneRef` fields are NOT auto-populated by a
// `kind:"map"` asset drop even though that would be a natural "ready to run"
// convenience -- that's Phase 36's push-composition territory ("push to
// Foundry — ready to run"), not this phase's tray-persistence contract.
//
// ===========================================================================
// §8. NEW routes (net-new this phase)
// ===========================================================================
//   GET    /api/combat-planning/items?world=                     -> {items}
//   POST   /api/combat-planning/items/:id/accept   {world}        -> {item}
//   POST   /api/combat-planning/items/:id/discard  {world}        -> {item}
//   POST   /api/combat-planning/items/:id/tags     {world, tag}   -> {item}    (§4 addTag)
//   DELETE /api/combat-planning/items/:id/tags/:tag {world}       -> {item}    (§4 removeTag)
//
//   GET    /api/session-planner/stagecraft?world=[&kind=map|splash|music]  -> {assets}
//   POST   /api/session-planner/stagecraft/:id/accept   {world}   -> {asset}
//   POST   /api/session-planner/stagecraft/:id/discard  {world}   -> {asset}
//   POST   /api/session-planner/stagecraft/:id/tags     {world, tag}  -> {asset}
//   DELETE /api/session-planner/stagecraft/:id/tags/:tag {world}  -> {asset}
//
//   GET    /api/session-planner/token-index?world=[&sceneUuid=]   -> {tokens}   (read-only, §3)
//
//   GET    /api/scene-planning/scenes/:sceneId/tray?world=        -> {roster, xpBudget}
//   POST   /api/scene-planning/scenes/:sceneId/tray/drop  {world, kind, id}     -> {roster, xpBudget, element}
//          (`element` is the created/reused SceneElement for a "creature" drop's FIRST occurrence, else `null`)
//          -- unresolvable `id` for the given `kind` -> 404 (each underlying
//          store's own "No ... found" error message, matching
//          statusForError's existing `/not found/i` -> 404 rule verbatim).
//   DELETE /api/scene-planning/scenes/:sceneId/tray/:kind/:id  {world}         -> {roster, xpBudget}
//          (removes the roster row entirely -- mirrors the design's ✕
//          `remove` handler, a full splice, never a decrement)
//   POST   /api/scene-planning/scenes/:sceneId/tray/budget  {world, xpBudget}  -> {roster, xpBudget}
//
// Also gains (§5 additive fields, status-independent patch, see §5 above):
//   POST /api/combat-planning/bestiary/:id/note      {note}              -> {entry}
//   POST /api/combat-planning/bestiary/:id/rating    {rating}            -> {entry}
//   POST /api/combat-planning/party-roster/:id/passive    {world, passive}    -> {member}
//   POST /api/combat-planning/party-roster/:id/conditions {world, conditions} -> {member}
//
// ===========================================================================
// §9. REUSED, UNCHANGED routes (explicitly pinned so 35.2/35.3 don't
//     reinvent a second copy of any of these)
// ===========================================================================
//   POST /api/foundry/pull-actors {world}   -- SAME route/path, response
//     shape grows additively per §6 above. This suite's route-level pull
//     test hits this EXACT existing route, never a new one.
//   GET  /api/scene-planning/scenes?world=&sort=recency   -- feeds the scene
//     tray's own scene list (README §H's "filter + recency-ordered scene
//     list", Library.dc.html's `sceneTargets`) -- UNCHANGED, Phase 30's own
//     `listScenesByRecency`.
//   POST /api/scene-planning/scenes/:sceneId/elements/from-graph {world, entityId, name?}
//     (`attachExistingNodeAsElement`) -- the FORWARD-COMPATIBLE graph-linked
//     creature-drop path noted in §7 above; not exercised by this phase's
//     own fixture (no bestiary entry carries a graph link yet), reused
//     UNCHANGED whenever a future phase adds that link.
//   POST /api/scene-planning/scenes/:sceneId/elements {world, name, kind?, fields?, stat?}
//     (`createElement`) -- the actual mechanism §7's "local element + stat"
//     creature-drop path uses under the hood, UNCHANGED.
//
// ===========================================================================
// §10. UI/DOM testid contract (35.2 implements against this; every id below
//     is THIS FILE's own naming decision, following the phase34-fixture.mjs
//     precedent of "the design record leaves exact testid shapes to the QE
//     pass, pinned here so one contract exists")
// ===========================================================================
// TABS: `[data-testid="library-tabs"]` wraps `[data-testid="library-tab"]
//   [data-tab="bestiary"|"hall"|"reliquary"|"stagecraft"][data-active="true"|"false"]`,
//   each containing `[data-testid="library-tab-count"]` (mono count text,
//   the tab's own real item count, e.g. bestiary's = accepted+proposed
//   bestiary entries in this world's context -- library-wide per bestiary's
//   own scoping). Clicking a tab navigates `#library/<tab>` (bare `#library`
//   = bestiary, the design's own default `tab: "bestiary"` initial state).
//
// BESTIARY (`[data-testid="library-bestiary-root"]`):
//   - `[data-testid="library-habitat-tree"]` wraps `[data-testid=
//     "library-habitat-row"][data-habitat-id]` (graph places + the FIXED
//     "all"/"unplaced" buckets, Library.dc.html:621's own seed), each with
//     `[data-testid="library-habitat-row-count"]`. Clicking selects it
//     (filters the creature grid).
//   - `[data-testid="library-creature-grid"]` wraps `[data-testid=
//     "library-creature-card"][data-entry-id]`, each with `[data-testid=
//     "library-creature-card-name"]` / `[data-testid=
//     "library-creature-card-rating"]` (e.g. "CR 5") / `[data-testid=
//     "library-creature-card-source"]` (source pill text: srd|foundry|mine).
//     Clicking a card selects it into the stat rail.
//   - `[data-testid="library-stat-rail"][data-entry-id]` (right rail, the
//     selected creature's full stat block) wraps:
//       `[data-testid="library-rating-stepper"]` with `[data-testid=
//       "library-rating-stepper-down"]` / `[data-testid=
//       "library-rating-stepper-value"]` / `[data-testid=
//       "library-rating-stepper-up"]` (§5's `rating` field, PATCHed via
//       the note/rating routes above).
//       `[data-testid="library-gm-note"]` -- contenteditable, blur saves
//       via the bestiary note route.
//       `[data-testid="library-source-pill"]` -- §5's derived `sourcePill`.
//
// HERO'S HALL (`[data-testid="library-hall-root"]`):
//   `[data-testid="library-hero-card"][data-member-id]` wraps:
//     `[data-testid="library-hero-conditions-toggle"]` -- ALWAYS VISIBLE
//     with NO enclosing disclosure/expander element (the locked decision:
//     "Hero conditions = one-click, always visible" -- this suite asserts
//     it is both PRESENT and immediately clickable/editable on initial
//     render, with no separate "show conditions" click required first,
//     in contrast to ratings/notes which the design puts behind a click).
//     `[data-testid="library-hero-resources"]`.
//     `[data-testid="library-hero-expertise-marker"]` -- the "✦" marks a
//     `buildRelevant.expertise`-listed skill (present only on such rows).
//
// RELIQUARY (`[data-testid="library-reliquary-root"]`) + STAGECRAFT
// (`[data-testid="library-stagecraft-root"]`) -- ONE shared tagged-shelf
// component, per README §H/"Ported once, used everywhere":
//   `[data-testid="tagged-shelf-tag-rail"]` wraps `[data-testid=
//   "tagged-shelf-tag-chip"][data-tag]` each with `[data-testid=
//   "tagged-shelf-tag-chip-count"]`. Clicking toggles it into the ACTIVE
//   filter set (AND semantics -- §4's filterByTagsAnd); a second click
//   removes it. `[data-testid="tagged-shelf-clear-tags-btn"]` clears every
//   active tag at once (present only when at least one is active).
//   `[data-testid="tagged-shelf-search-input"]` -- free-text, matches name/
//   description/tags (README §H).
//   `[data-testid="tagged-shelf-row"][data-item-id][data-kind]` wraps:
//     `[data-testid="tagged-shelf-row-tag"][data-tag]`, each with a
//     `[data-testid="tagged-shelf-row-tag-remove"]` ✕ (calls the DELETE tag
//     route).
//     `[data-testid="tagged-shelf-row-add-tag-btn"]` opens `[data-testid=
//     "tagged-shelf-row-tag-input"]` (Enter commits via the POST tag route,
//     Escape cancels -- README §H's own interaction spec).
//   STAGECRAFT-ONLY: `[data-testid="library-stagecraft-kind-filter"]` wraps
//   `[data-testid="library-stagecraft-kind-chip"][data-kind="all"|"map"|
//   "splash"|"music"]`.
//
// SCENE TRAY (shared component, mounted identically on ALL FOUR Library
// tabs -- the SAME DOM subtree/testids regardless of which tab is active,
// per README's "implement once" -- this suite asserts it is present and
// behaves identically from at least two different tabs, not just one):
//   `[data-testid="scene-tray"]` wraps:
//     `[data-testid="scene-tray-search-input"]`.
//     `[data-testid="scene-tray-scene-row"][data-scene-id]`, a drop target,
//     containing `[data-testid="scene-tray-scene-row-meta"]` (mono text,
//     "N creatures · N heroes · N props") and `[data-testid=
//     "scene-tray-xp-meter"]` whose textContent matches
//     `/^\d+ \/ \d+ xp$/i` (the locked "N / budget xp" copy, LITERALLY --
//     this suite asserts textContent does NOT match
//     `/deadly|trivial|easy|hard|medium/i` ANYWHERE inside `[data-testid=
//     "scene-tray"]`'s own subtree, the explicit no-verdict-language
//     regression guard the task plan calls for).
//     `[data-testid="scene-tray-roster-chip"][data-kind][data-source-id]`,
//     one per roster row, textContent = the resolved name + (" ×" + n when
//     n>1, per the design's own `label` composition), with a `[data-testid=
//     "scene-tray-roster-chip-remove"]` ✕ child (calls the DELETE tray
//     route).
//
// ===========================================================================
// §11. This fixture's mock dnd5e-2014 data (offline, no live Foundry/real
//     wf-test-5e dependency -- 35.pre's real index, once it lands, is a
//     LATER phase's richer fixture per the task plan; this file's own mock
//     is deliberately realistic-SHAPED (cross-checked field-for-field
//     against wf-mcp-server/test/fixtures/foundry-bridge/
//     foundry-index.sample.json, the project's own existing real-shaped
//     fixture) but entirely self-contained)
// ===========================================================================
// `writeFoundryIndexFixture(dataDir, world)` writes a
// `world-fabric-foundry-index.json` containing:
//   - "Ogrekin Skirmisher" (CR 5 monster, npc) -- hp 85/ac 16, a Greataxe +
//     Handaxe weapon item each, a "Multiattack" feat (2 attacks) so
//     deriveMultiattack has real text to parse -- this IS "the CR 5 monster
//     with items" the task calls for.
//   - "Frostmaw the Undying" (CR 12 LEGENDARY monster, npc) -- hp 195/ac 18,
//     Bite + Claw weapons, a "Multiattack" feat, THREE feat items whose
//     `system.activation.type === "legendary"` (so deriveLegendaryActions
//     resolves count:3), and a "Frost Breath" feat with `system.recharge`
//     (so deriveRechargeAbilities resolves one entry) -- "the legendary".
//   - "Kestrel Windrider" (PC, character, level 5 Ranger) -- a "Ranger"
//     class item + "Longbow" weapon (combat-relevant), PLUS three genuine
//     INVENTORY items with real `system.quantity`/`system.description.value`
//     ("Potion of Healing" x3 consumable, "Bag of Holding" equipment,
//     "Rope, Silk (50 feet)" loot) -- these three are what §6's
//     itemsProposed pull-mapper test asserts against (a monster's items[]
//     never feeds Reliquary, only a PC's does, per §6's own scope note).
//   - ONE user, "PlayerOne", `characterUuid` = Kestrel's uuid (the
//     classifyActor "pc" signal) -- role 1 (PLAYER).
//   - ONE scene, "The Sunken Chantry" -- real `background.src`, `width`/
//     `height`/`grid`, and THREE placed tokens (one per actor above) --
//     "a scene with background+tokens". Top-level `tokens[]` is the SAME
//     three entries flattened with `sceneUuid` stamped (contract §1.4's own
//     "never re-derive, always flatten from scenes[].tokens" rule, followed
//     here even in a hand-authored fixture so a future contract-drift check
//     has something real to compare against).
//
// ---------------------------------------------------------------------------
// Fixture/isolation conventions -- mirrors phase30/34-fixture.mjs exactly:
// real in-process createReviewServer({port:0}), real fixture seeding via the
// actual store/API functions where the target already exists (scenes/plans/
// graph), and this file's own writeFoundryIndexFixture (a direct fs write --
// the ONLY thing being fixture-seeded here that has no "real route" to seed
// it through, since it plays the role of the Foundry-side module's own
// export, which this project's server never writes itself).
// setupPhase35Env is setupPhase34Env PLUS the FOUR new store directories
// this phase's stores introduce (§1/§2/§3/§7 above) -- same "added when
// first actually exercised" precedent every prior new store's own fixture
// predates.
// ---------------------------------------------------------------------------
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  setupPhase34Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  fetchGraphViaRoute,
  primeWorldSelection,
  reparentNodeViaRoute,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
} from "./phase34-fixture.mjs";

// ---------------------------------------------------------------------------
// §12. setupPhase35Env -- the four new store-dir env vars this phase's
// stores read (exact names are PART OF THIS CONTRACT -- 35.1's stores must
// read these exact names, mirroring every prior new store's own naming
// precedent, or this suite's isolation silently leaks across test files).
// ---------------------------------------------------------------------------
export function setupPhase35Env(prefix) {
  const { scratchDir, dataDir } = setupPhase34Env(prefix);
  process.env.GM_TOOLS_ITEM_DIR = join(scratchDir, "items");
  process.env.GM_TOOLS_STAGECRAFT_DIR = join(scratchDir, "stagecraft");
  process.env.GM_TOOLS_TOKEN_DIR = join(scratchDir, "tokens");
  process.env.GM_TOOLS_SCENE_TRAY_DIR = join(scratchDir, "scene-tray");
  return { scratchDir, dataDir };
}

// ---------------------------------------------------------------------------
// §11's mock dnd5e-2014 index -- a direct fs write (there is no "real route"
// that produces this file; it plays the role of the Foundry-side module's
// own export, per the bridge contract). Returns the exact object written so
// callers can assert against known field values without re-parsing.
// ---------------------------------------------------------------------------
export function writeFoundryIndexFixture(dataDir, world) {
  const index = {
    version: 1,
    worldId: world,
    exportedAt: "2026-08-08T12:00:00.000Z",
    actors: [
      {
        uuid: "Actor.ogrekinSkirmisher",
        name: "Ogrekin Skirmisher",
        type: "npc",
        img: "icons/creatures/humanoid/orc-armored-yellow.webp",
        ownership: { default: 0 },
        system: {
          hp: { value: 85, max: 85, temp: 0 },
          ac: 16,
          cr: 5,
          level: null,
          abilities: {
            str: { value: 19, mod: 4, save: 4 }, dex: { value: 12, mod: 1, save: 1 },
            con: { value: 17, mod: 3, save: 3 }, int: { value: 8, mod: -1, save: -1 },
            wis: { value: 11, mod: 0, save: 0 }, cha: { value: 10, mod: 0, save: 0 }
          },
          saves: { str: 4, dex: 1, con: 3, int: -1, wis: 0, cha: 0 },
          skills: { ath: { value: 1, proficient: 1, passive: 14 } },
          biography: "<p>A scarred vanguard for the warband that raided the causeway.</p>"
        },
        items: [
          {
            uuid: "Item.ogrekin-greataxe", name: "Greataxe", type: "weapon",
            img: "icons/weapons/axes/axe-battle-orange.webp",
            system: { damage: { parts: [["1d12 + 4", "slashing"]] }, attackBonus: 7, ability: "str", actionType: "mwak" }
          },
          {
            uuid: "Item.ogrekin-handaxe", name: "Handaxe", type: "weapon",
            img: "icons/weapons/axes/axe-simple-wood.webp",
            system: { damage: { parts: [["1d6 + 4", "slashing"]] }, attackBonus: 7, ability: "str", actionType: "mwak" }
          },
          {
            uuid: "Item.ogrekin-multiattack", name: "Multiattack", type: "feat",
            img: "icons/skills/melee/strike-slashes-orange.webp",
            system: { activation: { type: "action", cost: 1 }, description: { value: "The ogrekin makes two greataxe attacks." } }
          }
        ],
        effects: []
      },
      {
        uuid: "Actor.frostmawTheUndying",
        name: "Frostmaw the Undying",
        type: "npc",
        img: "icons/creatures/reptiles/wyvern-white.webp",
        ownership: { default: 0 },
        system: {
          hp: { value: 195, max: 195, temp: 0 },
          ac: 18,
          cr: 12,
          level: null,
          abilities: {
            str: { value: 23, mod: 6, save: 6 }, dex: { value: 10, mod: 0, save: 0 },
            con: { value: 21, mod: 5, save: 5 }, int: { value: 6, mod: -2, save: -2 },
            wis: { value: 14, mod: 2, save: 2 }, cha: { value: 15, mod: 2, save: 2 }
          },
          saves: { str: 6, dex: 0, con: 5, int: -2, wis: 2, cha: 2 },
          skills: { prc: { value: 2, proficient: 2, passive: 22 } },
          biography: "<p>A frost-wight elder that has not slept in three centuries.</p>"
        },
        items: [
          {
            uuid: "Item.frostmaw-bite", name: "Bite", type: "weapon",
            img: "icons/creatures/abilities/mouth-teeth-long-white.webp",
            system: { damage: { parts: [["2d10 + 6", "piercing"]] }, attackBonus: 11, ability: "str", actionType: "mwak" }
          },
          {
            uuid: "Item.frostmaw-claw", name: "Claw", type: "weapon",
            img: "icons/creatures/claws/claw-bear-paw-white.webp",
            system: { damage: { parts: [["2d6 + 6", "slashing"]] }, attackBonus: 11, ability: "str", actionType: "mwak" }
          },
          {
            uuid: "Item.frostmaw-multiattack", name: "Multiattack", type: "feat",
            img: "icons/skills/melee/strike-slashes-white.webp",
            system: { activation: { type: "action", cost: 1 }, description: { value: "Frostmaw makes two attacks: one bite and one claw." } }
          },
          {
            uuid: "Item.frostmaw-frostbreath", name: "Frost Breath", type: "feat",
            img: "icons/magic/water/orb-ice-web.webp",
            system: { recharge: { value: 5, charged: true }, description: { value: "Frostmaw exhales a 60-foot cone of frost, 12d6 cold damage." } }
          },
          {
            uuid: "Item.frostmaw-legendary-detect", name: "Detect", type: "feat",
            img: "icons/magic/perception/eye-ringed-glow-angry-large-red.webp",
            system: { activation: { type: "legendary", cost: 1 }, description: { value: "Frostmaw makes a Wisdom (Perception) check." } }
          },
          {
            uuid: "Item.frostmaw-legendary-tailsweep", name: "Tail Sweep", type: "feat",
            img: "icons/skills/melee/strike-tail-white.webp",
            system: { activation: { type: "legendary", cost: 1 }, description: { value: "Frostmaw sweeps its tail through a 10-foot radius." } }
          },
          {
            uuid: "Item.frostmaw-legendary-frightful", name: "Frightful Presence", type: "feat",
            img: "icons/magic/fear/face-fear-orange.webp",
            system: { activation: { type: "legendary", cost: 2 }, description: { value: "Each creature within 60 feet must succeed a Wisdom saving throw or be frightened." } }
          }
        ],
        effects: [{ name: "Aura of Cold", changes: [] }]
      },
      {
        uuid: "Actor.kestrelWindrider",
        name: "Kestrel Windrider",
        type: "character",
        img: "icons/creatures/humanoid/human-male-green.webp",
        ownership: { default: 0, "player-one": 3 },
        system: {
          hp: { value: 44, max: 44, temp: 0 },
          ac: 15,
          cr: null,
          level: 5,
          abilities: {
            str: { value: 12, mod: 1, save: 1 }, dex: { value: 17, mod: 3, save: 3 },
            con: { value: 14, mod: 2, save: 2 }, int: { value: 10, mod: 0, save: 0 },
            wis: { value: 15, mod: 2, save: 4 }, cha: { value: 8, mod: -1, save: -1 }
          },
          saves: { str: 1, dex: 3, con: 2, int: 0, wis: 4, cha: -1 },
          skills: {
            prc: { value: 2, proficient: 2, passive: 18 },
            sur: { value: 1, proficient: 1, passive: 14 },
            ste: { value: 1, proficient: 1, passive: 13 }
          },
          biography: "<p>A ranger tracking the warband that raided the causeway toll.</p>"
        },
        items: [
          { uuid: "Item.kestrel-ranger-class", name: "Ranger", type: "class", img: "icons/skills/trades/beast-cage-thin.webp", system: { levels: 5, identifier: "ranger" } },
          {
            uuid: "Item.kestrel-longbow", name: "Longbow", type: "weapon",
            img: "icons/weapons/bows/bow-recurve-yellow.webp",
            system: { damage: { parts: [["1d8 + 3", "piercing"]] }, attackBonus: 6, ability: "dex", actionType: "rwak" }
          },
          {
            uuid: "Item.kestrel-potion-healing", name: "Potion of Healing", type: "consumable",
            img: "icons/consumables/potions/potion-bottle-corked-fuchsia.webp",
            system: { quantity: 3, description: { value: "<p>A character who drinks the magical red fluid regains 2d4 + 2 hit points.</p>" } }
          },
          {
            uuid: "Item.kestrel-bag-of-holding", name: "Bag of Holding", type: "equipment",
            img: "icons/containers/bags/pack-leather-brown.webp",
            system: { quantity: 1, description: { value: "<p>Its interior space is larger than its outside dimensions.</p>" } }
          },
          {
            uuid: "Item.kestrel-silk-rope", name: "Rope, Silk (50 feet)", type: "loot",
            img: "icons/sundries/survival/rope-brown.webp",
            system: { quantity: 1, description: { value: "<p>Fifty feet of silk rope, coiled.</p>" } }
          }
        ],
        effects: []
      }
    ],
    users: [
      { id: "player-one", name: "PlayerOne", role: 1, characterUuid: "Actor.kestrelWindrider" },
      { id: "gm-russell", name: "Russell", role: 4, characterUuid: null }
    ],
    scenes: [
      {
        uuid: "Scene.sunkenChantry",
        name: "The Sunken Chantry",
        background: { src: "scenes/sunken-chantry.webp" },
        width: 4000,
        height: 3000,
        grid: { size: 100, distance: 5, units: "ft" },
        tokens: [
          { name: "Ogrekin Skirmisher", x: 900, y: 700, actorUuid: "Actor.ogrekinSkirmisher", img: "icons/creatures/humanoid/orc-armored-yellow.webp" },
          { name: "Frostmaw the Undying", x: 2000, y: 1500, actorUuid: "Actor.frostmawTheUndying", img: "icons/creatures/reptiles/wyvern-white.webp" },
          { name: "Kestrel Windrider", x: 500, y: 2600, actorUuid: "Actor.kestrelWindrider", img: "icons/creatures/humanoid/human-male-green.webp" }
        ]
      }
    ],
    tokens: [
      { sceneUuid: "Scene.sunkenChantry", name: "Ogrekin Skirmisher", x: 900, y: 700, actorUuid: "Actor.ogrekinSkirmisher", img: "icons/creatures/humanoid/orc-armored-yellow.webp" },
      { sceneUuid: "Scene.sunkenChantry", name: "Frostmaw the Undying", x: 2000, y: 1500, actorUuid: "Actor.frostmawTheUndying", img: "icons/creatures/reptiles/wyvern-white.webp" },
      { sceneUuid: "Scene.sunkenChantry", name: "Kestrel Windrider", x: 500, y: 2600, actorUuid: "Actor.kestrelWindrider", img: "icons/creatures/humanoid/human-male-green.webp" }
    ]
  };

  const path = join(dataDir, "worlds", world, "world-fabric-foundry-index.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(index, null, 2), "utf8");
  return index;
}

// ---------------------------------------------------------------------------
// Direct-fs seed helpers for §1 ItemRecord / §2 StagecraftAsset -- item-
// store.mjs/stagecraft-store.mjs are NET-NEW modules (35.1's own job, not
// yet buildable/importable from THIS task), so unlike every other fixture
// helper in this project (which seeds through a real, already-existing
// store function or route), there is no module to call. These two helpers
// write DIRECTLY to the exact on-disk path/shape §1/§2 above pin
// (`<GM_TOOLS_ITEM_DIR>/<world>.json` / `<GM_TOOLS_STAGECRAFT_DIR>/<world>.json`,
// a flat JSON array) -- the SAME class of deliberate exception as
// writeFoundryIndexFixture above (there is no producer to seed through yet
// because this phase's own job IS to define what that producer must write).
// 35.1 implementing item-store.mjs/stagecraft-store.mjs to read/write this
// EXACT shape is what turns a fixture seeded this way into something a real
// store round-trips correctly -- these helpers are therefore also a passive
// regression check on 35.1's own file-format fidelity, not just a UI-test
// convenience.
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

/** Fills in §1's ItemRecord defaults; pass only the fields a test cares about. */
export function makeItemRecord(overrides = {}) {
  return {
    id: `it_test_${Math.random().toString(36).slice(2, 8)}`,
    world: "unset",
    kind: "item",
    name: "Unnamed Item",
    type: null,
    quantity: null,
    description: null,
    tags: [],
    foundryItemRef: null,
    ownerFoundryActorUuid: null,
    ownerPartyMemberId: null,
    sourceText: null,
    status: "proposed",
    createdAt: nowIso(),
    ...overrides
  };
}

/** Writes `records` (full ItemRecord objects, e.g. from makeItemRecord()) verbatim to `<GM_TOOLS_ITEM_DIR>/<world>.json`. */
export function seedItemRecords(world, records) {
  const root = process.env.GM_TOOLS_ITEM_DIR;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${world}.json`), JSON.stringify(records, null, 2), "utf8");
}

/** Fills in §2's StagecraftAsset defaults; pass only the fields a test cares about. */
export function makeStagecraftAsset(overrides = {}) {
  return {
    id: `sc_test_${Math.random().toString(36).slice(2, 8)}`,
    world: "unset",
    kind: "map",
    name: "Unnamed Asset",
    source: "local",
    meta: null,
    desc: null,
    tags: [],
    foundryRef: null,
    status: "proposed",
    createdAt: nowIso(),
    ...overrides
  };
}

/** Writes `records` (full StagecraftAsset objects) verbatim to `<GM_TOOLS_STAGECRAFT_DIR>/<world>.json`. */
export function seedStagecraftAssets(world, records) {
  const root = process.env.GM_TOOLS_STAGECRAFT_DIR;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${world}.json`), JSON.stringify(records, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Route helpers, §8 (net-new -- non-asserting on status, a non-200/404 here
// IS the expected "red for the right reason" signal) and §9 (reused-
// unchanged -- these DO assert 200, since a failure here is a genuine
// regression in an already-shipped route, not this phase's own red).
// ---------------------------------------------------------------------------

/** POST /api/foundry/pull-actors {world} -- REUSED, UNCHANGED route (§9). Asserts 200 (a real regression otherwise). */
export async function pullActorsViaRoute(base, world) {
  const res = await fetch(`${base}/api/foundry/pull-actors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world })
  });
  const body = await res.json().catch(() => null);
  if (res.status !== 200) {
    throw new Error(`POST /api/foundry/pull-actors must succeed (it's a reused, already-shipped route) -- got ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

/** GET /api/combat-planning/items?world= -- 404 until 35.1. */
export async function listItemsViaRoute(base, world) {
  const res = await fetch(`${base}/api/combat-planning/items?world=${encodeURIComponent(world)}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function acceptItemViaRoute(base, world, id) {
  const res = await fetch(`${base}/api/combat-planning/items/${encodeURIComponent(id)}/accept`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function addItemTagViaRoute(base, world, id, tag) {
  const res = await fetch(`${base}/api/combat-planning/items/${encodeURIComponent(id)}/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world, tag })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function removeItemTagViaRoute(base, world, id, tag) {
  const res = await fetch(`${base}/api/combat-planning/items/${encodeURIComponent(id)}/tags/${encodeURIComponent(tag)}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** GET /api/session-planner/stagecraft?world=[&kind=] -- 404 until 35.1. */
export async function listStagecraftViaRoute(base, world, kind) {
  const qs = new URLSearchParams({ world, ...(kind ? { kind } : {}) });
  const res = await fetch(`${base}/api/session-planner/stagecraft?${qs.toString()}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function addStagecraftTagViaRoute(base, world, id, tag) {
  const res = await fetch(`${base}/api/session-planner/stagecraft/${encodeURIComponent(id)}/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world, tag })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function removeStagecraftTagViaRoute(base, world, id, tag) {
  const res = await fetch(`${base}/api/session-planner/stagecraft/${encodeURIComponent(id)}/tags/${encodeURIComponent(tag)}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** GET /api/session-planner/token-index?world=[&sceneUuid=] -- 404 until 35.1. */
export async function listTokenIndexViaRoute(base, world, sceneUuid) {
  const qs = new URLSearchParams({ world, ...(sceneUuid ? { sceneUuid } : {}) });
  const res = await fetch(`${base}/api/session-planner/token-index?${qs.toString()}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** GET /api/scene-planning/scenes/:sceneId/tray?world= -- 404 until 35.3. */
export async function fetchSceneTrayViaRoute(base, world, sceneId) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/tray?world=${encodeURIComponent(world)}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** POST /api/scene-planning/scenes/:sceneId/tray/drop {world, kind, id} -- 404 until 35.3. */
export async function dropOnSceneTrayViaRoute(base, world, sceneId, { kind, id }) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/tray/drop`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world, kind, id })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** DELETE /api/scene-planning/scenes/:sceneId/tray/:kind/:id {world} -- 404 until 35.3. */
export async function removeFromSceneTrayViaRoute(base, world, sceneId, kind, id) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/tray/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** POST /api/scene-planning/scenes/:sceneId/tray/budget {world, xpBudget} -- 404 until 35.3. */
export async function setSceneTrayBudgetViaRoute(base, world, sceneId, xpBudget) {
  const res = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/tray/budget`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world, xpBudget })
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export {
  cleanupScratchEnv,
  createSceneViaRoute,
  createPlanViaRoute,
  addSceneToPlanViaRoute,
  fetchGraphViaRoute,
  primeWorldSelection,
  reparentNodeViaRoute,
  DESKTOP_VIEWPORT,
  IPHONE_13_VIEWPORT
};
