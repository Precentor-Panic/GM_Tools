/**
 * Bestiary store — Phase 18 task 18.1. Pure, Foundry-free, unit-testable.
 *
 * SCOPING DECISION (design record §1a/§4 left this explicitly open --
 * resolved HERE, per task 18.1's own instruction to "state the decision and
 * reasoning since the design record explicitly left it open"): bestiary
 * storage is PER-USER / LIBRARY-WIDE, NOT per-world. Reasoning, straight
 * from the design record's own text: "A monster a DM owns isn't really tied
 * to one campaign." This is a deliberate exception to every other store in
 * this project (all per-world) -- flagged here explicitly, and matched
 * exactly by test/combat-planning/bestiary-store.test.mjs's own header
 * comment, so a future pass doesn't silently drift this back to a per-world
 * shape out of habit with the rest of the codebase's conventions.
 *
 * Storage: ONE JSON FILE PER ENTRY (entity-narration.mjs's per-id-file
 * convention, not scenes.mjs's per-world-file convention -- there is no
 * per-world grouping concept here at all): `<bestiaryRoot>/<entryId>.json`.
 * listBestiaryEntries() reads across the whole root, no world subdir.
 * Default root GM_Tools/bestiary/ (sibling to entity-narration/,
 * session-scenes/); override with GM_TOOLS_BESTIARY_DIR (tests use this for
 * isolation). Reuses review-state.mjs's withLock/ConcurrentWriteError, per
 * every other store's established precedent.
 *
 * "Show your work" (design record §1a): a BestiaryEntry stores rawFields
 * (bestiary-ingest.mjs's output) AND derivedScore (action-economy.mjs +
 * effect-impact.mjs's output, attached later via updateBestiaryEntryScore,
 * task 18.3) SIDE BY SIDE -- this module never computes a score itself
 * (that would violate the pure-scoring module boundary task 18.3 exists to
 * enforce), it only stores whatever a caller hands it.
 *
 * Ingestion-time outlier sanity check (design record §1a, a hard
 * requirement): saveBestiaryEntry ALWAYS runs checkBestiaryOutliers and
 * stamps the result (needsConfirmation/outlierReasons) -- never a separate
 * opt-in step a caller could forget to call.
 *
 * Lighter review than the graph's mutation-review batch machinery (design
 * record §1a: "more like prep-content-ops.mjs's accept/discard pattern"): a
 * BestiaryEntry's status is 'proposed' | 'accepted' | 'discarded' -- no
 * batchId, no diff, no sync-to-Foundry reachability at all.
 *
 * Phase 35 task 35.1, §5 of review-ui/test/e2e/phase35-fixture.mjs (THE
 * WRITTEN CONTRACT): gains two additive, optional/nullable persisted fields
 * -- `note` (free-form GM note) and `rating` (the user's own star/CR-override
 * value; null = "use the book value"). Both default to `null` via a
 * READ-TIME fallback (`?? null`, applied at getBestiaryEntry/
 * listBestiaryEntries -- every pre-Phase-35 entry simply lacks the key on
 * disk and reads as `null`, no migration/SCHEMA_VERSION bump needed, per
 * this module's own already-established additive-field convention above).
 * Patched via updateBestiaryEntryNote/updateBestiaryEntryRating -- STATUS-
 * INDEPENDENT (no proposed/accepted check), mirroring updateBestiaryEntryScore's
 * own "no status check" convention below, NOT updateBestiaryEntryRawFields's
 * proposed-only guard: a GM editing their own note/rating on an
 * already-accepted entry is exactly the kind of ongoing table-use edit these
 * fields exist for, not a re-ingest a human decision should gate.
 *
 * Also gains `sourcePill` -- a DERIVED, NEVER-PERSISTED read-time projection
 * (`deriveSourcePill`, applied at the same two read boundaries): "foundry" if
 * `foundryActorRef` is set, "reskin" if `reskinOfEntryId` is set (Phase
 * 37.6b, see createReskinnedBestiaryEntry below), "srd" if
 * `sourceText`/`sourcePdfName` mentions "SRD" (case-insensitive), else
 * "mine". A pure function of already-stored fields -- never a fifth
 * persisted status value.
 *
 * Phase 37.6b (task plan's own addendum, wiring the two Library stubs) adds
 * two more additive, optional/nullable fields, following the EXACT SAME
 * "no SCHEMA_VERSION bump, read-time-fallback-to-null" convention §5 above
 * already established for `note`/`rating` (NOT item-store.mjs's own
 * write-time-explicit-null convention for its sibling `graphEntityId` field
 * -- this store already had its own precedent for additive optional fields
 * before 35.5a's item promote existed, so it's followed here rather than
 * copied from a sibling module):
 *   - `graphEntityId` -- "Promote to a named world figure" (see
 *     promoteBestiaryEntryToGraph below), mirrors item-store.mjs's own
 *     back-link field name/semantics exactly (a promoted entry's link to
 *     the real World Fabric node it now also exists as).
 *   - `reskinOfEntryId` -- "Wear it as something else" (see
 *     createReskinnedBestiaryEntry below), the flag deriveSourcePill keys
 *     "reskin" off of: the id of the BestiaryEntry a reskinned entry's stat
 *     block was copied from, verbatim, unchanged.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";
import { diceAverage } from "./dice.mjs";
// Phase 37.6b -- "Promote to a named world figure." Same cross-directory
// reuse precedent item-store.mjs's promoteItemToGraph/session-planner/
// scene-elements.mjs's promoteElement already established (all three import
// addNodeOp from here) -- no second manual-entity-creation mechanism.
import { addNodeOp } from "../wf-mcp-server/lib/manual-edit-ops.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "bestiary");

export function bestiaryRoot() {
  return process.env.GM_TOOLS_BESTIARY_DIR || DEFAULT_ROOT;
}

function entryFilePath(entryId) {
  return join(bestiaryRoot(), `${entryId}.json`);
}

/** Generate a bestiary entry id. Injectable (opts.makeId) for deterministic tests. */
export function makeBestiaryEntryId() {
  return `bst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * PURE, no I/O. A gross-outlier guard on the derived fields, per design
 * record §1a -- v1, deliberately generous bands (this is a confirmation
 * flag, not a rejection):
 *   - flags if any single attack's estimated per-round damage (dice
 *     average, times multiattack count if present) exceeds the stat
 *     block's OWN hp.
 *   - flags if hp <= 0 or ac <= 0 (a parsing failure wearing a
 *     plausible-looking JSON shape).
 * @param {object} rawFields
 * @returns {{flagged:boolean, reasons:string[]}}
 */
export function checkBestiaryOutliers(rawFields) {
  const reasons = [];
  const hp = rawFields?.hp;
  const ac = rawFields?.ac;

  if (typeof hp === "number" && hp <= 0) {
    reasons.push(`hp (${hp}) is not a positive number -- likely a parsing failure.`);
  }
  if (typeof ac === "number" && ac <= 0) {
    reasons.push(`ac (${ac}) is not a positive number -- likely a parsing failure.`);
  }

  const multiattackCount = rawFields?.multiattack?.count ?? 1;
  if (typeof hp === "number" && hp > 0) {
    for (const attack of rawFields?.attacks ?? []) {
      const avg = diceAverage(attack?.damageDice);
      if (avg === null) continue;
      const perRound = avg * multiattackCount;
      if (perRound > hp) {
        reasons.push(
          `Attack "${attack?.name ?? "?"}" estimated per-round damage (~${perRound.toFixed(1)}, dice average ` +
          `${avg.toFixed(1)}${multiattackCount > 1 ? ` × multiattack ${multiattackCount}` : ""}) exceeds this ` +
          `creature's own hp (${hp}) -- plausible only at the extreme high end, worth a human glance.`
        );
      }
    }
  }

  return { flagged: reasons.length > 0, reasons };
}

