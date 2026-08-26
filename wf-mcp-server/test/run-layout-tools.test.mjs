import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * CONTRACT UNDER TEST -- the live-play / run-layout MCP tools (2026-08-26):
 *   wf_set_element_run, wf_set_scene_active_variants, wf_infer_run_layout,
 *   wf_delete_scene_element, wf_reorder_scene_elements, wf_set_scene_narration,
 *   wf_promote_scene_element / wf_demote_scene_element,
 *   plus `run` on wf_add_scene_element / wf_update_scene_element and the
 *   kind/whereNote/tags/activeVariants keys on wf_update_scene.
 * Real MCP subprocess over stdio against scratch stores, keyless, same
 * harness as planner-library-chronicle-tools.test.mjs.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.mjs");
const { snapshotFilePath } = await import("../lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-run-layout-tools-test-"));
const dataDir = join(scratchDir, "foundrydata");
const env = {
  ...process.env,
  WF_DATA_DIR: dataDir,
  GM_TOOLS_REVIEW_STATE_DIR: join(scratchDir, "review-state"),
  GM_TOOLS_PENDING_LEDGER_DIR: join(scratchDir, "pending-resolution"),
  GM_TOOLS_HUMAN_REVIEW_DIR: join(scratchDir, "human-review"),
  GM_TOOLS_MANUAL_UNDO_DIR: join(scratchDir, "manual-undo"),
  GM_TOOLS_PLANS_DIR: join(scratchDir, "plans"),
  GM_TOOLS_SESSION_SCENES_DIR: join(scratchDir, "session-scenes"),
  GM_TOOLS_SCENE_ELEMENTS_DIR: join(scratchDir, "scene-elements"),
  GM_TOOLS_SCENE_TRAY_DIR: join(scratchDir, "scene-tray"),
  GM_TOOLS_SCENE_NARRATION_DIR: join(scratchDir, "scene-narration"),
  GM_TOOLS_BESTIARY_DIR: join(scratchDir, "bestiary"),
  GM_TOOLS_STAGECRAFT_DIR: join(scratchDir, "stagecraft")
};
delete env.ANTHROPIC_API_KEY;
delete env.WF_DEFAULT_WORLD;

const WORLD = "run-layout-tools-test-world";
const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "rl-square", name: "The Square", type: "place", importance: 0.5 } }
]);

let transport, client;
const transportInst = new StdioClientTransport({ command: process.execPath, args: [SERVER_PATH], env, stderr: "pipe" });
transport = transportInst;
client = new Client({ name: "run-layout-tools-test-client", version: "0.0.0" });
await client.connect(transport);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const textBlock = res.content?.find((b) => b.type === "text");
  if (res.isError) throw new Error(textBlock?.text ?? "unknown MCP tool error");
  return textBlock ? JSON.parse(textBlock.text) : null;
}
async function callExpectError(name, args) {
  const res = await client.callTool({ name, arguments: args });
  assert.equal(res.isError, true, `expected ${name} to error`);
  return res.content?.find((b) => b.type === "text")?.text ?? "";
}

let sceneId;
await test("wf_update_scene carries kind/whereNote/tags/activeVariants; wf_set_scene_active_variants flips the switch", async () => {
  const { scene } = await call("wf_create_scene", { world: WORLD, name: "Square at dusk", locationEntityId: "rl-square" });
  sceneId = scene.id;
  assert.deepEqual(scene.activeVariants, []);
  const { scene: patched } = await call("wf_update_scene", { world: WORLD, sceneId, kind: "combat", whereNote: "By the well", tags: ["live"] });
  assert.equal(patched.kind, "combat");
  assert.equal(patched.whereNote, "By the well");
  assert.deepEqual(patched.tags, ["live"]);
  const { scene: flipped } = await call("wf_set_scene_active_variants", { world: WORLD, sceneId, variants: ["Night"] });
  assert.deepEqual(flipped.activeVariants, ["Night"]);
  const { scene: all } = await call("wf_set_scene_active_variants", { world: WORLD, sceneId, variants: [] });
  assert.deepEqual(all.activeVariants, []);
});

