// revealTab seeding (run-layout v4, narrative-state round) — the
// mid-session reveal wire, end to end:
//   - a grouped card whose "Revealed" state is marked revealTab seeds to
//     the FIRST tab while the bound entity is unrevealed;
//   - flipping the entity's reveal state via the narrative-state route
//     changes the run-version fingerprint, the 3s poll rebuilds, and the
//     card's seeded tab flips to the revealTab state WITHOUT a reload;
//   - a local tab click afterwards still overrides the seed (table
//     sovereignty), surviving the next rebuild.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase30Env,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  DESKTOP_VIEWPORT
} from "./phase30-fixture.mjs";
import { createFromGraphElementViaRoute, patchSceneElementViaRoute, createSceneElementViaRoute, updateSceneViaRoute } from "./phase29-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-run-reveal-tab-");
const WORLD = "e2e-run-reveal-tab-world";
process.env.WF_DEFAULT_WORLD = WORLD;
process.env.GM_TOOLS_NARRATIVE_STATE_DIR = `${scratchDir}/narrative-state`;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "rrt-inn", name: "The Ewer", type: "place", importance: 0.5, description: "An inn." } },
  { op: "upsert_entity", data: { id: "rrt-marek", name: "Marek", type: "person", importance: 0.6, description: "The barkeep." } }
]);

let server, base, browser;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(res.status, 200, `${path} failed`);
  return res.json();
}

test("a reveal-state flip re-seeds the marked tab on the next poll rebuild; a local click still overrides", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "rrt-inn", name: "Evening at the Ewer" });
  // The bound member: Marek attached from the graph (carries graphEntityId).
  const fromGraph = await createFromGraphElementViaRoute(base, WORLD, scene.id, { entityId: "rrt-marek", name: "Marek" });
  assert.equal(fromGraph.status, 200, `from-graph attach failed: ${JSON.stringify(fromGraph.body)}`);
  const bound = fromGraph.body.element;
  assert.equal(bound.graphEntityId, "rrt-marek", "the attached element carries the graph binding");
  const patched = await patchSceneElementViaRoute(base, WORLD, scene.id, bound.id, { run: { column: "side", role: "gm", group: "marek", variant: "Cover" } });
  assert.equal(patched.status, 200, `run patch failed: ${JSON.stringify(patched.body)}`);
  // The reveal state: no own graphEntityId — binds through the group's
  // first-bound member (the group-lead fallback).
  const revealed = (await createSceneElementViaRoute(base, WORLD, scene.id, {
    name: "Marek — Revealed",
    fields: { looks: "The smile drops; he reaches under the bar." },
    run: { column: "side", role: "gm", group: "marek", variant: "Revealed", revealTab: true }
  })).body.element;
  assert.ok(revealed?.id, "second member created");

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`).waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="mode-run-btn"]').click();
  const spread = page.locator(`[data-testid="scene-run-spread"][data-scene-id="${scene.id}"]`);
  await spread.waitFor({ state: "visible", timeout: 15000 });
  const group = spread.locator('[data-testid="rs-group"]');

  // Unrevealed (no record at all): first-tab default.
  assert.equal(await group.locator(".rs-tab--active").textContent(), "Cover");

  // The table learns the truth: flip Marek to revealed (direct sidecar
  // write — the same thing a session wrap's apply step does).
  await postJson(`/api/entities/rrt-marek/narrative-state`, { world: WORLD, revealState: "revealed" });

  // The reveal joined the run-version fingerprint, so the 3s poll rebuilds
  // and the revealTab seed lands — no reload, no local pick involved.
  await page.waitForFunction(() => {
    const active = document.querySelector('[data-testid="rs-group"] .rs-tab--active');
    return active && active.textContent === "Revealed";
  }, undefined, { timeout: 15000 });

  // Table sovereignty: the GM flips back to Cover locally…
  await page.locator('[data-testid="scene-run-spread"] [data-testid="rs-tab"][data-variant="Cover"]').click();
  assert.equal(await group.locator(".rs-tab--active").textContent(), "Cover");

  // …and another rebuild (any run-version bump) must NOT re-seed over it.
  // Rebuild detection: mark the CURRENT spread node; the poll's rebuild
  // replaces it wholesale, so the marker vanishing = a fresh render landed.
  await page.evaluate(() => document.querySelector('[data-testid="scene-run-spread"]').setAttribute("data-e2e-marker", "1"));
  await updateSceneViaRoute(base, WORLD, scene.id, { whereNote: "By the tap-room hearth" });
  await page.waitForFunction(() => {
    const s = document.querySelector('[data-testid="scene-run-spread"]');
    return s && !s.hasAttribute("data-e2e-marker");
  }, undefined, { timeout: 15000 });
  assert.equal(await group.locator(".rs-tab--active").textContent(), "Cover", "local pick survives the reveal seed on rebuild");

  await page.close();
});
