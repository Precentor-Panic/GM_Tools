// Phase 25 task 25.0, REQUIRED SCENARIO 2 -- "Top strip + corrected flag
// coding: prep-readiness badges render with distinct, non---reject styling
// for flag-badge--structural, and distinguishable treatment between
// flag-badge--content and the empty-digest state (assert actual computed
// CSS custom-property values, not just class names)." Read
// table-mode-fixture.mjs's header FIRST (§2 is this file's own section).
// EXPECTED TO FAIL right now -- `table-top-strip`/`table-flag-badge` don't
// exist yet AND task 25.1's own color-token fix hasn't landed yet either
// (style.css still reuses --reject/--pill-rejected-bg for
// flag-badge--structural as of this writing, confirmed at ~line 627) -- so
// this file is a genuine double contract: the DOM must exist, AND it must
// render with the corrected (not yet fixed) tokens. Both failures are the
// deliverable of this task, not bugs in this file.
//
// FIXTURE: ONE anchor entity with ZERO edges and no narration ever
// generated -- this single, deliberately minimal entity simultaneously
// satisfies THREE independent conditions (confirmed directly against
// session-planner/flags.mjs / digest.mjs's real logic, not assumed):
//   - contentReadinessFlag.flagged === true (getCurrentEntityNarration
//     returns null for an entity that has never been narrated -- "no
//     narration" is always one of its `reasons`)
//   - structuralUnderConnectionFlag.flagged === true (edgeCount 0 <
//     DEFAULT_MIN_EDGES 2)
//   - digest === null (buildAmbientDigestEntry's own EMPTY-RENDER RULE: no
//     connecting edge label/notes AND no narration prose -> null, not
//     padded/fabricated)
// One fixture entity therefore renders all three flag-coding states this
// scenario needs to compare, with no cross-entity ambiguity.
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

const { scratchDir, dataDir } = setupSceneConstructionEnv("gm-tools-e2e-tablemode-flags-");
const WORLD = "e2e-tablemode-flags-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "tmflags-anchor", name: "Flag Coding Anchor", type: "place", importance: 0.5 } }
]);

let server, base, browser, page;
let scene;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "tmflags-anchor" });

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

/** Resolves a CSS custom property to the browser's own normalized computed color string, by momentarily applying it to a real (offscreen, immediately-removed) element -- avoids brittle raw-string comparison (e.g. "#a13d3d" vs "rgb(161, 61, 61)"). */
async function resolvedVarColor(pg, varName, cssProp) {
  return pg.evaluate(({ v, p }) => {
    const el = document.createElement("span");
    el.style[p] = `var(${v})`;
    el.style.position = "absolute";
    el.style.visibility = "hidden";
    document.body.appendChild(el);
    const val = getComputedStyle(el)[p];
    el.remove();
    return val;
  }, { v: varName, p: cssProp });
}

test("the structural flag badge does NOT reuse --reject/--pill-rejected-bg -- the confirmed pre-existing bug this phase fixes", async () => {
  await gotoTableMode(page, base, scene.id);

  const structuralBadge = page.locator('[data-testid="table-flag-badge"][data-flag-kind="structural"]');
  await structuralBadge.waitFor({ state: "visible", timeout: 15000 });

  const [rejectColor, pillRejectedBg] = await Promise.all([
    resolvedVarColor(page, "--reject", "color"),
    resolvedVarColor(page, "--pill-rejected-bg", "backgroundColor")
  ]);
  const [badgeColor, badgeBg] = await Promise.all([
    structuralBadge.evaluate((el) => getComputedStyle(el).color),
    structuralBadge.evaluate((el) => getComputedStyle(el).backgroundColor)
  ]);

  assert.notEqual(badgeColor, rejectColor, `flag-badge--structural's computed color (${badgeColor}) must not equal --reject's resolved color (${rejectColor}) -- reusing the genuine-error-state token is the confirmed pre-existing bug`);
  assert.notEqual(badgeBg, pillRejectedBg, `flag-badge--structural's computed background-color (${badgeBg}) must not equal --pill-rejected-bg's resolved color (${pillRejectedBg})`);
});

test("the content flag badge and the empty-digest state are distinguishable from each other, not pixel-identical, despite both legitimately using the --amber family", async () => {
  await gotoTableMode(page, base, scene.id);

  const contentBadge = page.locator('[data-testid="table-flag-badge"][data-flag-kind="content"]');
  const emptyState = page.locator('[data-testid="table-flag-badge"][data-flag-kind="empty"]');
  await contentBadge.waitFor({ state: "visible", timeout: 15000 });
  await emptyState.waitFor({ state: "visible", timeout: 15000 });

  const readStyle = async (locator) =>
    locator.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        borderColor: cs.borderColor,
        borderStyle: cs.borderStyle,
        fontWeight: cs.fontWeight
      };
    });

  const [contentStyle, emptyStyle] = await Promise.all([readStyle(contentBadge), readStyle(emptyState)]);

  assert.notDeepEqual(
    contentStyle,
    emptyStyle,
    `flag-badge--content (${JSON.stringify(contentStyle)}) and the empty-digest state (${JSON.stringify(emptyStyle)}) must differ in at least one computed style property (icon/border-style/weight/etc.) -- they mean different things ("flagged as undeveloped" vs "nothing established at all") and must not render pixel-identical`
  );
});

test("the structural badge and content badge are ALSO independently, simultaneously present on this fixture's single anchor entity -- proving the two flags are two real, co-occurring signals, not merged into one", async () => {
  await gotoTableMode(page, base, scene.id);

  const structuralBadge = page.locator('[data-testid="table-flag-badge"][data-flag-kind="structural"]');
  const contentBadge = page.locator('[data-testid="table-flag-badge"][data-flag-kind="content"]');
  await structuralBadge.waitFor({ state: "visible", timeout: 15000 });
  await contentBadge.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await structuralBadge.count(), 1);
  assert.equal(await contentBadge.count(), 1);
});