/**
 * PURE, no I/O. Phase 35 task 35.1, §5: derives the read-time `sourcePill`
 * projection from fields already on the entry -- foundryActorRef present ->
 * "foundry"; sourceText/sourcePdfName mentioning "SRD" (case-insensitive) ->
 * "srd"; else "mine".
 * @param {object} entry
 * @returns {"foundry"|"srd"|"mine"}
 */
export function deriveSourcePill(entry) {
  if (entry?.foundryActorRef) return "foundry";
  // Phase 37.6b: checked BEFORE the srd/mine fallback -- a reskinned entry
  // is never foundry-linked (createReskinnedBestiaryEntry always passes
  // foundryActorRef:null) and won't typically carry "SRD" source text
  // either, but the explicit back-link is the authoritative signal either
  // way, not an absence-of-other-signals inference.
  if (entry?.reskinOfEntryId) return "reskin";
  const flagText = `${entry?.sourceText ?? ""} ${entry?.sourcePdfName ?? ""}`;
  if (/srd/i.test(flagText)) return "srd";
  return "mine";
}

/**
 * Read-time projection applied at every read boundary (getBestiaryEntry/
 * listBestiaryEntries/updateBestiaryEntryNote/updateBestiaryEntryRating) --
 * `note`/`rating` default to `null` for a pre-Phase-35 entry, `sourcePill` is
 * always derived fresh, NEVER persisted back to disk.
 */
