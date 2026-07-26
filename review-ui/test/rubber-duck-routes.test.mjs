import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * Phase 8 task 8.4 — deterministic route-level tests for the rubber-duck
 * mode wiring, matching routes.test.mjs's own style (real HTTP requests
 * against an in-process server, no mocking of the HTTP layer itself).
 *
 * What's covered here (no real API call needed):
 *   - the settings get/set round trip
 *   - the reject route's dispatch: unaffected for a non-rubber-duck batch
 *     (byte-identical to pre-Phase-8), unaffected for scope='entity' even on
 *     a rubber-duck batch, requires note/quickPickReason on a rubber-duck
 *     batch at scope='batch', and refuses a plain reject once the bounded
 *     re-framing budget is already spent (FramingRoundLimitError -> 409) --
 *     this last one is deterministic because requestReframing's round-limit
 *     check runs BEFORE any model call.
 *   - writeup-select-framing's required-field validation
 *
 * What's NOT covered here (needs a real, billed Anthropic API call --
 * proposeFramingsFromWriteup/proposeWfiFromWriteup have no test-time client
 * injection seam threaded through review-ui's HTTP layer, same reason
 * routes.test.mjs/routes-live.smoke.mjs are split): the actual propose ->
 * framings -> select -> batch created round trip, and an actual
 * quick-pick-triggered re-framing call succeeding. See the sibling
 * rubber-duck-routes-live.smoke.mjs for those.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-review-ui-rubber-duck-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_USER_SETTINGS_DIR = join(scratchDir, "user-settings");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "review-ui-rubber-duck-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createBatch, loadBatch } = await import("../../mutation-engine/review-state.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });

let entityCounter = 0;

/** A hand-built writeup-import batch, avoiding a real LLM call -- mirrors previewWriteupImport's own mutation shape. */
function makeWriteupImportBatch({ rubberDuck, framingHistory } = {}) {
  const suffix = entityCounter++;
  const entityId = `writeup-npc-${suffix}`;
  applyHeadless(snapPath, [{ op: "upsert_entity", data: { id: entityId, name: `Writeup NPC ${suffix}`, type: "person", importance: 0.5 } }]);
  const scope = { mode: "writeup-import", text: `Some writeup text ${suffix}.` };
  if (rubberDuck) scope.rubberDuck = rubberDuck;
  if (framingHistory) scope.framingHistory = framingHistory;
  return createBatch(WORLD, scope, undefined, [
    {
      op: "upsert_entity",
      id: entityId,
      data: { importance: 0.6 },
      rationale: "Extracted from the writeup.",
      batchId: "placeholder",
      sourceKind: "writeup-import",
      regionId: "writeup-import",
      entityContext: { name: `Writeup NPC ${suffix}`, importance: 0.6, tags: [] }
    }
  ]);
}

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

// ------------------------------------------------------------- settings ---

test("GET /api/settings/rubber-duck: default state before anything is ever set", async () => {
  const { status, body } = await getJson("/api/settings/rubber-duck");
  assert.equal(status, 200);
  assert.equal(body.enabled, false);
});

test("POST /api/settings/rubber-duck -> GET round trip", async () => {
  const set = await postJson("/api/settings/rubber-duck", { enabled: true });
  assert.equal(set.status, 200);
  assert.equal(set.body.enabled, true);
  assert.ok(set.body.updatedAt);

  const get = await getJson("/api/settings/rubber-duck");
  assert.equal(get.body.enabled, true);

  // Reset for the rest of this file's tests, which construct their own
  // rubber-duck batches directly rather than depending on the live setting.
  await postJson("/api/settings/rubber-duck", { enabled: false });
});

test("POST /api/settings/rubber-duck with a non-boolean `enabled` is a clean 400", async () => {
  const { status, body } = await postJson("/api/settings/rubber-duck", { enabled: "yes" });
  assert.equal(status, 400);
  assert.ok(body.error);
});

// ------------------------------------------------------- reject dispatch ---

test("reject route: a batch with NO batch.scope.rubberDuck is completely unaffected -- note/quickPickReason are ignored, response has no rubberDuckLoop field (byte-identical to pre-Phase-8)", async () => {
  const batch = makeWriteupImportBatch(); // no rubberDuck stamp at all
  const { status, body } = await postJson(`/api/batches/${batch.id}/reject`, {
    world: WORLD,
    scope: "batch",
    note: "this note should be ignored entirely"
  });
  assert.equal(status, 200);
  assert.ok(!("rubberDuckLoop" in body), "a non-rubber-duck batch's reject response must carry no new field");
  const reloaded = loadBatch(WORLD, batch.id);
  assert.ok(reloaded.mutations.every((m) => m.status === "rejected"));
});

