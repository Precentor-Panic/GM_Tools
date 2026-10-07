// Beautification pass (2026-10-07) -- Prep and Run must say the SAME word for
// the same field, and an exits element's Secret must never render in public.
//
// RUN_FIELD_LABELS' own header says "edit THIS table to rename a field's
// presentation; every surface follows." That was true for 4 roles out of 11:
// Run consulted the mapping at six hand-written sites and everything else
// went through runSpreadFieldLines, which ignored role entirely. So Prep
// labelled fields Run never labelled ("TRIGGER" on a person, "LOOKS" on the
// thing that IS the dressing), and a GM box printed six anonymous paragraphs
// where Prep labelled all seven -- the GM could not tell which paragraph was
// the secret.
//
// The exits case is the one that is a SAFETY bug rather than a cosmetic one:
// `secret` used to be pooled in with the public exit lines, so anything typed
// into an exits element's Secret field rendered in the exits footer with none
// of the rust secret treatment. Both halves are covered: the renderer pulls it
// out, and Prep no longer offers the chip.
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
import { createSceneElementViaRoute } from "./phase29-fixture.mjs";

const { scratchDir, dataDir } = setupPhase30Env("gm-tools-e2e-prep-run-labels-");
const WORLD = "e2e-prep-run-labels-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { RUN_FIELD_LABELS, runFieldLabel } = await import("../../public/run-layout.mjs");

const snapPath = snapshotFilePath(dataDir, WORLD);
bootstrapSnapshot(snapPath, { worldId: WORLD });
applyHeadless(snapPath, [
  { op: "upsert_entity", data: { id: "prl-floor", name: "The Slaking Floor", type: "place", importance: 0.6, description: "Kiln glow on wet stone." } }
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

async function openScene(sceneId) {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#planner/scene/${sceneId}`);
  await page.locator(`[data-testid="planner-scene-view"][data-scene-id="${sceneId}"]`).waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[data-testid="scene-elements-list"]').waitFor({ timeout: 15000 });
  return page;
}

test("the label table now covers the roles the element form actually uses", () => {
  // A pure-unit guard on the table itself: the four roles below were the four
  // missing ones, and they are the four the current element form leans on.
  for (const role of ["person", "dressing", "gm", "exits"]) {
    assert.ok(RUN_FIELD_LABELS[role], `${role} must have a label mapping`);
  }
  assert.equal(runFieldLabel("person", "trigger"), "Opens with", '"TRIGGER" on a person means nothing');
  assert.equal(runFieldLabel("dressing", "looks"), "Detail", '"LOOKS" labels the thing that IS the dressing');
  assert.equal(runFieldLabel("gm", "gives"), "Do", "a GM box is instruction, not description");
  // Unmapped keys still fall through to the generic label.
  assert.equal(runFieldLabel("person", "nosuchfield", "Fallback"), "Fallback");
});

test("Prep and Run print the SAME label for a person's fields", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "prl-floor" });
  await makeEl(scene.id, {
    name: "Bashir",
    fields: { trigger: "Walks over with the board.", wants: "The count to come out even.", means: "He is paid per body." },
    run: { column: "main", role: "person" }
  });

  const page = await openScene(scene.id);

  const prep = await page.locator('[data-testid="scene-elements-list"]').innerText();
  assert.match(prep, /OPENS WITH/i, "Prep must use the role-aware label");
  assert.doesNotMatch(prep, /\bTRIGGER\b/i, 'Prep must no longer say "TRIGGER" on a person');

  await page.locator('[data-testid="mode-run-btn"]').click();
  await page.locator('[data-testid="scene-run-spread"]').waitFor({ state: "visible", timeout: 15000 });
  const run = await page.locator('[data-testid="scene-run-spread"]').innerText();
  assert.match(run, /Lever/i, "Run must use the same role-aware label Prep does");
  assert.doesNotMatch(run, /\bMEANS\b/i, "Run must not fall back to the generic label");

  await page.close();
});

test("a GM box labels its fields in Run instead of printing anonymous paragraphs", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "prl-floor" });
  await makeEl(scene.id, {
    name: "If they stall",
    fields: { looks: "The clerk waits.", gives: "Call for the overseer.", secret: "The overseer is already bought." },
    run: { column: "side", role: "gm" }
  });

  const page = await openScene(scene.id);
  await page.locator('[data-testid="mode-run-btn"]').click();
  const spread = page.locator('[data-testid="scene-run-spread"]');
  await spread.waitFor({ state: "visible", timeout: 15000 });

  // Labels are uppercased by CSS, so innerText reads "DOCall for the
  // overseer." -- match case-insensitively, anchored on the value that
  // follows, which is what proves the label is attached to the right field.
  const text = await spread.innerText();
  assert.match(text, /DO\s*Call for the overseer/i, "the instruction field must be labelled");
  assert.match(text, /SECRET\s*The overseer is already bought/i, "the secret must be labelled as a secret");
  assert.doesNotMatch(text, /^\s*Call for the overseer/m, "it must no longer print as an anonymous paragraph");
  // And it must carry the real secret treatment, not just the word.
  assert.ok(
    await spread.locator(".rs-l--secret").count() > 0,
    "a GM box's secret must render with the secret treatment"
  );

  await page.close();
});

test("an exits element's secret never renders in the public exits footer, and Prep stops offering the chip", async () => {
  const scene = await createSceneViaRoute(base, WORLD, { locationEntityId: "prl-floor" });
  await makeEl(scene.id, {
    name: "Ways out",
    fields: {
      gives: "PLOT: Down to the cisterns → The Boiling Steps",
      secret: "The stair behind the kiln is watched."
    },
    run: { column: "main", role: "exits" }
  });

  const page = await openScene(scene.id);

  // Prep must not offer a + SECRET chip on an exits element.
  const row = page.locator('[data-testid="scene-element-row"]').first();
  await row.hover();
  const addBtn = row.locator(".scene-add-field-btn").first();
  if (await addBtn.count()) {
    await addBtn.click();
    const options = await row.locator(".scene-add-field-option").allInnerTexts();
    assert.ok(
      !options.some((o) => /secret/i.test(o)),
      `an exits element must not be offered a SECRET field; got ${JSON.stringify(options)}`
    );
  }

  await page.locator('[data-testid="mode-run-btn"]').click();
  const spread = page.locator('[data-testid="scene-run-spread"]');
  await spread.waitFor({ state: "visible", timeout: 15000 });

  // The existing secret still renders -- data already on disk must not vanish --
  // but as a real secret, not as an anonymous public exit line.
  const secretLines = spread.locator(".rs-l--secret");
  assert.ok(await secretLines.count() > 0, "the secret must still be shown to the GM");
  assert.match(await spread.innerText(), /The stair behind the kiln is watched/);

  // And it must NOT be inside the exit rows themselves.
  const exitRowText = (await spread.locator(".rs-exit").allInnerTexts()).join(" ");
  assert.doesNotMatch(
    exitRowText,
    /stair behind the kiln/,
    "the secret must not be pooled in with the public exit lines"
  );

  await page.close();
});
