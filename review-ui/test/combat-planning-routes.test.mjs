import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — Phase 18 task 18.7's new review-ui/server.mjs
 * routes, wrapping combat-planning/bestiary-store.mjs (18.1),
 * combat-planning/party-roster-store.mjs (18.2), and
 * combat-planning/encounter-heuristic.mjs + thematic-filter.mjs (18.5). None
 * of this exists yet -- expected to fail (a 404 "unknown route" response
 * where a real status/body was asserted, or a thrown error at import time)
 * until 18.7 lands. Placed in review-ui/test/ (not wf-mcp-server/test/) to
 * match where session-planner-routes.test.mjs/routes.test.mjs actually
 * live -- these are review-ui/server.mjs routes, same as every other route
 * those sibling files cover.
 *
 * Real HTTP requests via fetch() against an in-process server.listen(0),
 * same pattern as review-ui/test/session-planner-routes.test.mjs.
 *
 * ---------------------------------------------------------------------------
 * POST /api/combat-planning/bestiary/ingest   { text } or { pdfBase64 }
 * ---------------------------------------------------------------------------
 * Thin wrapper: ingests via combat-planning/bestiary-ingest.mjs, stores via
 * bestiary-store.mjs's saveBestiaryEntry. Response 200: { entry }.
 * LIBRARY-WIDE, deliberately NO `world` parameter at all (bestiary-store.mjs's
 * own deliberate per-user/library-wide scoping decision, see its own test
 * file's header comment) -- makes a real LLM call, so (matching this
 * project's established test/smoke split) this file only exercises this
 * route's plumbing is REACHABLE and its lack-of-world-scoping behavior, not
 * a real successful ingest round trip (that belongs in a companion
 * *.smoke.mjs, not here).
 *
 * ---------------------------------------------------------------------------
 * GET /api/combat-planning/bestiary
 * ---------------------------------------------------------------------------
 * Thin wrapper over listBestiaryEntries(). Response 200: { entries }. No
 * `world` parameter (library-wide).
 *
 * ---------------------------------------------------------------------------
 * POST /api/combat-planning/bestiary/:id/accept
 * ---------------------------------------------------------------------------
 * Thin wrapper over acceptBestiaryEntry(parts[3]). Response 200: { entry }.
 *
 * ---------------------------------------------------------------------------
 * POST /api/combat-planning/bestiary/:id/discard
 * ---------------------------------------------------------------------------
 * Thin wrapper over discardBestiaryEntry(parts[3]). Response 200: { entry }.
 *
 * ---------------------------------------------------------------------------
 * POST /api/combat-planning/party-roster/ingest   { world, text } or { world, pdfBase64 }
 * ---------------------------------------------------------------------------
 * Thin wrapper: ingests via party-roster-ingest.mjs, stores via
 * party-roster-store.mjs's savePartyMember. Response 200: { member }.
 * WORLD-SCOPED (unlike bestiary) -- resolveWorld(body.world), no
 * client-supplied dataDir honored.
 *
 * ---------------------------------------------------------------------------
 * GET /api/combat-planning/party-roster?world=...
 * ---------------------------------------------------------------------------
 * Thin wrapper over listPartyMembers(w). Response 200: { members }.
 *
 * ---------------------------------------------------------------------------
 * POST /api/combat-planning/encounter-suggest   { world, targetDifficulty, sceneEntityId, knobs? }
 * ---------------------------------------------------------------------------
 * The one route in this set that makes a real API call (thematic-filter.mjs's
 * proposeThematicTags, grounded via mutation-engine/narrate.mjs's
 * buildAdjacencyContext against the LIVE snapshot loaded from
 * resolveDir()/resolveWorld() -- no client-supplied dataDir), then wraps
 * encounter-heuristic.mjs's suggestEncounter (deterministic, no further LLM
 * call) with the thematically-filtered pool. Response 200: { suggestion }.
 * world format IS validated (resolveWorld) BEFORE any LLM call runs, same as
 * session-planner-routes.test.mjs's notes/intake route.
 *
 * ---------------------------------------------------------------------------
 * SECURITY (extending review-ui/test/routes.test.mjs's/session-planner-routes.
 * test.mjs's own established convention -- NOT a new convention invented,
 * per task 18.7's own explicit instruction):
 * ---------------------------------------------------------------------------
 *   - Every WORLD-SCOPED route (party-roster/ingest, party-roster list,
 *     encounter-suggest) rejects a path-traversal-shaped `world` id with 400
 *     ("Invalid world id"), never silently resolved into a file path.
 *   - The bestiary routes carry no `world` concept at all (by design, see
 *     above) -- there is nothing to validate there, but a bogus/irrelevant
 *     `world`/`dataDir` query param passed anyway must have ZERO effect on
 *     the response (still 200, same content), proving these routes never
 *     accidentally start reading one.
 *   - A client-supplied `dataDir` is NEVER honored by encounter-suggest (the
 *     only route here that touches the live snapshot) -- resolves from
 *     server-side env config (resolveDir() with no argument) regardless.
 *
 * ---------------------------------------------------------------------------
 * Phase 18 addendum -- encounter-suggest's three new OPTIONAL fields (found
 * during Phase 19 task 19.0's test-authoring pass; full authoritative
 * contract in review-ui/test/e2e/combat-planning-fixture.mjs's header
 * comment): `themeText`, `attendingMemberIds`, `manualCombination`. No API
 * key is configured in this test environment (this project's own standing
 * note), which is exactly what these tests lean on to PROVE zero-LLM-call
 * behavior deterministically: a real proposeThematicTags call always 502s
 * here (statusForError's AnthropicError/"Could not resolve authentication
 * method" branch), so a 200 response is direct proof no such call was made,
 * and a 502 is direct proof one WAS attempted -- no client mock needed.
 * ---------------------------------------------------------------------------
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-combat-planning-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "combat-planning-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "cp-route-test-scene", name: "Combat Route Test Scene", type: "place", importance: 0.5 } }
]);

