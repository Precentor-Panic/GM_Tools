// G2 — drag ONTO a card to join its group (variants round, 2026-09-01):
//   - dropping a card on another card's middle band writes run.group on both
//     (new group slugged from the target's after-dash name), byte-compatible
//     with the popover path, and Run shows ONE composite card;
//   - the ONE-LAYER CAP: a multi-member stack dragged by its lead can never
//     join another card — the drop falls through to lane reorder;
//   - a member sub-row dragged out to lane space ungroups it;
//   - drag-onto-a-TABBED-card IS how a state is added ("+ variant" removed,
//     Russell 2026-09-01): a variant-less element joining a group that
//     already has states gets one derived from its after-dash name.
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
import { createSceneElementViaRoute, listSceneElementsViaRoute } from "./phase29-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-board-group-");
const WORLD = "e2e-board-group-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "bg-hall", name: "The Hall", type: "place", importance: 0.6, description: "A hall." } }
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
async function els(sceneId) {
  return (await listSceneElementsViaRoute(base, WORLD, sceneId)).body.elements;
}
async function openBoard(page, sceneId) {
  await page.goto(`${base}/#planner/scene/${sceneId}`);
  await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${sceneId}"]`).waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="layout-board-btn"]').click();
  const board = page.locator('[data-testid="scene-layout-board"]');
  await board.waitFor({ state: "visible", timeout: 10000 });
  return board;
}

test("drop ON a card joins its group (slug from the target's name); Run then shows one composite card with tabs", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "bg-hall", name: "Join scene" });
  const lead = await makeEl(scene.id, { name: "Charm — The Held Word", fields: { gives: '"Kept words keep."' }, run: { column: "main", role: "card" } });
  const outcome = await makeEl(scene.id, { name: "Read Aloud — Broken", fields: { looks: "It snaps." }, run: { column: "main", role: "read", variant: "Broken" } });

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  const board = await openBoard(page, scene.id);
  const outcomeCard = board.locator(`[data-testid="layout-card"][data-element-id="${outcome.id}"]`);
  const leadCard = board.locator(`[data-testid="layout-card"][data-element-id="${lead.id}"]`);
  await outcomeCard.dragTo(leadCard); // default target = center = the join band

  const stack = board.locator(`[data-testid="layout-stack"][data-element-id="${lead.id}"]`);
  await stack.waitFor({ timeout: 10000 });
  assert.equal(await stack.getAttribute("data-group"), "the-held-word", "group slugged from the target's after-dash name");
  assert.deepEqual(await stack.locator('[data-testid="layout-stack-member"]').count(), 1, "the joined member rides the stack");

  const stored = await els(scene.id);
  const sLead = stored.find((e) => e.id === lead.id);
  const sOutcome = stored.find((e) => e.id === outcome.id);
  assert.deepEqual(sLead.run, { column: "main", role: "card", group: "the-held-word" });
  assert.deepEqual(sOutcome.run, { column: "main", role: "read", variant: "Broken", group: "the-held-word" }, "the full run shape survives the join (variant kept)");
  assert.equal(stored.indexOf(sOutcome), stored.indexOf(sLead) + 1, "the joined member sits right after the group");

  // Run renders ONE composite card, same as the popover path would.
  await page.locator('[data-testid="mode-run-btn"]').click();
  const group = page.locator('[data-testid="rs-group"]');
  await group.waitFor({ timeout: 10000 });
  assert.equal(await group.count(), 1);
  await page.close();
});

test("one-layer cap: a multi-member stack dragged onto a card REORDERS instead of joining; joining a tabbed card derives a state; a member dragged out ungroups", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "bg-hall", name: "Cap scene" });
  const stackLead = await makeEl(scene.id, { name: "Charm — The Ledger", fields: { gives: "x" }, run: { column: "main", role: "card", group: "ledger" } });
  const member = await makeEl(scene.id, { name: "Read Aloud — Paid", fields: { looks: "y" }, run: { column: "main", role: "read", group: "ledger", variant: "Paid" } });
  const lone = await makeEl(scene.id, { name: "Beat — The clerk", fields: { gives: "counts" }, run: { column: "main", role: "beat" } });

  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  let board = await openBoard(page, scene.id);
  const stack = board.locator(`[data-testid="layout-stack"][data-element-id="${stackLead.id}"]`);
  const loneCard = board.locator(`[data-testid="layout-card"][data-element-id="${lone.id}"]`);

  // Drag the whole stack onto the lone card's center: join must REFUSE
  // (tabs-of-tabs), so nothing gains a new group and the lone card stays
  // ungrouped. (The drop falls through to the lane's reorder handler.)
  await stack.dragTo(loneCard);
  await page.waitForTimeout(600);
  let stored = await els(scene.id);
  assert.equal(stored.find((e) => e.id === lone.id).run.group, undefined, "the lone card gained no group");
  assert.equal(stored.find((e) => e.id === stackLead.id).run.group, "ledger", "the stack kept its own group");

  // Joining a TABBED card derives a state: the variant-less lone beat
  // dragged onto the stack becomes tab "The clerk" (after-dash name), not a
  // section below the tabs (the reported at-the-table confusion).
  board = page.locator('[data-testid="scene-layout-board"]');
  const loneCard2 = board.locator(`[data-testid="layout-card"][data-element-id="${lone.id}"]`);
  const stack2 = board.locator(`[data-testid="layout-stack"][data-element-id="${stackLead.id}"]`);
  await loneCard2.dragTo(stack2);
  await page.waitForFunction(
    (g) => document.querySelectorAll(`[data-testid="layout-stack"][data-group="${g}"] [data-testid="layout-stack-member"]`).length >= 2,
    "ledger",
    { timeout: 10000 }
  );
  stored = await els(scene.id);
  const joined = stored.find((e) => e.id === lone.id);
  assert.equal(joined.run.group, "ledger");
  assert.equal(joined.run.variant, "The clerk", "the after-dash name became the state");

  // Drag the original member OUT to lane space (the title strip — always
  // card-free, so the drop can never read as a join): it ungroups.
  const memberRow = board.locator(`[data-testid="layout-stack-member"][data-element-id="${member.id}"]`);
  const mainLane = board.locator('[data-testid="layout-lane"][data-column="main"]');
  const laneBox = await mainLane.boundingBox();
  await memberRow.dragTo(mainLane, { targetPosition: { x: laneBox.width / 2, y: 10 } });
  await page.waitForFunction(
    (id) => !!document.querySelector(`[data-testid="layout-card"][data-element-id="${id}"]`),
    member.id,
    { timeout: 10000 }
  );
  stored = await els(scene.id);
  const freed = stored.find((e) => e.id === member.id);
  assert.equal(freed.run.group, undefined, "dragging out cleared the group");
  assert.equal(freed.run.variant, "Paid", "the rest of the run shape survives the split");
  await page.close();
});
