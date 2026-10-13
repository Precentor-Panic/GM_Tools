// Notes at the table (WS-D, table round 2026-09-09). The Add Event control
// used to be write-only -- every autosave POSTed a NEW note (the "notes save
// — duplicated" gap) and nothing ever read them back. Now: the control
// creates one note and edits it in place as the GM types, Enter starts the
// next one, and a "Notes — this scene" strip in both Run (side column) and
// Prep reads them back, refreshed on the Run poll so a note jotted from
// another seat lands without a reload. Asserted against the real DOM AND
// the real store (the GET route), never just the visible text.
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
import { createSceneElementViaRoute } from "./phase29-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-run-notes-");
const WORLD = "e2e-run-notes-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "rn-pit", name: "The Pit", type: "place", importance: 0.6 } }
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

async function waitFor(fn, { timeout = 10000, every = 200 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeout) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, every));
  }
}

async function storedNotes(sceneId) {
  const res = await fetch(`${base}/api/session-planner/notes?world=${WORLD}&sceneId=${sceneId}`);
  return (await res.json()).notes;
}

test("a note jotted in Run is saved ONCE, read back in the side strip, survives a poll rebuild, and Enter starts a fresh note", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "rn-pit", name: "Fight night" });
  await createSceneElementViaRoute(base, WORLD, scene.id, { name: "Read Aloud — Opening", fields: { looks: "The tiers are full." }, run: { column: "main", role: "read" } });

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`).waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="mode-run-btn"]').click();
  const spread = page.locator('[data-testid="scene-run-spread"]');
  await spread.waitFor({ state: "visible", timeout: 15000 });

  // Empty strip is hidden, not an empty header.
  assert.equal(await page.locator('[data-testid="run-notes-strip"]').isVisible(), false);

  // The control sits in the scene toolbar; clicking opens its drop-down with focus.
  await page.locator('[data-testid="run-add-event-btn"]').click();
  const textarea = page.locator('.scene-event-pop [data-testid="scene-event-textarea"]');
  await textarea.waitFor({ state: "visible" });
  assert.equal(await textarea.evaluate((el) => document.activeElement === el), true, "textarea takes focus on open");

  // Type in three bursts, well past the debounce each time: ONE note, edited in place.
  await textarea.type("Vane re-opened");
  await page.waitForTimeout(900);
  await textarea.type(" the number");
  await page.waitForTimeout(900);
  await textarea.type(" -- twice");
  await waitFor(async () => {
    const n = await storedNotes(scene.id);
    return n.length === 1 && n[0].text === "Vane re-opened the number -- twice";
  });
  const [first] = await storedNotes(scene.id);
  assert.equal(first.sceneId, scene.id);

  // The strip reads it back (on the next poll tick).
  const strip = page.locator('[data-testid="run-notes-strip"]');
  await waitFor(async () => (await strip.locator('[data-testid="scene-note-row"]').count()) === 1);
  assert.match(await strip.textContent(), /Notes — this scene \(1\)/);
  assert.match(await strip.locator('[data-testid="scene-note-row"]').first().textContent(), /Vane re-opened the number -- twice/);
  assert.equal(await strip.locator('[data-testid="scene-note-row"]').first().getAttribute("data-note-id"), first.id);

  // Enter flushes and starts a NEW note; the first stays a single record.
  await textarea.press("Enter");
  await waitFor(async () => (await textarea.inputValue()) === "");
  await textarea.type("Marek arrived early");
  await waitFor(async () => (await storedNotes(scene.id)).length === 2);
  const after = await storedNotes(scene.id);
  assert.deepEqual(after.map((n) => n.text), ["Vane re-opened the number -- twice", "Marek arrived early"]);
  assert.equal(after[0].id, first.id, "Enter did not re-save the first note under a new id");

  // A change from elsewhere forces a full spread rebuild; the strip must come back populated.
  await createSceneElementViaRoute(base, WORLD, scene.id, { name: "Read Aloud — Later", fields: { looks: "The bell." }, run: { column: "main", role: "read" } });
  await waitFor(async () => (await page.locator('[data-testid="scene-run-updated"]').count()) === 1, { timeout: 12000 });
  const rebuilt = page.locator('[data-testid="run-notes-strip"]');
  await waitFor(async () => (await rebuilt.locator('[data-testid="scene-note-row"]').count()) === 2);
  assert.match(await rebuilt.textContent(), /Notes — this scene \(2\)/);

  // ✕ deletes through the route and the strip drops the row.
  await rebuilt.locator('[data-testid="scene-note-row"]').last().locator('[data-testid="scene-note-delete"]').click();
  await waitFor(async () => (await storedNotes(scene.id)).length === 1);
  await waitFor(async () => (await rebuilt.locator('[data-testid="scene-note-row"]').count()) === 1);
  assert.deepEqual((await storedNotes(scene.id)).map((n) => n.text), ["Vane re-opened the number -- twice"]);

  // Prep shows the same strip (the Add Event control there feeds it too).
  await page.locator('[data-testid="mode-prep-btn"]').click();
  const prepStrip = page.locator('[data-testid="scene-notes-strip"]');
  await waitFor(async () => (await prepStrip.locator('[data-testid="scene-note-row"]').count()) === 1);
  assert.match(await prepStrip.textContent(), /Vane re-opened the number -- twice/);
  await page.close();
});
