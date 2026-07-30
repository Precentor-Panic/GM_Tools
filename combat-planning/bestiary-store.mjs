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
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";

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
 * Parses a dice-string average (e.g. "2d6+3" -> 10, "40d10+400" -> 620).
 * Pure. Returns null (never throws, never guesses) for a shape it doesn't
 * recognize -- checkBestiaryOutliers below simply skips an unparseable
 * attack rather than fabricating a number for it.
 * @param {string} diceStr
 * @returns {number|null}
 */
export function diceAverage(diceStr) {
  if (typeof diceStr !== "string") return null;
  const m = diceStr.trim().match(/^(\d+)d(\d+)\s*([+-]\s*\d+)?$/i);
  if (!m) {
    // A plain flat number (no dice at all) is also a valid "damageDice" in
    // principle -- tolerate it rather than treating it as unparseable.
    const flat = Number(diceStr.trim());
    return Number.isFinite(flat) ? flat : null;
  }
  const count = Number(m[1]);
  const sides = Number(m[2]);
  const modifier = m[3] ? Number(m[3].replace(/\s+/g, "")) : 0;
  return count * ((sides + 1) / 2) + modifier;
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
 * @param {{rawFields:object, derivedScore?:object|null, sourceText?:string|null, sourcePdfName?:string|null}} fields
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object}   the created BestiaryEntry
 */
export function saveBestiaryEntry({ rawFields, derivedScore = null, sourceText = null, sourcePdfName = null }, opts = {}) {
  const makeId = opts.makeId ?? makeBestiaryEntryId;
  const now = opts.now ?? new Date().toISOString();
  const outlier = checkBestiaryOutliers(rawFields);

  const entry = {
    id: makeId(),
    rawFields,
    derivedScore,
    sourceText,
    sourcePdfName,
    needsConfirmation: outlier.flagged,
    outlierReasons: outlier.reasons,
    status: "proposed",
    createdAt: now
  };

  return writeEntry(entry);
}

/** @returns {object}   the BestiaryEntry. Throws a clear Error if not found. */
export function getBestiaryEntry(entryId) {
  return readEntry(entryId);
}

/** @returns {object[]}   every BestiaryEntry across the whole library (NOT scoped to any world). [] if none exist yet. */
export function listBestiaryEntries() {
  const root = bestiaryRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(root, f), "utf8")));
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

export { ConcurrentWriteError };
