// Phase 19 task 19.0 -- proactive e2e test, written BEFORE the Encounter
// Builder UI exists. REQUIRED SCENARIOS 6 + 7 (grouped in one file --
// both are score-band-area default/fixture-presence checks, per this
// file's own scope): "Plain-mode default and permanent fixtures" and
// "Attendance-staleness line suppressed at full attendance." EXPECTED TO
// FAIL right now with a Playwright selector-not-found/timeout error -- see
// combat-planning-live-recompute.e2e.mjs's header for the full shared DOM
// contract.
//
// ---------------------------------------------------------------------------
// PLAIN/PRECISE TOGGLE (task 19.3, design record §1: styled like the
// existing List/Graph toggle -- review-ui/public/index.html's
// `#review-mode-toggle`/`[data-review-mode]` convention -- localStorage-
// persisted, DEFAULT PLAIN):
// ---------------------------------------------------------------------------
//   - `[data-testid="mode-toggle-plain"]` / `[data-testid="mode-toggle-precise"]`
//     buttons, one carrying an `active` class at a time (mirroring
//     `#review-mode-toggle`'s own `.active`-class convention exactly).
//   - localStorage key `gmReview.combatPlanning.scoreMode` -- ABSENT (a
//     genuinely fresh session, this test's own setup) means Plain, per
//     design record §1: "this default was chosen specifically because a
//     narrative-light DM's warning... applies to anyone's FIRST look at the
//     tool, not just that persona."
//
// PERMANENT FIXTURES (design record §1, explicit: "Two things are
// PERMANENT, mode-independent fixtures, never gated behind the
// Plain/Precise toggle"):
//   - `[data-testid="snowball-pill-damage"]` / `[data-testid="snowball-pill-hp"]`
//     -- visible in BOTH modes (this test toggles to Precise and back,
//     confirming presence at every step).
//   - `[data-testid="burst-ceiling-badge"]` -- visible in BOTH modes,
//     WHENEVER the current working roster has a nonzero burst ceiling (per
//     combat-planning-live-recompute.e2e.mjs's own header: "visually
//     absent, not just subtle, when never touched by tooling" -- this
//     file's fixture includes a recharge-ability monster specifically so
//     the badge has something real to show in both modes, rather than
//     conflating "never gated behind Plain/Precise" with the separate
//     "absent when genuinely zero" case, which is not this scenario's
//     concern).
//
// ATTENDANCE-STALENESS LINE (task 19.2/19.3, design record §1: "whenever
// checked attendance differs from the full roster, a literal sentence
// renders under the score band... Suppressed at full attendance"):
//   - `[data-testid="attendance-staleness-line"]` -- ABSENT from the DOM
//     entirely (not just hidden/empty text) at full attendance; PRESENT,
//     containing the CORRECT checked-in count/total AND the correct
//     checked-in member names, once at least one roster chip is unchecked.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { chromium } from "playwright";
import {
  setupScratchEnv,
  cleanupScratchEnv,
  DESKTOP_VIEWPORT,
  primeWorldSelection,
  seedAcceptedBestiaryEntry,
  seedPartyMember,
  fullProfileRawFields
} from "./combat-planning-fixture.mjs";

const { scratchDir } = setupScratchEnv("gm-tools-e2e-cp-scoreband-");
const WORLD = "e2e-cp-scoreband-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { createReviewServer } = await import("../../server.mjs");

let server, base, browser, page;
let memberA, memberB, memberC;

