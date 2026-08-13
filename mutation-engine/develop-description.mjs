/**
 * Develop-description LLM assist — pure, Foundry-free, unit-testable via
 * `opts.client` injection like every other outbound-LLM call site in this
 * project (mutation-engine/llm-call.mjs's own DI seam).
 *
 * Phase 37.6 task 3. Backs the new "✦ develop this place" affordance beside
 * BOTH place-description editors (world-view.js's detail pane, the scene
 * page's own `buildPlaceDescriptionBlock` in session-planner-view.js): the GM
 * types a short one-line vision for a place they're actively working on
 * ("what do you see here?"), and this returns a SUGGESTED block of
 * ADDITIONAL detail text grounded in the entity's current description + its
 * real graph neighborhood — via `narrate.mjs`'s `buildAdjacencyContext`, the
 * shared adjacency builder this project's graph-context convention (Phase
 * 37.6 task 4) names as the default for any NEW call site, rather than a
 * bespoke re-derivation of the same BFS walk.
 *
 * NEVER writes anything, to the graph or anywhere else — this module returns
 * a plain suggestion string. The caller (POST /api/graph/nodes/:id/
 * develop-description) hands it back as a one-shot suggestion the frontend
 * shows inline; accepting it is a SEPARATE, explicit step that merges it into
 * the node's description through the ALREADY-EXISTING editNodeOp route (the
 * same `POST /api/graph/nodes/:id` route the plain click-to-edit description
 * fields already use) — dismissing just discards it. Same no-silent-auto-
 * write discipline as element-assist.mjs's drafts.
 *
 * MANUAL SMOKE TEST (documented per gm-tools-conventions' LLM-code rule — a
 * real, cheap round trip confirming the output validates; not run in CI, no
 * API key in the build env):
 *
 *   ANTHROPIC_API_KEY=sk-... node --input-type=module -e '
 *     import { developDescription } from "./mutation-engine/develop-description.mjs";
 *     import { loadSnapshot } from "./wf-mcp-server/lib/snapshot.mjs";
 *     import { resolveDir } from "./wf-mcp-server/lib/resolve.mjs";
 *     const { entities, edges } = loadSnapshot(resolveDir(), "my-world").snapshot;
 *     const out = await developDescription(entities, edges, "<entityId>", "a place gone quiet since the fire");
 *     console.log(JSON.stringify(out, null, 2));
 *   '
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callModelDetailed, fillTemplate, parseJsonResponse } from "./llm-call.mjs";
import { buildAdjacencyContext } from "./narrate.mjs";
import { findEntity } from "../wf-mcp-server/lib/graph.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "develop-description.md"), "utf8");

// Concise, grounded prose -- same sonnet tier every other structured/short
// creative call site in this project defaults to. Caller may override via
// opts.model.
export const DEFAULT_DEVELOP_DESCRIPTION_MODEL = "claude-sonnet-5";

function renderNeighborhood(neighborDescriptions) {
  if (!neighborDescriptions.length) return "(no recorded graph connections)";
  return neighborDescriptions.map((d) => `- ${d}`).join("\n");
}

/**
 * @param {object[]} entities   live snapshot entities
 * @param {object[]} edges      live snapshot edges
 * @param {string} entityId     the graph node being developed (world-view's selected node, or a scene's anchor place)
 * @param {string} vision       the GM's own one-line prompt for this place -- required, non-empty
 * @param {object} [opts]
 * @param {object} [opts.client]   injectable Anthropic-SDK-shaped client (tests / DI); real client built from opts.apiKey otherwise
 * @param {string} [opts.apiKey]
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.adjacencyDepth]   defaults to buildAdjacencyContext's own default (1 -- immediate neighbors only)
 * @returns {Promise<{suggestion: string}>}   the model's suggested ADDITIONAL detail text (never persisted here)
 */
export async function developDescription(entities, edges, entityId, vision, opts = {}) {
  const entity = findEntity(entities, entityId);
  if (!entity) {
    throw new Error(`developDescription: no entity found for id "${entityId}".`);
  }
  const trimmedVision = String(vision ?? "").trim();
  if (!trimmedVision) {
    throw new Error("developDescription: a non-empty vision prompt is required.");
  }

  const { entityLabel, neighborDescriptions } = buildAdjacencyContext(entities, edges, entityId, opts.adjacencyDepth);

  const prompt = fillTemplate(PROMPT_TEMPLATE, {
    entityLabel,
    currentDescription: entity.description && entity.description.trim() ? entity.description.trim() : "(none recorded yet)",
    neighborhoodContext: renderNeighborhood(neighborDescriptions),
    vision: trimmedVision
  });

  const { text } = await callModelDetailed(prompt, {
    client: opts.client,
    apiKey: opts.apiKey,
    model: opts.model ?? DEFAULT_DEVELOP_DESCRIPTION_MODEL,
    maxTokens: opts.maxTokens ?? 768
  });

  const parsed = parseJsonResponse(text);
  const suggestion = String(parsed?.suggestion ?? "").trim();
  if (!suggestion) {
    throw new Error("developDescription: the model returned no usable suggestion.");
  }
  return { suggestion };
}
