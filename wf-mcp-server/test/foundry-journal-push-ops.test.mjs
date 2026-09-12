import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

/**
 * CONTRACT UNDER TEST — wf-mcp-server/lib/foundry-journal-push-ops.mjs (v6).
 *
 * The properties worth pinning here are the ones that protect a live world:
 * an update names ONLY the Objectives page, a create is refused when the
 * player already has a journal (the duplicate-journal trap), an ambiguous
 * actor->user join throws rather than guessing whose card it is, and a ref is
 * written only on a confirmed ok:true.
 *
 * Same hand-rolled harness + scratch-env-before-import convention as
 * foundry-item-push-ops.test.mjs.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-foundry-journal-push-ops-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
const dataDir = join(scratchDir, "foundrydata");

const {
  pushPartyObjectivesToFoundry, adoptPartyObjectivesJournal, reconcilePendingObjectivesResults,
  renderObjectivesHtml, composeObjectivesOwnership, buildObjectivesJournalOp, findObjectivesJournal
} = await import("../lib/foundry-journal-push-ops.mjs");
const { foundryOpsPath, foundryResultsPath } = await import("../lib/snapshot.mjs");
const {
  savePartyMember, getPartyMember, addPartyMemberObjective, setPartyMemberObjectivesRef
} = await import("../../combat-planning/party-roster-store.mjs");

let passed = 0;
async function test(name, fn) {
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

function seedFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2), "utf8");
}
function armFakeWatcher(world, results, delayMs = 20) {
  const opsPath = foundryOpsPath(dataDir, world);
  return setTimeout(() => {
    seedFile(foundryResultsPath(dataDir, world), Array.isArray(results) ? results : [results]);
    writeFileSync(opsPath, "[]", "utf8");
  }, delayMs);
}
const PLAYER = "uuuuuuuuuuuuuuuu";
const GM = "gggggggggggggggg";
function seedIndex(world, journals = []) {
  seedFile(join(dataDir, "worlds", world, "world-fabric-foundry-index.json"), {
    version: 1, worldId: world,
    users: [
      { id: PLAYER, name: "torok", role: 1, characterUuid: "Actor.flint" },
      { id: GM, name: "Gamemaster", role: 4, characterUuid: null }
    ],
    journals
  });
}
function seedMember(world, id, extra = {}) {
  savePartyMember(world, { name: "Flint", combatRelevant: {}, buildRelevant: {}, foundryActorRef: "Actor.flint", ...extra }, { makeId: () => id });
  return id;
}

// ── pure ────────────────────────────────────────────────────────────────────

await test("renderObjectivesHtml: open list, a Done block for closed, words for empty, and escaping", () => {
  assert.equal(renderObjectivesHtml([]), "<p><em>Nothing set yet.</em></p>");
  assert.equal(
    renderObjectivesHtml([{ text: "Take the stage, or leave it.", status: "open" }]),
    "<ol><li>Take the stage, or leave it.</li></ol>"
  );
  const mixed = renderObjectivesHtml([
    { text: "Get paid.", status: "open" },
    { text: "Destroy the charm.", status: "closed" }
  ]);
  assert.match(mixed, /<ol><li>Get paid\.<\/li><\/ol>/);
  assert.match(mixed, /<h3>Done<\/h3>/);
  assert.match(mixed, /<s>Destroy the charm\.<\/s>/);
  assert.match(renderObjectivesHtml([{ text: "<script>x</script>", status: "open" }]), /&lt;script&gt;/);
});

await test("composeObjectivesOwnership: player at OWNER, every GM at OWNER, nobody by default", () => {
  const index = { users: [{ id: PLAYER, role: 1, characterUuid: "Actor.flint" }, { id: GM, role: 4 }] };
  const { ownership, playerUserId } = composeObjectivesOwnership({ name: "Flint", foundryActorRef: "Actor.flint" }, index);
  assert.deepEqual(ownership, { default: 0, [PLAYER]: 3, [GM]: 3 });
  assert.equal(playerUserId, PLAYER);
});

await test("composeObjectivesOwnership: refuses rather than guessing whose card it is", () => {
  const index = { users: [{ id: PLAYER, role: 1, characterUuid: "Actor.flint" }] };
  assert.throws(() => composeObjectivesOwnership({ name: "Mule" }, index), /no linked Foundry actor/);
  assert.throws(() => composeObjectivesOwnership({ name: "X", foundryActorRef: "Actor.nobody" }, index), /No Foundry user has/);
  const twin = { users: [{ id: PLAYER, role: 1, characterUuid: "Actor.flint" }, { id: "aaaaaaaaaaaaaaaa", role: 1, characterUuid: "Actor.flint" }] };
  assert.throws(() => composeObjectivesOwnership({ name: "X", foundryActorRef: "Actor.flint" }, twin), /2 Foundry users claim/);
});

await test("buildObjectivesJournalOp: an update names ONE page and never the player's", () => {
  const index = { users: [{ id: PLAYER, role: 1, characterUuid: "Actor.flint" }, { id: GM, role: 4 }] };
  const member = {
    name: "Flint", foundryActorRef: "Actor.flint",
    objectives: [{ id: "o1", text: "Take the stage.", status: "open" }],
    foundryObjectivesRef: { journalUuid: "JournalEntry.x", pageId: "p2" }
  };
  const op = buildObjectivesJournalOp(member, { index });
  assert.equal(op.kind, "update_journal");
  assert.equal(op.data.journalUuid, "JournalEntry.x");
  assert.equal(op.data.pages.length, 1, "exactly one page -- an unnamed page cannot be touched");
  assert.equal(op.data.pages[0].name, "Objectives");
  assert.equal(op.data.pages[0].pageId, "p2");
  assert.ok(!JSON.stringify(op).includes("Your wants"), "the player's page is never mentioned");
});

await test("buildObjectivesJournalOp: a create makes three pages, and only the player's inherits OWNER", () => {
  const index = { users: [{ id: PLAYER, role: 1, characterUuid: "Actor.flint" }, { id: GM, role: 4 }] };
  const op = buildObjectivesJournalOp({
    name: "Flint", foundryActorRef: "Actor.flint", objectives: [], foundryObjectivesRef: null
  }, { index, tonight: "The Gleam is dead." });

  assert.equal(op.kind, "create_journal");
  assert.deepEqual(op.data.pages.map((p) => p.name), ["Tonight", "Objectives", "Your wants"]);
  assert.deepEqual(op.data.pages[0].ownership, { [PLAYER]: 2 }, "GM pages are read-only to the player");
  assert.deepEqual(op.data.pages[1].ownership, { [PLAYER]: 2 });
  assert.equal(op.data.pages[2].ownership, undefined, "the player's page inherits OWNER from the entry");
  assert.equal(op.data.bridgeKind, "objectives");
});

await test("findObjectivesJournal: matches on name plus this player's OWNER grant", () => {
  const journals = [
    { uuid: "JournalEntry.a", name: "Objectives", ownership: { default: 0, aaaaaaaaaaaaaaaa: 3 } },
    { uuid: "JournalEntry.b", name: "Objectives", ownership: { default: 0, [PLAYER]: 3 } },
    { uuid: "JournalEntry.c", name: "Notes", ownership: { default: 0, [PLAYER]: 3 } }
  ];
  assert.equal(findObjectivesJournal({ journals }, PLAYER).uuid, "JournalEntry.b");
  assert.equal(findObjectivesJournal({ journals }, "zzzzzzzzzzzzzzzz"), null);
});

// ── push ────────────────────────────────────────────────────────────────────

await test("push: THE DUPLICATE TRAP -- refuses to create when the player already has a journal", async () => {
  const WORLD = "journal-dupe-world";
  const id = seedMember(WORLD, "pm-dupe");
  addPartyMemberObjective(WORLD, id, "Take the stage.");
  seedIndex(WORLD, [{ uuid: "JournalEntry.theirs", name: "Objectives", ownership: { default: 0, [PLAYER]: 3 }, pages: [] }]);

  await assert.rejects(
    () => pushPartyObjectivesToFoundry(dataDir, WORLD, id, { pollMs: 5, timeoutMs: 20 }),
    /already exists in Foundry .* adopt it first/
  );
  assert.equal(getPartyMember(WORLD, id).foundryObjectivesRef, null, "nothing written");
});

await test("adopt: writes the ref, fills pageId from the index, and emits NO op", async () => {
  const WORLD = "journal-adopt-world";
  const id = seedMember(WORLD, "pm-adopt");
  seedIndex(WORLD, [{
    uuid: "JournalEntry.theirs", name: "Objectives", ownership: { default: 0, [PLAYER]: 3 },
    pages: [{ id: "pg1", name: "Tonight" }, { id: "pg2", name: "Objectives" }]
  }]);

  const out = adoptPartyObjectivesJournal(dataDir, WORLD, id, "JournalEntry.theirs");
  assert.equal(out.adopted, true);
  assert.equal(out.pageId, "pg2");
  const m = getPartyMember(WORLD, id);
  assert.equal(m.foundryObjectivesRef.journalUuid, "JournalEntry.theirs");
  assert.equal(m.foundryObjectivesRef.pageId, "pg2");

  let opsWritten = true;
  try { readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"); } catch { opsWritten = false; }
  assert.equal(opsWritten, false, "adopt must not touch the ops channel");

  assert.throws(() => adoptPartyObjectivesJournal(dataDir, WORLD, id, "JournalEntry.nope"), /reload the Foundry client/);
});

await test("push: applied ok:true writes the ref; the op on disk is the update shape", async () => {
  const WORLD = "journal-applied-world";
  const id = seedMember(WORLD, "pm-ok");
  addPartyMemberObjective(WORLD, id, "Take the stage, or leave it.");
  seedIndex(WORLD, []);
  setPartyMemberObjectivesRef(WORLD, id, { journalUuid: "JournalEntry.x", pageId: "p2", lastPushedAt: null });

  let captured = null;
  const t = setTimeout(() => {
    captured = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"));
    seedFile(foundryResultsPath(dataDir, WORLD), [{ opId: "op_j_ok", ok: true, foundryUuid: "JournalEntry.x" }]);
    writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8");
  }, 20);

  const result = await pushPartyObjectivesToFoundry(dataDir, WORLD, id, { pollMs: 5, timeoutMs: 500, makeOpId: () => "op_j_ok" });
  clearTimeout(t);

  assert.equal(result.status, "applied");
  assert.equal(result.ok, true);
  assert.equal(captured[0].kind, "update_journal");
  assert.equal(captured[0].data.pages.length, 1);
  assert.equal(captured[0].data.pages[0].name, "Objectives");
  assert.match(captured[0].data.pages[0].html, /Take the stage, or leave it\./);
  assert.equal(getPartyMember(WORLD, id).foundryObjectivesRef.lastPushedAt !== null, true);
});

await test("push: an ok:false result leaves the ref's lastPushedAt untouched", async () => {
  const WORLD = "journal-failed-world";
  const id = seedMember(WORLD, "pm-fail");
  addPartyMemberObjective(WORLD, id, "x");
  seedIndex(WORLD, []);
  setPartyMemberObjectivesRef(WORLD, id, { journalUuid: "JournalEntry.y", pageId: null, lastPushedAt: null });

  const t = armFakeWatcher(WORLD, { opId: "op_j_fail", ok: false, error: "does not resolve to a JournalEntry" });
  const result = await pushPartyObjectivesToFoundry(dataDir, WORLD, id, { pollMs: 5, timeoutMs: 500, makeOpId: () => "op_j_fail" });
  clearTimeout(t);

  assert.equal(result.ok, false);
  assert.match(result.error, /does not resolve/);
  assert.equal(getPartyMember(WORLD, id).foundryObjectivesRef.lastPushedAt, null, "a failed push never stamps a ref");
});

await test("push: queued ledgers the op and writes no ref; reconcile consumes the late result", async () => {
  const WORLD = "journal-queued-world";
  const id = seedMember(WORLD, "pm-queued");
  addPartyMemberObjective(WORLD, id, "x");
  seedIndex(WORLD, []);
  setPartyMemberObjectivesRef(WORLD, id, { journalUuid: "JournalEntry.z", pageId: null, lastPushedAt: null });

  const result = await pushPartyObjectivesToFoundry(dataDir, WORLD, id, { pollMs: 5, timeoutMs: 20, makeOpId: () => "op_j_q" });
  assert.equal(result.status, "queued");
  assert.equal(getPartyMember(WORLD, id).objectivesPendingPush.opId, "op_j_q");
  assert.equal(getPartyMember(WORLD, id).foundryObjectivesRef.lastPushedAt, null);

  // a second push while one is in flight is refused
  await assert.rejects(() => pushPartyObjectivesToFoundry(dataDir, WORLD, id, { pollMs: 5, timeoutMs: 20 }), /already has an objectives push in flight/);

  // the late result lands, plus an unrelated sibling result that must survive
  seedFile(foundryResultsPath(dataDir, WORLD), [
    { opId: "op_someone_else", ok: true, foundryUuid: "Item.other" },
    { opId: "op_j_q", ok: true, foundryUuid: "JournalEntry.z" }
  ]);
  assert.equal(reconcilePendingObjectivesResults(dataDir, WORLD, id), 1);
  const m = getPartyMember(WORLD, id);
  assert.equal(m.objectivesPendingPush, null);
  assert.notEqual(m.foundryObjectivesRef.lastPushedAt, null);

  const survivors = JSON.parse(readFileSync(foundryResultsPath(dataDir, WORLD), "utf8"));
  assert.deepEqual(survivors.map((r) => r.opId), ["op_someone_else"], "a sibling producer's late result is never clobbered");
  writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8");
});

await test("push: a member with no objectives is refused", async () => {
  const WORLD = "journal-empty-world";
  const id = seedMember(WORLD, "pm-empty");
  seedIndex(WORLD, []);
  await assert.rejects(() => pushPartyObjectivesToFoundry(dataDir, WORLD, id, { pollMs: 5, timeoutMs: 20 }), /no objectives to push/);
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
