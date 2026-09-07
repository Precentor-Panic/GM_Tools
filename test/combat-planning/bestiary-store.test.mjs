import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — combat-planning/bestiary-store.mjs (Phase 18 task
 * 18.1). This module does not exist yet; this file is the interface spec for
 * it, per plans/phase-18-tasks.md task 18.0. It is expected to fail with
 * "Cannot find module" until 18.1 lands.
 *
 * SCOPING DECISION (design record §1a/§4 left this explicitly open --
 * resolved HERE, at spec time, per task 18.1's own instruction to "state the
 * decision and reasoning since the design record explicitly left it open"):
 * bestiary storage is PER-USER / LIBRARY-WIDE, NOT per-world. Reasoning
 * (from the design record's own text): "A monster a DM owns isn't really
 * tied to one campaign." This is a deliberate, first-of-its-kind exception to
 * every other store in this project (which are all per-world) -- flagged
 * here explicitly so 18.1's real implementation doesn't silently drift back
 * to a per-world shape out of habit.
 *
 * Storage: ONE JSON FILE PER ENTRY (entity-narration.mjs's per-id-file
 * convention, not scenes.mjs's per-world-file convention -- chosen because
 * there is no per-world grouping concept here at all): `<bestiaryRoot>/
 * <entryId>.json`. listBestiaryEntries() does a readdir across the whole
 * root (no world subdir to descend into). Default root GM_Tools/bestiary/
 * (sibling to entity-narration/, session-scenes/); override with
 * GM_TOOLS_BESTIARY_DIR (tests use this for isolation). Reuses
 * review-state.mjs's withLock/ConcurrentWriteError, per every other store's
 * established precedent -- GM_TOOLS_REVIEW_STATE_DIR must ALSO be isolated
 * by any test importing this module.
 *
 * "Show your work" requirement (design record §1a): a BestiaryEntry stores
 * the RAW extracted fields (bestiary-ingest.mjs's output) AND the derived
 * score (combat-planning/action-economy.mjs + effect-impact.mjs's output,
 * attached later, task 18.3) SIDE BY SIDE -- never just the collapsed score.
 * `derivedScore` is null until updateBestiaryEntryScore() attaches one; this
 * module does NOT compute scores itself (that would violate the pure-scoring
 * module boundary task 18.3 exists to enforce) -- it only stores whatever a
 * caller computed and handed it.
 *
 * Ingestion-time outlier sanity check (design record §1a, a HARD requirement
 * per task 18.0): checkBestiaryOutliers flags an implausible entry for human
 * confirmation BEFORE it's treated as trustworthy -- saveBestiaryEntry always
 * runs this check and stamps its result onto the entry (`needsConfirmation`,
 * `outlierReasons`), it is never a separate opt-in step a caller could forget.
 *
 * Lighter review than the graph's mutation-review batch machinery (design
 * record §1a: "more like prep-content-ops.mjs's accept/discard pattern"):
 * a BestiaryEntry's `status` is `'proposed' | 'accepted' | 'discarded'` --
 * no batchId, no diff, no sync-to-Foundry reachability at all.
 *
 * BestiaryEntry shape:
 *   {
 *     id: string,
 *     rawFields: object,             // bestiary-ingest.mjs's RawBestiaryFields, verbatim
 *     derivedScore: object|null,     // combat-planning scoring output, or null until attached
 *     sourceText: string|null,       // the original pasted text, if that's how it was ingested
 *     sourcePdfName: string|null,    // a filename/label, if ingested from a PDF (never the PDF bytes themselves)
 *     needsConfirmation: boolean,    // outlier-check result
 *     outlierReasons: string[],      // [] if needsConfirmation is false
 *     status: 'proposed'|'accepted'|'discarded',
 *     createdAt: string              // ISO timestamp
 *   }
 *
 * ---------------------------------------------------------------------------
 * bestiaryRoot()
 * ---------------------------------------------------------------------------
 * @returns {string}   process.env.GM_TOOLS_BESTIARY_DIR || DEFAULT_ROOT
 *
 * ---------------------------------------------------------------------------
 * checkBestiaryOutliers(rawFields)
 * ---------------------------------------------------------------------------
 * PURE function, no I/O. A "gross-outlier guard on the derived fields" --
 * per design record §1a: a DPR-to-HP ratio outside a broad plausible band,
 * or an attack-bonus-vs-AC figure implausible relative to stated
 * level/CR. Concretely (v1, deliberately generous bands -- this is a
 * confirmation flag, not a rejection):
 *   - flags if any single attack's estimated per-round damage
 *     (damageDice's average, times multiattack count if present) exceeds the
 *     stat block's OWN hp -- a creature that can one-shot-kill something with
 *     its own hp's worth of health in a single round is plausible only at the
 *     extreme high end, worth a human glance.
 *   - flags if hp <= 0 or ac <= 0 (a parsing failure wearing a plausible-looking
 *     JSON shape).
 *   @param {object} rawFields
 *   @returns {{flagged:boolean, reasons:string[]}}
 *
 * ---------------------------------------------------------------------------
 * saveBestiaryEntry({ rawFields, derivedScore, sourceText, sourcePdfName }, opts)
 * ---------------------------------------------------------------------------
 * Always runs checkBestiaryOutliers(rawFields) and stamps the result.
 * status is always 'proposed' at creation.
 *   @param {object} [opts]
 *   @param {() => string} [opts.makeId]
 *   @param {string} [opts.now]
 *   @returns {object}   the created BestiaryEntry
 *
 * ---------------------------------------------------------------------------
 * getBestiaryEntry(entryId)
 * ---------------------------------------------------------------------------
 * @returns {object}   the BestiaryEntry. Throws a clear Error if not found.
 *
 * ---------------------------------------------------------------------------
 * listBestiaryEntries()
 * ---------------------------------------------------------------------------
 * @returns {object[]}   every BestiaryEntry across the whole library (NOT
 *                        scoped to any world). [] if none exist yet.
 *
 * ---------------------------------------------------------------------------
 * updateBestiaryEntryScore(entryId, derivedScore)
 * ---------------------------------------------------------------------------
 * Attaches (or replaces) a BestiaryEntry's derivedScore WITHOUT touching
 * rawFields -- "show your work" means both must persist together, but this
 * function is how the score half gets filled in after the pure scoring
 * functions (task 18.3/18.4) run against the already-stored rawFields.
 *   @returns {object}   the updated BestiaryEntry
 *
 * ---------------------------------------------------------------------------
 * acceptBestiaryEntry(entryId)
 * ---------------------------------------------------------------------------
 * status: 'proposed' -> 'accepted'. @returns {object} the updated BestiaryEntry.
 *
 * ---------------------------------------------------------------------------
 * discardBestiaryEntry(entryId)
 * ---------------------------------------------------------------------------
 * status: 'proposed' -> 'discarded' ONLY (prep-content-ops.mjs's own
 * "refuses to discard accepted content" convention) -- throws a clear Error
 * if the entry is already 'accepted'. @returns {object} the updated BestiaryEntry.
 */

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-bestiary-store-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
// Phase 37.6b -- promoteBestiaryEntryToGraph's own addNodeOp dependency
// chain (manual-edit-ops.mjs) transitively touches manual-undo/human-review,
// same isolation set test/scene-planning/scene-elements.test.mjs's own
// promoteElement tests already establish for the identical addNodeOp call.
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.WF_DATA_DIR = join(scratchDir, "foundrydata");

const REPO_DEFAULT_ROOT = join(new URL("../../bestiary", import.meta.url).pathname);
const before = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();

const PROMOTE_WORLD = "bestiary-store-promote-test-world";

const PLAUSIBLE_RAW_FIELDS = {
  name: "Dire Wolf",
  type: "beast",
  hp: 37,
  ac: 14,
  attacks: [{ name: "Bite", toHitBonus: 5, damageDice: "2d6+3" }]
};

const IMPLAUSIBLE_RAW_FIELDS = {
  name: "Suspiciously Deadly Rat",
  type: "beast",
  hp: 1,
  ac: 10,
  attacks: [{ name: "Cataclysm Bite", toHitBonus: 20, damageDice: "40d10+400" }]
};

(async () => {
  const {
    bestiaryRoot,
    checkBestiaryOutliers,
    saveBestiaryEntry,
    getBestiaryEntry,
    listBestiaryEntries,
    updateBestiaryEntryScore,
    acceptBestiaryEntry,
    discardBestiaryEntry,
    updateBestiaryEntryRawFields,
    compactStatFlavorLine,
    promoteBestiaryEntryToGraph,
    createReskinnedBestiaryEntry
  } = await import("../../combat-planning/bestiary-store.mjs");
  const { snapshotFilePath, loadSnapshot } = await import("../../wf-mcp-server/lib/snapshot.mjs");
  const { bootstrapSnapshot } = await import("../../graph-import/headless-apply.mjs");
  bootstrapSnapshot(snapshotFilePath(process.env.WF_DATA_DIR, PROMOTE_WORLD), { worldId: PROMOTE_WORLD });

  test("directory isolation: bestiaryRoot() honors GM_TOOLS_BESTIARY_DIR, never the repo's real default", () => {
    assert.equal(bestiaryRoot(), process.env.GM_TOOLS_BESTIARY_DIR);
    assert.notEqual(bestiaryRoot(), REPO_DEFAULT_ROOT);
  });

  test("checkBestiaryOutliers: a plausible entry is NOT flagged", () => {
    const result = checkBestiaryOutliers(PLAUSIBLE_RAW_FIELDS);
    assert.equal(result.flagged, false);
    assert.deepEqual(result.reasons, []);
  });

  test("checkBestiaryOutliers: an implausible DPR-to-HP ratio IS flagged, with a non-empty reason", () => {
    const result = checkBestiaryOutliers(IMPLAUSIBLE_RAW_FIELDS);
    assert.equal(result.flagged, true);
    assert.ok(result.reasons.length > 0);
  });

  test("saveBestiaryEntry: a plausible entry saves with needsConfirmation:false, status:'proposed', derivedScore:null", () => {
    const entry = saveBestiaryEntry(
      { rawFields: PLAUSIBLE_RAW_FIELDS, sourceText: "pasted text..." },
      { makeId: () => "bst-1", now: "2026-07-22T18:00:00.000Z" }
    );
    assert.equal(entry.id, "bst-1");
    assert.equal(entry.status, "proposed");
    assert.equal(entry.needsConfirmation, false);
    assert.equal(entry.derivedScore, null);
    assert.deepEqual(entry.rawFields, PLAUSIBLE_RAW_FIELDS);
  });

  test("saveBestiaryEntry: an implausible entry saves with needsConfirmation:true and reasons attached (never silently accepted as trustworthy)", () => {
    const entry = saveBestiaryEntry(
      { rawFields: IMPLAUSIBLE_RAW_FIELDS },
      { makeId: () => "bst-2", now: "2026-07-22T18:05:00.000Z" }
    );
    assert.equal(entry.needsConfirmation, true);
    assert.ok(entry.outlierReasons.length > 0);
  });

  test("getBestiaryEntry: round-trips a saved entry by id", () => {
    const reread = getBestiaryEntry("bst-1");
    assert.equal(reread.id, "bst-1");
    assert.equal(reread.rawFields.name, "Dire Wolf");
  });

  test("getBestiaryEntry: throws a clear error for an unknown id", () => {
    assert.throws(() => getBestiaryEntry("no-such-entry"), /no-such-entry/);
  });

  test("listBestiaryEntries: lists across the WHOLE library, not scoped to any world", () => {
    const ids = listBestiaryEntries().map((e) => e.id);
    assert.ok(ids.includes("bst-1"));
    assert.ok(ids.includes("bst-2"));
  });

  test("updateBestiaryEntryScore: attaches a derivedScore without touching rawFields ('show your work' -- both persist together)", () => {
    const updated = updateBestiaryEntryScore("bst-1", { actionEconomyScore: 12, aggregatedImpactScore: 7 });
    assert.deepEqual(updated.derivedScore, { actionEconomyScore: 12, aggregatedImpactScore: 7 });
    assert.deepEqual(updated.rawFields, PLAUSIBLE_RAW_FIELDS, "rawFields must be untouched by a score attach");
  });

  test("acceptBestiaryEntry: proposed -> accepted", () => {
    const updated = acceptBestiaryEntry("bst-1");
    assert.equal(updated.status, "accepted");
  });

  test("discardBestiaryEntry: refuses to discard an already-accepted entry", () => {
    assert.throws(() => discardBestiaryEntry("bst-1"), /accepted/i);
  });

  test("discardBestiaryEntry: a still-'proposed' entry discards cleanly", () => {
    const updated = discardBestiaryEntry("bst-2");
    assert.equal(updated.status, "discarded");
  });

  test("no write in this file leaked into the repo's real default bestiary/ directory", () => {
    const after = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();
    const added = [...after].filter((f) => !before.has(f));
    assert.deepEqual(added, [], `this test run must not add new entries to ${REPO_DEFAULT_ROOT}, found: ${added}`);
  });

  // -------------------------------------------------------------------------
  // Phase 32 task 32.2 -- foundryActorRef link field + updateBestiaryEntryRawFields,
  // the store-side half of the Foundry PULL ingest's review-gated
  // dedup/re-ingest contract (wf-mcp-server/lib/foundry-pull-ops.mjs).
  // -------------------------------------------------------------------------

  test("saveBestiaryEntry: foundryActorRef defaults to null for every pre-existing (non-Foundry) caller", () => {
    const entry = saveBestiaryEntry({ rawFields: PLAUSIBLE_RAW_FIELDS }, { makeId: () => "bst-no-ref", now: "2026-08-06T00:00:00.000Z" });
    assert.equal(entry.foundryActorRef, null);
  });

  test("saveBestiaryEntry: foundryActorRef round-trips when explicitly provided (the Foundry-pull ingest's path)", () => {
    const entry = saveBestiaryEntry(
      { rawFields: PLAUSIBLE_RAW_FIELDS, foundryActorRef: "Actor.gob001boss" },
      { makeId: () => "bst-ref-1", now: "2026-08-06T00:00:00.000Z" }
    );
    assert.equal(entry.foundryActorRef, "Actor.gob001boss");
    assert.equal(entry.status, "proposed");
    const reread = getBestiaryEntry("bst-ref-1");
    assert.equal(reread.foundryActorRef, "Actor.gob001boss");
  });

  test("updateBestiaryEntryRawFields: overwrites rawFields/sourceText on a still-'proposed' entry, preserving id/foundryActorRef/status/createdAt", () => {
    const updatedRawFields = { ...PLAUSIBLE_RAW_FIELDS, hp: 40 };
    const updated = updateBestiaryEntryRawFields("bst-ref-1", { rawFields: updatedRawFields, sourceText: "re-pulled" });
    assert.equal(updated.id, "bst-ref-1");
    assert.equal(updated.foundryActorRef, "Actor.gob001boss");
    assert.equal(updated.status, "proposed");
    assert.equal(updated.createdAt, "2026-08-06T00:00:00.000Z");
    assert.equal(updated.rawFields.hp, 40);
    assert.equal(updated.sourceText, "re-pulled");
  });

  test("updateBestiaryEntryRawFields: NEVER silently overwrites an already-'accepted' entry -- refuses with a clear error (the no-silent-auto-write invariant, applied to a re-ingest)", () => {
    const accepted = acceptBestiaryEntry("bst-ref-1");
    assert.equal(accepted.status, "accepted");
    assert.throws(
      () => updateBestiaryEntryRawFields("bst-ref-1", { rawFields: { ...PLAUSIBLE_RAW_FIELDS, hp: 999 } }),
      /accepted/i
    );
    // and the entry's own content is provably untouched by the refused call
    const reread = getBestiaryEntry("bst-ref-1");
    assert.equal(reread.rawFields.hp, 40, "must still be the value from the last successful update, not 999");
  });

  // -------------------------------------------------------------------------
  // Phase 35 task 35.1, §5 -- note/rating (status-independent patch) +
  // sourcePill (derived, read-time-only projection).
  // -------------------------------------------------------------------------

  const { deriveSourcePill, updateBestiaryEntryNote, updateBestiaryEntryRating } = await import("../../combat-planning/bestiary-store.mjs");

  test("deriveSourcePill: PURE -- foundryActorRef present -> 'foundry'", () => {
    assert.equal(deriveSourcePill({ foundryActorRef: "Actor.x", sourceText: null, sourcePdfName: null }), "foundry");
  });

  test("deriveSourcePill: sourceText/sourcePdfName mentioning 'SRD' (case-insensitive) -> 'srd'", () => {
    assert.equal(deriveSourcePill({ foundryActorRef: null, sourceText: "Pulled from the 2014 SRD", sourcePdfName: null }), "srd");
    assert.equal(deriveSourcePill({ foundryActorRef: null, sourceText: null, sourcePdfName: "srd-monsters.pdf" }), "srd");
  });

  test("deriveSourcePill: neither signal present -> 'mine'", () => {
    assert.equal(deriveSourcePill({ foundryActorRef: null, sourceText: "hand-typed", sourcePdfName: null }), "mine");
  });

  // Friction Wave 1 W4c -- the add-from-plutonium provenance stamp.
  test("deriveSourcePill (W4c): 'via Plutonium' in sourceText -> 'plutonium', checked BEFORE the srd branch, and never triggered by an unrelated mention of the word", () => {
    assert.equal(deriveSourcePill({ foundryActorRef: null, sourceText: "MM p347 via Plutonium", sourcePdfName: null }), "plutonium");
    // A source string that could ALSO read srd-ish: the explicit stamp wins.
    assert.equal(deriveSourcePill({ foundryActorRef: null, sourceText: "SRD p1 via Plutonium", sourcePdfName: null }), "plutonium");
    // foundryActorRef still outranks everything (a later Foundry-link wins).
    assert.equal(deriveSourcePill({ foundryActorRef: "Actor.x", sourceText: "MM p347 via Plutonium", sourcePdfName: null }), "foundry");
    // A note merely mentioning the module name without the stamp stays 'mine'.
    assert.equal(deriveSourcePill({ foundryActorRef: null, sourceText: "reminded me of the plutonium module", sourcePdfName: null }), "mine");
  });

  test("getBestiaryEntry/listBestiaryEntries: a pre-Phase-35 entry (no note/rating on disk) reads note:null, rating:null, and a derived sourcePill", () => {
    // saveBestiaryEntry's own return value is NOT run through the read-time
    // projection (it's a create, not a read boundary) -- assert the
    // projection via getBestiaryEntry/listBestiaryEntries instead, the two
    // actual read boundaries §5 pins.
    saveBestiaryEntry({ rawFields: PLAUSIBLE_RAW_FIELDS }, { makeId: () => "bst-p35-legacy", now: "2026-08-08T00:00:00.000Z" });
    const reread = getBestiaryEntry("bst-p35-legacy");
    assert.equal(reread.note, null);
    assert.equal(reread.rating, null);
    assert.equal(reread.sourcePill, "mine");
    const inList = listBestiaryEntries().find((e) => e.id === "bst-p35-legacy");
    assert.equal(inList.note, null);
    assert.equal(inList.rating, null);
    assert.equal(inList.sourcePill, "mine");
  });

  test("sourcePill is NEVER persisted to disk -- it's a pure read-time projection of already-stored fields", () => {
    const raw = JSON.parse(readFileSync(join(process.env.GM_TOOLS_BESTIARY_DIR, "bst-p35-legacy.json"), "utf8"));
    assert.equal("sourcePill" in raw, false, "sourcePill must not exist in the on-disk JSON at all");
  });

  test("updateBestiaryEntryNote/updateBestiaryEntryRating: STATUS-INDEPENDENT -- patch an ALREADY-ACCEPTED entry successfully (mirrors updateBestiaryEntryScore's own no-status-check convention, not the proposed-only guard)", () => {
    const accepted = acceptBestiaryEntry("bst-p35-legacy");
    assert.equal(accepted.status, "accepted");

    const noted = updateBestiaryEntryNote("bst-p35-legacy", "Watch for the ambush.");
    assert.equal(noted.note, "Watch for the ambush.");
    assert.equal(noted.status, "accepted", "status untouched by a note edit");

    const rated = updateBestiaryEntryRating("bst-p35-legacy", "3");
    assert.equal(rated.rating, "3");
    assert.equal(rated.status, "accepted", "status untouched by a rating edit");

    const reread = getBestiaryEntry("bst-p35-legacy");
    assert.equal(reread.note, "Watch for the ambush.");
    assert.equal(reread.rating, "3");
  });

  test("updateBestiaryEntryNote/updateBestiaryEntryRating: an explicit null clears the field back to 'use the book value'/no note", () => {
    const cleared = updateBestiaryEntryRating("bst-p35-legacy", null);
    assert.equal(cleared.rating, null);
  });

  // ---------------------------------------------------------------------
  // Phase 37.6b -- "Promote to a named world figure" + "Wear it as
  // something else" (wiring the two remaining Library stubs).
  // ---------------------------------------------------------------------

  test("compactStatFlavorLine: PURE -- a non-numeric flavor summary (type, CR, alignment, named attacks) never includes the actual damage numbers", () => {
    const line = compactStatFlavorLine({
      name: "Test Goblin", type: "humanoid (goblinoid)", challengeRating: "1/4", alignment: "neutral evil",
      attacks: [{ name: "Scimitar", toHitBonus: 4, damageDice: "1d6+2" }]
    });
    assert.match(line, /humanoid \(goblinoid\)/);
    assert.match(line, /CR 1\/4/);
    assert.match(line, /neutral evil/);
    assert.match(line, /Scimitar/);
    assert.doesNotMatch(line, /1d6\+2/, "must never leak the literal damage dice into the flavor line");
  });

  test("compactStatFlavorLine: null for rawFields with nothing to say (never fabricates prose)", () => {
    assert.equal(compactStatFlavorLine({}), null);
    assert.equal(compactStatFlavorLine(null), null);
  });

  await testAsync("promoteBestiaryEntryToGraph: creates a REAL graph node (type 'person', description seeded from compactStatFlavorLine) and back-links graphEntityId", async () => {
    const entry = saveBestiaryEntry(
      { rawFields: PLAUSIBLE_RAW_FIELDS },
      { makeId: () => "bst-promote-1", now: "2026-08-12T00:00:00.000Z" }
    );
    const before = loadSnapshot(process.env.WF_DATA_DIR, PROMOTE_WORLD).snapshot.entities.length;

    const result = await promoteBestiaryEntryToGraph(process.env.WF_DATA_DIR, PROMOTE_WORLD, entry.id);
    assert.equal(result.created, true);
    assert.ok(result.entityId, "must return the new entity's id");

    const after = loadSnapshot(process.env.WF_DATA_DIR, PROMOTE_WORLD).snapshot;
    assert.equal(after.entities.length, before + 1, "exactly one new entity created");
    const node = after.entities.find((n) => n.id === result.entityId);
    assert.ok(node, "the promoted entity must be a real, fetchable graph node");
    assert.equal(node.name, "Dire Wolf");
    assert.equal(node.type, "person", "the deliberate, documented choice -- see promoteBestiaryEntryToGraph's own doc comment for why");
    assert.match(node.description, /beast/, "description seeded from compactStatFlavorLine, not fabricated");

    const reread = getBestiaryEntry(entry.id);
    assert.equal(reread.graphEntityId, result.entityId, "the BestiaryEntry must be back-linked to the real node");
    assert.equal(reread.rawFields.hp, PLAUSIBLE_RAW_FIELDS.hp, "the entry's own stat block is untouched by promotion");
  });

  await testAsync("promoteBestiaryEntryToGraph: idempotent -- a second promote returns the SAME entityId, created:false, creates NO second node", async () => {
    const entry = saveBestiaryEntry(
      { rawFields: PLAUSIBLE_RAW_FIELDS },
      { makeId: () => "bst-promote-2", now: "2026-08-12T00:00:00.000Z" }
    );
    const first = await promoteBestiaryEntryToGraph(process.env.WF_DATA_DIR, PROMOTE_WORLD, entry.id);
    const beforeSecond = loadSnapshot(process.env.WF_DATA_DIR, PROMOTE_WORLD).snapshot.entities.length;

    const second = await promoteBestiaryEntryToGraph(process.env.WF_DATA_DIR, PROMOTE_WORLD, entry.id);
    assert.equal(second.created, false);
    assert.equal(second.entityId, first.entityId, "must return the SAME entity id, not a new one");

    const afterSecond = loadSnapshot(process.env.WF_DATA_DIR, PROMOTE_WORLD).snapshot.entities.length;
    assert.equal(afterSecond, beforeSecond, "promoting twice must NOT create a second node");
  });

  await testAsync("promoteBestiaryEntryToGraph: an entry with no rawFields flavor still promotes (description omitted, not a crash)", async () => {
    const entry = saveBestiaryEntry(
      { rawFields: { name: "Bare Stat Block" } },
      { makeId: () => "bst-promote-bare", now: "2026-08-12T00:00:00.000Z" }
    );
    const result = await promoteBestiaryEntryToGraph(process.env.WF_DATA_DIR, PROMOTE_WORLD, entry.id);
    assert.equal(result.created, true);
    const node = loadSnapshot(process.env.WF_DATA_DIR, PROMOTE_WORLD).snapshot.entities.find((n) => n.id === result.entityId);
    assert.equal(node.name, "Bare Stat Block");
  });

  await testAsync("promoteBestiaryEntryToGraph: an unknown entry id fails cleanly, no graph write", async () => {
    const before = loadSnapshot(process.env.WF_DATA_DIR, PROMOTE_WORLD).snapshot.entities.length;
    await assert.rejects(() => promoteBestiaryEntryToGraph(process.env.WF_DATA_DIR, PROMOTE_WORLD, "bst-does-not-exist"));
    const after = loadSnapshot(process.env.WF_DATA_DIR, PROMOTE_WORLD).snapshot.entities.length;
    assert.equal(after, before, "an unknown id must never create a node");
  });

  test("createReskinnedBestiaryEntry: rawFields IDENTICAL to the source except `name`; note carries description+habitat; status 'accepted'; never foundry-linked; sourcePill 'reskin'", () => {
    const source = saveBestiaryEntry(
      { rawFields: PLAUSIBLE_RAW_FIELDS, foundryActorRef: "Actor.source-wolf" },
      { makeId: () => "bst-reskin-source", now: "2026-08-12T00:00:00.000Z" }
    );
    const created = createReskinnedBestiaryEntry(
      source,
      { name: "Ashfen Cur", description: "A mangy, ash-grey stray that hunts in the ruined quarter.", habitatHint: "Urban ruins, at dusk." },
      { makeId: () => "bst-reskin-1", now: "2026-08-12T00:05:00.000Z" }
    );

    assert.equal(created.id, "bst-reskin-1");
    assert.equal(created.rawFields.name, "Ashfen Cur", "name is the ONE overwritten field");
    assert.equal(created.rawFields.hp, PLAUSIBLE_RAW_FIELDS.hp, "hp copied verbatim -- same numbers");
    assert.equal(created.rawFields.ac, PLAUSIBLE_RAW_FIELDS.ac, "ac copied verbatim -- same numbers");
    assert.deepEqual(created.rawFields.attacks, PLAUSIBLE_RAW_FIELDS.attacks, "attacks copied verbatim -- same numbers");
    assert.match(created.note, /mangy, ash-grey stray/, "the suggestion's description lands in the note field");
    assert.match(created.note, /Urban ruins, at dusk\./, "the habitat hint lands in the note field too");
    assert.equal(created.status, "accepted", "an accepted reskin suggestion IS the accept -- not left 'proposed'");
    assert.equal(created.foundryActorRef, null, "a reskin is NEVER foundry-linked, even when its source entry was");
    assert.equal(created.reskinOfEntryId, "bst-reskin-source", "back-linked to the entry it was reskinned from");
    assert.equal(created.sourcePill, "reskin");

    // Genuinely persisted, not just echoed -- re-fetch from disk.
    const reread = getBestiaryEntry("bst-reskin-1");
    assert.equal(reread.status, "accepted");
    assert.equal(reread.sourcePill, "reskin");
  });

  test("reskin opacity: flavorName/chassis/reflavorNotes set on a reskin; mechanics untouched; chassis carries the source code", () => {
    const source = saveBestiaryEntry(
      { rawFields: PLAUSIBLE_RAW_FIELDS, sourceText: "MM p341 via Plutonium" },
      { makeId: () => "bst-reskin-src-3", now: "2026-09-07T00:00:00.000Z" }
    );
    const created = createReskinnedBestiaryEntry(
      source,
      {
        name: "Copper Hand Sergeant",
        description: "A gate captain in copper-trimmed leathers.",
        habitatHint: "The Copper Gates, at inspection.",
        reflavorNotes: ["Its 'Fire Bolt' is a thrown alchemical vial — same attack, same damage."]
      },
      { makeId: () => "bst-reskin-3", now: "2026-09-07T00:05:00.000Z" }
    );

    assert.equal(created.flavorName, "Copper Hand Sergeant", "flavorName is the table-facing name");
    assert.equal(created.rawFields.name, "Copper Hand Sergeant", "rawFields.name still carries the flavor name (defense in depth)");
    assert.equal(created.chassis, `${PLAUSIBLE_RAW_FIELDS.name} (MM)`, "chassis is the GM-only display string with the source code");
    assert.deepEqual(created.reflavorNotes, ["Its 'Fire Bolt' is a thrown alchemical vial — same attack, same damage."]);
    // Russell's hard rule: mechanics deep-equal to the source, only name differs.
    for (const k of Object.keys(PLAUSIBLE_RAW_FIELDS)) {
      if (k === "name") continue;
      assert.deepEqual(created.rawFields[k], PLAUSIBLE_RAW_FIELDS[k], `${k} unchanged by reskin`);
    }

    const reread = getBestiaryEntry("bst-reskin-3");
    assert.equal(reread.flavorName, "Copper Hand Sergeant");
    assert.equal(reread.chassis, `${PLAUSIBLE_RAW_FIELDS.name} (MM)`);
    assert.deepEqual(reread.reflavorNotes, created.reflavorNotes);
  });

  test("reskin opacity: reflavorNotes omitted -> null; a legacy entry with no new fields reads flavorName === rawFields.name and null chassis/reflavor", () => {
    const source = saveBestiaryEntry(
      { rawFields: PLAUSIBLE_RAW_FIELDS },
      { makeId: () => "bst-reskin-src-4", now: "2026-09-07T00:00:00.000Z" }
    );
    // legacy/non-reskin entry: no flavorName stored -> defaults to rawFields.name
    assert.equal(getBestiaryEntry("bst-reskin-src-4").flavorName, PLAUSIBLE_RAW_FIELDS.name);
    assert.equal(getBestiaryEntry("bst-reskin-src-4").chassis, null);
    assert.equal(getBestiaryEntry("bst-reskin-src-4").reflavorNotes, null);

    const created = createReskinnedBestiaryEntry(
      source,
      { name: "Silt Trench Bruiser", description: "d", habitatHint: "h" },
      { makeId: () => "bst-reskin-4", now: "2026-09-07T00:05:00.000Z" }
    );
    assert.equal(created.reflavorNotes, null, "no reflavor lines -> null, not []");
    // source had no Plutonium stamp -> chassis is the bare chassis name, no (code)
    assert.equal(created.chassis, PLAUSIBLE_RAW_FIELDS.name);
  });

  test("createReskinnedBestiaryEntry: throws a clear error for an empty/missing suggestion name -- no entry created", () => {
    const source = saveBestiaryEntry(
      { rawFields: PLAUSIBLE_RAW_FIELDS },
      { makeId: () => "bst-reskin-source-2", now: "2026-08-12T00:00:00.000Z" }
    );
    assert.throws(
      () => createReskinnedBestiaryEntry(source, { name: "   ", description: "x", habitatHint: "y" }),
      /non-empty suggestion\.name/
    );
  });

  console.log(`\n${passed} passed`);
})();

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
