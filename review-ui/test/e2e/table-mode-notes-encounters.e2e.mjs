// Phase 25 task 25.0, REQUIRED SCENARIO 8 -- "Notes + encounters interleave:
// seed both a note and a saved encounter on one scene, assert both render
// in one unified zone (not two separately-sized sections)." Read
// table-mode-fixture.mjs's header FIRST (§5 is this file's own section).
// EXPECTED TO FAIL right now -- none of `table-notes-encounters-zone`/
// `table-notes-encounters-item` exists yet. That failure is the deliverable
// of this task, not a bug in this file.
//
// "One unified zone, not two separately-sized sections" (design record §3,
// Phase 21 §6's standing equal-weight rule) is asserted the SAME measurable
// way scene-construction-events-encounters.e2e.mjs's own equal-weight test
// already established for Add Event/Add Encounter: same real parentElement,
// not merely "both exist somewhere on the page."
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupSceneConstructionEnv,
  cleanupScratchEnv,
  createSceneViaRoute,
  primeWorldSelection,
  gotoTableMode,
  DESKTOP_VIEWPORT
} from "./table-mode-fixture.mjs";

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-tablemode-notesenc-");
const WORLD = "e2e-tablemode-notesenc-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { saveBestiaryEntry, acceptBestiaryEntry } = await import("../../../combat-planning/bestiary-store.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "tmnotesenc-anchor", name: "Notes Encounters Anchor", type: "place", importance: 0.5 } }
]);

const bestiaryEntry = saveBestiaryEntry({
  rawFields: { name: "Interleave Test Wolf", type: "beast", hp: 11, ac: 13, attacks: [{ name: "Bite", toHitBonus: 4, damageDice: "2d4+2", damageType: "piercing" }] },
  derivedScore: null
});
acceptBestiaryEntry(bestiaryEntry.id);

let server, base, browser, page;
let scene, note, encounterId;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmnotesenc-anchor" });

  const noteRes = await fetch(`${base}/api/session-planner/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, text: "A real pending scene note for the interleave test.", anchorEntityId: "tmnotesenc-anchor", sceneId: scene.id })
  });
  const noteBody = await noteRes.json();
  assert.equal(noteRes.status, 200, `note setup itself must succeed -- broken test setup, not the thing under test (got ${noteRes.status}: ${JSON.stringify(noteBody)})`);
  note = noteBody.note;

  const encRes = await fetch(`${base}/api/scene-planning/scenes/${scene.id}/encounters`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      world: WORLD,
      name: "Interleave Test Encounter",
      combination: [{ entryId: bestiaryEntry.id, count: 1 }],
      knobs: {},
      scoreSnapshot: { expectedScore: 1, burstCeiling: 1, snowballDelta: {}, asymmetricRiskFlag: false }
    })
  });
  const encBody = await encRes.json();
  assert.equal(encRes.status, 200, `encounter setup itself must succeed -- broken test setup, not the thing under test (got ${encRes.status}: ${JSON.stringify(encBody)})`);
  encounterId = encBody.encounter.id;

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("both the note and the saved encounter render as items in ONE unified zone, DOM siblings under the same parent", async () => {
  await gotoTableMode(page, base, scene.id);

  const zone = page.locator('[data-testid="table-notes-encounters-zone"]');
  await zone.waitFor({ state: "visible", timeout: 15000 });

  const noteItem = zone.locator(`[data-testid="table-notes-encounters-item"][data-item-type="note"][data-item-id="${note.id}"]`);
  const encounterItem = zone.locator(`[data-testid="table-notes-encounters-item"][data-item-type="encounter"][data-item-id="${encounterId}"]`);
  await noteItem.waitFor({ state: "visible", timeout: 10000 });
  await encounterItem.waitFor({ state: "visible", timeout: 10000 });

  assert.match((await noteItem.locator('[data-testid="table-note-text"]').textContent()) ?? "", /A real pending scene note/);
  assert.match((await encounterItem.locator('[data-testid="table-encounter-name"]').textContent()) ?? "", /Interleave Test Encounter/);

  const [noteParent, encounterParent] = await Promise.all([
    noteItem.evaluateHandle((el) => el.parentElement),
    encounterItem.evaluateHandle((el) => el.parentElement)
  ]);
  assert.equal(
    await page.evaluate(([a, b]) => a === b, [noteParent, encounterParent]),
    true,
    "the note item and the encounter item must be DOM siblings under the SAME parent -- 'interleaved,' not two separately-sized sections each with their own wrapping container"
  );

  // Both items must also be direct children of the zone itself (not nested
  // one level deeper inside a per-type sub-list), confirming there's
  // genuinely ONE list, not two lists that happen to share a parentElement
  // reference by coincidence.
  const zoneHandle = await zone.elementHandle();
  const bothAreZoneChildren = await page.evaluate(
    ([z, n, e]) => z.contains(n) && n.parentElement === z && z.contains(e) && e.parentElement === z,
    [zoneHandle, await noteItem.elementHandle(), await encounterItem.elementHandle()]
  );
  assert.equal(bothAreZoneChildren, true, "both items must be DIRECT children of table-notes-encounters-zone itself");
});
