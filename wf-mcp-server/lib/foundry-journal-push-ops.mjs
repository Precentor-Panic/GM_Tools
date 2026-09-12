/**
 * Journal PUSH — the objectives card, and the general journal write (v6).
 *
 * Sibling to ./foundry-push-ops.mjs (scenes) and ./foundry-item-push-ops.mjs
 * (items/bestiary): same ops-channel transport, same direct-GM review-free
 * convention. A GM-authored objectives list going to a player's journal is a
 * table-prep act, not a canon proposal, so no review gate applies — and like
 * its siblings this is HTTP-only with no MCP mirror (an LLM-driven write into
 * a player's own journal is a genuinely different surface).
 *
 * WHAT THIS MODULE IS CAREFUL ABOUT. The six live `Objectives` journals are
 * owned by their players, who write prose in them. The bridge's page-merge
 * semantics mean an update can only touch pages it names (see
 * `resolveJournalPageUpdates` in the module), so this producer names exactly
 * ONE page — `Objectives` — and never mentions the player's page at all.
 *
 * THE DUPLICATE-JOURNAL TRAP, and why `adopt` exists. All six entries are
 * named identically and GM_Tools has never held a uuid for any of them. A
 * push with no ref would compose a CREATE, producing a seventh journal the
 * player cannot tell from their own while the real one silently stops being
 * updated. So: `pushPartyObjectivesToFoundry` REFUSES to create when the
 * index already shows an `Objectives` journal owned by this member's player,
 * and points the caller at `adoptPartyObjectivesJournal` instead.
 *
 * REFS ARE WRITTEN ONLY ON A CONFIRMED ok:true — same rule as every sibling
 * producer; a queued or failed push leaves the row exactly as it was.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  getPartyMember,
  setPartyMemberObjectivesRef,
  setPartyMemberObjectivesPendingPush
} from "../../combat-planning/party-roster-store.mjs";
import { writeFoundryOps, makeOpId } from "./foundry-ops.mjs";
import { foundryResultsPath } from "./snapshot.mjs";

/** GM role, per Foundry's CONST.USER_ROLES.GAMEMASTER. */
const GM_ROLE = 4;
/** CONST.DOCUMENT_OWNERSHIP_LEVELS — only the two levels this module writes. */
const OWNER = 3;
const OBSERVER = 2;
/** The page the GM owns and this producer rewrites. Never the player's page. */
export const OBJECTIVES_PAGE = "Objectives";
export const TONIGHT_PAGE = "Tonight";
export const WANTS_PAGE = "Your wants";

/** PURE. No text from a store row is ever trusted as HTML. */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * PURE. The Objectives page body.
 *
 * Open lines are the numbered list the card has always been; closed ones fall
 * to a "Done" block struck through, so a player can see what they finished
 * rather than watching lines vanish. An empty list says so in words — never
 * an empty `<ol>`, which renders as nothing and reads as a bug.
 */
export function renderObjectivesHtml(objectives = []) {
  const list = Array.isArray(objectives) ? objectives : [];
  const open = list.filter((o) => o?.status !== "closed");
  const closed = list.filter((o) => o?.status === "closed");
  const parts = [];
  parts.push(open.length
    ? `<ol>${open.map((o) => `<li>${escapeHtml(o.text)}</li>`).join("")}</ol>`
    : "<p><em>Nothing set yet.</em></p>");
  if (closed.length) {
    parts.push("<h3>Done</h3>");
    parts.push(`<ul>${closed.map((o) => `<li><s>${escapeHtml(o.text)}</s></li>`).join("")}</ul>`);
  }
  return parts.join("\n");
}

/**
 * PURE. Resolve this member's player from the Foundry index and build the
 * journal's ownership map: nobody by default, the player and every GM at
 * OWNER.
 *
 * The join is `member.foundryActorRef` -> the `users[]` entry whose
 * `characterUuid` is that actor. An ambiguous or missing join THROWS rather
 * than defaulting to anything — the failure mode this prevents is handing one
 * player's objectives to another, which no error message would undo.
 */
