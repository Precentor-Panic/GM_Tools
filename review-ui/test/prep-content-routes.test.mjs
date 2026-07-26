import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";

/**
 * Phase 11 task 11.3's deterministic route-level tests: everything that
 * doesn't require a real Anthropic API call (the store CRUD wiring, error
 * mapping, and -- the acceptance-critical structural check -- that this
 * surface has NO batchId anywhere, confirming it is not reachable from
 * Batch Review). The propose-framings/reframe/generate routes DO need a
 * real model call and are covered by the sibling
 * prep-content-routes-live.smoke.mjs, matching this project's established
 * *.test.mjs (mocked/no-LLM) vs. *.smoke.mjs (real API) split.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-review-ui-prep-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "review-ui-prep-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { savePrepContent, getPrepContent } = await import("../../mutation-engine/prep-content.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "alvor", name: "Alvor", type: "person", importance: 0.5, description: "A smith." } },
  { op: "upsert_entity", data: { id: "riverwood", name: "Riverwood", type: "place", importance: 0.6, description: "A village." } }
]);

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

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}
async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  return { status: res.status, body: await res.json() };
}

test("GET /api/entities/:id/prep returns null prep content for an entity never developed", async () => {
  const { status, body } = await getJson(`/api/entities/alvor/prep?world=${WORLD}`);
  assert.equal(status, 200);
  assert.equal(body.entityId, "alvor");
  assert.equal(body.prepContent, null);
});

test("POST .../prep/accept 400s cleanly when nothing has been proposed yet -- not a crash", async () => {
  const { status, body } = await postJson(`/api/entities/riverwood/prep/accept`, { world: WORLD });
  assert.equal(status, 400);
  assert.ok(body.error);
});

test("POST .../prep/regenerate-field 400s cleanly with no prep content yet", async () => {
  const { status } = await postJson(`/api/entities/riverwood/prep/regenerate-field`, { world: WORLD, fieldName: "secret" });
  assert.equal(status, 400);
});

test("POST .../prep/discard and .../prep/mark-stale are safe no-ops (200, discarded:false-ish / null) with nothing yet", async () => {
  const discard = await postJson(`/api/entities/nobody-home/prep/discard`, { world: WORLD });
  assert.equal(discard.status, 200);
  assert.equal(discard.body, null);

  const stale = await postJson(`/api/entities/nobody-home/prep/mark-stale`, { world: WORLD });
  assert.equal(stale.status, 200);
  assert.equal(stale.body, null);
});

test("full accept/discard/mark-stale lifecycle over a directly-seeded 'proposed' draft (no LLM call needed)", async () => {
  savePrepContent(WORLD, "alvor", {
    entityType: "person",
    framingUsed: "test framing",
    fields: {
      descriptionAppearance: "x", personalityMannerisms: "x", motivationGoal: "x",
      secret: "the original secret", potentialRolls: [], hook: "x"
    }
  });

  const got = await getJson(`/api/entities/alvor/prep?world=${WORLD}`);
  assert.equal(got.body.prepContent.status, "proposed");

  const accepted = await postJson(`/api/entities/alvor/prep/accept`, { world: WORLD });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.status, "accepted");

  // Discard now refuses (it's accepted, never deleted) -- confirmed via the route, not just the library function.
  const discardAttempt = await postJson(`/api/entities/alvor/prep/discard`, { world: WORLD });
  assert.equal(discardAttempt.status, 400);
  assert.ok(getPrepContent(WORLD, "alvor"), "still there after the refused discard");

  const staled = await postJson(`/api/entities/alvor/prep/mark-stale`, { world: WORLD });
  assert.equal(staled.status, 200);
  assert.equal(staled.body.status, "stale");
  assert.equal(staled.body.fields.secret, "the original secret", "fields untouched by going stale");
});

test("a freshly-proposed (not yet accepted) draft CAN be discarded, and disappears entirely", async () => {
  savePrepContent(WORLD, "riverwood", {
    entityType: "place",
    framingUsed: "test framing",
    fields: {
      descriptionAtmosphere: "x", notableFeatures: "x", secret: "x", potentialEncounter: "x", potentialRolls: []
    }
  });
  assert.ok(getPrepContent(WORLD, "riverwood"));
  const discarded = await postJson(`/api/entities/riverwood/prep/discard`, { world: WORLD });
  assert.equal(discarded.status, 200);
  assert.equal(discarded.body.discarded, true);
  assert.equal(getPrepContent(WORLD, "riverwood"), null);
});

test("no route anywhere in this surface accepts a batchId -- confirming (structurally, not just by convention) that prep content is unreachable from Batch Review", () => {
  const serverSource = new URL("../server.mjs", import.meta.url);
  // A cheap, direct structural check: read this project's own server.mjs
  // source and confirm none of the /prep routes reference batchId at all.
  return import("node:fs").then(({ readFileSync }) => {
    const src = readFileSync(serverSource, "utf8");
    const prepSectionStart = src.indexOf("GET /api/entities/:entityId/prep?world=");
    assert.ok(prepSectionStart > -1, "expected to find the Phase 11 routes section");
    const prepSection = src.slice(prepSectionStart);
    assert.doesNotMatch(prepSection, /batchId/, "the Phase 11 prep-content route section must never reference batchId");
  });
});
