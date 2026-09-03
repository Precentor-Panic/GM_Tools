/**
 * Foundry Item/Bestiary-actor PUSH — "Aureus to the Table" workstream B2
 * task G7. Sibling module to ./foundry-push-ops.mjs (scene push): SAME
 * transport (./foundry-ops.mjs's writeFoundryOps), SAME direct-GM,
 * review-free convention (a Reliquary/curated-Bestiary row is already a
 * human-authored/human-accepted catalogue entry — pushing it to Foundry is
 * a table-prep act, not a canon proposal; no review gate applies here any
 * more than it does to pushSceneToFoundry). Backs
 * `POST /api/foundry/push-item` / `POST /api/foundry/push-bestiary-entry`
 * (review-ui/server.mjs, HTTP-only — no MCP mirror, same "destructive/
 * external act" precedent gm-tools-agent SKILL §8 already documents for
 * push-scene).
 *
 * THE FIDELITY BOUNDARY (contract v4, plans/phase-32-bridge-contract.md §2,
 * `plans/plutonium-import-spike.md`): two distinct producer paths onto two
 * distinct op kinds, chosen by a row's OWN provenance —
 *   - Plutonium-sourced rows (provenance stamped by the add-from-plutonium
 *     routes, review-ui/server.mjs — "SOURCE[ pPAGE] via Plutonium",
 *     `deriveSourcePill`'s own `/via plutonium/i` test) → `import_via_plutonium`,
 *     driving Plutonium's OWN 5etools→dnd5e converter against the FULL raw
 *     record (`combat-planning/plutonium-source.mjs`'s getRawPlutoniumEntry)
 *     at real import fidelity. Best-effort by contract: Plutonium
 *     absent/api missing/importer returning nothing are all clean per-op
 *     failures, never a thrown batch abort.
 *   - Hand-authored rows (no such provenance) → `create_item`, a
 *     deliberately LOW-FIDELITY GM_Tools-composed dnd5e payload (name/type/
 *     description/uses only — no activities, no spell effects; the GM
 *     fills real mechanics in Foundry where they matter). This is NOT a
 *     5etools converter and never claims to be one.
 * There is no third path that tries to "upgrade" a hand-authored row to
 * Plutonium fidelity — a row's provenance is fixed at add-time.
 *
 * THE LOSTECH FLOW (Russell's design driver — a necklace of fireballs with
 * one bead, a scry wand with two charges that never recover; "TRUE lostech
 * = it still recharges"): a Reliquary row's `pushOverrides` (item-store.mjs)
 * scarcity-patches a pushed item's charges down from whatever it pushed in
 * at. For a Plutonium-sourced row this means TWO SEQUENTIAL ops in the SAME
 * push call — `import_via_plutonium` (full fidelity) THEN `update_item`
 * (the scarcity patch, `system.uses` only, contract v4's whitelist) — never
 * one op trying to do both, since the update needs the import's OWN
 * returned uuid, which doesn't exist until the import round-trips. For a
 * hand-authored row, overrides fold directly into the single `create_item`
 * payload instead (no second op needed — GM_Tools composes the system
 * payload itself either way, so there's nothing to patch after the fact).
 *
 * `system.uses` composition (the charges knob, both paths): `recharges:
 * false` → `recovery: []` (explicitly non-recharging — the common lostech
 * case). `recharges: true` or omitted → the recovery key is OMITTED from
 * the patch/payload entirely — for the two-op Plutonium path this lets
 * Plutonium's own imported recovery config survive untouched (the "TRUE
 * lostech, it still recharges" case is simply "don't touch recovery at
 * all"); for the single-op hand-authored path there is no prior recovery to
 * preserve, so omitting the key just leaves Foundry's own default
 * (`uses.recovery: []`, i.e. non-recharging) — which happens to already
 * match the lostech DEFAULT ("the lostech default is scarcity" — G8's UI
 * defaults the "recharges on rest" checkbox OFF for exactly this reason).
 * Actually configuring a hand-authored item to recharge is out of this
 * workstream's fidelity boundary ("the GM fills mechanics in Foundry where
 * they matter") — there is no recovery-profile editor here, v1.
 *
 * `descriptionNote` (pushOverrides) is validated/persisted by item-store.mjs
 * but DELIBERATELY NOT PATCHED by this module in v1: appending it to
 * `system.description.value` would require already knowing the imported
 * item's real description text (Plutonium's own conversion output, which
 * this producer never reads back), so silently overwriting the whole
 * description field instead of appending would destroy real imported prose.
 * G8's UI marks it "not pushed yet" for exactly this reason. A future
 * workstream that wants this would need `import_via_plutonium`'s result to
 * echo back the created doc's description, which the bridge contract
 * doesn't currently do.
 *
 * QUEUED → PENDING-LEDGER → RECONCILE (mirrors ./foundry-push-ops.mjs's
 * scene convention exactly, one ledger entry per row):
 *   - item-store.mjs's `pendingPush` / bestiary-store.mjs's `pendingPush`,
 *     shape `{opId, phase:"import"|"update", ...}` for items (bestiary only
 *     ever has one phase, so its ledger is just `{opId}`).
 *   - `reconcilePendingItemResults`/`reconcilePendingBestiaryResults` consume
 *     LATE results (the poll window closed before Foundry's watcher
 *     applied the batch) — called at the START of every push (so a stale
 *     ledger entry never blocks a fresh one once resolved) AND exported for
 *     the routes to call standalone (mirrors flushDirtyStagedScenes's own
 *     "reconcile first" convention).
 *   - REFS ARE WRITTEN ONLY ON CONFIRMED `ok:true` — a `queued` or `ok:false`
 *     result never writes `foundryItemRef`/`foundryActorRef`. For the
 *     two-op lostech flow this means "final confirmed ok" for the WHOLE
 *     flow (import ok AND, when overrides exist, update ok too) — a known,
 *     documented edge case: if the import succeeds but the follow-up
 *     update fails/queues-and-later-fails, NO ref is written (so the row
 *     still reads as "not yet in Foundry"), which means a GM who retries
 *     the push will create a SECOND Foundry item (the first, orphaned, has
 *     full charges and no GM_Tools-side ref pointing at it). This mirrors
 *     `import_via_plutonium`'s own contract-level "best-effort" framing
 *     rather than trying to invent a reconciliation mechanism this bridge's
 *     op vocabulary doesn't support (there's no "delete the orphan" op to
 *     compose against a document GM_Tools never got a chance to record).
 *     Flagged here explicitly, not silently accepted.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  getItem,
  listItems,
  setItemFoundryRef,
  setItemPendingPush
} from "../../combat-planning/item-store.mjs";
import {
  getBestiaryEntry,
  listBestiaryEntries,
  setBestiaryFoundryActorRef,
  setBestiaryPendingPush
} from "../../combat-planning/bestiary-store.mjs";
import { getRawPlutoniumEntry } from "../../combat-planning/plutonium-source.mjs";
import { writeFoundryOps, makeOpId } from "./foundry-ops.mjs";
import { foundryResultsPath } from "./snapshot.mjs";

/**
 * PURE. Parses the "SOURCE[ pPAGE] via Plutonium" provenance line the
 * add-from-plutonium routes stamp onto `sourceText` (review-ui/server.mjs,
 * both the bestiary and items routes use the exact same
 * `${source}${page != null ? \` p${page}\` : ""} via Plutonium` template) —
 * the ONE place this module needs to recover `source` from a row that only
 * carries `name` + this one free-text field. 5etools source codes never
 * contain spaces (DMG/PHB/XGE/…), so `\S+` is a safe, exact inverse of the
 * template above.
 * @param {string|null|undefined} sourceText
 * @returns {string|null}
 */
