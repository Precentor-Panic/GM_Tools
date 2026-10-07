// Navigation round (2026-10-07) -- the scene page's LOOKUP panel and the
// now-clickable `⛓ graph` badge.
//
// Russell, at the table: "I find myself hunting longer than necessary for new
// people, names, and even area names." Before this, the only entity search in
// the app lived on the World surface, so reaching it was itself the navigation
// that cost him his place in the scene (the other half of that complaint is
// the amended Decision 4, covered in phase30-shell.e2e.mjs).
//
// What matters here, and why each case exists:
//   1. The panel finds a node by NAME without leaving the scene -- the whole
//      point. It also must include a node that is already an element in this
//      scene, which is exactly where buildFromGraphPicker (the panel it was
//      forked from) does the opposite.
//   2. It is READ-ONLY. A lookup that quietly attaches the thing you looked up
//      would be a trap mid-session, so this asserts the element count is
//      unchanged after a search-and-expand.
//   3. Matching reaches the description, ranked behind name and type, because
//      "the area with the water in it" is how a GM actually remembers a place.
//   4. `/` opens it and Esc closes it -- hands stay on the keyboard.
//   5. The `⛓ graph` badge navigates to #world/<id>. The id was already in the
//      DOM and did nothing.
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
import { listSceneElementsViaRoute } from "./phase29-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-scene-lookup-");
const WORLD = "e2e-scene-lookup-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  // The scene's own anchor place.
  { op: "upsert_entity", data: { id: "lk-kiln", name: "The Lime Kilns", type: "place", importance: 0.6, description: "A glowing floor where the bodies are counted in." } },
  // A person the GM would look up mid-scene. Deliberately given BOTH a summary
  // and a description so the expanded body can show the long text under the
  // one-liner rather than dropping it.
  { op: "upsert_entity", data: { id: "lk-clerk", name: "Bashir the Counting Clerk", type: "person", importance: 0.4, summary: "Counts the bodies in and carries the board.", description: "A thin man with a chalked board who will not be hurried and does not negotiate the value of a writ." } },
  // A place whose NAME shares no word with the thing a GM would type: the
  // description is the only way in. This is case 3.
  { op: "upsert_entity", data: { id: "lk-arch", name: "The Split Arch", type: "place", importance: 0.3, description: "A cistern stands against unexplored ground on the far side of the market." } },
  // No description at all -- the panel must say so honestly rather than render
  // an empty body.
  { op: "upsert_entity", data: { id: "lk-bare", name: "The Unwritten Alley", type: "place", importance: 0.2 } }
]);

let server, base, browser, sceneId;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();

  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "lk-kiln" });
  sceneId = scene.id;
  // Put Bashir IN the scene as a KEY element. Two jobs: it proves the lookup
  // still finds an in-scene node (case 1, where the from-graph picker this
  // panel was forked from does the opposite), and it gives case 5 a real
  // badge. Attached through the from-graph route rather than create+promote:
  // promote would mint a SECOND node with the same name, which is exactly the
  // duplicate the name search would then trip over.
  const attach = await fetch(`${base}/api/scene-planning/scenes/${encodeURIComponent(sceneId)}/elements/from-graph`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ world: WORLD, entityId: "lk-clerk" })
  });
  assert.equal(attach.status, 200, "test setup: attaching the clerk must succeed");
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

async function openScene(page) {
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${sceneId}`);
  await page.locator('[data-testid="planner-scene-view"]').waitFor({ state: "visible", timeout: 15000 });
}

test("the lookup toggle finds a node by name without leaving the scene, including one already in this scene", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openScene(page);

  const panel = page.locator('[data-testid="scene-lookup-panel"]');
  assert.equal(await panel.isVisible(), false, "the panel must start closed");

  await page.locator('[data-testid="lookup-toggle-btn"]').click();
  await panel.waitFor({ state: "visible", timeout: 10000 });

  await page.locator('[data-testid="scene-lookup-input"]').fill("bashir");
  const row = page.locator('[data-testid="scene-lookup-row"][data-entity-id="lk-clerk"]');
  await row.waitFor({ state: "visible", timeout: 10000 });

  // Still on the scene page -- the whole point.
  assert.equal(await page.evaluate(() => location.hash), `#planner/scene/${sceneId}`);
  assert.equal(
    await page.locator('[data-testid="planner-scene-view"]').isVisible(),
    true,
    "looking a name up must not navigate away from the scene"
  );

  // Expanding shows the summary AND the longer description under it.
  await row.locator('[data-testid="scene-lookup-head"]').click();
  const body = row.locator('[data-testid="scene-lookup-body"]');
  await body.waitFor({ state: "visible", timeout: 10000 });
  const text = await body.innerText();
  assert.match(text, /Counts the bodies in/, "the summary must show");
  assert.match(text, /does not negotiate the value of a writ/, "the full description must show under the summary, not replace it");

  await page.close();
});

