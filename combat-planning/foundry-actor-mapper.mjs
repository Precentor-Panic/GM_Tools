/**
 * Foundry actor → RawBestiaryFields / RawPartyMemberFields mappers — Phase
 * 32 task 32.2 (the phase's primary deliverable). PURE, plain-object-in/
 * plain-object-out, no store/fs/network access whatsoever — every function
 * here is unit-testable with zero live Foundry, driven by the 32.0 fixtures
 * (wf-mcp-server/test/fixtures/foundry-bridge/foundry-index.sample.json +
 * .minimal.json).
 *
 * Reads worlds/<world>/world-fabric-foundry-index.json's `actors[]`/
 * `users[]` shape exactly as plans/phase-32-bridge-contract.md §1 defines
 * it. Per that contract: EVERY `system.*` field is optional and no mapper
 * may assume any of them are present — every accessor below uses optional
 * chaining/defensive fallbacks, and a malformed/unexpected `items[]` entry
 * is skipped (fail-soft), never thrown.
 *
 * DERIVATION SCOPE (contract's own explicit design decision, §1.1
 * "ActorSystem"): attacks/multiattack/rechargeAbilities/legendaryActions
 * are NOT modeled as first-class index fields — they're derived HERE from
 * `actor.items[]` (dnd5e's raw, unmodeled `item.system` blob) and
 * `appliedEffects`/`auraEffects` from `actor.effects[]`. This keeps the
 * wire format a thin pass-through of Foundry's own documents; this module
 * is where dnd5e's action-economy semantics actually live, exactly as the
 * contract calls for.
 *
 * Every derivation below is BEST-EFFORT, documented inline where the
 * heuristic is fuzzy (multiattack count parsing from free-text feature
 * descriptions is the fuzziest one) — read the derived fields as a starting
 * draft a human reviews (review-gated, status:'proposed'), never as ground
 * truth, matching the contract's own "fail soft on a field it doesn't
 * recognize" instruction for `item.system`.
 */
import { diceAverage } from "./dice.mjs";

// --- small local helpers (pure) -------------------------------------------

const WORD_TO_NUMBER = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10
};

/**
 * Best-effort strip of HTML tags from a Foundry biography/description blob.
 * Never throws. EXPORTED as of Phase 35 task 35.1 (per
 * plans/phase-32-deferred.md §1's own instruction -- combat-planning/
 * item-store.mjs's ItemRecord.description reuses this exact helper via
 * mapActorItemsToInventory below, rather than a second HTML-stripping
 * implementation).
 */
