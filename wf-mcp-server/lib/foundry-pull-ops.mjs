/**
 * Foundry actor PULL ingest — Phase 32 task 32.2 (the phase's PRIMARY
 * deliverable). Composes the read-only foundry-index reader
 * (./foundry-index.mjs) with the pure actor→raw-fields mappers
 * (combat-planning/foundry-actor-mapper.mjs) and the two EXISTING
 * bestiary/party-roster stores — shared verbatim by review-ui/server.mjs's
 * POST /api/foundry/pull-actors route and wf-mcp-server/index.mjs's
 * wf_pull_foundry_actors tool, per gm-tools-conventions' "front-ends are
 * thin wrappers, never logic duplicators."
 *
 * REVIEW-GATED, per the no-silent-auto-write invariant: every candidate
 * lands as status:'proposed', NEVER 'accepted' — exactly like every other
 * ingest path in this project (bestiary's existing LLM text/PDF ingest
 * already works this way).
 *
 * DEDUP/LINK BY foundryActorRef — re-running the pull for a world:
 *   - a matching status:'proposed' entry/member is UPDATED IN PLACE
 *     (id/createdAt preserved) — a stale, not-yet-reviewed candidate should
 *     reflect Foundry's current state, not pile up as a duplicate.
 *   - a matching status:'accepted' entry/member is LEFT COMPLETELY
 *     UNTOUCHED — a human decision, possibly hand-edited since acceptance.
 *     Reported back under `alreadyLinked` so a caller/UI can say "already
 *     synced" instead of silently doing nothing with no explanation.
 *   - otherwise, a brand-new proposed candidate is created.
 * See combat-planning/party-roster-store.mjs's own header comment for why
 * party-roster gained the SAME status gate bestiary already had, rather
 * than the "return candidates without saving" alternative.
 *
 * Phase 35 task 35.1, §6 of review-ui/test/e2e/phase35-fixture.mjs (THE
 * WRITTEN CONTRACT): this composition grows to ALSO read `index.scenes[]`
 * (already present on every index per the bridge contract §1.3 -- the
 * pre-35.1 implementation read ONLY `index.actors`) in the SAME pass, per
 * plans/phase-32-deferred.md §1/§2's own designs. Response shape gains
 * THREE new keys -- `itemsProposed`, `stagecraftProposed`, `tokensSynced` --
 * alongside the EXISTING `bestiaryProposed`/`partyProposed`/`alreadyLinked`/
 * `skippedActors` (all four UNCHANGED, this is a strictly additive response
 * shape); `alreadyLinked` itself gains a THIRD key, `items`.
 *
 * itemsProposed SCOPE (deferred §1's own scope rule, reused verbatim): only
 * a PC actor's (classifyActor==="pc") items[] feed Reliquary -- a monster's
 * items[] already feeds mapActorToBestiary's own attack/feature derivation,
 * never Reliquary. Within a PC's items[], mapActorItemsToInventory
 * (combat-planning/foundry-actor-mapper.mjs) further excludes class/weapon/
 * feat items -- those already feed this SAME actor's own combat-relevant
 * stat block via mapActorToPartyMember, so surfacing them a second time as
 * Reliquary rows would just duplicate that data (this filter is THIS task's
 * own resolution of an ambiguity the written contract's §6 prose leaves
 * open -- "one per actors[].items[] entry" could be read as "every item,
 * no filter" -- resolved by cross-checking the concrete, already-written
 * assertion in test/e2e/phase35-pull-and-persistence.e2e.mjs, which pins
 * Kestrel Windrider's itemsProposed count at exactly 3, excluding her
 * Ranger class item and Longbow weapon; flagged here and in this task's own
 * completion report as a deviation-resolution, not a silent guess).
 *
 * ownerPartyMemberId resolution: always the PartyMember.id JUST created/
 * updated for this SAME PC actor in this SAME pass (upsertPartyMember's own
 * return value) -- deferred §1's "one click populates bestiary + roster +
 * items together" ordering, never a second lookup pass.
 *
 * stagecraftProposed: one `kind:"map"` StagecraftAsset per `index.scenes[]`
 * entry that has a usable background (a scene with `background:null`, or no
 * `background.src`, is SKIPPED -- "nothing to reference yet", README §H).
 * Dedup/upsert on `foundryRef.sceneUuid`, the SAME three-way branch as
 * upsertBestiary/upsertItem, one more time. Deliberately does NOT gain its
 * own `alreadyLinked` bucket (the written contract's §6 text scopes that
 * addition to `items` only) -- an already-`accepted` map asset is simply
 * left untouched and not re-reported, same effect, no new response key.
 *
 * tokensSynced: one entry per distinct sceneUuid appearing in EITHER
 * `index.scenes[]` OR the flattened `index.tokens[]` (the union, so a scene
 * with zero placed tokens this run still gets its token set correctly
 * wiped/replaced and reported as `count:0`, per token-store.mjs's own
 * REPLACE-semantics doc comment) -- `syncTokensForScene` does the actual
 * per-scene replace + best-effort sceneId resolution.
 *
 * Phase 38 task 38.2, §2/§3 of review-ui/test/e2e/phase38-fixture.mjs (THE
 * WRITTEN CONTRACT) -- TWO more loops, same pass, folded into the EXISTING
 * `itemsProposed`/`stagecraftProposed` buckets (no new response keys):
 *   - `index.worldItems[]` -> Reliquary UNOWNED proposals (both owner fields
 *     null -- a loose world item has no owning actor), via the SAME
 *     `upsertItem` three-way branch keyed on `foundryItemRef`, now
 *     generalized to take its owner/sourceText from the caller instead of
 *     deriving them from an `actor` (see foundry-actor-mapper.mjs's
 *     `mapItemToInventoryFields` doc comment for the shared-derivation
 *     refactor this composes with).
 *   - `index.compendia[]` Scene-pack `entries[]` -> Stagecraft `kind:"map"`
 *     browse rows carrying a NEW additive `compendiumRef:{packId,entryId}`
 *     + `foundryRef:null` (not yet imported) + meta "in compendium — import
 *     to stage", via a NEW `upsertCompendiumBrowseRow`, one level over
 *     `upsertStagecraftMap`'s own three-way branch, keyed on
 *     `compendiumRef.packId+entryId` instead of `foundryRef.sceneUuid`. A
 *     non-Scene pack (or a Scene pack with no `entries` key) contributes
 *     nothing.
 */
