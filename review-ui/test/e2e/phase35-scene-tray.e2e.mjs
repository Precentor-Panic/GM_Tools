// Phase 35 task 35.0 -- QE-first e2e contract, part 3: the SHARED scene
// tray on all four Library surfaces (README §H/"Ported once, used
// everywhere" -- "implement once"). Read phase35-fixture.mjs FIRST (§7 tray
// roster persistence, §10 UI/DOM contract's own "SCENE TRAY" section).
//
// EXPECTED-RED reasons: `[data-testid="scene-tray"]` does not exist anywhere
// in review-ui/public/ today (grep-confirmed) -- every locator below is a
// genuine selector-not-found/timeout. The underlying
// `POST .../tray/drop`/`GET .../tray` routes also 404 today (§8).
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupPhase35Env,
  cleanupScratchEnv,
  primeWorldSelection,
  createSceneViaRoute,
  writeFoundryIndexFixture,
  pullActorsViaRoute,
  makeStagecraftAsset,
  seedStagecraftAssets,
  fetchSceneTrayViaRoute,
  setSceneTrayBudgetViaRoute,
  DESKTOP_VIEWPORT
} from "./phase35-fixture.mjs";

const { scratchDir, dataDir } = setupPhase35Env("gm-tools-e2e-p35tray-");
const WORLD = "e2e-p35-scene-tray";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { acceptBestiaryEntry } = await import("../../../combat-planning/bestiary-store.mjs");
const { acceptPartyMember } = await import("../../../combat-planning/party-roster-store.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });
writeFoundryIndexFixture(dataDir, WORLD);

const LANTERN = makeStagecraftAsset({
  id: "sc_lantern_prop", world: WORLD, kind: "splash", name: "Lantern-lit Stairwell",
  tags: ["prop"], status: "accepted"
});
seedStagecraftAssets(WORLD, [LANTERN]);

let server, base, browser, scene, ogrekinId, kestrelId;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();

  const pulled = await pullActorsViaRoute(base, WORLD);
  const ogrekin = pulled.bestiaryProposed.find((e) => e.rawFields.name === "Ogrekin Skirmisher");
  acceptBestiaryEntry(ogrekin.id);
  ogrekinId = ogrekin.id;
  const kestrel = pulled.partyProposed[0];
  acceptPartyMember(WORLD, kestrel.id);
  kestrelId = kestrel.id;

  scene = await createSceneViaRoute(base, WORLD, { objectiveNote: "Clear the lower cells." });
  await setSceneTrayBudgetViaRoute(base, WORLD, scene.id, 1800); // no-op today (404) -- harmless when red
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

// Native HTML5 drag-drop via the REAL source element + a SHARED DataTransfer,
// same technique as phase33-world-drop-to-planner.e2e.mjs/
// phase31-interactions.e2e.mjs (Playwright's own dragTo()/hover-mouse
// helpers do not reliably fire this app's real dragstart/drop listeners).
async function nativeDnD(page, srcSel, tgtSel) {
  await page.evaluate(({ srcSel, tgtSel }) => {
    const src = document.querySelector(srcSel);
    const tgt = document.querySelector(tgtSel);
    if (!src) throw new Error("drag SOURCE not found: " + srcSel);
    if (!tgt) throw new Error("drop TARGET not found: " + tgtSel);
    const dt = new DataTransfer();
    const ev = (type) => new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt });
    src.dispatchEvent(ev("dragstart"));
    tgt.dispatchEvent(ev("dragover"));
    tgt.dispatchEvent(ev("drop"));
    src.dispatchEvent(ev("dragend"));
  }, { srcSel, tgtSel });
}

