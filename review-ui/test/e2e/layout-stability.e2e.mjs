// WS-G guard (table round 2026-09-09, feedback 7: "switching between the
// three views, and clicking into edit fields on the Prep page, still produces
// visible box resizing and text jumping"). The probe
// (layout-stability.probe.mjs) measured the causes; this is the promoted
// assertion, on the same fixture and measurement kit, with classic 15px
// scrollbars so the gutter is real:
//
//   1. Click-to-edit is an overlay: entering and leaving looks / means /
//      wants / read-aloud / element name moves NOTHING by >= 1px (no row,
//      field, band or sub-bar), and the scrollbar does not toggle.
//   2. Prep <-> Layout <-> Run: the sub-bar and its controls never move; the
//      head band and read-aloud keep their box between Prep and Layout; a
//      full lap Prep -> Layout -> Run -> Prep lands on the identical Prep
//      geometry; the scrollbar never toggles.
//   3. The lanes rail is a pure column shift: every row keeps its height and
//      width, all rows shift left by the same amount, and closing restores
//      the identical geometry.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import { setupPhase30Env, cleanupScratchEnv, primeWorldSelection } from "./phase30-fixture.mjs";
import { SEED_ENTITIES, snapshot, diff, settle, seedScene, openScenePrep } from "./layout-stability-fixture.mjs";

const PX = 1; // tolerance: sub-pixel text metrics only, never a visible jump
const WIDTHS = [1280, 1920];

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-layout-stability-");
const WORLD = "e2e-layout-stability-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, SEED_ENTITIES);

let server, base, browser, scene, marek;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
  // Headless Chromium hides scrollbars (0px overlay); the desktop browser at
  // the table paints classic ones, and the gutter is a named suspect.
  browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
  ({ scene, marek } = await seedScene(base, WORLD));
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

const fmt = (r) => `${r.key}: ${r.note || `dh ${r.dh} dtop ${r.dtop} dw ${r.dw} dleft ${r.dleft}`}`;
const movedBy = (rows, px = PX, axes = ["dh", "dtop", "dw", "dleft"]) => rows.filter((r) => r.note || axes.some((a) => Math.abs(r[a]) >= px));

// Nothing tracked moved, appeared or vanished between two snapshots.
function assertStill(label, before, after, { only, except } = {}) {
  let rows = diff(before, after).filter((r) => r.key !== "page:scroll");
  if (only) rows = rows.filter((r) => only(r.key));
  if (except) rows = rows.filter((r) => !except(r.key));
  const bad = movedBy(rows);
  assert.equal(bad.length, 0, `${label}: expected nothing to move, got\n  ${bad.map(fmt).join("\n  ")}`);
}
function assertGutterStable(label, before, after) {
  assert.equal(after["page:scroll"].scrollbar, before["page:scroll"].scrollbar, `${label}: scrollbar gutter toggled ${before["page:scroll"].scrollbar}px -> ${after["page:scroll"].scrollbar}px`);
}

async function openPage(width) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await primeWorldSelection(page, base, WORLD);
  await openScenePrep(page, base, scene.id);
  return page;
}
async function toLayout(page) { await page.locator('[data-testid="layout-board-btn"]').click(); await settle(page); }
async function toRun(page) { await page.locator('[data-testid="mode-run-btn"]').click(); await page.locator('[data-testid="scene-run-spread"]').waitFor({ state: "visible" }); await settle(page); }
async function toPrep(page) { await page.locator('[data-testid="mode-prep-btn"]').click(); await page.locator('[data-testid="scene-element-row"]').first().waitFor({ state: "visible" }); await settle(page); }

const isBar = (k) => k.startsWith("bar:");
const isBandOrReadAloud = (k) => k === "head-band" || k.startsWith("scene-band-") || k === "read-aloud-section" || k === "field:read-aloud";

