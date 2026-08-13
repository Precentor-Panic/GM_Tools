/**
 * Scene-element functional-prep LLM assist — pure, Foundry-free, unit-testable
 * via `opts.client` injection like every other outbound-LLM call site in this
 * project (mutation-engine/llm-call.mjs's own DI seam).
 *
 * Phase 28 task 28.4, §E. Backs the scene page's inline `✦` ghost links: read
 * the scene's place + nearby graph context (+ the elements already keyed here)
 * and either PROPOSE a handful of elements, functional and mundane-dressing
 * alike ("propose elements here") or DRAFT the functional-prep fields for one
 * named element ("draft fields"). Grounded in the concise one-page-dungeon
 * field model (Looks/Means/Checks/Gives/Function/Trigger, appearance
 * de-prioritized), per prompts/scene-element-functional-prep.md.
 *
 * Phase 37.6 task 1 added a THIRD mode, "draft-read-aloud", backing the same
 * page's `✦ Draft this from the place description and the objective` link --
 * previously a plain JS string concatenation wearing the `✦` glyph with no
 * model call at all. It now genuinely calls the model (place description +
 * objective + neighborhood, prompts/scene-read-aloud-draft.md) and returns
 * `{ narration }` instead of `{ elements }`.
 *
 * The no-silent-auto-write invariant governs GRAPH writes; it does NOT forbid
 * this. Drafting element fields writes only to the scene-elements store (a
 * scene-local authoring aid, the exact same surface as hand-typing an element)
 * — NEVER to the World Fabric graph. This module itself writes NOTHING: it
 * returns validated drafts and lets the caller (the route / the frontend)
 * persist them through the ordinary scene-elements/narration routes.
 * Element→graph PROMOTION still only ever happens via the explicit promote
 * route / the Wrap confirm step, never here.
 *
 * MANUAL SMOKE TEST (documented per gm-tools-conventions' LLM-code rule — a
 * real, cheap round trip confirming the output validates; not run in CI, no
 * API key in the build env):
 *
 *   ANTHROPIC_API_KEY=sk-... node --input-type=module -e '
 *     import { assistScenePrep } from "./session-planner/element-assist.mjs";
 *     import { resolveDir } from "./wf-mcp-server/lib/resolve.mjs";
 *     const out = await assistScenePrep(resolveDir(), "my-world", "<sceneId>",
 *       { mode: "propose-elements" });
 *     console.log(JSON.stringify(out, null, 2));
 *   '
 *
 * (For draft-fields mode pass `{ mode: "draft-fields", elementName: "..." }`.
 * For draft-read-aloud pass `{ mode: "draft-read-aloud" }`.)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callModelDetailed, fillTemplate, parseJsonResponse } from "../mutation-engine/llm-call.mjs";
import { loadSnapshot } from "../wf-mcp-server/lib/snapshot.mjs";
import { neighborhood } from "../wf-mcp-server/lib/graph.mjs";
import { getScene } from "./scenes.mjs";
import { listElementsForScene, SceneElementFields } from "./scene-elements.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "scene-element-functional-prep.md"), "utf8");
const READ_ALOUD_PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "scene-read-aloud-draft.md"), "utf8");

// The functional-prep assist is concise/structured work — same sonnet tier the
// project's other structured-extraction call sites (prep generation, writeup
// import) already default to. Caller may override via opts.model.
export const DEFAULT_ELEMENT_ASSIST_MODEL = "claude-sonnet-5";

// Known field vocabulary, sourced DIRECTLY from scene-elements.mjs's own Zod
// shape so the two never drift. A model reply carrying an unknown key is
// tolerated by dropping the key (SceneElementFields is `.strict()` and would
// otherwise reject the whole element) rather than failing the whole draft.
const KNOWN_FIELD_KEYS = Object.keys(SceneElementFields.shape);

function pickKnownFields(fields) {
  const out = {};
  for (const key of KNOWN_FIELD_KEYS) {
    if (fields && fields[key] !== undefined && fields[key] !== null) out[key] = fields[key];
  }
  return out;
}

// Phase 37.6 task 4 (graph-context census) doc-note: this stays a BESPOKE
// renderer (name + type + description per neighbor, one-hop entities already
// resolved by the caller via wf-mcp-server/lib/graph.mjs's neighborhood())
// rather than switching to narrate.mjs's buildAdjacencyContext -- richer
// (carries description, which the functional-prep/draft-read-aloud prompts
// both genuinely use) and already fit-for-purpose here. buildAdjacencyContext
// is this project's default for any NEW entity-centric call site going
// forward (Phase 37.6 task 4's own scan-mentions.mjs/develop-description.mjs
// additions both use it); this pre-existing builder is intentionally
// unchanged.
function describeNeighborhood(place, neighborEntities) {
  const others = neighborEntities.filter((e) => e.id !== place?.id);
  if (!others.length) return "(no recorded graph connections)";
  return others
    .map((e) => `- ${e.name}${e.type ? ` (${e.type})` : ""}${e.description ? `: ${e.description}` : ""}`)
    .join("\n");
}

function describeExistingElements(elements) {
  if (!elements.length) return "(none keyed yet)";
  return elements.map((e) => `- ${e.name || "(unnamed)"}`).join("\n");
}

/** draft-read-aloud mode: place + objective + neighborhood -> `{ narration }`. Separate small helper (own prompt/response shape) rather than folding into the elements branch below. */
async function draftReadAloud(scene, place, neighborEntities, opts) {
  const prompt = fillTemplate(READ_ALOUD_PROMPT_TEMPLATE, {
    placeName: place?.name ?? "(this scene has no anchor place)",
    placeDescription: place?.description ?? "(none recorded)",
    neighborhoodContext: describeNeighborhood(place, neighborEntities),
    objective: (scene.objectiveNote ?? "").trim() || "(no objective set for this scene)"
  });

  const { text } = await callModelDetailed(prompt, {
    client: opts.client,
    apiKey: opts.apiKey,
    model: opts.model ?? DEFAULT_ELEMENT_ASSIST_MODEL,
    maxTokens: opts.maxTokens ?? 512
  });

  const parsed = parseJsonResponse(text);
  return { narration: String(parsed?.narration ?? "").trim() };
}

