# Phase 32 task 32.4 — Deferred design: items/token stores, full scene push, UI surfaces

**Status: design only, not built.** This is the doc a future phase executes from without re-exploring 32.0–32.3.
Read `plans/phase-32-bridge-contract.md` (the file contract these designs extend) and
`plans/phase-32-tasks.md` first. Every schema/mapping below is grounded against what actually shipped in
32.0–32.3 — file:line references point at real code, not the original design record's sketch.

## What already exists (don't re-derive — reuse verbatim)

- **Pull transport:** `wf-mcp-server/lib/foundry-index.mjs`'s `readFoundryIndex(dataDir, world)` — reads
  `world-fabric-foundry-index.json`, tolerant of missing file / unknown fields / higher version.
- **Pull mappers:** `combat-planning/foundry-actor-mapper.mjs` — `classifyActor(actor, users)` (`"pc"|"monster"`),
  `mapActorToBestiary(actor)`, `mapActorToPartyMember(actor)`, plus reusable helpers `stripHtml`,
  `deriveAttacksFromItems`, etc. **Not currently exported** (module-private) — items 1 below needs `stripHtml`
  exported, noted there.
- **Pull orchestration + upsert pattern:** `wf-mcp-server/lib/foundry-pull-ops.mjs`'s `pullFoundryActorsToStores`
  — the `foundryActorRef`-keyed upsert (`accepted` untouched, `proposed` updated in place, else created) is the
  pattern both new stores below MUST reuse verbatim, not reinvent.
- **Push transport:** `wf-mcp-server/lib/foundry-ops.mjs`'s `writeFoundryOps` (write ops batch + poll
  `world-fabric-foundry-results.json`, `FoundryOpsInFlightError` on a still-in-flight batch) and
  `wf-mcp-server/lib/foundry-push-ops.mjs`'s `pushSceneToFoundry` (the one shipped op, `create_scene`).
- **Module-side apply:** `foundry_worldFabric/scripts/data/foundry-bridge.mjs`'s `applyFoundryOps(ops, creators)`
  — pure orchestration over an injected `creators` map; unsupported `kind` → soft-fail result, never throws.
  Extending push (§3 below) means adding entries to the `creators` object passed into `startFoundryOpsWatcher`
  (`foundry-bridge.mjs:361-372`), not touching `applyFoundryOps`'s dispatch loop itself.
- **Store convention this doc mirrors:** `combat-planning/party-roster-store.mjs` — per-world, one JSON file
  per world (`<root>/<world>.json`), flat array, `withLock`/`ConcurrentWriteError` from `mutation-engine/review-state.mjs`,
  injectable `opts.makeId`/`opts.now`, `status: 'proposed'|'accepted'|'discarded'` gate with
  `acceptX`/`discardX` (discard refuses on `accepted`) and an `updateXFields` that refuses on anything but
  `proposed`. **No explicit `SCHEMA_VERSION` constant** — like `bestiary-store.mjs` and `party-roster-store.mjs`
  themselves (confirmed: neither has one; `session-planner/scene-elements.mjs`'s `SCHEMA_VERSION = 2` is a
  different, older convention from a different store shape). Both new stores below follow the **no-explicit-
  constant** convention — schema evolution tracked by the "additive-only, optional new fields, no version bump
  needed" discipline the bridge contract itself already documents, not a numeric field in the store.

---

## 1. Items / inventory store (NEW)

