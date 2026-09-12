import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — the v6 journal/objectives routes in review-ui/server.mjs.
 *
 * Real HTTP against an in-process server.listen(0), same pattern as
 * foundry-push-routes.test.mjs — including its mandatory world-traversal
 * security case on every new route.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-foundry-journal-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "foundry-journal-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { foundryOpsPath, foundryResultsPath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { savePartyMember, getPartyMember } = await import("../../combat-planning/party-roster-store.mjs");
const { createReviewServer } = await import("../server.mjs");

const PLAYER = "uuuuuuuuuuuuuuuu";
const GM = "gggggggggggggggg";
let server, base;

function seedFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2), "utf8");
}

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  seedFile(join(dataDir, "worlds", WORLD, "world-fabric-foundry-index.json"), {
    version: 1, worldId: WORLD,
    users: [
      { id: PLAYER, name: "torok", role: 1, characterUuid: "Actor.flint" },
      { id: GM, name: "Gamemaster", role: 4, characterUuid: null }
    ],
    journals: [{
      uuid: "JournalEntry.theirs", name: "Objectives",
      ownership: { default: 0, [PLAYER]: 3, [GM]: 3 },
      pages: [{ id: "pg1", name: "Tonight" }, { id: "pg2", name: "Objectives" }, { id: "pg3", name: "Your wants" }]
    }]
  });
  savePartyMember(WORLD, { name: "Flint", combatRelevant: {}, buildRelevant: {}, foundryActorRef: "Actor.flint" }, { makeId: () => "pm-route" });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

async function req(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: res.status, body: await res.json() };
}
const postJson = (p, b) => req("POST", p, b);

test("objectives CRUD: add, patch, reorder, delete", async () => {
  const added = await postJson("/api/combat-planning/party-roster/pm-route/objectives", { world: WORLD, text: "Take the stage, or leave it." });
  assert.equal(added.status, 200);
  assert.equal(added.body.member.objectives.length, 1);
  const first = added.body.member.objectives[0].id;

  const second = await postJson("/api/combat-planning/party-roster/pm-route/objectives", { world: WORLD, text: "Operate unnoticed." });
  const secondId = second.body.member.objectives[1].id;

  const closed = await postJson(`/api/combat-planning/party-roster/pm-route/objectives/${first}`, { world: WORLD, status: "closed" });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.member.objectives.find((o) => o.id === first).status, "closed");

  const reordered = await postJson("/api/combat-planning/party-roster/pm-route/objectives-reorder", { world: WORLD, objectiveIds: [secondId, first] });
  assert.deepEqual(reordered.body.member.objectives.map((o) => o.id), [secondId, first]);

  const gone = await req("DELETE", `/api/combat-planning/party-roster/pm-route/objectives/${first}`, { world: WORLD });
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.body.member.objectives.map((o) => o.id), [secondId]);
});

test("objectives CRUD: empty text is a 400, not an empty line on a card", async () => {
  const r = await postJson("/api/combat-planning/party-roster/pm-route/objectives", { world: WORLD, text: "   " });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /non-empty text/);
});

test("GET /api/foundry/journals returns the index's journals for the adopt picker", async () => {
  const res = await fetch(`${base}/api/foundry/journals?world=${WORLD}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.journals.length, 1);
  assert.equal(body.journals[0].uuid, "JournalEntry.theirs");
});

test("adopt: points the member at an existing journal and writes no op", async () => {
  const r = await postJson("/api/foundry/adopt-party-objectives", { world: WORLD, memberId: "pm-route", journalUuid: "JournalEntry.theirs" });
  assert.equal(r.status, 200);
  assert.equal(r.body.pageId, "pg2");
  assert.equal(getPartyMember(WORLD, "pm-route").foundryObjectivesRef.journalUuid, "JournalEntry.theirs");

  let wrote = true;
  try { readFileSync(foundryOpsPath(dataDir, WORLD), "utf8"); } catch { wrote = false; }
  assert.equal(wrote, false, "adopt never touches the ops channel");
});

test("adopt: a journal the index has never seen is a 400 naming the fix", async () => {
  const r = await postJson("/api/foundry/adopt-party-objectives", { world: WORLD, memberId: "pm-route", journalUuid: "JournalEntry.ghost" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /reload the Foundry client/);
});

test("push-party-objectives: applied, and the op names only the Objectives page", async () => {
  let captured = null;
  const watcher = setInterval(() => {
    let ops;
    try { ops = JSON.parse(readFileSync(foundryOpsPath(dataDir, WORLD), "utf8")); } catch { return; }
    if (!Array.isArray(ops) || !ops.length) return;
    captured = ops;
    seedFile(foundryResultsPath(dataDir, WORLD), [{ opId: ops[0].opId, ok: true, foundryUuid: "JournalEntry.theirs" }]);
    writeFileSync(foundryOpsPath(dataDir, WORLD), "[]", "utf8");
    clearInterval(watcher);
  }, 20);

  const r = await postJson("/api/foundry/push-party-objectives", { world: WORLD, memberId: "pm-route" });
  clearInterval(watcher);

  assert.equal(r.status, 200);
  assert.equal(r.body.status, "applied");
  assert.equal(r.body.ok, true);
  assert.equal(captured[0].kind, "update_journal");
  assert.equal(captured[0].data.pages.length, 1);
  assert.equal(captured[0].data.pages[0].name, "Objectives");
  assert.ok(!JSON.stringify(captured).includes("Your wants"), "the player's page is never in the payload");
});

test("push-party-objectives: missing memberId is a 400", async () => {
  const r = await postJson("/api/foundry/push-party-objectives", { world: WORLD });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /requires memberId/);
});

test("adopt: missing journalUuid is a 400", async () => {
  const r = await postJson("/api/foundry/adopt-party-objectives", { world: WORLD, memberId: "pm-route" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /requires journalUuid/);
});

test("SECURITY: a traversal world id is refused on every new route", async () => {
  for (const [path, body] of [
    ["/api/foundry/push-party-objectives", { world: "../../../../etc", memberId: "pm-route" }],
    ["/api/foundry/adopt-party-objectives", { world: "../../../../etc", memberId: "pm-route", journalUuid: "JournalEntry.x" }],
    ["/api/combat-planning/party-roster/pm-route/objectives", { world: "../../../../etc", text: "x" }],
    ["/api/combat-planning/party-roster/pm-route/objectives-reorder", { world: "../../../../etc", objectiveIds: [] }]
  ]) {
    const r = await postJson(path, body);
    assert.equal(r.status, 400, `${path} must refuse a traversal world id`);
    assert.match(r.body.error, /Invalid world id/, path);
  }
});
