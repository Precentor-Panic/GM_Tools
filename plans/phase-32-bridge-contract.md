# Phase 32 task 32.0 — The Foundry Bridge File-Format Contract

**Status: authoritative, v3** (amended Phase 36 task 36.0 — the QUIET staged scene push; amended again Phase 38
task 38.0 — compendium content pipeline. v1/v2 sections below are UNCHANGED except where a later amendment
explicitly overrides them; new/changed material is marked **(v2)** / **(v3)** inline rather than rewriting the
whole document, so a reader can see exactly what each task adds on top of the already-shipped baseline). This is
the contract 32.1/36.1/38.1 (Foundry-module producer, `foundry_worldFabric`) and 32.2/32.3/36.2/38.2 (GM_Tools
consumers/producers) implement TO. Neither side may deviate from a field name/shape here without a follow-up
edit to this file — if a task hits a shape question this doc doesn't answer, that's a bug in this doc, not a
license to guess. See this file's own "Changelog" section (bottom) for the v1→v2→v3 diff summary, and
`plans/phase-36-tasks.md` / `review-ui/test/e2e/phase36-fixture.mjs` for the quiet-push spec, and
`plans/phase-38-tasks.md` / `review-ui/test/e2e/phase38-fixture.mjs` for the content-pipeline spec, that consume
these shapes (the bridge-contract file stays scoped to the WIRE FORMAT only — GM_Tools-side store
fields/routes/flush/import semantics are specified in phase36-fixture.mjs/phase38-fixture.mjs, not duplicated
here).

Design record: `/home/russell/.claude/plans/ok-i-m-back-with-dazzling-newt.md` (§Architecture). Task list:
`plans/phase-32-tasks.md`. Grounded against real code — see "Grounding" at the bottom of this file for exact
file:line references used while writing this contract.

## Scope and non-goals

Three NEW files, all under `<foundryDataDir>/worlds/<world>/`, additive to the existing bridge. The existing
`world-fabric-snapshot.json` (graph export) and `world-fabric-mutations.json` (graph mutation bridge,
`graph-service.mjs:238`/`:274`) are **completely unchanged** by this contract — no code in 32.1/32.2/32.3 may
read, write, or alter their shape or their watcher. This is a parallel channel for Foundry *documents*
(Actors/Users/Scenes/Items/Tokens), not graph entities.

| File | Direction | Purpose |
|---|---|---|
| `world-fabric-foundry-index.json` | Foundry → GM_Tools (**pull**) | Rich, read-only snapshot of Foundry's own documents |
| `world-fabric-foundry-ops.json` | GM_Tools → Foundry (**push**) | Queue of document-creation/update requests |
| `world-fabric-foundry-results.json` | Foundry → GM_Tools | Per-op outcome, for UUID write-back |

All three live in the SAME `worlds/<world>/` directory as the existing bridge files, so `wf-mcp-server/lib/snapshot.mjs`'s
existing `dataDir`/`world` resolution (and its path-traversal-hardening from the post-Phase-14 security review —
`resolveWorld()` validates the world-id format) applies unchanged; no new directory convention is introduced.

## Cross-cutting conventions (all three files)

- **Overwrite-to-signal, never delete** — same reason as the existing bridge (`graph-service.mjs:296-298`
  comment: "FilePicker can't delete"). A file is fully overwritten either with fresh content (producer) or
  with an empty value (consumer, once fully processed) — nothing is ever deleted, appended-and-left, or
  partially patched.
- **Permissive parsing** — every consumer MUST tolerate unknown fields (mirrors `RawBestiaryFields`/
  `RawPartyMemberFields`'s own deliberate non-`.strict()` zod convention in `combat-planning/bestiary-ingest.mjs`
  and `party-roster-ingest.mjs`: unknown keys are silently dropped, not a hard validation failure). This is
  what lets 32.1 and 32.2/32.3 ship independently without a synchronized release.
- **Additive-only versioning** — adding a new OPTIONAL field to any shape below is NOT a breaking change and
  does not require a version bump. A version bump is required only for: renaming/removing a field, changing a
  field's type, or changing a field from optional to required. Bump the relevant `*_VERSION` constant and
  record the change in this file's own "Changelog" section (below) when it happens — don't let a format's
  shape drift silently, per `.claude/skills/gm-tools-conventions/SKILL.md`'s schema-versioning discipline.
