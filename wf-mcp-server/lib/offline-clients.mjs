/**
 * Shared "offline degrade" infrastructure -- extracted verbatim out of
 * review-ui/server.mjs (QA fix-wave W1, Fix 3/Fix 4) so BOTH front ends
 * (review-ui/server.mjs's HTTP routes AND wf-mcp-server/index.mjs's MCP
 * tools) go through the exact same keyless-safety behavior instead of two
 * independently-drifting copies -- per gm-tools-conventions' "front-ends
 * are thin wrappers, never logic duplicators."
 *
 * Found via the MCP-wave packaging pass: wf-mcp-server/index.mjs's
 * LLM-backed tools (wf_propose_mutations, wf_propose_from_writeup,
 * wf_narrate_batch/wf_narrate_entity, wf_run_cycle, wf_resolve_pending, the
 * prep-content tools, ...) called straight into their library functions
 * with NO textureOpts/llmOpts at all -- unlike review-ui's routes, which
 * have gone through offlineOpts() below since the QA fix-wave. That meant
 * an MCP session with no ANTHROPIC_API_KEY set in the wf-mcp-server
 * process's own environment (a genuinely supported, documented
 * configuration -- see RUN.md/.mcp.json.example) would crash on the raw
 * Anthropic SDK's own construction-time "Could not resolve authentication
 * method" error the moment any of those tools were invoked, instead of
 * degrading the same honest way the app itself already does. This module is
 * the fix: wf-mcp-server/index.mjs now imports from here too (grep
 * `offlineOpts(` in both files for the exhaustive call-site list).
 *
 * =============================================================================
 * QA fix-wave W1, Fix 3/Fix 4 -- OFFLINE DEGRADE for every LLM-backed route.
 *
 * FIX 3 (offline degrade): three-plus routes (writeup-propose, assist-prep,
 * propose-updates, bestiary/ingest -- plus a fuller grep-driven audit below)
 * threw the raw Anthropic SDK's own "Could not resolve authentication
 * method" construction-time error keyless, instead of degrading like
 * develop-description/reskin-suggest/chronicle-run already did. `offlineOpts`
 * is the ONE shared helper every LLM-backed route below now goes through --
 * grep `offlineOpts(` for the exhaustive, greppable list. Post-fix invariant:
 * no LLM route can throw an auth error keyless.
 *
 * FIX 4 (offline body must never carry disclaimer boilerplate that gets
 * SAVED verbatim as real content): every offline client below returns a
 * CLEAN body -- no "Offline pass"/"ANTHROPIC_API_KEY" text inside any field
 * that a GM's Accept persists as real world/prep/bestiary/party-roster data.
 * Where a route's response shape has a genuine "why" sibling that is REVIEW
 * METADATA, never itself written into an entity/content field (a mutation's
 * own `rationale`), the honest offline label lives THERE instead. Every
 * route below that returns a one-shot suggestion card ALSO stamps a
 * top-level `offline:true` machine flag on its JSON response, so the
 * frontend can render the disclaimer as CHROME (a small note above the
 * text) rather than baking it into the text itself.
 * =============================================================================
 */
import { z } from "zod";
import { fieldsSchemaForType } from "../../mutation-engine/prep-content.mjs";

/**
 * Shared "offline degrade" wrapper: `{}` when a real ANTHROPIC_API_KEY is
 * configured (every call below is completely unaffected, byte-identical to
 * before this fix-wave), or `{ client: makeOfflineClient() }` when it isn't
 * -- an LLM-backed route degrades to an honest, clearly-labelled placeholder
 * response instead of the raw Anthropic SDK's own construction-time throw.
 * `makeOfflineClient` is a thunk (not the client itself) so it's only ever
 * constructed on the keyless path, never uselessly built alongside a real key.
 */
export function offlineOpts(makeOfflineClient) {
  return process.env.ANTHROPIC_API_KEY ? {} : { client: makeOfflineClient() };
}

/** True exactly when the offline-degrade path above is active for this process -- used to stamp response-level `offline:true` flags (Fix 4). */
export function isOffline() {
  return !process.env.ANTHROPIC_API_KEY;
}

/** Extract the first user-role text content out of an Anthropic-SDK-shaped `messages.create({messages})` call -- every offline client below reads its prompt this same way. */
function firstPromptText(messages) {
  return String(messages?.[0]?.content ?? "");
}

