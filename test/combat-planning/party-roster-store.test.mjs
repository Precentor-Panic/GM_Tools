import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — combat-planning/party-roster-store.mjs (Phase 18
 * task 18.2). This module does not exist yet; this file is the interface
 * spec for it, per plans/phase-18-tasks.md task 18.0. It is expected to fail
 * with "Cannot find module" until 18.2 lands.
 *
 * UNLIKE bestiary-store.mjs's open per-user-vs-per-world scoping question,
 * the design record is explicit here: "PCs genuinely belong to one campaign"
 * -- this store is PER-WORLD. Storage: ONE JSON FILE PER WORLD (scenes.mjs's
 * convention, not entity-narration.mjs's per-id-file one) --
 * `<partyRosterRoot>/<world>.json`, a flat array of PartyMember objects.
 * Default root GM_Tools/party-roster/ (sibling to session-scenes/); override
 * with GM_TOOLS_PARTY_ROSTER_DIR (tests use this for isolation). Reuses
 * review-state.mjs's withLock/ConcurrentWriteError -- GM_TOOLS_REVIEW_STATE_DIR
 * must ALSO be isolated by any test importing this module.
 *
 * PartyMember shape (STRUCTURALLY separates combatRelevant/buildRelevant,
 * mirroring party-roster-ingest.mjs's own extraction split -- this store
 * does not flatten or merge the two groups):
 *   {
 *     id: string,
 *     world: string,
 *     name: string,
 *     combatRelevant: object,        // party-roster-ingest.mjs's RawPartyMemberFields.combatRelevant, verbatim
 *     buildRelevant: object,         // ...buildRelevant, verbatim
 *     sourceText: string|null,
 *     sourcePdfName: string|null,
 *     createdAt: string
 *   }
 *
 * ---------------------------------------------------------------------------
 * partyRosterRoot()
 * ---------------------------------------------------------------------------
 * @returns {string}   process.env.GM_TOOLS_PARTY_ROSTER_DIR || DEFAULT_ROOT
 *
 * ---------------------------------------------------------------------------
 * savePartyMember(world, { name, combatRelevant, buildRelevant, sourceText, sourcePdfName }, opts)
 * ---------------------------------------------------------------------------
 *   @param {object} [opts]
 *   @param {() => string} [opts.makeId]
 *   @param {string} [opts.now]
 *   @returns {object}   the created PartyMember
 *
 * ---------------------------------------------------------------------------
 * getPartyMember(world, memberId)
 * ---------------------------------------------------------------------------
 * @returns {object}   the PartyMember. Throws a clear Error if not found.
 *
 * ---------------------------------------------------------------------------
 * listPartyMembers(world)
 * ---------------------------------------------------------------------------
 * @returns {object[]}   every PartyMember for `world`, in creation order. [] if none.
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

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-party-roster-store-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");

const REPO_DEFAULT_ROOT = join(new URL("../../party-roster", import.meta.url).pathname);
const before = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();

const WORLD = "party-roster-store-test-world";

const COMBAT = { class: "Ranger", level: 5, ac: 15, hp: 44, damagePerRoundEstimate: 18 };
const BUILD = { skills: ["Survival"], backstoryHooks: ["Estranged from a ranger lodge"] };

(async () => {
  const {
    partyRosterRoot,
    savePartyMember,
    getPartyMember,
    listPartyMembers,
    acceptPartyMember,
    discardPartyMember,
    updatePartyMemberFields,
    relabelPartyMember,
    addPartyMemberObjective,
    updatePartyMemberObjective,
    removePartyMemberObjective,
    reorderPartyMemberObjectives,
    setPartyMemberObjectivesRef
  } = await import("../../combat-planning/party-roster-store.mjs");

  test("directory isolation: partyRosterRoot() honors GM_TOOLS_PARTY_ROSTER_DIR, never the repo's real default", () => {
    assert.equal(partyRosterRoot(), process.env.GM_TOOLS_PARTY_ROSTER_DIR);
    assert.notEqual(partyRosterRoot(), REPO_DEFAULT_ROOT);
  });

  test("listPartyMembers: [] for a world with no members yet -- not an error", () => {
    assert.deepEqual(listPartyMembers("a-totally-new-world"), []);
  });

  test("savePartyMember: creates a member with combatRelevant/buildRelevant kept as SEPARATE stored keys", () => {
    const member = savePartyMember(
      WORLD,
      { name: "Kessa Windrider", combatRelevant: COMBAT, buildRelevant: BUILD, sourceText: "..." },
      { makeId: () => "pm-1", now: "2026-07-22T18:00:00.000Z" }
    );
    assert.equal(member.id, "pm-1");
    assert.equal(member.world, WORLD);
    assert.deepEqual(member.combatRelevant, COMBAT);
    assert.deepEqual(member.buildRelevant, BUILD);
    assert.equal(member.createdAt, "2026-07-22T18:00:00.000Z");
  });

  test("getPartyMember: round-trips a saved member by id", () => {
    const reread = getPartyMember(WORLD, "pm-1");
    assert.equal(reread.name, "Kessa Windrider");
    assert.equal(reread.combatRelevant.class, "Ranger");
  });

  test("getPartyMember: throws a clear error for an unknown memberId", () => {
    assert.throws(() => getPartyMember(WORLD, "no-such-member"), /no-such-member/);
  });

  test("listPartyMembers: lists every member for the world, in creation order", () => {
    savePartyMember(WORLD, { name: "Bram Ironhide", combatRelevant: {}, buildRelevant: {} }, {
      makeId: () => "pm-2",
      now: "2026-07-22T18:10:00.000Z"
    });
    const members = listPartyMembers(WORLD);
    assert.deepEqual(members.map((m) => m.id), ["pm-1", "pm-2"]);
  });

  test("no write in this file leaked into the repo's real default party-roster/ directory", () => {
    const after = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();
    const added = [...after].filter((f) => !before.has(f));
    assert.deepEqual(added, [], `this test run must not add new entries to ${REPO_DEFAULT_ROOT}, found: ${added}`);
  });

  // -------------------------------------------------------------------------
  // Phase 32 task 32.2 -- the status:'proposed'|'accepted'|'discarded' gate +
  // foundryActorRef link field this store gained for the Foundry PULL ingest
  // (see this module's own header comment for the full reasoning: every
  // PRE-EXISTING caller keeps its current immediately-usable behavior via a
  // default status:'accepted'; only the Foundry-pull ingest ever passes
  // 'proposed' explicitly).
  // -------------------------------------------------------------------------

  test("savePartyMember: status defaults to 'accepted' and foundryActorRef defaults to null for every pre-existing (non-Foundry) caller -- current behavior unchanged", () => {
    const member = savePartyMember(WORLD, { name: "Legacy Caller", combatRelevant: {}, buildRelevant: {} }, { makeId: () => "pm-legacy" });
    assert.equal(member.status, "accepted");
    assert.equal(member.foundryActorRef, null);
  });

  test("savePartyMember: an explicit status:'proposed' + foundryActorRef round-trips (the Foundry-pull ingest's path)", () => {
    const member = savePartyMember(
      WORLD,
      { name: "Pulled PC", combatRelevant: { hp: 27 }, buildRelevant: {}, foundryActorRef: "Actor.pc001elowen", status: "proposed" },
      { makeId: () => "pm-pulled-1", now: "2026-08-06T00:00:00.000Z" }
    );
    assert.equal(member.status, "proposed");
    assert.equal(member.foundryActorRef, "Actor.pc001elowen");
    const reread = getPartyMember(WORLD, "pm-pulled-1");
    assert.equal(reread.foundryActorRef, "Actor.pc001elowen");
  });

  test("updatePartyMemberFields: overwrites name/combatRelevant/buildRelevant on a still-'proposed' member, preserving id/world/foundryActorRef/status/createdAt", () => {
    const updated = updatePartyMemberFields(WORLD, "pm-pulled-1", {
      name: "Pulled PC (re-synced)",
      combatRelevant: { hp: 30 },
      buildRelevant: { skills: ["Perception"] },
      sourceText: "re-pulled"
    });
    assert.equal(updated.id, "pm-pulled-1");
    assert.equal(updated.foundryActorRef, "Actor.pc001elowen");
    assert.equal(updated.status, "proposed");
    assert.equal(updated.createdAt, "2026-08-06T00:00:00.000Z");
    assert.equal(updated.name, "Pulled PC (re-synced)");
    assert.equal(updated.combatRelevant.hp, 30);
  });

  test("updatePartyMemberFields: NEVER silently overwrites an already-'accepted' member -- refuses with a clear error (the no-silent-auto-write invariant, applied to a re-ingest)", () => {
    const accepted = acceptPartyMember(WORLD, "pm-pulled-1");
    assert.equal(accepted.status, "accepted");
    assert.throws(
      () => updatePartyMemberFields(WORLD, "pm-pulled-1", { name: "Should Not Land", combatRelevant: {}, buildRelevant: {} }),
      /accepted/i
    );
    const reread = getPartyMember(WORLD, "pm-pulled-1");
    assert.equal(reread.name, "Pulled PC (re-synced)", "must still be the value from the last successful update");
  });

  test("acceptPartyMember: proposed -> accepted", () => {
    const member = savePartyMember(WORLD, { name: "To Accept", combatRelevant: {}, buildRelevant: {}, status: "proposed" }, { makeId: () => "pm-to-accept" });
    const updated = acceptPartyMember(WORLD, member.id);
    assert.equal(updated.status, "accepted");
  });

  test("discardPartyMember: refuses to discard an already-accepted member", () => {
    assert.throws(() => discardPartyMember(WORLD, "pm-to-accept"), /accepted/i);
  });

  test("discardPartyMember: a still-'proposed' member discards cleanly", () => {
    const member = savePartyMember(WORLD, { name: "To Discard", combatRelevant: {}, buildRelevant: {}, status: "proposed" }, { makeId: () => "pm-to-discard" });
    const updated = discardPartyMember(WORLD, member.id);
    assert.equal(updated.status, "discarded");
  });

  // -------------------------------------------------------------------------
  // Phase 35 task 35.1, §5 -- passive/conditions (status-independent patch),
  // read-time defaults for a pre-Phase-35 member.
  // -------------------------------------------------------------------------

  const { updatePartyMemberPassive, updatePartyMemberConditions } = await import("../../combat-planning/party-roster-store.mjs");

  test("getPartyMember/listPartyMembers: a pre-Phase-35 member (no passive/conditions on disk) reads passive:null, conditions:''", () => {
    // savePartyMember's own return value is NOT run through the read-time
    // projection (it's a create, not a read boundary) -- assert the
    // projection via getPartyMember/listPartyMembers instead.
    savePartyMember(WORLD, { name: "Legacy Member", combatRelevant: {}, buildRelevant: {} }, { makeId: () => "pm-p35-legacy" });
    const reread = getPartyMember(WORLD, "pm-p35-legacy");
    assert.equal(reread.passive, null);
    assert.equal(reread.conditions, "");
    const inList = listPartyMembers(WORLD).find((m) => m.id === "pm-p35-legacy");
    assert.equal(inList.passive, null);
    assert.equal(inList.conditions, "");
  });

  test("updatePartyMemberPassive/updatePartyMemberConditions: STATUS-INDEPENDENT -- patch an ALREADY-ACCEPTED member successfully", () => {
    assert.equal(getPartyMember(WORLD, "pm-p35-legacy").status, "accepted", "savePartyMember's own default");

    const withPassive = updatePartyMemberPassive(WORLD, "pm-p35-legacy", 18);
    assert.equal(withPassive.passive, 18);
    assert.equal(withPassive.status, "accepted", "status untouched by a passive edit");

    const withConditions = updatePartyMemberConditions(WORLD, "pm-p35-legacy", "Poisoned, Prone");
    assert.equal(withConditions.conditions, "Poisoned, Prone");
    assert.equal(withConditions.status, "accepted", "status untouched by a conditions edit");

    const reread = getPartyMember(WORLD, "pm-p35-legacy");
    assert.equal(reread.passive, 18);
    assert.equal(reread.conditions, "Poisoned, Prone");
  });

  test("updatePartyMemberConditions: an explicit empty string clears conditions back to 'none'", () => {
    const cleared = updatePartyMemberConditions(WORLD, "pm-p35-legacy", "");
    assert.equal(cleared.conditions, "");
  });

  // A Foundry pull names a party row after whatever the actor was called, so
  // rosters drift into player handles standing in for characters, and a row
  // can end up pointing at an actor since deleted in Foundry (a dead ref
  // silently places no token on a pushed scene). Neither was fixable through
  // any existing route -- updatePartyMemberFields is the RE-INGEST path and
  // rightly refuses an accepted row.
  test("relabelPartyMember: renames an ACCEPTED member -- the GM's own edit is not the re-ingest guard's business", () => {
    savePartyMember(WORLD, { name: "Adam", combatRelevant: {}, buildRelevant: {}, foundryActorRef: "Actor.velthar" }, { makeId: () => "pm-relabel-1" });
    assert.throws(
      () => updatePartyMemberFields(WORLD, "pm-relabel-1", { name: "Velthar Starblind" }),
      /Refusing to overwrite/,
      "sanity: the re-ingest path still refuses an accepted row"
    );

    const renamed = relabelPartyMember(WORLD, "pm-relabel-1", { name: "Velthar Starblind" });
    assert.equal(renamed.name, "Velthar Starblind");
    assert.equal(renamed.status, "accepted", "status untouched by a rename");
    assert.equal(renamed.foundryActorRef, "Actor.velthar", "an unmentioned key is left alone");
    assert.equal(getPartyMember(WORLD, "pm-relabel-1").name, "Velthar Starblind");
  });

  test("relabelPartyMember: re-points a member at a different Foundry actor (a ref whose actor was deleted)", () => {
    savePartyMember(WORLD, { name: "Foxy", combatRelevant: {}, buildRelevant: {}, foundryActorRef: "Actor.deletedLongAgo" }, { makeId: () => "pm-relabel-2" });
    const fixed = relabelPartyMember(WORLD, "pm-relabel-2", { name: "Dio", foundryActorRef: "Actor.dioSheet" });
    assert.equal(fixed.name, "Dio");
    assert.equal(fixed.foundryActorRef, "Actor.dioSheet");
    assert.equal(getPartyMember(WORLD, "pm-relabel-2").foundryActorRef, "Actor.dioSheet");
  });

  test("relabelPartyMember: an empty patch and a blank name are both refused", () => {
    savePartyMember(WORLD, { name: "Keep me", combatRelevant: {}, buildRelevant: {} }, { makeId: () => "pm-relabel-3" });
    assert.throws(() => relabelPartyMember(WORLD, "pm-relabel-3", {}), /empty patch/);
    assert.throws(() => relabelPartyMember(WORLD, "pm-relabel-3", { name: "   " }), /non-empty string/);
    assert.equal(getPartyMember(WORLD, "pm-relabel-3").name, "Keep me");
  });

  test("relabelPartyMember: an explicit null ref clears the link without touching the name", () => {
    savePartyMember(WORLD, { name: "Unlinked soon", combatRelevant: {}, buildRelevant: {}, foundryActorRef: "Actor.x" }, { makeId: () => "pm-relabel-4" });
    const cleared = relabelPartyMember(WORLD, "pm-relabel-4", { foundryActorRef: null });
    assert.equal(cleared.foundryActorRef, null);
    assert.equal(cleared.name, "Unlinked soon");
  });

  // Objectives — the GM's card lines. Status-independent, like passive/
  // conditions: a GM typing an objective for an accepted PC IS the human
  // decision, not a re-ingest overwriting one.
  test("objectives: a row written before the field existed reads back [] and is not rewritten", () => {
    savePartyMember(WORLD, { name: "Legacy", combatRelevant: {}, buildRelevant: {} }, { makeId: () => "pm-obj-legacy" });
    const m = getPartyMember(WORLD, "pm-obj-legacy");
    assert.deepEqual(m.objectives, []);
    assert.equal(m.foundryObjectivesRef, null);
    assert.equal(m.objectivesPendingPush, null);
  });

  test("addPartyMemberObjective: appends to an ACCEPTED member (status-independent)", () => {
    savePartyMember(WORLD, { name: "Flint", combatRelevant: {}, buildRelevant: {} }, { makeId: () => "pm-obj-1" });
    assert.equal(getPartyMember(WORLD, "pm-obj-1").status, "accepted", "sanity");

    const m = addPartyMemberObjective(WORLD, "pm-obj-1", "  Take the stage, or leave it.  ",
      { makeId: () => "obj-a", now: "2026-09-11T00:00:00.000Z" });
    assert.equal(m.objectives.length, 1);
    assert.deepEqual(m.objectives[0], {
      id: "obj-a", text: "Take the stage, or leave it.", status: "open",
      createdAt: "2026-09-11T00:00:00.000Z", updatedAt: "2026-09-11T00:00:00.000Z", closedAt: null
    });
    assert.equal(m.status, "accepted", "status untouched by an objective edit");
    assert.throws(() => addPartyMemberObjective(WORLD, "pm-obj-1", "   "), /non-empty string/);
  });

  test("updatePartyMemberObjective: closing stamps closedAt, reopening clears it", () => {
    addPartyMemberObjective(WORLD, "pm-obj-1", "Get paid.", { makeId: () => "obj-b", now: "2026-09-11T00:00:00.000Z" });
    const closed = updatePartyMemberObjective(WORLD, "pm-obj-1", "obj-b", { status: "closed" }, { now: "2026-09-12T00:00:00.000Z" });
    const b = closed.objectives.find((o) => o.id === "obj-b");
    assert.equal(b.status, "closed");
    assert.equal(b.closedAt, "2026-09-12T00:00:00.000Z");

    const reopened = updatePartyMemberObjective(WORLD, "pm-obj-1", "obj-b", { status: "open" }, { now: "2026-09-13T00:00:00.000Z" });
    assert.equal(reopened.objectives.find((o) => o.id === "obj-b").closedAt, null);

    assert.throws(() => updatePartyMemberObjective(WORLD, "pm-obj-1", "nope", { status: "open" }), /No objective found/);
    assert.throws(() => updatePartyMemberObjective(WORLD, "pm-obj-1", "obj-b", { status: "done" }), /"open" or "closed"/);
    assert.throws(() => updatePartyMemberObjective(WORLD, "pm-obj-1", "obj-b", {}), /give `text`, `status`, or both/);
  });

  test("reorderPartyMemberObjectives: reorders, and refuses a mismatched id set", () => {
    const reordered = reorderPartyMemberObjectives(WORLD, "pm-obj-1", ["obj-b", "obj-a"]);
    assert.deepEqual(reordered.objectives.map((o) => o.id), ["obj-b", "obj-a"]);
    assert.throws(() => reorderPartyMemberObjectives(WORLD, "pm-obj-1", ["obj-a"]), /every existing objective exactly once/);
    assert.throws(() => reorderPartyMemberObjectives(WORLD, "pm-obj-1", ["obj-a", "obj-zzz"]), /every existing objective exactly once/);
  });

  test("removePartyMemberObjective / setPartyMemberObjectivesRef round-trip", () => {
    const gone = removePartyMemberObjective(WORLD, "pm-obj-1", "obj-a");
    assert.deepEqual(gone.objectives.map((o) => o.id), ["obj-b"]);
    assert.throws(() => removePartyMemberObjective(WORLD, "pm-obj-1", "obj-a"), /No objective found/);

    const ref = { journalUuid: "JournalEntry.abc", pageId: "p2", lastPushedAt: "2026-09-11T00:00:00.000Z" };
    assert.deepEqual(setPartyMemberObjectivesRef(WORLD, "pm-obj-1", ref).foundryObjectivesRef, ref);
    assert.equal(getPartyMember(WORLD, "pm-obj-1").foundryObjectivesRef.journalUuid, "JournalEntry.abc");
    assert.equal(setPartyMemberObjectivesRef(WORLD, "pm-obj-1", null).foundryObjectivesRef, null);
  });

  console.log(`\n${passed} passed`);
})();

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