before(async () => {
  await seedAcceptedBestiaryEntry({
    rawFields: fullProfileRawFields({
      name: "Scoreband Recharge Drake",
      hp: 50,
      ac: 15,
      rechargeAbilities: [{ name: "Fire Breath", rechargeOn: "5-6", damageDice: "6d6" }]
    })
  });
  memberA = await seedPartyMember(WORLD, { name: "Scoreband PC Alice", combatRelevant: { class: "Fighter", level: 5, ac: 17, hp: 44, damagePerRoundEstimate: 20 } });
  memberB = await seedPartyMember(WORLD, { name: "Scoreband PC Bram", combatRelevant: { class: "Wizard", level: 5, ac: 13, hp: 30, damagePerRoundEstimate: 22 } });
  memberC = await seedPartyMember(WORLD, { name: "Scoreband PC Cora", combatRelevant: { class: "Cleric", level: 5, ac: 16, hp: 38, damagePerRoundEstimate: 12 } });

  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  browser = await chromium.launch();
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("scenario 6 -- a genuinely fresh session defaults to Plain mode; snowball-delta and burst-ceiling stay visible in both modes", async () => {
  // A brand-new browser CONTEXT (not just a new page) so localStorage is
  // guaranteed genuinely empty -- reusing `page` across tests in this file
  // would risk carrying over a previously-set scoreMode key.
  const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
  const freshPage = await context.newPage();
  await primeWorldSelection(freshPage, base, WORLD);
  await freshPage.goto(`${base}/#combat-planning`);

  const storedMode = await freshPage.evaluate(() => localStorage.getItem("gmReview.combatPlanning.scoreMode"));
  assert.equal(storedMode, null, "sanity: this test's own fresh context must have no pre-existing scoreMode key");

  await freshPage.locator('[data-testid="difficulty-tier"][data-tier="hard"]').click();
  const plainBtn = freshPage.locator('[data-testid="mode-toggle-plain"]');
  await plainBtn.waitFor({ state: "visible", timeout: 15000 });
  assert.match(
    (await plainBtn.getAttribute("class")) || "",
    /\bactive\b/,
    "a genuinely fresh session (no localStorage scoreMode) must default to Plain mode -- mode-toggle-plain must carry the active class"
  );

  // Permanent fixtures visible in Plain mode.
  await freshPage.locator('[data-testid="snowball-pill-damage"]').waitFor({ state: "visible", timeout: 10000 });
  await freshPage.locator('[data-testid="snowball-pill-hp"]').waitFor({ state: "visible", timeout: 5000 });
  await freshPage.locator('[data-testid="burst-ceiling-badge"]').waitFor({ state: "visible", timeout: 5000 });

  // Switch to Precise -- same two fixtures must STILL be visible, unchanged
  // by the mode toggle (design record: "never gated behind the
  // Plain/Precise toggle").
  await freshPage.locator('[data-testid="mode-toggle-precise"]').click();
  await assert.doesNotReject(
    async () => freshPage.locator('[data-testid="mode-toggle-precise"][class*="active"]').waitFor({ state: "visible", timeout: 5000 }),
    "clicking mode-toggle-precise must actually switch the active mode"
  );
  await freshPage.locator('[data-testid="snowball-pill-damage"]').waitFor({ state: "visible", timeout: 5000 });
  await freshPage.locator('[data-testid="snowball-pill-hp"]').waitFor({ state: "visible", timeout: 5000 });
  await freshPage.locator('[data-testid="burst-ceiling-badge"]').waitFor({ state: "visible", timeout: 5000 });

  // Switch back to Plain -- still present.
  await freshPage.locator('[data-testid="mode-toggle-plain"]').click();
  await freshPage.locator('[data-testid="snowball-pill-damage"]').waitFor({ state: "visible", timeout: 5000 });
  await freshPage.locator('[data-testid="burst-ceiling-badge"]').waitFor({ state: "visible", timeout: 5000 });

  await context.close();
});

test("scenario 7 -- attendance-staleness line is absent at full attendance, present with correct names/count otherwise", async () => {
  const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
  const p = await context.newPage();
  await primeWorldSelection(p, base, WORLD);
  await p.goto(`${base}/#combat-planning`);

  await p.locator('[data-testid="difficulty-tier"][data-tier="medium"]').click();
  await p.locator('[data-testid="score-band"]').waitFor({ state: "visible", timeout: 15000 });

  // Full attendance (default: every roster-chip-checkbox checked) -- the
  // line must be ABSENT from the DOM, not just empty/hidden text.
  assert.equal(
    await p.locator('[data-testid="attendance-staleness-line"]').count(),
    0,
    "at full attendance (the default -- every chip checked), the attendance-staleness line must not exist in the DOM at all"
  );

  // Uncheck one of three members -> 2/3 present.
  await p.locator(`[data-testid="roster-chip"][data-member-id="${memberB.id}"] [data-testid="roster-chip-checkbox"]`).uncheck();

  const staleLine = p.locator('[data-testid="attendance-staleness-line"]');
  await staleLine.waitFor({ state: "visible", timeout: 10000 });
  const lineText = (await staleLine.textContent()).trim();
  assert.ok(lineText.includes("2") && lineText.includes("3"), `attendance-staleness line must contain the correct present/total count "2"/"3"; got "${lineText}"`);
  assert.ok(lineText.includes(memberA.name), `attendance-staleness line must name the CHECKED-IN "${memberA.name}"; got "${lineText}"`);
  assert.ok(lineText.includes(memberC.name), `attendance-staleness line must name the CHECKED-IN "${memberC.name}"; got "${lineText}"`);
  assert.ok(!lineText.includes(memberB.name), `attendance-staleness line must NOT name the unchecked "${memberB.name}" (a full-roster line, not a departed-members line); got "${lineText}"`);

  // Re-check the member -> back to full attendance -> line disappears again.
  await p.locator(`[data-testid="roster-chip"][data-member-id="${memberB.id}"] [data-testid="roster-chip-checkbox"]`).check();
  await assert.doesNotReject(async () => {
    await p.waitForFunction(() => document.querySelector('[data-testid="attendance-staleness-line"]') === null, { timeout: 10000 });
  }, "re-checking the unchecked member back to full attendance must remove the attendance-staleness line from the DOM again");

  await context.close();
});