/** Wrap a parsed JSON body as the Anthropic-SDK-shaped response every offline client below returns. */
function offlineTextResponse(bodyObj) {
  return { content: [{ type: "text", text: JSON.stringify(bodyObj) }], stop_reason: "end_turn" };
}

// A generic, honest, disclaimer-free placeholder for any persisted STRING
// content field this file's offline clients need to fill (prep-content
// fields, scene-element fields, etc.) -- deliberately free of "Offline
// pass"/"ANTHROPIC_API_KEY" (Fix 4): short and honest, but never an
// instruction aimed at the GM, so it reads sanely even if accepted verbatim.
export const OFFLINE_CONTENT_PLACEHOLDER = "Not detailed yet — a model wasn't available when this was generated.";

/**
 * OFFLINE DETERMINISTIC texture client (see POST /api/chronicle/run). An
 * Anthropic-SDK-shaped stub used ONLY when no ANTHROPIC_API_KEY is set, so a
 * key-less dev/demo environment (and the Chronicle e2e) still produces a real,
 * reviewable proposal instead of crashing on client construction. It reads the
 * region's own entity id straight out of the textureRegion prompt (which
 * embeds `[id=…]` per renderRegionContext) and returns a single honest,
 * clearly-labelled placeholder field-edit for that entity -- never pretending
 * to be model-authored prose. With a key present it is never constructed.
 *
 * FIX 4: `data.description` (the field a GM's Accept persists verbatim as
 * real entity content) stays a short, clean, disclaimer-free placeholder;
 * the "offline pass" label itself lives only in `rationale` -- review
 * metadata (Batch Review's own "why" text), never written into the entity.
 *
 * Reused as-is (not forked) by wf_propose_mutations/wf_run_cycle/
 * wf_resolve_pending -- non-Chronicle callers pass a neutral `fortuneLabel`
 * (e.g. "unspecified") since there's no fortune-track bias in that context.
 */
export function offlineTextureClient(fortuneLabel) {
  return {
    messages: {
      create: async ({ messages } = {}) => {
        const prompt = firstPromptText(messages);
        const m = /\[id=([^\]]+)\]/.exec(prompt);
        const id = m ? m[1] : null;
        const desc = `Time passed under a ${fortuneLabel} fortune.`;
        const mutation = id
          ? { op: "upsert_entity", id, data: { description: desc }, rationale: "Deferred thread carried into this passage (offline pass -- no model configured; edit or reject before applying)." }
          : { op: "upsert_entity", data: { name: "An unnamed consequence", type: "concept", description: desc }, rationale: "Offline pass -- no model configured; edit or reject before applying." };
        return offlineTextResponse([mutation]);
      }
    }
  };
}

/**
 * OFFLINE DETERMINISTIC develop-description client (see POST /api/graph/
 * nodes/:entityId/develop-description). Same reasoning/shape as
 * offlineTextureClient above -- used ONLY when no ANTHROPIC_API_KEY is set,
 * so the "✦ develop this place" affordance degrades HONESTLY (a real,
 * clearly-labelled placeholder suggestion the GM reviews and can dismiss)
 * rather than the route throwing on client construction. Echoes the GM's own
 * vision back as the suggestion. With a key present this is never constructed.
 *
 * FIX 4 (the persona finding this was built to close): `suggestion` is now a
 * CLEAN, minimal echo of the GM's own vision line -- usable-as-is if
 * accepted verbatim, carrying NEITHER the "Offline pass" disclaimer NOR any
 * instruction to set ANTHROPIC_API_KEY. The route (below) stamps the
 * disclaimer onto a separate `offline:true` response flag instead, which the
 * frontend renders as chrome above the suggestion text, never inside it.
 */
export function offlineDevelopDescriptionClient() {
  return {
    messages: {
      create: async ({ messages } = {}) => {
        const prompt = firstPromptText(messages);
        const m = /## The GM's own vision for this place, right now\s*\n\n([^\n]*)/.exec(prompt);
        const vision = (m ? m[1] : "").trim() || "the GM's own vision";
        const suggestion = vision.charAt(0).toUpperCase() + vision.slice(1) + (/[.!?]$/.test(vision) ? "" : ".");
        return offlineTextResponse({ suggestion });
      }
    }
  };
}