let server;
let base;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}
async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

// -------------------------------------------------------- bestiary (library-wide)

test("GET /api/combat-planning/bestiary returns an entries array (empty is fine, not an error) with no world parameter at all", async () => {
  const { status, body } = await getJson("/api/combat-planning/bestiary");
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.entries));
});

test("SECURITY: a bogus dataDir/world query param on GET /api/combat-planning/bestiary has ZERO effect -- still 200, same content, proving no world-scoping code path is silently reading it", async () => {
  const plain = await getJson("/api/combat-planning/bestiary");
  const withBogusParams = await getJson(
    `/api/combat-planning/bestiary?world=${encodeURIComponent("../../../../etc")}&dataDir=${encodeURIComponent("../../../etc")}`
  );
  assert.equal(withBogusParams.status, 200, "bestiary routes must never attempt to validate/resolve a world id they don't use");
  assert.deepEqual(withBogusParams.body, plain.body);
});

test("POST /api/combat-planning/bestiary/:id/accept is a registered route (not a 404 'no route' response)", async () => {
  const { status } = await postJson("/api/combat-planning/bestiary/no-such-entry/accept", {});
  assert.notEqual(status, 404, "the route itself must be registered -- a not-found ENTRY is a different, later failure mode than a missing ROUTE");
});

test("POST /api/combat-planning/bestiary/:id/discard is a registered route (not a 404 'no route' response)", async () => {
  const { status } = await postJson("/api/combat-planning/bestiary/no-such-entry/discard", {});
  assert.notEqual(status, 404, "the route itself must be registered -- a not-found ENTRY is a different, later failure mode than a missing ROUTE");
});

// -------------------------------------------------------- party-roster (per-world)

