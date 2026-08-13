import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * MCP wave -- Session Planner / Library / Chronicle parity tools. Real
 * subprocess, real MCP protocol round trip (same pattern
 * test/accept-reject-ledger.test.mjs already established) against the
 * ACTUAL wf-mcp-server/index.mjs, not a stand-in -- proves the new tools are
 * wired correctly end to end, not just that their underlying lib functions
 * work in isolation (those are covered by review-ui/test's own route tests,
 * since every new tool reuses the EXACT SAME store/lib modules those routes
 * call -- see index.mjs's own "MCP wave" section header comment).
 *
 * Deliberately runs with NO ANTHROPIC_API_KEY in the spawned subprocess's
 * environment (explicitly stripped below, regardless of what the parent
 * shell happens to have) -- wf_chronicle_run is the one LLM-backed tool
 * exercised here, and must degrade to the offline placeholder rather than
 * crash. This is also the packaging-verification test: it's the automated
 * proof that "ANTHROPIC_API_KEY is optional for the MCP tool paths" holds,
 * not just an assertion in a doc.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.mjs");

const { snapshotFilePath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-planner-library-chronicle-tools-test-"));
const dataDir = join(scratchDir, "foundrydata");
const env = {
  ...process.env,
  WF_DATA_DIR: dataDir,
  GM_TOOLS_REVIEW_STATE_DIR: join(scratchDir, "review-state"),
  GM_TOOLS_PENDING_LEDGER_DIR: join(scratchDir, "pending-resolution"),
  GM_TOOLS_HUMAN_REVIEW_DIR: join(scratchDir, "human-review"),
  GM_TOOLS_PLANS_DIR: join(scratchDir, "plans"),
  GM_TOOLS_SESSION_SCENES_DIR: join(scratchDir, "session-scenes"),
  GM_TOOLS_SCENE_ELEMENTS_DIR: join(scratchDir, "scene-elements"),
  GM_TOOLS_SCENE_TRAY_DIR: join(scratchDir, "scene-tray"),
  GM_TOOLS_SCENE_NARRATION_DIR: join(scratchDir, "scene-narration"),
  GM_TOOLS_BESTIARY_DIR: join(scratchDir, "bestiary"),
  GM_TOOLS_PARTY_ROSTER_DIR: join(scratchDir, "party-roster"),
  GM_TOOLS_ITEM_DIR: join(scratchDir, "items"),
  GM_TOOLS_STAGECRAFT_DIR: join(scratchDir, "stagecraft"),
  GM_TOOLS_WORLD_CLOCK_DIR: join(scratchDir, "world-clock"),
  GM_TOOLS_FORTUNE_DIR: join(scratchDir, "fortune-track"),
  GM_TOOLS_CHRONICLE_RUN_DIR: join(scratchDir, "chronicle-run")
};
delete env.ANTHROPIC_API_KEY; // keyless-by-design for this file -- see header comment
delete env.WF_DEFAULT_WORLD; // multi-world-safety regression guard -- see the dedicated test below

const WORLD = "planner-library-chronicle-test-world";
const OTHER_WORLD = "planner-library-chronicle-test-world-2";

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "the-anvil", name: "The Anvil Inn", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "gerdur", name: "Gerdur", type: "person", importance: 0.5 } }
]);
bootstrapSnapshot(snapshotFilePath(dataDir, OTHER_WORLD), { worldId: OTHER_WORLD });

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

let client, transport;
async function connect() {
  transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_PATH], env, stderr: "pipe" });
  client = new Client({ name: "planner-library-chronicle-tools-test-client", version: "0.0.0" });
  await client.connect(transport);
}

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const textBlock = res.content?.find((b) => b.type === "text");
  if (res.isError) throw new Error(textBlock?.text ?? "unknown MCP tool error");
  return textBlock ? JSON.parse(textBlock.text) : null;
}

/** Expects the call to fail (isError / thrown) and returns the error message. */
async function callExpectError(name, args) {
  const res = await client.callTool({ name, arguments: args });
  assert.equal(res.isError, true, `expected ${name} to error with args ${JSON.stringify(args)}`);
  return res.content?.find((b) => b.type === "text")?.text ?? "";
}

await connect();

// --- Multi-world safety -----------------------------------------------------

await test("multi-world safety: wf_list_plans requires `world` explicitly -- omitting it is a schema validation error, never a silent WF_DEFAULT_WORLD fallback", async () => {
  const res = await client.callTool({ name: "wf_list_plans", arguments: {} });
  assert.equal(res.isError, true, "omitting world must fail, not silently default");
});