export function parsePlutoniumProvenance(sourceText) {
  if (typeof sourceText !== "string") return null;
  const m = /^(\S+)(?: p\d+)? via Plutonium$/i.exec(sourceText.trim());
  return m ? m[1] : null;
}

/** PURE. `recharges:false` -> `recovery:[]`; true/absent -> key omitted (see module header). */
function buildUsesPatch(overrides) {
  const hasUses = overrides.usesValue !== undefined || overrides.usesMax !== undefined;
  if (!hasUses) return null;
  const value = overrides.usesValue !== undefined ? overrides.usesValue : overrides.usesMax;
  const max = overrides.usesMax !== undefined ? overrides.usesMax : overrides.usesValue;
  const uses = { value, max };
  if (overrides.recharges === false) uses.recovery = [];
  return uses;
}

/** PURE. The whitelisted `update_item` patch body for a lostech overrides object, or `null` if there's nothing to patch (e.g. only `descriptionNote` set — see header, v1 skips that field). */
export function buildLostechUpdatePatch(overrides) {
  const patch = {};
  if (overrides.displayName) patch.name = overrides.displayName;
  const uses = buildUsesPatch(overrides);
  if (uses) patch["system.uses"] = uses;
  return Object.keys(patch).length ? patch : null;
}

/** PURE. `<p>escaped</p>`, the dnd5e description shape create_item wants. No HTML from the source is trusted/passed through — this is a hand-authored plain-text field. */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** PURE. The `create_item` payload for a hand-authored row, overrides folded in directly (no second op — see module header). */
export function composeHandAuthoredCreateItemData(item, actorUuid) {
  const overrides = item.pushOverrides || {};
  const name = overrides.displayName || item.name;
  const uses = buildUsesPatch(overrides);
  const system = {};
  if (item.description) system.description = { value: `<p>${escapeHtml(item.description)}</p>` };
  if (uses) system.uses = uses;
  return {
    name,
    type: uses ? "consumable" : "loot",
    system,
    ...(actorUuid ? { actorUuid } : {})
  };
}

