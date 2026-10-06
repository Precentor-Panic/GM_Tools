import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — GET /api/foundry/party-sheets?world=
 * (the Run view's party rail, 2026-10-06). A thin wrapper over
 * wf-mcp-server/lib/foundry-connection.mjs's readPartySheets, which composes
 * readFoundryIndex with the pure projection in
 * combat-planning/party-sheet-index.mjs. Real HTTP via fetch() against an
 * in-process server.listen(0), the same pattern as foundry-pull-routes.test.mjs.
 *
 * Response 200: { version, world, state, exportedAt, ageMs, staleThresholdMs,
 *                 sheets, excluded, note? }
 *
 * The security assertion at the bottom is this file's standing rule, not an
 * optional extra: a client-supplied `dataDir` must never be honored (the
 * path-traversal fix that produced review-ui/test/routes.test.mjs), and a
 * malformed `world` id must be rejected outright.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-party-sheets-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");
process.env.GM_TOOLS_APP_SETTINGS_DIR = join(scratchDir, "app-settings");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "party-sheets-routes-test-world";
const EMPTY_WORLD = "party-sheets-routes-empty-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { foundryIndexPath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { createReviewServer } = await import("../server.mjs");

const save = (v) => ({ roll: { min: null, max: null, mode: 0 }, value: v });
const INDEX = {
  version: 1,
  worldId: WORLD,
  exportedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
  users: [
    { id: "u1", name: "Ada", characterUuid: "Actor.pc" },
    { id: "u2", name: "GM", characterUuid: null }
  ],
  actors: [
    {
      uuid: "Actor.pc", name: "Keeneye Vance", type: "character",
      items: [{ type: "class", name: "Rogue" }],
      system: {
        level: 5, ac: 15, hp: { value: 20, max: 33 },
        abilities: { dex: { value: 18, mod: 4, save: save(7) } },
        skills: { prc: { value: 9, proficient: 2, passive: 19 } }
      }
    },
    // type:"character" but claimed by nobody — the pack mule.
    { uuid: "Actor.mule", name: "Ada's Mule", type: "character", items: [], system: { level: 0 } }
  ]
};

const dest = foundryIndexPath(dataDir, WORLD);
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(INDEX), "utf8");

let server, base;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

const get = async (qs) => {
  const res = await fetch(`${base}/api/foundry/party-sheets${qs}`);
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  return { status: res.status, body };
};

test("200 with the documented shape, the mule excluded", async () => {
  const { status, body } = await get(`?world=${WORLD}`);
  assert.equal(status, 200);
  assert.equal(body.version, 1);
  assert.equal(body.world, WORLD);
  assert.equal(body.sheets.length, 1, `expected one seat, got ${JSON.stringify(body.sheets.map((s) => s.name))}`);
  assert.equal(body.sheets[0].name, "Keeneye Vance");
  assert.equal(body.sheets[0].passive.prc, 19);
  assert.equal(body.sheets[0].hpMax, 33);
  assert.equal(body.sheets[0].saves.find((s) => s.key === "dex").mod, 7, "the {roll,value} save is unwrapped");
  assert.equal(body.sheets[0].profBonus, 3, "derived from level 5");
});

test("the staleness fields are present and honest", async () => {
  const { body } = await get(`?world=${WORLD}`);
  assert.equal(body.state, "stale", "a 3-day-old index is past the default 15-minute threshold");
  assert.equal(body.exportedAt, INDEX.exportedAt);
  assert.ok(body.ageMs > 2 * 86400000, `ageMs should be ~3 days, got ${body.ageMs}`);
  assert.equal(typeof body.staleThresholdMs, "number");
});

test("a world with no index is 200 with state 'off' and a reindex note, not a 4xx", async () => {
  const { status, body } = await get(`?world=${EMPTY_WORLD}`);
  assert.equal(status, 200, "an un-exported world is an ordinary state, not an error");
  assert.equal(body.state, "off");
  assert.deepEqual(body.sheets, []);
  assert.match(body.note, /reindexForGmTools/, "the note says how to fix it");
  assert.equal(body.exportedAt, null);
});

test("a client-supplied dataDir is never honored", async () => {
  const { status, body } = await get(`?world=${WORLD}&dataDir=${encodeURIComponent("/etc")}`);
  assert.equal(status, 200);
  assert.equal(body.sheets.length, 1, "the query dataDir was ignored and the real index still read");
});

test("a malformed world id is rejected", async () => {
  for (const bad of ["../etc", "a/b", ""]) {
    const { status } = await get(`?world=${encodeURIComponent(bad)}`);
    assert.equal(status, 400, `expected 400 for world=${JSON.stringify(bad)}`);
  }
});