test("the lookup is READ-ONLY: searching and expanding adds no element to the scene", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openScene(page);

  const before = (await listSceneElementsViaRoute(base, WORLD, sceneId)).body.elements.length;

  await page.locator('[data-testid="lookup-toggle-btn"]').click();
  await page.locator('[data-testid="scene-lookup-panel"]').waitFor({ state: "visible", timeout: 10000 });
  await page.locator('[data-testid="scene-lookup-input"]').fill("unwritten");
  const row = page.locator('[data-testid="scene-lookup-row"][data-entity-id="lk-bare"]');
  await row.waitFor({ state: "visible", timeout: 10000 });
  await row.locator('[data-testid="scene-lookup-head"]').click();
  await row.locator('[data-testid="scene-lookup-body"]').waitFor({ state: "visible", timeout: 10000 });

  // A node with no description says so, rather than rendering a blank body.
  assert.match(await row.locator('[data-testid="scene-lookup-body"]').innerText(), /No description yet/);

  const after = (await listSceneElementsViaRoute(base, WORLD, sceneId)).body.elements.length;
  assert.equal(after, before, "a lookup must never attach what was looked up");

  await page.close();
});

test("matching reaches the description, ranked behind name and type", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openScene(page);

  await page.locator('[data-testid="lookup-toggle-btn"]').click();
  await page.locator('[data-testid="scene-lookup-panel"]').waitFor({ state: "visible", timeout: 10000 });

  // "unexplored" appears ONLY in The Split Arch's description -- no name or
  // type contains it.
  await page.locator('[data-testid="scene-lookup-input"]').fill("unexplored");
  await page.locator('[data-testid="scene-lookup-row"][data-entity-id="lk-arch"]').waitFor({ state: "visible", timeout: 10000 });
  assert.equal(
    await page.locator('[data-testid="scene-lookup-row"]').count(),
    1,
    "a description-only term must match exactly the node whose description carries it"
  );

  // "the" hits several names and several descriptions; a NAME match must rank
  // above a body match, so the first row is never a description-only hit.
  await page.locator('[data-testid="scene-lookup-input"]').fill("kiln");
  await page.locator('[data-testid="scene-lookup-row"][data-entity-id="lk-kiln"]').waitFor({ state: "visible", timeout: 10000 });
  assert.equal(
    await page.locator('[data-testid="scene-lookup-row"]').first().getAttribute("data-entity-id"),
    "lk-kiln",
    "a name match must outrank a description match"
  );

  // A term in nothing at all reports honestly.
  await page.locator('[data-testid="scene-lookup-input"]').fill("zzzznotathing");
  await page.locator('[data-testid="scene-lookup-empty"]').waitFor({ state: "visible", timeout: 10000 });

  await page.close();
});

test("/ opens the lookup and Esc closes it, and / never fires while a field is being edited", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openScene(page);

  const panel = page.locator('[data-testid="scene-lookup-panel"]');
  await page.locator('[data-testid="planner-scene-elements"]').waitFor({ state: "visible", timeout: 10000 });

  await page.keyboard.press("/");
  await panel.waitFor({ state: "visible", timeout: 10000 });
  // It opens FOCUSED -- the next keystroke is the search, not a shortcut.
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
    "scene-lookup-input",
    "the lookup must open with the input focused"
  );

  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden", timeout: 10000 });

  // Typing a slash into a real field must not open it. The scene objective is
  // a click-to-edit field that swaps in a <textarea data-testid=
  // "scene-objective-input"> -- the exact target the page-level handler's
  // guard returns early on. Asserted unconditionally: a locator that silently
  // finds nothing would make this case pass without testing anything.
  await page.locator('[data-testid="scene-objective"]').click();
  const objectiveInput = page.locator('[data-testid="scene-objective-input"]');
  await objectiveInput.waitFor({ state: "visible", timeout: 10000 });
  await page.keyboard.type("north/south");
  assert.equal(await panel.isVisible(), false, "a slash typed into a field must not open the lookup");
  assert.match(await objectiveInput.inputValue(), /north\/south/, "the slash must land in the field as text");

  await page.close();
});

test("the ⛓ graph badge opens its node in the World inspector", async () => {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await openScene(page);

  const badge = page.locator('[data-testid="scene-element-graph-badge"]').first();
  await badge.waitFor({ state: "visible", timeout: 10000 });
  const entityId = await badge.getAttribute("data-graph-entity-id");
  assert.ok(entityId, "the badge must carry the entity id it links to");

  await badge.click();
  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      (id) => location.hash === `#world/${id}`,
      entityId,
      { timeout: 10000 }
    );
  }, "clicking the graph badge must deep-link into the World inspector");
  await page.locator('[data-testid="world-surface-root"]').waitFor({ state: "visible", timeout: 10000 });

  await page.close();
});
