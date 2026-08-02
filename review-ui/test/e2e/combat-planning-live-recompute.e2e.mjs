// Phase 19 task 19.0 -- proactive e2e test, written BEFORE the Encounter
// Builder UI exists (tasks 19.1-19.6), per plans/phase-19-tasks.md task
// 19.0's REQUIRED SCENARIO 1: "Live recompute, no stale caching."
// EXPECTED TO FAIL right now with a Playwright "waiting for selector" /
// timeout error at the very first selector lookup below -- none of this DOM
// exists yet. That failure is the deliverable, same discipline as Phase
// 17.0's session-planner-*.e2e.mjs files: the selectors below ARE the
// implementation contract tasks 19.1/19.2/19.5 must build to match, not
// re-derive independently.
//
// See combat-planning-fixture.mjs's own header for: (1) why this file's
// fixture setup calls combat-planning/bestiary-store.mjs and party-roster-
// store.mjs DIRECTLY rather than driving the real ingest HTTP routes (no
// ANTHROPIC_API_KEY in this environment, and server.mjs has no way to inject
// a fake LLM client at the route layer -- an established, pre-existing
// project convention, not a Phase 19 gap); (2) the REQUIRED, currently-
// unshipped additive extension to POST /api/combat-planning/encounter-suggest
// (themeText / attendingMemberIds / manualCombination, all optional,
// backward-compatible) that this file's own live-recompute assertions below
// depend on -- every request this file's test bodies describe sends
// `themeText: ""` (or omits it), so NONE of this file's scenarios need any
// LLM-call mock; the two real LLM call sites (ingestion submit, non-blank
// theme-box submit) are OUT OF SCOPE for this file, covered instead by
// combat-planning-ingestion-flagging.e2e.mjs and
// combat-planning-loading-scope.e2e.mjs.
//
// ---------------------------------------------------------------------------
// FULL DOM CONTRACT for review-ui/public/combat-planning-view.js (tasks
// 19.1-19.6) -- this is the canonical, most-complete copy; every sibling
// combat-planning-*.e2e.mjs file's own header documents only the SUBSET of
// this contract its own scenario depends on, with a pointer back here for
// anything shared, mirroring session-planner-flush-on-navigate.e2e.mjs /
// session-planner-recenter-race.e2e.mjs's own "mirrored verbatim so the
// files never silently disagree" convention -- except here, given 9 sibling
// files, the shared piece lives in ONE place (this file) rather than being
// literally re-pasted 9 times.
// ---------------------------------------------------------------------------
//
// NAV + ROUTING (task 19.1):
//   - `.topnav button[data-nav="combat-planning"][data-testid="combat-planning-nav"]`
//     -- same list as Queue/New Import/Deferred Debt/Graph/Plan Session in
//     index.html.
//   - `#combat-planning` hash route -> `<section id="view-combat-planning"
//     class="view">`, the main builder (difficulty rail + roster strip +
//     score band + two disclosures + catalog), same `.view`/`#view-${view}`
//     active-toggle convention every other view already uses
//     (renderCurrentView()'s existing dispatch chain in app.js gains
//     `else if (view === "combat-planning") renderCombatPlanning();`).
//   - `#combat-planning-ingest/bestiary` and `#combat-planning-ingest/party-roster`
//     hash routes (arg-driven, matching `#session-planner/<sceneId>`'s own
//     `view/arg` convention) -> `<section id="view-combat-planning-ingest"
//     class="view">`, the ingestion screens (task 19.1, own contract
//     documented in combat-planning-ingestion-flagging.e2e.mjs). Reached from
//     the builder view via `[data-testid="add-monster-link"]` /
//     `[data-testid="add-party-member-link"]`.
//   - World selection: reads the SAME `localStorage.getItem("gmReview.world")`
//     key app.js's own world-select already writes, matching
//     session-planner-view.js's own `currentWorld()` convention exactly
//     (this file is standalone, no import from app.js, per that same
//     precedent).
//
// DIFFICULTY RAIL (task 19.2):
//   - `[data-testid="difficulty-tier"][data-tier="easy"|"medium"|"hard"|"deadly"]`
//     -- four large primary click targets.
//   - `[data-testid="difficulty-numeric-chip"]` -- a small click-to-edit
//     numeric input showing/editing the CURRENT active target number (design
//     record §1: "a small click-to-edit numeric chip next to whichever tier
//     is active").
//   - Clicking a tier (or committing an edited numeric-chip value) is THE
//     "declare intent" / "one-click gut-check" action -- no separate
//     Generate button. It fires `POST /api/combat-planning/encounter-suggest`
//     with body `{world, targetDifficulty, knobs, attendingMemberIds,
//     themeText:""}` (NO `manualCombination` -- this is the one call site
//     that uses the server's own auto-fill), and the response's
//     `suggestion.combination` REPLACES the working roster wholesale
//     (becoming the starting point for any subsequent catalog-driven
//     adjustment).
//
// ROSTER / ATTENDANCE STRIP (task 19.2):
//   - `[data-testid="roster-chip"][data-member-id="<id>"]` -- one per
//     `listPartyMembers(world)` entry, containing
//     `[data-testid="roster-chip-checkbox"]` (checked BY DEFAULT) and (task
//     19.3/19.6) `[data-testid="roster-chip-hp-staleness"]` (own contract in
//     combat-planning-hp-staleness.e2e.mjs).
//   - Unchecking a chip removes that member's id from `attendingMemberIds`
//     on every subsequent encounter-suggest call (design record §1: "a
//     two-click swap... removes that member from the array passed into
//     suggestEncounter/computeSnowballDelta") and triggers an immediate
//     recompute using the CURRENT working combination (i.e. a
//     `manualCombination`-mode call if a working combination already exists,
//     matching the "live recompute, roster half" requirement this file's own
//     test exercises) -- localStorage-persisted per world at
//     `gmReview.combatPlanning.attendance.<world>` (JSON array of currently
//     UNCHECKED member ids; absent/empty = full attendance, matching
//     graph-view.js's own cached-state convention).
//
// SCORE BAND (task 19.3, own detailed contract in
// combat-planning-score-band-defaults.e2e.mjs /
// combat-planning-hp-staleness.e2e.mjs):
//   - `[data-testid="score-band"]` container.
//   - `[data-testid="expected-score-value"]` -- the dominant figure (Plain:
//     tier word; Precise: number + all four tier thresholds).
//   - `[data-testid="snowball-pill-damage"]` / `[data-testid="snowball-pill-hp"]`
//     -- permanent, both Plain/Precise modes.
//   - `[data-testid="burst-ceiling-badge"]`.
//   - `[data-testid="attendance-staleness-line"]`.
//
// WORKING ROSTER (tasks 19.2/19.5 -- the actual combatant list currently
// being scored; feeds both the score band above and the "Why this score?"
// breakdown, task 19.4):
//   - `[data-testid="working-roster"]` container.
//   - `[data-testid="working-combatant-row"][data-entry-id="<id>"][data-origin="group"|"individual"]`
//     -- one per distinct combatant instance/group currently in the working
//     roster. A `data-origin="group"` row (created by a difficulty-tier
//     auto-suggestion, mirroring suggestEncounter's own native
//     `{entryId,count}` combination shape 1:1) carries `[data-testid="working-combatant-count"]`
//     showing its count. A `data-origin="individual"` row (created by a
//     catalog `+Add` click) always has count 1 and a unique
//     `data-instance-id`.
//   - Phase 20 task 20.4 (real removal + correct control placement, see
//     combat-planning-catalog-add-fork.e2e.mjs's own detailed, up-to-date
//     contract) relocated count/removal controls OUT of the catalog row and
//     INTO the working roster: a group-origin row carries
//     `[data-testid="working-roster-stepper"]` (`-minus`/`-plus`, adjusting
//     count in place, `-` at count 1 removes the row), and EVERY row
//     regardless of origin carries `[data-testid="working-roster-remove-btn"]`
//     (an explicit [x] removing that specific row -- by `data-instance-id`
//     for an individual row, never a broad "all individual rows of this
//     entryId" removal).
//
// TWO DISCLOSURES (task 19.4, own detailed contract in
// combat-planning-disclosure-copy.e2e.mjs):
//   - `[data-testid="adjust-panel-toggle"]` / `[data-testid="adjust-panel"]`
//     -- editable knobs: `[data-testid="knob-minion-rules"]` (checkbox),
//     `[data-testid="knob-legendary-actions"]` (checkbox),
//     `[data-testid="knob-scaling-slider"]`, `[data-testid="knob-player-tactics-slider"]`
//     (range inputs), `[data-testid="knob-pack-coefficient"]`. Closed by
//     default. Changing ANY knob triggers an immediate recompute of the
//     CURRENT working roster (manualCombination-mode encounter-suggest call
//     with the new knob values) -- this file's own test exercises this as
//     live-recompute mutation type 3.
//   - `[data-testid="why-score-toggle"]` / `[data-testid="why-score-panel"]`
//     -- read-only, own contract not exercised by this file.
//
// CATALOG (task 19.5, own detailed contract split across
// combat-planning-catalog-add-fork.e2e.mjs / combat-planning-confidence-format.e2e.mjs
// / combat-planning-intrinsic-score.e2e.mjs):
//   - `[data-testid="catalog"]` container; `[data-testid="catalog-row"][data-entry-id="<id>"]`
//     one per `status:"accepted"` bestiary entry (this suite's own
//     convention: the catalog only ever shows accepted entries, matching
//     bestiary-store.mjs's proposed/accepted/discarded lifecycle -- a
//     `status:"proposed"` entry belongs on the ingestion review screen, not
//     the catalog).
//   - A catalog row is now (task 20.4) a simple binary toggle:
//     `[data-testid="catalog-add-btn"]` ("+ Add") when this entryId has NO
//     row in the working roster yet -- clicking it adds ONE
//     `data-origin="individual"` row (this file's own test only ever clicks
//     Add on an entry that isn't already present, so this is the one
//     behavior it relies on) -- or `[data-testid="catalog-remove-btn"]`
//     ("Remove") once it has ANY row, clicking which removes every row for
//     that entryId. Own full contract/test in
//     combat-planning-catalog-add-fork.e2e.mjs. A successful add still
//     triggers a recompute (manualCombination-mode encounter-suggest call
//     reflecting the updated working roster) -- THIS is live-recompute
//     mutation type 2, exercised by this file's own test.
//
// LIVE-RECOMPUTE / NO-STALE-CACHING (design record §1, plans/phase-19-tasks.md
// task 19.0 scenario 1 -- THE SUBJECT OF THIS FILE): every one of the three
// mutation types above (roster attendance toggle, catalog add/remove, Adjust
// knob change) must, EVERY time, produce a freshly-rendered
// `expected-score-value` that reflects the NEW state -- never a value left
// over from a PRIOR mutation, and never a value that silently fails to
// update because some intermediate layer cached the previous
// encounter-suggest response. This test drives all three mutation types in
// sequence against the SAME session and asserts the rendered score changes
// (or, for the party-only-affecting mutation, that the party-dependent
// snowball figures change) after each one, with no reload between them --
// exactly the scenario a naive "compute once on mount, only re-render on
// unrelated updates" implementation would get wrong.
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