/**
 * @param {string} dir       resolved data dir (resolveDir()'s return value)
 * @param {string} world
 * @param {string} sceneId
 * @param {object} params
 * @param {"propose-elements"|"draft-fields"|"draft-read-aloud"} [params.mode="propose-elements"]
 * @param {string} [params.elementName]   REQUIRED for mode "draft-fields": which element to draft fields for
 * @param {object} [opts]
 * @param {object} [opts.client]   injectable Anthropic-SDK-shaped client (tests / DI); real client built from opts.apiKey otherwise
 * @param {string} [opts.apiKey]
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{elements: Array<{name:string, fields:object}>}|{narration:string}>}   validated, store-shaped drafts (never persisted here); `{narration}` for mode "draft-read-aloud"
 */
export async function assistScenePrep(dir, world, sceneId, params = {}, opts = {}) {
  const mode = params.mode ?? "propose-elements";
  if (mode === "draft-fields" && !String(params.elementName ?? "").trim()) {
    throw new Error('assistScenePrep: mode "draft-fields" requires a non-empty elementName.');
  }

  const scene = getScene(world, sceneId); // throws "No scene found" if unknown
  const { entities, edges } = loadSnapshot(dir, world).snapshot;
  const place = scene.locationEntityId ? entities.find((e) => e.id === scene.locationEntityId) ?? null : null;
  const neighborEntities = place ? neighborhood(entities, edges, place.id, 1).entities : [];

  if (mode === "draft-read-aloud") {
    return draftReadAloud(scene, place, neighborEntities, opts);
  }

  const existing = listElementsForScene(world, sceneId);

  const instruction =
    mode === "draft-fields"
      ? `Draft concise functional prep for the SINGLE element named "${params.elementName}" that belongs in this room. Return EXACTLY ONE element, with that exact name, filling in the fields that genuinely help run it.`
      : // Phase 37.6 task 1: this ONE mode now covers what "✦ Suggest dressing"
        // used to (a retired keyword-matched, place-agnostic table) -- ask for
        // a MIX so nothing that control gave the GM is lost, all of it now
        // genuinely grounded in this place's own description/neighbors rather
        // than a canned bucket. Most proposals should still be interactable
        // (real trigger + payload); 1 to 3 should be plain mundane set
        // dressing instead -- an ordinary sensory/atmosphere object that
        // makes the room feel lived-in (only a `name` and a short `gives`
        // sensory line; no trigger or checks needed for these).
        "Propose 4 to 7 elements that plausibly belong in this room, grounded specifically in the place's description and its graph neighbors above (never generic filler that could sit in any room). Most should be genuinely INTERACTABLE, with a real trigger and payload — the useful bones a GM runs at the table. Include 1 to 3 that are pure MUNDANE SET DRESSING instead: an ordinary sensory/atmosphere object or detail that makes the room feel real, keyed with just a `name` and a short `gives` (its sensory/flavor payload) — no trigger or checks required for these. Key every element the way a one-page dungeon keys its objects, whichever kind it is.";

  const prompt = fillTemplate(PROMPT_TEMPLATE, {
    placeName: place?.name ?? "(this scene has no anchor place)",
    placeDescription: place?.description ?? "(none recorded)",
    neighborhoodContext: describeNeighborhood(place, neighborEntities),
    existingElements: describeExistingElements(existing),
    instruction,
    retryNote: ""
  });

  const { text } = await callModelDetailed(prompt, {
    client: opts.client,
    apiKey: opts.apiKey,
    model: opts.model ?? DEFAULT_ELEMENT_ASSIST_MODEL,
    maxTokens: opts.maxTokens ?? 2048
  });

  const parsed = parseJsonResponse(text);
  const rawElements = Array.isArray(parsed?.elements) ? parsed.elements : [];

  const elements = rawElements
    .filter((el) => el && String(el.name ?? "").trim())
    .map((el) => ({
      name: String(el.name).trim(),
      // Validate the drafted fields against the SAME Zod shape the store
      // enforces on write, after dropping any unknown keys — a draft that
      // survives here will survive the ordinary create/update route unchanged.
      fields: SceneElementFields.parse(pickKnownFields(el.fields ?? {}))
    }));

  if (mode === "draft-fields") {
    // Keep only the element matching the requested name (case-insensitive),
    // falling back to the first returned element if the model renamed it.
    const wanted = String(params.elementName).trim().toLowerCase();
    const match = elements.find((e) => e.name.toLowerCase() === wanted) ?? elements[0];
    return { elements: match ? [match] : [] };
  }

  return { elements };
}