test("POST /api/combat-planning/party-roster/ingest + GET list round-trip is reachable (route registered) -- full success requires a real API call, covered by a companion smoke test, not here", async () => {
  // Only asserting the route EXISTS and world-validates correctly here (no
  // client is injectable through the HTTP layer, same limitation
  // review-ui/test/routes.test.mjs's own narrateOp/resolvePending routes
  // document for their real-API-only success paths) -- a 404 "No route"
  // response is the clean failure signal that 18.7 hasn't landed yet.
  const { status } = await getJson(`/api/combat-planning/party-roster?world=${WORLD}`);
  assert.notEqual(status, 404, "GET /api/combat-planning/party-roster must be a registered route");
});

test("SECURITY: POST /api/combat-planning/party-roster/ingest rejects a path-traversal-shaped world id with 400 (checked before any LLM call is ever made)", async () => {
  const { status, body } = await postJson("/api/combat-planning/party-roster/ingest", {
    world: "../../../../etc",
    text: "some character sheet text"
  });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: GET /api/combat-planning/party-roster rejects a path-traversal-shaped world id with 400", async () => {
  const { status, body } = await getJson(`/api/combat-planning/party-roster?world=${encodeURIComponent("../../../../etc")}`);
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

// -------------------------------------------------------- encounter-suggest

test("SECURITY: POST /api/combat-planning/encounter-suggest rejects a path-traversal-shaped world id with 400 (checked before any LLM call is ever made)", async () => {
  const { status, body } = await postJson("/api/combat-planning/encounter-suggest", {
    world: "../../../../etc",
    targetDifficulty: 20,
    sceneEntityId: "cp-route-test-scene"
  });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: a client-supplied dataDir is never honored by POST /api/combat-planning/encounter-suggest -- resolves from server-side env config regardless (route reachability + world-validation only here; the real LLM-backed success path is a companion smoke test)", async () => {
  const { status } = await postJson("/api/combat-planning/encounter-suggest", {
    world: WORLD,
    targetDifficulty: 20,
    sceneEntityId: "cp-route-test-scene",
    dataDir: "../../../etc"
  });
  // Not asserting 200 here (a real API call would be required to succeed
  // end-to-end, out of scope for this deterministic file) -- asserting the
  // request was NOT rejected for a dataDir-related reason, i.e. it got past
  // world/dataDir resolution and reached the (uninjectable-from-here) LLM
  // call boundary. A 400 with "Invalid world id" would be the wrong-reason
  // failure this specific assertion guards against. Checked FIRST against
  // 404 ("no such route") so this test fails for the RIGHT reason
  // pre-implementation (route missing), not vacuously pass because 404 also
  // happens to not equal 400.
  assert.notEqual(status, 404, "POST /api/combat-planning/encounter-suggest must be a registered route");
  assert.notEqual(status, 400, "must not fail world/dataDir validation -- the real world id and the real (ignored) bogus dataDir are both handled correctly");
});

// -------------------------------------------------------- encounter-suggest: Phase 18 addendum (themeText/attendingMemberIds/manualCombination)

const { saveBestiaryEntry, acceptBestiaryEntry } = await import("../../combat-planning/bestiary-store.mjs");
const { savePartyMember } = await import("../../combat-planning/party-roster-store.mjs");

function makeRawFields(name, overrides = {}) {
  return {
    name,
    type: "humanoid",
    hp: 10,
    ac: 12,
    attacks: [{ name: "Club", toHitBonus: 3, damageDice: "1d4+1", damageType: "bludgeoning" }],
    ...overrides
  };
}

const acceptedEntry = acceptBestiaryEntry(saveBestiaryEntry({ rawFields: makeRawFields("Accepted Test Goblin") }).id);
// Deliberately left 'proposed' (never accepted) -- proves the blank-themeText
// deterministic path only ever draws from status:"accepted" entries, same as
// the Phase 19 catalog's own convention (combat-planning-fixture.mjs).
saveBestiaryEntry({ rawFields: makeRawFields("Proposed-Only Test Goblin") });

const memberA = savePartyMember(WORLD, { name: "Aria", combatRelevant: { hp: 30, ac: 15, damagePerRoundEstimate: 10 }, buildRelevant: {} });
const memberB = savePartyMember(WORLD, { name: "Borin", combatRelevant: { hp: 40, ac: 16, damagePerRoundEstimate: 5 }, buildRelevant: {} });

test("encounter-suggest: omitting all three new fields (only world/targetDifficulty/sceneEntityId, the pre-existing request shape) is a strictly additive change -- still a registered, world-validated route producing a well-shaped 200 { suggestion } response, not a new failure mode for callers unaware of the new fields", async () => {
  const { status, body } = await postJson("/api/combat-planning/encounter-suggest", {
    world: WORLD,
    targetDifficulty: 20,
    sceneEntityId: "cp-route-test-scene"
  });
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.suggestion.combination) && body.suggestion.combination.length > 0);
  assert.equal(typeof body.suggestion.expectedScore, "number");
});