for (const width of WIDTHS) {
  test(`@${width}: click-to-edit is an overlay -- entering/leaving a field moves nothing and the gutter holds`, async () => {
    const page = await openPage(width);
    try {
      const fieldOf = (f) => page.locator(`[data-testid="scene-element-row"][data-element-id="${marek.id}"] [data-testid="scene-element-field"][data-field="${f}"]`);
      const cycle = async (label, enter, leave) => {
        const before = await snapshot(page);
        await enter(); await settle(page);
        const mid = await snapshot(page);
        assertStill(`enter ${label}`, before, mid);
        assertGutterStable(`enter ${label}`, before, mid);
        await leave(); await settle(page);
        const afterS = await snapshot(page);
        assertStill(`leave ${label}`, mid, afterS);
        assertStill(`round trip ${label}`, before, afterS);
        assertGutterStable(`leave ${label}`, mid, afterS);
      };
      // `checks` is a read-only array line, so the clickable kinds on the
      // person row are looks / means / wants.
      for (const f of ["looks", "means", "wants"]) {
        await cycle(f,
          async () => { await fieldOf(f).click(); await page.locator(`[data-testid="scene-element-field-input"][data-field="${f}"]`).waitFor({ state: "visible" }); },
          async () => { await page.keyboard.press("Escape"); await page.locator(`[data-testid="scene-element-field-input"][data-field="${f}"]`).waitFor({ state: "detached" }); });
      }
      await cycle("read-aloud",
        async () => { await page.locator('[data-testid="scene-narration"]').click(); await page.locator('[data-testid="scene-narration-input"]').waitFor({ state: "visible" }); },
        async () => { await page.keyboard.press("Escape"); await page.locator('[data-testid="scene-narration-input"]').waitFor({ state: "detached" }); });
      const nameEl = page.locator(`[data-testid="scene-element-row"][data-element-id="${marek.id}"] [data-testid="scene-element-name"]`);
      assert.ok(await nameEl.count(), "person row exposes an editable name");
      await cycle("element name",
        async () => { await nameEl.click(); await page.locator('[data-testid="scene-element-name-input"]').first().waitFor({ state: "visible" }); },
        async () => { await page.keyboard.press("Escape"); await page.locator('[data-testid="scene-element-name-input"]').first().waitFor({ state: "detached" }); });
    } finally {
      await page.close();
    }
  });

  test(`@${width}: Prep <-> Layout <-> Run keeps the sub-bar, band and read-aloud still; a full lap is identical; the gutter holds`, async () => {
    const page = await openPage(width);
    try {
      const prep0 = await snapshot(page);
      await toLayout(page);
      const layout = await snapshot(page);
      assertStill("Prep -> Layout (sub-bar)", prep0, layout, { only: isBar });
      assertStill("Prep -> Layout (band + read-aloud)", prep0, layout, { only: isBandOrReadAloud });
      assertGutterStable("Prep -> Layout", prep0, layout);

      await toRun(page);
      const run = await snapshot(page);
      assertStill("Layout -> Run (sub-bar)", layout, run, { only: isBar });
      assertGutterStable("Layout -> Run", layout, run);
      assert.ok(run["run-spread"], "Run shows the spread");

      await toPrep(page);
      const prep1 = await snapshot(page);
      assertStill("Prep -> Layout -> Run -> Prep lap", prep0, prep1);
      assertGutterStable("Run -> Prep", run, prep1);

      // The common table gesture: Prep -> Run -> Prep directly.
      await toRun(page);
      const run2 = await snapshot(page);
      assertStill("Prep -> Run direct (sub-bar)", prep1, run2, { only: isBar });
      assertStill("Run geometry is the same whichever view it came from", run, run2);
      await toPrep(page);
      assertStill("Prep -> Run -> Prep lap", prep0, await snapshot(page));
    } finally {
      await page.close();
    }
  });

  test(`@${width}: the lanes rail shifts the column as a unit -- no row reflows, close restores the geometry`, async () => {
    const page = await openPage(width);
    try {
      const railBtn = page.locator('[data-testid="rail-toggle-btn"]');
      const closed = await snapshot(page);
      await railBtn.click(); await settle(page);
      const open = await snapshot(page);
      const rows = diff(closed, open).filter((r) => r.key.startsWith("row:") || r.key.startsWith("field:") || r.key.startsWith("name:"));
      assert.ok(rows.length > 10, "rows are tracked");
      const reflowed = movedBy(rows, PX, ["dh", "dw", "dtop"]);
      assert.equal(reflowed.length, 0, `rail open reflowed rows:\n  ${reflowed.map(fmt).join("\n  ")}`);
      const shifts = new Set(rows.map((r) => Math.round(r.dleft)));
      assert.equal(shifts.size, 1, `rail open must shift every row by the same amount, got ${[...shifts].join(", ")}`);
      assert.ok([...shifts][0] < 0, "rail open shifts the column left to make room");
      // The sub-bar rides the same column: same shift, no resize.
      const bar = diff(closed, open).filter((r) => isBar(r.key));
      const barBad = bar.filter((r) => r.note || Math.abs(r.dh) >= PX || Math.abs(r.dw) >= PX || Math.abs(r.dtop) >= PX || Math.round(r.dleft) !== [...shifts][0]);
      assert.equal(barBad.length, 0, `rail open must carry the sub-bar with the column:\n  ${barBad.map(fmt).join("\n  ")}`);
      assertGutterStable("rail open", closed, open);
      await railBtn.click(); await settle(page);
      assertStill("rail close restores", closed, await snapshot(page));
    } finally {
      await page.close();
    }
  });
}