test("reject route: scope='entity' on a rubber-duck batch is ALSO unaffected -- the loop only applies at scope='batch'/'region'", async () => {
  const batch = makeWriteupImportBatch({ rubberDuck: { enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" }, framingHistory: [{ framings: [], selection: {}, note: "n0" }] });
  const { status, body } = await postJson(`/api/batches/${batch.id}/reject`, {
    world: WORLD,
    scope: "entity",
    id: "m0"
  });
  assert.equal(status, 200);
  assert.ok(!("rubberDuckLoop" in body), "scope='entity' must never trigger the reject loop, even in rubber-duck mode");
});

test("reject route: a rubber-duck batch at scope='batch' with NEITHER note NOR quickPickReason is refused with a clear 400", async () => {
  const batch = makeWriteupImportBatch({ rubberDuck: { enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" }, framingHistory: [{ framings: [], selection: {}, note: "n0" }] });
  const { status, body } = await postJson(`/api/batches/${batch.id}/reject`, { world: WORLD, scope: "batch" });
  assert.equal(status, 400);
  assert.match(body.error, /requires either `note`.*or `quickPickReason`/);
});

test("reject route: a SECOND plain reject (quickPickReason) once the bounded round budget is already spent is refused with a clean 409, without making any API call", async () => {
  const batch = makeWriteupImportBatch({
    rubberDuck: { enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" },
    framingHistory: [
      { framings: [], selection: {}, note: "initial round" },
      { framings: [], selection: {}, note: "re-framing round" }
    ]
  });
  const { status, body } = await postJson(`/api/batches/${batch.id}/reject`, {
    world: WORLD,
    scope: "batch",
    quickPickReason: "wrong-emphasis"
  });
  assert.equal(status, 409);
  assert.equal(body.name, "FramingRoundLimitError");

  // The plain-reject marking itself still happened (rejectOp runs before the
  // loop dispatch) -- only the re-framing round was refused.
  const reloaded = loadBatch(WORLD, batch.id);
  assert.ok(reloaded.mutations.every((m) => m.status === "rejected"));
});

test("reject route: an unknown quickPickReason is a clean 400, not a crash, and never calls the framing model", async () => {
  const batch = makeWriteupImportBatch({ rubberDuck: { enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" }, framingHistory: [{ framings: [], selection: {}, note: "n0" }] });
  const { status, body } = await postJson(`/api/batches/${batch.id}/reject`, {
    world: WORLD,
    scope: "batch",
    quickPickReason: "not-a-real-reason"
  });
  assert.equal(status, 400);
  assert.match(body.error, /Unknown quick-pick reason/);
});

// -------------------------------------------------- writeup-select-framing ---

test("POST /api/writeup-select-framing: missing both batchId and writeupText is a clean 400", async () => {
  const { status, body } = await postJson("/api/writeup-select-framing", {
    world: WORLD,
    framings: [{ id: "a", sentence: "x" }, { id: "b", sentence: "y" }, { id: "c", sentence: "z" }],
    selection: { primary: { id: "a", sentence: "x" } }
  });
  assert.equal(status, 400);
  assert.match(body.error, /requires either `batchId` or `writeupText`/);
});

test("POST /api/writeup-select-framing: writeupText path without `rubberDuck` is a clean 400 (the read-once snapshot must be carried forward, not re-read here)", async () => {
  const { status, body } = await postJson("/api/writeup-select-framing", {
    world: WORLD,
    writeupText: "Some writeup.",
    framings: [{ id: "a", sentence: "x" }, { id: "b", sentence: "y" }, { id: "c", sentence: "z" }],
    selection: { primary: { id: "a", sentence: "x" } }
  });
  assert.equal(status, 400);
  assert.match(body.error, /requires `rubberDuck`/);
});

test("POST /api/writeup-select-framing: batchId path against a NON-rubber-duck batch is refused with a clear error", async () => {
  const batch = makeWriteupImportBatch(); // no rubberDuck stamp
  const { status, body } = await postJson("/api/writeup-select-framing", {
    world: WORLD,
    batchId: batch.id,
    framings: [{ id: "a", sentence: "x" }, { id: "b", sentence: "y" }, { id: "c", sentence: "z" }],
    selection: { primary: { id: "a", sentence: "x" } }
  });
  assert.equal(status, 400);
  assert.match(body.error, /not created with rubber-duck mode on/);
});

test("POST /api/writeup-select-framing: batchId path against a batch whose round budget is ALREADY spent is refused with a clean 409 -- defense in depth, independent of the reject-route's own bound check", async () => {
  const batch = makeWriteupImportBatch({
    rubberDuck: { enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" },
    framingHistory: [
      { framings: [], selection: {}, note: "initial round" },
      { framings: [], selection: {}, note: "re-framing round" }
    ]
  });
  const { status, body } = await postJson("/api/writeup-select-framing", {
    world: WORLD,
    batchId: batch.id,
    framings: [{ id: "a", sentence: "x" }, { id: "b", sentence: "y" }, { id: "c", sentence: "z" }],
    selection: { primary: { id: "a", sentence: "x" } }
  });
  assert.equal(status, 409);
  assert.equal(body.name, "FramingRoundLimitError");
});

test("POST /api/writeup-propose: empty text is a clean 400, no API call", async () => {
  const { status, body } = await postJson("/api/writeup-propose", { world: WORLD, text: "   " });
  assert.equal(status, 400);
  assert.match(body.error, /non-empty `text`/);
});
