/**
 * Ambient digest — pure function, zero store I/O.
 *
 * Phase 16 task 16.3. Design record §3's concrete format: "Name (one-word
 * role tag) — the single relationship-to-here fact + the one hook that
 * matters", hard-capped short. THE EMPTY-RENDER RULE is the single most
 * important behavior in this module: the digest renders `null` (omitted,
 * never padded or fabricated) for an entity with no real relationship-fact
 * or hook to show — that's the line between retrieval (fine) and
 * speculative pre-writing (explicitly against the project's "prep what pays
 * off" philosophy).
 *
 * The caller (session-planner/brief.mjs, task 16.5) is responsible for
 * loading the entity, the connecting edge, and the entity's current
 * narration (mutation-engine/entity-narration.mjs's getCurrentEntityNarration)
 * and passing them in already-resolved.
 */

/** Design record §3's "hard-capped around 12-15 words" -- this module's own chosen concrete value. */
export const AMBIENT_DIGEST_MAX_WORDS = 15;

/**
 * @param {string} text
 * @param {number} maxWords
 * @returns {string}   text unchanged if it has <= maxWords words, otherwise
 *                      the first maxWords words plus a trailing "…" (no
 *                      ellipsis when nothing was cut).
 */
export function truncateToWords(text, maxWords) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  return `${words.slice(0, maxWords).join(" ")}…`;
}

/**
 * @param {object} entity     {id, name, type, role?, ...}
 * @param {object|null} edge  the edge connecting this entity to "here", or
 *                             null/undefined. Only edge.label/edge.notes are
 *                             ever read.
 * @param {object|null} narration   getCurrentEntityNarration()'s return
 *                                  shape ({prose, ...}) or null. Only
 *                                  narration.prose is ever read.
 * @returns {{name:string, roleTag:string, hook:string}|null}
 */
export function buildAmbientDigestEntry(entity, edge, narration) {
  const relationshipFact = edge?.label || edge?.notes || null;
  const hookText = narration?.prose || null;

  // THE EMPTY-RENDER RULE: never pad or fabricate.
  if (!relationshipFact && !hookText) return null;

  const roleTag =
    typeof entity.role === "string" && entity.role.trim()
      ? entity.role.trim().split(/\s+/)[0]
      : entity.type;

  const joined = [relationshipFact, hookText].filter(Boolean).join(" — ");

  return {
    name: entity.name,
    roleTag,
    hook: truncateToWords(joined, AMBIENT_DIGEST_MAX_WORDS)
  };
}
