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
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";
import { addTag, removeTag } from "./tags.mjs";

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

export { ConcurrentWriteError };
