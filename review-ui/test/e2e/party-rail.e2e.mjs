// The Run view's party rail (2026-10-06). Drives the real app against a real
// Foundry-index fixture written to the world's data dir, and asserts the five
// behaviours that are only observable in a browser:
//
//   1. The toggle exists in every view but is only USABLE in Run (hidden by
//      visibility, so the sub-bar never shifts), and it opens/closes the rail.
//   2. One seat per user-claimed actor, the pack MULE excluded, the unplayed
//      blank sheet excluded, sorted by passive Perception descending.
//   3. Hover shows that seat's saves + proficient skills; leaving hides it.
//   4. Click PINS the card, and the pin SURVIVES a run-version poll rebuild
//      (the whole reason the rail is a sibling of the spread host, not a child).
//   5. Escape unpins without leaving the scene, and keyboard focus opens a card.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { setupPhase30Env, cleanupScratchEnv, createSceneViaRoute } from "./phase30-fixture.mjs";
import { createSceneElementViaRoute, saveNarrationViaRoute } from "./phase29-fixture.mjs";
import { settle } from "./layout-stability-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-party-rail-");
const WORLD = "e2e-party-rail-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath, foundryIndexPath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });

// Skills helper: dnd5e shape, only the keys a sheet actually carries.
const sk = (entries) => Object.fromEntries(
  Object.entries(entries).map(([k, [value, proficient, passive]]) => [k, { value, proficient, passive }])
);
const ability = (score, mod, save) => ({ value: score, mod, save: { roll: { min: null, max: null, mode: 0 }, value: save } });

// Three claimed seats + one unclaimed `type:"character"` MULE. The mule is the
// regression guard for deliberately NOT using classifyActor, whose documented
// `type === "character"` fallback would pull it in as a fourth party member.
const INDEX = {
  version: 1,
  worldId: WORLD,
  exportedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
  users: [
    { id: "u1", name: "Ada", characterUuid: "Actor.low" },
    { id: "u2", name: "Bo", characterUuid: "Actor.high" },
    { id: "u3", name: "Cy", characterUuid: "Actor.blank" }
  ],
  scenes: [], tokens: [], playlists: [], worldItems: [], compendia: [], journals: [],
  actors: [
    {
      uuid: "Actor.low", name: "Lowly Sharpeye & Friend", type: "character",
      items: [{ type: "class", name: "Fighter" }],
      system: {
        level: 3, ac: 16, hp: { value: 20, max: 28 },
        abilities: { str: ability(16, 3, 5), dex: ability(12, 1, 1), con: ability(14, 2, 4), int: ability(8, -1, -1), wis: ability(10, 0, 0), cha: ability(10, 0, 0) },
        skills: sk({ prc: [0, 1, 12], ath: [5, 1, 15], ins: [0, 0, 10], inv: [-1, 0, 9] })
      }
    },
    {
      uuid: "Actor.high", name: "Hawkeye Vance", type: "character",
      items: [{ type: "class", name: "Rogue" }],
      system: {
        level: 3, ac: 14, hp: { value: 18, max: 22 },
        abilities: { str: ability(10, 0, 0), dex: ability(18, 4, 6), con: ability(12, 1, 1), int: ability(14, 2, 2), wis: ability(14, 2, 4), cha: ability(12, 1, 1) },
        // Expertise (2) on Perception, so the card must mark it.
        skills: sk({ prc: [6, 2, 19], ste: [6, 2, 16], ins: [2, 1, 12], inv: [4, 1, 14] })
      }
    },
    // A claimed seat with no sheet at all — excluded from the rail (Russell,
    // 2026-10-06: a character nobody is playing is noise at the table).
    { uuid: "Actor.blank", name: "Benchwarmer", type: "character", items: [], system: { level: 0, ac: 10, hp: { value: 0, max: 0 }, abilities: {}, skills: {} } },
    // THE MULE: type character, claimed by nobody.
    { uuid: "Actor.mule", name: "Ada's Mule", type: "character", items: [], system: { level: 0, ac: 10, hp: { value: 0, max: 0 }, abilities: {}, skills: {} } }
  ]
};
writeFileSync(foundryIndexPath(dataDir, WORLD), JSON.stringify(INDEX), "utf8");

let server, base, browser, scene;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
  scene = await createSceneViaRoute(base, WORLD, { name: "The Pit — call" });
  await saveNarrationViaRoute(base, WORLD, scene.id, "Sand, torches, and a crowd already loud.");
  await createSceneElementViaRoute(base, WORLD, scene.id, {
    name: "Bench chatter", fields: { looks: "Odds changing hands." }, run: { column: "main", role: "dressing" }
  });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

