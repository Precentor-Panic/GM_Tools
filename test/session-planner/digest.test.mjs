import assert from "node:assert/strict";

/**
 * CONTRACT UNDER TEST — session-planner/digest.mjs (Phase 16 task 16.3).
 * This module does not exist yet; this file is the interface spec for it,
 * per plans/phase-16-tasks.md task 16.0. It is expected to fail with
 * "Cannot find module" until 16.3 lands.
 *
 * Pure function, zero store I/O — the caller (session-planner/brief.mjs,
 * task 16.5) is responsible for loading the entity, the connecting edge, and
 * the entity's current narration (via mutation-engine/entity-narration.mjs's
 * getCurrentEntityNarration) and passing them in already-resolved. This lets
 * digest.mjs be tested with zero env-var isolation and zero store fixtures.
 *
 * ---------------------------------------------------------------------------
 * AMBIENT_DIGEST_MAX_WORDS
 * ---------------------------------------------------------------------------
 * Exported constant, the design record §3's "hard-capped around 12-15
 * words" — this module's own chosen concrete value (15).
 *
 * ---------------------------------------------------------------------------
 * truncateToWords(text, maxWords)
 * ---------------------------------------------------------------------------
 * Small exported helper: if `text` has more than `maxWords` whitespace-
 * separated words, returns the first `maxWords` words joined by a single
 * space plus a trailing "…"; otherwise returns `text` unchanged (no
 * trailing ellipsis when nothing was cut).
 *   @param {string} text
 *   @param {number} maxWords
 *   @returns {string}
 *
 * ---------------------------------------------------------------------------
 * buildAmbientDigestEntry(entity, edge, narration)
 * ---------------------------------------------------------------------------
 * Design record §3's concrete format: "Name (one-word role tag) — the single
 * relationship-to-here fact + the one hook that matters", hard-capped short.
 * "The digest renders empty for genuinely undeveloped nodes — it never pads
 * or fabricates to fill space."
 *
 *   @param {object} entity           {id, name, type, role?, ...} -- `role`
 *                                    is the Phase 12 scalar entity field; used
 *                                    as the one-word role tag when present.
 *   @param {object|null} edge        the edge connecting this entity to "here"
 *                                    (the corridor path / current scene
 *                                    anchor), or null/undefined if there is no
 *                                    such edge (e.g. this entity IS the anchor).
 *                                    Only edge.label and edge.notes are ever
 *                                    read by this function -- draw the
 *                                    relationship-to-here fact from
 *                                    `edge.label` if present, else `edge.notes`
 *                                    if present, else there is no relationship
 *                                    fact at all.
 *   @param {object|null} narration   mutation-engine/entity-narration.mjs's
 *                                    getCurrentEntityNarration() return shape
 *                                    ({prose, ...}) or null. Only
 *                                    narration.prose is ever read.
 *   @returns {{name:string, roleTag:string, hook:string}|null}
 *
 * Behavior:
 *   - roleTag: entity.role's first whitespace-separated word (lowercased is
 *     NOT required -- pass the field through as authored) if entity.role is
 *     a non-empty string, ELSE entity.type.
 *   - relationshipFact := edge?.label || edge?.notes || null
 *   - hookText := narration?.prose || null
 *   - THE EMPTY-RENDER RULE (the single most important behavior in this
 *     module, per design record §3): if BOTH relationshipFact and hookText
 *     are null/absent, return `null` -- never a padded or fabricated string.
 *   - Otherwise, join whichever of [relationshipFact, hookText] are present
 *     with " — ", then truncateToWords(..., AMBIENT_DIGEST_MAX_WORDS) the
 *     joined string to build `hook`.
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

(async () => {
  const { buildAmbientDigestEntry, truncateToWords, AMBIENT_DIGEST_MAX_WORDS } =
    await import("../../session-planner/digest.mjs");

  test("AMBIENT_DIGEST_MAX_WORDS is within the design record's 12-15-word cap", () => {
    assert.ok(AMBIENT_DIGEST_MAX_WORDS >= 12 && AMBIENT_DIGEST_MAX_WORDS <= 15);
  });

  test("truncateToWords: leaves short text unchanged, no trailing ellipsis", () => {
    assert.equal(truncateToWords("short and sweet", 15), "short and sweet");
  });

  test("truncateToWords: cuts long text to exactly maxWords words plus an ellipsis", () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const result = truncateToWords(long, 5);
    assert.equal(result, "word0 word1 word2 word3 word4…");
  });

  // ------------------------------------------------------- THE EMPTY-RENDER RULE

  test("THE EMPTY-RENDER RULE: renders null (never padded/fabricated) for an entity with no relationship fact AND no narration (§3)", () => {
    const entity = { id: "undeveloped-npc", name: "Unnamed Guard", type: "person" };
    const result = buildAmbientDigestEntry(entity, null, null);
    assert.equal(result, null);
  });

  test("renders null when the edge exists but carries neither label nor notes, and there is no narration", () => {
    const entity = { id: "e1", name: "Quiet Merchant", type: "person" };
    const edge = { id: "edge1", sourceId: "here", targetId: "e1", relationshipType: "presence" }; // no label, no notes
    const result = buildAmbientDigestEntry(entity, edge, null);
    assert.equal(result, null);
  });

  test("renders a real entry when only the edge relationship fact is present (no narration yet)", () => {
    const entity = { id: "e2", name: "Old Kellan", type: "person", role: "quartermaster" };
    const edge = { id: "edge2", sourceId: "here", targetId: "e2", relationshipType: "social", label: "sells rope and lantern oil" };
    const result = buildAmbientDigestEntry(entity, edge, null);
    assert.ok(result);
    assert.equal(result.name, "Old Kellan");
    assert.equal(result.roleTag, "quartermaster");
    assert.match(result.hook, /sells rope and lantern oil/);
  });

  test("renders a real entry when only narration is present (no edge relationship fact)", () => {
    const entity = { id: "e3", name: "The Sunken Well", type: "place" };
    const narration = { narrationId: "n1", prose: "A dry well the locals avoid after dark, said to whisper.", status: "current" };
    const result = buildAmbientDigestEntry(entity, null, narration);
    assert.ok(result);
    assert.equal(result.roleTag, "place", "falls back to entity.type when entity.role is absent");
    assert.match(result.hook, /dry well/);
  });

  test("falls back from edge.label to edge.notes when label is absent", () => {
    const entity = { id: "e4", name: "Borin", type: "person" };
    const edge = { id: "edge4", sourceId: "here", targetId: "e4", relationshipType: "social", notes: "owes the party a favor" };
    const result = buildAmbientDigestEntry(entity, edge, null);
    assert.match(result.hook, /owes the party a favor/);
  });

  test("the combined hook (relationship fact + narration hook) is capped to AMBIENT_DIGEST_MAX_WORDS words", () => {
    const entity = { id: "e5", name: "Verbose NPC", type: "person" };
    const edge = { id: "edge5", sourceId: "here", targetId: "e5", relationshipType: "social", label: "runs the only inn for a day's ride in any direction" };
    const narration = {
      narrationId: "n2",
      prose: "A garrulous innkeeper who remembers every traveler's name and every debt owed, sworn to secrecy about the smugglers upstairs.",
      status: "current"
    };
    const result = buildAmbientDigestEntry(entity, edge, narration);
    const wordCount = result.hook.replace(/…$/, "").trim().split(/\s+/).filter(Boolean).length;
    assert.ok(wordCount <= AMBIENT_DIGEST_MAX_WORDS, `hook should be capped at ${AMBIENT_DIGEST_MAX_WORDS} words, got ${wordCount}: "${result.hook}"`);
  });

  console.log(`\n${passed} passed`);
})();
