import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST -- Session Wrap routes (session-planner/session-wrap.mjs,
 * session-planner/truth-notes.mjs) behind:
 *   GET  /api/scene-planning/plans/:planId/wrap-candidates?world=       -> listWrapCandidates
 *   POST /api/scene-planning/plans/:planId/wrap-suggest      {world}    -> suggestWrapTransitions
 *   POST /api/scene-planning/plans/:planId/wrap-apply         {world, decisions} -> applyWrapTransitions
 *   POST /api/scene-planning/plans/:planId/truth-notes        {world, revealedEntityIds} -> generateTruthNotes
 *   GET  /api/scene-planning/plans/:planId/truth-notes?world= -> {current, history}
 *
 * This test file's own process never sets ANTHROPIC_API_KEY (same standing
 * "no live API calls in tests" rule as offline-degrade-routes.test.mjs), so
 * wrap-suggest/truth-notes are exercised through their real keyless-degrade
 * path -- exactly what a fresh dev/demo environment actually sees.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-wrap-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_NARRATIVE_STATE_DIR = join(scratchDir, "narrative-state");
process.env.GM_TOOLS_TRUTH_NOTES_DIR = join(scratchDir, "truth-notes");
process.env.GM_TOOLS_PLANS_DIR = join(scratchDir, "session-plans");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_SESSION_NOTES_DIR = join(scratchDir, "session-notes");
process.env.GM_TOOLS_WORLD_CLOCK_DIR = join(scratchDir, "world-clock");
process.env.GM_TOOLS_APP_SETTINGS_DIR = join(scratchDir, "app-settings");
process.env.WF_TIMELINE_GIT = "0";
process.env.WF_DATA_DIR = dataDir;

// Belt-and-suspenders (same as offline-degrade-routes.test.mjs): this
// suite's premise for wrap-suggest/truth-notes IS the keyless default.
delete process.env.ANTHROPIC_API_KEY;

const WORLD = "wrap-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { setNarrativeTruth, getNarrativeState } = await import("../../mutation-engine/narrative-state.mjs");
const { createPlan } = await import("../../session-planner/plans.mjs");
const { createReviewServer } = await import("../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "ent-a", name: "Mira the Barkeep", type: "person", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "ent-b", name: "The Miller's Ghost", type: "concept", importance: 0.4 } }
]);
setNarrativeTruth(dataDir, WORLD, "ent-a", "She was a Crown spy.", { stance: "concealing" }, { now: "2026-09-02T09:00:00.000Z" });
setNarrativeTruth(dataDir, WORLD, "ent-b", "He drowned his own daughter.", { stance: "unaware" }, { now: "2026-09-02T09:00:00.000Z" });

const plan = createPlan(WORLD, { name: "Session 1" }, { makeId: () => "plan-wrap-routes-1" });

let server, base;
before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(scratchDir, { recursive: true, force: true }); });

async function getJson(path) { const res = await fetch(`${base}${path}`); return { status: res.status, body: await res.json() }; }
async function postJson(path, body) { const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; }

test("GET wrap-candidates: lists both withheld entities with real names joined from the snapshot", async () => {
  const res = await getJson(`/api/scene-planning/plans/${plan.id}/wrap-candidates?world=${WORLD}`);
  assert.equal(res.status, 200);
  const ids = res.body.candidates.map((c) => c.entityId);
  assert.ok(ids.includes("ent-a") && ids.includes("ent-b"));
  const mira = res.body.candidates.find((c) => c.entityId === "ent-a");
  assert.equal(mira.entityName, "Mira the Barkeep");
  assert.equal(mira.truth, "She was a Crown spy.");
});

test("POST wrap-suggest: keyless degrade returns {suggestions:[], offline:true}-shaped, never a 5xx", async () => {
  const res = await postJson(`/api/scene-planning/plans/${plan.id}/wrap-suggest`, { world: WORLD });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.suggestions, []);
  assert.equal(res.body.offline, true);
  assert.equal(res.body.candidateCount, 2);
});

test("POST wrap-apply: transitions the narrative-state record (source:'wrap'), rejects a non-array/empty decisions body", async () => {
  const bad1 = await postJson(`/api/scene-planning/plans/${plan.id}/wrap-apply`, { world: WORLD, decisions: [] });
  assert.equal(bad1.status, 400);
  const bad2 = await postJson(`/api/scene-planning/plans/${plan.id}/wrap-apply`, { world: WORLD });
  assert.equal(bad2.status, 400);

  const res = await postJson(`/api/scene-planning/plans/${plan.id}/wrap-apply`, {
    world: WORLD,
    decisions: [{ entityId: "ent-a", to: "revealed", note: "Told outright." }]
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.applied, [{ entityId: "ent-a", to: "revealed" }]);
  assert.equal(res.body.timeline.committed, false, "WF_TIMELINE_GIT=0 in this test file's scratch env");

  // Read the store DIRECTLY (via its own env-override scratch dir) to
  // confirm the route genuinely wrote through to narrative-state.mjs, not
  // just echoed a plausible-looking response.
  const record = getNarrativeState(dataDir, WORLD, "ent-a");
  assert.equal(record.revealState, "revealed");
  const last = record.transitions[record.transitions.length - 1];
  assert.equal(last.source, "wrap");
  assert.equal(last.note, "Told outright.");
});

test("truth-notes: GET is empty before any generation, keyless POST persists an honest offline entry, GET reflects it", async () => {
  const before = await getJson(`/api/scene-planning/plans/${plan.id}/truth-notes?world=${WORLD}`);
  assert.equal(before.status, 200);
  assert.deepEqual(before.body, { current: null, history: [] });

  const generated = await postJson(`/api/scene-planning/plans/${plan.id}/truth-notes`, { world: WORLD, revealedEntityIds: ["ent-a"] });
  assert.equal(generated.status, 200);
  assert.equal(generated.body.offline, true);
  assert.ok(generated.body.entry.markdown.length > 0);
  assert.deepEqual(generated.body.entry.revealedEntityIds, ["ent-a"]);
  assert.equal(generated.body.entry.status, "current");

  const after = await getJson(`/api/scene-planning/plans/${plan.id}/truth-notes?world=${WORLD}`);
  assert.equal(after.status, 200);
  assert.ok(after.body.current, "a persisted current entry must now exist");
  assert.equal(after.body.current.id, generated.body.entry.id);
  assert.equal(after.body.history.length, 1);
});

test("SECURITY: a path-traversal-shaped world id is rejected with 400", async () => {
  const res = await getJson(`/api/scene-planning/plans/${plan.id}/wrap-candidates?world=${encodeURIComponent("../../etc")}`);
  assert.equal(res.status, 400);
});