/**
 * OFFLINE DETERMINISTIC reskin-suggest client (see POST /api/combat-
 * planning/bestiary/:id/reskin-suggest). Same shape/reasoning as
 * offlineDevelopDescriptionClient above -- used only when no
 * ANTHROPIC_API_KEY is set, so "✦ Wear it as something else" degrades
 * HONESTLY (real, clearly-labelled placeholder suggestions the GM reviews
 * and can accept/dismiss) rather than the route throwing on client
 * construction. Reads the creature's own name straight out of the prompt's
 * "## The creature being reskinned" section rather than inventing one.
 * Returns exactly MIN_RESKIN_SUGGESTIONS (2) suggestions -- combat-planning/
 * reskin-suggest.mjs's own validation requires at least that many. With a
 * key present this is never constructed.
 *
 * FIX 4: `description`/`habitatHint` (the fields reskin-accept persists
 * verbatim into a brand-new bestiary entry) stay clean and disclaimer-free;
 * the route stamps `offline:true` on the response instead (same convention
 * as develop-description above).
 */
export function offlineReskinSuggestClient() {
  return {
    messages: {
      create: async ({ messages } = {}) => {
        const prompt = firstPromptText(messages);
        const nameMatch = /## The creature being reskinned\s*\n\n([^\n—]*)/.exec(prompt);
        const creatureName = (nameMatch ? nameMatch[1] : "").trim() || "this creature";
        const suggestions = [1, 2].map((n) => ({
          name: `${creatureName} (variant ${n})`,
          description: `A reskinned take on ${creatureName}, not yet detailed.`,
          habitatHint: "Not yet suggested."
        }));
        return offlineTextResponse({ suggestions });
      }
    }
  };
}

/**
 * OFFLINE DETERMINISTIC writeup-import client (see POST /api/writeup-propose,
 * POST /api/scene-planning/scenes|plans/:id/propose-updates -- all three
 * routes ultimately call graph-import/writeup-import.mjs's importWriteup or
 * proposeFramingsFromWriteup with this same injected client). Detects WHICH
 * of the two prompt shapes it's answering by a marker unique to each
 * template (the extraction prompt always renders a "## Source text" section;
 * the framing prompt never does) rather than needing two separate DI seams
 * threaded through importWriteup's own dispatch.
 *
 * FIX 4: the extraction branch returns ZERO entities/edges -- the only
 * HONEST answer for "what did this text contain" without a real model (this
 * project has no non-LLM text-extraction fallback, and inventing placeholder
 * entities from unstructured prose would be actively misleading, not merely
 * unpolished). This still produces a real batch (mutationCount 0), so the
 * route returns 200 with a genuine, honestly-empty result rather than a
 * fabricated one -- the caller sees "nothing extracted (offline)" in the
 * batch summary, never phantom content. The framing branch returns 3 honest,
 * clearly-offline framing sentences (the schema requires exactly 3
 * non-empty strings) -- framings are throwaway UI copy, never persisted as
 * entity content, so no Fix-4 concern applies to them.
 *
 * Marker choice: BOTH prompts/writeup-import.md and prompts/writeup-
 * framing.md render a "## The writeup" section AND (since the intake-quality
 * pass gave the framing call the same names+types census) an "## Entities
 * already in this world's graph" section -- confirmed by reading both files
 * directly, not assumed -- so neither heading can distinguish them.
 * prompts/writeup-import.md's "## Relationships already in this world's
 * graph" section is the one heading unique to the extraction prompt
 * (framing deliberately never gets edges -- see proposeFramingsFromWriteup's
 * own doc comment), checked instead.
 */
export function offlineWriteupClient() {
  return {
    // Persona round (M5): lets the ops layer stamp `offline: true` onto a
    // writeup-propose response, so an honestly-empty keyless extraction is
    // distinguishable from "your writeup contained nothing extractable".
    offline: true,
    messages: {
      create: async ({ messages } = {}) => {
        const prompt = firstPromptText(messages);
        if (/^##\s*Relationships already in this world's graph/m.test(prompt)) {
          return offlineTextResponse({ entities: [], edges: [] });
        }
        const framings = ["a", "b", "c"].map((id) => ({
          id,
          sentence: "Offline pass -- no model configured, so no real interpretation is available yet."
        }));
        return offlineTextResponse({ framings });
      }
    }
  };
}

/**
 * OFFLINE DETERMINISTIC assist-prep client (see POST /api/scene-planning/
 * scenes/:sceneId/assist-prep). Chosen by the ROUTE per its own already-known
 * `mode` (propose-elements / draft-fields / draft-read-aloud) rather than
 * content-sniffing the prompt -- the route already branches on `mode` before
 * calling assistScenePrep, so this is simpler and more honest than a second,
 * regex-based dispatch of the same information.
 *
 * FIX 4: every returned field is clean/disclaimer-free (OFFLINE_CONTENT_PLACEHOLDER,
 * defined above) -- scene-element fields persist directly into the scene-elements
 * store on save, with no separate "rationale" sibling to carry a disclaimer instead.
 */
