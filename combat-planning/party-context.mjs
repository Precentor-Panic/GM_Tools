/**
 * Party context-exposure API — Phase 18 task 18.6. Design record §3: "A
 * compact, prose-ready summary of the party's build-relevant details
 * (skills/expertise, notable traits, backstory hooks -- the non-combat half
 * of §1b's extraction), in the same spirit as buildAdjacencyContext
 * grounding narration in real graph neighbors."
 *
 * EXPLICITLY OPT-IN PER CALL SITE, NEVER FORCE-INJECTED: this module is not
 * imported by mutation-engine/narrate.mjs or mutation-engine/texture.mjs (or
 * anywhere else) as part of this task -- exposing getPartyContext() is the
 * whole scope here. Deciding where it gets consumed is future work for
 * whichever feature wants it. combat-planning/party-context.test.mjs's own
 * grep-based tests confirm this by reading narrate.mjs/texture.mjs's source
 * directly, not just unit-testing this function in isolation.
 *
 * Reads ONLY buildRelevant fields from combat-planning/party-roster-store.mjs's
 * listPartyMembers(world) -- combatRelevant fields (AC, HP, attack bonus,
 * etc.) never appear in the returned prose; those stay internal to the
 * encounter heuristic (18.3-18.5).
 */
import { listPartyMembers } from "./party-roster-store.mjs";

function describeMember(member) {
  const build = member.buildRelevant ?? {};
  const parts = [];

  if (build.notableTraits?.length) parts.push(build.notableTraits.join("; "));
  if (build.backstoryHooks?.length) parts.push(build.backstoryHooks.join("; "));
  if (build.skills?.length) parts.push(`skilled in ${build.skills.join(", ")}`);
  if (build.expertise?.length) parts.push(`expert in ${build.expertise.join(", ")}`);

  if (parts.length === 0) return null;
  return `${member.name}: ${parts.join(". ")}.`;
}

/**
 * @param {string} world
 * @returns {string}   a compact, prose-ready summary of every party member's
 *   buildRelevant fields. "" (not an error, not a fabricated placeholder)
 *   for a world with no party roster ingested yet.
 */
export function getPartyContext(world) {
  const members = listPartyMembers(world);
  const lines = members.map(describeMember).filter((line) => line !== null);
  return lines.join(" ");
}
