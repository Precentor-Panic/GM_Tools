// Run-spread consolidation pass -- the composite-card (`run.group`) and
// auto-fold contracts as rendered in a REAL browser: interleaved dressing
// hoists into ONE card near the top of MAIN, and a grouped cluster (a
// payload card + its outcome read-alouds) renders as ONE card whose member
// sections come and go with `scene.activeVariants` while the card itself
// stays. The pure rules live in run-layout.mjs's planRunSpread (unit-tested
// in test/run-plan.test.mjs); this file pins the rendered DOM.
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
import { createSceneElementViaRoute, updateSceneViaRoute } from "./phase29-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-run-group-");
const WORLD = "e2e-run-group-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "rg-hall", name: "The Hall", type: "place", importance: 0.6, description: "A guild hall." } }
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

async function makeEl(sceneId, payload) {
  const r = await createSceneElementViaRoute(base, WORLD, sceneId, payload);
  assert.equal(r.status, 200, `element create failed: ${JSON.stringify(r.body)}`);
  return r.body.element;
}

async function openRun(sceneId) {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${sceneId}`);
  const root = page.locator(`[data-testid="planner-scene-view"][data-scene-id="${sceneId}"]`);
  await root.waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="scene-elements-list"]').waitFor({ timeout: 15000 });
  await page.locator('[data-testid="mode-run-btn"]').click();
  const spread = page.locator('[data-testid="scene-run-spread"]');
  await spread.waitFor({ state: "visible", timeout: 15000 });
  return { page, spread };
}

test("interleaved dressing hoists into ONE card above the beats, whatever the Prep order was", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "rg-hall", name: "Interleaved scene" });
  // Deliberately Kilmarn-retro-shaped interleaving: dressing scattered
  // between reads and beats (neutral names -- fixtures stay world-agnostic).
  await makeEl(scene.id, { name: "The banner", fields: { looks: "Faded." }, run: { column: "main", role: "dressing" } });
  await makeEl(scene.id, { name: "Read Aloud — Opening", fields: { looks: "Dust in the light." }, run: { column: "main", role: "read" } });
  await makeEl(scene.id, { name: "The argument", fields: { gives: "Names names." }, run: { column: "main", role: "beat" } });
  await makeEl(scene.id, { name: "The ledger", fields: { looks: "Open." }, run: { column: "main", role: "dressing" } });
  await makeEl(scene.id, { name: "The clerk", fields: { gives: "Counts on." }, run: { column: "main", role: "beat" } });
  await makeEl(scene.id, { name: "The chest", fields: { looks: "Locked." }, run: { column: "main", role: "dressing" } });

  const { page, spread } = await openRun(scene.id);
  const main = spread.locator(".rs-main");

  const dress = main.locator('[data-testid="rs-dressing-card"]');
  assert.equal(await dress.count(), 1, "exactly ONE dressing card despite the interleaving");
  assert.deepEqual(
    await dress.locator("li b").allTextContents(),
    ["The banner", "The ledger", "The chest"],
    "all three dressing rows, stable by order"
  );

  // Position: the read opens, the dressing card follows, the beats after.
  const headings = await main.locator(".rs-h").allTextContents();
  assert.equal(headings[0], "Opening", "the read-aloud opens the column");
  assert.equal(headings[1], "Dressing", "the dressing card sits directly after the opener");
  assert.deepEqual(headings.slice(2), ["The argument", "The clerk"], "beats keep their order below");
  await page.close();
});

test("a grouped cluster renders as ONE composite card; variant members swap with activeVariants while the card stays", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "rg-hall", name: "Group scene" });
  // The retro's P-2 shape, world-agnostic: a payload card leads, an outcome
  // beat and two variant read-alouds ride on the same card.
  await makeEl(scene.id, {
    name: "Charm — The Held Word",
    fields: { gives: '"A promise keeps whoever made it."', looks: "Binds the speaker to their last oath." },
    run: { column: "main", role: "card", group: "held-word" }
  });
  await makeEl(scene.id, {
    name: "Beat — Breaking it",
    fields: { gives: "The oath-breaker's voice fails for a day." },
    run: { column: "main", role: "beat", group: "held-word" }
  });
  await makeEl(scene.id, {
    name: "Read Aloud — Kept",
    fields: { looks: "The word holds, and the room settles." },
    run: { column: "main", role: "read", group: "held-word", variant: "Kept" }
  });
  await makeEl(scene.id, {
    name: "Read Aloud — Broken",
    fields: { looks: "The word snaps; every head turns." },
    run: { column: "main", role: "read", group: "held-word", variant: "Broken" }
  });
  // An ungrouped sibling proves the group pulls in ONLY its members.
  await makeEl(scene.id, { name: "The witness", fields: { gives: "Saw it all." }, run: { column: "main", role: "beat" } });

  let { page, spread } = await openRun(scene.id);
  let group = spread.locator('[data-testid="rs-group"]');
  assert.equal(await group.count(), 1, "one composite card for the group");
  assert.equal(await group.getAttribute("data-group"), "held-word");
  assert.equal(await group.locator(".rs-bhead .rs-bname").textContent(), "Charm — The Held Word", "the lead's name heads the card");
  assert.match(await group.locator(".rs-phrase").textContent(), /A promise keeps/, "the lead renders per its own role (card phrase)");
  // Variants round: the two states render as TABS (first active by default);
  // the non-variant member keeps its labeled section.
  assert.deepEqual(await group.locator('[data-testid="rs-tab"]').allTextContents(), ["Kept", "Broken"]);
  assert.equal(await group.locator(".rs-tab--active").textContent(), "Kept");
  assert.match(await group.textContent(), /the room settles/, "the active state's read-aloud shows");
  assert.ok(!(await group.textContent()).includes("every head turns"), "the inactive state's does not");
  assert.deepEqual(
    await group.locator(".rs-group-sec-h span:first-child").allTextContents(),
    ["Breaking it"],
    "the variant-less member keeps its heading; the active tab IS the state's heading"
  );
  assert.match(
    await spread.locator(".rs-main .rs-h").allTextContents().then((t) => t.join("|")),
    /The witness/,
    "the ungrouped beat stays its own element"
  );

  // LOCAL flip (adjudicated): clicking a tab swaps the content with no route
  // write — the persisted scene record stays untouched.
  await group.locator('[data-testid="rs-tab"][data-variant="Broken"]').click();
  group = spread.locator('[data-testid="rs-group"]');
  assert.equal(await group.locator(".rs-tab--active").textContent(), "Broken");
  assert.match(await group.textContent(), /every head turns/);
  const persisted = await (await fetch(`${base}/api/session-planner/scenes/${scene.id}?world=${WORLD}`)).json();
  assert.deepEqual(persisted.scene.activeVariants, [], "a tab click writes NOTHING to the scene record");
  await page.close();

  // activeVariants (route/MCP) seeds the starting tab on a fresh open.
  await updateSceneViaRoute(base, WORLD, scene.id, { activeVariants: ["Broken"] });
  ({ page, spread } = await openRun(scene.id));
  group = spread.locator('[data-testid="rs-group"]');
  assert.equal(await group.count(), 1, "the card survives variant gating");
  assert.equal(await group.locator(".rs-tab--active").textContent(), "Broken", "activeVariants seeds the tab");
  await page.close();
});
