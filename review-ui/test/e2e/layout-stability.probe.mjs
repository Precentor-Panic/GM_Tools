// WS-G probe (table round 2026-09-09, feedback 7: "box resizing and text
// jumping between Prep / Layout / Run, and when clicking into edit fields").
// A MEASUREMENT, not a pass/fail test -- the `.probe.mjs` suffix keeps it out
// of `npm run test:e2e`'s glob. Run directly:
//
//   cd review-ui && node test/e2e/layout-stability.probe.mjs [--all]
//
// Measurement kit + fixture live in layout-stability-fixture.mjs; the
// pass/fail guard is layout-stability.e2e.mjs.
// Loads a fixture scene, walks Prep -> Layout -> Run -> Prep, then clicks
// into and blurs one field of each kind (looks / means / checks / read-aloud
// / element name), and after every step records getBoundingClientRect() for
// every element row, field, run box, the head band and the page's scroll
// metrics. Prints a diff table (element, transition, dh, dtop, dw, dleft) of anything
// that moved, at 1280 and 1920 widths. `--all` prints unmoved rows too.
import { chromium } from "playwright";
import { setupPhase30Env, cleanupScratchEnv, primeWorldSelection } from "./phase30-fixture.mjs";
import { SEED_ENTITIES, snapshot, diff, moved, settle, seedScene, openScenePrep } from "./layout-stability-fixture.mjs";

const PRINT_ALL = process.argv.includes("--all");
const WIDTHS = [1280, 1920];
const HEIGHT = Number(process.env.PROBE_HEIGHT) || 900;

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-layout-probe-");
const WORLD = "e2e-layout-probe-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, SEED_ENTITIES);

function printDiff(label, rows, scroll) {
  const movedRows = rows.filter((r) => moved(r));
  const shown = PRINT_ALL ? rows : movedRows;
  console.log(`\n== ${label}   (scrollbar ${scroll.before}px -> ${scroll.after}px, scrollHeight ${scroll.hBefore} -> ${scroll.hAfter})   moved ${movedRows.length}/${rows.length}`);
  if (!shown.length) { console.log("   (nothing moved)"); return; }
  const w = Math.max(...shown.map((r) => r.key.length), 12);
  console.log(`   ${"element".padEnd(w)}  ${"dh".padStart(7)}  ${"dtop".padStart(7)}  ${"dw".padStart(7)}  ${"dleft".padStart(7)}`);
  for (const r of shown) {
    if (r.note) { console.log(`   ${r.key.padEnd(w)}  ${r.note}`); continue; }
    console.log(`   ${r.key.padEnd(w)}  ${String(r.dh).padStart(7)}  ${String(r.dtop).padStart(7)}  ${String(r.dw).padStart(7)}  ${String(r.dleft).padStart(7)}`);
  }
}

const server = createReviewServer({ port: 0 });
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://localhost:${server.address().port}`;
// Headless Chromium hides scrollbars by default (overlay, 0px) -- the real
// desktop browser paints classic ~15px ones, so keep them for the probe.
const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });

try {
  const { scene, marek } = await seedScene(base, WORLD);
  for (const width of WIDTHS) {
    console.log(`\n\n########## viewport ${width}x${HEIGHT} ##########`);
    const page = await browser.newPage({ viewport: { width, height: HEIGHT } });
    await primeWorldSelection(page, base, WORLD);
    await openScenePrep(page, base, scene.id);

    let prev = await snapshot(page);
    const step = async (label, act) => {
      await act();
      await settle(page);
      const cur = await snapshot(page);
      printDiff(label, diff(prev, cur), { before: prev["page:scroll"].scrollbar, after: cur["page:scroll"].scrollbar, hBefore: prev["page:scroll"].height, hAfter: cur["page:scroll"].height });
      prev = cur;
    };

    await step("Prep -> Layout", () => page.locator('[data-testid="layout-board-btn"]').click());
    await step("Layout -> Run", async () => {
      await page.locator('[data-testid="mode-run-btn"]').click();
      await page.locator('[data-testid="scene-run-spread"]').waitFor({ state: "visible" });
    });
    await step("Run -> Prep", async () => {
      await page.locator('[data-testid="mode-prep-btn"]').click();
      await page.locator('[data-testid="scene-element-row"]').first().waitFor({ state: "visible" });
    });
    // Second lap: Prep -> Run -> Prep directly (the common table gesture).
    await step("Prep -> Run (direct)", async () => {
      await page.locator('[data-testid="mode-run-btn"]').click();
      await page.locator('[data-testid="scene-run-spread"]').waitFor({ state: "visible" });
    });
    await step("Run -> Prep (direct)", async () => {
      await page.locator('[data-testid="mode-prep-btn"]').click();
      await page.locator('[data-testid="scene-element-row"]').first().waitFor({ state: "visible" });
    });

    // Click-to-edit: enter then blur, one field per kind. Enter and blur are
    // measured separately -- a jump on enter that reverses on blur is the
    // "text jumps while I edit" complaint; a residual after blur is drift.
    const fieldOf = (f) => page.locator(`[data-testid="scene-element-row"][data-element-id="${marek.id}"] [data-testid="scene-element-field"][data-field="${f}"]`);
    // `checks` is a read-only array line (no click-to-edit), so the third
    // clickable kind here is `wants`.
    for (const f of ["looks", "means", "wants"]) {
      await step(`click into ${f}`, async () => {
        await fieldOf(f).click();
        await page.locator(`[data-testid="scene-element-field-input"][data-field="${f}"]`).waitFor({ state: "visible" });
      });
      await step(`blur ${f}`, async () => {
        await page.keyboard.press("Escape");
        await page.locator(`[data-testid="scene-element-field-input"][data-field="${f}"]`).waitFor({ state: "detached" });
      });
    }
    await step("click into read-aloud", async () => {
      await page.locator('[data-testid="scene-narration"]').click();
      await page.locator('[data-testid="scene-narration-input"]').waitFor({ state: "visible" });
    });
    await step("blur read-aloud", async () => {
      await page.keyboard.press("Escape");
      await page.locator('[data-testid="scene-narration-input"]').waitFor({ state: "detached" });
    });
    const nameEl = page.locator(`[data-testid="scene-element-row"][data-element-id="${marek.id}"] [data-testid="scene-element-name"]`);
    if (await nameEl.count()) {
      await step("click into element name", async () => {
        await nameEl.click();
        await page.locator('[data-testid="scene-element-name-input"]').first().waitFor({ state: "visible" });
      });
      await step("blur element name", async () => {
        await page.keyboard.press("Escape");
        await page.locator('[data-testid="scene-element-name-input"]').first().waitFor({ state: "detached" });
      });
    }
    // The rail: open + close should be a pure width change, never a reflow of
    // row heights.
    const railBtn = page.locator('[data-testid="rail-toggle-btn"]');
    if (await railBtn.count()) {
      await step("open lanes rail", () => railBtn.click());
      await step("close lanes rail", () => railBtn.click());
    }
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
}
