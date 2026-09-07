/**
 * Reskin-suggester LLM assist — pure, Foundry-free, unit-testable via
 * `opts.client` injection like every other outbound-LLM call site in this
 * project (mutation-engine/llm-call.mjs's own DI seam).
 *
 * Phase 37.6b. Backs the Bestiary stat rail's "✦ Wear it as something else"
 * affordance (review-ui/public/library-view.js) -- "same numbers, different
 * creature": the model NEVER sees the stat block's actual numbers (ac/hp/
 * attacks/damage dice/etc) -- only a compact FLAVOR summary of them
 * (bestiary-store.mjs's compactStatFlavorLine, shared with
 * promoteBestiaryEntryToGraph's own description-seed rather than
 * re-derived here), so a suggestion can't accidentally propose new numbers.
 * Returns 2-3 `{name, description, habitatHint}` suggestions; NEVER writes
 * anything -- the caller (POST /api/combat-planning/bestiary/:id/
 * reskin-suggest) hands them back as one-shot cards, and accepting one is a
 * SEPARATE, explicit step (bestiary-store.mjs's createReskinnedBestiaryEntry,
 * via POST .../reskin-accept) that creates a brand-new bestiary entry with
 * the byte-identical rawFields -- same no-silent-auto-write discipline as
 * mutation-engine/develop-description.mjs's own suggestion/accept split.
 *
 * GRAPH CONTEXT (Phase 37.6 task 4's graph-context-everywhere rule): when the
 * entry is already promoted (`graphEntityId` set -- see
 * bestiary-store.mjs's promoteBestiaryEntryToGraph), grounds on that
 * entity's real immediate neighborhood via narrate.mjs's
 * buildAdjacencyContext (this project's default entity-centric context
 * builder for any NEW call site). Otherwise there is no anchor entity to
 * walk outward from yet, so it falls back to a compact whole-world summary
 * -- graph-import/writeup-import.mjs's renderExistingWorldSummary, REUSED
 * rather than re-derived (same "names/types only" shape), matching that
 * module's own identical "no anchor entity" reasoning for its own,
 * structurally identical fallback.
 *
 * OFFLINE DETERMINISTIC DEGRADE: see review-ui/server.mjs's
 * offlineReskinSuggestClient (same shape/reasoning as
 * offlineDevelopDescriptionClient) -- used only when no ANTHROPIC_API_KEY is
 * set, so a key-less dev/demo environment (and this route's own e2e
 * coverage) still gets real, honestly-labelled suggestions instead of the
 * route throwing on client construction. With a key present it is never
 * constructed.
 *
 * MANUAL SMOKE TEST (documented per gm-tools-conventions' LLM-code rule — a
 * real, cheap round trip confirming the output validates; not run in CI, no
 * API key in the build env):
 *
 *   ANTHROPIC_API_KEY=sk-... node --input-type=module -e '
 *     import { suggestReskins } from "./combat-planning/reskin-suggest.mjs";
 *     import { getBestiaryEntry } from "./combat-planning/bestiary-store.mjs";
 *     import { loadSnapshot } from "./wf-mcp-server/lib/snapshot.mjs";
 *     import { resolveDir } from "./wf-mcp-server/lib/resolve.mjs";
 *     const entry = getBestiaryEntry("<entryId>");
 *     const { entities, edges } = loadSnapshot(resolveDir(), "my-world").snapshot;
 *     const out = await suggestReskins(entry, entities, edges, "closer to a court intriguer than a brute");
 *     console.log(JSON.stringify(out, null, 2));
 *   '
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callModelDetailed, fillTemplate, parseJsonResponse } from "../mutation-engine/llm-call.mjs";
import { buildAdjacencyContext } from "../mutation-engine/narrate.mjs";
import { renderExistingWorldSummary } from "../graph-import/writeup-import.mjs";
import { compactStatFlavorLine } from "./bestiary-store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "creature-reskin.md"), "utf8");

// Concise, grounded creative work -- same sonnet tier every other
// structured/short creative call site in this project defaults to
// (develop-description.mjs, element-assist.mjs). Caller may override via
// opts.model.
export const DEFAULT_RESKIN_SUGGEST_MODEL = "claude-sonnet-5";

export const MIN_RESKIN_SUGGESTIONS = 2;
export const MAX_RESKIN_SUGGESTIONS = 3;

function renderGraphContext(entities, edges, entry) {
  if (entry?.graphEntityId) {
    const { entityLabel, neighborDescriptions } = buildAdjacencyContext(entities, edges, entry.graphEntityId);
    const neighbors = neighborDescriptions.length
      ? neighborDescriptions.map((d) => `- ${d}`).join("\n")
      : "(no recorded graph connections)";
    return `This creature is already linked to the world graph as "${entityLabel}". Nearby:\n${neighbors}`;
  }
  return (
    `This creature isn't linked to the world graph yet. Here's a compact summary of the world it might drop into:\n` +
    renderExistingWorldSummary(entities)
  );
}

function normalizeSuggestion(raw) {
  const name = String(raw?.name ?? "").trim();
  const description = String(raw?.description ?? "").trim();
  const habitatHint = String(raw?.habitatHint ?? "").trim();
  if (!name || !description || !habitatHint) return null;
  // Optional (2026-09-07): per-ability DELIVERY reflavor lines. Absence is
  // valid; each line reflavors how an ability LOOKS, never its mechanics.
  const reflavorNotes = Array.isArray(raw?.reflavorNotes)
    ? raw.reflavorNotes.map((s) => String(s).trim()).filter(Boolean)
    : [];
  return { name, description, habitatHint, ...(reflavorNotes.length ? { reflavorNotes } : {}) };
}

/**
 * @param {object} entry        a BestiaryEntry (bestiary-store.mjs's getBestiaryEntry shape -- rawFields required)
 * @param {object[]} entities   live snapshot entities (may be [] -- a fresh/empty world is a real, valid input, not an error)
 * @param {object[]} edges      live snapshot edges
 * @param {string} [vision]     optional GM one-line steer ("closer to a court intriguer than a brute"), same shape as developDescription's own vision param -- unlike that one, empty/omitted is valid here (the model is told to surprise the GM instead)
 * @param {object} [opts]
 * @param {object} [opts.client]   injectable Anthropic-SDK-shaped client (tests / DI); real client built from opts.apiKey otherwise
 * @param {string} [opts.apiKey]
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{suggestions: Array<{name:string, description:string, habitatHint:string}>}>}
 */