**File:** `combat-planning/item-store.mjs`. **Scope: per-world**, not library-wide like bestiary — an item's
relevance is scoped to the campaign whose party holds it (mirrors party-roster's own per-world reasoning, not
bestiary's per-user reasoning). **Storage:** `<itemRoot>/<world>.json`, one JSON file per world, flat array of
`ItemRecord`. Default root `GM_Tools/items/` (sibling to `party-roster/`), overridable via
`GM_TOOLS_ITEM_DIR` (tests use this for isolation, same as `GM_TOOLS_PARTY_ROSTER_DIR`). Reuses
`review-state.mjs`'s `withLock`/`ConcurrentWriteError`.

### Schema — `ItemRecord`

```js
{
  id: string,                    // it_<ts>_<rand>, injectable via opts.makeId
  world: string,
  name: string,
  type: string | null,           // dnd5e item type pass-through: "weapon" | "equipment" | "consumable" |
                                  // "loot" | "tool" | ... (system-defined, same opaque vocabulary as the
                                  // contract's actors[].items[].type)
  quantity: number | null,       // item.system.quantity, opaque pass-through, optional (contract §1.1 Item's
                                  // `system` is deliberately unmodeled — this store reads ONE known dnd5e
                                  // field out of it, same "known-convention, fail-soft on absence" approach
                                  // foundry-actor-mapper.mjs already takes for weapon/feat items)
  description: string | null,    // stripHtml(item.system.description.value) — same helper + same
                                  // "best-effort pass-through, not LLM-parsed" reasoning as ActorSystem.biography
  foundryItemRef: string | null, // "Item.<id>" — the EMBEDDED item's own uuid (distinct from the owning
                                  // actor's uuid). Dedup/upsert key, mirrors foundryActorRef's role exactly.
  ownerFoundryActorUuid: string | null,  // the actor this item was embedded on at pull time (actors[].uuid) —
                                          // kept even when ownerPartyMemberId can't resolve (see below), so the
                                          // link is never silently lost
  ownerPartyMemberId: string | null,     // best-effort resolved link into party-roster-store.mjs: the id of the
                                          // PartyMember whose foundryActorRef === ownerFoundryActorUuid, or null
                                          // if that actor hasn't been pulled/accepted into the roster yet (a
                                          // real, expected transient state right after a first-ever pull — items
                                          // and the owning PC are populated in the SAME pull run, order-dependent
                                          // only within that run; see "Populate order" below)
  sourceText: string | null,     // `Pulled from Foundry actor <ownerFoundryActorUuid>, item <foundryItemRef> (<name>).`
                                  // — same convention as foundry-pull-ops.mjs's sourceTextFor()
  status: 'proposed' | 'accepted' | 'discarded',
  createdAt: string              // ISO 8601
}
```

### Populate mapping (from `foundry-index.json`)

Source: `actors[].items[]` for every actor `classifyActor(actor, users) === "pc"` (contract §1.1's `items[]`
is present on EVERY actor, monsters included, but this store only ever ingests a PC's inventory — a monster's
`items[]` already feeds `mapActorToBestiary`'s attack/feature derivation and isn't "inventory" in the tracked-
loot sense this store exists for). **Standalone items** (a Foundry `Item` document sitting in a world/compendium,
not embedded on any actor) are **not currently pullable** — the contract's `actors[].items[]` is the only items
source in `FOUNDRY_INDEX_VERSION = 1`; a top-level `items[]` array (analogous to `tokens[]`'s flattening) would
be a real, additive contract bump if a future phase needs unowned/loose items. Flagged here as a known gap, not
designed further — out of scope until a concrete use case (e.g. "loot sitting in an unclaimed chest") demands it.

**New mapper** (add to `combat-planning/foundry-actor-mapper.mjs`, same module as the existing two mappers —
keep item derivation next to attack/feature derivation since both read the same `items[]` array):

```js
/** actor.items[] -> ItemRecord-SHAPED raw fields (name/type/quantity/description/foundryItemRef), one per item. */
export function mapActorItemsToInventory(actor) { ... }
```

Field-by-field: `name` ← `item.name`; `type` ← `item.type`; `quantity` ← `item.system.quantity` (typeof-guarded,
`null` if absent/non-numeric — same defensive pattern as every other `system.*` read in this file); `description`
← `stripHtml(item.system.description.value)`. **`stripHtml` must become an exported function** from
`foundry-actor-mapper.mjs` (currently module-private, `foundry-actor-mapper.mjs:42`) — a one-line change, the
only actual code-shape prerequisite this design surfaces.

### Populate order + upsert (extends `foundry-pull-ops.mjs`, doesn't replace it)

Add an `upsertItem(world, actor, item, opts)` alongside `upsertBestiary`/`upsertPartyMember` in
`wf-mcp-server/lib/foundry-pull-ops.mjs`, same three-way branch keyed on `foundryItemRef` (not `foundryActorRef`):
accepted match → `already-linked`; proposed match → update in place; else create. Call it from the SAME
`pullFoundryActorsToStores` loop, after the PC branch's `upsertPartyMember` call (so `ownerPartyMemberId` can
resolve against the roster record `upsertPartyMember` just created/updated in this same pass — no separate pull
action needed; **one "Pull from Foundry" click populates bestiary + roster + items together**). If
`ownerPartyMemberId` resolution fails (shouldn't, given same-pass ordering, but the party member could itself
have failed/been skipped) leave it `null` — never block item ingestion on roster ingestion succeeding.
`pullFoundryActorsToStores`'s return shape gains `itemsProposed: object[]` alongside `bestiaryProposed`/
`partyProposed`, and `alreadyLinked.items: string[]`.

**Route/tool surface:** no new endpoint — folds into the existing `POST /api/foundry/pull-actors` /
`wf_pull_foundry_actors` (same call, richer response). Consistent with 32.2's own "one pull, whatever's in the
index" model; a separate `pull-items` endpint would fragment a single logical action into two round-trips for
no benefit (items are strictly a function of the actors just pulled, never pulled independently).

---

## 2. Token index store (NEW)

**File:** `session-planner/token-store.mjs` (grouped with `scenes.mjs`, not `combat-planning/`, since tokens are
scene-attached, not combat-stat-attached). **Scope: per-world**, same file-per-world convention:
`<tokenRoot>/<world>.json`. Default root `GM_Tools/tokens/`, override `GM_TOOLS_TOKEN_DIR`.

### Schema — `TokenRecord`

```js
{
  id: string,                // tok_<ts>_<rand>
  world: string,
  sceneUuid: string,          // the Foundry Scene uuid this token was placed on at capture time (index's
                              // tokens[].sceneUuid, contract §1.4)
  sceneId: string | null,     // best-effort link into session-planner/scenes.mjs: the id of the GM_Tools
                              // scene whose foundrySceneRef === sceneUuid, or null if unresolved (see below)
  name: string,
  x: number | null,
  y: number | null,
  actorUuid: string | null,   // links to a bestiary/party-roster entry via THEIR foundryActorRef, same join
                              // key, not duplicated/renamed here — a reader does the join, this store doesn't
                              // pre-resolve it (unlike ownerPartyMemberId above; see "Why no owner-resolution" below)
  img: string | null,
  capturedAt: string          // the index's own exportedAt this token was read from — NOT createdAt-on-first-
                              // insert, because this store is a snapshot mirror, not authored content (see below)
}
```

**Deliberately NO `status`/review-gate.** Unlike bestiary/party-roster/items, a token isn't authored content a
human accepts or edits — it's a straight positional fact Foundry already owns. There's nothing to "propose" (no
derived/heuristic fields, no ambiguity to review). Review-gating would add friction with no corresponding
benefit.

**Deliberately NO per-token upsert-by-id.** The contract's `PlacedToken` shape (§1.3/§1.4) has **no stable
per-token id** — only `name`/`x`/`y`/`actorUuid`/`img` (+`sceneUuid` in the flattened form). Two tokens on the
same scene with the same actor and same starting position are indistinguishable in the wire format. So: **this
store does a full per-scene replace on every pull**, not an upsert — `syncTokensForScene(world, sceneUuid,
tokens, capturedAt)` deletes every existing `TokenRecord` for that `sceneUuid` in this world and inserts the
freshly-pulled set wholesale. This mirrors the index file's own "always a full replace" semantics (contract §1)
rather than inventing a fake identity to upsert against. **Flagged gap:** a future contract bump adding a real
`token.id` (Foundry's own placed-Token document id, which DOES exist in Foundry's data model — `scene.tokens.get(id)`
— but wasn't carried into the wire format in `FOUNDRY_INDEX_VERSION = 1`) would let a future version of this
store do a real per-token upsert/move-diff instead of blunt full-replace. Worth doing before this store is
actually built, not after — cheap to add to the contract now, annoying to retrofit once consumers exist.

### Populate mapping

Source: top-level `tokens[]` (already flattened with `sceneUuid` stamped, contract §1.4 — read that array
directly, never re-derive from `scenes[].tokens`, matching the contract's own anti-drift instruction to 32.1).
Group by `sceneUuid`, call `syncTokensForScene` once per distinct scene in the pulled index.

`sceneId` resolution: best-effort lookup — `listScenes(world)` (whatever `scenes.mjs`'s existing list function
is) `.find(s => s.foundrySceneRef === token.sceneUuid)`. **This will resolve to `null` for most tokens on a
first pull**, because 32.2 never built a pull-*scenes* slice — the ONLY way a GM_Tools scene record acquires a
`foundrySceneRef` today is by being *pushed* (32.3's `create_scene`), never by being pulled from an existing
Foundry scene. A token captured from a scene Russell built natively in Foundry (the common case — most scenes
in a running campaign predate any GM_Tools push) will have a real `sceneUuid` but `sceneId: null` until either
(a) a future pull-scenes slice is built (out of scope here — flagged, not designed, since nothing in 32.0-32.3
sketched an inbound scene-pull path or a `scenes.mjs` upsert-by-`foundrySceneRef` convention to receive it), or
(b) that specific scene happens to have been the target of a GM_Tools push. Document this prominently in
whatever UI eventually lists tokens — "linked to a GM_Tools scene" vs. "Foundry-only scene" are both valid,
common states.

**Why no owner-resolution (contrast with item store's `ownerPartyMemberId`):** items need an owner link because
"whose inventory is this" is the whole point of the store. A token's `actorUuid` is already the natural join key
into bestiary/roster (both already expose `foundryActorRef`) — pre-resolving it into a second redundant id field
would just be a cache that goes stale differently than the source columns it's caching. A reader joins live.

### Future push: `create_token` op (placing a remembered token)

Already sketched as a reserved kind in `plans/phase-32-bridge-contract.md` §2's table:
`{ sceneUuid, actorUuid, x, y, img? }`. Full shape for this phase's purposes:

```js
data: {
  sceneUuid: string,   // required — must be a Foundry Scene the ops watcher can fromUuid() resolve
  actorUuid: string,   // required — must be a Foundry Actor the ops watcher can fromUuid() resolve
  x: number,
  y: number,
  img?: string         // optional texture override; defaults to the actor's own img if omitted
}
```

Module-side (`foundry-bridge.mjs`'s `creators` map, alongside `createScene`): a new `createToken` entry —

```js
createToken: async (data) => {
  const scene = await fromUuid(data.sceneUuid);
  if (!scene) throw new Error(`create_token: scene not found for uuid ${data.sceneUuid}`);
  const actor = data.actorUuid ? await fromUuid(data.actorUuid) : null;
  const [doc] = await scene.createEmbeddedDocuments("Token", [{
    name: actor?.name,
    x: data.x, y: data.y,
    actorId: actor?.id,                                   // v14 TokenDocument wants actorId, NOT actorUuid
    texture: { src: data.img ?? actor?.img }
  }]);
  return doc?.uuid;
}
```

(`actorId` vs `actorUuid`: TokenDocument's embedded-creation data uses the actor's bare `id` within the same
world, not its fully-qualified `uuid` — a real, easy-to-miss v14 API detail worth calling out explicitly so a
future implementer doesn't copy the `Actor.<id>` uuid string in verbatim and get a silently-unlinked token.)

**GM_Tools-side caller** (a future `wf-mcp-server/lib/foundry-token-push-ops.mjs`, sibling to
`foundry-push-ops.mjs`): reads a `TokenRecord`, resolves `sceneUuid` (either the token's own captured
`sceneUuid`, or — if the intent is "place this remembered actor onto a DIFFERENT, newly-pushed scene" — the
target scene's `foundrySceneRef`), writes a `create_token` op via `writeFoundryOps`, no store write-back needed
on success (a placed token isn't itself a GM_Tools record that needs a ref — unlike `create_scene`'s
`foundrySceneRef`, there's no "my token index entry" to update; the NEXT pull will pick the new placement up
naturally as a fresh `TokenRecord` after the wholesale-replace above).

---

## 3. Full scene push (extends 32.3's thin `create_scene` slice)

32.3 shipped `create_scene` with `{name, background:{src}, width?, height?}` only. This section designs the
remaining pieces the bridge contract already reserved space for (`plans/phase-32-bridge-contract.md` §2's
"Reserved kinds" table) plus two more the original task list called out (lighting, splash-as-journal-image).

### 3a. `create_scene` — extended `data` shape

```js
data: {
  name: string,
  background: { src: string },
  width?: number,
  height?: number,
  grid?: { size: number, distance: number, units: string },   // mirrors index §1.3's own Scene.grid shape —
                                                                // deliberately the SAME shape pulled and pushed,
                                                                // no reshaping needed either direction
  walls?: WallData[],
  lighting?: { globalLight?: boolean, darkness?: number },     // subset of Scene#environment/darkness fields
                                                                // actually useful for prep (a DM setting a scene
                                                                // to start dim/dark) — not a full lighting-config
                                                                // push (ambient light *placement* is a separate,
                                                                // undesigned concern, noted below)
  tokens?: { actorUuid: string, x: number, y: number, img?: string }[],  // batch-place tokens at scene-creation
                                                                          // time, same per-token shape as
                                                                          // create_token's data (§2 above) minus
                                                                          // sceneUuid (implicit: the scene just
                                                                          // created)
  foreground?: { src: string }    // v14 Scene#foreground — an image layer ABOVE tokens (the "splash on top of
                                   // the map" case Russell described, distinct from background which sits below)
}

WallData = {
  c: [number, number, number, number],   // [x1,y1,x2,y2] — Foundry's raw Wall#c shape, system-agnostic
  door?: 0 | 1 | 2,                       // 0 none, 1 door, 2 secret door — Foundry's own CONST.WALL_DOOR_TYPES
  move?: 0 | 1, sight?: 0 | 1 | 2, light?: 0 | 1 | 2, sound?: 0 | 1 | 2   // per-sense restriction levels,
                                                                            // Foundry's own CONST.WALL_SENSE_TYPES
}
```

Module-side: `createScene`'s creator (`foundry-bridge.mjs:362-371`) gains conditional keys mirroring the
existing `width`/`height` pattern (`if (data.grid != null) createData.grid = data.grid;` etc. for `grid`/
`lighting`/`foreground`), plus **after** scene creation, two follow-up embedded-doc calls if present:
`scene.createEmbeddedDocuments("Wall", walls)` and `scene.createEmbeddedDocuments("Token", tokens.map(...))`
(the token mapping is IDENTICAL to §2's `createToken` creator body — factor it into one shared helper, don't
duplicate). **Ambient light PLACEMENT** (actual `AmbientLight` documents with position/radius/color, as opposed
to the scene-level `darkness`/`globalLight` toggles above) is explicitly **not designed here** — it's a
materially bigger, separate feature (light *fixtures*, not scene settings) that nothing in the original task
scope asked for; flagged as a real, deliberate non-goal of this section, not an oversight.

### 3b. `update_scene` — as reserved in the contract table, now given a concrete shape

```js
data: {
  sceneUuid: string,                                          // required — the target scene, from a prior
                                                                // create_scene result's foundryUuid (or a
                                                                // future pull-scenes lookup)
  patch: {
    name?: string, background?: { src: string }, width?: number, height?: number,
    grid?: {...}, foreground?: {...}   // same shapes as 3a, all optional — a genuine partial patch
  }
}
```

Module-side creator: `fromUuid(data.sceneUuid)` → `scene.update(data.patch)` (v14's own document `update()`,
no `getDocumentClass` needed for an update against an already-resolved doc instance). Returns the same
`foundryUuid` back (identity round-trip, useful for the caller's own bookkeeping even though it didn't change).

### 3c. `create_journal_image` — splash art as a journal image page

```js
data: {
  imageSrc: string,       // required — same "already-a-path-in-Foundry's-data-dir" assumption as background.src
  journalName?: string,   // defaults to a generic "Splash Art" name if omitted
  pageName?: string,      // defaults to journalName
  folder?: string         // optional JournalEntry folder id/name to file it under
}
```

Module-side creator, following `cockpit-app.mjs:835-910`'s EXISTING journal-push pattern for the envelope
(`getDocumentClass("JournalEntry").create(...)`, v14-correct per that file's own note) but an **`"image"`-type
page**, not `cockpit-app.mjs`'s `"text"`-type page:

```js
createJournalImage: async (data) => {
  const doc = await getDocumentClass("JournalEntry").create({
    name: data.journalName ?? "Splash Art",
    folder: data.folder,
    pages: [{ name: data.pageName ?? data.journalName ?? "Splash Art", type: "image", src: data.imageSrc }]
  });
  return doc?.uuid;
}
```

### 3d. The open question this section can't fully close: where does the map/splash FILE come from?

32.3 shipped with `mapSrc` as a caller-supplied path/URL — GM_Tools never validates or moves bytes, it just
tells Foundry "use this src" and Foundry's own `Scene.background.src` resolves it from Foundry's data dir at
render time. That's fine as long as the file is **already sitting somewhere Foundry's data dir can see it**.
Two real options for how it gets there, neither built, both worth stating plainly for whoever designs the
actual upload flow:

- **(a) Direct filesystem copy — the practical near-term answer.** GM_Tools and `foundry_worldFabric` run on
  the SAME host today (confirmed: both live under `/opt/dev/` on this machine, and the whole file-bridge
  transport already assumes a shared, locally-addressable `<foundryDataDir>`). A "push to Foundry" route could
  simply `fs.copyFile` the map/splash image into `<foundryDataDir>/worlds/<world>/scenes-from-gmtools/<name>`
  BEFORE writing the `create_scene`/`create_journal_image` op, then pass that resulting relative path as
  `mapSrc`/`imageSrc`. No new op kind needed, no Foundry-side code changes needed — purely a GM_Tools-side
  route addition. This is the recommended default for a future implementer, specifically because it needs
  nothing new on the Foundry-module side.
- **(b) A real `upload_asset` op, for when the two aren't co-located** (a genuinely remote Foundry instance).
  Would need a new op kind carrying either a base64-encoded payload (fine for small splash images, bad for a
  multi-MB battle map) or a GM_Tools-hosted URL the Foundry CLIENT fetches and re-uploads via `FilePicker.upload`
  (better for size, but requires the Foundry client to be able to reach GM_Tools's HTTP server over the network
  — a real deployment-topology assumption neither repo currently makes anywhere else). Not designed further
  here — it's a genuinely different scale of feature (network topology + binary transfer), flagged as future
  work only if/when a non-co-located deployment is ever a real requirement.

---

## 4. UI surfaces (deferred until Russell's interface, designed in Claude Designer, lands)

Per `feedback-designer-wiring-model.md`'s established GM_Tools front-end pattern: Russell designs the surface,
Claude Code ports the `.dc.html` + wires it to the backend below — no UI is speculatively built here. What each
surface needs FROM THE BACKEND, so the eventual port is a straight wiring exercise:

### 4a. Pull-review surface (accept/discard proposed bestiary / party / items)

- **List proposed candidates:** bestiary already exposes this (`listBestiaryEntries().filter(e=>e.status==='proposed')`,
  existing route); party-roster gained the same `status` field in 32.2 (`listPartyMembers(world).filter(...)`,
  existing route per 32.2's own work); the item store (§1) would expose the identical shape once built.
- **Accept/discard:** `acceptBestiaryEntry`/`discardBestiaryEntry` and `acceptPartyMember`/`discardPartyMember`
  already exist (32.2); the item store needs the SAME two functions, copied verbatim from
  `party-roster-store.mjs`'s versions (same refuse-to-discard-accepted rule).
  need a genuinely new endpoint per store — REST route already established for the two that exist
  (`POST /api/bestiary/:id/accept`-shaped, check actual route names in `review-ui/server.mjs` before wiring);
  items mirrors the pattern once its store lands.
- **"What changed since last accept" diff:** every re-pull that updates a `proposed` entry in place
  (`upsertBestiary`/`upsertPartyMember`/the future `upsertItem`) already OVERWRITES `rawFields`/
  `combatRelevant`+`buildRelevant`/item fields — nothing currently PRESERVES the prior accepted version for a
  side-by-side diff. If the UI wants "here's what changed" (not just "here's the new proposed state"), that's
  a genuinely new backend capability (keep the last-accepted snapshot alongside the current proposed one) — not
  something the existing stores already do implicitly. Flagged as a real gap if the UI design calls for it;
  the simplest version ("just show the new proposed values, full stop, like every other proposed/accepted flow
  in this project already works") needs nothing new.

### 4b. Push surface ("push to Foundry" on a scene)

- **Trigger + status:** `POST /api/foundry/push-scene {world, sceneId, mapSrc, name?, width?, height?}` already
  exists (32.3) and returns one of `queued` (no live Foundry client picked it up within ~7s — the UI should show
  this as "waiting, is a GM logged into Foundry?" not an error) / `applied, ok:true, foundryUuid` (success,
  `scene.foundrySceneRef` now set) / `applied, ok:false, error` (a real Foundry-side failure, e.g. a bad path).
  The UI's job is entirely: a `mapSrc` input (file path for now — §3d's copy-flow, once built, would replace
  this with a real file picker that resolves to a path automatically), a submit button, and a status display
  keyed off those three outcomes. Nothing new needed on the backend for the THIN case that exists today.
- **Once a scene has `foundrySceneRef` set:** the UI can show "linked to Foundry" and could offer `update_scene`
  (§3b, not yet built) for re-pushing changes to an already-created scene instead of always creating a new one.
- **Place-a-remembered-token affordance:** once the token store (§2) and its push caller exist, a per-scene
  "tokens seen here" list (`TokenRecord`s filtered by `sceneId`) with a "place on this scene" action that issues
  a `create_token` op. Entirely new-store-dependent — nothing to wire until §2 is built.

Nothing in this section requires new backend design beyond what §1–§3 already specify — the UI surfaces are
consumers of those, not a source of new schema questions.