function projectReadFields(entry) {
  if (!entry) return entry;
  return {
    ...entry,
    note: entry.note ?? null,
    rating: entry.rating ?? null,
    // Phase 37.6b: same read-time-fallback-to-null convention as note/rating above.
    graphEntityId: entry.graphEntityId ?? null,
    reskinOfEntryId: entry.reskinOfEntryId ?? null,
    sourcePill: deriveSourcePill(entry)
  };
}

function readEntry(entryId) {
  const filePath = entryFilePath(entryId);
  if (!existsSync(filePath)) {
    throw new Error(`No bestiary entry found: "${entryId}" (looked for ${filePath}).`);
  }
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeEntry(entry) {
  const filePath = entryFilePath(entry.id);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf8");
  });
  return entry;
}

/**
 * Always runs checkBestiaryOutliers(rawFields) and stamps the result.
 * status is always 'proposed' at creation.
 * @param {{rawFields:object, derivedScore?:object|null, sourceText?:string|null, sourcePdfName?:string|null, foundryActorRef?:string|null}} fields
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object}   the created BestiaryEntry
 */
export function saveBestiaryEntry(
  { rawFields, derivedScore = null, sourceText = null, sourcePdfName = null, foundryActorRef = null, reskinOfEntryId = null },
  opts = {}
) {
  const makeId = opts.makeId ?? makeBestiaryEntryId;
  const now = opts.now ?? new Date().toISOString();
  const outlier = checkBestiaryOutliers(rawFields);

  const entry = {
    id: makeId(),
    rawFields,
    derivedScore,
    sourceText,
    sourcePdfName,
    // Phase 32 task 32.2 -- nullable link back to the Foundry actor this
    // entry was pulled from (null for every pre-existing LLM-ingested/
    // hand-added entry). Additive field, SCHEMA_VERSION-equivalent note:
    // this store has no explicit SCHEMA_VERSION constant of its own to bump
    // (unlike interchange.mjs's WFI_VERSION) -- an ADDITIVE optional field
    // on an existing flat-JSON shape needs none, per
    // plans/phase-32-bridge-contract.md's own "additive-only versioning"
    // convention (adding an optional field is not a breaking change).
    foundryActorRef,
    // Phase 37.6b -- nullable back-link to the BestiaryEntry this one was
    // reskinned FROM (see createReskinnedBestiaryEntry below); null for
    // every entry created any other way. Same additive-field reasoning as
    // foundryActorRef immediately above.
    reskinOfEntryId,
    needsConfirmation: outlier.flagged,
    outlierReasons: outlier.reasons,
    status: "proposed",
    createdAt: now
  };

  return writeEntry(entry);
}

/**
 * Overwrites rawFields/sourceText/sourcePdfName on an EXISTING entry and
 * re-runs checkBestiaryOutliers — the "re-ingesting the same Foundry actor
 * updates the still-proposed candidate" half of the pull ingest's
 * review-gate (wf-mcp-server/lib/foundry-pull-ops.mjs, Phase 32 task 32.2).
 * `id`/`createdAt`/`foundryActorRef`/`status` are preserved untouched.
 * Refuses (throws) unless the entry is still `status:'proposed'` — an
 * 'accepted' entry is a human decision this function must never silently
 * overwrite, matching discardBestiaryEntry's own "refuses on accepted"
 * convention (the no-silent-auto-write invariant, applied to a RE-ingest
 * rather than a first ingest).
 * @returns {object}   the updated BestiaryEntry
 */