import { readFoundryIndex } from "./foundry-index.mjs";
import {
  classifyActor,
  mapActorToBestiary,
  mapActorToPartyMember,
  mapActorItemsToInventory,
  mapItemToInventoryFields
} from "../../combat-planning/foundry-actor-mapper.mjs";
import { saveBestiaryEntry, listBestiaryEntries, updateBestiaryEntryRawFields } from "../../combat-planning/bestiary-store.mjs";
import { savePartyMember, listPartyMembers, updatePartyMemberFields } from "../../combat-planning/party-roster-store.mjs";
import { saveItem, listItems, updateItemFields } from "../../combat-planning/item-store.mjs";
import { saveStagecraftAsset, listStagecraftAssets, updateStagecraftAssetFields } from "../../session-planner/stagecraft-store.mjs";
import { syncTokensForScene } from "../../session-planner/token-store.mjs";

function sourceTextFor(actor) {
  return `Pulled from Foundry actor ${actor.uuid} (${actor.name ?? "unnamed"}).`;
}

function sourceTextForItem(actor, item) {
  return `Pulled from Foundry actor ${actor.uuid}, item ${item.foundryItemRef} (${item.name}).`;
}

/** Phase 38 task 38.2, §2 -- a loose `worldItems[]` entry has no owning actor, so its sourceText carries no actor uuid to cite. */
const SOURCE_TEXT_FOR_WORLD_ITEM = "Pulled from Foundry world items.";

/** Phase 38 task 38.2, §3 -- StagecraftAsset.meta for a not-yet-imported compendium browse row. */
const COMPENDIUM_BROWSE_META = "in compendium — import to stage";

/**
 * Derived display string from a scene's width/height/grid -- free-form, not
 * parsed back (StagecraftAsset.meta's own documented shape). Fail-soft: any
 * missing piece is simply omitted from the joined string, never throws.
 */