await test("multi-world safety: two worlds' planner state never leaks into each other", async () => {
  await call("wf_create_plan", { world: WORLD, name: "Opening Session" });
  await call("wf_create_plan", { world: OTHER_WORLD, name: "One-Shot Plan" });
  const { plans: plansA } = await call("wf_list_plans", { world: WORLD });
  const { plans: plansB } = await call("wf_list_plans", { world: OTHER_WORLD });
  assert.ok(plansA.some((p) => p.name === "Opening Session"));
  assert.ok(!plansA.some((p) => p.name === "One-Shot Plan"), "world A must not see world B's plan");
  assert.ok(plansB.some((p) => p.name === "One-Shot Plan"));
  assert.ok(!plansB.some((p) => p.name === "Opening Session"), "world B must not see world A's plan");
});

// --- Session Planner: plans -------------------------------------------------

let planId;
await test("wf_create_plan / wf_get_plan / wf_rename_plan round-trip", async () => {
  const { plan } = await call("wf_create_plan", { world: WORLD, name: "Session 1" });
  planId = plan.id;
  assert.equal(plan.name, "Session 1");
  assert.deepEqual(plan.sceneIds, []);
  const { plan: fetched } = await call("wf_get_plan", { world: WORLD, planId });
  assert.equal(fetched.id, planId);
  const { plan: renamed } = await call("wf_rename_plan", { world: WORLD, planId, name: "Session 1 (renamed)" });
  assert.equal(renamed.name, "Session 1 (renamed)");
});

// --- Session Planner: scenes -------------------------------------------------

let sceneId, otherSceneId;
await test("wf_create_scene: a place locationEntityId is accepted", async () => {
  const { scene } = await call("wf_create_scene", { world: WORLD, name: "Tavern Brawl", locationEntityId: "the-anvil", objectiveNote: "Introduce the party" });
  sceneId = scene.id;
  assert.equal(scene.name, "Tavern Brawl");
  assert.equal(scene.locationEntityId, "the-anvil");
});

await test("wf_create_scene: a NON-place locationEntityId is rejected with a clear error (mirrors the HTTP route's own guard)", async () => {
  const msg = await callExpectError("wf_create_scene", { world: WORLD, name: "Bad Scene", locationEntityId: "gerdur" });
  assert.match(msg, /must reference a "place" entity/);
});

await test("wf_create_scene: an unknown locationEntityId is allowed through unchanged (guard only fires for an existing non-place entity)", async () => {
  const { scene } = await call("wf_create_scene", { world: WORLD, name: "Untethered Scene", locationEntityId: "does-not-exist" });
  otherSceneId = scene.id;
  assert.equal(scene.locationEntityId, "does-not-exist");
});

await test("wf_update_scene patches only supplied fields", async () => {
  const { scene } = await call("wf_update_scene", { world: WORLD, sceneId, objectiveNote: "Updated objective" });
  assert.equal(scene.objectiveNote, "Updated objective");
  assert.equal(scene.name, "Tavern Brawl", "name must be unchanged -- patch-style, not a full overwrite");
});

await test("wf_list_scenes: recency:true orders most-recently-touched first; omitted keeps creation order", async () => {
  const { scenes: creationOrder } = await call("wf_list_scenes", { world: WORLD });
  assert.equal(creationOrder[0].id, sceneId, "creation order: Tavern Brawl was created first");
  await call("wf_update_scene", { world: WORLD, sceneId: otherSceneId, name: "Untethered Scene (touched)" });
  const { scenes: recencyOrder } = await call("wf_list_scenes", { world: WORLD, recency: true });
  assert.equal(recencyOrder[0].id, otherSceneId, "recency order: the just-touched scene must sort first");
});

await test("wf_add_scene_to_plan / wf_reorder_plan", async () => {
  const { plan: withScene } = await call("wf_add_scene_to_plan", { world: WORLD, planId, sceneId });
  assert.deepEqual(withScene.sceneIds, [sceneId]);
  await call("wf_add_scene_to_plan", { world: WORLD, planId, sceneId: otherSceneId });
  const { plan: reordered } = await call("wf_reorder_plan", { world: WORLD, planId, sceneIds: [otherSceneId, sceneId] });
  assert.deepEqual(reordered.sceneIds, [otherSceneId, sceneId]);
});

// --- Session Planner: elements -----------------------------------------------

let elementId;
await test("wf_add_scene_element / wf_get_scene_elements / wf_update_scene_element (stat shallow-merges)", async () => {
  const { element } = await call("wf_add_scene_element", { world: WORLD, sceneId, name: "Suspicious Barkeep", kind: "local", stat: { hp: 10, ac: 12 } });
  elementId = element.id;
  const { elements } = await call("wf_get_scene_elements", { world: WORLD, sceneId });
  assert.ok(elements.some((e) => e.id === elementId));
  const { element: patched } = await call("wf_update_scene_element", { world: WORLD, sceneId, elementId, stat: { hp: 15 } });
  assert.equal(patched.stat.hp, 15, "hp must update");
  assert.equal(patched.stat.ac, 12, "ac must survive the shallow merge, not be wiped");
});

