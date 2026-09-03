/**
 * Item / inventory store — Phase 35 task 35.1, §1 of review-ui/test/e2e/
 * phase35-fixture.mjs (THE WRITTEN CONTRACT), reusing
 * plans/phase-32-deferred.md §1's ItemRecord design verbatim plus this
 * phase's own two additions: `tags: string[]` (the tagged-shelf's own
 * findability model) and a FIXED `kind: "item"` literal (so a Reliquary row
 * and a Stagecraft row render through the exact same shared shelf component
 * keyed off one `kind` field).
 *
 * Scope: PER-WORLD (deferred §1's own reasoning — an item's relevance is
 * scoped to the campaign whose party holds it, mirroring
 * party-roster-store.mjs, NOT bestiary-store.mjs's per-user/library-wide
 * scoping). Storage: ONE JSON FILE PER WORLD, `<itemRoot>/<world>.json`, a
 * flat array of ItemRecord. Default root GM_Tools/items/ (sibling to
 * party-roster/); override with GM_TOOLS_ITEM_DIR (tests use this for
 * isolation — the exact env var name is pinned by
 * review-ui/test/e2e/phase35-fixture.mjs's own setupPhase35Env). Reuses
 * review-state.mjs's withLock/ConcurrentWriteError, per every other store's
 * established precedent.
 *
 * status gate mirrors bestiary/party-roster exactly:
 * 'proposed' | 'accepted' | 'discarded'. saveItem defaults to 'proposed'
 * (matching bestiary-store.mjs's own default, NOT party-roster-store.mjs's
 * default-'accepted' — items are pull-populated content this phase (there is
 * no hand-add UI affordance yet), so the safer no-silent-auto-write default
 * applies; wf-mcp-server/lib/foundry-pull-ops.mjs is the only caller today).
 *
 * dedup/upsert (done by the CALLER, wf-mcp-server/lib/foundry-pull-ops.mjs)
 * follows the EXACT SAME three-way branch as upsertBestiary/
 * upsertPartyMember, keyed on foundryItemRef instead of foundryActorRef —
 * this module supplies updateItemFields as the "update the still-proposed
 * candidate in place" half of that branch, same as
 * updateBestiaryEntryRawFields/updatePartyMemberFields.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";
import { addTag, removeTag } from "./tags.mjs";
// Phase 35.5a (task #44) -- "promote a Reliquary item to a graph node." Same
// cross-directory reuse precedent session-planner/scene-elements.mjs's
// promoteElement / session-planner/transit-entity.mjs's createTransitEntity
// already established (both import addNodeOp from here) -- no second
// manual-entity-creation mechanism.
import { addNodeOp } from "../wf-mcp-server/lib/manual-edit-ops.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "items");

export function itemRoot() {
  return process.env.GM_TOOLS_ITEM_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return join(itemRoot(), `${world}.json`);
}

function readItems(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeItems(world, items) {
  const filePath = worldFilePath(world);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(items, null, 2), "utf8");
  });
  return items;
}

/** Generate an item id. Injectable (opts.makeId) for deterministic tests, same pattern as makeBestiaryEntryId. */
export function makeItemId() {
  return `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {string} world
 * @param {{name:string, type?:string|null, quantity?:number|null, description?:string|null, tags?:string[], foundryItemRef?:string|null, ownerFoundryActorUuid?:string|null, ownerPartyMemberId?:string|null, sourceText?:string|null, status?:'proposed'|'accepted'|'discarded'}} fields
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object}   the created ItemRecord
 */
export function saveItem(
  world,
  {
    name,
    type = null,
    quantity = null,
    description = null,
    tags = [],
    foundryItemRef = null,
    ownerFoundryActorUuid = null,
    ownerPartyMemberId = null,
    sourceText = null,
    status = "proposed"
  },
  opts = {}
) {
  const makeId = opts.makeId ?? makeItemId;
  const now = opts.now ?? new Date().toISOString();
  const item = {
    id: makeId(),
    world,
    kind: "item",
    name,
    type,
    quantity,
    description,
    tags: Array.isArray(tags) ? tags : [],
    foundryItemRef,
    ownerFoundryActorUuid,
    ownerPartyMemberId,
    sourceText,
    status,
    // Phase 35.5a: additive-optional back-link to a promoted graph node --
    // per bestiary-store.mjs's own documented "additive field needs no
    // SCHEMA bump" convention. null until promoteItemToGraph sets it; a
    // pre-Phase-35.5a item on disk simply has this key absent, which reads
    // the same as null everywhere it's checked (`item.graphEntityId`).
    graphEntityId: null,
    // "Aureus to the Table" task G7 -- same write-time-explicit-null
    // convention as graphEntityId above (not bestiary-store.mjs's read-time-
    // fallback convention; this store already had its own precedent before
    // G7 existed). pendingPush mirrors scenes.mjs's own ledger shape
    // (`{opId, phase, ...}` -- see wf-mcp-server/lib/foundry-item-push-ops.mjs)
    // for a push whose ops write queued but wasn't confirmed applied within
    // the poll window; pushOverrides is the "lostech" local-override editor's
    // persisted state (displayName/usesValue/usesMax/recharges/
    // descriptionNote -- see setItemPushOverrides below), null until a GM
    // opts in via the Reliquary row's "lostech…" toggle.
    pendingPush: null,
    pushOverrides: null,
    createdAt: now
  };
  const items = readItems(world);
  writeItems(world, [...items, item]);
  return item;
}

/** @returns {object}   the ItemRecord. Throws a clear Error if not found. */
export function getItem(world, itemId) {
  const item = readItems(world).find((i) => i.id === itemId);
  if (!item) {
    throw new Error(`No item found: world="${world}" itemId="${itemId}"`);
  }
  return item;
}

/** @returns {object[]}   every ItemRecord for `world`, in creation order. [] if none. */
export function listItems(world) {
  return readItems(world);
}

function findItemIndex(world, itemId, items) {
  const idx = items.findIndex((i) => i.id === itemId);
  if (idx === -1) {
    throw new Error(`No item found: world="${world}" itemId="${itemId}"`);
  }
  return idx;
}

/** status: 'proposed' -> 'accepted'. Mirrors acceptBestiaryEntry/acceptPartyMember. @returns {object} the updated ItemRecord. */
export function acceptItem(world, itemId) {
  const items = readItems(world);
  const idx = findItemIndex(world, itemId, items);
  const updated = { ...items[idx], status: "accepted" };
  const next = [...items];
  next[idx] = updated;
  writeItems(world, next);
  return updated;
}

/**
 * status -> 'discarded' ONLY. Refuses (throws) if already 'accepted' — same
 * "refuse to discard accepted content" convention as
 * discardBestiaryEntry/discardPartyMember.
 * @returns {object} the updated ItemRecord.
 */
export function discardItem(world, itemId) {
  const items = readItems(world);
  const idx = findItemIndex(world, itemId, items);
  if (items[idx].status === "accepted") {
    throw new Error(
      `Refusing to discard item "${itemId}" (status "accepted") -- only a not-yet-accepted 'proposed' item can be discarded outright.`
    );
  }
  const updated = { ...items[idx], status: "discarded" };
  const next = [...items];
  next[idx] = updated;
  writeItems(world, next);
  return updated;
}

/**
 * Overwrites name/type/quantity/description/sourceText/ownerFoundryActorUuid/
 * ownerPartyMemberId on an EXISTING item — the "re-ingesting the same
 * Foundry item updates the still-proposed candidate" half of the pull
 * ingest's review-gate (wf-mcp-server/lib/foundry-pull-ops.mjs). `id`/
 * `world`/`kind`/`createdAt`/`foundryItemRef`/`status`/`tags` are preserved
 * untouched. Refuses (throws) unless the item is still `status:'proposed'`
 * — mirrors updatePartyMemberFields's identical guard exactly.
 * @returns {object}   the updated ItemRecord
 */
export function updateItemFields(
  world,
  itemId,
  { name, type, quantity, description, sourceText, ownerFoundryActorUuid, ownerPartyMemberId } = {}
) {
  const items = readItems(world);
  const idx = findItemIndex(world, itemId, items);
  const existing = items[idx];
  if (existing.status !== "proposed") {
    throw new Error(
      `Refusing to overwrite item "${itemId}" (status "${existing.status}") -- only a still-'proposed' item may be ` +
      `updated by a re-ingest; an accepted/discarded item is a human decision, never silently overwritten.`
    );
  }
  const updated = {
    ...existing,
    name: name ?? existing.name,
    type: type !== undefined ? type : existing.type,
    quantity: quantity !== undefined ? quantity : existing.quantity,
    description: description !== undefined ? description : existing.description,
    sourceText: sourceText !== undefined ? sourceText : existing.sourceText,
    ownerFoundryActorUuid: ownerFoundryActorUuid !== undefined ? ownerFoundryActorUuid : existing.ownerFoundryActorUuid,
    ownerPartyMemberId: ownerPartyMemberId !== undefined ? ownerPartyMemberId : existing.ownerPartyMemberId
  };
  const next = [...items];
  next[idx] = updated;
  writeItems(world, next);
  return updated;
}

/**
 * §4's addTag wrapped with this store's own read-modify-write persistence —
 * the "pure helper + a thin persisting wrapper" split every tags.mjs
 * consumer follows.
 * @returns {object}   the updated ItemRecord. Throws a clear Error if `itemId` isn't found.
 */
export function addItemTag(world, itemId, tag) {
  const items = readItems(world);
  findItemIndex(world, itemId, items); // throws "No item found" if unknown
  const next = addTag(items, itemId, tag);
  writeItems(world, next);
  return next.find((i) => i.id === itemId);
}

/** @returns {object}   the updated ItemRecord. Throws a clear Error if `itemId` isn't found. */
export function removeItemTag(world, itemId, tag) {
  const items = readItems(world);
  findItemIndex(world, itemId, items); // throws "No item found" if unknown
  const next = removeTag(items, itemId, tag);
  writeItems(world, next);
  return next.find((i) => i.id === itemId);
}

/**
 * Phase 35.5a (task #44) -- "I'd like to be able to promote items of
 * interest from the reliquary to the graph as nodes, if the party deems
 * them important." Creates a real World Fabric graph entity from this item
 * (`name` verbatim, `description` when the item has one) and back-links the
 * ItemRecord via `graphEntityId`. The item keeps living in the Reliquary --
 * this only adds a back-link, never mutates/removes the ItemRecord's own
 * catalogue fields.
 *
 * ENTITY TYPE: `"object"` -- this project's graph has no dedicated "item"
 * entity type (confirmed by direct read of the global entity-type enum,
 * wf-mcp-server/index.mjs's `z.enum(["person","place","faction","object",
 * "event","concept"])` / mutation-engine/prep-content.mjs's identical
 * `PrepEntityType`); `"object"` is also the EXACT default
 * session-planner/scene-elements.mjs's own `promoteElement` already uses
 * for this same "promote something into the graph" action one layer over
 * (a scene element, not a Reliquary item) -- matched, not invented.
 *
 * MECHANISM: the SAME manual-entity-creation route every other manual
 * node-add in this project already uses
 * (wf-mcp-server/lib/manual-edit-ops.mjs's addNodeOp) -- no second
 * entity-creation mechanism, per session-planner/transit-entity.mjs's own
 * precedent for this exact cross-directory reuse.
 *
 * IDEMPOTENT: an item that already carries a `graphEntityId` returns the
 * EXISTING node's id verbatim, `created:false`, and writes nothing -- this
 * mirrors scene-elements.mjs's `promoteElement`/`attachExistingNodeAsElement`
 * own "return the existing one, don't duplicate" precedent, this codebase's
 * established idempotency convention for a promote/attach action (a plain
 * 200 re-describing current state, not a 409 conflict -- promoting twice is
 * not an error condition from the GM's point of view, it's "yes, still
 * true").
 *
 * @param {string} dir       resolved data dir (resolveDir()'s return value)
 * @param {string} world
 * @param {string} itemId
 * @returns {Promise<{item:object, entityId:string, created:boolean}>}
 */
export async function promoteItemToGraph(dir, world, itemId) {
  const existing = getItem(world, itemId); // throws "No item found" -- statusForError's regex doesn't special-case this message (same as every sibling store's own getX), so this currently 400s like accept/discard on an unknown id already do; not this task's scope to change

  if (existing.graphEntityId) {
    return { item: existing, entityId: existing.graphEntityId, created: false };
  }

  const { entityId } = await addNodeOp(dir, world, {
    name: existing.name,
    type: "object",
    ...(existing.description ? { description: existing.description } : {})
  });

  const item = setItemGraphEntityId(world, itemId, entityId);
  return { item, entityId, created: true };
}

/**
 * Status-independent patch (mirrors updateBestiaryEntryNote/Rating's own
 * "no status check" convention -- a promote is an ongoing table-use action,
 * not a proposed-content edit) that writes the back-link `promoteItemToGraph`
 * computes. Not exposed as its own route; promoteItemToGraph is the only
 * caller.
 * @returns {object}   the updated ItemRecord
 */
function setItemGraphEntityId(world, itemId, graphEntityId) {
  const items = readItems(world);
  const idx = findItemIndex(world, itemId, items);
  const updated = { ...items[idx], graphEntityId };
  const next = [...items];
  next[idx] = updated;
  writeItems(world, next);
  return updated;
}

// ===========================================================================
// "Aureus to the Table" task G7 -- the Foundry-push narrow setters.
// Mirrors session-planner/scenes.mjs's markScenePushed/setScenePendingPush
// narrowness EXACTLY: each setter touches ONLY its own field(s), read-modify-
// write, no status check (a push is an ongoing table-use action against an
// already-accepted-or-not-yet-reviewed catalogue row, not a re-ingest a
// human decision should gate -- same reasoning as updateBestiaryEntryNote's
// own "no status check" convention). All three throw the same clear
// "No item found" error as findItemIndex on an unknown id.
// ===========================================================================

/**
 * PushOverrides -- the "lostech" local-override editor's persisted shape.
 * Every field optional; `null` clears the whole thing (see
 * setItemPushOverrides below). `.strict()` so a stray/misspelled key is a
 * loud validation error, not a silently-dropped typo.
 */
export const PushOverridesSchema = z
  .object({
    displayName: z.string().min(1).optional(),
    usesValue: z.number().int().min(0).optional(),
    usesMax: z.number().int().min(1).optional(),
    recharges: z.boolean().optional(),
    descriptionNote: z.string().optional()
  })
  .strict();

/**
 * Writes (or clears) the item's own `foundryItemRef` -- the narrow "this
 * catalogue row now has a real Foundry document" ack, written by
 * wf-mcp-server/lib/foundry-item-push-ops.mjs's pushItemToFoundry ONLY on a
 * confirmed-applied `ok:true` result (never on `queued`/`ok:false` -- see
 * that module's own header for the full contract).
 * @returns {object}   the updated ItemRecord
 */
export function setItemFoundryRef(world, itemId, ref) {
  const items = readItems(world);
  const idx = findItemIndex(world, itemId, items);
  const updated = { ...items[idx], foundryItemRef: ref ?? null };
  const next = [...items];
  next[idx] = updated;
  writeItems(world, next);
  return updated;
}

/**
 * Writes (or clears, `pending: null`) the item's own pending-push ledger
 * entry -- the SAME "ops written but not confirmed within the poll window"
 * mechanism scenes.mjs's setScenePendingPush already established, shaped
 * `{opId, phase:"import"|"update", ...}` (see foundry-item-push-ops.mjs).
 * @returns {object}   the updated ItemRecord
 */
export function setItemPendingPush(world, itemId, pending) {
  const items = readItems(world);
  const idx = findItemIndex(world, itemId, items);
  const updated = { ...items[idx], pendingPush: pending ?? null };
  const next = [...items];
  next[idx] = updated;
  writeItems(world, next);
  return updated;
}

/**
 * Writes (or clears, `overridesOrNull: null`) the item's "lostech" local
 * overrides -- validated against PushOverridesSchema (a caller passing an
 * unknown key or an out-of-range value gets a loud ZodError, never a
 * silently-dropped/coerced field). No status check, same reasoning as this
 * section's header comment.
 * @returns {object}   the updated ItemRecord
 */
export function setItemPushOverrides(world, itemId, overridesOrNull) {
  const items = readItems(world);
  const idx = findItemIndex(world, itemId, items);
  const validated = overridesOrNull == null ? null : PushOverridesSchema.parse(overridesOrNull);
  const updated = { ...items[idx], pushOverrides: validated };
  const next = [...items];
  next[idx] = updated;
  writeItems(world, next);
  return updated;
}

export { ConcurrentWriteError };