export function offlineAssistPrepClient(mode, elementName) {
  return {
    messages: {
      create: async () => {
        if (mode === "draft-read-aloud") {
          return offlineTextResponse({ narration: OFFLINE_CONTENT_PLACEHOLDER });
        }
        const name = mode === "draft-fields" ? (elementName || "Untitled element") : "An unnamed detail";
        const elements = [{ name, fields: { gives: OFFLINE_CONTENT_PLACEHOLDER } }];
        return offlineTextResponse({ elements });
      }
    }
  };
}

/**
 * OFFLINE DETERMINISTIC bestiary-ingest client (see POST /api/combat-
 * planning/bestiary/ingest). RawBestiaryFields requires {name, type, hp, ac}
 * -- an honest, obviously-placeholder stat block (hp/ac deliberately
 * implausible round numbers, not a guessed real value) the GM reviews and
 * edits/discards before it's ever promoted to the graph or used in combat
 * planning (bestiary entries are 'proposed' until an explicit accept).
 */
export function offlineBestiaryIngestClient() {
  return {
    messages: {
      create: async () => offlineTextResponse({
        name: "Unidentified creature",
        type: "unknown",
        hp: 1,
        ac: 10
      })
    }
  };
}

/** OFFLINE DETERMINISTIC party-roster-ingest client (see POST /api/combat-planning/party-roster/ingest). RawPartyMemberFields requires only a non-empty `name`; everything else is optional, so an honest placeholder name alone is a fully valid, reviewable proposal. */
export function offlinePartyRosterIngestClient() {
  return {
    messages: {
      create: async () => offlineTextResponse({ name: "Unidentified character" })
    }
  };
}

/**
 * OFFLINE DETERMINISTIC thematic-filter client (see the encounter-suggest
 * pipeline's POST route). Reads every `"entryId": "..."` out of the rendered
 * candidatePoolJson section of the prompt and returns the WHOLE pool
 * unfiltered (never narrows it) -- the honest "no thematic judgment was
 * possible offline" answer, and the only response guaranteed to pass
 * proposeThematicTags' own "never invent an id outside the input pool"
 * validation without seeing the real pool object directly.
 */
export function offlineThematicFilterClient() {
  return {
    messages: {
      create: async ({ messages } = {}) => {
        const prompt = firstPromptText(messages);
        const ids = [...prompt.matchAll(/"entryId":\s*"([^"]+)"/g)].map((m) => m[1]);
        return offlineTextResponse({ filteredEntryIds: ids, rationale: "Offline pass -- no thematic filtering applied; the full candidate pool was passed through unfiltered." });
      }
    }
  };
}

/** OFFLINE DETERMINISTIC quick-gen client (see POST /api/scene-planning/quick-gen). quickGenerate has no JSON/schema contract at all -- it returns raw model text verbatim -- so the offline body itself must already be the final, clean, disclaimer-free text a caller could use as-is. */
export function offlineQuickGenClient() {
  return {
    messages: {
      create: async () => ({ content: [{ type: "text", text: OFFLINE_CONTENT_PLACEHOLDER }], stop_reason: "end_turn" })
    }
  };
}

/**
 * OFFLINE DETERMINISTIC narration client (see POST .../narrate,
 * .../mutations/:id/narrate, and the standalone entity "Narrate This"
 * route). Narration has no JSON schema -- it's plain prose, persisted
 * verbatim by entity-narration.mjs's saveEntityNarration on success -- so,
 * per Fix 4, the returned text must already be the clean, honest,
 * disclaimer-free body a GM could read at the table as-is (short and
 * plainly a placeholder, never an instruction to configure anything).
 */
export function offlineNarrateClient() {
  return {
    messages: {
      create: async () => ({ content: [{ type: "text", text: OFFLINE_CONTENT_PLACEHOLDER }], stop_reason: "end_turn" })
    }
  };
}

/** OFFLINE DETERMINISTIC scan-mentions client (see POST /api/entities/:id/scan-mentions). MentionsResponse's `mentions` array has no minimum length -- the honest offline answer is "no mentions found," never an invented one. */
export function offlineScanMentionsClient() {
  return {
    messages: {
      create: async () => offlineTextResponse({ mentions: [] })
    }
  };
}

