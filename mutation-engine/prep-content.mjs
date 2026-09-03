/**
 * Prep-content store — pure, Foundry-free, unit-testable. Phase 11 tasks
 * 11.1/11.2.
 *
 * WHY A SEPARATE STORE, NOT THE MUTATION ENGINE (verified against the real
 * code, not just reasoned from the design doc's flagged caveat — see
 * plans/phase-11-review.md's "Open questions" #1): mutation-engine/schema.mjs's
 * `Mutation`/`StoredMutation` shape is `{op, id, data, rationale, batchId,
 * sourceKind, impactScore, mutationId, status, ...}` — a single graph-diff
 * operation that belongs to a `Batch` (review-state.mjs's `createBatch`),
 * goes through `diff.mjs` against a live snapshot, and is meant to be
 * applied to the World Fabric graph via `wf_sync_to_foundry`/
 * `headless-apply.mjs`. PrepContent has none of that shape: it isn't an
 * `op` against an entity/edge, it doesn't belong to a `Batch` (a "develop
 * this node" action is a single-entity, single-purpose act with no batching
 * concept), it is never diffed against the live graph the way an
 * entity/edge mutation is, and per this phase's confirmed decision it must
 * NEVER be synced to Foundry at all — the exact opposite of what
 * `StoredMutation` exists to eventually reach. Forcing PrepContent through
 * `Batch`/`StoredMutation`/`review-state.mjs` would mean either loosening
 * `Mutation`'s `.strict()` schema (schema.mjs's own doc comment explains
 * why that split from `StoredMutation` was deliberate) or inventing a fake
 * `op` that lies about what actually happened — both worse than a small,
 * independent store. This module is that store, following
 * `entity-narration.mjs`/`human-review.mjs`'s established flat-JSON/
 * `withLock`/env-override convention exactly, confirmed correct rather than
 * assumed.
 *
 * Storage: one JSON file per (world, entityId) — `<prepContentRoot>/<world>/
 * <entityId>.json`, holding a SINGLE PrepContent object (not a history
 * array like entity-narration.mjs): the design doc's data shape has no
 * history list, and living-doc field regeneration is meant to mutate the
 * one current doc's fields in place, not accumulate an ever-growing list of
 * past drafts. Default root is GM_Tools/prep-content/ (sibling to
 * review-state/, entity-narration/, human-review/, pending-resolution/,
 * user-settings/); override with GM_TOOLS_PREP_CONTENT_DIR (tests use this
 * for isolation — this project's standing "no write in this file leaked
 * into the repo's real default directory" regression-test convention).
 *
 * STATUS LIFECYCLE: 'proposed' (freshly generated, not yet confirmed by the
 * GM) -> 'accepted' (GM confirmed it as real prep material) -> 'stale'
 * (the underlying entity was mutated again after acceptance — see task
 * 11.4/wf-mcp-server/lib/mutation-ops.mjs's acceptMutationIds). A
 * 'proposed' draft can be discarded outright (discardPrepContent) — it was
 * never confirmed, so there's nothing to preserve; an 'accepted' or 'stale'
 * doc is NEVER deleted by this module, matching the no-silent-loss
 * convention entity-narration.mjs/human-review.mjs already established for
 * their own persisted content (markPrepContentStale flips status only,
 * never touches `fields`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withLock, ConcurrentWriteError } from "./review-state.mjs";
import { callModelDetailed, fillTemplate as fillTemplateShared, parseJsonResponse } from "./llm-call.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "prep-content");
const FRAMING_PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "prep-framing.md"), "utf8");
const GENERATION_PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "prep-generation.md"), "utf8");
const FIELD_REGEN_PROMPT_TEMPLATE = readFileSync(join(__dirname, "..", "prompts", "prep-field-regenerate.md"), "utf8");

export const SCHEMA_VERSION = 1;

// Same Layer-0 entity-type vocabulary wf-mcp-server/graph-import already
// constrain to (writeup-import.mjs's own EntityType) — reused, not
// reinvented, so this module stays in sync with the rest of the codebase's
// idea of what an entity type even is.
export const PrepEntityType = z.enum(["person", "place", "faction", "object", "event", "concept"]);
export const PrepContentStatus = z.enum(["proposed", "accepted", "stale"]);

const Roll = z.object({
  skill: z.string().min(1),
  dc: z.number(),
  purpose: z.string().min(1)
}).strict();

// ---------------------------------------------------------------------------
// Task 11.1: the six entity-type templates, per phase-11-review.md's exact
// field lists (person/place/faction/object/event get full templates; concept
// gets the reduced description+howItSurfaces scope, an explicit scoping call
// the design doc itself flags as "not discussed directly by the owner").
// `potentialRolls` is normalized to a plural array across every type that
// has rolls at all (the design doc's prose varies singular/mostly-plural
// informally -- "potential roll(s)" / "a potential roll" / "roll(s)" -- a
// single consistent shape is simpler to render/validate and loses nothing:
// a one-item array covers the singular case).
// ---------------------------------------------------------------------------

const FIELDS_SCHEMA_BY_TYPE = {
  person: z.object({
    descriptionAppearance: z.string(),
    personalityMannerisms: z.string(),
    motivationGoal: z.string(),
    secret: z.string(),
    potentialRolls: z.array(Roll),
    hook: z.string()
  }).strict(),
  place: z.object({
    descriptionAtmosphere: z.string(),
    notableFeatures: z.string(),
    secret: z.string(),
    potentialEncounter: z.string(),
    potentialRolls: z.array(Roll)
  }).strict(),
  faction: z.object({
    publicFaceGoals: z.string(),
    internalConflictSecret: z.string(),
    resourcesReach: z.string(),
    hookConsequence: z.string()
  }).strict(),
  object: z.object({
    appearance: z.string(),
    mechanicalProperties: z.string(),
    originSecret: z.string(),
    discovery: z.string(),
    potentialRolls: z.array(Roll)
  }).strict(),
  event: z.object({
    publicAccount: z.string(),
    actualTruth: z.string(),
    rippleConsequences: z.string(),
    potentialRolls: z.array(Roll)
  }).strict(),
  concept: z.object({
    description: z.string(),
    howItSurfaces: z.string()
  }).strict()
};

/** The zod schema for one entity type's `fields` shape. Throws for an unknown type rather than returning undefined. */
export function fieldsSchemaForType(entityType) {
  const schema = FIELDS_SCHEMA_BY_TYPE[entityType];
  if (!schema) {
    throw new Error(`No prep-content field template for entity type "${entityType}". Known types: ${Object.keys(FIELDS_SCHEMA_BY_TYPE).join(", ")}.`);
  }
  return schema;
}

