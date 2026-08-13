/**
 * Session Planner composition operations — the actual business logic behind
 * review-ui/server.mjs's POST /api/scene-planning/scenes/:sceneId/tray/drop
 * route ("§7's pinned drop behavior", implemented at the route layer per
 * that route's own comment, not in scene-tray.mjs itself), extracted (MCP
 * wave) so wf-mcp-server/index.mjs's wf_tray_drop tool calls the EXACT same
 * code path instead of re-deriving it against a second, drifting copy —
 * per gm-tools-conventions' "front-ends are thin wrappers, never logic
 * duplicators."
 *
 * Deliberately excludes review-ui/server.mjs's own `touchSceneSafely`
 * (recency bump + the Phase 36 quiet-push flush-scheduling machinery) —
 * that's a review-ui HTTP-server-process convenience (a `setTimeout` chain
 * tied to that long-running process), not core planner-state business logic,
 * and out of scope for a stdio-spawned MCP tool call. wf_tray_drop instead
 * does its own best-effort `touchScene` recency bump inline (see
 * wf-mcp-server/index.mjs) — real parity for "this scene got more recent,"
 * without adopting review-ui's own background Foundry-push scheduling.
 */
import { getBestiaryEntry } from "../../combat-planning/bestiary-store.mjs";
import { getPartyMember } from "../../combat-planning/party-roster-store.mjs";
import { getItem } from "../../combat-planning/item-store.mjs";
import { getStagecraftAsset } from "../../session-planner/stagecraft-store.mjs";
import { getSceneTray, addToSceneTray } from "../../session-planner/scene-tray.mjs";
import { createElement, listElementsForScene, attachExistingNodeAsElement } from "../../session-planner/scene-elements.mjs";

/**
 * Phase 35 task 35.1, §7 -- the scene tray's creature-drop route composition:
 * a bestiary entry's `rawFields` (ac/hp/cr/etc) projected into
 * scene-elements.mjs's StatBlock shape (Phase 29's `{count,ac,hp,speed,cr,
 * raw,foundryActor}`), reused verbatim, no new stat fields invented here.
 * Values are passed through with their OWN native type (ac/hp/challengeRating
 * are genuinely numbers on a Foundry-pulled monster) -- StatBlock's ac/hp/cr
 * were widened to accept string OR number specifically for this call site. A
 * missing rawFields value is simply omitted, never a fabricated default.
 */
export function statFromBestiaryRawFields(entry) {
  const rawFields = entry?.rawFields ?? {};
  const stat = {};
  if (rawFields.hp != null) stat.hp = rawFields.hp;
  if (rawFields.ac != null) stat.ac = rawFields.ac;
  if (rawFields.challengeRating != null) stat.cr = rawFields.challengeRating;
  if (rawFields.speed != null) stat.speed = typeof rawFields.speed === "string" ? rawFields.speed : String(rawFields.speed);
  if (entry?.foundryActorRef) stat.foundryActor = entry.foundryActorRef;
  return stat;
}

/**
 * POST /api/scene-planning/scenes/:sceneId/tray/drop's full composition:
 * a "creature" drop's FIRST occurrence creates/reuses a kind:'local'
 * SceneElement carrying a stat block (dedup via fields.bestiaryEntryId), or
 * a REAL kind:'graph' element via attachExistingNodeAsElement when the
 * bestiary entry carries a graphEntityId link; a repeat drop only stacks the
 * roster, element:null. "hero"/"asset" drops never touch scene-elements.mjs
 * at all (display-only / the roster row itself IS the scene-asset link). An
 * unresolvable id for the given kind throws a "No ... found" error (mapped
 * to 404 by the HTTP layer's own statusForError).
 *
 * @param {string} dir  resolved data dir
 * @param {string} w    resolved world id
 * @param {string} sceneId
 * @param {{kind:'creature'|'hero'|'asset', id:string}} drop
 * @returns {Promise<{roster:object[], xpBudget:number|null, element:object|null}>}
 */
export async function sceneTrayDropOp(dir, w, sceneId, { kind, id }) {
  if (!id) {
    throw new Error("id is required");
  }

  if (kind === "creature") {
    const entry = getBestiaryEntry(id); // throws "No bestiary entry found" -> 404
    const before = getSceneTray(w, sceneId);
    const alreadyInRoster = before.roster.some((r) => r.id === id && r.kind === "creature");
    let element = null;
    if (!alreadyInRoster) {
      if (entry.graphEntityId) {
        element = await attachExistingNodeAsElement(dir, w, sceneId, entry.graphEntityId, {
          name: entry.rawFields?.name ?? undefined,
          stat: statFromBestiaryRawFields(entry)
        });
      } else {
        const existingElement = listElementsForScene(w, sceneId).find((e) => e.fields?.bestiaryEntryId === id);
        if (existingElement) {
          element = existingElement;
        } else {
          element = createElement(w, sceneId, {
            name: entry.rawFields?.name ?? "Unnamed Creature",
            kind: "local",
            fields: { bestiaryEntryId: id },
            stat: statFromBestiaryRawFields(entry)
          });
        }
      }
    }
    const result = addToSceneTray(w, sceneId, { id, kind }, {});
    return { ...result, element };
  }

  if (kind === "hero") {
    getPartyMember(w, id); // throws "No party member found" -> 404
    const result = addToSceneTray(w, sceneId, { id, kind }, {});
    return { ...result, element: null };
  }

  if (kind === "asset") {
    // §7's own pin: resolves item-store-first, then stagecraft-store.
    let resolved = false;
    try {
      getItem(w, id);
      resolved = true;
    } catch { /* fall through to stagecraft-store */ }
    if (!resolved) {
      try {
        getStagecraftAsset(w, id);
        resolved = true;
      } catch { /* neither store has it -- 404 below */ }
    }
    if (!resolved) {
      throw new Error(`No asset found: world="${w}" id="${id}"`);
    }
    const result = addToSceneTray(w, sceneId, { id, kind }, {});
    return { ...result, element: null };
  }

  throw new Error(`Unknown scene tray drop kind: "${kind}" -- expected "creature"|"hero"|"asset"`);
}
