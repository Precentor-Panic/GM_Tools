/**
 * Party roster store — Phase 18 task 18.2. Pure, Foundry-free,
 * unit-testable.
 *
 * UNLIKE bestiary-store.mjs's open per-user-vs-per-world scoping question,
 * the design record is explicit here: "PCs genuinely belong to one
 * campaign" -- this store is PER-WORLD. Storage: ONE JSON FILE PER WORLD
 * (session-planner/scenes.mjs's convention), `<partyRosterRoot>/<world>.json`,
 * a flat array of PartyMember objects. Default root GM_Tools/party-roster/
 * (sibling to session-scenes/); override with GM_TOOLS_PARTY_ROSTER_DIR
 * (tests use this for isolation). Reuses review-state.mjs's
 * withLock/ConcurrentWriteError, per every other store's established
 * precedent.
 *
 * PartyMember STRUCTURALLY separates combatRelevant/buildRelevant, mirroring
 * party-roster-ingest.mjs's own extraction split -- this store never
 * flattens or merges the two groups.
 *
 * Phase 32 task 32.2 addendum -- this store had NO status/review-gate model
 * at all before this task (every savePartyMember() call was immediately
 * "live" in the roster). The Foundry PULL slice needs one: re-ingesting the
 * same Foundry actor must be able to update a not-yet-reviewed candidate in
 * place without ever silently clobbering a member a DM has since accepted/
 * hand-edited (the no-silent-auto-write invariant, gm-tools-conventions'
 * SKILL.md). Two options were on the table (see the task's own framing):
 * (a) give this store the SAME status:'proposed'|'accepted'|'discarded' gate
 * bestiary-store.mjs already has, or (b) return pull candidates to the
 * caller for review WITHOUT saving, persisting only on an explicit accept
 * that re-sends the full candidate payload. Chose (a): every EXISTING
 * caller (today's LLM text/PDF ingest route, any hand-added member) keeps
 * its current immediately-usable behavior byte-for-byte via a default
 * `status:'accepted'` on savePartyMember() -- a DM directly adding a member
 * today already IS the deliberate-authorship act bestiary's LLM-ingest path
 * needs a separate accept step for; there was never a reason to add review
 * friction to that existing flow. The NEW Foundry-pull path
 * (wf-mcp-server/lib/foundry-pull-ops.mjs) is the only caller that ever
 * passes `status:'proposed'` explicitly. This also lets the SAME find-by-
 * foundryActorRef / update-if-proposed / skip-if-accepted upsert logic work
 * identically for both stores, instead of inventing a second review
 * mechanic — and avoids the harder-to-get-right alternative of a client
 * round-tripping an entire unsaved candidate payload back through an accept
 * call.
 *
 * `foundryActorRef` (nullable) links a member back to the Foundry actor it
 * was pulled from; null for every manually- or LLM-added member.
 *
 * Phase 35 task 35.1, §5 of review-ui/test/e2e/phase35-fixture.mjs (THE
 * WRITTEN CONTRACT): gains two additive fields -- `passive` (number|null,
 * passive Perception or whichever skill the design's own passiveText cell
 * shows) and `conditions` (string, default "" -- "one-click, always
 * visible" per the locked design decision, NOT behind a disclosure click
 * unlike ratings/notes). Both default via a READ-TIME fallback at
 * getPartyMember/listPartyMembers (a pre-Phase-35 member simply lacks the
 * key on disk). Patched via updatePartyMemberPassive/
 * updatePartyMemberConditions -- STATUS-INDEPENDENT (mirrors
 * bestiary-store.mjs's updateBestiaryEntryNote/Rating's identical "no status
 * check" convention, NOT updatePartyMemberFields's proposed-only guard): a
 * DM editing passive/conditions on an already-accepted member is an ongoing
 * table-use edit, not a re-ingest a human decision should gate.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "party-roster");

export function partyRosterRoot() {
  return process.env.GM_TOOLS_PARTY_ROSTER_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return join(partyRosterRoot(), `${world}.json`);
}

function readMembers(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeMembers(world, members) {
  const filePath = worldFilePath(world);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(members, null, 2), "utf8");
  });
  return members;
}

/** Generate a party-member id. Injectable (opts.makeId) for deterministic tests. */
export function makePartyMemberId() {
  return `pm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {string} world
 * @param {{name:string, combatRelevant:object, buildRelevant:object, sourceText?:string|null, sourcePdfName?:string|null, foundryActorRef?:string|null, status?:'proposed'|'accepted'}} fields
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object}   the created PartyMember
 */
export function savePartyMember(
  world,
  { name, combatRelevant, buildRelevant, sourceText = null, sourcePdfName = null, foundryActorRef = null, status = "accepted" },
  opts = {}
) {
  const makeId = opts.makeId ?? makePartyMemberId;
  const now = opts.now ?? new Date().toISOString();

  const member = {
    id: makeId(),
    world,
    name,
    combatRelevant: combatRelevant ?? {},
    buildRelevant: buildRelevant ?? {},
    sourceText,
    sourcePdfName,
    // Phase 32 task 32.2 -- see this module's header comment for the full
    // status-gate reasoning. Default 'accepted' preserves every pre-existing
    // caller's behavior unchanged; only the Foundry-pull ingest ever passes
    // 'proposed' explicitly.
    foundryActorRef,
    status,
    createdAt: now
  };

  const members = readMembers(world);
  writeMembers(world, [...members, member]);
  return member;
}

/**
 * Read-time projection applied at every read boundary (Phase 35 task 35.1,
 * §5) -- `passive` defaults to `null`, `conditions` defaults to `""` for a
 * pre-Phase-35 member, never persisted back to disk just from a read.
 */
function projectMemberReadFields(member) {
  if (!member) return member;
  return { ...member, passive: member.passive ?? null, conditions: member.conditions ?? "" };
}

/** @returns {object}   the PartyMember (§5's passive/conditions projection included). Throws a clear Error if not found. */
export function getPartyMember(world, memberId) {
  const member = readMembers(world).find((m) => m.id === memberId);
  if (!member) {
    throw new Error(`No party member found: world="${world}" memberId="${memberId}"`);
  }
  return projectMemberReadFields(member);
}

/** @returns {object[]}   every PartyMember for `world`, in creation order, §5's projection included. [] if none. */
export function listPartyMembers(world) {
  return readMembers(world).map(projectMemberReadFields);
}

function findMemberIndex(world, memberId, members) {
  const idx = members.findIndex((m) => m.id === memberId);
  if (idx === -1) {
    throw new Error(`No party member found: world="${world}" memberId="${memberId}"`);
  }
  return idx;
}

/** status: 'proposed' -> 'accepted'. Mirrors acceptBestiaryEntry. @returns {object} the updated PartyMember. */
export function acceptPartyMember(world, memberId) {
  const members = readMembers(world);
  const idx = findMemberIndex(world, memberId, members);
  const updated = { ...members[idx], status: "accepted" };
  const next = [...members];
  next[idx] = updated;
  writeMembers(world, next);
  return updated;
}

/**
 * status: 'proposed' -> 'discarded' ONLY. Mirrors discardBestiaryEntry's
 * "refuses to discard accepted content" convention. @returns {object} the updated PartyMember.
 */
export function discardPartyMember(world, memberId) {
  const members = readMembers(world);
  const idx = findMemberIndex(world, memberId, members);
  if (members[idx].status === "accepted") {
    throw new Error(
      `Refusing to discard party member "${memberId}" (status "accepted") -- only a not-yet-accepted 'proposed' ` +
      `member can be discarded outright.`
    );
  }
  const updated = { ...members[idx], status: "discarded" };
  const next = [...members];
  next[idx] = updated;
  writeMembers(world, next);
  return updated;
}

/**
 * Overwrites name/combatRelevant/buildRelevant/sourceText/sourcePdfName on
 * an EXISTING member — the "re-ingesting the same Foundry actor updates the
 * still-proposed candidate" half of the pull ingest's review-gate
 * (wf-mcp-server/lib/foundry-pull-ops.mjs, Phase 32 task 32.2). `id`/
 * `world`/`createdAt`/`foundryActorRef`/`status` are preserved untouched.
 * Refuses (throws) unless the member is still `status:'proposed'` — mirrors
 * updateBestiaryEntryRawFields's identical guard exactly, same no-silent-
 * auto-write reasoning.
 * @returns {object}   the updated PartyMember
 */
export function updatePartyMemberFields(world, memberId, { name, combatRelevant, buildRelevant, sourceText = null, sourcePdfName = null }) {
  const members = readMembers(world);
  const idx = findMemberIndex(world, memberId, members);
  const existing = members[idx];
  if (existing.status !== "proposed") {
    throw new Error(
      `Refusing to overwrite party member "${memberId}" (status "${existing.status}") -- only a still-'proposed' ` +
      `member may be updated by a re-ingest; an accepted/hand-edited member is a human decision, never silently ` +
      `overwritten.`
    );
  }
  const updated = {
    ...existing,
    name: name ?? existing.name,
    combatRelevant: combatRelevant ?? existing.combatRelevant,
    buildRelevant: buildRelevant ?? existing.buildRelevant,
    sourceText,
    sourcePdfName
  };
  const next = [...members];
  next[idx] = updated;
  writeMembers(world, next);
  return updated;
}

/**
 * §5's status-INDEPENDENT patch -- mirrors bestiary-store.mjs's
 * updateBestiaryEntryNote/Rating's "no status check" convention (an ongoing
 * table-use edit, not a re-ingest a DM's own acceptance decision should
 * gate).
 * @returns {object}   the updated PartyMember (projection included)
 */
export function updatePartyMemberPassive(world, memberId, passive) {
  const members = readMembers(world);
  const idx = findMemberIndex(world, memberId, members);
  const updated = { ...members[idx], passive: passive ?? null };
  const next = [...members];
  next[idx] = updated;
  writeMembers(world, next);
  return projectMemberReadFields(updated);
}

/**
 * §5's status-INDEPENDENT patch, same convention as updatePartyMemberPassive.
 * @returns {object}   the updated PartyMember (projection included)
 */
export function updatePartyMemberConditions(world, memberId, conditions) {
  const members = readMembers(world);
  const idx = findMemberIndex(world, memberId, members);
  const updated = { ...members[idx], conditions: conditions ?? "" };
  const next = [...members];
  next[idx] = updated;
  writeMembers(world, next);
  return projectMemberReadFields(updated);
}

export { ConcurrentWriteError };