/**
 * OFFLINE DETERMINISTIC wrap-suggest client (see POST /api/scene-planning/
 * plans/:planId/wrap-suggest -- session-planner/session-wrap.mjs's
 * suggestWrapTransitions). suggestWrapTransitions' own validation drops any
 * suggestion whose entityId isn't a real roster member, so the only HONEST
 * offline answer is "no suggestions" -- inventing a plausible-looking
 * entityId here would either get silently dropped (best case, misleading
 * about what "offline" produced) or, worse, coincidentally match a real
 * roster entry and look like a genuine suggestion. `note` is a top-level
 * sibling (never inside a persisted field -- there is none here, this
 * response has nothing a GM's apply step would write verbatim) explaining
 * why the roster is empty; the route also stamps `offline:true` on the HTTP
 * response, same convention as every other route in this file.
 */
export function offlineWrapSuggestClient() {
  return {
    messages: {
      create: async () => offlineTextResponse({
        suggestions: [],
        note: "Offline pass -- no model configured, so no reveal-state suggestions could be made; review the candidates manually."
      })
    }
  };
}

/**
 * OFFLINE DETERMINISTIC truth-notes client (see POST /api/scene-planning/
 * plans/:planId/truth-notes -- session-planner/session-wrap.mjs's
 * generateTruthNotes). Unlike develop-description's suggestion card,
 * generateTruthNotes SAVES its markdown straight to the truth-notes store as
 * the plan's new `current` entry -- there is no separate GM accept step
 * downstream to catch a disclaimer before it reaches players. `markdown`
 * therefore stays a short, honest, parenthetical placeholder (never
 * "ANTHROPIC_API_KEY" instructional text, matching Fix 4's spirit) rather
 * than a full offline essay -- a GM reading the recap sees plainly that
 * nothing was generated, and can write the real recap by hand. The route
 * also stamps `offline:true` on the HTTP response, same convention as every
 * other route in this file.
 */
export function offlineTruthNotesClient() {
  return {
    messages: {
      create: async () => offlineTextResponse({
        markdown: "(Offline — no model was available to draft this recap. Write the session's reveals up by hand for now.)"
      })
    }
  };
}

/**
 * A single field's own offline placeholder value, honest to its real zod
 * type (an empty array for an array-typed field -- e.g. every template's
 * shared `potentialRolls` -- OFFLINE_CONTENT_PLACEHOLDER for a string one).
 * Generic over WHICH field, not hardcoded to `potentialRolls` by name, so
 * this stays correct even if a future template adds a second array field.
 */
export function offlinePrepFieldValue(fieldSchema) {
  return fieldSchema instanceof z.ZodArray ? [] : OFFLINE_CONTENT_PLACEHOLDER;
}

/**
 * OFFLINE DETERMINISTIC prep-content client (see the "develop this node"
 * propose-framings/reframe/generate/regenerate-field routes). `kind`
 * selects the response shape the ROUTE already knows it's asking for
 * (framing vs. a full field set vs. a single field), same "route already
 * knows, don't content-sniff" reasoning as offlineAssistPrepClient above.
 *
 * `entityType` (required for kind "generate") drives the response OFF THE
 * REAL per-type zod schema (fieldsSchemaForType) -- each of the six
 * templates is `.strict()`, so a generic "fill every field name from every
 * type" response would fail validation for any type whose schema doesn't
 * contain some other type's field. Reading the schema directly means this
 * client can never drift out of sync with a template's real field list,
 * unlike a hand-duplicated field-name list would.
 */
export function offlinePrepContentClient(kind, { fieldName, entityType } = {}) {
  return {
    messages: {
      create: async () => {
        if (kind === "framing") {
          const framings = ["a", "b", "c"].map((id) => ({ id, sentence: "Offline pass -- no real framing available without a model." }));
          return offlineTextResponse({ framings });
        }
        if (kind === "field") {
          const schema = fieldsSchemaForType(entityType);
          return offlineTextResponse({ value: offlinePrepFieldValue(schema.shape[fieldName]) });
        }
        // kind === "generate": every key this entity type's own schema
        // actually declares, each filled with its own type-honest placeholder.
        const schema = fieldsSchemaForType(entityType);
        const fields = {};
        for (const [key, fieldSchema] of Object.entries(schema.shape)) {
          fields[key] = offlinePrepFieldValue(fieldSchema);
        }
        return offlineTextResponse({ fields });
      }
    }
  };
}