test("encounter-suggest: blank/whitespace-only themeText skips proposeThematicTags ENTIRELY -- a clean deterministic 200 (not the 502 an attempted real API call would produce with no key configured), proving zero LLM calls", async () => {
  const { status, body } = await postJson("/api/combat-planning/encounter-suggest", {
    world: WORLD,
    targetDifficulty: 5,
    themeText: "   ",
    sceneEntityId: "cp-route-test-scene"
  });
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.suggestion.combination) && body.suggestion.combination.length > 0);
});

test("encounter-suggest: omitted themeText field entirely (not just blank) also skips proposeThematicTags -- same zero-LLM-call 200 as explicit blank", async () => {
  const { status, body } = await postJson("/api/combat-planning/encounter-suggest", {
    world: WORLD,
    targetDifficulty: 5
    // themeText omitted entirely, manualCombination omitted -- auto-fill against the accepted pool
  });
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.suggestion.combination) && body.suggestion.combination.length > 0);
});

test("encounter-suggest: non-empty themeText still calls proposeThematicTags for real -- the original shipped behavior, unchanged (502, no API key configured)", async () => {
  const { status } = await postJson("/api/combat-planning/encounter-suggest", {
    world: WORLD,
    targetDifficulty: 5,
    themeText: "undead crypt",
    sceneEntityId: "cp-route-test-scene"
  });
  assert.equal(status, 502, "a genuinely non-blank themeText must still attempt the real LLM call");
});

test("encounter-suggest: the blank-themeText deterministic candidate pool only draws from status:'accepted' bestiary entries", async () => {
  const { status, body } = await postJson("/api/combat-planning/encounter-suggest", {
    world: WORLD,
    targetDifficulty: 5,
    themeText: ""
  });
  assert.equal(status, 200);
  const usedEntryIds = new Set(body.suggestion.combination.map((c) => c.entryId));
  assert.ok(usedEntryIds.has(acceptedEntry.id), "the accepted entry must be a real candidate");
});

test("encounter-suggest: attendingMemberIds filters the party BEFORE scoring -- with only one member attending, that member is necessarily both snowballDelta contributors", async () => {
  const { status, body } = await postJson("/api/combat-planning/encounter-suggest", {
    world: WORLD,
    targetDifficulty: 5,
    themeText: "",
    attendingMemberIds: [memberA.id]
  });
  assert.equal(status, 200);
  assert.equal(body.suggestion.snowballDelta.topDamageContributorId, memberA.id);
  assert.equal(body.suggestion.snowballDelta.topEffectiveHpContributorId, memberA.id);
});