export function stripHtml(html) {
  if (typeof html !== "string") return null;
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

/** First [diceString, damageType] pair off a dnd5e weapon item's system.damage.parts, or [null, undefined]. */
function firstDamagePart(item) {
  const parts = item?.system?.damage?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return [null, undefined];
  const first = parts[0];
  if (!Array.isArray(first)) return [null, undefined];
  return [typeof first[0] === "string" ? first[0] : null, typeof first[1] === "string" ? first[1] : undefined];
}

/**
 * Weapon-type items → RawAttack[] (bestiary-ingest.mjs's RawAttack shape:
 * {name, toHitBonus?, damageDice, damageType?}). Skips (fail-soft) any item
 * missing a usable damage-dice string rather than emitting a broken attack.
 */
function deriveAttacksFromItems(items) {
  if (!Array.isArray(items)) return [];
  const attacks = [];
  for (const item of items) {
    if (!item || item.type !== "weapon") continue;
    const [damageDice, damageType] = firstDamagePart(item);
    if (!damageDice) continue;
    attacks.push({
      name: typeof item.name === "string" && item.name ? item.name : "Unnamed Attack",
      toHitBonus: typeof item?.system?.attackBonus === "number" ? item.system.attackBonus : undefined,
      damageDice,
      damageType
    });
  }
  return attacks;
}

/**
 * A feat item literally named "Multiattack" → RawMultiattack ({count,
 * attackNames?}), per dnd5e's own naming convention (confirmed by the 32.0
 * sample fixture). BEST-EFFORT count parsing out of the feature's free-text
 * description (digit or a one..ten word) — returns undefined (no guess)
 * when no count can be confidently parsed, rather than fabricating a
 * default. attackNames is populated with whichever of this actor's own
 * derived weapon-attack names appear (case-insensitive substring) in the
 * description text.
 */
function deriveMultiattack(items, attacks) {
  if (!Array.isArray(items)) return undefined;
  const multiattackItem = items.find(
    (it) => it && it.type === "feat" && typeof it.name === "string" && it.name.trim().toLowerCase() === "multiattack"
  );
  if (!multiattackItem) return undefined;

  const description = stripHtml(multiattackItem?.system?.description?.value) ?? "";
  const lower = description.toLowerCase();
  const match = lower.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  if (!match) return undefined; // can't confidently parse a count -- no fabricated default

  const count = /^\d+$/.test(match[1]) ? Number(match[1]) : WORD_TO_NUMBER[match[1]];
  if (!Number.isFinite(count) || count <= 0) return undefined;

  const attackNames = (attacks ?? [])
    .map((a) => a.name)
    .filter((name) => typeof name === "string" && lower.includes(name.toLowerCase()));

  return attackNames.length > 0 ? { count, attackNames } : { count };
}

/**
 * Feat items carrying dnd5e's `system.recharge` sub-field → RawRechargeAbility[]
 * ({name, rechargeOn, damageDice?}). rechargeOn is formatted "<value>+" (e.g.
 * "5+" for a 5-6 recharge) -- the contract leaves the exact string format
 * unspecified beyond z.string(), and "5+" is the standard dnd5e stat-block
 * phrasing this mirrors. damageDice is a best-effort XdY pull out of the
 * feature's free-text description, omitted if none is found.
 */
function deriveRechargeAbilities(items) {
  if (!Array.isArray(items)) return undefined;
  const abilities = [];
  for (const item of items) {
    if (!item || item.type !== "feat") continue;
    const recharge = item?.system?.recharge;
    if (!recharge || typeof recharge.value !== "number") continue;
    const description = stripHtml(item?.system?.description?.value) ?? "";
    const diceMatch = description.match(/\b\d+d\d+(?:\s*[+-]\s*\d+)?\b/);
    abilities.push({
      name: typeof item.name === "string" && item.name ? item.name : "Unnamed Recharge Ability",
      rechargeOn: `${recharge.value}+`,
      damageDice: diceMatch ? diceMatch[0] : undefined
    });
  }
  return abilities.length > 0 ? abilities : undefined;
}

/**
 * dnd5e activation lookup, BOTH shapes -- Phase 36 task 36.2 addendum
 * (orchestrator-flagged scope addition, evidence from the 36.1
 * foundry_worldFabric module wave): dnd5e v3 stores an item's activation
 * directly at `item.system.activation` (legacy shape -- SPELLS still carry
 * this shape in practice). dnd5e v4+ moved action-economy data under an
 * `ActivitiesField`, `item.system.activities.<activityId>.activation` (an
 * object KEYED by an opaque per-activity id, e.g. `"dnd5eactivity000"`) --
 * monster feats/weapons carry this new shape. Before 36.1's module fix, the
 * activities field's non-source `toObject()` collapsed to `{}` on export
 * (silently losing this data entirely); the module now source-serializes it,
 * so the new shape is real, live data as of this wave, not a bug to route
 * around.
 *
 * Checks the legacy path FIRST (back-compat + spells), then falls through to
 * the first activity entry (in whatever key order Object.values yields --
 * dnd5e doesn't document an ordering guarantee here, and a feat with
 * multiple differently-typed activities is not a case this project's
 * derivation needs to disambiguate) that carries an `activation.type`.
 * @returns {{type?:string, cost?:number}}   {} if neither shape has one.
 */
function activationOf(item) {
  const legacy = item?.system?.activation;
  if (legacy && typeof legacy.type === "string" && legacy.type) {
    return { type: legacy.type, cost: typeof legacy.cost === "number" ? legacy.cost : undefined };
  }
  const activities = item?.system?.activities;
  if (activities && typeof activities === "object") {
    for (const activity of Object.values(activities)) {
      const type = activity?.activation?.type;
      if (typeof type === "string" && type) {
        const cost = activity.activation.cost;
        return { type, cost: typeof cost === "number" ? cost : undefined };
      }
    }
  }
  return {};
}

/**
 * Feat items whose dnd5e activation type (legacy OR activities-shaped, see
 * `activationOf` above) is "legendary" → RawLegendaryActions ({count,
 * costPerAction?}). None of the 32.0 fixtures exercise this (no
 * legendary-actioned monster in the sample set) — this is exercised only by
 * the general fail-soft/no-throw guarantee against those fixtures; a real
 * legendary-actioned monster is covered by this file's own activities-shaped
 * unit-test fixture (Phase 36 task 36.2) and by the orchestrator's live
 * wf-test-5e re-pull at 36.3.
 */
function deriveLegendaryActions(items) {
  if (!Array.isArray(items)) return undefined;
  const legendaryItems = items.filter((it) => activationOf(it).type === "legendary");
  if (legendaryItems.length === 0) return undefined;
  const withCost = legendaryItems.find((it) => typeof activationOf(it).cost === "number");
  const cost = withCost ? activationOf(withCost).cost : undefined;
  return { count: legendaryItems.length, costPerAction: typeof cost === "number" ? cost : undefined };
}

/** Any feat item whose activation type (legacy OR activities-shaped) is "lair" → lairEffects:true. */
function deriveLairEffects(items) {
  if (!Array.isArray(items)) return undefined;
  return items.some((it) => activationOf(it).type === "lair") ? true : undefined;
}

/**
 * actor.effects[] (raw ActiveEffect pass-through, contract §1.1's `Effect`
 * shape) → appliedEffects (every effect name) + auraEffects (the subset
 * whose name mentions "aura", case-insensitive — a reasonable, documented
 * heuristic since the contract doesn't carry a separate aura-vs-ordinary
 * flag on Effect). null/absent effects (the minimal fixture's case) tolerated
 * identically to [] per the contract's own explicit instruction.
 */
function deriveEffects(effects) {
  if (!Array.isArray(effects) || effects.length === 0) return { appliedEffects: undefined, auraEffects: undefined };
  const names = effects.map((e) => e?.name).filter((n) => typeof n === "string" && n.length > 0);
  const auraNames = names.filter((n) => n.toLowerCase().includes("aura"));
  return {
    appliedEffects: names.length > 0 ? names : undefined,
    auraEffects: auraNames.length > 0 ? auraNames : undefined
  };
}

/**
 * Item types that feed a PC's OWN combat-relevant/build-relevant stat block
 * elsewhere in this file (deriveAttacksFromItems for weapons, `classItem`
 * lookup in mapActorToPartyMember, `notableAbilities` for feats) rather than
 * being genuine tracked inventory/loot -- excluded from
 * mapActorItemsToInventory below so a PC's Reliquary items are their actual
 * carried gear (potions, containers, mundane loot), not a duplicate of the
 * class/weapon/feat data the party-roster stat block already carries.
 */
// KNOWN LIMITATION (confirmed against the real wf-test-5e world's own
// export, wf-mcp-server/test/foundry-pull-ops-wf-test-5e.test.mjs): a
// quantity-bearing THROWN weapon (e.g. a PC's stack of Javelins) is
// EXCLUDED here along with every other "weapon" type item, even though it's
// genuinely expendable inventory a GM might want to track in Reliquary.
// This is a deliberate, documented trade-off (not a bug) -- the type-only
// filter is what the written contract's own concrete test assertion
// (review-ui/test/e2e/phase35-pull-and-persistence.e2e.mjs, Kestrel's
// itemsProposed count pinned at exactly 3, excluding her Longbow) requires;
// a finer-grained rule (e.g. "a weapon item WITH quantity>1 is inventory
// too") would need its own explicit test/contract sign-off before landing.
const NON_INVENTORY_ITEM_TYPES = new Set(["class", "subclass", "weapon", "feat", "spell", "race", "background"]);

/**
 * ONE Foundry item document → ItemRecord-SHAPED raw fields (name/type/
 * quantity/description/foundryItemRef) -- Phase 38 task 38.2, §2's resolved
 * ambiguity: extracted out of `mapActorItemsToInventory` (below) so a SECOND
 * caller (the worldItems[] pull-mapper, wf-mcp-server/lib/
 * foundry-pull-ops.mjs) can reuse the SAME per-item field derivation
 * UNFILTERED -- a loose world item has no sibling mapper duplicating its
 * data the way an actor's own class/weapon/feat items do (see
 * NON_INVENTORY_ITEM_TYPES's doc comment), so it carries no type exclusion.
 * `mapActorItemsToInventory` itself is a byte-identical, non-breaking
 * refactor on top of this -- the existing type filter stays exactly where it
 * was, on that (actor-items) caller only. PURE, no I/O, fail-soft on a
 * malformed item.
 * @param {object} item
 * @returns {{name:string, type:string|null, quantity:number|null, description:string|null, foundryItemRef:string|null}}
 */
export function mapItemToInventoryFields(item) {
  return {
    name: typeof item?.name === "string" && item.name ? item.name : "Unnamed Item",
    type: typeof item?.type === "string" ? item.type : null,
    quantity: typeof item?.system?.quantity === "number" ? item.system.quantity : null,
    description: stripHtml(item?.system?.description?.value),
    foundryItemRef: typeof item?.uuid === "string" ? item.uuid : null
  };
}

/**
 * actor.items[] → ItemRecord-SHAPED raw fields (name/type/quantity/
 * description/foundryItemRef), one per genuine INVENTORY item -- Phase 35
 * task 35.1, per plans/phase-32-deferred.md §1's own instruction to keep
 * item derivation next to attack/feature derivation (both read the same
 * `items[]` array). PURE, no I/O, fail-soft on a malformed item.
 *
 * Deliberately excludes NON_INVENTORY_ITEM_TYPES above (class/weapon/feat/
 * etc.) -- those already feed this actor's own combat-relevant stat block
 * (deriveAttacksFromItems, the classItem lookup, notableAbilities) via
 * mapActorToPartyMember, so re-surfacing them as separate Reliquary rows
 * would just duplicate that same data under a different name.
 *
 * @param {object} actor
 * @returns {{name:string, type:string|null, quantity:number|null, description:string|null, foundryItemRef:string|null}[]}
 */
export function mapActorItemsToInventory(actor) {
  const items = Array.isArray(actor?.items) ? actor.items : [];
  return items
    .filter((it) => it && typeof it.type === "string" && !NON_INVENTORY_ITEM_TYPES.has(it.type))
    .map(mapItemToInventoryFields);
}

// --- classifyActor ---------------------------------------------------------

/**
 * "monster" | "pc" — plans/phase-32-bridge-contract.md §1.1's authoritative
 * signal: an actor whose `uuid` is referenced by some `users[].characterUuid`
 * IS a PC. Falls back to `type === "character"` ONLY when no user claims the
 * actor (the contract's own documented fallback heuristic — `type` alone is
 * "not fully reliable across all dnd5e configurations"). Never throws:
 * tolerates a missing/malformed `users` array, a null actor.uuid, etc.
 * @param {object} actor
 * @param {object[]} [users]
 * @returns {"monster"|"pc"}
 */
export function classifyActor(actor, users) {
  const uuid = actor?.uuid;
  const userList = Array.isArray(users) ? users : [];
  const ownedByUser = uuid != null && userList.some((u) => u?.characterUuid != null && u.characterUuid === uuid);
  if (ownedByUser) return "pc";
  if (actor?.type === "character") return "pc";
  return "monster";
}

// --- mapActorToBestiary -----------------------------------------------------

/**
 * Foundry actor → a RawBestiaryFields-SHAPED plain object (monsters).
 * NOT run through RawBestiaryFields.parse() here — that zod schema requires
 * hp/ac as numbers, but the contract explicitly requires this mapper to
 * tolerate BOTH being entirely absent (the minimal fixture's case) and
 * still produce a usable partial object rather than throwing; hp/ac come
 * through as `null` in that case, which downstream consumers (e.g.
 * bestiary-store.mjs's checkBestiaryOutliers, a plain `typeof x === "number"`
 * check) already tolerate cleanly. A human reviewer accepting a
 * status:'proposed' entry with null hp/ac gets an honest, visibly-incomplete
 * draft, not a silently-fabricated 0.
 * @param {object} actor
 * @returns {object}
 */
export function mapActorToBestiary(actor) {
  const system = actor?.system ?? {};
  const items = Array.isArray(actor?.items) ? actor.items : [];
  const attacks = deriveAttacksFromItems(items);
  const { appliedEffects, auraEffects } = deriveEffects(actor?.effects);

  return {
    name: typeof actor?.name === "string" && actor.name ? actor.name : "Unnamed Actor",
    type: typeof actor?.type === "string" && actor.type ? actor.type : "npc",
    challengeRating: system?.cr ?? undefined,
    level: typeof system?.level === "number" ? system.level : undefined,
    hp: typeof system?.hp?.value === "number" ? system.hp.value : null,
    ac: typeof system?.ac === "number" ? system.ac : null,
    attacks,
    multiattack: deriveMultiattack(items, attacks),
    rechargeAbilities: deriveRechargeAbilities(items),
    legendaryActions: deriveLegendaryActions(items),
    lairEffects: deriveLairEffects(items),
    auraEffects,
    appliedEffects
  };
}

// --- mapActorToPartyMember --------------------------------------------------

/**
 * Foundry actor → a RawPartyMemberFields-SHAPED plain object (PCs):
 * {name, combatRelevant, buildRelevant}. Same "shaped, not zod-parsed"
 * reasoning as mapActorToBestiary — RawPartyMemberFields' CombatRelevant/
 * BuildRelevant sub-schemas are already `.default({})`-friendly (every
 * field individually optional), so this mapper's output IS
 * RawPartyMemberFields-schema-valid even when sparse, unlike the bestiary
 * case.
 * @param {object} actor
 * @returns {object}
 */
export function mapActorToPartyMember(actor) {
  const system = actor?.system ?? {};
  const items = Array.isArray(actor?.items) ? actor.items : [];

  const classItem = items.find((it) => it?.type === "class");
  const attacks = deriveAttacksFromItems(items);
  const attackBonus = attacks.reduce(
    (best, a) => (typeof a.toHitBonus === "number" && (best === undefined || a.toHitBonus > best) ? a.toHitBonus : best),
    undefined
  );
  const damagePerRoundEstimate = attacks.length > 0
    ? attacks.reduce((sum, a) => sum + (diceAverage(a.damageDice) ?? 0), 0)
    : undefined;

  const notableAbilities = items
    .filter((it) => it?.type === "feat" && typeof it?.name === "string" && it.name)
    .map((it) => it.name);

  const skillsBlock = system?.skills;
  const skillKeys = skillsBlock && typeof skillsBlock === "object" ? Object.keys(skillsBlock) : [];
  const skills = skillKeys.filter((k) => (skillsBlock[k]?.proficient ?? 0) >= 1);
  const expertise = skillKeys.filter((k) => skillsBlock[k]?.proficient === 2);

  const bioText = stripHtml(system?.biography);

  return {
    name: typeof actor?.name === "string" && actor.name ? actor.name : "Unnamed Character",
    combatRelevant: {
      class: typeof classItem?.name === "string" ? classItem.name : undefined,
      level: typeof system?.level === "number" ? system.level : (typeof classItem?.system?.levels === "number" ? classItem.system.levels : undefined),
      ac: typeof system?.ac === "number" ? system.ac : undefined,
      hp: typeof system?.hp?.value === "number" ? system.hp.value : undefined,
      attackBonus,
      damagePerRoundEstimate,
      // Contract §1.1's own explicit design decision: `saves` is kept as a
      // SEPARATE top-level map specifically so it can be assigned here
      // directly, with no reshaping.
      saveDCs: system?.saves && typeof system.saves === "object" ? system.saves : undefined,
      notableAbilities: notableAbilities.length > 0 ? notableAbilities : undefined
    },
    buildRelevant: {
      skills: skills.length > 0 ? skills : undefined,
      expertise: expertise.length > 0 ? expertise : undefined,
      // Plain pass-through of the biography text, per the contract's own
      // explicit allowance ("a plain pass-through ... is acceptable" --
      // structured trait extraction is LLM territory, out of scope here).
      notableTraits: bioText ? [bioText] : undefined,
      // backstoryHooks: no signal available from raw actor stats without an
      // LLM pass -- deliberately left undefined, a real, documented gap only
      // an LLM-assisted pull (or manual entry) can fill.
      backstoryHooks: undefined
    }
  };
}
