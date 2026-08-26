// Run spread (2026-08-26) -- Run mode renders the scene as a runnable
// spread driven by each element's EXPLICIT `run` layout (column/role/
// variant), falling back to run-layout.mjs's inference for
// untagged elements, and gated by `scene.activeVariants`. Asserted against
// the real ported DOM under the designer shell (`#planner/scene/<id>`).
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

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-run-spread-");
const WORLD = "e2e-run-spread-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "rs-square", name: "The Old Square", type: "place", importance: 0.6, description: "A cobbled square." } }
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

test("every role lands in its column; explicit run beats inference; off is absent; exits parse to labelled targets", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "rs-square", name: "Spread scene" });
  await updateSceneViaRoute(base, WORLD, scene.id, { name: "Spread scene", kind: "combat", tags: ["live"], whereNote: "The square · by the well" });
  await makeEl(scene.id, { name: "Read Aloud — Opening", fields: { looks: "Rain on cobbles." }, run: { column: "main", role: "read" } });
  await makeEl(scene.id, { name: "A cart", fields: { looks: "Overturned." }, run: { column: "main", role: "dressing" } });
  await makeEl(scene.id, { name: "A dog", fields: { looks: "Asleep." }, run: { column: "main", role: "dressing" } });
  await makeEl(scene.id, { name: "The Watch", fields: { gives: "Questions." }, run: { column: "main", role: "beat" } });
  await makeEl(scene.id, { name: "Exits", fields: { gives: "ONWARD (plot): follow the cart → 'The Yard'\nLINGER: stay → 'The Inn'" }, run: { column: "main", role: "exits" } });
  await makeEl(scene.id, { name: "Guards", fields: { statblockRef: "Guard (MM)" }, stat: { count: 3 }, run: { column: "side", role: "block" } });
  await makeEl(scene.id, { name: "The token", fields: { gives: "\"What is given cannot be returned.\"", looks: "It burns.", secret: "Fail: nothing." }, run: { column: "side", role: "card" } });
  await makeEl(scene.id, { name: "Backdrop — Present", fields: { looks: "Busy." }, run: { column: "side", role: "gm" } });
  await makeEl(scene.id, { name: "Cut", fields: { looks: "Never shown." }, run: { column: "off", role: "gm" } });
  // Untagged -> inference: "Backdrop — Night" reads as a side GM box with variant "Night".
  await makeEl(scene.id, { name: "Backdrop — Night", fields: { looks: "Lamps lit." } });
  // Read-aloud whose explicit layout pushes it to the SIDE (explicit beats the name-inference default of main).
  await makeEl(scene.id, { name: "Read Aloud — Whisper", fields: { looks: "psst" }, run: { column: "side", role: "read" } });

  const { page, spread } = await openRun(scene.id);
  const main = spread.locator(".rs-main");
  const side = spread.locator(".rs-side");

  // Head band
  assert.equal(await spread.locator(".rs-head h3").textContent(), "Spread scene");
  const pills = await spread.locator(".rs-pills .rs-pill").allTextContents();
  assert.deepEqual(pills, ["combat", "live"]);
  assert.match(await spread.locator(".rs-where").textContent(), /The square · by the well/);

  // Main column
  assert.equal(await main.locator(".rs-read").count(), 1);
  assert.match(await main.locator(".rs-read").textContent(), /Rain on cobbles/);
  assert.equal(await main.locator("ul.rs-dress").count(), 1, "consecutive dressing folds into ONE list");
  assert.equal(await main.locator("ul.rs-dress li").count(), 2);
  assert.match(await main.locator(".rs-h").allTextContents().then((t) => t.join("|")), /The Watch/);
  const exits = main.locator(".rs-exits .rs-exit");
  assert.equal(await exits.count(), 2, "two exit lines from one multi-line field");
  assert.equal(await exits.nth(0).locator("b").textContent(), "Plot");
  assert.equal(await exits.nth(0).locator(".rs-target").textContent(), "The Yard");
  assert.equal(await exits.nth(1).locator("b").textContent(), "Linger");

  // Side column
  assert.equal(await side.locator(".rs-block:not(.rs-card) .rs-bname").first().textContent(), "Guards");
  assert.equal(await side.locator(".rs-mult").textContent(), "×3");
  assert.match(await side.locator(".rs-bl").first().textContent(), /Guard \(MM\)/);
  assert.equal(await side.locator(".rs-card .rs-phrase").textContent(), "\"What is given cannot be returned.\"");
  const boxTitles = await side.locator(".rs-box .rs-box-l").allTextContents();
  assert.ok(boxTitles.includes("Backdrop — Present"), boxTitles.join("|"));
  assert.ok(boxTitles.includes("Backdrop — Night"), "inferred GM box");
  assert.ok(boxTitles.includes("Read Aloud — Whisper"), "explicit side read-aloud renders as a side box");

  // Off column never renders.
  assert.equal(await spread.locator("text=Never shown.").count(), 0);
  await page.close();
});