// --- Session Planner: composed wf_get_scene ----------------------------------

await test("wf_get_scene composes record + elements + tray + narration in one call", async () => {
  const result = await call("wf_get_scene", { world: WORLD, sceneId });
  assert.equal(result.scene.id, sceneId);
  assert.ok(Array.isArray(result.elements));
  assert.ok(result.elements.some((e) => e.id === elementId));
  assert.ok("roster" in result.tray && "xpBudget" in result.tray);
  assert.equal(result.narration, null, "no narration saved yet -- must be null, not throw");
});

// --- Library: hand-authoring + list ------------------------------------------

let bestiaryEntryId;
await test("wf_add_bestiary_entry (NO world param) / wf_list_bestiary filters / wf_get_bestiary_entry", async () => {
  const { entry } = await call("wf_add_bestiary_entry", { name: "Cave Bear", ac: 12, hp: 42, challengeRating: "2" });
  bestiaryEntryId = entry.id;
  assert.equal(entry.status, "accepted", "hand-add accepts immediately, no review gate");

  const { entries: allEntries } = await call("wf_list_bestiary", {});
  assert.ok(allEntries.some((e) => e.id === bestiaryEntryId));

  const { entries: filtered } = await call("wf_list_bestiary", { status: "accepted", source: "mine" });
  assert.ok(filtered.some((e) => e.id === bestiaryEntryId));
  const { entries: wrongStatus } = await call("wf_list_bestiary", { status: "proposed" });
  assert.ok(!wrongStatus.some((e) => e.id === bestiaryEntryId), "status filter must actually exclude non-matching entries");

  // wf_get_bestiary_entry's read-time projection (getBestiaryEntry ->
  // projectReadFields) is where sourcePill actually appears -- the raw
  // hand-add response above (acceptBestiaryEntry's own write-time return)
  // deliberately does NOT include it, mirroring the real HTTP route exactly.
  const { entry: fetched } = await call("wf_get_bestiary_entry", { entryId: bestiaryEntryId });
  assert.equal(fetched.id, bestiaryEntryId);
  assert.equal(fetched.sourcePill, "mine");
});

await test("wf_add_party_member / wf_list_party", async () => {
  const { member } = await call("wf_add_party_member", { world: WORLD, name: "Kael Stormwind", class: "Fighter", level: 3, ac: 16, hp: 28 });
  assert.equal(member.combatRelevant.class, "Fighter");
  const { members } = await call("wf_list_party", { world: WORLD });
  assert.ok(members.some((m) => m.id === member.id));
  const { members: otherWorldMembers } = await call("wf_list_party", { world: OTHER_WORLD });
  assert.ok(!otherWorldMembers.some((m) => m.id === member.id), "party rosters must not leak across worlds");
});

await test("wf_add_item / wf_list_items", async () => {
  const { item } = await call("wf_add_item", { world: WORLD, name: "Lantern of Whispers", type: "wondrous", description: "Glows near secrets." });
  assert.equal(item.status, "accepted");
  const { items } = await call("wf_list_items", { world: WORLD });
  assert.ok(items.some((i) => i.id === item.id));
});

await test("wf_add_stagecraft_asset / wf_list_stagecraft (includes hand-added rows alongside any catalog/compendium rows)", async () => {
  const { asset } = await call("wf_add_stagecraft_asset", { world: WORLD, name: "Tavern Interior", kind: "map", desc: "A cozy common room." });
  assert.equal(asset.status, "accepted");
  const { assets } = await call("wf_list_stagecraft", { world: WORLD });
  assert.ok(assets.some((a) => a.id === asset.id));
  const { assets: mapsOnly } = await call("wf_list_stagecraft", { world: WORLD, kind: "map" });
  assert.ok(mapsOnly.every((a) => a.kind === "map"));
});

// --- Session Planner: tray drop (composed op, shared with the HTTP route) --

await test("wf_tray_drop {kind:'creature'}: FIRST drop creates a stat-carrying element; repeat drop only stacks the roster", async () => {
  const first = await call("wf_tray_drop", { world: WORLD, sceneId, kind: "creature", id: bestiaryEntryId });
  assert.ok(first.element, "first drop must create a scene element");
  assert.equal(first.element.stat.hp, 42);
  assert.equal(first.roster.find((r) => r.id === bestiaryEntryId)?.n, 1);

  const second = await call("wf_tray_drop", { world: WORLD, sceneId, kind: "creature", id: bestiaryEntryId });
  assert.equal(second.element, null, "repeat drop must NOT create a second element");
  assert.equal(second.roster.find((r) => r.id === bestiaryEntryId)?.n, 2, "repeat drop stacks the roster count");
});