// One-line human descriptions per field, used to build the generation/
// field-regenerate prompts' "what to produce" spec text — kept as data here
// rather than hardcoded per-type prose inside the (shared) prompt template
// files, per task 11.2's "shared template with type-conditional instructions"
// framing (this module's own call, as the task file allows).
const FIELD_DESCRIPTIONS_BY_TYPE = {
  person: {
    descriptionAppearance: "Physical description and appearance -- what a player would notice on sight.",
    personalityMannerisms: "Personality traits, speech patterns, and mannerisms that make roleplaying this NPC distinctive.",
    motivationGoal: "What this person actually wants, and why.",
    secret: "Something true about this person that isn't publicly known -- a fact the GM can reveal later.",
    potentialRolls: "1-3 concrete skill checks a player might reasonably make when interacting with this person, each {skill, dc, purpose} -- purpose is a one-line note on what succeeding or failing reveals or does.",
    hook: "A concrete way this person could pull the party into a scene, quest, or complication."
  },
  place: {
    descriptionAtmosphere: "Sensory description and mood -- what a player would see, hear, and feel here.",
    notableFeatures: "Specific points of interest or landmarks within this place.",
    secret: "Something hidden about this place that isn't obvious on arrival.",
    potentialEncounter: "A concrete encounter or complication that could plausibly occur here.",
    potentialRolls: "1-3 concrete skill checks tied to exploring or interacting with this place, each {skill, dc, purpose}."
  },
  faction: {
    publicFaceGoals: "What this faction presents itself as, and its stated goals.",
    internalConflictSecret: "An internal conflict, fracture, or secret that complicates the faction's public face.",
    resourcesReach: "What resources, influence, or reach this faction actually has.",
    hookConsequence: "A concrete hook for the party, or a consequence of crossing this faction."
  },
  object: {
    appearance: "Physical description of the object.",
    mechanicalProperties: "Any mechanical or plot-relevant properties, if relevant -- keep this general/narrative if the object is purely a story item.",
    originSecret: "The object's true origin, or a secret about it.",
    discovery: "How the party is likely to discover or come across this object.",
    potentialRolls: "1-3 concrete skill checks tied to identifying or using this object, each {skill, dc, purpose}."
  },
  event: {
    publicAccount: "The account of this event that most people believe or have heard.",
    actualTruth: "What actually happened, if different from the public account.",
    rippleConsequences: "Concrete consequences or ripples this event has caused or will cause.",
    potentialRolls: "1-3 concrete skill checks tied to uncovering the truth behind this event, each {skill, dc, purpose}."
  },
  concept: {
    description: "A clear description of this concept or idea.",
    howItSurfaces: "A concrete way this concept surfaces or matters during actual play."
  }
};