export async function suggestReskins(entry, entities, edges, vision, opts = {}) {
  if (!entry || !entry.rawFields) {
    throw new Error("suggestReskins requires a BestiaryEntry with rawFields.");
  }
  const trimmedVision = String(vision ?? "").trim();

  const prompt = fillTemplate(PROMPT_TEMPLATE, {
    creatureName: entry.rawFields?.name || "Unnamed creature",
    statFlavor: compactStatFlavorLine(entry.rawFields) || "(no stat-block flavor recorded)",
    graphContext: renderGraphContext(entities || [], edges || [], entry),
    vision: trimmedVision || "(no specific steer from the GM this time -- surprise them, but stay plausible for this creature's stat block)"
  });

  const { text } = await callModelDetailed(prompt, {
    client: opts.client,
    apiKey: opts.apiKey,
    model: opts.model ?? DEFAULT_RESKIN_SUGGEST_MODEL,
    maxTokens: opts.maxTokens ?? 1024
  });

  const parsed = parseJsonResponse(text);
  const rawSuggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  const suggestions = rawSuggestions.map(normalizeSuggestion).filter(Boolean).slice(0, MAX_RESKIN_SUGGESTIONS);

  if (suggestions.length < MIN_RESKIN_SUGGESTIONS) {
    throw new Error(
      `suggestReskins: the model returned ${suggestions.length} usable suggestion(s), need at least ${MIN_RESKIN_SUGGESTIONS}.`
    );
  }
  return { suggestions };
}