export function updateBestiaryEntryRawFields(entryId, { rawFields, sourceText = null, sourcePdfName = null }) {
  const entry = readEntry(entryId);
  if (entry.status !== "proposed") {
    throw new Error(
      `Refusing to overwrite bestiary entry "${entryId}" (status "${entry.status}") -- only a still-'proposed' ` +
      `entry may be updated by a re-ingest; an accepted/discarded entry is a human decision, never silently ` +
      `overwritten.`
    );
  }
  const outlier = checkBestiaryOutliers(rawFields);
  return writeEntry({
    ...entry,
    rawFields,
    sourceText,
    sourcePdfName,
    needsConfirmation: outlier.flagged,
    outlierReasons: outlier.reasons
  });
}

/** @returns {object}   the BestiaryEntry (§5's note/rating/sourcePill projection included). Throws a clear Error if not found. */
export function getBestiaryEntry(entryId) {
  return projectReadFields(readEntry(entryId));
}

/** @returns {object[]}   every BestiaryEntry across the whole library (NOT scoped to any world), §5's projection included. [] if none exist yet. */
export function listBestiaryEntries() {
  const root = bestiaryRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((f) => f.endsWith(".json"))
    .map((f) => projectReadFields(JSON.parse(readFileSync(join(root, f), "utf8"))));
}

/**
 * Attaches (or replaces) a BestiaryEntry's derivedScore WITHOUT touching
 * rawFields -- "show your work" means both must persist together, but this
 * function is how the score half gets filled in after task 18.3/18.4's pure
 * scoring functions run against the already-stored rawFields.
 * @returns {object}   the updated BestiaryEntry
 */
export function updateBestiaryEntryScore(entryId, derivedScore) {
  const entry = readEntry(entryId);
  return writeEntry({ ...entry, derivedScore });
}

/** status: 'proposed' -> 'accepted'. @returns {object} the updated BestiaryEntry. */
export function acceptBestiaryEntry(entryId) {
  const entry = readEntry(entryId);
  return writeEntry({ ...entry, status: "accepted" });
}

/**
 * status: 'proposed' -> 'discarded' ONLY (prep-content-ops.mjs's own
 * "refuses to discard accepted content" convention) -- throws a clear Error
 * if the entry is already 'accepted'.
 * @returns {object} the updated BestiaryEntry.
 */
export function discardBestiaryEntry(entryId) {
  const entry = readEntry(entryId);
  if (entry.status === "accepted") {
    throw new Error(
      `Refusing to discard bestiary entry "${entryId}" (status "accepted") -- only a not-yet-accepted 'proposed' ` +
      `entry can be discarded outright.`
    );
  }
  return writeEntry({ ...entry, status: "discarded" });
}

/**
 * §5's status-INDEPENDENT patch -- mirrors updateBestiaryEntryScore's own
 * "no status check" convention (an ongoing table-use edit, not a re-ingest a
 * DM's own acceptance decision should gate).
 * @returns {object}   the updated BestiaryEntry (projection included)
 */
export function updateBestiaryEntryNote(entryId, note) {
  const entry = readEntry(entryId);
  return projectReadFields(writeEntry({ ...entry, note: note ?? null }));
}

/**
 * §5's status-INDEPENDENT patch, same convention as updateBestiaryEntryNote.
 * @returns {object}   the updated BestiaryEntry (projection included)
 */
export function updateBestiaryEntryRating(entryId, rating) {
  const entry = readEntry(entryId);
  return projectReadFields(writeEntry({ ...entry, rating: rating ?? null }));
}