// ---------------------------------------------------------------------------
// 1. DROP -> ROSTER {id,n,kind}, CREATURE STACKING ×N
// ---------------------------------------------------------------------------
test("dropping a Bestiary creature card onto the scene tray creates a roster entry {id,n:1,kind:'creature'}; a SECOND drop of the same creature stacks to n:2", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#library`);
  await page.locator('[data-testid="library-bestiary-root"]').waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="scene-tray"]').waitFor({ state: "visible", timeout: 10000 });

  const cardSel = '[data-testid="library-creature-card"][data-entry-id="' + ogrekinId + '"]';
  const rowSel = `[data-testid="scene-tray-scene-row"][data-scene-id="${scene.id}"]`;
  await page.locator(cardSel).waitFor({ state: "visible", timeout: 10000 });
  await page.locator(rowSel).waitFor({ state: "visible", timeout: 10000 });

  await nativeDnD(page, cardSel, rowSel);
  await page.waitForFunction(
    (rowSel) => document.querySelector(rowSel)?.querySelector('[data-testid="scene-tray-roster-chip"]') != null,
    rowSel,
    { timeout: 10000 }
  );

  let tray = await fetchSceneTrayViaRoute(base, WORLD, scene.id);
  assert.equal(tray.status, 200, "the tray route must be live once this is green");
  assert.deepEqual(tray.body.roster, [{ id: ogrekinId, n: 1, kind: "creature" }]);

  await nativeDnD(page, cardSel, rowSel);
  await page.waitForFunction(
    () => /×2/.test(document.querySelector('[data-testid="scene-tray-roster-chip"]')?.textContent ?? ""),
    null,
    { timeout: 10000 }
  );
  tray = await fetchSceneTrayViaRoute(base, WORLD, scene.id);
  assert.deepEqual(tray.body.roster, [{ id: ogrekinId, n: 2, kind: "creature" }], "a second drop of the SAME creature must stack (n:2), not create a second row");

  const chipText = await page.locator(`${rowSel} [data-testid="scene-tray-roster-chip"][data-kind="creature"]`).textContent();
  assert.match(chipText ?? "", /×2/, `stacked chip must show the ×N count, got "${chipText}"`);

  await page.close();
});

test("dropping a hero card resets to n:1 on a repeat drop (never stacks); dropping a Stagecraft asset also lands at n:1", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const rowSel = `[data-testid="scene-tray-scene-row"][data-scene-id="${scene.id}"]`;

  await page.goto(`${base}/#library/hall`);
  await page.locator('[data-testid="library-hall-root"]').waitFor({ state: "visible", timeout: 15000 });
  const heroCardSel = `[data-testid="library-hero-card"][data-member-id="${kestrelId}"]`;
  await page.locator(heroCardSel).waitFor({ state: "visible", timeout: 10000 });
  await page.locator(rowSel).waitFor({ state: "visible", timeout: 10000 });
  await nativeDnD(page, heroCardSel, rowSel);
  await nativeDnD(page, heroCardSel, rowSel); // repeat -- must NOT stack

  let tray = await fetchSceneTrayViaRoute(base, WORLD, scene.id);
  const heroEntry = tray.body.roster.find((r) => r.kind === "hero" && r.id === kestrelId);
  assert.ok(heroEntry, "hero roster entry must exist after a drop");
  assert.equal(heroEntry.n, 1, "a hero drop must NEVER stack past n:1, even on repeat drops");

  await page.goto(`${base}/#library/stagecraft`);
  await page.locator('[data-testid="library-stagecraft-root"]').waitFor({ state: "visible", timeout: 15000 });
  const assetRowSel = '[data-testid="tagged-shelf-row"][data-item-id="sc_lantern_prop"]';
  await page.locator(assetRowSel).waitFor({ state: "visible", timeout: 10000 });
  await page.locator(rowSel).waitFor({ state: "visible", timeout: 10000 });
  await nativeDnD(page, assetRowSel, rowSel);

  tray = await fetchSceneTrayViaRoute(base, WORLD, scene.id);
  const assetEntry = tray.body.roster.find((r) => r.kind === "asset" && r.id === "sc_lantern_prop");
  assert.ok(assetEntry, "asset roster entry must exist after a Stagecraft-shelf drop");
  assert.equal(assetEntry.n, 1);

  await page.close();
});

