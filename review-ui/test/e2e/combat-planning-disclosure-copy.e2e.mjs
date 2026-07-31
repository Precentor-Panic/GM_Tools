// Phase 19 task 19.0 -- proactive e2e test, written BEFORE the Encounter
// Builder UI exists. REQUIRED SCENARIO 9: "Adjust-panel disclosure trigger
// contains no provisional-sounding copy." EXPECTED TO FAIL right now with a
// Playwright selector-not-found/timeout error -- see
// combat-planning-live-recompute.e2e.mjs's header for the shared nav/
// routing contract and the `[data-testid="adjust-panel-toggle"]` /
// `[data-testid="adjust-panel"]` contract (task 19.4).
//
// Direct test of design record §1's round-3 refinement: "its trigger must
// not INVITE the click: no '3 more options available'-style nudge copy
// implying the suggestion is provisional. If the suggestion looks done,
// there should be no visual reason to open it." A simple, deliberately
// LIGHT check per task 19.0's own framing ("a lighter check... a
// copy-discipline requirement, test it as a simple string-absence check
// against the rendered DOM text") -- this file asserts the TRIGGER's own
// rendered text against a curated list of banned provisional-sounding
// phrases, case-insensitively, and separately confirms the panel is closed
// by default (task 19.4's own stated requirement, reused here as a cheap
// sanity check that this test is looking at the right, not-yet-opened
// element).
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

const { scratchDir } = setupScratchEnv("gm-tools-e2e-cp-disclosure-");
const WORLD = "e2e-cp-disclosure-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { createReviewServer } = await import("../../server.mjs");

let server, base, browser, page;

// The design record's own two named examples plus close paraphrases of the
// same "there's more/better if you dig deeper" implication.
const BANNED_PROVISIONAL_PHRASES = [
  "more options",
  "try adjusting",
  "more available",
  "options available",
  "tweak for a better",
  "not quite right",
  "fine-tune for accuracy"
];

before(async () => {
  await seedAcceptedBestiaryEntry({ rawFields: fullProfileRawFields({ name: "Disclosure Copy Goblin" }) });
  await seedPartyMember(WORLD, { name: "Disclosure Copy PC", combatRelevant: { class: "Fighter", level: 5, ac: 16, hp: 40, damagePerRoundEstimate: 16 } });

  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("the Adjust-panel trigger's rendered text contains no provisional-sounding copy, and the panel is closed by default", async () => {
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#combat-planning`);
  await page.locator('[data-testid="difficulty-tier"][data-tier="medium"]').click();

  const trigger = page.locator('[data-testid="adjust-panel-toggle"]');
  await trigger.waitFor({ state: "visible", timeout: 15000 });
  const triggerText = ((await trigger.textContent()) || "").toLowerCase();

  for (const phrase of BANNED_PROVISIONAL_PHRASES) {
    assert.ok(
      !triggerText.includes(phrase),
      `the Adjust-panel trigger's rendered text must not contain the provisional-sounding phrase "${phrase}" -- got trigger text "${triggerText}"`
    );
  }
  assert.ok(triggerText.trim().length > 0, "the trigger must render SOME real label text (not an empty/icon-only element this check couldn't meaningfully assert on)");

  // Sanity: closed by default (task 19.4's own stated requirement) --
  // confirms this test found the real, not-yet-opened trigger.
  const panel = page.locator('[data-testid="adjust-panel"]');
  assert.equal(
    await panel.isVisible().catch(() => false),
    false,
    "the Adjust panel must be closed by default -- if it's already open, this test may not be checking the trigger's actual closed-state copy"
  );
});