await test("wf_tray_drop {kind:'hero'}: display-only, no scene element", async () => {
  const { member } = await call("wf_add_party_member", { world: WORLD, name: "Second Hero" });
  const result = await call("wf_tray_drop", { world: WORLD, sceneId, kind: "hero", id: member.id });
  assert.equal(result.element, null);
  assert.ok(result.roster.some((r) => r.id === member.id && r.kind === "hero"));
});

await test("wf_tray_drop: an unresolvable id never throws an ugly 500-shaped error -- clean 'not found'", async () => {
  const msg = await callExpectError("wf_tray_drop", { world: WORLD, sceneId, kind: "creature", id: "does-not-exist" });
  assert.match(msg, /No bestiary entry found/);
});

await test("wf_tray_drop: an unknown kind is rejected with a clear error", async () => {
  const msg = await callExpectError("wf_tray_drop", { world: WORLD, sceneId, kind: "vehicle", id: "x" });
  // zod enum validation rejects this before the handler even runs.
  assert.match(msg, /vehicle|enum|Invalid/i);
});

await test("wf_set_xp_budget / wf_tray_remove", async () => {
  const budgeted = await call("wf_set_xp_budget", { world: WORLD, sceneId, xpBudget: 500 });
  assert.equal(budgeted.xpBudget, 500);
  const removed = await call("wf_tray_remove", { world: WORLD, sceneId, kind: "creature", id: bestiaryEntryId });
  assert.ok(!removed.roster.some((r) => r.id === bestiaryEntryId), "removed row must be gone from the roster");
});

// --- Chronicle: clock / fortune / intents ------------------------------------

await test("wf_get_world_clock / wf_set_fortune / wf_get_fortune", async () => {
  const clock = await call("wf_get_world_clock", { world: WORLD });
  assert.ok("currentDate" in clock && "sessionNumber" in clock);
  const set = await call("wf_set_fortune", { world: WORLD, stopId: "ruinous" });
  assert.equal(set.stopId, "ruinous");
  const got = await call("wf_get_fortune", { world: WORLD });
  assert.equal(got.stopId, "ruinous");
});

await test("wf_queue_intent / wf_list_pending_intents (manual sentinel)", async () => {
  const queued = await call("wf_queue_intent", { world: WORLD, name: "The barkeep's debt", note: "He owes the Thieves' Guild." });
  assert.ok(queued.entityId);
  assert.equal(queued.entries[0].sourceBatchId, "manual");
  assert.equal(queued.entries[0].cycleDescriptor, "Manual");

  const { entities: pending } = await call("wf_list_pending_intents", { world: WORLD });
  assert.ok(pending.some((p) => p.entityId === queued.entityId));

  // Dedup-or-create: queuing the SAME name again must resolve to the same entity, not create a duplicate.
  const queuedAgain = await call("wf_queue_intent", { world: WORLD, name: "The barkeep's debt" });
  assert.equal(queuedAgain.entityId, queued.entityId, "same free-typed name must dedup to the same entity");
});

// --- Chronicle: wf_chronicle_run (offline-safe, through the review gate) ----

await test("wf_chronicle_run: prompt-as-seed produces a real, non-empty batch even with nothing queued/carried, advances the clock exactly once, and degrades cleanly offline (no ANTHROPIC_API_KEY in this test's env)", async () => {
  const clockBefore = await call("wf_get_world_clock", { world: WORLD });
  const result = await call("wf_chronicle_run", {
    world: WORLD,
    scopeKind: "queued-intents",
    carriedEntryIds: [],
    span: { days: 3 },
    prompt: "A fire breaks out in the market district.",
    tags: ["fire"]
  });
  assert.ok(result.batchId);
  assert.ok(result.mutationCount >= 1, "the typed prompt must earn at least one reviewable proposal, even with nothing carried");
  assert.equal(result.scopeKind, "queued-intents");
  assert.notEqual(result.clock.currentDate, clockBefore.currentDate, "the clock must actually advance");

  const clockAfter = await call("wf_get_world_clock", { world: WORLD });
  assert.equal(clockAfter.currentDate, result.clock.currentDate, "advanceWorldClock must be called exactly once -- the run's own reported clock must match what's now persisted");
});

await test("wf_list_chronicle_log surfaces the wf_chronicle_run batch with its promptSummary sidecar", async () => {
  const log = await call("wf_list_chronicle_log", { world: WORLD });
  const entry = log.entries.find((e) => e.promptSummary === "A fire breaks out in the market district.");
  assert.ok(entry, "the run's promptSummary must appear in the chronicle log");
  assert.ok(entry.headline);
});

await client.close();
console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
