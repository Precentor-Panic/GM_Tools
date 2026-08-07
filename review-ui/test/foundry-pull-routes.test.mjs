import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — Phase 32 task 32.2's new review-ui/server.mjs route,
 * a thin wrapper over wf-mcp-server/lib/foundry-pull-ops.mjs's
 * pullFoundryActorsToStores. Real HTTP requests via fetch() against an
 * in-process server.listen(0), same pattern as
 * review-ui/test/combat-planning-routes.test.mjs.
 *
 * ---------------------------------------------------------------------------
 * POST /api/foundry/pull-actors   { world }
 * ---------------------------------------------------------------------------
 * Response 200: { indexFound, bestiaryProposed, partyProposed, alreadyLinked, skippedActors }.
 * World-scoped (resolveWorld(body.world)), no client-supplied dataDir honored.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "wf-mcp-server", "test", "fixtures", "foundry-bridge");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-foundry-pull-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "foundry-pull-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { foundryIndexPath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { createReviewServer } = await import("../server.mjs");

const sampleFixture = JSON.parse(readFileSync(join(FIXTURES_DIR, "foundry-index.sample.json"), "utf8"));
const indexDest = foundryIndexPath(dataDir, WORLD);
mkdirSync(dirname(indexDest), { recursive: true });
writeFileSync(indexDest, JSON.stringify(sampleFixture), "utf8");

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

async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

test("POST /api/foundry/pull-actors: real fixture round trip -- 2 monsters + 1 PC, all status:'proposed'", async () => {
  const { status, body } = await postJson("/api/foundry/pull-actors", { world: WORLD });
  assert.equal(status, 200);
  assert.equal(body.indexFound, true);
  assert.equal(body.bestiaryProposed.length, 2);
  assert.equal(body.partyProposed.length, 1);
  assert.ok(body.bestiaryProposed.every((e) => e.status === "proposed"));
  assert.equal(body.partyProposed[0].status, "proposed");
  assert.deepEqual(body.alreadyLinked, { bestiary: [], party: [] });
});

test("POST /api/foundry/pull-actors: a world with no index file yet -- 200, indexFound:false, empty arrays (not a 404/500)", async () => {
  const { status, body } = await postJson("/api/foundry/pull-actors", { world: "a-world-never-reindexed" });
  assert.equal(status, 200);
  assert.equal(body.indexFound, false);
  assert.deepEqual(body.bestiaryProposed, []);
  assert.deepEqual(body.partyProposed, []);
});

test("SECURITY: POST /api/foundry/pull-actors rejects a path-traversal-shaped world id with 400 (checked before any file read)", async () => {
  const { status, body } = await postJson("/api/foundry/pull-actors", { world: "../../../../etc" });
  assert.equal(status, 400);
  assert.match(body.error, /Invalid world id/);
});

test("SECURITY: a client-supplied dataDir is never honored -- resolves from server-side WF_DATA_DIR regardless", async () => {
  const { status, body } = await postJson("/api/foundry/pull-actors", { world: WORLD, dataDir: "../../../etc" });
  assert.equal(status, 200);
  assert.equal(body.indexFound, true, "must still read the real WF_DATA_DIR index, ignoring the bogus client-supplied dataDir entirely");
});

void __dirname;