export function composeObjectivesOwnership(member, index) {
  const actorUuid = member?.foundryActorRef;
  if (!actorUuid) {
    throw new Error(`"${member?.name ?? "this member"}" has no linked Foundry actor -- link one before pushing objectives.`);
  }
  const users = Array.isArray(index?.users) ? index.users : [];
  const claimants = users.filter((u) => u?.characterUuid === actorUuid);
  if (!claimants.length) {
    throw new Error(`No Foundry user has "${actorUuid}" as their character -- assign the actor to a player in Foundry before pushing objectives.`);
  }
  if (claimants.length > 1) {
    throw new Error(`${claimants.length} Foundry users claim "${actorUuid}" as their character -- resolve that in Foundry; this never guesses which player owns a card.`);
  }
  const ownership = { default: 0, [claimants[0].id]: OWNER };
  for (const u of users) if (u?.role === GM_ROLE && u.id) ownership[u.id] = OWNER;
  return { ownership, playerUserId: claimants[0].id, playerName: claimants[0].name ?? null };
}

/** PURE. The index's `Objectives` journal for one player, or null. */
export function findObjectivesJournal(index, playerUserId) {
  const journals = Array.isArray(index?.journals) ? index.journals : [];
  return journals.find((j) =>
    j?.name === OBJECTIVES_PAGE && j?.ownership && j.ownership[playerUserId] === OWNER) ?? null;
}

/**
 * PURE. The op for one member's objectives — `update_journal` naming ONLY the
 * Objectives page when a ref exists, `create_journal` with all three pages
 * when one genuinely has to be made.
 *
 * Page ownership is what the three-page split bought: the GM's two pages are
 * OBSERVER for the player (readable, not clobberable), and the player's page
 * is left absent so it INHERITs OWNER from the entry and stays theirs.
 */
export function buildObjectivesJournalOp(member, { index, tonight } = {}) {
  const { ownership, playerUserId } = composeObjectivesOwnership(member, index);
  const objectivesHtml = renderObjectivesHtml(member.objectives);
  const ref = member.foundryObjectivesRef;

  if (ref?.journalUuid) {
    return {
      kind: "update_journal",
      data: {
        journalUuid: ref.journalUuid,
        // ONE page. The player's page is not mentioned, so it cannot be touched.
        pages: [{ name: OBJECTIVES_PAGE, html: objectivesHtml, ...(ref.pageId ? { pageId: ref.pageId } : {}) }]
      }
    };
  }
  return {
    kind: "create_journal",
    data: {
      name: OBJECTIVES_PAGE,
      bridgeKind: "objectives",
      ownership,
      pages: [
        { name: TONIGHT_PAGE, html: `<p>${escapeHtml(tonight ?? "")}</p>`, ownership: { [playerUserId]: OBSERVER } },
        { name: OBJECTIVES_PAGE, html: objectivesHtml, ownership: { [playerUserId]: OBSERVER } },
        { name: WANTS_PAGE, html: "<p></p>" } // no ownership -> INHERIT -> the player keeps OWNER
      ]
    }
  };
}

