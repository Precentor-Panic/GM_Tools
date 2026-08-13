import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * QA W2 fix (Group B #10) — pin for the "dangling locationEntityId" display
 * guard. `resolveSceneDisplayName` is duplicated verbatim across
 * plans-view.js, session-planner-view.js, app-shell.js, scene-tray.js's own
 * `sceneName`, and wf-mcp-server/lib/foundry-push-ops.mjs's `resolveSceneName`
 * (see wf-mcp-server/test/foundry-push-ops.test.mjs for that copy's own pin,
 * against the real live-snapshot lookup). Of the browser-side copies, only
 * plans-view.js and session-planner-view.js import cleanly under plain Node
 * (app-shell.js touches `document` at import time; scene-tray.js's copy is a
 * closure private to mountSceneTray) — both were made exported (additive,
 * no other behavior change) so this file can pin the fix without a DOM.
 *
 * The bug: a scene whose anchor place was DELETED (locationEntityId set, but
 * missing from the entity lookup) rendered the raw wf_ id. The fix: fall
 * back to the literal string "(place removed)" instead.
 */

const { resolveSceneDisplayName: resolvePlansView } = await import("../public/plans-view.js");
const { resolveSceneDisplayName: resolveSessionPlanner } = await import("../public/session-planner-view.js");

test("plans-view.js resolveSceneDisplayName: an explicit name still wins over everything", () => {
  const scene = { name: "The Ambush", locationEntityId: "wf_deleted_1", objectiveNote: "irrelevant" };
  assert.equal(resolvePlansView(scene, new Map()), "The Ambush");
});

test("plans-view.js resolveSceneDisplayName: a resolvable locationEntityId still shows the real place name", () => {
  const scene = { name: null, locationEntityId: "wf_place_1", objectiveNote: null };
  const infoMap = new Map([["wf_place_1", { name: "The Sunken Chapel" }]]);
  assert.equal(resolvePlansView(scene, infoMap), "The Sunken Chapel");
});

test("plans-view.js resolveSceneDisplayName: a locationEntityId missing from the lookup shows \"(place removed)\", never the raw id", () => {
  const scene = { name: null, locationEntityId: "wf_deleted_place_1", objectiveNote: null };
  const result = resolvePlansView(scene, new Map()); // empty map -- deleted/unresolvable
  assert.equal(result, "(place removed)");
  assert.doesNotMatch(result, /wf_/);
});

test("plans-view.js resolveSceneDisplayName: no locationEntityId at all still falls back to objectiveNote, then \"Ad-hoc scene\"", () => {
  assert.equal(resolvePlansView({ name: null, locationEntityId: null, objectiveNote: "A quiet moment" }, new Map()), "A quiet moment");
  assert.equal(resolvePlansView({ name: null, locationEntityId: null, objectiveNote: null }, new Map()), "Ad-hoc scene");
});

test("session-planner-view.js resolveSceneDisplayName: a locationEntityId missing from its module-level entity map shows \"(place removed)\", never the raw id", () => {
  // The module's own entityInfoMapGlobal starts as an empty Map and is only
  // ever populated by a real scene-page render (DOM-only) -- empty is
  // exactly the "couldn't resolve" case this guard exists for.
  const scene = { name: null, locationEntityId: "wf_deleted_place_2", objectiveNote: null };
  const result = resolveSessionPlanner(scene);
  assert.equal(result, "(place removed)");
  assert.doesNotMatch(result, /wf_/);
});

test("session-planner-view.js resolveSceneDisplayName: an explicit name still wins", () => {
  assert.equal(resolveSessionPlanner({ name: "Named Scene", locationEntityId: "wf_x", objectiveNote: null }), "Named Scene");
});
