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
import { campaignStoreFile } from "../mutation-engine/campaign-home.mjs";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "party-roster");

export function partyRosterRoot() {
  return process.env.GM_TOOLS_PARTY_ROSTER_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return campaignStoreFile(world, { store: "party-roster", envVar: "GM_TOOLS_PARTY_ROSTER_DIR", legacyRoot: DEFAULT_ROOT });
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
  return {
    ...member,
    passive: member.passive ?? null,
    conditions: member.conditions ?? "",
    // (2026-09-11) objectives + its Foundry journal ref, same read-time
    // projection this store has always used for versioning -- a row written
    // before these existed reads them as empty/null and is never rewritten
    // on disk just because it was read.
    objectives: Array.isArray(member.objectives) ? member.objectives : [],
    foundryObjectivesRef: member.foundryObjectivesRef ?? null,
    objectivesPendingPush: member.objectivesPendingPush ?? null
  };
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

/**
 * The GM's own roster edit: rename a member, and/or re-point it at a
 * different Foundry actor. STATUS-INDEPENDENT, same convention as
 * updatePartyMemberPassive/Conditions above -- an ongoing table-use edit,
 * not a re-ingest. `updatePartyMemberFields` deliberately refuses an
 * accepted member because THAT path is the pull ingest overwriting a human
 * decision; this one IS the human decision, so it does not gate on status.
 *
 * Why it exists (2026-09-09): a Foundry pull names party rows after whatever
 * the actor happened to be called, so a roster drifts into player handles
 * ("Adam", "Vercinix") standing in for characters, and a row can end up
 * pointing at an actor the GM later deleted in Foundry -- a dead
 * foundryActorRef silently places no token on a pushed scene. Neither was
 * fixable through any existing route.
 *
 * @param {string} world
 * @param {string} memberId
 * @param {{name?:string, foundryActorRef?:string|null}} patch   omitted keys are left untouched
 * @returns {object}   the updated PartyMember
 */
export function relabelPartyMember(world, memberId, { name, foundryActorRef } = {}) {
  if (name === undefined && foundryActorRef === undefined) {
    throw new Error("relabelPartyMember: give a `name`, a `foundryActorRef`, or both -- an empty patch is a no-op the caller should not have made.");
  }
  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    throw new Error("relabelPartyMember: `name` must be a non-empty string.");
  }
  const members = readMembers(world);
  const idx = findMemberIndex(world, memberId, members);
  const updated = {
    ...members[idx],
    ...(name !== undefined ? { name: name.trim() } : {}),
    ...(foundryActorRef !== undefined ? { foundryActorRef } : {})
  };
  const next = [...members];
  next[idx] = updated;
  writeMembers(world, next);
  return updated;
}

/** Generate an objective id. Injectable (opts.makeId) for deterministic tests. */
export function makeObjectiveId() {
  return `obj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Patch one member in place through the read-time projection, so every
 * objectives writer below shares one concurrency-safe read/modify/write.
 * STATUS-INDEPENDENT, like updatePartyMemberPassive/Conditions above: a GM
 * typing an objective for an accepted PC IS the human decision, not a
 * re-ingest overwriting one.
 */
function patchMember(world, memberId, fn) {
  const members = readMembers(world);
  const idx = findMemberIndex(world, memberId, members);
  const current = projectMemberReadFields(members[idx]);
  const updated = fn(current);
  const next = [...members];
  next[idx] = updated;
  writeMembers(world, next);
  return projectMemberReadFields(updated);
}

/**
 * The GM's objective lines for one PC — the card's list, in card order.
 *
 * Deliberately NO reward or satisfied-when field: both are GM-side by ruling,
 * and storing them beside the card text is how they end up printed on it.
 *
 * @returns {object}   the updated PartyMember
 */
export function addPartyMemberObjective(world, memberId, text, opts = {}) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) throw new Error("addPartyMemberObjective: `text` must be a non-empty string.");
  const now = opts.now ?? new Date().toISOString();
  const id = opts.makeId ? opts.makeId() : makeObjectiveId();
  return patchMember(world, memberId, (m) => ({
    ...m,
    objectives: [...m.objectives, { id, text: value, status: "open", createdAt: now, updatedAt: now, closedAt: null }]
  }));
}

/** Patch one objective's text and/or status. `closed` stamps closedAt; reopening clears it. */
export function updatePartyMemberObjective(world, memberId, objectiveId, { text, status } = {}, opts = {}) {
  if (text === undefined && status === undefined) {
    throw new Error("updatePartyMemberObjective: give `text`, `status`, or both.");
  }
  if (status !== undefined && status !== "open" && status !== "closed") {
    throw new Error(`updatePartyMemberObjective: status must be "open" or "closed", got ${JSON.stringify(status)}.`);
  }
  if (text !== undefined && (typeof text !== "string" || !text.trim())) {
    throw new Error("updatePartyMemberObjective: `text` must be a non-empty string.");
  }
  const now = opts.now ?? new Date().toISOString();
  return patchMember(world, memberId, (m) => {
    const idx = m.objectives.findIndex((o) => o.id === objectiveId);
    if (idx === -1) throw new Error(`No objective found: memberId="${memberId}" objectiveId="${objectiveId}"`);
    const o = m.objectives[idx];
    const next = { ...o, updatedAt: now };
    if (text !== undefined) next.text = text.trim();
    if (status !== undefined) {
      next.status = status;
      next.closedAt = status === "closed" ? now : null;
    }
    const objectives = [...m.objectives];
    objectives[idx] = next;
    return { ...m, objectives };
  });
}

/** Hard delete — a line the GM typed into their own roster row needs no audit trail. */
export function removePartyMemberObjective(world, memberId, objectiveId) {
  return patchMember(world, memberId, (m) => {
    if (!m.objectives.some((o) => o.id === objectiveId)) {
      throw new Error(`No objective found: memberId="${memberId}" objectiveId="${objectiveId}"`);
    }
    return { ...m, objectives: m.objectives.filter((o) => o.id !== objectiveId) };
  });
}

/** Reorder — the rendered <ol> order is table-facing. The id set must match exactly. */
export function reorderPartyMemberObjectives(world, memberId, objectiveIds) {
  const wanted = Array.isArray(objectiveIds) ? objectiveIds : [];
  return patchMember(world, memberId, (m) => {
    const have = m.objectives.map((o) => o.id);
    if (wanted.length !== have.length || !have.every((id) => wanted.includes(id))) {
      throw new Error("reorderPartyMemberObjectives: `objectiveIds` must list every existing objective exactly once.");
    }
    return { ...m, objectives: wanted.map((id) => m.objectives.find((o) => o.id === id)) };
  });
}

/** The pushed journal this member's objectives live in. Written ONLY on a confirmed ok:true. */
export function setPartyMemberObjectivesRef(world, memberId, ref) {
  return patchMember(world, memberId, (m) => ({ ...m, foundryObjectivesRef: ref ?? null }));
}

/** The queued-push ledger entry, mirroring setItemPendingPush. */
export function setPartyMemberObjectivesPendingPush(world, memberId, pending) {
  return patchMember(world, memberId, (m) => ({ ...m, objectivesPendingPush: pending ?? null }));
}

export { ConcurrentWriteError };