/**
 * PURE, no I/O. A compact, non-numeric FLAVOR line derived from rawFields --
 * "type, CR X, alignment" style, deliberately never the literal attack/
 * damage-dice numbers (those stay untouched wherever this line is used).
 * Two Phase 37.6b call sites share this ONE formatter rather than each
 * re-deriving their own: promoteBestiaryEntryToGraph seeds a new graph
 * node's description with it, and combat-planning/reskin-suggest.mjs's
 * prompt context uses it to describe "what this stat block IS" to the model
 * without handing over the numbers themselves to reinterpret.
 * @param {object} rawFields
 * @returns {string|null}   null if rawFields has nothing to say
 */
export function compactStatFlavorLine(rawFields) {
  const rf = rawFields || {};
  const parts = [];
  if (rf.type) parts.push(rf.type);
  if (rf.challengeRating != null) parts.push(`CR ${rf.challengeRating}`);
  if (rf.alignment) parts.push(rf.alignment);
  if (Array.isArray(rf.attacks) && rf.attacks.length) {
    const names = rf.attacks.map((a) => a?.name).filter(Boolean).slice(0, 3);
    if (names.length) parts.push(`fights with ${names.join(", ")}`);
  }
  return parts.length ? parts.join(", ") : null;
}

/**
 * Status-independent patch (mirrors setItemGraphEntityId/updateBestiaryEntryNote's
 * own "no status check" convention -- a promote is an ongoing table-use
 * action, not a proposed-content edit) that writes the back-link
 * promoteBestiaryEntryToGraph computes. Not exposed as its own route;
 * promoteBestiaryEntryToGraph is the only caller.
 * @returns {object}   the updated BestiaryEntry (projection included)
 */
function setBestiaryEntryGraphEntityId(entryId, graphEntityId) {
  const entry = readEntry(entryId);
  return projectReadFields(writeEntry({ ...entry, graphEntityId }));
}

/**
 * Phase 37.6b -- "Promote to a named world figure." Mirrors item-store.mjs's
 * promoteItemToGraph exactly: SAME mechanism (addNodeOp, the one manual-
 * entity-creation route every promote/attach action in this project already
 * shares), SAME idempotent "second promote returns the existing node,
 * writes nothing" convention (a plain 200 re-describing current state, not
 * a 409 -- promoting twice is not an error condition from the GM's point of
 * view). Creates a real World Fabric graph entity from this BestiaryEntry
 * and back-links the entry via `graphEntityId`. The entry keeps living in
 * the Bestiary -- this only adds a back-link, never mutates rawFields/
 * status/anything else about it.
 *
 * ENTITY TYPE: always `"person"` -- deliberately NOT dynamically inferred
 * per-entry (e.g. off rf.type's free-text "beast"/"humanoid"/"construct"
 * creature-type wording). Two reasons, both documented here since the task
 * plan explicitly asked for the choice to be recorded:
 *   1. The Library's own copy for this exact affordance is "Promote to a
 *      NAMED WORLD FIGURE," not "promote to a graph node" -- the whole
 *      point of this action (distinct from the item promote's neutral
 *      "object" default) is elevating a stat block to the standing of a
 *      recognized INDIVIDUAL in the world. "person" is this graph's
 *      closest available concept for that intent.
 *   2. This project's global entity-type enum (wf-mcp-server/index.mjs's
 *      z.enum(["person","place","faction","object","event","concept"]),
 *      the SAME enum item-store.mjs's own header comment already cites for
 *      its "object" choice) has no dedicated "creature"/"monster" type at
 *      all, and rf.type's free text ("giant", "swarm of Tiny beasts",
 *      "elemental (air)"...) is not a reliable classifier onto the six-item
 *      enum. Rather than guess wrong silently for a whole class of
 *      creatures (an ooze reading "person" is an honest, visible
 *      approximation; an ooze guessed into a wrong bucket by shaky regex
 *      matching is a silent one), this names the ACTION's intent directly.
 *      A promoted ooze or swarm reading "person" in the graph's type field
 *      is the same kind of honest tradeoff item-store's own "object"
 *      default already accepted for a promoted Reliquary weapon.
 *
 * DESCRIPTION: seeded from compactStatFlavorLine(entry.rawFields) when the
 * entry has enough rawFields to produce one -- never fabricated prose, the
 * SAME compact formatter combat-planning/reskin-suggest.mjs's prompt
 * context uses (one shared helper, not two).
 *
 * @param {string} dir     resolved data dir (resolveDir()'s return value)
 * @param {string} world   which world's graph gains the node -- a
 *   BestiaryEntry itself carries no world (library-wide, per this module's
 *   own scoping decision above), so the caller/GM picks the destination
 *   world at promote time, exactly like item-store's identically-shaped
 *   `{world}` route body param
 * @param {string} entryId
 * @returns {Promise<{entry:object, entityId:string, created:boolean}>}
 */