/**
 * Consumes any LATE results for items a previous push cycle left in the
 * pending-push ledger — same "survive between calls" reconcile
 * `foundry-push-ops.mjs`'s `reconcilePendingResults` already established for
 * scenes, one entry per pending item, keyed on `pendingPush.opId`.
 *
 * `phase:"import"` resolving `ok:true`:
 *   - no `pushOverrides` on the row → this WAS the whole flow → write
 *     `foundryItemRef` now (final confirmed ok) and clear the ledger.
 *   - `pushOverrides` present with a real patch to apply → compose and send
 *     the follow-up `update_item` op RIGHT NOW (a second `writeFoundryOps`
 *     call from inside reconcile — the two-phase flow doesn't stop just
 *     because phase one arrived late). That call queuing AGAIN re-ledgers
 *     as `phase:"update"` with the import's own uuid carried forward; a
 *     confirmed result writes the ref (or not — see header's documented
 *     orphan-risk case) and clears the ledger either way.
 * `phase:"import"` resolving `ok:false` → clear the ledger, write nothing
 * (no Foundry doc was created — safe to retry the whole push).
 * `phase:"update"` resolving either way → clear the ledger; `ok:true` also
 * writes `foundryItemRef` (using the carried-forward `importedUuid`).
 * `phase:"create"` (hand-authored, single-op path — overrides already
 * folded into the create_item payload, never a follow-up patch) resolving
 * either way → clear the ledger; `ok:true` also writes `foundryItemRef`.
 *
 * @param {string} dir
 * @param {string} world
 * @param {object} [opts]   forwarded to a follow-up writeFoundryOps call, if one is needed
 * @returns {Promise<number>}   how many pending items were reconciled this call
 */