async function openRun(page) {
  await page.goto(`${base}/#planner/scene/${scene.id}`);
  await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`).waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="mode-run-btn"]').click();
  await page.locator('[data-testid="scene-run-spread"]').waitFor({ state: "visible" });
  await settle(page);
}

const toggle = (page) => page.locator('[data-testid="party-rail-toggle-btn"]');
const seats = (page) => page.locator('[data-testid="party-seat"]');
const detail = (page) => page.locator('[data-testid="party-seat-detail"]');

test("the toggle keeps its slot in Prep but is only usable in Run", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${base}/#planner/scene/${scene.id}`);
    await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${scene.id}"]`).waitFor({ state: "visible", timeout: 15000 });
    await page.locator('[data-testid="mode-prep-btn"]').click();
    await settle(page);
    // Hidden by VISIBILITY, never display -- it must still occupy its box, or
    // the segmented control beside it shifts between views.
    const prep = await toggle(page).evaluate((el) => {
      const cs = getComputedStyle(el);
      return { visibility: cs.visibility, display: cs.display, width: el.getBoundingClientRect().width };
    });
    assert.equal(prep.visibility, "hidden", "the toggle is not usable in Prep");
    assert.notEqual(prep.display, "none", "the toggle must keep its slot, not be display:none");
    assert.ok(prep.width > 0, "the toggle still occupies width in Prep");

    await page.locator('[data-testid="mode-run-btn"]').click();
    await settle(page);
    assert.equal(await toggle(page).evaluate((el) => getComputedStyle(el).visibility), "visible", "usable in Run");
  } finally { await page.close(); }
});

test("the toggle opens and closes the rail, and the caret does not change its width", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await openRun(page);
    await assert.rejects(() => seats(page).first().waitFor({ state: "visible", timeout: 600 }), /Timeout|timeout/, "closed by default");
    const wClosed = await toggle(page).evaluate((el) => el.getBoundingClientRect().width);

    await toggle(page).click();
    await seats(page).first().waitFor({ state: "visible" });
    await settle(page);
    const wOpen = await toggle(page).evaluate((el) => el.getBoundingClientRect().width);
    assert.ok(Math.abs(wOpen - wClosed) < 1, `the caret flip changed the button width by ${wOpen - wClosed}px`);

    await toggle(page).click();
    await settle(page);
    assert.equal(await page.locator('[data-testid="party-rail-host"]').evaluate((el) => getComputedStyle(el).display), "none", "closes again");
  } finally { await page.close(); }
});

test("one seat per claimed sheet, mule and blank sheet excluded, sorted by passive Perception", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await openRun(page);
    await toggle(page).click();
    await seats(page).first().waitFor({ state: "visible" });
    const rows = await seats(page).evaluateAll((els) => els.map((el) => ({
      name: el.querySelector(".party-seat-n").textContent,
      passive: el.querySelector('[data-testid="party-seat-passive"]').textContent
    })));
    assert.equal(rows.length, 2, `expected 2 seats, got ${JSON.stringify(rows)}`);
    assert.ok(!rows.some((r) => /Mule/i.test(r.name)), "the pack mule must never appear as a party member");
    assert.ok(!rows.some((r) => /Benchwarmer/.test(r.name)), "a claimed seat with no sheet is excluded");
    assert.deepEqual(rows.map((r) => r.passive), ["19", "12"], "sorted by passive Perception, descending");
    // compactLabel trims at the "&"
    assert.equal(rows[1].name, "Lowly Sharpeye", "the rail label is compacted for a two-name actor");
    // Honest staleness: a 2-day-old index is past the 15-minute threshold.
    const asOf = await page.locator('[data-testid="party-rail-asof"]').textContent();
    assert.match(asOf, /^as of /, `expected an as-of line, got ${JSON.stringify(asOf)}`);
  } finally { await page.close(); }
});