/** Human-readable one-liner for a single field of a given entity type -- used by regeneratePrepField's prompt. */
export function fieldDescription(entityType, fieldName) {
  return FIELD_DESCRIPTIONS_BY_TYPE[entityType]?.[fieldName] ?? "(no description recorded for this field)";
}

/** Bullet-list spec text for the generation prompt's "fields to produce" section, built from FIELD_DESCRIPTIONS_BY_TYPE -- never hand-duplicated per type in the prompt file itself. */
export function fieldSpecTextForType(entityType) {
  const descriptions = FIELD_DESCRIPTIONS_BY_TYPE[entityType];
  if (!descriptions) throw new Error(`No field descriptions for entity type "${entityType}".`);
  return Object.entries(descriptions)
    .map(([field, desc]) => `- \`${field}\`: ${desc}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Persisted shape + store CRUD
// ---------------------------------------------------------------------------

export const PrepContent = z.object({
  entityId: z.string(),
  entityType: PrepEntityType,
  framingUsed: z.string(),
  status: PrepContentStatus,
  generatedAt: z.string(),
  lastRegeneratedAt: z.string().optional(),
  fields: z.record(z.string(), z.any())
}).strict();

function validatePrepContent(doc) {
  const parsed = PrepContent.parse(doc);
  fieldsSchemaForType(parsed.entityType).parse(parsed.fields);
  return parsed;
}

export function prepContentRoot() {
  return process.env.GM_TOOLS_PREP_CONTENT_DIR || DEFAULT_ROOT;
}

function worldDir(world) {
  return join(prepContentRoot(), world);
}

function prepContentFilePath(world, entityId) {
  return join(worldDir(world), `${entityId}.json`);
}

/** The entity's current prep content, or null if none has ever been generated. Never throws for "not found". */
export function getPrepContent(world, entityId) {
  const filePath = prepContentFilePath(world, entityId);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeDoc(world, entityId, doc) {
  const validated = validatePrepContent(doc);
  const filePath = prepContentFilePath(world, entityId);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(validated, null, 2), "utf8");
  });
  return validated;
}

/**
 * Save a freshly-generated (or wholesale-replaced) prep-content doc, status
 * defaulting to 'proposed'. Overwrites whatever was there before in full --
 * for a field-granular edit use updatePrepField instead.
 *
 * @param {string} world
 * @param {string} entityId
 * @param {{entityType:string, framingUsed:string, fields:object, status?:string}} doc
 * @param {object} [opts]
 * @param {string} [opts.now]  injectable ISO timestamp, for deterministic tests
 * @returns {object} the saved, validated PrepContent
 */
export function savePrepContent(world, entityId, doc, opts = {}) {
  const now = opts.now ?? new Date().toISOString();
  const full = {
    entityId,
    entityType: doc.entityType,
    framingUsed: doc.framingUsed,
    status: doc.status ?? "proposed",
    generatedAt: doc.generatedAt ?? now,
    ...(doc.lastRegeneratedAt ? { lastRegeneratedAt: doc.lastRegeneratedAt } : {}),
    fields: doc.fields
  };
  return writeDoc(world, entityId, full);
}

/** Flip a 'proposed' draft to 'accepted' -- the initial full-block accept the design doc requires before any field-granular editing is meaningful. Throws if nothing has been proposed yet. */
export function acceptPrepContent(world, entityId) {
  const existing = getPrepContent(world, entityId);
  if (!existing) {
    throw new Error(`No prep content proposed yet for entity "${entityId}" in world "${world}" -- nothing to accept.`);
  }
  return writeDoc(world, entityId, { ...existing, status: "accepted" });
}

/**
 * Discard a not-yet-accepted 'proposed' draft outright -- safe because it
 * was never confirmed as real prep material. Refuses (throws) to discard an
 * 'accepted' or 'stale' doc: those are never deleted by this module, only
 * ever marked stale (markPrepContentStale). A safe no-op if there's nothing
 * at all yet.
 */
export function discardPrepContent(world, entityId) {
  const existing = getPrepContent(world, entityId);
  if (!existing) return null;
  if (existing.status !== "proposed") {
    throw new Error(
      `Refusing to discard prep content for entity "${entityId}" (status "${existing.status}") -- only a ` +
      `not-yet-accepted 'proposed' draft can be discarded outright. Accepted or stale content is never deleted, ` +
      `only marked stale.`
    );
  }
  const filePath = prepContentFilePath(world, entityId);
  withLock(filePath, () => {
    try { unlinkSync(filePath); } catch { /* already gone */ }
  });
  return { entityId, discarded: true };
}

/**
 * Task 11.4's hook target: mark an entity's existing prep content 'stale'
 * without touching `fields` at all -- the content remains fully readable,
 * just flagged as possibly out of sync with the entity's current state. A
 * safe no-op (returns null, writes nothing) for an entity with no prep
 * content yet, matching entity-narration.mjs's supersedeEntityNarration's
 * own "nothing to flag" convention.
 */
export function markPrepContentStale(world, entityId) {
  const existing = getPrepContent(world, entityId);
  if (!existing) return null;
  if (existing.status === "stale") return existing;
  return writeDoc(world, entityId, { ...existing, status: "stale" });
}

/**
 * The field-granular living-doc edit path (task 11.1): mutate exactly ONE
 * named field, leaving every other field byte-identical. Validates both
 * that `fieldName` is a real field for this entity's type AND that
 * `newValue` matches that field's own expected shape before writing
 * anything.
 *
 * @param {string} world
 * @param {string} entityId
 * @param {string} fieldName
 * @param {*} newValue
 * @param {object} [opts]
 * @param {string} [opts.now]
 * @returns {object} the saved, validated PrepContent (status unchanged)
 */
export function updatePrepField(world, entityId, fieldName, newValue, opts = {}) {
  const existing = getPrepContent(world, entityId);
  if (!existing) {
    throw new Error(`No prep content for entity "${entityId}" in world "${world}" -- generate it first.`);
  }
  const schema = fieldsSchemaForType(existing.entityType);
  if (!(fieldName in schema.shape)) {
    throw new Error(
      `"${fieldName}" is not a valid prep-content field for entity type "${existing.entityType}". ` +
      `Valid fields: ${Object.keys(schema.shape).join(", ")}.`
    );
  }
  const validatedValue = schema.shape[fieldName].parse(newValue);
  const now = opts.now ?? new Date().toISOString();
  const updatedFields = { ...existing.fields, [fieldName]: validatedValue };
  return writeDoc(world, entityId, { ...existing, fields: updatedFields, lastRegeneratedAt: now });
}

export { ConcurrentWriteError };

// =====================================================================
// Task 11.2 — framing + generation LLM calls. Same retry-once-then-typed-
// error / truncation-aware convention as every other outward-facing call in
// this codebase (texture.mjs, writeup-import.mjs, narrate.mjs), via
// llm-call.mjs's shared callModelDetailed. Both calls are grounded in the
// entity's real immediate graph neighborhood (built once per invocation by
// the caller -- see wf-mcp-server/lib/prep-content-ops.mjs task 11.3 -- and
// passed in here as `neighborhoodContext`, never re-fetched redundantly
// across the two calls).
// =====================================================================

export const DEFAULT_PREP_FRAMING_MODEL = "claude-haiku-4-5";
export const DEFAULT_PREP_GENERATION_MODEL = "claude-sonnet-5";

// Mirrors writeup-import.mjs's MAX_FRAMING_ROUNDS precedent, one level down
// to a single entity: the INITIAL framing call counts as round 1; a
// reviewer who doesn't like any of the three angles gets exactly one more
// bounded round (round 2) before being required to just pick one (or write
// a fully custom framing -- review-ui's frontend already offers that "(d)
// none of the above" option for writeup-import's framing screen, reused
// verbatim here rather than inventing a second escape hatch). Unlike
// writeup-import's batch.scope.framingHistory (a batch already exists to
// carry that count), prep content has no persisted object yet at this
// stage -- the round count is carried by the CALLER (the ops/route layer,
// then the frontend's own ephemeral flow state) and passed in explicitly,
// not tracked inside this pure module.
export const MAX_PREP_FRAMING_ROUNDS = 2;

export class PrepFramingProposalError extends Error {
  constructor(message, { attempts, lastError, rawResponse } = {}) {
    super(message);
    this.name = "PrepFramingProposalError";
    this.attempts = attempts;
    this.lastError = lastError;
    this.rawResponse = rawResponse;
  }
}

export class PrepGenerationError extends Error {
  constructor(message, { attempts, lastError, rawResponse } = {}) {
    super(message);
    this.name = "PrepGenerationError";
    this.attempts = attempts;
    this.lastError = lastError;
    this.rawResponse = rawResponse;
  }
}

/** Thrown when a reframe request would exceed MAX_PREP_FRAMING_ROUNDS -- mirrors writeup-import.mjs's FramingRoundLimitError, kept as its own class so a caller can distinguish "this phase's round budget is spent" without inspecting message text. */
export class PrepFramingRoundLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrepFramingRoundLimitError";
  }
}

const FramingItem = z.object({ id: z.enum(["a", "b", "c"]), sentence: z.string().min(1) });
const FramingsResponse = z
  .object({ framings: z.array(FramingItem).length(3) })
  .refine((v) => new Set(v.framings.map((f) => f.id)).size === 3, {
    message: 'framings must have exactly the id set {"a","b","c"}, one each, no duplicates'
  });

// Per-type angle guidance for the framing prompt -- "who this person really
// is" for a person, "what this place's actual role is" for a place, etc.,
// per phase-11-review.md's own DM-requirements wording (item 1).
const FRAMING_ANGLE_GUIDANCE = {
  person: "who this person really is beneath the surface -- their true motivation, a hidden angle, or the role they actually play versus how they first appear",
  place: "what this place's actual role or story is -- what really happens here, what it means to the people who live near it, or what's hidden beneath its surface impression",
  faction: "what this faction is really about beneath its public face -- its true goal, an internal fracture, or what it actually wants from the party",
  object: "what this object's true nature or history really is -- its origin, a hidden property, or why it actually matters",
  event: "what actually happened here beneath the public account -- the truth behind the story people tell, or its real consequences",
  concept: "how this idea actually shows up and matters in play -- a concrete way it surfaces at the table"
};

function fillFramingTemplate(vars) {
  return fillTemplateShared(FRAMING_PROMPT_TEMPLATE, vars);
}
function fillGenerationTemplate(vars) {
  return fillTemplateShared(GENERATION_PROMPT_TEMPLATE, vars);
}
function fillFieldRegenTemplate(vars) {
  return fillTemplateShared(FIELD_REGEN_PROMPT_TEMPLATE, vars);
}

/** Render a buildAdjacencyContext()-shaped {entityLabel, neighborDescriptions} (or a plain array of strings) into prompt text. Accepts either shape so callers can pass narrate.mjs's helper output directly. */
function neighborhoodContextText(neighborhoodContext) {
  const descriptions = Array.isArray(neighborhoodContext)
    ? neighborhoodContext
    : neighborhoodContext?.neighborDescriptions;
  if (!descriptions || !descriptions.length) return "(no known graph connections recorded)";
  return descriptions.join(", ");
}

/**
 * Phase 11 task 11.2: the framing-first "first reaction" call for a single
 * entity, mirroring writeup-import.mjs's proposeFramingsFromWriteup one
 * level down. Cheap by construction (haiku tier, small maxTokens), grounded
 * in the entity's own recorded fields AND its real immediate graph
 * neighborhood -- never the entity's isolated fields alone, per the design
 * doc's explicit requirement.
 *
 * @param {{name:string, type:string, description?:string, summary?:string}} entity
 * @param {object|string[]} neighborhoodContext  buildAdjacencyContext()'s {entityLabel, neighborDescriptions} shape, or a plain string array
 * @param {object} [opts]
 * @param {string} [opts.note]  steering note (used by requestPrepReframing's re-framing round)
 * @param {object} [opts.client] @param {string} [opts.apiKey] @param {string} [opts.model] @param {number} [opts.maxTokens]
 * @returns {Promise<{framings: Array<{id:"a"|"b"|"c", sentence:string}>}>}
 * @throws {PrepFramingProposalError}
 */
export async function proposeFramingsForEntity(entity, neighborhoodContext, opts = {}) {
  if (!entity || !entity.name || !entity.type) {
    throw new Error("proposeFramingsForEntity requires an entity with at least {name, type}.");
  }
  const angleGuidance = FRAMING_ANGLE_GUIDANCE[entity.type];
  if (!angleGuidance) {
    throw new Error(`No framing guidance for entity type "${entity.type}". Known types: ${Object.keys(FRAMING_ANGLE_GUIDANCE).join(", ")}.`);
  }

  const basePrompt = fillFramingTemplate({
    entityName: entity.name,
    entityType: entity.type,
    entityDescription: entity.description || entity.summary || "(no description recorded)",
    neighborhoodContext: neighborhoodContextText(neighborhoodContext),
    gmTruthContext: neighborhoodContext?.gmTruthBlock || "",
    angleGuidance,
    retryNote: opts.note ? `Additional note: ${opts.note}` : ""
  });

  let prompt = basePrompt;
  let lastError;
  let lastRaw;
  let maxTokens = opts.maxTokens ?? 512; // same "three short sentences" sizing as writeup-import's own framing call
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { text: raw, truncated } = await callModelDetailed(prompt, {
      ...opts,
      model: opts.model ?? DEFAULT_PREP_FRAMING_MODEL,
      maxTokens
    });
    lastRaw = raw;

    if (truncated) {
      lastError = new Error(`Model response was truncated at max_tokens=${maxTokens} before it finished.`);
      if (attempt < maxAttempts) { maxTokens *= 2; continue; }
      break;
    }

    try {
      const parsed = parseJsonResponse(raw);
      const validated = FramingsResponse.parse(parsed);
      return { framings: validated.framings };
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        prompt =
          basePrompt +
          `\n\nYour previous response failed validation with this error -- fix it and respond with ONLY the ` +
          `corrected JSON object, no prose:\n${err.message}\n\nYour previous response was:\n${raw}`;
      }
    }
  }

  throw new PrepFramingProposalError(
    `Prep-content framing proposal for "${entity.name}" failed validation twice: ${lastError?.message}`,
    { attempts: maxAttempts, lastError, rawResponse: lastRaw }
  );
}

/**
 * A reviewer-rejected framing's bounded re-framing round -- mirrors
 * writeup-import.mjs's requestReframing. Throws PrepFramingRoundLimitError
 * BEFORE spending an API call if the bounded budget is already used.
 *
 * @param {object} entity
 * @param {object|string[]} neighborhoodContext
 * @param {number} priorRoundCount  how many framing rounds have already happened for this "develop this node" session (1 after the initial proposeFramingsForEntity call)
 * @param {object} [opts]  forwarded to proposeFramingsForEntity
 * @throws {PrepFramingRoundLimitError}
 */
export async function requestPrepReframing(entity, neighborhoodContext, priorRoundCount, opts = {}) {
  if (priorRoundCount >= MAX_PREP_FRAMING_ROUNDS) {
    throw new PrepFramingRoundLimitError(
      `Already used the one bounded re-framing round for "${entity.name}" (priorRoundCount=${priorRoundCount}, max ` +
      `${MAX_PREP_FRAMING_ROUNDS}) -- pick one of the current framings (or write a fully custom one) instead of ` +
      `requesting another round.`
    );
  }
  return proposeFramingsForEntity(entity, neighborhoodContext, {
    ...opts,
    note:
      "The reviewer didn't like the previous three framings. Propose three genuinely different interpretive " +
      "readings than before -- do not just restate the same three ideas in different words."
  });
}

/**
 * Turn a picked/blended framing selection into plain steering text, the
 * same {primary:{id,sentence}, blend?} shape writeup-import.mjs's
 * composeFramingNote accepts (reused verbatim by review-ui's frontend, see
 * task 11.5) -- kept as its own function (not a reuse of
 * composeFramingNote) because the wording is domain-specific ("steer the
 * generated content" vs. "steer the extraction").
 *
 * @param {{primary:{id:string,sentence:string}, blend?:string}} selection
 * @returns {string}
 */
export function composePrepFramingNote(selection) {
  if (!selection || typeof selection !== "object") {
    throw new Error("composePrepFramingNote requires a selection object.");
  }
  const { primary, blend } = selection;
  if (!primary || typeof primary.sentence !== "string" || !primary.sentence.trim()) {
    throw new Error("composePrepFramingNote requires selection.primary.{id,sentence}.");
  }
  let note = `The reviewer's chosen framing for developing this entity: "${primary.sentence.trim()}". Steer the generated content toward this reading.`;
  if (typeof blend === "string" && blend.trim()) {
    note += ` Additionally, blend in: ${blend.trim()}`;
  }
  return note;
}

/**
 * Task 11.2's generation call: the fuller, type-specific structured content
 * call, steered by the framing note composed above. Validates the model's
 * output against the entity type's expected field shape before trusting it.
 *
 * @param {object} entity
 * @param {object|string[]} neighborhoodContext
 * @param {string} framingNote  composePrepFramingNote()'s output
 * @param {object} [opts]
 * @returns {Promise<{fields:object}>}
 * @throws {PrepGenerationError}
 */
export async function generatePrepContent(entity, neighborhoodContext, framingNote, opts = {}) {
  if (!entity || !entity.name || !entity.type) {
    throw new Error("generatePrepContent requires an entity with at least {name, type}.");
  }
  const schema = fieldsSchemaForType(entity.type);
  const fieldsSpec = fieldSpecTextForType(entity.type);

  const basePrompt = fillGenerationTemplate({
    entityName: entity.name,
    entityType: entity.type,
    entityDescription: entity.description || entity.summary || "(no description recorded)",
    neighborhoodContext: neighborhoodContextText(neighborhoodContext),
    gmTruthContext: neighborhoodContext?.gmTruthBlock || "",
    framingNote: framingNote || "(no specific framing chosen -- use your own best judgment)",
    fieldsSpec,
    retryNote: ""
  });

  let prompt = basePrompt;
  let lastError;
  let lastRaw;
  let maxTokens = opts.maxTokens ?? 2048; // a full multi-field structured block, closer to texture.mjs's sizing than the framing call's
  const maxAttempts = 2;
  const responseSchema = z.object({ fields: schema }).strict();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { text: raw, truncated } = await callModelDetailed(prompt, {
      ...opts,
      model: opts.model ?? DEFAULT_PREP_GENERATION_MODEL,
      maxTokens
    });
    lastRaw = raw;

    if (truncated) {
      lastError = new Error(`Model response was truncated at max_tokens=${maxTokens} before it finished.`);
      if (attempt < maxAttempts) { maxTokens *= 2; continue; }
      break;
    }

    try {
      const parsed = parseJsonResponse(raw);
      const validated = responseSchema.parse(parsed);
      return { fields: validated.fields };
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        prompt =
          basePrompt +
          `\n\nYour previous response failed validation with this error -- fix it and respond with ONLY the ` +
          `corrected JSON object, no prose:\n${err.message}\n\nYour previous response was:\n${raw}`;
      }
    }
  }

  throw new PrepGenerationError(
    `Prep-content generation for "${entity.name}" (${entity.type}) failed validation twice: ${lastError?.message}`,
    { attempts: maxAttempts, lastError, rawResponse: lastRaw }
  );
}