export async function reconcilePendingItemResults(dir, world, opts = {}) {
  const pendingItems = listItems(world).filter((i) => i.pendingPush?.opId);
  if (pendingItems.length === 0) return 0;

  const resultsPath = foundryResultsPath(dir, world);
  if (!existsSync(resultsPath)) return 0;
  let allResults;
  try {
    const raw = readFileSync(resultsPath, "utf8").trim();
    const parsed = raw ? JSON.parse(raw) : [];
    allResults = Array.isArray(parsed) ? parsed : [];
  } catch {
    return 0; // unreadable mid-write -- try again next cycle
  }
  if (allResults.length === 0) return 0;

  const consumedOpIds = new Set();
  let reconciled = 0;
  for (const item of pendingItems) {
    const { opId, phase } = item.pendingPush;
    const result = allResults.find((r) => r.opId === opId);
    if (!result) continue;
    consumedOpIds.add(opId);
    reconciled++;

    if (phase === "update") {
      if (result.ok) setItemFoundryRef(world, item.id, item.pendingPush.importedUuid ?? null);
      setItemPendingPush(world, item.id, null);
      continue;
    }

    if (phase === "create") {
      // Hand-authored, single-op path — overrides are already folded into
      // the create_item payload itself, never a follow-up patch here.
      if (result.ok) setItemFoundryRef(world, item.id, result.foundryUuid ?? null);
      setItemPendingPush(world, item.id, null);
      continue;
    }

    // phase === "import" (Plutonium-sourced, possibly two-phase)
    if (!result.ok) {
      setItemPendingPush(world, item.id, null);
      continue;
    }
    const importedUuid = result.foundryUuid ?? null;
    const patch = item.pushOverrides ? buildLostechUpdatePatch(item.pushOverrides) : null;
    if (!patch) {
      setItemFoundryRef(world, item.id, importedUuid);
      setItemPendingPush(world, item.id, null);
      continue;
    }
    // Overrides exist and there's a real patch -- fire the follow-up update
    // op now, right here in reconcile, same as a same-cycle two-phase push.
    const updateOpId = opts.makeOpId ? opts.makeOpId() : makeOpId();
    const updateOutcome = await writeFoundryOps(dir, world, [{ opId: updateOpId, kind: "update_item", data: { itemUuid: importedUuid, patch } }], opts);
    if (updateOutcome.status === "queued") {
      setItemPendingPush(world, item.id, { opId: updateOpId, phase: "update", importedUuid });
      continue;
    }
    const updateResult = updateOutcome.results.find((r) => r.opId === updateOpId);
    if (updateResult?.ok) setItemFoundryRef(world, item.id, importedUuid);
    setItemPendingPush(world, item.id, null);
  }

  if (consumedOpIds.size > 0) {
    const remaining = allResults.filter((r) => !consumedOpIds.has(r.opId));
    writeFileSync(resultsPath, remaining.length ? JSON.stringify(remaining, null, 2) : "[]", "utf8");
  }
  return reconciled;
}

/**
 * @param {string} dir
 * @param {string} world
 * @param {string} itemId
 * @param {{actorUuid?:string}} [args]   actorUuid: compose into the import_via_plutonium/create_item op so the item lands directly in that actor's inventory instead of the world items list
 * @param {object} [opts]   forwarded to writeFoundryOps (pollMs/timeoutMs); opts.makeOpId overrides id generation for deterministic tests
 * @returns {Promise<
 *   {status:'queued', itemId:string, opId:string, phase:'import'|'update'|'create', importedUuid?:string, note:string} |
 *   {status:'applied', itemId:string, opId:string, ok:true, foundryUuid:string, item:object} |
 *   {status:'applied', itemId:string, opId:string, ok:false, error:string, importedUuid?:string}
 * >}
 */
export async function pushItemToFoundry(dir, world, itemId, { actorUuid } = {}, opts = {}) {
  await reconcilePendingItemResults(dir, world, opts);

  const item = getItem(world, itemId); // throws "No item found" if unknown, same as every other item-store.mjs caller
  if (item.foundryItemRef) {
    throw new Error(
      `pushItemToFoundry: item "${itemId}" ("${item.name}") already has a foundryItemRef ("${item.foundryItemRef}") -- ` +
      `already in Foundry — remove it there first if you want a re-push.`
    );
  }

  const provenanceSource = parsePlutoniumProvenance(item.sourceText);
  if (provenanceSource) {
    const rawEntry = getRawPlutoniumEntry(dir, "items", { name: item.name, source: provenanceSource });
    if (!rawEntry) {
      throw new Error(
        `pushItemToFoundry: item "${itemId}" ("${item.name}") was added from Plutonium ("${item.sourceText}"), ` +
        `but the raw record for name="${item.name}" source="${provenanceSource}" is no longer available -- is ` +
        `Plutonium still installed with the same bundled data?`
      );
    }
    return pushPlutoniumItem(dir, world, item, rawEntry, actorUuid, opts);
  }

  return pushHandAuthoredItem(dir, world, item, actorUuid, opts);
}