// ---------------------------------------------------------------------------
// 2. THE TRAY IS THE SAME COMPONENT ON EVERY SURFACE
// ---------------------------------------------------------------------------
test("the roster set from a drop on the Bestiary tab is IMMEDIATELY visible in the tray on the Reliquary tab (one shared component, not four copies)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const rowSel = `[data-testid="scene-tray-scene-row"][data-scene-id="${scene.id}"]`;

  await page.goto(`${base}/#library`);
  await page.locator('[data-testid="library-bestiary-root"]').waitFor({ state: "visible", timeout: 15000 });
  const cardSel = `[data-testid="library-creature-card"][data-entry-id="${ogrekinId}"]`;
  await page.locator(cardSel).waitFor({ state: "visible", timeout: 10000 });
  await nativeDnD(page, cardSel, rowSel);
  await page.waitForFunction(
    (rowSel) => document.querySelector(rowSel)?.querySelector('[data-testid="scene-tray-roster-chip"]') != null,
    rowSel, { timeout: 10000 }
  );

  await page.goto(`${base}/#library/reliquary`);
  await page.locator('[data-testid="library-reliquary-root"]').waitFor({ state: "visible", timeout: 15000 });
  await page.locator(rowSel).waitFor({ state: "visible", timeout: 10000 });
  const chip = page.locator(`${rowSel} [data-testid="scene-tray-roster-chip"][data-kind="creature"][data-source-id="${ogrekinId}"]`);
  await chip.waitFor({ state: "visible", timeout: 8000 });

  await page.close();
});

// ---------------------------------------------------------------------------
// 3. XP METER TEXT "N / budget xp" -- AND the explicit no-verdict-language guard
// ---------------------------------------------------------------------------
test('XP meter renders literally "N / budget xp" for a scene with a set budget and a dropped creature, and NO verdict word (deadly/hard/easy/trivial/medium) appears anywhere in the tray', async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const rowSel = `[data-testid="scene-tray-scene-row"][data-scene-id="${scene.id}"]`;

  await page.goto(`${base}/#library`);
  await page.locator('[data-testid="library-bestiary-root"]').waitFor({ state: "visible", timeout: 15000 });
  const cardSel = `[data-testid="library-creature-card"][data-entry-id="${ogrekinId}"]`;
  await page.locator(cardSel).waitFor({ state: "visible", timeout: 10000 });
  await nativeDnD(page, cardSel, rowSel);

  const meter = page.locator(`${rowSel} [data-testid="scene-tray-xp-meter"]`);
  await meter.waitFor({ state: "visible", timeout: 10000 });
  const meterText = (await meter.textContent()) ?? "";
  assert.match(meterText, /^\d+ \/ \d+ xp$/i, `XP meter text must be the literal "N / budget xp" form, got "${meterText}"`);

  const trayText = ((await page.locator('[data-testid="scene-tray"]').textContent()) ?? "").toLowerCase();
  assert.doesNotMatch(
    trayText,
    /\b(deadly|trivial|easy|hard|medium)\b/,
    "the scene tray must NEVER render verdict/difficulty language -- the Encounter Builder stays the difficulty tool (locked decision)"
  );

  await page.close();
});

// ---------------------------------------------------------------------------
// 4. REMOVING A ROSTER ROW
// ---------------------------------------------------------------------------
test("clicking a roster chip's ✕ removes that row entirely (a real persisted removal, not a decrement)", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const rowSel = `[data-testid="scene-tray-scene-row"][data-scene-id="${scene.id}"]`;

  await page.goto(`${base}/#library`);
  await page.locator('[data-testid="library-bestiary-root"]').waitFor({ state: "visible", timeout: 15000 });
  const cardSel = `[data-testid="library-creature-card"][data-entry-id="${ogrekinId}"]`;
  await page.locator(cardSel).waitFor({ state: "visible", timeout: 10000 });
  await nativeDnD(page, cardSel, rowSel);

  const chip = page.locator(`${rowSel} [data-testid="scene-tray-roster-chip"][data-kind="creature"][data-source-id="${ogrekinId}"]`);
  await chip.waitFor({ state: "visible", timeout: 10000 });
  await chip.locator('[data-testid="scene-tray-roster-chip-remove"]').click();
  await chip.waitFor({ state: "detached", timeout: 8000 });

  const tray = await fetchSceneTrayViaRoute(base, WORLD, scene.id);
  assert.ok(!tray.body.roster.some((r) => r.kind === "creature" && r.id === ogrekinId), "removed row must be gone from the persisted roster, not just hidden client-side");

  await page.close();
});