- **dnd5e vs. generic fields** — Foundry's document *envelope* (name/img/uuid/type on Actors, Users, Scenes)
  is system-agnostic. Everything nested under an actor's `system` key is **game-system-specific** — the shapes
  below describe the **dnd5e** system (what `foundry_worldFabric`'s target world actually runs) and every
  `system.*` sub-field is OPTIONAL for exactly this reason: a non-dnd5e world (or a dnd5e actor missing a
  field, e.g. an NPC with no configured skills) must produce a value 32.1 can still emit and 32.2's mappers
  must still consume without throwing. **No mapper may assume any `system.*` field is present.** This is
  exercised directly by `foundry-index.minimal.json` below.

---

## 1. `world-fabric-foundry-index.json` (Foundry → GM_Tools, PULL)

**`FOUNDRY_INDEX_VERSION = 1`** (constant 32.1 exports from `scripts/data/foundry-bridge.mjs`, mirroring
`interchange.mjs`'s `WFI_VERSION` precedent).

Written fire-and-forget on flush/ready plus a manual "Reindex for GM_Tools" control (32.1's job). Always a
**full replace** — every export overwrites the whole file with the current full state, not a diff. No clearing
convention needed (nothing to signal "done" about — it's informational, read any time, like
`world-fabric-snapshot.json`).

### Top level

```
{
  version: 1,                 // FOUNDRY_INDEX_VERSION — see the (v2) note below: still 1, not bumped.
  worldId: string,             // game.world.id
  exportedAt: string,          // ISO 8601
  actors: Actor[],
  users: User[],
  scenes: Scene[],
  tokens: Token[],              // flat convenience index — see §1.4
  playlists: Playlist[],         // (v2, Phase 36) — see §1.5. Additive-optional per the "additive-only
                                 // versioning" rule below (a pre-36.1 exporter simply omits this key; every
                                 // 32.2-era consumer already tolerates unknown/missing top-level keys), so
                                 // FOUNDRY_INDEX_VERSION stays 1 — this is NOT a breaking shape change.
  worldItems: Item[],            // (v3, Phase 38) — see §1.6. Additive-optional, same reasoning as playlists.
  compendia: CompendiumPackInfo[] // (v3, Phase 38) — see §1.7. Additive-optional, same reasoning as playlists.
}
```

### 1.1 `actors[]`

```
{
  uuid: string,                 // "Actor.<id>" — game.actors.get(id).uuid
  name: string,
  type: string,                 // Foundry actor type: "npc" | "character" | (others, system-defined)
  img: string | null,
  ownership: { [userId: string]: number } | null,   // OPTIONAL, raw Actor#ownership (0-3 per user + "default").
                                                       // Convenience/cross-check only — the PRIMARY way to tell
                                                       // a PC from a monster is users[].characterUuid (§1.2),
                                                       // not ownership. A mapper must not require this field.
  system: ActorSystem,          // see below — always present, every key inside it optional
  items: Item[],                // embedded actor.items, always present (possibly [])
  effects: Effect[] | null      // OPTIONAL, raw actor.effects (ActiveEffect docs) — see note below
}
```

`type` drives 32.2's monster-vs-PC routing in combination with `users[].characterUuid`: an actor whose `uuid`
is referenced by some `users[].characterUuid` is a PC (→ `RawPartyMemberFields`); an actor of type `"npc"`
(or any type NOT referenced by a user) is a monster candidate (→ `RawBestiaryFields`). `type` alone is not
fully reliable across all dnd5e configurations (a GM can technically own an "npc"-typed helper, a player could
theoretically be handed a "character"-typed monster) — **`users[].characterUuid` ownership is the authoritative
signal**, `type` is the fallback heuristic when no user claims the actor.

#### `ActorSystem` (nested under `actors[].system`) — dnd5e-shaped, every field optional

```
{
  hp: { value: number, max: number, temp?: number } | null,     // system.attributes.hp
  ac: number | null,                                             // system.attributes.ac.value
  cr: string | number | null,                                    // system.details.cr — MONSTERS. Absent for PCs.
  level: number | null,                                          // system.details.level — PCS (character level,
                                                                   // Foundry auto-sums class-item levels). Absent
                                                                   // for most monsters (dnd5e monsters use cr, not
                                                                   // level) — a mapper must treat null as "use cr
                                                                   // instead", never coerce null → 0.
  abilities: {
    str?: AbilityScore, dex?: AbilityScore, con?: AbilityScore,
    int?: AbilityScore, wis?: AbilityScore, cha?: AbilityScore
  } | null,                                                       // system.abilities.<key>
  saves: { [ability: string]: number } | null,                    // OPTIONAL convenience flattening of
                                                                   // abilities.<k>.save — kept as a SEPARATE
                                                                   // top-level map (not just nested in abilities)
                                                                   // because RawPartyMemberFields.combatRelevant.
                                                                   // saveDCs is exactly this shape
                                                                   // (Record<string,number>) and this lets 32.2's
                                                                   // PC mapper assign it directly with no
                                                                   // reshaping. Monsters may also carry this.
  skills: {
    [skillKey: string]: { value: number, proficient?: number, passive?: number }
  } | null,                                                       // system.skills.<key> — proficient: 0/0.5/1/2
                                                                   // (2 = expertise). Used both directions: PC
                                                                   // buildRelevant.skills/expertise (proficient
                                                                   // >= 1 / === 2) and monster skill checks.
  biography: string | null                                        // system.details.biography.value, HTML or
                                                                   // plain text. Best-effort source text for
                                                                   // buildRelevant.notableTraits/backstoryHooks —
                                                                   // 32.2's mapper is NOT required to parse this
                                                                   // with an LLM; a plain pass-through (or a
                                                                   // deferred LLM pass) is acceptable.
}

AbilityScore = { value: number, mod?: number, save?: number }
```

**Design decision — why `system` looks like this:** the fields above are chosen SPECIFICALLY because both
downstream mappers can be built from them without an LLM:
- Monster → `RawBestiaryFields`: `hp.value`→`hp`, `ac`→`ac`, `cr`→`challengeRating`. `attacks[]`/`multiattack`/
  `rechargeAbilities`/`legendaryActions`/`lairEffects`/`auraEffects`/`appliedEffects` are NOT modeled as
  first-class `system` fields — they're derived by 32.2's mapper from `items[]` (weapon-type items → attacks;
  feature-type items with a recharge/legendary activation → recharge/legendary abilities) and `effects[]`
  (→ `appliedEffects`). This keeps the index a faithful, thin pass-through of Foundry's own document shape
  rather than a second place that re-implements dnd5e's action-economy semantics — that derivation logic
  belongs in 32.2's mapper (Node-testable against the fixtures below), not baked into the wire format.
- PC → `RawPartyMemberFields`: `combatRelevant.class`/`level`/`ac`/`hp` from `system.details.level`+`ac`+`hp`
  plus a class-type item's name; `attackBonus`/`damagePerRoundEstimate` derived from weapon items the same way
  as the monster case; `saveDCs` directly from `saves`; `buildRelevant.skills`/`expertise` from `skills`.

#### `Item` (nested under `actors[].items[]`)

```
{
  uuid: string,          // "Item.<id>"
  name: string,
  type: string,           // dnd5e item type: "weapon" | "feat" | "class" | "spell" | "equipment" | ... (system-defined)
  img: string | null,
  system: object           // OPAQUE PASS-THROUGH of Foundry's raw item.system — deliberately NOT modeled
                            // field-by-field in this contract (dnd5e's item.system shape is deep and has
                            // shifted across dnd5e system versions; enumerating it here would make this
                            // contract the thing that goes stale). 32.2's mapper reads known dnd5e
                            // conventions out of this blob (e.g. a "weapon" item's damage formula, a "feat"
                            // item's activation/recharge/uses data for recharge & legendary actions, a
                            // "class" item's `system.levels` for PC level/class) but MUST fail soft (skip
                            // that one item, don't throw) on a field it doesn't recognize or that's absent —
                            // this is the exact case foundry-index.minimal.json exercises.
}
```

`type` values 32.2 is expected to key off of (documented here so 32.1 and 32.2 agree on vocabulary, not
enforced by this contract): `"weapon"` (attacks), `"feat"` (features — includes recharge abilities, legendary
actions, lair/aura-effect-granting features, identified by `system.activation`/`system.recharge`/`system.uses`
sub-fields the mapper inspects), `"class"` (PC class + level).

#### `Effect` (nested under `actors[].effects[]`, OPTIONAL)

```
{ name: string, changes?: object[] }
```

Raw pass-through of `actor.effects` (ActiveEffect documents). Exists specifically so 32.2's mapper can populate
`RawBestiaryFields.appliedEffects` (`string[]`, effect names) directly, rather than heuristically scanning
feature-item names/descriptions for effect-like text. **This field is genuinely optional** — 32.1 may ship
without it in an early cut, and 32.2's mapper must treat `effects: null`/absent identically to `effects: []`
(empty `appliedEffects`), not as an error.

### 1.2 `users[]`

```
{
  id: string | null,          // OPTIONAL, raw game.users user._id — include when convenient; not required for
                               // correctness since `name` is the join key 32.2 actually uses (Foundry world
                               // usernames are unique within a world in practice).
  name: string,
  role: number,                // Foundry CONST.USER_ROLES: 1=PLAYER, 2=TRUSTED, 3=ASSISTANT, 4=GAMEMASTER
  characterUuid: string | null // user.character?.uuid — "Actor.<id>" of the PC this user plays, or null/absent
                               // if unassigned. THIS is the authoritative pull → party-roster signal (see §1.1).
}
```

### 1.3 `scenes[]`

```
{
  uuid: string,                          // "Scene.<id>"
  name: string,
  background: { src: string } | null,    // scene.background — the map image. null if the scene has no map yet.
  width: number | null,
  height: number | null,
  grid: { size: number, distance: number, units: string } | null,   // scene.grid, subset used for map-scale math
  tokens: PlacedToken[]                  // placed tokens ON THIS SCENE — same shape as §1.4, minus sceneUuid
}

PlacedToken = { name: string, x: number, y: number, actorUuid: string | null, img: string | null }
```

**(v2, Phase 36) `actorUuid` corrective note — NOT a shape change, a bugfix.** `actorUuid` was ALWAYS specified
as the base `"Actor.<id>"` form (this is what `Actor.uuid` means everywhere else in this contract — §1.1's own
`actors[].uuid`). 32.1's shipped `extractToken` (`foundry-bridge.mjs:~262`) had a real defect: it emitted the
COMPOUND embedded-document uuid instead (`Scene.<id>.Token.<id>.Actor.<id>`, Foundry's own `TokenDocument#actor`
resolution path leaking into the export), which never actually matches any `actors[].uuid`/`foundryActorRef`
join key anywhere downstream — silently breaking the join for every consumer that ever tried it (token-store's
`actorUuid` field, §2's `create_token` op). 36.1 fixes `extractToken` to emit the base `Actor.<id>` form the
contract always specified. **No version bump** — the documented shape here is unchanged; only a
implementation defect that violated it is being corrected. A GM_Tools-side consumer written strictly to THIS
document's `actorUuid` shape was always correct; it just never actually matched real pre-36.1 export data.

### 1.4 `tokens[]` — flat convenience index

**Decision:** fold BOTH ways, not one or the other. `scenes[].tokens` (§1.3) is the canonical per-scene
grouping (what 32.3's future scene-push/token-index work naturally wants — "give me this scene's tokens").
Top-level `tokens[]` is the SAME data, flattened across every scene with a `sceneUuid` added, for a consumer
that wants "every placed token in the world" without iterating scenes (32.4's future token-index store). 32.1
must build the top-level array by flattening `scenes[].tokens` (never a second independent enumeration) so the
two can't drift apart within one export:

```
{ sceneUuid: string, name: string, x: number, y: number, actorUuid: string | null, img: string | null }
```

### 1.5 `playlists[]` (v2, Phase 36) — top-level, alongside `actors`/`users`/`scenes`/`tokens`

```
{
  id: string,           // "Playlist.<id>" — game.playlists.get(id).uuid
  name: string,
  tracks: Track[]
}

Track = { name: string, path?: string }   // path is OPTIONAL — a track's own sound.path, when 32.1/36.1 can
                                            // cheaply resolve it; a consumer must tolerate a name-only track
                                            // (e.g. Stagecraft's music rows link by name/description, not by
                                            // a resolved file path this phase — plans/phase-35-tasks.md's own
                                            // "music rows are hand-added only this phase" decision means
                                            // nothing downstream requires `path` to be present yet).
```

Same "always a full replace" semantics as the rest of the index (§1's own top-level rule) — every export
overwrites `playlists[]` wholesale, never a diff. Additive-optional (see the top-level shape note above):
absent entirely on a pre-36.1 index, and every consumer (32.2-era or later) must treat a missing `playlists`
key identically to `playlists: []`.

### 1.6 `worldItems[]` (v3, Phase 38) — top-level, alongside `actors`/`users`/`scenes`/`tokens`/`playlists`

**Grounding fact (explorer report, 2026-08-10, `plans/phase-38-tasks.md`'s own "Bridge blind spots"):** the index
enumerates ONLY world actors/users/scenes/playlists — `game.items` (LOOSE world Items, not embedded on any
actor — where Plutonium's world-import lands, per Russell's "expand the Reliquary dramatically" ask) is
completely invisible to GM_Tools today. `worldItems[]` closes that gap.

```
worldItems: Item[]   // SAME Item shape as §1.1's embedded actors[].items[] entries, VERBATIM — reuses
                      // foundry_worldFabric's own existing extractItem() function unchanged (it already takes
                      // any Foundry Item document, embedded or not) — NOT a second item-shape/extraction
                      // function. { uuid, name, type, img, system } — see §1.1's own Item shape for the exact
                      // field docs (system is an OPAQUE pass-through, same "fail soft on an unrecognized field"
                      // rule).
```

Built from `game.items` (Foundry's world-level Item WorldCollection — genuinely loose items, never an actor's
embedded `items[]`, no overlap with §1.1's per-actor arrays). Same "always a full replace" semantics as the rest
of the index. Additive-optional: absent entirely on a pre-38.1 index, every consumer must treat a missing
`worldItems` key identically to `worldItems: []`. `uuid` here is the item's own `"Item.<id>"` world-item uuid
(NOT compound/embedded — there is no owning actor to compound it with), which is exactly the value 38.2's
Reliquary mapper uses as `foundryItemRef` for dedup/upsert (mirrors §1.1 Item's `uuid`→`foundryItemRef` join key
convention exactly, just with no owning actor on the other end).

### 1.7 `compendia[]` (v3, Phase 38) — top-level, alongside the above

**Grounding fact (same explorer report):** `game.packs` (ALL compendium content — where Czepeku's map packs and
any pack-based content live until imported) is ALSO completely invisible to GM_Tools today. `compendia[]` closes
this second gap, deliberately CHEAPLY: a pack can hold hundreds of MB of documents (Czepeku packs, per the task
plan's own grounding), so this section enumerates pack HEADERS via Foundry's own lazy `pack.index` read (never
`pack.getDocuments()`/full-document loads) — confirmed against the real client source
(`CompendiumCollection#getIndex`, `foundry_worldFabric/scripts/data/pack-scan.mjs`'s own existing
`listImportablePacks()` precedent for `pack.collection`/`pack.metadata.label`/`pack.documentName`/`pack.index`).

```
compendia: CompendiumPackInfo[]

CompendiumPackInfo = {
  packId: string,        // pack.collection — e.g. "czepeku-taverns.scenes" — the STABLE id used everywhere
                          // else in this contract a pack is referenced (§2's import_compendium_scene.data.packId,
                          // 38.2's compendiumRef.packId dedup key).
  label: string,          // pack.metadata.label ?? pack.collection — human-readable pack title.
  documentType: string,   // pack.documentName — "Scene" | "Item" | "Actor" | "JournalEntry" | ... (whatever
                           // Foundry reports; NOT filtered/allowlisted here the way pack-scan.mjs's
                           // listImportablePacks() restricts to {Item,Actor,JournalEntry} — this index is a
                           // faithful inventory of EVERY installed pack, not just the ones a particular consumer
                           // currently knows how to use; 38.2's Stagecraft mapper is the one that filters to
                           // documentType==="Scene").
  count: number,           // pack.index.size (falls back to pack.size when index isn't loaded yet) — same
                            // "count, not full enumeration" idiom pack-scan.mjs's own `size` field already uses.
  entries: PackEntry[] | undefined   // ONLY present when documentType === "Scene" — see below. Genuinely ABSENT
                                      // (not `null`, not `[]`) on a non-Scene pack, so a consumer can branch on
                                      // `"entries" in pack` / `pack.entries !== undefined` to tell "a Scene pack
                                      // with zero entries" apart from "a non-Scene pack, headers only" without
                                      // relying on count===0 ambiguity.
}

PackEntry = { id: string, name: string, thumb: string | null }
```

**Why entries are Scene-pack-only:** the phase's own concrete ask is "browse a Czepeku pack's map scenes before
importing" (Stagecraft browse rows, §2's `import_compendium_scene`) — no other pack document type has an
analogous "browse then selectively import" UI this phase builds. Enumerating every document's name for
EVERY installed pack (Plutonium alone ships packs with thousands of items/spells/monsters) would make this
already-cheap `pack.index` read needlessly large for packs nothing downstream reads per-entry yet; a future phase
that wants browsable Item/Actor pack entries extends this section then, following the exact same pattern.

`PackEntry.thumb` is `pack.index`'s own `.img` field for a Scene document — confirmed against the real client
source (`CompendiumCollection#indexDocument`: `index.img = data.thumb ?? data.img`, i.e. a Scene's dedicated
`thumb` field, Foundry's own compendium-listing thumbnail) — `pack.index` already carries this VERBATIM per-entry
with zero extra reads once the index is loaded (`pack.getIndex()`), matching this section's own "cheap header
reads only" rule. `null` when a Scene document in the pack has no thumb/img set.

`entries[].id` is the document's own `_id` WITHIN the pack (NOT a full uuid) — this is deliberately the exact
value §2's `import_compendium_scene.data.entryId` takes, so a browse-row's `{packId, entryId}` pair round-trips
directly into the import op with no reshaping, mirroring `create_token`'s own "no reshaping either direction"
precedent (§2's `create_scene.data.grid` note) one level up.

Same "always a full replace" semantics as the rest of the index. Additive-optional: absent entirely on a
pre-38.1 index, every consumer must treat a missing `compendia` key identically to `compendia: []`.

---

## 2. `world-fabric-foundry-ops.json` (GM_Tools → Foundry, PUSH)

**`FOUNDRY_OPS_SCHEMA_VERSION = 1`** — tracked here and in module comments (like the existing
`world-fabric-mutations.json` mutation shape already is), **NOT as an in-file field**. See "Shape decision"
below for why.

Top-level shape: a flat JSON array (matching the existing `world-fabric-mutations.json` convention exactly —
`graph-service.mjs:292`'s `Array.isArray(mutations)` check is the same shape this file uses):

```
[ Op, Op, ... ]

Op = {
  opId: string,     // opaque, unique per op, assigned by the GM_Tools-side writer (e.g. `op_<ts>_<rand>`).
                     // Not interpreted by Foundry beyond echoing it back in the matching result.
  kind: string,      // see kinds below
  data: object        // kind-specific payload
}
```

**Direction & clearing convention:** GM_Tools (producer) writes the FULL current queue, overwriting whatever
was there (mirrors `applyMutationsToFoundry` in `wf-mcp-server/lib/mutation-ops.mjs:109` — write-then-poll).
The Foundry-side watcher (consumer, 32.1) applies every op in the array, writes ALL outcomes to
`world-fabric-foundry-results.json` (§3) FIRST, then overwrites this ops file back to `[]` to signal
"processed" — same "overwrite empty, can't delete" mechanic as the existing mutation watcher
(`graph-service.mjs:296-298`), and same ordering (write result before clearing the request) so a crash between
the two steps never loses a result silently.

### `kind: "create_scene"` — the push slice; extended (v2, Phase 36) with grid/tokens/foreground

```
data: {
  name: string,
  background: { src: string },   // map image path/URL, required — this op exists to get a map into Foundry.
                                  // SEE "Background write semantics" below — background does NOT actually land
                                  // via Scene.create's own field on v14; the module writes it via a follow-up
                                  // embedded Level-doc update. The WIRE shape (this field, here) is unchanged —
                                  // only 36.1's module-side IMPLEMENTATION of how it lands in Foundry changes.
  width?: number,
  height?: number,
  grid?: { size: number, distance: number, units: string },   // (v2) mirrors index §1.3's own Scene.grid shape
                                                                // verbatim — deliberately the SAME shape pulled
                                                                // and pushed, no reshaping either direction.
  tokens?: { actorUuid: string, x: number, y: number, img?: string }[],  // (v2) batch-place tokens at
                                                                // scene-creation time — same per-token shape as
                                                                // create_token's `data` below, minus `sceneUuid`
                                                                // (implicit: the scene just created). `actorUuid`
                                                                // here is the base `Actor.<id>` form (§1.1),
                                                                // NOT a fully-qualified compound uuid — see
                                                                // create_token's own v14 actorId note below,
                                                                // which applies identically to this batch form.
  foreground?: { src: string }   // (v2) v14 Scene#foreground — an image layer ABOVE tokens (splash-on-top-of-
                                  // map), distinct from `background` which sits below. Also written via a
                                  // follow-up doc call, NOT Scene.create's own field directly — see below.
}
```

On success, the Foundry watcher creates a `Scene` document (`getDocumentClass("Scene").create(...)`, v14-correct
per the design record's own note — NOT `globalThis.Scene.create`, `cockpit-app.mjs:835`'s older habit) and
reports back `foundryUuid` in the matching result (§3).

**Background write semantics — v14 SHOWSTOPPER, load-bearing for BOTH create and update (v2, Phase 36).**
Proven live (`plans/wf-test-setup.md:124`): on Foundry v14, `Scene#background` is a DEPRECATED getter — setting
`scene.background.src` (or passing `background:{src}` into `Scene.create(...)`'s creation data) is **silently
ignored**. The actual background image lives on the scene's embedded **Level** document (`defaultLevel0000`).
The fix, which 36.1 must apply on **BOTH** `create_scene` (right after the `Scene.create` call, using the newly
created scene's own embedded Level doc) **AND** `update_scene` (whenever `patch.background` is present):

```js
await scene.updateEmbeddedDocuments("Level", [{ _id: "defaultLevel0000", "background.src": data.background.src }]);
```

The deprecated `scene.background.src` GETTER still reflects the Level doc's value (Foundry's own back-compat
shim) — this is why §1.3's PULL-side `extractScene` (which reads `scene.background?.src`) already works
correctly with ZERO module changes; only the two WRITE paths (create, update) needed the fix. `foreground`
follows the analogous v14 field if/when Foundry deprecates it the same way — 36.1's own task is to verify at
implementation time and use whichever write path (direct `Scene#foreground` field vs. an embedded-doc call)
actually persists on the target Foundry version, documenting whichever turns out true; this contract does not
presume `foreground` shares the exact same Level-doc quirk as `background`, only that a naive
`Scene.create({foreground:{src}})`/`scene.update({foreground:{src}})` must be VERIFIED to actually work, not
assumed, given `background`'s own proof that Foundry v14 silently drops fields exactly this shape.

### `kind: "update_scene"` — (v2, Phase 36, implemented; was "reserved, shape may change" in v1)

```
data: {
  sceneUuid: string,   // required — the target scene, typically a prior create_scene result's `foundryUuid`
  patch: {
    name?: string,
    background?: { src: string },   // see "Background write semantics" above — Level-doc write, not a plain
                                      // `scene.update()` field-set, when present.
    width?: number,
    height?: number,
    grid?: { size: number, distance: number, units: string },
    foreground?: { src: string }
  }
}
```

Module-side: `fromUuid(data.sceneUuid)` → `scene.update(patch)` for every key EXCEPT `background` (routed
through the Level-doc `updateEmbeddedDocuments` call above instead, run alongside/after the plain `update()`
call for the remaining keys). Returns the same `foundryUuid` back (identity round-trip) in the result. An
unresolvable `sceneUuid` is a per-op failure (`ok:false`, §3), not a thrown/aborted batch.

### `kind: "create_token"` — (v2, Phase 36, implemented; was "reserved, shape may change" in v1)

```
data: {
  sceneUuid: string,   // required — must be a Foundry Scene the ops watcher can fromUuid() resolve
  actorUuid: string,   // required — the base "Actor.<id>" form (§1.1) — see the v14 gotcha below
  x: number,
  y: number,
  img?: string          // optional texture override; defaults to the actor's own img if omitted
}
```

**v14 gotcha (module-side, load-bearing — deferred §2's own finding, reused verbatim):** `TokenDocument`'s
embedded-creation data wants the actor's bare **`id`**, not its fully-qualified `uuid` string, in its own
`actorId` field:

```js
const scene = await fromUuid(data.sceneUuid);
const actor = data.actorUuid ? await fromUuid(data.actorUuid) : null;
const [doc] = await scene.createEmbeddedDocuments("Token", [{
  name: actor?.name, x: data.x, y: data.y,
  actorId: actor?.id,                          // NOT data.actorUuid verbatim — v14 wants the bare id
  texture: { src: data.img ?? actor?.img }
}]);
```

Copying `data.actorUuid` (the `"Actor.<id>"` string) directly into `actorId` produces a silently-unlinked token
(no thrown error, just a token with no working actor link) — this is exactly the class of easy-to-miss v14 API
detail this note exists to prevent a future implementer from re-discovering the hard way.

### `kind: "create_journal_image"` — (v2, Phase 36, implemented; was "reserved, shape may change" in v1)

```
data: {
  imageSrc: string,       // required — same "already-a-path-in-Foundry's-data-dir" assumption as background.src
  journalName?: string,   // defaults to a generic "Splash Art" name if omitted
  pageName?: string,      // defaults to journalName
  folder?: string         // optional JournalEntry folder id/name to file it under
}
```

Module-side, following `cockpit-app.mjs:835-910`'s existing journal-push pattern for the envelope
(`getDocumentClass("JournalEntry").create(...)`) but an **`"image"`-type** page, not that file's `"text"`-type:

```js
const doc = await getDocumentClass("JournalEntry").create({
  name: data.journalName ?? "Splash Art",
  folder: data.folder,
  pages: [{ name: data.pageName ?? data.journalName ?? "Splash Art", type: "image", src: data.imageSrc }]
});
return doc?.uuid;
```

### `kind: "import_compendium_scene"` — (v3, Phase 38, NEW)

```
data: {
  packId: string,    // required — §1.7's CompendiumPackInfo.packId (pack.collection)
  entryId: string     // required — §1.7's PackEntry.id (the document's own _id within the pack)
}
```

Creates a real WORLD Scene document from a compendium Scene entry — the backend for Stagecraft's "browse a
Czepeku pack → import 2–3 you'll actually run" flow. On success, reports back `foundryUuid` (the new world
Scene's own uuid, e.g. `"Scene.xyz789"`) in the matching result (§3), exactly like `create_scene`.

**The v14 idiom (researched this task, documented here so 38.1's implementer doesn't have to re-derive it):**

```js
const pack = game.packs.get(data.packId);
if (!pack) throw new Error(`import_compendium_scene: unknown pack "${data.packId}"`);
const imported = await game.scenes.importFromCompendium(pack, data.entryId);
return imported?.uuid;
```

`game.scenes` is a `WorldCollection` (confirmed by direct read of the installed v14 client source,
`client/documents/collections/scenes.mjs`: `class Scenes extends WorldCollection`), and
`WorldCollection#importFromCompendium(pack, id, updateData={}, options={})`
(`client/documents/abstract/world-collection.mjs:80`) is Foundry's OWN official import helper — NOT the
"`pack.getDocument(entryId)` → `Scene.create(doc.toObject())`" idiom this task was scoped to verify against (that
manual two-step form also works, but `importFromCompendium` is what Foundry's own compendium-sidebar "Import"
button calls, and it additionally applies `WorldCollection#fromCompendium`'s data hygiene — clearing `folder`/
`sort`/`ownership`/compendium `active` state and stamping `_stats.compendiumSource` — none of which the manual
two-step form does for free). Prefer it over the manual form.

**Background/Level-doc consideration for imported scenes — VERIFIED, not assumed, and GOOD NEWS relative to
`create_scene`'s own showstopper:** `create_scene`'s push path (above) needs the explicit `updateEmbeddedDocuments
("Level", …)` follow-up because it builds a scene from a FLAT `{name, background:{src}}` payload with no
embedded Level document of its own. `import_compendium_scene` does NOT have this problem: `importFromCompendium`
→ `fromCompendium` calls `document.toObject()` with its default `source=true` (confirmed by direct read of
`common/abstract/data.mjs:820`, `toObject(source=true) { return deepClone(this._source) }`) — this deep-clones
the COMPLETE source data of the compendium Scene document, which INCLUDES its embedded `levels` collection (the
`defaultLevel0000` doc that actually carries `background.src` on v14, per this contract's own `create_scene`
background-write-semantics note above). That full source, embedded Level doc and all, is what
`WorldCollection#importDocument` hands to `Scene.create(...)` — so a compendium Scene's real map art survives
the import automatically, with ZERO extra Level-doc write needed on this path. 38.1's implementer must still
VERIFY this live against a real Czepeku pack scene at implementation time (per this contract's own standing
"verify, don't assume, given `background`'s own proof that v14 silently drops naively-shaped fields" rule) —
but the mechanism is sound and does not need a bespoke fix the way `create_scene`/`update_scene` did.

An unresolvable `packId` or `entryId` (unknown pack, or a document id not present in that pack) is a per-op
failure (`ok:false`, §3), not a thrown/aborted batch — same convention as every other kind in this section.

### Reserved kinds — still NOT implemented (unchanged from v1; no phase has claimed these yet)

| `kind` | Indicative `data` shape | Notes |
|---|---|---|
| `create_actor` | `{ name: string, type: string, img?: string, system?: object }` | Push a bestiary/roster entry back INTO Foundry — not part of Phase 36's scope (36 pushes scenes/tokens/art, not actors) |

`walls`/`lighting` on `create_scene` (sketched in `plans/phase-32-deferred.md` §3a) and ambient-light
*placement* remain explicitly undesigned/out of scope — Phase 36 does not adopt them; a future phase that wants
them amends this contract then.

A producer or consumer encountering an unrecognized `kind` string in a future version MUST skip that one op
(record it as a failed result with a clear `error`, per §3) rather than aborting the whole batch — one bad/future
op must never block the rest of the queue.

---

## 3. `world-fabric-foundry-results.json` (Foundry → GM_Tools)

**`FOUNDRY_RESULTS_SCHEMA_VERSION = 1`** — same no-in-file-version-field reasoning as §2.

Top-level shape: flat JSON array, one entry per op FROM THE MOST RECENTLY APPLIED OPS BATCH:

```
[ Result, Result, ... ]

Result = {
  opId: string,          // correlates 1:1 with the Op that produced this result
  ok: boolean,
  foundryUuid?: string,   // present when ok:true AND the op created/identified a document (e.g. "Scene.abc123")
  error?: string          // present when ok:false — human-readable failure reason
}
```

**Correlation & write-back (32.3's job):** GM_Tools polls this file after writing an ops batch (mirroring
`applyMutationsToFoundry`'s poll-for-`[]` loop in `mutation-ops.mjs:109-129`, but polling for a non-empty
array containing its own `opId`s rather than for emptiness). For each `Result` with `ok:true` and a
`foundryUuid`, GM_Tools writes that UUID into the corresponding link field on ITS OWN store — e.g.
`create_scene`'s result UUID goes into `session-planner/scenes.mjs`'s new `foundrySceneRef` field on the scene
record that requested the push (matched via whatever GM_Tools-side bookkeeping maps `opId` → source record;
that bookkeeping lives in 32.3's ops-writer, not in this file's shape).

**Clearing convention:** GM_Tools (consumer here — the direction is reversed from §2) overwrites this file back
to `[]` once it has fully read and written back every result it needed from the current contents. Until GM_Tools
clears it, a later unrelated poll must not re-process already-handled results — 32.3's writer is responsible for
only ever treating results as "new" if their `opId` matches an outstanding op it's currently waiting on.

## Shape decision: why `ops`/`results` are flat arrays with NO in-file `version`, while `index` has one

The design record's own literal architecture shows `ops`/`results` as bare arrays (`[{opId,...}]`), matching
`world-fabric-mutations.json`'s existing shape exactly — and that existing file has never carried an in-file
version field either (its schema is versioned by code/doc discipline only, same as this contract now does for
`ops`/`results`). Wrapping them in `{version, ops:[...]}` would break the `Array.isArray()` check the Foundry
watcher's poll loop relies on for both the request and completion signal (an object isn't `[]`-clearable in the
same simple way). The `index` file has no such constraint — it's a single full-replace snapshot, not a
poll-and-clear queue — so it keeps the explicit `version` field, matching `world-fabric-snapshot.json`'s own
`meta.version` precedent (`graph-service.mjs:249`). **This is a deliberate, load-bearing asymmetry, not an
oversight** — 32.1/32.2/32.3 should not "fix" it into consistency.

## Compatibility rules (all three files)

1. A consumer reading `world-fabric-foundry-index.json` checks `version` against the highest it understands.
   `version` equal or lower → read normally (permissive parsing handles any newly-added optional fields). A
   HIGHER `version` than the consumer understands → best-effort read of known top-level keys, log a warning;
   never hard-fail, since the index is read-only/informational (a stale reader still gets a partially-useful
   pull rather than nothing).
2. `ops`/`results` have no in-file version to check (see above) — an unrecognized `kind` in an ops entry is
   handled per §2's per-op skip rule, which is the only forward-compat mechanism these two files need.
3. None of the three files may be read or written by any code path that also touches
   `world-fabric-snapshot.json` or `world-fabric-mutations.json` — they are fully independent files with fully
   independent watchers/writers.

## Changelog

- **v1** (Phase 32 task 32.0) — initial contract. `FOUNDRY_INDEX_VERSION = 1`,
  `FOUNDRY_OPS_SCHEMA_VERSION = 1`, `FOUNDRY_RESULTS_SCHEMA_VERSION = 1`.
- **v2** (Phase 36 task 36.0, this amendment) — all additive/corrective, **no `*_VERSION` constant bumped**
  anywhere (every change below qualifies as "additive-only" per this doc's own cross-cutting convention):
  - `create_scene.data` grows `grid?`/`tokens?`/`foreground?` (§2).
  - NEW implemented op kinds: `update_scene`, `create_token`, `create_journal_image` (all three were "reserved,
    shape may change" in v1 — now implemented per 36.1, shapes finalized as documented in §2).
  - **Background write semantics pinned as a documented v14 showstopper**: `background`/`foreground` on
    `create_scene`/`update_scene` write via the embedded Level doc (`updateEmbeddedDocuments("Level",
    [{_id:"defaultLevel0000","background.src":...}])`), NOT `Scene.create`'s/`scene.update()`'s own field —
    that field is silently ignored on v14. Applies to BOTH create and update.
  - `create_token`'s v14 `actorId`-not-`actorUuid` gotcha documented explicitly (deferred §2, reused verbatim).
  - Index gains top-level `playlists: Playlist[]` (§1.5), additive-optional.
  - `PlacedToken.actorUuid` corrective note: the contract's shape was always base `"Actor.<id>"`; 32.1's shipped
    `extractToken` had a real defect emitting a compound uuid instead — 36.1 fixes the implementation to match
    the ALREADY-DOCUMENTED shape (not a shape change, a bugfix — see §1.4's own note).
  - GM_Tools-side quiet-push spec (Scene additive fields, stage route, flush semantics, map-src resolution,
    local-copy path) lives in `review-ui/test/e2e/phase36-fixture.mjs`, not in this file — this file stays
    scoped to the wire format only, per its own "Scope and non-goals" section at the top.
- **v3** (Phase 38 task 38.0, this amendment) — all additive, **no `*_VERSION` constant bumped** (both changes
  qualify as "additive-only" per this doc's own cross-cutting convention):
  - Index gains top-level `worldItems: Item[]` (§1.6, `game.items` — closes the "loose world items invisible"
    blind spot) and `compendia: CompendiumPackInfo[]` (§1.7, `game.packs` header enumeration via `pack.index`
    only, Scene packs additionally get `entries:[{id,name,thumb}]`) — both additive-optional.
  - NEW op kind `import_compendium_scene` (§2): `{packId, entryId}` → a real world Scene, via Foundry's own
    `game.scenes.importFromCompendium(pack, entryId)` — verified this does NOT need `create_scene`'s Level-doc
    background fix (the compendium document's own embedded Level doc round-trips through `toObject()` for free).
  - GM_Tools-side content-pipeline spec (Reliquary/Stagecraft pull-mapper shapes, the import-on-accept
    composition + pending/reconcile reuse, plan-delete rail contract, the Loyalty tree + `anchorMembership` op)
    lives in `review-ui/test/e2e/phase38-fixture.mjs`, not in this file — same "wire format only" scoping as v2.

---

## Fixtures (executable form of this contract)

Location: `wf-mcp-server/test/fixtures/foundry-bridge/` (new directory — `wf-mcp-server/test/` has no existing
fixtures subdirectory as of this writing; `GM_Tools/test/fixtures/` holds root-suite fixtures for an unrelated
purpose, so a bridge-specific subfolder under `wf-mcp-server/test/fixtures/` keeps this discoverable next to
the 32.2/32.3 code that will consume it, without colliding with either existing convention).

| File | Purpose |
|---|---|
| `foundry-index.sample.json` | Rich, valid index: 2 monsters (npc, hp/ac/cr, items incl. a recharge feature + effect), 1 PC (character, owned by a user, class item + skills), 1 scene with background + a placed token. All uuids cross-referenced and internally consistent. |
| `foundry-index.minimal.json` | Valid but sparse: one non-dnd5e-ish actor missing `system.cr`/`abilities`/`skills` etc., no users, one scene with no background/tokens. Exercises the "every `system.*` field optional, mapper must tolerate absence" rule. |
| `foundry-ops.create-scene.sample.json` | One `create_scene` op. |
| `foundry-results.sample.json` | The matching result for that op (`ok:true`, `foundryUuid`). |

**(v2, Phase 36)** No new fixture files are added to this directory by task 36.0 — the v2 op-shape fixtures
(`update_scene`/`create_token`/`create_journal_image`/the extended `create_scene`) live as inline constants in
`review-ui/test/e2e/phase36-fixture.mjs` instead (36.2's flush-engine composer and 36.1's pure-fn module tests
both consume THOSE shapes directly, per that file's own header — the "shared-fixture discipline" this project
established in Phase 32 continues, just anchored in the newer e2e-fixture convention rather than growing this
older `wf-mcp-server/test/fixtures/` directory further).

**(v3, Phase 38)** Same discipline continues one level further — the v3 shapes (`worldItems[]`, `compendia[]`,
`import_compendium_scene`) live as inline constants/mock-index builders in `review-ui/test/e2e/phase38-fixture.mjs`,
not as new files under this directory.

## Grounding (file:line used while writing this contract)

- `foundry_worldFabric/scripts/data/graph-service.mjs:238` `exportSnapshot()`, `:274` `startMutationWatcher()`,
  `:296-298` overwrite-to-`[]` comment.
- `foundry_worldFabric/scripts/data/interchange.mjs:17` `WFI_VERSION`, `:204` `normalizeEntity` (`imageUrl`,
  `foundryRef` field-naming precedent).
- `foundry_worldFabric/scripts/apps/cockpit-app.mjs:835-910` `_pushSelectionToFoundry` (existing push: v14
  `Scene.background={src}`, journal page shape, the `globalThis[Type].create` habit this phase's push code
  should NOT repeat — use `getDocumentClass` instead).
- `foundry_worldFabric/scripts/data/pack-scan.mjs:~105` — the one place `actor.system.details.cr` /
  `actor.system.details.biography.value` are read today, confirming those exact dnd5e paths.
- `GM_Tools/combat-planning/bestiary-ingest.mjs:84` `RawBestiaryFields`.
- `GM_Tools/combat-planning/party-roster-ingest.mjs:45-71` `CombatRelevant`/`BuildRelevant`/`RawPartyMemberFields`.
- `GM_Tools/wf-mcp-server/lib/mutation-ops.mjs:109-149` `applyMutationsToFoundry`/`applyMutationsWithHeadlessFallback`
  (the write+poll pattern §2/§3 mirror).
- `GM_Tools/wf-mcp-server/lib/snapshot.mjs` (`snapshotFilePath`/`mutationsPath` — path convention the new files follow).
