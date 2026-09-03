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
  GM_TOOLS_STAGECRAFT_DIR: join(scratchDir, "stagecraft"),
  GM_TOOLS_BRIEFING_DIR: join(scratchDir, "briefing")
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

await test("wf_set_element_run carries `group` (composite Run card tag); a re-set without it clears just the group", async () => {
  const { element: grouped } = await call("wf_set_element_run", { world: WORLD, sceneId, elementId: plainId, column: "main", role: "card", group: "P-2" });
  assert.deepEqual(grouped.run, { column: "main", role: "card", group: "P-2" });
  // wf_add_scene_element's `run` param takes it too.
  const { element: sibling } = await call("wf_add_scene_element", {
    world: WORLD, sceneId, name: "Read Aloud — Outcome", fields: { looks: "It lands." },
    run: { column: "main", role: "read", group: "P-2", variant: "Outcome" }
  });
  assert.equal(sibling.run.group, "P-2");
  // Replace-not-merge: setting run again WITHOUT group drops it.
  const { element: ungrouped } = await call("wf_set_element_run", { world: WORLD, sceneId, elementId: plainId, column: "main", role: "card" });
  assert.ok(!("group" in ungrouped.run), "re-set without group clears it");
  // The store's zod (min(1)) rejects an empty-string group.
  await callExpectError("wf_update_scene_element", { world: WORLD, sceneId, elementId: plainId, run: { column: "main", role: "card", group: "" } });
  // Cleanup so the later infer/reorder tests see the same element set as before.
  await call("wf_delete_scene_element", { world: WORLD, sceneId, elementId: sibling.id });
  const { element: restored } = await call("wf_set_element_run", { world: WORLD, sceneId, elementId: plainId, clear: true });
  assert.equal(restored.run, null);
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

// Persona round (M2): the MCP surface used to hide the lib's `opts.type`
// override, so a stat-less NPC could only ever promote as an "object".
await test("wf_promote_scene_element: explicit `type` overrides the stat-block inference", async () => {
  const { element: npc } = await call("wf_add_scene_element", { world: WORLD, sceneId, name: "The Old Journeyman", fields: { gives: "Collects wrong strands." } });
  const { element } = await call("wf_promote_scene_element", { world: WORLD, sceneId, elementId: npc.id, type: "person" });
  const { entity } = await call("wf_get_entity", { world: WORLD, entityId: element.graphEntityId });
  assert.equal(entity.type, "person", "explicit type wins over the no-stat 'object' default");
  await call("wf_delete_scene_element", { world: WORLD, sceneId, elementId: npc.id });
});

// Persona round (M3): wf_apply_mutations used to blind-overwrite the bridge
// file, silently discarding queued-but-unapplied mutations (the exact gap
// foundry-ops.mjs's own doc comment flags). The raw tool now refuses.
await test("wf_apply_mutations refuses to clobber a non-empty queued-mutations bridge file", async () => {
  const { writeFileSync: wfs, mkdirSync: mks } = await import("node:fs");
  const { mutationsPath } = await import("../lib/snapshot.mjs");
  const { dirname: dn } = await import("node:path");
  const bridge = mutationsPath(dataDir, WORLD);
  mks(dn(bridge), { recursive: true });
  wfs(bridge, JSON.stringify([{ op: "upsert_entity", data: { id: "stuck-1", name: "Stuck", type: "concept" } }]), "utf8");
  const errText = await callExpectError("wf_apply_mutations", {
    world: WORLD, mutations: [{ op: "upsert_entity", data: { id: "new-1", name: "New", type: "concept" } }]
  });
  assert.match(errText, /queued-but-unapplied/, "the refusal names the actual problem");
  assert.match(errText, /1 queued/, "and counts what would have been lost");
  // The stuck queue is untouched by the refused call.
  const { readFileSync: rfs } = await import("node:fs");
  assert.match(rfs(bridge, "utf8"), /stuck-1/);
  wfs(bridge, "[]", "utf8"); // clean up so later suites see a drained queue
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

await test("briefing tools: upsert (create + patch), list in order, reorder, delete", async () => {
  const { card: a } = await call("wf_upsert_briefing_card", { world: WORLD, title: "The Premise", eyebrow: "The con", body: "<p>x</p>", span: 2 });
  const { card: b } = await call("wf_upsert_briefing_card", { world: WORLD, title: "Cast" });
  const { card: b2 } = await call("wf_upsert_briefing_card", { world: WORLD, cardId: b.id, body: "<ul><li>Vane</li></ul>" });
  assert.equal(b2.body, "<ul><li>Vane</li></ul>"); assert.equal(b2.title, "Cast");
  const { cards } = await call("wf_reorder_briefing_cards", { world: WORLD, cardIds: [b.id, a.id] });
  assert.deepEqual(cards.map((c) => c.id), [b.id, a.id]);
  assert.equal((await call("wf_delete_briefing_card", { world: WORLD, cardId: a.id })).deleted, true);
  assert.deepEqual((await call("wf_list_briefing_cards", { world: WORLD })).cards.map((c) => c.id), [b.id]);
  await callExpectError("wf_upsert_briefing_card", { world: WORLD, body: "no title" });
});

await test("wf_set_element_run carries revealTab (v4): persists with a variant, silently dropped without one, cleared by a re-set", async () => {
  const { scene } = await call("wf_create_scene", { world: WORLD, name: "Reveal wire — the cellar" });
  const { element } = await call("wf_add_scene_element", { world: WORLD, sceneId: scene.id, name: "Marek — Revealed", fields: { looks: "The smile drops." } });
  const { element: set } = await call("wf_set_element_run", { world: WORLD, sceneId: scene.id, elementId: element.id, column: "side", role: "gm", variant: "Revealed", group: "marek", revealTab: true });
  assert.deepEqual(set.run, { column: "side", role: "gm", variant: "Revealed", group: "marek", revealTab: true });
  // revealTab without a variant is meaningless — the tool drops it rather than persisting a no-op flag.
  const { element: noVariant } = await call("wf_set_element_run", { world: WORLD, sceneId: scene.id, elementId: element.id, column: "side", role: "gm", revealTab: true });
  assert.deepEqual(noVariant.run, { column: "side", role: "gm" });
});

await client.close();
rmSync(scratchDir, { recursive: true, force: true });
