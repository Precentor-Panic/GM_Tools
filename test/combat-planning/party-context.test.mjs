import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — combat-planning/party-context.mjs's getPartyContext
 * (Phase 18 task 18.6). This module does not exist yet; this file is the
 * interface spec for it, per plans/phase-18-tasks.md task 18.0. It is
 * expected to fail with "Cannot find module" until 18.6 lands.
 *
 * Design record §3: "A compact, prose-ready summary of the party's
 * build-relevant details (skills/expertise, notable traits, backstory hooks
 * -- the non-combat half of §1b's extraction), in the same spirit as
 * buildAdjacencyContext grounding narration in real graph neighbors."
 * EXPLICITLY OPT-IN PER CALL SITE, NEVER FORCE-INJECTED (task 18.0's own
 * hard requirement) -- this file's SECOND half is a grep/import-based test
 * (not just a unit test of the function itself) confirming
 * mutation-engine/narrate.mjs and mutation-engine/texture.mjs do NOT import
 * or call it, proving it hasn't been silently wired in as a default.
 *
 * Reads from combat-planning/party-roster-store.mjs's listPartyMembers(world)
 * -- pulls ONLY buildRelevant fields (skills, expertise, notableTraits,
 * backstoryHooks). combatRelevant fields (AC, HP, attack bonus, etc.) MUST
 * NEVER appear in the returned prose -- those stay internal to the
 * encounter heuristic (task 18.6's own explicit instruction: "NOT the
 * combat-relevant fields, which stay internal to the heuristic").
 *
 * ---------------------------------------------------------------------------
 * getPartyContext(world)
 * ---------------------------------------------------------------------------
 * @param {string} world
 * @returns {string}   a compact, prose-ready summary of every party
 *   member's buildRelevant fields. Returns an empty string (not an error,
 *   not a fabricated placeholder) for a world with no party roster ingested
 *   yet -- matching this project's "render empty rather than padded"
 *   discipline (Phase 16/17's ambient-digest precedent, applied here to a
 *   different kind of emptiness).
 */

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-party-context-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PARTY_ROSTER_DIR = join(scratchDir, "party-roster");

const WORLD = "party-context-test-world";

(async () => {
  const { getPartyContext } = await import("../../combat-planning/party-context.mjs");
  const { savePartyMember } = await import("../../combat-planning/party-roster-store.mjs");

  test("getPartyContext: an empty string (not an error, not a fabricated placeholder) for a world with no roster ingested yet", () => {
    const ctx = getPartyContext("a-totally-new-world-with-no-roster");
    assert.equal(ctx, "");
  });

  test("getPartyContext: includes buildRelevant content (a skill, a backstory hook) once a member is saved", () => {
    savePartyMember(
      WORLD,
      {
        name: "Kessa Windrider",
        combatRelevant: { class: "Ranger", level: 5, ac: 15, hp: 44, damagePerRoundEstimate: 18 },
        buildRelevant: {
          skills: ["Survival"],
          notableTraits: ["Grew up in the Ashfen Marsh"],
          backstoryHooks: ["Estranged from a ranger lodge she left under a cloud"]
        }
      },
      { makeId: () => "pm-ctx-1", now: "2026-07-22T18:00:00.000Z" }
    );
    const ctx = getPartyContext(WORLD);
    assert.ok(ctx.includes("Kessa Windrider"), "must name the party member");
    assert.ok(
      ctx.includes("ranger lodge") || ctx.includes("Ashfen Marsh"),
      "must include at least one real buildRelevant detail, not a generic placeholder"
    );
  });

  test("getPartyContext: NEVER includes combatRelevant fields (AC/HP/damage numbers) -- those stay internal to the heuristic", () => {
    const ctx = getPartyContext(WORLD);
    assert.ok(!/\bAC\b/.test(ctx), "must not surface AC");
    assert.ok(!/\b44\s*(hp|HP)\b/.test(ctx), "must not surface the raw HP figure");
    assert.ok(!/\bdamagePerRound/i.test(ctx), "must not surface the combat-relevant field name at all");
  });

  test("getPartyContext: is a plain string return type, not an object/promise -- opt-in call sites can splice it straight into a prompt template with no further unwrapping", () => {
    assert.equal(typeof getPartyContext(WORLD), "string");
  });

  test("OPT-IN, NEVER FORCE-INJECTED: mutation-engine/narrate.mjs does not import or call getPartyContext anywhere", () => {
    const src = readFileSync(new URL("../../mutation-engine/narrate.mjs", import.meta.url), "utf8");
    assert.ok(!/getPartyContext/.test(src), "narrate.mjs must never reference getPartyContext -- it must stay opt-in per call site, never a default");
    assert.ok(!/combat-planning/.test(src), "narrate.mjs must never import anything from combat-planning/ at all");
  });

  test("OPT-IN, NEVER FORCE-INJECTED: mutation-engine/texture.mjs does not import or call getPartyContext anywhere", () => {
    const src = readFileSync(new URL("../../mutation-engine/texture.mjs", import.meta.url), "utf8");
    assert.ok(!/getPartyContext/.test(src), "texture.mjs must never reference getPartyContext -- it must stay opt-in per call site, never a default");
    assert.ok(!/combat-planning/.test(src), "texture.mjs must never import anything from combat-planning/ at all");
  });

  console.log(`\n${passed} passed`);
})();

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