export async function promoteBestiaryEntryToGraph(dir, world, entryId) {
  const existing = getBestiaryEntry(entryId); // throws "No bestiary entry found" -- same not-found convention as every sibling store's own promote

  if (existing.graphEntityId) {
    return { entry: existing, entityId: existing.graphEntityId, created: false };
  }

  const description = compactStatFlavorLine(existing.rawFields);
  const { entityId } = await addNodeOp(dir, world, {
    name: existing.rawFields?.name || "Unnamed",
    type: "person",
    ...(description ? { description } : {})
  });

  const entry = setBestiaryEntryGraphEntityId(entryId, entityId);
  return { entry, entityId, created: true };
}

/**
 * Phase 37.6b -- "Wear it as something else," accept-half. Creates a NEW
 * BestiaryEntry from an accepted combat-planning/reskin-suggest.mjs
 * suggestion:
 *   - rawFields: IDENTICAL to the source entry's, with ONLY `name`
 *     overwritten -- "same numbers, different creature" taken literally;
 *     ac/hp/attacks/everything else is a structural copy, never re-derived
 *     or passed through the model at all.
 *   - the suggestion's flavor description (+ habitat hint) is written into
 *     the new entry's `note` -- this store's EXISTING free-form GM-note
 *     field (§5 above), per the task's own "desc into note ... per the
 *     store shape" instruction; no new persisted prose field invented for it.
 *   - `reskinOfEntryId` back-links to the entry it was reskinned from -- the
 *     flag deriveSourcePill keys "reskin" off of.
 *   - status is `"accepted"` immediately, NOT left `"proposed"` like a
 *     fresh ingest -- the GM already made an explicit accept/dismiss
 *     decision on the one-shot suggestion card itself; this function IS
 *     that accept, not a re-review of it.
 *   - `foundryActorRef` stays null always -- a reskin has no Foundry actor
 *     of its own ("NOT foundry-linked" per the task's own explicit wording).
 *
 * checkBestiaryOutliers still runs (via the ordinary saveBestiaryEntry path,
 * unchanged) -- the copied rawFields will always score identically to the
 * source entry's own outlier result, since the numbers are untouched.
 *
 * @param {object} sourceEntry   the BestiaryEntry being reskinned (its rawFields are copied verbatim, only `name` overwritten)
 * @param {{name:string, description:string, habitatHint?:string}} suggestion
 * @param {object} [opts]   forwarded to saveBestiaryEntry (opts.makeId/opts.now, for deterministic tests)
 * @returns {object}   the created, already-accepted BestiaryEntry (projection included)
 */
export function createReskinnedBestiaryEntry(sourceEntry, suggestion, opts = {}) {
  const name = String(suggestion?.name ?? "").trim();
  if (!name) {
    throw new Error("createReskinnedBestiaryEntry requires a non-empty suggestion.name.");
  }
  const description = String(suggestion?.description ?? "").trim();
  const habitatHint = String(suggestion?.habitatHint ?? "").trim();
  const note = [description, habitatHint ? `Habitat: ${habitatHint}` : null].filter(Boolean).join("\n\n");

  const rawFields = { ...(sourceEntry?.rawFields ?? {}), name };
  const created = saveBestiaryEntry(
    { rawFields, sourceText: null, sourcePdfName: null, foundryActorRef: null, reskinOfEntryId: sourceEntry?.id ?? null },
    opts
  );
  if (note) updateBestiaryEntryNote(created.id, note);
  acceptBestiaryEntry(created.id);
  return getBestiaryEntry(created.id);
}

export { ConcurrentWriteError };