test("hover shows saves and proficient skills with expertise marked; leaving hides it", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await openRun(page);
    await toggle(page).click();
    await seats(page).first().waitFor({ state: "visible" });

    await seats(page).first().hover();
    await detail(page).waitFor({ state: "visible" });
    const card = await detail(page).innerText();
    assert.match(card, /Hawkeye Vance/, "the card names the hovered PC");
    assert.match(card, /Rogue 3/, "class and level");
    assert.match(card, /AC 14/);
    assert.match(card, /HP 22/, "HP MAX, never the current value");
    assert.ok(!/HP 18/.test(card), "the current HP must not be shown — it stays in Foundry");
    assert.match(card, /Perception/, "proficient skills are listed");
    assert.ok(await detail(page).locator(".psk-x").count() > 0, "expertise is marked");
    const saves = await detail(page).locator(".party-saves div").evaluateAll((els) => els.map((e) => e.textContent.replace(/\s+/g, "")));
    assert.equal(saves.length, 6, "all six saves");
    assert.ok(saves.some((t) => /DEX\+6/.test(t)), `the {roll,value} save object must be unwrapped: ${JSON.stringify(saves)}`);

    // Move the pointer well off the rail; the card closes after its grace timer.
    await page.mouse.move(10, 10);
    await detail(page).waitFor({ state: "hidden", timeout: 3000 });
  } finally { await page.close(); }
});

test("click pins the card, the pin survives a poll rebuild, and Escape unpins", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await openRun(page);
    await toggle(page).click();
    await seats(page).first().waitFor({ state: "visible" });

    await seats(page).first().click();
    await detail(page).waitFor({ state: "visible" });
    assert.match(await detail(page).innerText(), /pinned/i, "the card says it is pinned");

    // Beautification pass (2026-10-07): the ROW must show it too. `.party-seat
    // --pinned` was toggled in JS and had no CSS rule anywhere, so a pinned
    // seat was pixel-identical to a merely hovered one -- the feature's
    // headline gesture rendered no state on the thing you clicked. Asserted
    // against the HOVERED appearance specifically, since matching hover is the
    // exact bug: a rule that only repeated hover's background would pass a
    // naive "has a background" check.
    const boxOf = (n) => seats(page).nth(n).evaluate((el) => {
      const cs = getComputedStyle(el);
      return { shadow: cs.boxShadow, bg: cs.backgroundColor };
    });
    const pinnedBox = await boxOf(0);

    // Pin wins over hover: hovering the other seat must not steal the card.
    await seats(page).nth(1).hover();
    await settle(page);
    const hoveredBox = await boxOf(1);
    assert.notDeepEqual(
      pinnedBox, hoveredBox,
      "a pinned seat must not look identical to a hovered one"
    );
    assert.notEqual(pinnedBox.shadow, "none", "the pinned seat carries its own rule");
    assert.match(await detail(page).innerText(), /Hawkeye Vance/, "hovering another seat must not steal a pinned card");

    // Change the scene so the 3s run-version poll rebuilds the spread. The rail
    // is a SIBLING of the rebuilt host, so the pin must survive.
    await createSceneElementViaRoute(base, WORLD, scene.id, {
      name: "A late arrival", fields: { looks: "Someone shoulders in at the north gate." }, run: { column: "main", role: "dressing" }
    });
    await page.locator('[data-testid="scene-run-updated"]').waitFor({ state: "visible", timeout: 12000 });
    assert.ok(await detail(page).isVisible(), "the pinned card survived the rebuild");
    assert.match(await detail(page).innerText(), /Hawkeye Vance/, "and it is still the same PC");

    await page.keyboard.press("Escape");
    await detail(page).waitFor({ state: "hidden" });
    // Escape unpinned the card WITHOUT leaving the scene.
    await page.locator('[data-testid="scene-run-spread"]').waitFor({ state: "visible" });
  } finally { await page.close(); }
});

test("a seat is keyboard reachable and focus opens its card", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await openRun(page);
    await toggle(page).click();
    await seats(page).first().waitFor({ state: "visible" });
    await seats(page).first().focus();
    await detail(page).waitFor({ state: "visible" });
    assert.match(await detail(page).innerText(), /Hawkeye Vance/, "focus opens the card");
    await page.keyboard.press("Enter");
    await settle(page);
    assert.match(await detail(page).innerText(), /pinned/i, "Enter pins it");
  } finally { await page.close(); }
});

test("at phone width the rail is always present and the toggle is gone", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await openRun(page);
    assert.equal(await toggle(page).evaluate((el) => getComputedStyle(el).display), "none", "no toggle at phone width");
    await seats(page).first().waitFor({ state: "visible", timeout: 8000 });
    assert.equal(await seats(page).count(), 2, "the rail renders without the toggle");
    // The card goes inline rather than floating over a 390px screen.
    await seats(page).first().click();
    await detail(page).waitFor({ state: "visible" });
    assert.equal(await detail(page).evaluate((el) => getComputedStyle(el).position), "static", "the card is inline at phone width");
  } finally { await page.close(); }
});
