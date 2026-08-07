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
    updatePartyMemberFields
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

  console.log(`\n${passed} passed`);
})();

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