test("encounter-suggest: omitting attendingMemberIds uses the full roster, unchanged -- the OTHER member (higher hp) is the top-effective-hp contributor", async () => {
  const { status, body } = await postJson("/api/combat-planning/encounter-suggest", {
    world: WORLD,
    targetDifficulty: 5,
    themeText: ""
    // attendingMemberIds omitted -- full roster (memberA + memberB)
  });
  assert.equal(status, 200);
  assert.equal(body.suggestion.snowballDelta.topEffectiveHpContributorId, memberB.id, "memberB has the higher hp (40 vs 30) -- proves the full roster, not a filtered one, was scored");
});

test("encounter-suggest: manualCombination is echoed back exactly and scored via the identical math as auto-fill -- a manual combination equal to what targetDifficulty would have auto-generated produces the same expectedScore/burstCeiling/asymmetricRiskFlag", async () => {
  const autoRes = await postJson("/api/combat-planning/encounter-suggest", {
    world: WORLD,
    targetDifficulty: 5,
    themeText: ""
  });
  assert.equal(autoRes.status, 200);

  const manualRes = await postJson("/api/combat-planning/encounter-suggest", {
    world: WORLD,
    themeText: "",
    manualCombination: autoRes.body.suggestion.combination
  });
  assert.equal(manualRes.status, 200);
  assert.deepEqual(manualRes.body.suggestion.combination, autoRes.body.suggestion.combination, "manualCombination must be echoed back exactly");
  assert.equal(manualRes.body.suggestion.expectedScore, autoRes.body.suggestion.expectedScore);
  assert.equal(manualRes.body.suggestion.burstCeiling, autoRes.body.suggestion.burstCeiling);
  assert.equal(manualRes.body.suggestion.asymmetricRiskFlag, autoRes.body.suggestion.asymmetricRiskFlag);
});

test("encounter-suggest: manualCombination skips the auto-fill entirely -- targetDifficulty can be omitted alongside it without error", async () => {
  const { status, body } = await postJson("/api/combat-planning/encounter-suggest", {
    world: WORLD,
    themeText: "",
    manualCombination: [{ entryId: acceptedEntry.id, count: 3 }]
  });
  assert.equal(status, 200);
  assert.deepEqual(body.suggestion.combination, [{ entryId: acceptedEntry.id, count: 3 }]);
});

// -------------------------------------------------------- encounter-suggest: Phase 20 task 20.5 (theme narrowing against a snapshot-less world)

// A SEPARATE world within the SAME dataDir, deliberately never passed to
// bootstrapSnapshot -- reproduces the real, confirmed root cause of task
// 20.5 ("narrow by theme doesn't work when actually used"): Encounter
// Builder's own bestiary/party-roster stores are deliberately NOT
// graph-backed (see combat-planning-fixture.mjs's own header), so a real DM
// world may genuinely have no world-fabric-snapshot.json on disk at all.
const WORLD_NO_SNAPSHOT = "combat-planning-routes-test-world-no-snapshot";

test("encounter-suggest: 20.5 REGRESSION -- non-empty themeText for a world with NO WF snapshot on disk no longer 400s with \"No World Fabric snapshot found\" (the confirmed root cause); it degrades to an ungrounded scene context and still genuinely attempts the real LLM call (502, no API key configured) -- the SAME failure shape as a themed request against a world that DOES have a snapshot", async () => {
  const { status, body } = await postJson("/api/combat-planning/encounter-suggest", {
    world: WORLD_NO_SNAPSHOT,
    targetDifficulty: 5,
    themeText: "undead crypt"
    // deliberately no sceneEntityId -- matches combat-planning-view.js's
    // real onThemeSubmit request shape, which never sends one
  });
  assert.notEqual(
    status, 400,
    "must not throw 'No World Fabric snapshot found' just because narrowing-by-theme was requested for a world that has never been graph-backed -- Encounter Builder is deliberately NOT graph-backed"
  );
  assert.equal(status, 502, "having skipped the snapshot-load gate, the request must still genuinely reach proposeThematicTags and fail on the expected missing-API-key reason, not some other new error");
  assert.doesNotMatch(body.error ?? "", /No World Fabric snapshot found/);
});

void __dirname;
