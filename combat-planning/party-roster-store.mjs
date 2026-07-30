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
 * @param {{name:string, combatRelevant:object, buildRelevant:object, sourceText?:string|null, sourcePdfName?:string|null}} fields
 * @param {object} [opts]
 * @param {() => string} [opts.makeId]
 * @param {string} [opts.now]
 * @returns {object}   the created PartyMember
 */
export function savePartyMember(world, { name, combatRelevant, buildRelevant, sourceText = null, sourcePdfName = null }, opts = {}) {
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
    createdAt: now
  };

  const members = readMembers(world);
  writeMembers(world, [...members, member]);
  return member;
}

/** @returns {object}   the PartyMember. Throws a clear Error if not found. */
export function getPartyMember(world, memberId) {
  const member = readMembers(world).find((m) => m.id === memberId);
  if (!member) {
    throw new Error(`No party member found: world="${world}" memberId="${memberId}"`);
  }
  return member;
}

/** @returns {object[]}   every PartyMember for `world`, in creation order. [] if none. */
export function listPartyMembers(world) {
  return readMembers(world);
}

export { ConcurrentWriteError };