async function pushPlutoniumItem(dir, world, item, rawEntry, actorUuid, opts) {
  const opId = opts.makeOpId ? opts.makeOpId() : makeOpId();
  const op = { opId, kind: "import_via_plutonium", data: { kind: "item", entry: rawEntry, ...(actorUuid ? { actorUuid } : {}) } };
  const outcome = await writeFoundryOps(dir, world, [op], opts);

  if (outcome.status === "queued") {
    setItemPendingPush(world, item.id, { opId, phase: "import" });
    return { status: "queued", itemId: item.id, opId, phase: "import", note: outcome.note };
  }
  const result = outcome.results.find((r) => r.opId === opId);
  if (!result?.ok) {
    return { status: "applied", itemId: item.id, opId, ok: false, error: result?.error ?? "no result for this op" };
  }
  const importedUuid = result.foundryUuid;

  const patch = item.pushOverrides ? buildLostechUpdatePatch(item.pushOverrides) : null;
  if (!patch) {
    const updated = setItemFoundryRef(world, item.id, importedUuid);
    return { status: "applied", itemId: item.id, opId, ok: true, foundryUuid: importedUuid, item: updated };
  }

  // Two-op lostech flow: SEQUENTIAL, awaited -- the update needs the
  // import's own real uuid, which didn't exist before the call above.
  const updateOpId = opts.makeOpId ? opts.makeOpId() : makeOpId();
  const updateOutcome = await writeFoundryOps(dir, world, [{ opId: updateOpId, kind: "update_item", data: { itemUuid: importedUuid, patch } }], opts);
  if (updateOutcome.status === "queued") {
    setItemPendingPush(world, item.id, { opId: updateOpId, phase: "update", importedUuid });
    return { status: "queued", itemId: item.id, opId: updateOpId, phase: "update", importedUuid, note: updateOutcome.note };
  }
  const updateResult = updateOutcome.results.find((r) => r.opId === updateOpId);
  if (!updateResult?.ok) {
    // Documented orphan-risk case -- see module header. No ref written.
    return {
      status: "applied",
      itemId: item.id,
      opId: updateOpId,
      ok: false,
      importedUuid,
      error: `Import succeeded (${importedUuid}) but the lostech charges patch failed: ${updateResult?.error ?? "no result for this op"}`
    };
  }
  const updated = setItemFoundryRef(world, item.id, importedUuid);
  return { status: "applied", itemId: item.id, opId: updateOpId, ok: true, foundryUuid: importedUuid, item: updated };
}

async function pushHandAuthoredItem(dir, world, item, actorUuid, opts) {
  const opId = opts.makeOpId ? opts.makeOpId() : makeOpId();
  const op = { opId, kind: "create_item", data: composeHandAuthoredCreateItemData(item, actorUuid) };
  const outcome = await writeFoundryOps(dir, world, [op], opts);

  if (outcome.status === "queued") {
    setItemPendingPush(world, item.id, { opId, phase: "create" });
    return { status: "queued", itemId: item.id, opId, phase: "create", note: outcome.note };
  }
  const result = outcome.results.find((r) => r.opId === opId);
  if (!result?.ok) {
    return { status: "applied", itemId: item.id, opId, ok: false, error: result?.error ?? "no result for this op" };
  }
  const updated = setItemFoundryRef(world, item.id, result.foundryUuid);
  return { status: "applied", itemId: item.id, opId, ok: true, foundryUuid: result.foundryUuid, item: updated };
}

/**
 * Consumes late results for bestiary entries a previous push cycle left
 * pending -- same convention as reconcilePendingItemResults, one phase only
 * (a bestiary push is always a single `import_via_plutonium` op, no
 * lostech-style follow-up).
 * @param {string} dir
 * @param {string} world   used only to resolve the transport dir for this call (the bestiary itself is library-wide, not world-scoped)
 * @returns {number}   how many pending entries were reconciled this call
 */
