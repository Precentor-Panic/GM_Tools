// Session wrap-up panel (Plan page, narrative-state layer): the withheld
// roster renders, suggest degrades honestly keyless, a GM-selected
// transition applies as a real sidecar write (source:"wrap"), the offline
// player truth-notes recap generates + persists across a full reload, and
// the roster empties once nothing is withheld. Keyless end to end (this
// process never sets ANTHROPIC_API_KEY — the offline degrade IS the path
// under test for the two LLM calls).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupPhase30Env, cleanupScratchEnv, createSceneViaRoute, primeWorldSelection, DESKTOP_VIEWPORT } from "./phase30-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-session-wrap-");
const WORLD = "e2e-session-wrap-world";
process.env.WF_DEFAULT_WORLD = WORLD;
process.env.GM_TOOLS_NARRATIVE_STATE_DIR = `${scratchDir}/narrative-state`;
process.env.GM_TOOLS_TRUTH_NOTES_DIR = `${scratchDir}/truth-notes`;
process.env.WF_TIMELINE_GIT = "0";
delete process.env.ANTHROPIC_API_KEY;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "sw-inn", name: "The Ewer", type: "place", importance: 0.5 } },
  { op: "upsert_entity", data: { id: "sw-vane", name: "Corvin Vane", type: "person", importance: 0.9 } }
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

async function api(path, body) {
  const res = await fetch(`${base}${path}`, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  assert.ok(res.status < 400, `${path} -> ${res.status}`);
  return res.json();
}

test("roster → keyless suggest → manual override → apply (real sidecar write) → offline recap persists across reload", async () => {
  // Seed: a withheld truth, and a plan with one scene.
  await api(`/api/entities/sw-vane/narrative-state`, { world: WORLD, truth: "He drains the Source.", stance: "concealing" });
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "sw-inn", name: "Evening at the Ewer" });
  const { plan } = await api(`/api/scene-planning/plans`, { world: WORLD, name: "Session Three" });
  await api(`/api/scene-planning/plans/${plan.id}/scenes`, { world: WORLD, sceneId: scene.id });

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#plans/${plan.id}`);
  await page.locator('[data-testid="plan-detail"]').waitFor({ state: "visible", timeout: 15000 });

  const panel = page.locator('[data-testid="session-wrap-panel"]');
  await panel.locator("summary").click();
  const row = panel.locator('[data-testid="wrap-reveal-row"][data-entity-id="sw-vane"]');
  await row.waitFor({ state: "visible", timeout: 10000 });
  assert.match(await row.textContent(), /Corvin Vane/);
  assert.match(await row.textContent(), /unrevealed · concealing/);

  // Keyless suggest: an honest "no key" message, never a fake suggestion.
  await panel.locator('[data-testid="wrap-suggest-btn"]').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="wrap-status"]')?.textContent.includes("No API key")
  , undefined, { timeout: 10000 });

  // GM overrides by hand and applies.
  await row.locator('[data-testid="wrap-reveal-select"]').selectOption("revealed");
  await panel.locator('[data-testid="wrap-apply-btn"]').click();
  const notes = panel.locator('[data-testid="wrap-truth-notes-md"]');
  await notes.waitFor({ state: "visible", timeout: 15000 });
  assert.match(await notes.textContent(), /Offline/i, "keyless recap is honestly labeled");

  // The apply was a REAL sidecar write with wrap provenance.
  const { narrativeState } = await api(`/api/entities/sw-vane/narrative-state?world=${WORLD}`);
  assert.equal(narrativeState.revealState, "revealed");
  const last = narrativeState.transitions.at(-1);
  assert.equal(last.source, "wrap");

  // Reload: nothing withheld anymore, and the recap came back from the store.
  await page.reload();
  await page.locator('[data-testid="plan-detail"]').waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="session-wrap-panel"] summary').click();
  await page.locator('[data-testid="wrap-roster-empty"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-testid="wrap-truth-notes-md"]').waitFor({ state: "visible", timeout: 10000 });

  await page.close();
});