function sceneMetaString(scene) {
  const parts = [];
  if (typeof scene?.width === "number" && typeof scene?.height === "number") {
    parts.push(`${scene.width}x${scene.height}`);
  }
  const grid = scene?.grid;
  if (grid && typeof grid.size === "number") {
    const distance = typeof grid.distance === "number" ? grid.distance : "?";
    const units = typeof grid.units === "string" ? grid.units : "";
    parts.push(`grid ${grid.size}/${distance}${units}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

function upsertBestiary(actor, mapped, opts) {
  const matches = listBestiaryEntries().filter((e) => e.foundryActorRef === actor.uuid);
  const acceptedMatch = matches.find((e) => e.status === "accepted");
  if (acceptedMatch) return { record: acceptedMatch, action: "already-linked" };

  const proposedMatch = matches.find((e) => e.status === "proposed");
  if (proposedMatch) {
    const entry = updateBestiaryEntryRawFields(proposedMatch.id, { rawFields: mapped, sourceText: sourceTextFor(actor) });
    return { record: entry, action: "updated" };
  }

  const entry = saveBestiaryEntry({ rawFields: mapped, sourceText: sourceTextFor(actor), foundryActorRef: actor.uuid }, opts);
  return { record: entry, action: "created" };
}

function upsertPartyMember(world, actor, mapped, opts) {
  const matches = listPartyMembers(world).filter((m) => m.foundryActorRef === actor.uuid);
  const acceptedMatch = matches.find((m) => m.status === "accepted");
  if (acceptedMatch) return { record: acceptedMatch, action: "already-linked" };

  const proposedMatch = matches.find((m) => m.status === "proposed");
  if (proposedMatch) {
    const member = updatePartyMemberFields(world, proposedMatch.id, {
      name: mapped.name,
      combatRelevant: mapped.combatRelevant,
      buildRelevant: mapped.buildRelevant,
      sourceText: sourceTextFor(actor)
    });
    return { record: member, action: "updated" };
  }

  const member = savePartyMember(
    world,
    {
      name: mapped.name,
      combatRelevant: mapped.combatRelevant,
      buildRelevant: mapped.buildRelevant,
      sourceText: sourceTextFor(actor),
      foundryActorRef: actor.uuid,
      status: "proposed"
    },
    opts
  );
  return { record: member, action: "created" };
}

/**
 * upsertItem -- Phase 35 task 35.1, §6, GENERALIZED at Phase 38 task 38.2 §2
 * so it works for BOTH an actor-embedded item (ownerFoundryActorUuid/
 * ownerPartyMemberId set) and a loose `worldItems[]` entry (both null) --
 * same three-way branch as upsertBestiary/upsertPartyMember, keyed on
 * foundryItemRef, with the owner/sourceText now supplied by the caller
 * rather than derived from an `actor` this function no longer requires.
 */
function upsertItem(world, mappedItem, { ownerFoundryActorUuid = null, ownerPartyMemberId = null, sourceText = null } = {}, opts) {
  const matches = listItems(world).filter((i) => i.foundryItemRef === mappedItem.foundryItemRef);
  const acceptedMatch = matches.find((i) => i.status === "accepted");
  if (acceptedMatch) return { record: acceptedMatch, action: "already-linked" };

  const proposedMatch = matches.find((i) => i.status === "proposed");
  if (proposedMatch) {
    const item = updateItemFields(world, proposedMatch.id, {
      name: mappedItem.name,
      type: mappedItem.type,
      quantity: mappedItem.quantity,
      description: mappedItem.description,
      sourceText,
      ownerFoundryActorUuid,
      ownerPartyMemberId
    });
    return { record: item, action: "updated" };
  }

  const item = saveItem(
    world,
    {
      name: mappedItem.name,
      type: mappedItem.type,
      quantity: mappedItem.quantity,
      description: mappedItem.description,
      foundryItemRef: mappedItem.foundryItemRef,
      ownerFoundryActorUuid,
      ownerPartyMemberId,
      sourceText
    },
    opts
  );
  return { record: item, action: "created" };
}

/** upsertStagecraftMap -- Phase 35 task 35.1, §6. Same three-way branch, keyed on foundryRef.sceneUuid. No dedicated alreadyLinked bucket (see this file's own header note). */
function upsertStagecraftMap(world, scene, opts) {
  const matches = listStagecraftAssets(world, "map").filter((a) => a.foundryRef?.sceneUuid === scene.uuid);
  const acceptedMatch = matches.find((a) => a.status === "accepted");
  if (acceptedMatch) return { record: acceptedMatch, action: "already-linked" };

  // Phase 36 task 36.2, §4 -- capture `background.src` as `foundryRef.imagePath`
  // whenever usable (hasUsableBackground, below, already computes exactly
  // this condition -- this just threads the value through, where before it
  // was discarded after the guard check). Additive-optional key on
  // foundryRef -- absent when `hasUsableBackground` is false, but that case
  // never reaches here (the caller loop below skips the scene entirely).
  const mapped = {
    name: typeof scene?.name === "string" && scene.name ? scene.name : "Unnamed Scene",
    source: "foundry",
    meta: sceneMetaString(scene),
    foundryRef: { sceneUuid: scene.uuid, imagePath: scene.background.src }
  };

  const proposedMatch = matches.find((a) => a.status === "proposed");
  if (proposedMatch) {
    const asset = updateStagecraftAssetFields(world, proposedMatch.id, mapped);
    return { record: asset, action: "updated" };
  }

  const asset = saveStagecraftAsset(world, { kind: "map", ...mapped, status: "proposed" }, opts);
  return { record: asset, action: "created" };
}

/** True only when a scene has a genuinely usable background to reference -- README §H: "a null background has nothing findable." */
function hasUsableBackground(scene) {
  return typeof scene?.background?.src === "string" && scene.background.src.length > 0;
}

/**
 * upsertCompendiumBrowseRow -- Phase 38 task 38.2, §3. One level over
 * upsertStagecraftMap's own three-way branch (same shape, exactly), keyed on
 * `compendiumRef.packId + compendiumRef.entryId` instead of
 * `foundryRef.sceneUuid` -- a compendium Scene entry that hasn't been
 * imported yet has no `foundryRef.sceneUuid` to key on. `kind:"map"`
 * deliberately reuses the existing map shelf (not a new kind); `thumb` is an
 * ADDITIVE-ONLY field (not part of the contract's own pinned StagecraftAsset
 * candidate shape) carried through so the Library's browse-row rendering has
 * something to show -- absent/`null` changes nothing about the pinned
 * fixture assertions (name/meta/compendiumRef/foundryRef/status), it is
 * purely additive.
 *
 * ACCEPTED-match branch left untouched, same reasoning as upsertStagecraftMap
 * -- this is what makes "an imported entry's browse row and its resulting
 * world-scene row must NOT duplicate" hold structurally (see this file's own
 * header comment / phase38-fixture.mjs §3): once imported,
 * compendiumRef+foundryRef.sceneUuid live on the SAME accepted row, so BOTH
 * this branch (matching on compendiumRef) and upsertStagecraftMap's own
 * branch (matching on the newly-created world scene's sceneUuid, on some
 * FUTURE pull that also re-syncs scenes[]) converge on that one record.
 */
function upsertCompendiumBrowseRow(world, pack, entry, opts) {
  const matches = listStagecraftAssets(world, "map").filter(
    (a) => a.compendiumRef?.packId === pack.packId && a.compendiumRef?.entryId === entry.id
  );
  const acceptedMatch = matches.find((a) => a.status === "accepted");
  if (acceptedMatch) return { record: acceptedMatch, action: "already-linked" };

  const mapped = {
    name: typeof entry?.name === "string" && entry.name ? entry.name : "Unnamed Scene",
    source: "foundry",
    meta: COMPENDIUM_BROWSE_META,
    thumb: typeof entry?.thumb === "string" ? entry.thumb : null
  };

  const proposedMatch = matches.find((a) => a.status === "proposed");
  if (proposedMatch) {
    const asset = updateStagecraftAssetFields(world, proposedMatch.id, mapped);
    return { record: asset, action: "updated" };
  }

  const asset = saveStagecraftAsset(
    world,
    {
      kind: "map",
      ...mapped,
      foundryRef: null,
      compendiumRef: { packId: pack.packId, entryId: entry.id },
      status: "proposed"
    },
    opts
  );
  return { record: asset, action: "created" };
}

/**
 * Every distinct sceneUuid touched this pull -- the union of index.scenes[]
 * and the flattened index.tokens[]'s own sceneUuid, so a scene with zero
 * placed tokens this run still gets its token set correctly wiped/replaced
 * (token-store.mjs's own REPLACE-semantics doc comment).
 */
function distinctSceneUuidsWithTokens(index) {
  const bySceneUuid = new Map();
  for (const scene of Array.isArray(index.scenes) ? index.scenes : []) {
    if (scene?.uuid && !bySceneUuid.has(scene.uuid)) bySceneUuid.set(scene.uuid, []);
  }
  for (const token of Array.isArray(index.tokens) ? index.tokens : []) {
    if (!token?.sceneUuid) continue;
    if (!bySceneUuid.has(token.sceneUuid)) bySceneUuid.set(token.sceneUuid, []);
    bySceneUuid.get(token.sceneUuid).push(token);
  }
  return bySceneUuid;
}

/**
 * @param {string} dataDir
 * @param {string} world
 * @param {object} [opts]   forwarded to saveBestiaryEntry/savePartyMember/saveItem/saveStagecraftAsset (makeId/now — test-injectable determinism)
 * @returns {{
 *   indexFound: boolean,
 *   bestiaryProposed: object[],               // bestiary entries now status:'proposed' (created OR updated this run)
 *   partyProposed: object[],                  // party members now status:'proposed' (created OR updated this run)
 *   itemsProposed: object[],                  // ItemRecords now status:'proposed' (PC actors' items[] only, created OR updated this run)
 *   stagecraftProposed: object[],              // StagecraftAssets (kind:"map") now status:'proposed' (created OR updated this run)
 *   tokensSynced: {sceneUuid:string, count:number}[],   // one entry per distinct sceneUuid touched, count = TokenRecords on file for that scene AFTER the replace
 *   alreadyLinked: {bestiary: string[], party: string[], items: string[]},  // foundryActorRefs/foundryItemRefs skipped because already 'accepted'
 *   skippedActors: {uuid: string, reason: string}[]         // actors that couldn't be classified/mapped (defense-in-depth; the mappers themselves never throw)
 * }}
 */
export function pullFoundryActorsToStores(dataDir, world, opts = {}) {
  const index = readFoundryIndex(dataDir, world);
  // Phase 38 task 38.2 fix: the ORIGINAL guard here was `!index ||
  // !Array.isArray(index.actors) || index.actors.length === 0` -- treating
  // "index exists but has zero actors" identically to "no index file at
  // all" and bailing out before EVER reaching the scenes[]/worldItems[]/
  // compendia[] loops below. That was harmless before this phase (every
  // real/fixture index that existed also had actors), but phase38-fixture.mjs's
  // own minimal index (§7 -- "no actors/scenes, only worldItems+compendia")
  // is the first fixture to exercise an index with actors:[] and real content
  // in the OTHER top-level arrays -- only a genuinely MISSING index file
  // (readFoundryIndex returning null) short-circuits now; an empty
  // `actors[]` simply makes the actor loop below a no-op, same as an empty
  // `scenes[]`/`worldItems[]`/`compendia[]` already was.
  if (!index) {
    return {
      indexFound: false,
      bestiaryProposed: [],
      partyProposed: [],
      itemsProposed: [],
      stagecraftProposed: [],
      tokensSynced: [],
      alreadyLinked: { bestiary: [], party: [], items: [] },
      skippedActors: []
    };
  }

  const bestiaryProposed = [];
  const partyProposed = [];
  const itemsProposed = [];
  const stagecraftProposed = [];
  const alreadyLinked = { bestiary: [], party: [], items: [] };
  const skippedActors = [];

  for (const actor of Array.isArray(index.actors) ? index.actors : []) {
    if (!actor || typeof actor !== "object" || !actor.uuid) {
      skippedActors.push({ uuid: actor?.uuid ?? "(missing uuid)", reason: "actor is missing a uuid -- cannot dedup/link, skipped" });
      continue;
    }
    try {
      const role = classifyActor(actor, index.users);
      if (role === "pc") {
        const mapped = mapActorToPartyMember(actor);
        const { record, action } = upsertPartyMember(world, actor, mapped, opts);
        if (action === "already-linked") alreadyLinked.party.push(actor.uuid);
        else partyProposed.push(record);

        // Phase 35 task 35.1, §6 -- items are strictly a function of the PC
        // actor just pulled, populated in the SAME pass so ownerPartyMemberId
        // can resolve against `record` above with no second pull action.
        for (const mappedItem of mapActorItemsToInventory(actor)) {
          if (!mappedItem.foundryItemRef) continue; // can't dedup/link without a stable ref -- skip, matching the actor-uuid guard above
          const { record: itemRecord, action: itemAction } = upsertItem(
            world,
            mappedItem,
            { ownerFoundryActorUuid: actor.uuid, ownerPartyMemberId: record.id, sourceText: sourceTextForItem(actor, mappedItem) },
            opts
          );
          if (itemAction === "already-linked") alreadyLinked.items.push(mappedItem.foundryItemRef);
          else itemsProposed.push(itemRecord);
        }
      } else {
        const mapped = mapActorToBestiary(actor);
        const { record, action } = upsertBestiary(actor, mapped, opts);
        if (action === "already-linked") alreadyLinked.bestiary.push(actor.uuid);
        else bestiaryProposed.push(record);
      }
    } catch (err) {
      // Defense-in-depth only -- classifyActor/mapActorToBestiary/
      // mapActorToPartyMember are themselves guaranteed never to throw
      // (unit-tested against both 32.0 fixtures); this catch exists so one
      // genuinely unanticipated bad actor record can never abort the whole
      // pull for every other actor in the index.
      skippedActors.push({ uuid: actor.uuid, reason: err.message });
    }
  }

  // Phase 35 task 35.1, §6 -- scenes[] -> Stagecraft `map` refs.
  for (const scene of Array.isArray(index.scenes) ? index.scenes : []) {
    if (!scene || typeof scene !== "object" || !scene.uuid) continue;
    if (!hasUsableBackground(scene)) continue; // "a null background has nothing findable" -- skipped, not proposed
    try {
      const { record, action } = upsertStagecraftMap(world, scene, opts);
      if (action !== "already-linked") stagecraftProposed.push(record);
    } catch {
      // Defense-in-depth only, same reasoning as the actor loop's own catch --
      // a genuinely malformed scene record must never abort the whole pull.
    }
  }

  // Phase 38 task 38.2, §2 -- worldItems[] -> Reliquary UNOWNED proposals
  // (ownerFoundryActorUuid/ownerPartyMemberId both null -- no owning actor
  // exists for a loose world item). Unlike an actor's own items[], NO type
  // filter applies here (§2's resolved ambiguity, foundry-actor-mapper.mjs's
  // own header comment) -- every worldItems[] entry becomes a candidate.
  for (const worldItem of Array.isArray(index.worldItems) ? index.worldItems : []) {
    if (!worldItem || typeof worldItem !== "object" || !worldItem.uuid) continue;
    try {
      const mappedItem = mapItemToInventoryFields(worldItem);
      if (!mappedItem.foundryItemRef) continue; // can't dedup/link without a stable ref -- skip, matching the actor loop's own guard
      const { record: itemRecord, action: itemAction } = upsertItem(
        world,
        mappedItem,
        { ownerFoundryActorUuid: null, ownerPartyMemberId: null, sourceText: SOURCE_TEXT_FOR_WORLD_ITEM },
        opts
      );
      if (itemAction === "already-linked") alreadyLinked.items.push(mappedItem.foundryItemRef);
      else itemsProposed.push(itemRecord);
    } catch {
      // Defense-in-depth only, same reasoning as the actor loop's own catch.
    }
  }

  // Phase 38 task 38.2, §3 -- compendia[] Scene-pack entries -> Stagecraft
  // browse rows. A non-Scene pack (or a Scene pack with no `entries` key)
  // contributes nothing -- browsable entries are a Scene-only concept.
  for (const pack of Array.isArray(index.compendia) ? index.compendia : []) {
    if (!pack || pack.documentType !== "Scene" || !Array.isArray(pack.entries)) continue;
    for (const entry of pack.entries) {
      if (!entry || typeof entry !== "object" || !entry.id) continue;
      try {
        const { record, action } = upsertCompendiumBrowseRow(world, pack, entry, opts);
        if (action !== "already-linked") stagecraftProposed.push(record);
      } catch {
        // Defense-in-depth only, same reasoning as the scenes[] loop's own catch.
      }
    }
  }

  // Phase 35 task 35.1, §6 -- tokens[] -> token-index, per-scene REPLACE.
  const tokensSynced = [];
  for (const [sceneUuid, tokens] of distinctSceneUuidsWithTokens(index)) {
    const synced = syncTokensForScene(world, sceneUuid, tokens, index.exportedAt, opts);
    tokensSynced.push({ sceneUuid, count: synced.length });
  }

  return { indexFound: true, bestiaryProposed, partyProposed, itemsProposed, stagecraftProposed, tokensSynced, alreadyLinked, skippedActors };
}