/**
 * The living-doc field-granular regenerate call (task 11.1/11.2's
 * "field-granular living-doc regeneration"): asks the model to redo ONLY
 * the named field, grounded in the entity's other CURRENT fields (so the
 * new value stays consistent) plus the same graph context. Returns just the
 * new field value, validated against that one field's own zod schema --
 * the caller (updatePrepField) is responsible for actually persisting it,
 * so this function never touches disk.
 *
 * @param {object} entity
 * @param {object|string[]} neighborhoodContext
 * @param {object} currentFields  the entity's existing PrepContent.fields, for consistency context
 * @param {string} fieldName
 * @param {string} [note]  optional GM steering note
 * @param {object} [opts]
 * @returns {Promise<*>} the new, validated value for `fieldName` only
 * @throws {PrepGenerationError}
 */
export async function regeneratePrepField(entity, neighborhoodContext, currentFields, fieldName, note, opts = {}) {
  if (!entity || !entity.name || !entity.type) {
    throw new Error("regeneratePrepField requires an entity with at least {name, type}.");
  }
  const schema = fieldsSchemaForType(entity.type);
  if (!(fieldName in schema.shape)) {
    throw new Error(
      `"${fieldName}" is not a valid prep-content field for entity type "${entity.type}". ` +
      `Valid fields: ${Object.keys(schema.shape).join(", ")}.`
    );
  }
  const fieldSchema = schema.shape[fieldName];

  const basePrompt = fillFieldRegenTemplate({
    entityName: entity.name,
    entityType: entity.type,
    neighborhoodContext: neighborhoodContextText(neighborhoodContext),
    gmTruthContext: neighborhoodContext?.gmTruthBlock || "",
    currentFieldsJson: JSON.stringify(currentFields ?? {}, null, 2),
    fieldName,
    fieldDescription: fieldDescription(entity.type, fieldName),
    retryNote: note ? `Additional guidance from the GM -- follow it: ${note}` : "(none)"
  });

  let prompt = basePrompt;
  let lastError;
  let lastRaw;
  let maxTokens = opts.maxTokens ?? 1024;
  const maxAttempts = 2;
  const responseSchema = z.object({ value: fieldSchema }).strict();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { text: raw, truncated } = await callModelDetailed(prompt, {
      ...opts,
      model: opts.model ?? DEFAULT_PREP_GENERATION_MODEL,
      maxTokens
    });
    lastRaw = raw;

    if (truncated) {
      lastError = new Error(`Model response was truncated at max_tokens=${maxTokens} before it finished.`);
      if (attempt < maxAttempts) { maxTokens *= 2; continue; }
      break;
    }

    try {
      const parsed = parseJsonResponse(raw);
      const validated = responseSchema.parse(parsed);
      return validated.value;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        prompt =
          basePrompt +
          `\n\nYour previous response failed validation with this error -- fix it and respond with ONLY the ` +
          `corrected JSON object, no prose:\n${err.message}\n\nYour previous response was:\n${raw}`;
      }
    }
  }

  throw new PrepGenerationError(
    `Prep-content field regeneration for "${entity.name}".${fieldName} failed validation twice: ${lastError?.message}`,
    { attempts: maxAttempts, lastError, rawResponse: lastRaw }
  );
}