export function reconcilePendingBestiaryResults(dir, world) {
  const pendingEntries = listBestiaryEntries().filter((e) => e.pendingPush?.opId);
  if (pendingEntries.length === 0) return 0;

  const resultsPath = foundryResultsPath(dir, world);
  if (!existsSync(resultsPath)) return 0;
  let allResults;
  try {
    const raw = readFileSync(resultsPath, "utf8").trim();
    const parsed = raw ? JSON.parse(raw) : [];
    allResults = Array.isArray(parsed) ? parsed : [];
  } catch {
    return 0;
  }
  if (allResults.length === 0) return 0;

  const consumedOpIds = new Set();
  let reconciled = 0;
  for (const entry of pendingEntries) {
    const { opId } = entry.pendingPush;
    const result = allResults.find((r) => r.opId === opId);
    if (!result) continue;
    if (result.ok) setBestiaryFoundryActorRef(entry.id, result.foundryUuid ?? null);
    setBestiaryPendingPush(entry.id, null);
    consumedOpIds.add(opId);
    reconciled++;
  }

  if (consumedOpIds.size > 0) {
    const remaining = allResults.filter((r) => !consumedOpIds.has(r.opId));
    writeFileSync(resultsPath, remaining.length ? JSON.stringify(remaining, null, 2) : "[]", "utf8");
  }
  return reconciled;
}

/**
 * @param {string} dir
 * @param {string} entryId
 * @param {{world:string}} args   world is needed ONLY to resolve the transport dir for this push (writeFoundryOps writes into worlds/<world>/... even though the bestiary itself is library-wide)
 * @param {object} [opts]   forwarded to writeFoundryOps; opts.makeOpId overrides id generation for deterministic tests
 * @returns {Promise<
 *   {status:'queued', entryId:string, opId:string, note:string} |
 *   {status:'applied', entryId:string, opId:string, ok:true, foundryUuid:string, entry:object} |
 *   {status:'applied', entryId:string, opId:string, ok:false, error:string}
 * >}
 */
export async function pushBestiaryEntryToFoundry(dir, entryId, { world } = {}, opts = {}) {
  if (!world) throw new Error("pushBestiaryEntryToFoundry: `world` is required (needed to resolve the Foundry transport dir).");
  reconcilePendingBestiaryResults(dir, world);

  const entry = getBestiaryEntry(entryId); // throws "No bestiary entry found" if unknown, same as every other bestiary-store.mjs caller
  if (entry.foundryActorRef) {
    throw new Error(
      `pushBestiaryEntryToFoundry: bestiary entry "${entryId}" ("${entry.rawFields?.name ?? "?"}") already has a ` +
      `foundryActorRef ("${entry.foundryActorRef}") -- already in Foundry — remove it there first if you want a re-push.`
    );
  }
  if (entry.sourcePill !== "plutonium") {
    throw new Error(
      `pushBestiaryEntryToFoundry: bestiary entry "${entryId}" ("${entry.rawFields?.name ?? "?"}") has no Plutonium ` +
      `provenance (sourcePill="${entry.sourcePill}") -- only creatures added from the "Available via Plutonium" ` +
      `shelf can be pushed this way.`
    );
  }
  const source = parsePlutoniumProvenance(entry.sourceText);
  const name = entry.rawFields?.name;
  const rawEntry = source && name ? getRawPlutoniumEntry(dir, "bestiary", { name, source }) : null;
  if (!rawEntry) {
    throw new Error(
      `pushBestiaryEntryToFoundry: entry "${entryId}" ("${name ?? "?"}") carries Plutonium provenance ` +
      `("${entry.sourceText}") but the raw record is no longer available -- is Plutonium still installed with the ` +
      `same bundled data?`
    );
  }
  if (rawEntry._copy) {
    throw new Error(
      `pushBestiaryEntryToFoundry: "${name}" is a Plutonium "_copy" reprint shell, not a fully copy-resolved stat ` +
      `block -- this bridge doesn't implement 5etools' copy-resolution logic, so this creature can't be pushed.`
    );
  }

  const opId = opts.makeOpId ? opts.makeOpId() : makeOpId();
  const outcome = await writeFoundryOps(dir, world, [{ opId, kind: "import_via_plutonium", data: { kind: "creature", entry: rawEntry } }], opts);

  if (outcome.status === "queued") {
    setBestiaryPendingPush(entryId, { opId });
    return { status: "queued", entryId, opId, note: outcome.note };
  }
  const result = outcome.results.find((r) => r.opId === opId);
  if (!result?.ok) {
    return { status: "applied", entryId, opId, ok: false, error: result?.error ?? "no result for this op" };
  }
  const updated = setBestiaryFoundryActorRef(entryId, result.foundryUuid);
  return { status: "applied", entryId, opId, ok: true, foundryUuid: result.foundryUuid, entry: updated };
}