/** Read the exported Foundry index for a world, or `{}` when there isn't one. */
function readIndex(dir, world) {
  try {
    return JSON.parse(readFileSync(`${dir}/worlds/${world}/world-fabric-foundry-index.json`, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Consume a late result for a member whose push was left queued. Mirrors
 * reconcilePendingItemResults, INCLUDING the survivors-only rewrite of the
 * results file — never blanket-clear it, a sibling producer may be waiting on
 * its own late result.
 */
export function reconcilePendingObjectivesResults(dir, world, memberId) {
  const member = getPartyMember(world, memberId);
  const pending = member.objectivesPendingPush;
  if (!pending?.opId) return 0;
  const path = foundryResultsPath(dir, world);
  let all;
  try {
    all = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return 0; // mid-write or absent -- try again next cycle
  }
  if (!Array.isArray(all)) return 0;
  const result = all.find((r) => r?.opId === pending.opId);
  if (!result) return 0;

  if (result.ok) {
    setPartyMemberObjectivesRef(world, memberId, {
      journalUuid: result.foundryUuid ?? pending.journalUuid ?? null,
      pageId: pending.pageId ?? null,
      lastPushedAt: new Date().toISOString()
    });
  }
  setPartyMemberObjectivesPendingPush(world, memberId, null);
  writeFileSync(path, JSON.stringify(all.filter((r) => r?.opId !== pending.opId), null, 2), "utf8");
  return 1;
}

/**
 * Adopt an existing Foundry journal as this member's objectives card.
 *
 * Writes the ref and EMITS NO OP. This is the step that stops the first push
 * creating a seventh `Objectives` journal — see the module header.
 */
export function adoptPartyObjectivesJournal(dir, world, memberId, journalUuid) {
  if (!journalUuid) throw new Error("adoptPartyObjectivesJournal: `journalUuid` is required.");
  const index = readIndex(dir, world);
  const journal = (Array.isArray(index.journals) ? index.journals : []).find((j) => j?.uuid === journalUuid);
  if (!journal) {
    throw new Error(`No journal "${journalUuid}" in this world's Foundry index -- reload the Foundry client to refresh it, then try again.`);
  }
  const page = (journal.pages ?? []).find((p) => p?.name === OBJECTIVES_PAGE) ?? null;
  const member = setPartyMemberObjectivesRef(world, memberId, {
    journalUuid,
    pageId: page?.id ?? null,
    lastPushedAt: null
  });
  return { adopted: true, memberId, journalUuid, pageId: page?.id ?? null, member };
}

/**
 * Push one member's objectives to their journal.
 *
 * @returns {Promise<object>}  {status:'queued'|'applied', memberId, opId, ok?, foundryUuid?, error?, note?}
 */
export async function pushPartyObjectivesToFoundry(dir, world, memberId, opts = {}) {
  if (!world) throw new Error("pushPartyObjectivesToFoundry: `world` is required.");
  reconcilePendingObjectivesResults(dir, world, memberId);

  const member = getPartyMember(world, memberId);
  if (member.objectivesPendingPush?.opId) {
    throw new Error(`"${member.name}" already has an objectives push in flight (${member.objectivesPendingPush.opId}) -- wait for it to settle.`);
  }
  if (!member.objectives.length) {
    throw new Error(`"${member.name}" has no objectives to push -- add one first.`);
  }

  const index = readIndex(dir, world);
  if (!Array.isArray(index.journals)) {
    // The only reliable liveness probe for the v6 module: nothing else writes
    // this key. Warn rather than throw -- a create can still be composed.
    console.warn(`world-fabric | this world's Foundry index has no journals[] -- the client may be running pre-v6 module code; reload it before pushing.`);
  }

  const op = buildObjectivesJournalOp(member, { index, tonight: opts.tonight });

  if (op.kind === "create_journal") {
    const { playerUserId } = composeObjectivesOwnership(member, index);
    const existing = findObjectivesJournal(index, playerUserId);
    if (existing) {
      throw new Error(
        `an Objectives journal for this player already exists in Foundry ("${existing.uuid}") -- adopt it first rather than creating a second one.`
      );
    }
  }

  const opId = opts.makeOpId ? opts.makeOpId() : makeOpId();
  const outcome = await writeFoundryOps(dir, world, [{ opId, kind: op.kind, data: op.data }], opts);

  if (outcome.status === "queued") {
    setPartyMemberObjectivesPendingPush(world, memberId, {
      opId,
      phase: op.kind === "create_journal" ? "create" : "update",
      journalUuid: op.data.journalUuid ?? null,
      pageId: member.foundryObjectivesRef?.pageId ?? null
    });
    return { status: "queued", memberId, opId, note: outcome.note };
  }

  const result = outcome.results.find((r) => r.opId === opId);
  if (!result?.ok) {
    return { status: "applied", memberId, opId, ok: false, error: result?.error ?? "no result for this op" };
  }
  const updated = setPartyMemberObjectivesRef(world, memberId, {
    journalUuid: result.foundryUuid ?? op.data.journalUuid ?? null,
    pageId: member.foundryObjectivesRef?.pageId ?? null,
    lastPushedAt: new Date().toISOString()
  });
  return { status: "applied", memberId, opId, ok: true, foundryUuid: result.foundryUuid, member: updated };
}