const { scratchDir, dataDir } = setupScratchEnv("gm-tools-e2e-cp-recompute-");
const WORLD = "e2e-cp-recompute-world";
process.env.WF_DEFAULT_WORLD = WORLD;
void dataDir; // this suite never touches the WF graph -- bestiary/party-roster are deliberately not graph-backed (design record §1a)

const { createReviewServer } = await import("../../server.mjs");

let server, base, browser, page;
let goblinEntry, ogreEntry;
let heavyDamageMember, tankMember;

before(async () => {
  // Two catalog-addable monsters: a light one (already present in the
  // combination the difficulty rail is expected to auto-suggest at a low
  // target) and a heavier second one this test manually +Adds to force a
  // visible expectedScore change (mutation type 2).
  goblinEntry = await seedAcceptedBestiaryEntry({ rawFields: fullProfileRawFields({ name: "Recompute Goblin" }) });
  ogreEntry = await seedAcceptedBestiaryEntry({
    rawFields: fullProfileRawFields({
      name: "Recompute Ogre",
      hp: 59,
      ac: 11,
      attacks: [{ name: "Greatclub", toHitBonus: 6, damageDice: "2d8+4", damageType: "bludgeoning" }]
    })
  });

  // Two party members with clearly different damage/hp profiles so
  // toggling one off measurably changes computeSnowballDelta's output
  // (mutation type 1) -- the party's own damagePerRoundEstimate/hp fields,
  // per party-roster-ingest.mjs's RawPartyMemberFields.combatRelevant shape.
  heavyDamageMember = await seedPartyMember(WORLD, {
    name: "Recompute Heavy Damage PC",
    combatRelevant: { class: "Fighter", level: 5, ac: 17, hp: 44, attackBonus: 7, damagePerRoundEstimate: 24 }
  });
  tankMember = await seedPartyMember(WORLD, {
    name: "Recompute Tank PC",
    combatRelevant: { class: "Paladin", level: 5, ac: 19, hp: 52, attackBonus: 6, damagePerRoundEstimate: 10 }
  });

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

test("live recompute: roster-attendance toggle, catalog add, and knob change each produce a freshly-rendered score, never a stale prior value", async () => {
  await primeWorldSelection(page, base, WORLD);
  await page.goto(`${base}/#combat-planning`);

  const scoreBand = page.locator('[data-testid="score-band"]');
  await scoreBand.waitFor({ state: "visible", timeout: 15000 });

  // Precise mode (not the default Plain mode) -- Plain only ever renders a
  // quantized TIER WORD (Trivial/Easy/Medium/Hard/Deadly), so two genuinely
  // different raw scores landing in the same tier bucket would render
  // byte-identical text and falsely look like a stale/no-op recompute.
  // Precise always renders the raw number, which is what this test's own
  // "never a stale prior value" assertions actually need to be reliable.
  await page.locator('[data-testid="mode-toggle-precise"]').click();

  // --- Establish a starting suggestion (difficulty-rail click) ---------
  // "easy" (not "medium") deliberately -- at "medium" the greedy auto-fill
  // picks BOTH goblinEntry AND ogreEntry (confirmed directly), which would
  // leave ogreEntry already present as a data-origin="group" row before
  // MUTATION TYPE 2 below ever gets to it. Since task 20.4 made the catalog
  // row a binary Add/Remove toggle (an entry already in the working roster
  // shows "Remove", not "+Add"), that collision would make the
  // catalog-add-btn lookup below fail to find anything -- "easy" keeps this
  // test's own two fixture monsters cleanly separated (only goblinEntry is
  // auto-picked), matching the comment on goblinEntry/ogreEntry above.
  await page.locator('[data-testid="difficulty-tier"][data-tier="easy"]').click();
  const expectedScoreEl = page.locator('[data-testid="expected-score-value"]');
  await expectedScoreEl.waitFor({ state: "visible", timeout: 10000 });
  const scoreAfterDifficultyClick = (await expectedScoreEl.textContent()).trim();
  assert.ok(scoreAfterDifficultyClick.length > 0, "expected-score-value must render real text after the first suggestion");

  // ===================== MUTATION TYPE 1: roster attendance =====================
  const snowballDamagePill = page.locator('[data-testid="snowball-pill-damage"]');
  await snowballDamagePill.waitFor({ state: "visible", timeout: 10000 });
  const snowballBeforeToggle = (await snowballDamagePill.textContent()).trim();

  const heavyChip = page.locator(`[data-testid="roster-chip"][data-member-id="${heavyDamageMember.id}"]`);
  await heavyChip.locator('[data-testid="roster-chip-checkbox"]').uncheck();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      ({ selector, prev }) => document.querySelector(selector)?.textContent?.trim() !== prev,
      { selector: '[data-testid="snowball-pill-damage"]', prev: snowballBeforeToggle },
      { timeout: 10000 }
    );
  }, "unchecking the top-damage party member's attendance chip must change the rendered snowball-delta figure (it is computed FROM the checked-in party) -- a value byte-identical to before the toggle means the recompute never happened or a stale response was reused");

  // ===================== MUTATION TYPE 2: catalog add/remove =====================
  const scoreBeforeCatalogAdd = (await expectedScoreEl.textContent()).trim();
  const ogreRow = page.locator(`[data-testid="catalog-row"][data-entry-id="${ogreEntry.id}"]`);
  await ogreRow.waitFor({ state: "visible", timeout: 10000 });
  await ogreRow.locator('[data-testid="catalog-add-btn"]').click();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      ({ selector, prev }) => document.querySelector(selector)?.textContent?.trim() !== prev,
      { selector: '[data-testid="expected-score-value"]', prev: scoreBeforeCatalogAdd },
      { timeout: 10000 }
    );
  }, "adding a second (heavier) monster to the working roster via the catalog's +Add must change the rendered expected-score-value -- a value identical to before the add means the recompute never happened or a stale response was reused");

  const newRow = page.locator(`[data-testid="working-combatant-row"][data-entry-id="${ogreEntry.id}"][data-origin="individual"]`);
  await newRow.waitFor({ state: "visible", timeout: 5000 });

  // ===================== MUTATION TYPE 3: Adjust-panel knob change =====================
  const scoreBeforeKnobChange = (await expectedScoreEl.textContent()).trim();
  await page.locator('[data-testid="adjust-panel-toggle"]').click();
  const legendaryKnob = page.locator('[data-testid="knob-legendary-actions"]');
  await legendaryKnob.waitFor({ state: "visible", timeout: 5000 });
  // Flip it (default per encounter-heuristic.mjs's DEFAULT_KNOBS is `true`)
  // -- toggling `legendaryActions` off subtracts legendaryActionValue from
  // any combatant that has legendary actions, or is a real, if occasionally
  // zero-magnitude, knob; this test's fixture data has no legendary-action
  // monster, so instead exercise a knob guaranteed to move the number for
  // ANY non-empty combination: scalingSlider.
  await page.locator('[data-testid="knob-scaling-slider"]').fill("1.5");

  await assert.doesNotReject(async () => {
    await page.waitForFunction(
      ({ selector, prev }) => document.querySelector(selector)?.textContent?.trim() !== prev,
      { selector: '[data-testid="expected-score-value"]', prev: scoreBeforeKnobChange },
      { timeout: 10000 }
    );
  }, "changing the scaling-slider knob in the Adjust panel must change the rendered expected-score-value for the CURRENT working roster -- a value identical to before the knob change means the recompute never happened or a stale response was reused");

  void goblinEntry; void tankMember; // referenced only for fixture-setup realism (a real 2-monster/2-PC roster, not a degenerate single-entry one)
});