test("activeVariants gates variant-tagged elements; empty shows all; untagged elements always render", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "rs-square", name: "Variant scene" });
  await makeEl(scene.id, { name: "Backdrop — Present", fields: { looks: "Day." }, run: { column: "side", role: "gm", variant: "Present" } });
  await makeEl(scene.id, { name: "Backdrop — Night", fields: { looks: "Dark." }, run: { column: "side", role: "gm", variant: "Night" } });
  await makeEl(scene.id, { name: "Always", fields: { looks: "Constant." }, run: { column: "side", role: "gm" } });

  let { page, spread } = await openRun(scene.id);
  let titles = await spread.locator(".rs-side .rs-box-l").allTextContents();
  assert.deepEqual(titles, ["Backdrop — Present", "Backdrop — Night", "Always"], "empty activeVariants = show all");
  await page.close();

  await updateSceneViaRoute(base, WORLD, scene.id, { activeVariants: ["Night"] });
  ({ page, spread } = await openRun(scene.id));
  titles = await spread.locator(".rs-side .rs-box-l").allTextContents();
  assert.deepEqual(titles, ["Backdrop — Night", "Always"]);
  await page.close();
});

test("a sketch element renders its SVG (sanitised) with its caption; an empty placeholder is hidden", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "rs-square", name: "Sketch scene" });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><script>window.__pwned=1</script><rect class="skw" x="10" y="10" width="40" height="20" onclick="window.__pwned=2"/><text class="skT" x="12" y="45">WELL</text></svg>';
  await makeEl(scene.id, { name: "Sketch", fields: { looks: svg, means: "① PCs enter from the west." }, run: { column: "side", role: "sketch" } });
  await makeEl(scene.id, { name: "Read aloud", fields: {}, run: { column: "main", role: "read", placeholder: true } });
  await makeEl(scene.id, { name: "A lamp", fields: { looks: "Lit." }, run: { column: "main", role: "dressing" } });

  const { page, spread } = await openRun(scene.id);
  const sk = spread.locator(".rs-side .rs-sketch");
  assert.equal(await sk.locator("svg").count(), 1);
  assert.equal(await sk.locator("svg script").count(), 0, "script stripped");
  assert.equal(await sk.locator("svg rect[onclick]").count(), 0, "on* handler stripped");
  assert.equal(await sk.locator("svg text").textContent(), "WELL");
  assert.match(await sk.locator(".rs-cap").textContent(), /PCs enter/);
  assert.equal(await page.evaluate(() => window.__pwned ?? null), null);
  // The empty placeholder read-aloud leaves no heading behind; the dressing list still shows.
  assert.equal(await spread.locator(".rs-main .rs-h").count(), 1, "only the Dressing heading");
  assert.equal(await spread.locator(".rs-main .rs-h").textContent(), "Dressing");
  await page.close();
});