let readId, gmId, plainId;
await test("wf_add_scene_element / wf_update_scene_element accept `run`; wf_set_element_run writes, replaces and clears it", async () => {
  ({ element: { id: readId } } = await call("wf_add_scene_element", { world: WORLD, sceneId, name: "Read Aloud — Dusk", fields: { looks: "Gold light." }, run: { column: "main", role: "read", variant: "Dusk" } }));
  ({ element: { id: gmId } } = await call("wf_add_scene_element", { world: WORLD, sceneId, name: "Backdrop — Night", fields: { looks: "Dark." } }));
  ({ element: { id: plainId } } = await call("wf_add_scene_element", { world: WORLD, sceneId, name: "A bucket", fields: { looks: "Wooden." } }));

  const { element: set } = await call("wf_set_element_run", { world: WORLD, sceneId, elementId: gmId, column: "side", role: "gm", variant: "Night" });
  assert.deepEqual(set.run, { column: "side", role: "gm", variant: "Night" });
  const { element: moved } = await call("wf_set_element_run", { world: WORLD, sceneId, elementId: gmId, column: "off", role: "gm" });
  assert.deepEqual(moved.run, { column: "off", role: "gm" }, "replace, not merge -- variant dropped");
  const { element: cleared } = await call("wf_set_element_run", { world: WORLD, sceneId, elementId: gmId, clear: true });
  assert.equal(cleared.run, null);
  await callExpectError("wf_set_element_run", { world: WORLD, sceneId, elementId: gmId, column: "main" });
  await callExpectError("wf_update_scene_element", { world: WORLD, sceneId, elementId: gmId, run: { column: "main", role: "hero" } });
});

await test("wf_infer_run_layout tags only untagged elements and is idempotent; wf_get_scene returns the run + activeVariants", async () => {
  const { elements } = await call("wf_infer_run_layout", { world: WORLD, sceneId });
  const byId = new Map(elements.map((e) => [e.id, e]));
  assert.deepEqual(byId.get(readId).run, { column: "main", role: "read", variant: "Dusk" }, "explicit untouched");
  assert.deepEqual(byId.get(gmId).run, { column: "side", role: "gm", variant: "Night" }, "inferred from the name");
  assert.deepEqual(byId.get(plainId).run, { column: "main", role: "dressing" });
  const again = await call("wf_infer_run_layout", { world: WORLD, sceneId });
  assert.deepEqual(again.elements.map((e) => e.run), elements.map((e) => e.run));
  const full = await call("wf_get_scene", { world: WORLD, sceneId });
  assert.equal(full.elements.find((e) => e.id === gmId).run.variant, "Night");
  assert.ok(Array.isArray(full.scene.activeVariants));
});

await test("wf_reorder_scene_elements + wf_delete_scene_element + wf_set_scene_narration", async () => {
  const { elements } = await call("wf_reorder_scene_elements", { world: WORLD, sceneId, elementIds: [plainId, gmId, readId] });
  assert.deepEqual(elements.map((e) => e.id), [plainId, gmId, readId]);
  const del = await call("wf_delete_scene_element", { world: WORLD, sceneId, elementId: plainId });
  assert.equal(del.deleted, true);
  const again = await call("wf_delete_scene_element", { world: WORLD, sceneId, elementId: plainId });
  assert.equal(again.deleted, false, "idempotent");
  const { narration } = await call("wf_set_scene_narration", { world: WORLD, sceneId, text: "The square smells of rain." });
  assert.equal(narration.text, "The square smells of rain.");
  const full = await call("wf_get_scene", { world: WORLD, sceneId });
  assert.equal(full.narration.text, "The square smells of rain.");
  assert.equal(full.elements.length, 2);
});

await test("wf_promote_scene_element makes a real graph node; wf_demote_scene_element keeps it", async () => {
  const { element } = await call("wf_promote_scene_element", { world: WORLD, sceneId, elementId: gmId });
  assert.equal(element.kind, "graph");
  assert.ok(element.graphEntityId);
  const { element: back } = await call("wf_demote_scene_element", { world: WORLD, sceneId, elementId: gmId });
  assert.equal(back.kind, "local");
  const { entity } = await call("wf_get_entity", { world: WORLD, entityId: element.graphEntityId });
  assert.ok(entity, "graph node survives demote");
});

await test("multi-world safety: every new tool requires `world`", async () => {
  for (const name of ["wf_set_element_run", "wf_set_scene_active_variants", "wf_infer_run_layout", "wf_delete_scene_element", "wf_reorder_scene_elements", "wf_set_scene_narration"]) {
    const res = await client.callTool({ name, arguments: { sceneId, elementId: gmId, variants: [], elementIds: [gmId], text: "x", column: "main", role: "gm" } });
    assert.equal(res.isError, true, `${name} must refuse a missing world`);
  }
});

await test("wf_seed_run_skeleton seeds placeholders for the missing roles and is idempotent", async () => {
  const { scene } = await call("wf_create_scene", { world: WORLD, name: "Transit — The ford" });
  const first = await call("wf_seed_run_skeleton", { world: WORLD, sceneId: scene.id });
  assert.equal(first.kind, "transit");
  assert.deepEqual(first.seeded.map((e) => e.run.role), ["read", "beat", "beat", "exits"]);
  const again = await call("wf_seed_run_skeleton", { world: WORLD, sceneId: scene.id });
  assert.equal(again.seeded.length, 0);
  const asCombat = await call("wf_seed_run_skeleton", { world: WORLD, sceneId: scene.id, kind: "combat" });
  assert.ok(asCombat.seeded.some((e) => e.run.role === "block"), "override adds the combat-only roles");
});

await client.close();
rmSync(scratchDir, { recursive: true, force: true });
