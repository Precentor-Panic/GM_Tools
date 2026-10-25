import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST (2026-10-25): POST /api/session-planner/scenes/:id/foundry-link
 * records a Foundry scene ref on an UNSTAGED planner scene without staging it
 * (so no flush is scheduled), refuses a staged scene (409) and anything that is
 * not a bare Scene uuid (400), and null unlinks.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-foundry-link-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_STAGECRAFT_DIR = join(scratchDir, "stagecraft");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_SCENE_TRAY_DIR = join(scratchDir, "scene-tray");
process.env.WF_DATA_DIR = join(scratchDir, "foundrydata");
const WORLD = "foundry-link-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { createReviewServer } = await import("../server.mjs");
const { createScene, getScene, updateScene } = await import("../../session-planner/scenes.mjs");

let server, base;
before(async () => { server = createReviewServer({ port: 0 }); await new Promise((r) => server.once("listening", r)); base = `http://localhost:${server.address().port}`; });
after(async () => { await new Promise((r) => server.close(r)); rmSync(scratchDir, { recursive: true, force: true }); });
const post = async (path, body) => { const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };

test("links, stays unstaged, and unlinks", async () => {
  const s = createScene(WORLD, { name: "Under the well" }, { makeId: () => "scene-link-1" });
  const r = await post(`/api/session-planner/scenes/${s.id}/foundry-link`, { world: WORLD, foundrySceneRef: "Scene.lsEh2uGTAduxMERW" });
  assert.equal(r.status, 200);
  assert.equal(r.body.scene.foundrySceneRef, "Scene.lsEh2uGTAduxMERW");
  assert.equal(getScene(WORLD, s.id).stagedForFoundry, false, "linking never stages");
  const u = await post(`/api/session-planner/scenes/${s.id}/foundry-link`, { world: WORLD, foundrySceneRef: null });
  assert.equal(u.body.scene.foundrySceneRef, null);
});

test("refuses a malformed ref and a staged scene", async () => {
  const s = createScene(WORLD, { name: "Staged" }, { makeId: () => "scene-link-2" });
  for (const bad of ["Actor.lsEh2uGTAduxMERW", "Scene.short", "../x", 5]) {
    assert.equal((await post(`/api/session-planner/scenes/${s.id}/foundry-link`, { world: WORLD, foundrySceneRef: bad })).status, 400, String(bad));
  }
  updateScene(WORLD, s.id, { stagedForFoundry: true });
  assert.equal((await post(`/api/session-planner/scenes/${s.id}/foundry-link`, { world: WORLD, foundrySceneRef: "Scene.lsEh2uGTAduxMERW" })).status, 409);
});
