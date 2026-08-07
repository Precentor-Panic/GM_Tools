/**
 * Foundry actor PULL ingest — Phase 32 task 32.2 (the phase's PRIMARY
 * deliverable). Composes the read-only foundry-index reader
 * (./foundry-index.mjs) with the pure actor→raw-fields mappers
 * (combat-planning/foundry-actor-mapper.mjs) and the two EXISTING
 * bestiary/party-roster stores — shared verbatim by review-ui/server.mjs's
 * POST /api/foundry/pull-actors route and wf-mcp-server/index.mjs's
 * wf_pull_foundry_actors tool, per gm-tools-conventions' "front-ends are
 * thin wrappers, never logic duplicators."
 *
 * REVIEW-GATED, per the no-silent-auto-write invariant: every candidate
 * lands as status:'proposed', NEVER 'accepted' — exactly like every other
 * ingest path in this project (bestiary's existing LLM text/PDF ingest
 * already works this way).
 *
 * DEDUP/LINK BY foundryActorRef — re-running the pull for a world:
 *   - a matching status:'proposed' entry/member is UPDATED IN PLACE
 *     (id/createdAt preserved) — a stale, not-yet-reviewed candidate should
 *     reflect Foundry's current state, not pile up as a duplicate.
 *   - a matching status:'accepted' entry/member is LEFT COMPLETELY
 *     UNTOUCHED — a human decision, possibly hand-edited since acceptance.
 *     Reported back under `alreadyLinked` so a caller/UI can say "already
 *     synced" instead of silently doing nothing with no explanation.
 *   - otherwise, a brand-new proposed candidate is created.
 * See combat-planning/party-roster-store.mjs's own header comment for why
 * party-roster gained the SAME status gate bestiary already had, rather
 * than the "return candidates without saving" alternative.
 */
import { readFoundryIndex } from "./foundry-index.mjs";
import { classifyActor, mapActorToBestiary, mapActorToPartyMember } from "../../combat-planning/foundry-actor-mapper.mjs";
import { saveBestiaryEntry, listBestiaryEntries, updateBestiaryEntryRawFields } from "../../combat-planning/bestiary-store.mjs";
import { savePartyMember, listPartyMembers, updatePartyMemberFields } from "../../combat-planning/party-roster-store.mjs";

function sourceTextFor(actor) {
  return `Pulled from Foundry actor ${actor.uuid} (${actor.name ?? "unnamed"}).`;
}

function upsertBestiary(actor, mapped, opts) {
  const matches = listBestiaryEntries().filter((e) => e.foundryActorRef === actor.uuid);
  const acceptedMatch = matches.find((e) => e.status === "accepted");
  if (acceptedMatch) return { record: acceptedMatch, action: "already-linked" };

  const proposedMatch = matches.find((e) => e.status === "proposed");
  if (proposedMatch) {
    const entry = updateBestiaryEntryRawFields(proposedMatch.id, { rawFields: mapped, sourceText: sourceTextFor(actor) });
    return { record: entry, action: "updated" };
  }

  const entry = saveBestiaryEntry({ rawFields: mapped, sourceText: sourceTextFor(actor), foundryActorRef: actor.uuid }, opts);
  return { record: entry, action: "created" };
}

function upsertPartyMember(world, actor, mapped, opts) {
  const matches = listPartyMembers(world).filter((m) => m.foundryActorRef === actor.uuid);
  const acceptedMatch = matches.find((m) => m.status === "accepted");
  if (acceptedMatch) return { record: acceptedMatch, action: "already-linked" };

  const proposedMatch = matches.find((m) => m.status === "proposed");
  if (proposedMatch) {
    const member = updatePartyMemberFields(world, proposedMatch.id, {
      name: mapped.name,
      combatRelevant: mapped.combatRelevant,
      buildRelevant: mapped.buildRelevant,
      sourceText: sourceTextFor(actor)
    });
    return { record: member, action: "updated" };
  }

  const member = savePartyMember(
    world,
    {
      name: mapped.name,
      combatRelevant: mapped.combatRelevant,
      buildRelevant: mapped.buildRelevant,
      sourceText: sourceTextFor(actor),
      foundryActorRef: actor.uuid,
      status: "proposed"
    },
    opts
  );
  return { record: member, action: "created" };
}

/**
 * @param {string} dataDir
 * @param {string} world
 * @param {object} [opts]   forwarded to saveBestiaryEntry/savePartyMember (makeId/now — test-injectable determinism)
 * @returns {{
 *   indexFound: boolean,
 *   bestiaryProposed: object[],               // bestiary entries now status:'proposed' (created OR updated this run)
 *   partyProposed: object[],                  // party members now status:'proposed' (created OR updated this run)
 *   alreadyLinked: {bestiary: string[], party: string[]},  // foundryActorRefs skipped because already 'accepted'
 *   skippedActors: {uuid: string, reason: string}[]         // actors that couldn't be classified/mapped (defense-in-depth; the mappers themselves never throw)
 * }}
 */
export function pullFoundryActorsToStores(dataDir, world, opts = {}) {
  const index = readFoundryIndex(dataDir, world);
  if (!index || !Array.isArray(index.actors) || index.actors.length === 0) {
    return { indexFound: !!index, bestiaryProposed: [], partyProposed: [], alreadyLinked: { bestiary: [], party: [] }, skippedActors: [] };
  }

  const bestiaryProposed = [];
  const partyProposed = [];
  const alreadyLinked = { bestiary: [], party: [] };
  const skippedActors = [];

  for (const actor of index.actors) {
    if (!actor || typeof actor !== "object" || !actor.uuid) {
      skippedActors.push({ uuid: actor?.uuid ?? "(missing uuid)", reason: "actor is missing a uuid -- cannot dedup/link, skipped" });
      continue;
    }
    try {
      const role = classifyActor(actor, index.users);
      if (role === "pc") {
        const mapped = mapActorToPartyMember(actor);
        const { record, action } = upsertPartyMember(world, actor, mapped, opts);
        if (action === "already-linked") alreadyLinked.party.push(actor.uuid);
        else partyProposed.push(record);
      } else {
        const mapped = mapActorToBestiary(actor);
        const { record, action } = upsertBestiary(actor, mapped, opts);
        if (action === "already-linked") alreadyLinked.bestiary.push(actor.uuid);
        else bestiaryProposed.push(record);
      }
    } catch (err) {
      // Defense-in-depth only -- classifyActor/mapActorToBestiary/
      // mapActorToPartyMember are themselves guaranteed never to throw
      // (unit-tested against both 32.0 fixtures); this catch exists so one
      // genuinely unanticipated bad actor record can never abort the whole
      // pull for every other actor in the index.
      skippedActors.push({ uuid: actor.uuid, reason: err.message });
    }
  }

  return { indexFound: true, bestiaryProposed, partyProposed, alreadyLinked, skippedActors };
}
