#!/usr/bin/env node
/**
 * Review-UI HTTP server — Phase 6 task 6.1.
 *
 * A thin local HTTP layer over the mutation engine's library modules,
 * importing them DIRECTLY (no MCP round-trip, no requirement that a Claude
 * Code session be open) — same architectural point Phase 2's headless-apply
 * made: reviewing shouldn't require a live chat session. Every route below
 * calls straight into mutation-engine/*, time-skip/*, or
 * wf-mcp-server/lib/mutation-ops.mjs's shared review-workflow operations
 * (see that module's own doc comment — it's the exact code wf-mcp-server's
 * wf_accept/wf_reject/wf_regenerate/wf_sync_to_foundry/wf_rollback_batch/
 * wf_review_batch tools call, extracted so this server reuses it verbatim
 * instead of re-deriving the same logic against a second, drifting copy —
 * per gm-tools-conventions' "front-ends are thin wrappers, never logic
 * duplicators"). No independent business logic lives in this file beyond
 * request parsing, routing, and status-code mapping.
 *
 * Dependency choice: bare `node:http`, no framework. This project's
 * established convention is "no frontend framework, no build step" for
 * anything UI-facing, and the route surface here (a dozen or so JSON
 * endpoints plus static file serving) is small and uniform enough that a
 * hand-rolled router (~40 lines, see `route()`/`serveStatic()` below) is
 * less machinery than adding a new runtime dependency for it — matching
 * gm-tools-conventions' "keep the dependency footprint proportionate"
 * instruction and its explicit "flag a new dependency rather than adding it
 * silently" rule (this note IS that flag: a framework was considered and
 * deliberately not used).
 *
 * review-ui/package.json declares NO dependencies at all: every import below
 * is either a Node built-in or a relative path into mutation-engine/,
 * time-skip/, graph-import/, or wf-mcp-server/lib/ — none of which this
 * server needs its own node_modules for for (their own transitive deps,
 * zod/@anthropic-ai/sdk, resolve from GM_Tools/'s root node_modules via
 * Node's normal upward node_modules search, the same way wf-mcp-server's own
 * mutation-engine/* imports already do).
 *
 * SECURITY: this server has NO authentication layer of its own -- every
 * route below is reachable by anyone who can reach the port (this project's
 * own documented remote-access recommendation is a mesh VPN like Tailscale,
 * specifically because this file has nothing to authenticate a request
 * with). Given that, every route calls the shared resolveDir() with NO
 * argument, deliberately never forwarding a client-supplied `dataDir` from
 * `body`/the query string into it, even though wf-mcp-server/lib/resolve.mjs's
 * resolveDir() function itself still accepts an explicit override (needed
 * there for the MCP tool surface, which is local/trusted, spawned directly
 * by a Claude Code session over stdio, never network-facing). Found via a
 * real security review: resolveDir(explicit) and resolveWorld(world) both
 * used to pass an unvalidated client string straight into join()-based file
 * paths across all seven of this project's flat-JSON stores plus the
 * snapshot/mutations-bridge paths -- node:path's join() does not stop `..`
 * traversal, so an unauthenticated request with a crafted `dataDir` was a
 * real arbitrary-file-read/write primitive scoped to whatever this Node
 * process's OS user can touch, not just "read/write your campaign data."
 * Fixed by removing the untrusted input from this file entirely (dataDir
 * always resolves from WF_DATA_DIR/OS-default here, never from a request)
 * rather than trying to validate an arbitrary path string -- a validator
 * is one more thing that can itself have a bug (symlinks, encoding,
 * normalization edge cases); not accepting the input at all has no such
 * failure mode. `world` is separately hardened at its source in
 * resolve.mjs's own resolveWorld() (format-restricted, not removed --
 * unlike dataDir, a world id is a genuinely meaningful client-supplied
 * value here, e.g. switching worlds from the UI's own dropdown).
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { listWorldDirs } from "../wf-mcp-server/lib/data-dir.mjs";

// W6a: the server-side world-id floor (POST /api/worlds' own long-standing
// rule, now also the source of GET /api/worlds' per-dir `attachable` flag).
const WORLD_ID_RE = /^[a-zA-Z0-9_-]+$/;
import { loadSnapshot, snapshotFilePath } from "../wf-mcp-server/lib/snapshot.mjs";
import { resolveWorld, resolveDir } from "../wf-mcp-server/lib/resolve.mjs";
import { findEntity, neighborhood } from "../wf-mcp-server/lib/graph.mjs";
import { bootstrapSnapshot, applyHeadless } from "../graph-import/headless-apply.mjs";

import { loadBatch, listBatches } from "../mutation-engine/review-state.mjs";
import { summarizeBatch, renderHeadline } from "../mutation-engine/grain.mjs";
import { findUnreviewedEntities, markHumanReviewed, DEFAULT_MAX_AGE_DAYS, DEFAULT_MAX_UNREVIEWED_ACCEPTS } from "../mutation-engine/human-review.mjs";
import { listPendingEntities, readAvailablePending } from "../mutation-engine/pending-ledger.mjs";
import { resolvePending } from "../time-skip/resolve-pending.mjs";
import { getUserSettings, setRubberDuckMode } from "../mutation-engine/user-settings.mjs";

import {
  flaggedEntityIdSet,
  reviewGrainOp,
  acceptOp,
  acceptMutationIds,
  rejectMutationIds,
  regenerateOp,
  narrateOp,
  syncOp,
  rollbackOp,
  proposeFromWriteupOp,
  selectFramingForNewBatch,
  selectFramingForExistingBatch,
  rejectWithLoopOp,
  narrateEntityOp,
  narrateEntityStandaloneOp,
  getEntityNarrationOp,
  getEntityNarrationHistoryOp,
  scanMentionsOp,
  patchPendingMutationDataOp,
  redirectMentionScanRowToExistingOp,
  nearMatchesForBatch,
  triageForBatch,
  edgeDisplayForBatch,
  worldNameCollisionsForBatch,
  convertCreateToUpdateOfExistingOp,
  revertMutationsToPending
} from "../wf-mcp-server/lib/mutation-ops.mjs";

// Phase 12 tasks 12.3/12.4/12.6 -- manual node/edge create/edit/delete,
// the single-slot "Undo Last Manual Edit" mechanism, and narration reset.
// Deliberately NOT exposed as MCP tools -- see manual-edit-ops.mjs's own
// top-of-file doc comment for why (manual edits bypass the review gate by
// design; an LLM-driven MCP call reaching this same unreviewed write path
// would undermine the no-silent-auto-write invariant this whole project is
// built around).
import {
  addNodeOp,
  addEdgeOp,
  editNodeOp,
  editEdgeOp,
  deleteNodeOp,
  deleteEdgeOp,
  reparentNode,
  anchorMembership,
  removeNodeReparentUp,
  resetEntityNarrationOp,
  undoLastManualEditOp,
  getManualUndoStatusOp,
  getManualEditSyncStatusOp
} from "../wf-mcp-server/lib/manual-edit-ops.mjs";

// Phase 11 -- per-node content generation ("develop this node"). A
// deliberately separate operations module from mutation-ops.mjs above (see
// mutation-engine/prep-content.mjs's own doc comment) -- none of these
// routes take a batchId, so this surface is not reachable from Batch
// Review even in principle.
import {
  proposePrepFramingsOp,
  reframePrepFramingsOp,
  generatePrepContentOp,
  getPrepContentOp,
  acceptPrepContentOp,
  discardPrepContentOp,
  regeneratePrepFieldOp,
  markPrepContentStaleOp
} from "../wf-mcp-server/lib/prep-content-ops.mjs";
// Narrative-state layer ("Layer 2") — reveal/truth/stance/clock sidecar,
// direct-write (no review batch; see narrative-state-ops.mjs's header).
import {
  getNarrativeStateOp,
  setNarrativeStateOp,
  tickClockOp,
  listNarrativeStateOp
} from "../wf-mcp-server/lib/narrative-state-ops.mjs";
// (fieldsSchemaForType/`z` were only needed by the offline prep-content
// client, now moved to wf-mcp-server/lib/offline-clients.mjs -- see the
// import block above.)

// Phase 16 -- Session Planner engine (task 16.6). Thin wrappers only, same
// convention as every other route in this file: resolveWorld/resolveDir()
// with NO client-supplied dataDir override anywhere below.
import { createScene, forkScene, getScene, listScenesForWorld, listScenesByRecency, renameScene, updateScene, deleteScene, touchScene } from "../session-planner/scenes.mjs";
// Phase 30 task 30.1 -- the World inspector's "appears in" reverse lookup.
// A separate module from scenes.mjs itself (avoids a circular import --
// scene-lookup.mjs's own header comment explains why).
import { scenesForEntity, removeEntityFromAllScenes } from "../session-planner/scene-lookup.mjs";
import { buildSessionBrief } from "../session-planner/brief.mjs";
import { captureNote, runBatchIntake } from "../session-planner/session-notes.mjs";

// Phase 18 -- Encounter Guidance engine (task 18.7). Thin wrappers only,
// same convention as every other route in this file: resolveWorld()/
// resolveDir() with NO client-supplied dataDir override anywhere below.
// Bestiary routes are deliberately NEVER world-scoped (bestiary-store.mjs's
// own per-user/library-wide storage decision, task 18.1) -- party-roster and
// encounter-suggest ARE world-scoped, same as session-planner's own routes
// above.
import { buildAdjacencyContext, DEFAULT_ENTITY_NARRATE_DEPTH } from "../mutation-engine/narrate.mjs";
import { proposeBestiaryEntryFromText, proposeBestiaryEntryFromPdf } from "../combat-planning/bestiary-ingest.mjs";
import {
  saveBestiaryEntry,
  getBestiaryEntry,
  listBestiaryEntries,
  acceptBestiaryEntry,
  discardBestiaryEntry,
  updateBestiaryEntryNote,
  updateBestiaryEntryRating,
  promoteBestiaryEntryToGraph,
  createReskinnedBestiaryEntry
} from "../combat-planning/bestiary-store.mjs";
// Phase 37.6b -- "Wear it as something else" (see the module's own doc
// comment for the full grounding/offline-degrade story).
import { suggestReskins } from "../combat-planning/reskin-suggest.mjs";
// Friction Wave 1 W4a -- the read-only Plutonium source LAYER (bundled
// 5etools bestiary data indexed from <dataDir>/modules/plutonium/, never
// mixed into the curated bestiary store). See that module's own header.
import { loadPlutoniumIndex, searchPlutoniumIndex, plutoniumFacets, findPlutoniumCreature } from "../combat-planning/plutonium-source.mjs";
import { proposePartyMemberFromText, proposePartyMemberFromPdf } from "../combat-planning/party-roster-ingest.mjs";
import {
  savePartyMember,
  getPartyMember,
  listPartyMembers,
  updatePartyMemberPassive,
  updatePartyMemberConditions
} from "../combat-planning/party-roster-store.mjs";
// Phase 35 task 35.1, §1/§4/§8 -- item store (Reliquary) + the shared tags
// helper API. Thin route wrappers only, per gm-tools-conventions.
import { listItems, getItem, saveItem, acceptItem, discardItem, addItemTag, removeItemTag, promoteItemToGraph } from "../combat-planning/item-store.mjs";
// Phase 35 task 35.1, §2/§8 -- stagecraft asset store (map/splash/music).
import {
  listStagecraftAssets,
  getStagecraftAsset,
  saveStagecraftAsset,
  acceptStagecraftAsset,
  discardStagecraftAsset,
  addStagecraftTag,
  removeStagecraftTag,
  // Friction Wave 1 W3a -- the src edit route's backing patch.
  updateStagecraftAssetSrc
} from "../session-planner/stagecraft-store.mjs";
// Phase 35 task 35.1, §3/§8 -- token index (read-only route).
import { listTokens } from "../session-planner/token-store.mjs";
// Phase 35 task 35.1, §7/§8 -- shared scene tray store, roster/budget
// bookkeeping only (the creature-drop "create/reuse a stat-carrying scene
// element" composition lives at THIS file's own route handler below, per
// §7's own explicit instruction).
import { getSceneTray, addToSceneTray, removeFromSceneTray, setSceneTrayXpBudget, listSceneTrayRecordsForWorld } from "../session-planner/scene-tray.mjs";
import { proposeThematicTags } from "../combat-planning/thematic-filter.mjs";
import { suggestEncounter, scoreCombination } from "../combat-planning/encounter-heuristic.mjs";
// Phase 32 task 32.2 -- Foundry actor PULL ingest (bestiary + party roster,
// review-gated). Shared verbatim with wf-mcp-server/index.mjs's
// wf_pull_foundry_actors tool -- see that module's own header comment.
import { pullFoundryActorsToStores } from "../wf-mcp-server/lib/foundry-pull-ops.mjs";
// Phase 32 task 32.3 -- the thin PUSH slice (a GM_Tools scene -> a Foundry
// Scene seeded with a map, via the ops channel). Sibling module to
// foundry-pull-ops.mjs above -- see its own header comment.
// Phase 36 task 36.2 -- `flushDirtyStagedScenes`, the quiet-push flush
// engine (same file, extended -- see that module's own header note).
import { pushSceneToFoundry, flushDirtyStagedScenes } from "../wf-mcp-server/lib/foundry-push-ops.mjs";
// Phase 38 task 38.2, §4 -- import-on-accept (a compendiumRef Stagecraft
// browse row's accept composes `import_compendium_scene` through the SAME
// ops channel, asynchronous like a staged push). Sibling module to
// foundry-push-ops.mjs -- see its own header comment.
import { importCompendiumSceneOnAccept, reconcilePendingCompendiumImports } from "../wf-mcp-server/lib/stagecraft-import-ops.mjs";

// Phase 34 task 34.1 -- Connection-Menu backend glue: connection-state
// derivation + sync-now (foundry-connection.mjs composes readFoundryIndex
// with the EXISTING pullFoundryActorsToStores above, no second pull path),
// the per-world app-settings store, and the World Anvil URL lore-intake
// route (composes with the EXISTING importWriteup pipeline, same shape as
// /api/writeup-propose below).
import { deriveConnectionState, syncNow } from "../wf-mcp-server/lib/foundry-connection.mjs";
import { getSettings as getAppSettings, patchSettings as patchAppSettings } from "../session-planner/app-settings.mjs";
import { importFromWorldAnvil } from "../wf-mcp-server/lib/worldanvil-intake.mjs";

// Phase 37 task 37.1 -- Chronicle stores + the run-composition route. Thin
// wrappers only, same convention as every other route in this file:
// resolveWorld()/resolveDir() with NO client-supplied dataDir override
// anywhere below. orchestrateBatch is the SAME resumable orchestrator every
// other propose/time-skip path already uses -- POST /api/chronicle/run
// composes it, never forks a second one.
import { getWorldClock, advanceWorldClock } from "../session-planner/world-clock.mjs";
import { getFortune, setFortune } from "../session-planner/fortune-track.mjs";
import { recordChronicleRun, getChronicleRun } from "../session-planner/chronicle-run.mjs";
// MCP wave -- extracted so wf-mcp-server/index.mjs's wf_chronicle_run/
// wf_queue_intent/wf_list_chronicle_log/wf_list_pending_intents tools reuse
// this EXACT composition instead of a second, drifting copy. See that
// module's own header comment.
import {
  firstLineTruncated,
  resolveOrCreateIntentEntity,
  pendingEntitiesPayload,
  chronicleLogPayload,
  runChronicleOp,
  queueIntentOp
} from "../wf-mcp-server/lib/chronicle-ops.mjs";
// MCP wave -- extracted so wf-mcp-server/index.mjs's LLM-backed tools share
// the SAME keyless-safety degrade this file's routes have always had. See
// that module's own header comment.
// MCP wave -- extracted so wf-mcp-server/index.mjs's wf_tray_drop tool
// reuses this EXACT composition instead of a second, drifting copy.
import { sceneTrayDropOp } from "../wf-mcp-server/lib/planner-ops.mjs";
import {
  offlineOpts,
  isOffline,
  offlineTextureClient,
  offlineDevelopDescriptionClient,
  offlineReskinSuggestClient,
  offlineWriteupClient,
  offlineAssistPrepClient,
  offlineBestiaryIngestClient,
  offlinePartyRosterIngestClient,
  offlineThematicFilterClient,
  offlineQuickGenClient,
  offlineNarrateClient,
  offlineScanMentionsClient,
  offlinePrepContentClient
} from "../wf-mcp-server/lib/offline-clients.mjs";

// Phase 22 (task 22.7) -- Scene Engine routes. Thin wrappers only, same
// convention as every other route in this file: resolveWorld()/resolveDir()
// with NO client-supplied dataDir override anywhere below. getScene is
// already imported above (Phase 16's session-planner import block) and
// reused here unmodified.
import { createTransitEntity } from "../session-planner/transit-entity.mjs";
import {
  startSceneUndoSession,
  listSceneUndoActions,
  recordSceneUndoAction,
  undoLastSceneAction,
  undoAllSceneActions,
  clearSceneUndoSession
} from "../mutation-engine/scene-undo.mjs";

// Phase 26 task 26.1 -- Plan store. Thin wrappers only, same convention as
// every other route in this file: resolveWorld() with NO client-supplied
// dataDir override anywhere below (the store never touches the graph
// snapshot at all).
import { createPlan, getPlan, listPlansForWorld, addSceneToPlan, removeSceneFromPlan, reorderPlanScenes, deletePlan, plansContainingScene, renamePlan } from "../session-planner/plans.mjs";

// Phase 26 task 26.9, §26.E / Phase 28 task 28.1 -- post-session graph
// update. Thin composition only: proposeUpdatesForPlan/proposeUpdatesForScene
// (session-planner/plan-updates.mjs) assemble a Plan's/Scene's own pending
// notes then delegate straight to the EXISTING, completely unmodified
// importWriteup -- no logic duplicated here.
import { proposeUpdatesForPlan, proposeUpdatesForScene } from "../session-planner/plan-updates.mjs";

// Phase 28 task 28.1 -- per-scene ordered elements + per-scene narration.
// Thin wrappers only, same convention as every other route in this file:
// resolveWorld()/resolveDir() with NO client-supplied dataDir override
// anywhere below. promoteElement is the one op here that touches the live
// graph (a direct manual edit, same surface as POST /api/graph/nodes -- see
// scene-elements.mjs's own header comment for why this is NOT a
// no-silent-auto-write violation), so its route resolves `dir` too.
import { createElement, listElementsForScene, updateElement, removeElement, promoteElement, demoteElement, attachExistingNodeAsElement, reorderElements, inferRunLayoutForScene } from "../session-planner/scene-elements.mjs";
import { createHash } from "node:crypto";
import { seedRunSkeleton } from "../session-planner/run-skeleton.mjs";
import { listBriefingCards, createBriefingCard, updateBriefingCard, removeBriefingCard, reorderBriefingCards } from "../session-planner/briefing-store.mjs";
import { getCurrentSceneNarration, saveSceneNarration } from "../session-planner/scene-narration.mjs";

// Phase 28 task 28.4, §E -- the inline `✦` functional-prep assist. Thin
// wrapper over the pure, Foundry-free assistScenePrep (client injection stays
// in-process only, same established HTTP-round-trip limitation as
// propose-updates / writeup-propose -- a live client cannot survive fetch()).
// It returns validated element DRAFTS; the frontend persists them through the
// ordinary scene-elements create/update routes (a scene-local authoring aid,
// NOT a graph write -- see element-assist.mjs's header).
import { assistScenePrep } from "../session-planner/element-assist.mjs";

// Phase 37.6 task 3 -- the "✦ develop this place" affordance beside BOTH
// place-description editors (world-view.js's detail pane, session-planner-
// view.js's buildPlaceDescriptionBlock). Same DI-seam/never-writes contract
// as assistScenePrep above -- returns a suggestion, the frontend merges it
// through the ordinary editNodeOp route (POST /api/graph/nodes/:entityId)
// only if the GM explicitly accepts it.
import { developDescription } from "../mutation-engine/develop-description.mjs";

// Phase 26 task 26.10, §26.F -- "Drop this into Foundry". Lives directly
// under review-ui/ (not wf-mcp-server/lib/) -- see foundry-push.mjs's own
// header for why (playwright's runtime dependency only resolves from
// review-ui's own node_modules).
import { pushEntityToFoundry } from "./foundry-push.mjs";
import { developScene } from "../mutation-engine/scene-develop.mjs";
import { quickGenerate, groundPromptWithAnchor } from "../mutation-engine/quick-gen.mjs";

// Phase 22 ADDENDUM -- "Add Encounter" persistence (plans/phase-21-review.md
// §6: equal-weight sibling of "Add Event"/session-notes.mjs's captureNote).
// Thin wrapper only, same convention as every route in this file/block.
import {
  saveEncounter,
  listEncountersForScene,
  removeSavedEncounter,
  listEncountersForWorld,
  attachEncounterToScene,
  detachEncounterFromScene
} from "../combat-planning/saved-encounter.mjs";
// Only used to distinguish "the Anthropic API itself failed" (502, an
// upstream/infra problem) from "this codebase's own library modules threw a
// deliberate validation error" (400) in statusForError below -- see that
// function's own Phase 18 branch.
import { AnthropicError } from "@anthropic-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

export const DEFAULT_PORT = 8787;

// --- small request/response helpers -----------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Map a thrown error to an HTTP status code. Every route handler funnels its
 * errors through here rather than letting an unhandled exception 500 the
 * process — per task 6.1's explicit requirement that a narration request
 * against a non-fully-accepted batch "must 4xx cleanly ... not a generic
 * 500", generalized to every route (the same care is owed everywhere, not
 * just narrate).
 */
function statusForError(err) {
  if (err.name === "NarrationGateError") return 409; // batch not fully accepted -- a real conflict with narrate's precondition, not a bad request shape
  if (err.name === "ConcurrentWriteError") return 409; // another writer holds the lock right now -- retryable
  if (err.name === "WriteupImportRegenerateScopeError") return 400;
  // W2c: the extraction outgrew its token budget -- a payload-too-dense
  // condition the CALLER fixes (split the writeup / raise the env budget),
  // carrying its own actionable guidance. 422, not 500: the server did its
  // job; the request's content couldn't be processed within the budget.
  if (err.name === "WriteupTruncatedError") return 422;
  // Phase 8: the bounded re-framing round is already spent -- a real
  // conflict with the reject-loop's own precondition (needs a note now),
  // not a malformed request.
  if (err.name === "FramingRoundLimitError") return 409;
  // Phase 11: same conflict, one level down (a single entity's prep-content
  // framing round, not a whole writeup-import batch).
  if (err.name === "PrepFramingRoundLimitError") return 409;
  if (err.name === "NoNarratableBatchError") return 404; // task 14.7: no accepted mutation exists yet for this entity
  if (/already exists/i.test(err.message ?? "")) return 409; // task 14.2: creating a world id that's already taken
  if (/no (batch|region|entity|world|snapshot) found/i.test(err.message ?? "")) return 404;
  if (/not found/i.test(err.message ?? "")) return 404;
  // Phase 18 task 18.7: an LLM-touching route (bestiary/party-roster ingest,
  // encounter-suggest's thematic filter) that failed because the Anthropic
  // API itself couldn't be reached/authenticated is a genuine upstream/infra
  // failure, not a caller-facing validation problem -- must NOT collapse
  // into the same 400 every deliberate validation throw uses, or a route
  // whose world/dataDir handling is completely correct would look
  // indistinguishable from one that rejected the request outright (exactly
  // the distinction review-ui/test/combat-planning-routes.test.mjs's own
  // dataDir-never-honored test on encounter-suggest checks for). Caught two
  // ways: a real AnthropicError instance (an actual failed/rejected HTTP
  // call), or the SDK's own pre-request "Could not resolve authentication
  // method" check (a plain Error, not an AnthropicError subclass, thrown
  // when no API key is configured at all -- as will be the case in this
  // project's own deterministic test runs, which never set one).
  if (err instanceof AnthropicError || /Could not resolve authentication method/i.test(err.message ?? "")) return 502;
  return 400; // everything else thrown by this codebase's library modules is a deliberate, caller-facing validation error, not a crash
}

function sendError(res, err) {
  const status = statusForError(err);
  sendJson(res, status, { error: err.message, name: err.name ?? "Error", ...(err.notAccepted ? { notAccepted: err.notAccepted } : {}) });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(new Error(`Invalid JSON request body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  // Phase 17 task 17.0/17.3: review-ui/public/debounced-save.mjs is a real
  // ES module imported by session-planner-view.js -- without this, the
  // browser fetches it, gets served as application/octet-stream (the
  // extname()-miss fallback below), and refuses to load it as a module
  // script (strict MIME-type enforcement per the HTML spec), silently
  // breaking the ENTIRE app.js module graph (every other view along with
  // it) since app.js -> session-planner-view.js -> debounced-save.mjs is one
  // static import chain. Found by actually driving this in a browser, not
  // from reading the JS alone -- every pre-existing e2e test started failing
  // too, which is what surfaced it.
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  // Phase 29 task 29.0: self-hosted design-system fonts
  // (review-ui/public/fonts/*.woff2) -- without this they fall back to
  // application/octet-stream (the extname()-miss default below), which most
  // browsers tolerate for @font-face but isn't the correct MIME type.
  ".woff2": "font/woff2",
  // Run layout (2026-08-26): map images streamed by the stagecraft image route.
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".gif": "image/gif"
};

function serveStatic(res, filePath) {
  if (!existsSync(filePath)) {
    sendJson(res, 404, { error: `Not found: ${filePath}` });
    return;
  }
  const type = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
  const body = readFileSync(filePath);
  // No-cache for static assets: this is a single-user LOCAL dev tool served
  // straight from disk, and the frontend is iterated on constantly (the
  // Designer -> port/wire -> reload loop). Aggressive browser caching meant a
  // plain reload kept showing a stale app.js/style.css bundle -- every change
  // needed a manual hard-refresh. `no-store` guarantees a fresh fetch each
  // load; the refetch cost is negligible over localhost.
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    "Cache-Control": "no-store, must-revalidate"
  });
  res.end(body);
}

// --- domain helpers (thin wiring only, no new business logic) --------------

/**
 * Phase 30 task 30.1 (the OPTIONAL-but-preferred half): bumps a scene's own
 * `updatedAt` after a route successfully writes to that scene's CONTENT (an
 * element create/update/delete/reorder/promote/demote/from-graph, or a
 * narration save) -- the World scene-tray's "most recently touched" signal
 * needs to react to content edits, not just direct scene-record patches
 * (updateScene/renameScene already stamp themselves). Deliberately done
 * HERE, at the route layer, rather than inside scene-elements.mjs/
 * scene-narration.mjs themselves -- those stores stay pure and don't import
 * scenes.mjs's touchScene (cross-store coupling the task's own instructions
 * called out as worth avoiding if it gets messy; it would here, since
 * neither store currently imports scenes.mjs except scene-elements.mjs's
 * existing narrow `getScene` use for promoteElement). Best-effort: a
 * sceneId these ops were never guaranteed to validate (e.g. createElement
 * doesn't call getScene) could in principle be stale/unknown, in which case
 * touchScene's own "No scene found" throw is swallowed here -- the write
 * that already succeeded must never be reported as failed just because the
 * recency bump couldn't find a scene to stamp.
 */
// Run layout (2026-08-26) -- the elements list carries a tiny read-only
// `bestiary` summary for any element linked via fields.bestiaryEntryId, so
// the Run spread can print AC/HP/CR without the client learning the
// bestiary store. Missing/unknown entries degrade to no summary, never an
// error (a dangling link is a prep problem, not a render failure).
function withBestiarySummary(element) {
  const id = element?.fields?.bestiaryEntryId;
  if (!id) return element;
  try {
    const entry = getBestiaryEntry(id);
    const rf = entry.rawFields || {};
    return { ...element, bestiary: { id, name: entry.name ?? rf.name ?? null, ac: rf.ac ?? null, hp: rf.hp ?? null, cr: rf.challengeRating ?? rf.cr ?? null, note: entry.note ?? null } };
  } catch {
    return element;
  }
}

function touchSceneSafely(w, sceneId) {
  try {
    const scene = touchScene(w, sceneId);
    maybeScheduleFlush(w, scene); // Phase 36 task 36.2, §3 -- the trigger choke point
  } catch {
    // Best-effort only -- see this function's own doc comment.
  }
}

/**
 * Phase 36 task 36.2, §5 -- the quiet-push flush engine's FIRST trigger:
 * staged-scene mutation, debounced ONE TICK (a single `setTimeout(...,0)`
 * macrotask, per world). `touchSceneSafely` above is the single choke point
 * that fires this for every tray/element/narration write; the `/stage`
 * route (§2) and every direct `updateScene`/`renameScene` call on a scene
 * RECORD call `maybeScheduleFlush` themselves right after their own write
 * succeeds. Every trigger that fires within the same macrotask window before
 * the scheduled flush actually runs coalesces into that ONE flush call,
 * which re-reads "which scenes are dirty right now" fresh at fire time (via
 * `flushDirtyStagedScenes`'s own `listScenesByRecency` scan) -- NOT a
 * snapshot taken at schedule time. `flushScheduled` is cleared BEFORE
 * `flushDirtyStagedScenes` runs (not after), so a mutation arriving WHILE a
 * flush is actively in flight (e.g. blocked on the ops-channel poll)
 * schedules a genuine follow-up flush rather than being silently absorbed
 * into the in-flight one.
 */
const flushScheduled = new Set();
function scheduleFlush(world, delayMs = 0) {
  if (flushScheduled.has(world)) return;
  flushScheduled.add(world);
  setTimeout(() => {
    flushScheduled.delete(world);
    let dir;
    try {
      dir = resolveDir();
    } catch (err) {
      console.error(`[foundry-flush] world "${world}": could not resolve the Foundry data dir -- ${err.message}`);
      return;
    }
    flushDirtyStagedScenes(dir, world).then((outcome) => {
      // Orchestrator reconcile (36.3 live-smoke finding): a queued outcome
      // means ops were written (pending ledger recorded) or the channel was
      // busy -- the loop closes only when a LATER cycle reconciles the late
      // results (Foundry's watcher ticks every 5s, well past the quiet
      // flush's own poll window). ONE delayed follow-up (~8s) consumes them
      // without waiting for the next user mutation or Sync now. delayMs > 0
      // marks a follow-up, so a still-queued follow-up (Foundry genuinely
      // closed) ends the chain instead of looping forever.
      if (outcome?.queued && delayMs === 0) {
        scheduleFlush(world, 8000);
      } else if (delayMs > 0 && delayMs < 20000 && outcome?.pendingCount > 0) {
        // The follow-up fired before the watcher's results landed -- chain
        // ONE more, longer follow-up (8s -> 16s, then the < 20000 guard ends
        // the chain). Bounded: at most two follow-ups per queued outcome.
        scheduleFlush(world, delayMs * 2);
      }
    }).catch((err) => {
      console.error(`[foundry-flush] background flush for world "${world}" failed:`, err.message);
    });
  }, delayMs);
}

/** Schedules a flush iff the just-written scene is currently staged (an unstaged scene's own dirty predicate is false anyway -- see foundry-push-ops.mjs's isSceneDirty). Best-effort: `scene` may be null/undefined from a caller that doesn't have one handy. */
function maybeScheduleFlush(world, scene) {
  if (scene?.stagedForFoundry === true) scheduleFlush(world);
}

// statFromBestiaryRawFields moved to wf-mcp-server/lib/planner-ops.mjs
// (MCP wave) -- shared with wf_tray_drop. Imported below, alongside
// sceneTrayDropOp, for the POST .../tray/drop route.

/**
 * Full batch-detail payload for the Review view: headline + per-region,
 * per-entity data (grain.mjs's summarizeBatch), each entity augmented with
 * its actual review-state status (accepted/pending/rejected/...) -- a field
 * summarizeBatch's own output deliberately doesn't carry (it's a grain/
 * collapse concern, not a status concern), cross-referenced here from the
 * raw batch.mutations by mutationId. Also reports `narratable` (every
 * mutation status==='accepted') so the frontend knows whether to offer
 * narration without needing its own copy of narrate.mjs's gate rule.
 */
function batchDetailPayload(dir, w, batchId) {
  const batch = loadBatch(w, batchId);
  const statusByMutationId = new Map(batch.mutations.map((m) => [m.mutationId, m.status]));
  const summary = summarizeBatch(batch, { flaggedEntityIds: flaggedEntityIdSet(w) });
  // Friction Wave 1 (W1a): live-snapshot entities for the deterministic
  // near-match chips on CREATE cards. A world with no snapshot yet (or an
  // unreadable one) degrades to no chips -- never a failed batch read.
  let liveEntities = [];
  try {
    ({ entities: liveEntities } = loadSnapshot(dir, w).snapshot);
  } catch { /* no snapshot yet is a real, valid state */ }
  const nearMatches = nearMatchesForBatch(batch, liveEntities);
  // W1e: deterministic triage tag + severity-merged effective risk per
  // mutation (see triageForBatch) -- the risk override is also what makes
  // the Triaged grouping meaningful for pre-Phase-37 batches, whose
  // mutations carry no stamped risk at all.
  const triage = triageForBatch(batch, nearMatches);
  // W1g: real endpoint names for edge cards ("A —label→ B", never raw ids)
  // -- the live edges list rides along for delete/update-of-existing-edge
  // rows whose data omits its endpoints.
  let liveEdges = [];
  try {
    ({ edges: liveEdges } = loadSnapshot(dir, w).snapshot);
  } catch { /* same no-snapshot degrade as liveEntities above */ }
  const edgeDisplay = edgeDisplayForBatch(batch, liveEntities, liveEdges);
  // W5c: non-blocking world-name guard -- an entity named exactly like the
  // world gets a subtle advisory tag on its card (see mutation-ops.mjs).
  const worldNameCollisions = worldNameCollisionsForBatch(batch, w);
  const regions = summary.regions.map((region) => ({
    ...region,
    entities: region.entities.map((e) => ({
      ...e,
      status: statusByMutationId.get(e.mutationId),
      ...(nearMatches[e.mutationId] ? { nearMatches: nearMatches[e.mutationId] } : {}),
      ...(triage[e.mutationId] ? { triage: triage[e.mutationId].triage, risk: triage[e.mutationId].risk } : {}),
      ...(edgeDisplay[e.mutationId] ? { edgeDisplay: edgeDisplay[e.mutationId] } : {}),
      ...(worldNameCollisions[e.mutationId] ? { worldNameCollision: true } : {})
    }))
  }));
  const narratable = batch.mutations.length > 0 && batch.mutations.every((m) => m.status === "accepted");
  return {
    batch: {
      id: batch.id,
      world: batch.world,
      createdAt: batch.createdAt,
      status: batch.status,
      scope: batch.scope,
      elapsedTimeDescriptor: batch.elapsedTimeDescriptor,
      mutationCount: batch.mutations.length
    },
    headline: summary.headline,
    regions,
    narratable
  };
}

/**
 * The batch Settings' "Undo Last Batch" button targets: the most-recently-
 * created batch (review-state.mjs's listBatches is already newest-first)
 * that is not already rolled-back and has at least one accepted mutation
 * (rollback.mjs's own scope -- "most-recently-accepted batch only", but
 * nothing upstream tracks that id for a caller, so this is that lookup).
 * Returns null if nothing is rollback-able.
 */
function findLastRollbackableBatch(w) {
  for (const summary of listBatches(w)) {
    if (summary.status === "rolled-back") continue;
    const batch = loadBatch(w, summary.id);
    if (batch.mutations.some((m) => m.status === "accepted")) {
      return { id: batch.id, createdAt: batch.createdAt, status: batch.status };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Task 14.8 (QA-pass finding): scan-for-mentioned-entities had no
// cancellation and no duplicate-request guard -- navigating away while a
// scan was in flight didn't cancel it server-side (it silently completed
// and created a batch the user never saw appear), and the natural "nothing
// seemed to happen, let me click it again" retry created a second, fully
// redundant batch, wasting an LLM call.
//
// Server-side half of the fix (paired with an AbortController on the
// frontend, review-ui/public/app.js): a lightweight, IN-MEMORY (this
// process only -- not a new persisted data store, proportionate to the
// actual risk per the task's own "don't over-engineer a general
// request-deduplication framework" guidance) guard against firing a second
// genuinely-identical scan (same world, same source entity, same text)
// while one is still in flight OR was very recently completed -- returns
// the SAME result instead of starting a new one.
// ---------------------------------------------------------------------------
const SCAN_DEDUPE_WINDOW_MS = 10_000; // "very recently completed" -- long enough to absorb a confused retry-click, short enough to never mask a genuinely new request
const recentScans = new Map(); // key -> { promise, settledAt: number|null }

function scanDedupeKey(w, entityId, text) {
  return `${w}::${entityId}::${text}`;
}

/**
 * Runs `runScan()` (the real scanMentionsOp call) UNLESS an identical scan
 * (same key) is already in flight or settled within SCAN_DEDUPE_WINDOW_MS,
 * in which case the same promise/result is reused. `runScan` is a thunk
 * (not eagerly invoked) so a deduped call never triggers a second LLM call
 * even speculatively.
 */
function dedupedScan(w, entityId, text, runScan) {
  const key = scanDedupeKey(w, entityId, text);
  const existing = recentScans.get(key);
  const now = Date.now();
  if (existing && (existing.settledAt === null || now - existing.settledAt < SCAN_DEDUPE_WINDOW_MS)) {
    return existing.promise;
  }
  const promise = runScan();
  const entry = { promise, settledAt: null };
  recentScans.set(key, entry);
  promise.then(
    () => {
      entry.settledAt = Date.now();
      // Self-review remediation: without this, a successfully-settled entry
      // would sit in `recentScans` for the server process's ENTIRE lifetime
      // (only ever unreachable, never removed) -- an unbounded-growth leak
      // over a long-running session with many distinct (world, entity,
      // text) scans. Bound it to roughly "the current dedupe window's worth
      // of history" instead -- only remove THIS entry, and only if nothing
      // newer has already replaced it under the same key.
      setTimeout(() => { if (recentScans.get(key) === entry) recentScans.delete(key); }, SCAN_DEDUPE_WINDOW_MS).unref?.();
    },
    () => { recentScans.delete(key); } // a failed scan should NOT be cached -- a real retry after an error must actually retry
  );
  return promise;
}

// Exported for direct, deterministic unit testing of the dedup mechanism
// itself (no real LLM call needed -- see test/scan-dedupe.test.mjs)
// separately from the real-API end-to-end proof in routes-live.smoke.mjs.
export { dedupedScan, recentScans as __testOnlyRecentScans };

/**
 * GET /api/unreviewed-entities payload: every flagged entity, plus a real
 * display name looked up from the live snapshot -- task 14.6 (QA-pass
 * finding, confirmed independently by BOTH personas). Mirrors
 * pendingEntitiesPayload's exact same "look up from the live snapshot,
 * degrade gracefully to the raw id if there's no snapshot yet" convention
 * immediately below, rather than a second lookup approach.
 */
function unreviewedEntitiesPayload(w, dir, opts) {
  const flagged = findUnreviewedEntities(w, opts);
  let entities = [];
  try {
    ({ entities } = loadSnapshot(dir, w).snapshot);
  } catch {
    // No snapshot yet is fine here -- flagged entries can still be listed by id, just without a friendly name.
  }
  return flagged.map((f) => ({ ...f, name: findEntity(entities, f.entityId)?.name ?? f.entityId }));
}

// MCP wave: pendingEntitiesPayload/resolveOrCreateIntentEntity/
// firstLineTruncated/chronicleLogPayload AND the whole "QA fix-wave W1, Fix
// 3/Fix 4 -- OFFLINE DEGRADE for every LLM-backed route" block (offlineOpts/
// isOffline/every offline*Client) moved verbatim to wf-mcp-server/lib/
// chronicle-ops.mjs and wf-mcp-server/lib/offline-clients.mjs respectively,
// so wf-mcp-server/index.mjs's MCP tools go through the EXACT SAME code
// instead of a second, drifting copy -- per gm-tools-conventions' "front-ends
// are thin wrappers, never logic duplicators." Imported at the top of this
// file now; grep `offlineOpts(` there for the exhaustive, greppable call-site
// list (unchanged from before this move).

// ---------------------------------------------------------------------------
// Phase 7 -- graph data route (task 7.1). Thin composition over EXISTING
// primitives only, per the task's own instruction: wf-mcp-server/lib/graph.mjs's
// neighborhood() for BFS (no second graph-walk), mutation-ops.mjs's
// flaggedEntityIdSet (itself just human-review.mjs's findUnreviewedEntities,
// already used above by /api/unreviewed-entities) for the unreviewed
// channel, pending-ledger.mjs's listPendingEntities (already used above by
// /api/pending-entities) for the deferred-debt channel. No new business
// logic beyond request shaping lives here.
// ---------------------------------------------------------------------------

const GRAPH_STATUS_FILTER_TOKENS = new Set(["unreviewed", "deferred-debt"]);

/**
 * Parse a `filter` query param into the Set of active status tokens, or
 * `null` for "show everything." Task 7.4 originally shipped with
 * flagged-only as the default (filter omitted); real usage reversed that --
 * having to hit "Show everything" on every single visit was the actual
 * complaint. Omitting the param (or passing `all`, or a param with no
 * recognizable tokens) now all mean "show everything"; only an explicit,
 * recognized token list narrows the result.
 */
function parseGraphFilter(raw) {
  if (!raw || raw === "all") return null;
  const tokens = raw.split(",").map((t) => t.trim()).filter((t) => GRAPH_STATUS_FILTER_TOKENS.has(t));
  return tokens.length ? new Set(tokens) : null;
}

/**
 * Full-graph degree map (entityId -> edge count), built once over the
 * WHOLE snapshot's edges -- a node's hub-ness is a real property of the
 * persisted graph, not an artifact of how much context happens to be
 * fetched around it in any one request.
 */
function graphDegreeMap(edges) {
  const m = new Map();
  for (const e of edges) {
    m.set(e.sourceId, (m.get(e.sourceId) ?? 0) + 1);
    m.set(e.targetId, (m.get(e.targetId) ?? 0) + 1);
  }
  return m;
}

// Phase 12 task 12.2: matches foundry_worldFabric's own
// game.settings default for SETTINGS.staleThreshold (see
// llm-context.mjs's own `staleThreshold = 3` default and
// graph-service.mjs's `?? 3` fallback) -- a best-effort constant, not a
// live per-world read. Metadata nomination #5 ("surface already-existing
// fields") was explicitly confirmed GM_Tools-side-only/no-schema-change,
// so exporting the live per-world override into the snapshot meta is out
// of scope here; this reproduces WF's OWN default rather than inventing a
// different one.
const DEFAULT_STALE_THRESHOLD = 3;

/** Same recency-staleness formula as llm-context.mjs's budgetedContext (session-count based, not wall-clock). */
function isSessionStale(entity, sessionNumber) {
  return sessionNumber > 0 && entity.sessionSeen != null && (sessionNumber - entity.sessionSeen) >= DEFAULT_STALE_THRESHOLD;
}

/**
 * Phase 12 task 12.2: adds importance, session-staleness, foundryRef
 * presence, and the four new World Fabric entity fields (status/
 * playerKnown/canonLocked/role, task 12.1) to the existing node payload --
 * pure additive UI wiring over already-fetchable snapshot data, no new
 * backend logic. A synthetic/proposed-only entity (a batch-mode create with
 * no persisted counterpart, or an in-flight manual-edit placeholder) simply
 * has these come back `null`/`false`, same as every other already-optional
 * field this function produces.
 */
function graphNodePayload(entity, { degrees, flaggedIds, debtIds, proposed, sessionNumber }) {
  return {
    id: entity.id,
    name: entity.name ?? entity.id,
    type: entity.type ?? "unknown",
    degree: degrees.get(entity.id) ?? 0,
    flaggedUnreviewed: flaggedIds.has(entity.id),
    hasDeferredDebt: debtIds.has(entity.id),
    importance: typeof entity.importance === "number" ? entity.importance : null,
    hasFoundryRef: !!entity.foundryRef,
    sessionStale: isSessionStale(entity, sessionNumber ?? 0),
    lastSession: entity.lastSession ?? null,
    description: entity.description ?? "",
    status: entity.status ?? null,
    playerKnown: entity.playerKnown ?? null,
    canonLocked: entity.canonLocked ?? false,
    role: entity.role ?? null,
    // Phase 25 task 25.3: same additive-payload-growth pattern as the
    // task 19.6 comment above -- foundry_worldFabric/scripts/data/
    // graph-service.mjs's upsertEntity already persists summary/imageUrl/
    // tags (confirmed directly), but this route never returned them, so
    // Table Mode's member-roster nested-expand zone (description/summary/
    // imageUrl/tags) had nothing to read. Pure additive UI wiring over
    // already-fetchable snapshot data, no new backend logic, no new route.
    summary: entity.summary ?? "",
    imageUrl: entity.imageUrl ?? null,
    tags: Array.isArray(entity.tags) ? entity.tags : [],
    // Phase 19 task 19.6: a small, additive, backward-compatible response
    // field (same category of change as the Phase 18 addendum's additive
    // REQUEST fields on encounter-suggest -- growing an EXISTING route's
    // payload, not a new route) -- combat-planning-view.js's Resync-from-
    // Foundry button reads a WF entity's own already-stored generic
    // `attributes` bag (matched to a PartyMember by name) as the closest
    // real "read live data via the existing snapshot/file-bridge" path
    // available: WF graph entities have no dedicated hp field of their own
    // (confirmed by reading entity-schema/graphNodePayload fresh), so this
    // is a genuine, flagged gap, not an established convention being
    // reused -- see combat-planning-view.js's own header comment for the
    // full reasoning.
    attributes: entity.attributes ?? {},
    ...(proposed !== undefined ? { proposed } : {})
  };
}

function graphEdgePayload(edge, { proposed }) {
  return {
    id: edge.id,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    relationshipType: edge.relationshipType ?? "unspecified",
    label: edge.label,
    // Phase 12 task 12.2/12.3: the edge popover (new work) needs these to
    // render/pre-fill an edit form -- absent from Phase 7's original
    // read-only payload, which only ever rendered a line + optional arrow.
    strength: typeof edge.strength === "number" ? edge.strength : null,
    valence: edge.valence ?? null,
    notes: edge.notes ?? null,
    ...(proposed !== undefined ? { proposed } : {})
  };
}

/**
 * Batch-scoped graph payload: this batch's own proposed entities/edges
 * (every entity/edge touched by one of its mutations, regardless of
 * accept/reject/pending status -- accepting doesn't write to the graph
 * until sync, so even an accepted mutation is still "proposed" here) plus
 * their one-hop (or `depth`-hop) PERSISTED neighbors, via neighborhood().
 *
 * A create with no persisted counterpart yet gets a synthetic node keyed
 * `new:<mutationId>` -- writeup-import (graph-import/writeup-import.mjs)
 * pre-assigns a real id to every entity it creates, but texture.mjs's
 * LLM-authored creates are NOT guaranteed to (schema.mjs's `Mutation.id` is
 * optional), so this route can't assume every entity mutation carries a
 * resolved id the way Phase 5's own id-stability fix could.
 */
function graphPayloadForBatch(w, dir, batchId, depth) {
  const batch = loadBatch(w, batchId);
  let entities = [];
  let edges = [];
  let sessionNumber = 0;
  try {
    const loaded = loadSnapshot(dir, w);
    ({ entities, edges } = loaded.snapshot);
    sessionNumber = loaded.meta?.sessionNumber ?? 0;
  } catch {
    // No persisted snapshot yet (a brand-new world) -- the batch's own
    // proposed nodes still render, just with no persisted context.
  }
  const entityMap = new Map(entities.map((e) => [e.id, e]));
  const edgeMap = new Map(edges.map((e) => [e.id, e]));

  const proposedEntityIds = new Set(); // real + synthetic keys
  const syntheticEntities = new Map(); // key -> {id, name, type}
  const proposedEdgeIds = new Set();
  const syntheticEdges = new Map(); // key -> {id, sourceId, targetId, relationshipType, label}
  const seedRealIds = new Set(); // real persisted ids to expand neighborhood() from

  for (const m of batch.mutations) {
    if (m.op === "upsert_entity" || m.op === "delete_entity") {
      const key = m.id ?? `new:${m.mutationId}`;
      proposedEntityIds.add(key);
      if (m.id && entityMap.has(m.id)) {
        seedRealIds.add(m.id);
      } else {
        syntheticEntities.set(key, {
          id: key,
          name: m.entityContext?.name ?? m.data?.name ?? key,
          type: m.data?.type ?? "unknown"
        });
      }
    } else if (m.op === "upsert_edge" || m.op === "delete_edge") {
      const existingEdge = m.id ? edgeMap.get(m.id) : undefined;
      const sourceId = m.data?.sourceId ?? existingEdge?.sourceId;
      const targetId = m.data?.targetId ?? existingEdge?.targetId;
      if (!sourceId || !targetId) continue; // can't place an edge we can't resolve both endpoints for
      const key = m.id ?? `new-edge:${m.mutationId}`;
      proposedEdgeIds.add(key);
      syntheticEdges.set(key, {
        id: key,
        sourceId,
        targetId,
        relationshipType: m.data?.relationshipType ?? existingEdge?.relationshipType ?? "unspecified",
        label: m.data?.label ?? existingEdge?.label
      });
      for (const endpointId of [sourceId, targetId]) {
        if (entityMap.has(endpointId)) {
          seedRealIds.add(endpointId);
        } else if (!syntheticEntities.has(endpointId) && !proposedEntityIds.has(endpointId)) {
          // An edge endpoint this batch never directly mutates as an entity
          // and that isn't in the live snapshot either -- shouldn't happen
          // in practice (every producer creates/stubs both endpoints before
          // an edge referencing them), but render a minimal placeholder
          // rather than a dangling edge if it ever does.
          syntheticEntities.set(endpointId, { id: endpointId, name: endpointId, type: "unknown" });
        }
        proposedEntityIds.add(endpointId);
      }
    }
  }

  // Expand context: PERSISTED neighbors of every real seed entity this
  // batch touches -- reusing neighborhood(), one call per seed, merged.
  const contextEntities = new Map();
  const contextEdges = new Map();
  for (const seedId of seedRealIds) {
    const nb = neighborhood(entities, edges, seedId, depth);
    for (const e of nb.entities) contextEntities.set(e.id, e);
    for (const e of nb.edges) contextEdges.set(e.id, e);
  }

  const degrees = graphDegreeMap(edges);
  const flaggedIds = flaggedEntityIdSet(w);
  const debtIds = new Set(listPendingEntities(w));

  const nodesById = new Map();
  for (const e of syntheticEntities.values()) {
    nodesById.set(e.id, graphNodePayload(e, { degrees, flaggedIds, debtIds, proposed: true, sessionNumber }));
  }
  for (const e of contextEntities.values()) {
    nodesById.set(e.id, graphNodePayload(e, { degrees, flaggedIds, debtIds, proposed: proposedEntityIds.has(e.id), sessionNumber }));
  }

  const edgesById = new Map();
  for (const e of syntheticEdges.values()) {
    edgesById.set(e.id, graphEdgePayload(e, { proposed: true }));
  }
  for (const e of contextEdges.values()) {
    if (!edgesById.has(e.id)) edgesById.set(e.id, graphEdgePayload(e, { proposed: proposedEdgeIds.has(e.id) }));
  }

  return { nodes: [...nodesById.values()], edges: [...edgesById.values()] };
}

/**
 * Standalone whole-graph payload (tasks 7.1/7.4): every persisted entity,
 * filtered by status. Omitting `filter` entirely defaults to the CONFIRMED
 * flagged-only default (unreviewed OR deferred-debt) -- "show everything"
 * is an explicit `filter=all`, never the unstated default.
 */
function graphPayloadStandalone(w, dir, filterRaw) {
  let entities = [];
  let edges = [];
  let sessionNumber = 0;
  try {
    const loaded = loadSnapshot(dir, w);
    ({ entities, edges } = loaded.snapshot);
    sessionNumber = loaded.meta?.sessionNumber ?? 0;
  } catch {
    return { nodes: [], edges: [] };
  }
  const degrees = graphDegreeMap(edges);
  const flaggedIds = flaggedEntityIdSet(w);
  const debtIds = new Set(listPendingEntities(w));
  const activeFilters = parseGraphFilter(filterRaw); // null = show everything

  const selected = entities.filter((e) => {
    if (!activeFilters) return true;
    return (activeFilters.has("unreviewed") && flaggedIds.has(e.id)) ||
           (activeFilters.has("deferred-debt") && debtIds.has(e.id));
  });
  const selectedIds = new Set(selected.map((e) => e.id));

  const nodes = selected.map((e) => graphNodePayload(e, { degrees, flaggedIds, debtIds, sessionNumber }));
  const visibleEdges = edges
    .filter((e) => selectedIds.has(e.sourceId) && selectedIds.has(e.targetId))
    .map((e) => graphEdgePayload(e, {}));

  return { nodes, edges: visibleEdges };
}

// --- routing -----------------------------------------------------------------

/**
 * @param {object} [opts]
 * @param {number} [opts.port]
 * @returns {import('node:http').Server}
 */
export function createReviewServer(opts = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);

      if (parts[0] !== "api") {
        return handleStatic(url.pathname, res);
      }

      await handleApi(req, res, url, parts);
    } catch (err) {
      sendError(res, err);
    }
  });

  return server.listen(opts.port ?? DEFAULT_PORT);
}

function handleStatic(pathname, res) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(PUBLIC_DIR, rel);
  // Guard against path traversal outside public/ -- a fixed, small file set is served, no reason to ever escape PUBLIC_DIR.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 400, { error: "Invalid path" });
  }
  serveStatic(res, filePath);
}

async function handleApi(req, res, url, parts) {
  const method = req.method;
  const q = url.searchParams;

  // GET /api/worlds
  // W6a: alongside the snapshot-bearing `worlds` list (the topbar
  // world-select's long-standing source, unchanged shape), the response now
  // carries `worldDirs` -- EVERY world directory under Data/worlds/*, each
  // flagged hasSnapshot (selectable as-is) or not (attachable: POST below
  // bootstraps a snapshot INTO that existing folder). Both lists come from
  // the same listWorldDirs() scan (data-dir.mjs) -- one notion of "worlds on
  // disk", per the kilmarn friction entry ("the two world lists should
  // probably be one surface"). `attachable` is computed HERE, server-side,
  // so the id-format floor (the same regex POST enforces) can never drift
  // between the picker UI and the route that acts on it.
  if (method === "GET" && parts.length === 2 && parts[1] === "worlds") {
    const dir = resolveDir();
    const dirs = listWorldDirs(dir);
    return sendJson(res, 200, {
      dataDir: dir,
      worlds: dirs.filter((w) => w.hasSnapshot).map((w) => w.id),
      worldDirs: dirs.map((w) => ({
        ...w,
        attachable: !w.hasSnapshot && WORLD_ID_RE.test(w.id)
      }))
    });
  }

  // POST /api/worlds  { world }
  // Task 14.2: bootstrapSnapshot() (graph-import/headless-apply.mjs) already
  // existed and was already tested, but was never called from any production
  // code path -- a genuinely new campaign with no prior Foundry world had no
  // UI affordance to create one at all, a hard wall on New Import. This wires
  // it into a real, reachable route: create an empty standalone snapshot for
  // a brand-new world id, which listWorlds() (GET /api/worlds, above) picks
  // up immediately since it just checks for an on-disk snapshot file.
  //
  // W6a: the same route now also serves ATTACH -- when the id names an
  // EXISTING Data/worlds/<id> directory that has no snapshot yet (a real
  // Foundry world GM_Tools has never touched, e.g. kilmarn), the snapshot is
  // bootstrapped INTO that folder and the response says `attached: true`.
  // The id is validated against the actual folder listing (exact name match
  // via listWorldDirs), not just the regex, so an attach can never invent a
  // sibling directory through case/whitespace drift. A snapshot-bearing id
  // still 409s exactly as before -- that world already exists; select it.
  if (method === "POST" && parts.length === 2 && parts[1] === "worlds") {
    const body = await readBody(req);
    const dir = resolveDir();
    const worldId = typeof body.world === "string" ? body.world.trim() : "";
    if (!worldId || !WORLD_ID_RE.test(worldId)) {
      throw new Error(
        "POST /api/worlds requires a non-empty `world` id using only letters, digits, hyphens, and underscores " +
        "(it becomes a directory name on disk)."
      );
    }
    const snapPath = snapshotFilePath(dir, worldId);
    if (existsSync(snapPath)) {
      throw new Error(`World "${worldId}" already exists at ${snapPath} -- pick a different id, or select it from the existing worlds list instead.`);
    }
    const existingDir = listWorldDirs(dir).find((w) => w.id === worldId);
    bootstrapSnapshot(snapPath, { worldId });
    return sendJson(res, 200, {
      world: worldId,
      dataDir: dir,
      created: !existingDir,
      attached: !!existingDir
    });
  }

  // GET /api/batches
  if (method === "GET" && parts.length === 2 && parts[1] === "batches") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { world: w, batches: listBatches(w) });
  }

  // GET /api/entities/:entityId?world=&dataDir=  -- a single committed entity's own
  // record from the live snapshot (name/type/description/etc.), no edges/narration/prep
  // attached. Backs Phase 11's entity-detail view header (task 11.5); the narration and
  // prep-content sub-resources below are fetched separately by the same page.
  if (method === "GET" && parts.length === 3 && parts[1] === "entities") {
    const w = resolveWorld(q.get("world"));
    const dir = resolveDir();
    const { entities } = loadSnapshot(dir, w).snapshot;
    const entity = findEntity(entities, parts[2]);
    if (!entity) throw new Error(`No committed entity "${parts[2]}" found in world "${w}"'s live snapshot.`);
    return sendJson(res, 200, { entity });
  }

  // GET /api/batches/:batchId
  if (method === "GET" && parts.length === 3 && parts[1] === "batches") {
    const w = resolveWorld(q.get("world"));
    const dir = resolveDir();
    return sendJson(res, 200, batchDetailPayload(dir, w, parts[2]));
  }

  // POST /api/batches/:batchId/view  { world, grain, regionId, entityId }
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "view") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const result = reviewGrainOp(w, { batchId: parts[2], grain: body.grain, regionId: body.regionId, entityId: body.entityId });
    return sendJson(res, 200, { ok: true, ...result });
  }

  // POST /api/batches/:batchId/accept  { world, dataDir, scope, id }
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "accept") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await acceptOp(dir, w, { batchId: parts[2], scope: body.scope, id: body.id });
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/reject  { world, dataDir, scope, id, note, quickPickReason }
  // Phase 8: dispatches through rejectWithLoopOp, which is a byte-identical
  // pass-through to the old plain-reject behavior for every batch that
  // isn't a rubber-duck-mode writeup-import batch at scope='batch'/'region'
  // -- see mutation-ops.mjs's own doc comment for the full state machine.
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "reject") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    // QA W1 Fix 3 (grep-driven audit): the rubber-duck-mode reject-loop's
    // OWN reframe/regenerate calls degrade offline too, same as every other
    // writeup-import-backed call site.
    const result = await rejectWithLoopOp(dir, w, {
      batchId: parts[2],
      scope: body.scope,
      id: body.id,
      note: body.note,
      quickPickReason: body.quickPickReason
    }, { llmOpts: offlineOpts(offlineWriteupClient) });
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/bulk-accept  { world, dataDir, mutationIds, reviewedMutationIds }
  // The checkbox multi-select "Accept Selected" action: an arbitrary subset
  // of mutationIds, not necessarily a whole region/batch. `reviewedMutationIds`
  // (a subset of mutationIds) is per-mutation: only rows the GM actually
  // expanded before accepting count as genuinely reviewed
  // (markHumanReviewed); everything else accepted this way accumulates the
  // unreviewed-accept count (recordUnreviewedAccept) -- see
  // mutation-ops.mjs's acceptMutationIds doc comment for the full reasoning.
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "bulk-accept") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const mutationIds = body.mutationIds;
    if (!Array.isArray(mutationIds) || !mutationIds.length) {
      throw new Error("bulk-accept requires a non-empty mutationIds array");
    }
    const { entities, edges } = loadSnapshot(dir, w).snapshot;
    // Self-review remediation: mutation-ops.mjs's acceptMutationIds defaults
    // an OMITTED reviewedMutationIds to mutationIds (everything counts as
    // reviewed) -- correct for acceptOp's scope-based callers, which always
    // pass an explicit value either way, but the wrong default for THIS
    // route: a caller of the bulk endpoint that forgets the field should not
    // silently over-credit review. Default to [] (nothing reviewed) here at
    // the HTTP boundary instead of passing an omitted field straight through.
    const result = acceptMutationIds(w, parts[2], mutationIds, {
      entities,
      edges,
      reviewedMutationIds: body.reviewedMutationIds ?? []
    });
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/revert-to-pending  { world, mutationIds }
  // Friction Wave 1 (W1d): the reject-cascade's undo -- rejected mutations
  // (typically edges auto-greyed when their endpoint create was rejected)
  // flipped back to pending. Rejected-only; see revertMutationsToPending.
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "revert-to-pending") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const result = revertMutationsToPending(w, { batchId: parts[2], mutationIds: body.mutationIds });
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/bulk-reject  { world, mutationIds, reviewedMutationIds }
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "bulk-reject") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const mutationIds = body.mutationIds;
    if (!Array.isArray(mutationIds) || !mutationIds.length) {
      throw new Error("bulk-reject requires a non-empty mutationIds array");
    }
    // Same conservative-default reasoning as bulk-accept above.
    const result = rejectMutationIds(w, parts[2], mutationIds, { reviewedMutationIds: body.reviewedMutationIds ?? [] });
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/regenerate  { world, dataDir, scope, id, note }
  // QA W1 Fix 3 (grep-driven audit): can dispatch to EITHER a writeup-import
  // re-extraction OR a per-region texture regenerate depending on the
  // batch's own sourceKind -- both injection seams are threaded, only one
  // fires per call.
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "regenerate") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await regenerateOp(dir, w, { batchId: parts[2], scope: body.scope, id: body.id, note: body.note }, {
      writeupOpts: { llmOpts: offlineOpts(offlineWriteupClient) },
      textureOpts: offlineOpts(() => offlineTextureClient("regenerated"))
    });
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/narrate  { world, note }
  // Hard-gated by narrate.mjs's assertBatchNarratable (via narrateOp ->
  // narrateBatch): a batch with any non-accepted mutation throws
  // NarrationGateError, mapped to a clean 409 by sendError -- never a crash,
  // never a silent partial narration.
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "narrate") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    // QA W1 Fix 3 (grep-driven audit): degrades to a clean placeholder
    // narration instead of throwing keyless.
    const result = await narrateOp(w, { batchId: parts[2], note: body.note }, offlineOpts(offlineNarrateClient));
    return sendJson(res, 200, result);
  }

  // ---------------------------------------------------------------------
  // Phase 10 -- per-entity narration & persistence (task 10.4). This is now
  // the DEFAULT narration path the frontend uses (task 10.5); the whole-batch
  // /narrate route above is left unchanged and still works if ever needed.
  // ---------------------------------------------------------------------

  // POST /api/batches/:batchId/narrate-entity  { world, dataDir, mutationId, note }
  // Entity-grain gate (mutation-engine/narrate.mjs's assertMutationNarratable,
  // via narrateEntity): only the targeted mutationId must be status:'accepted'
  // -- a sibling mutation elsewhere in the batch being pending/rejected does
  // NOT block this call, unlike the whole-batch /narrate route above. On
  // success the result is durably persisted (mutation-engine/entity-narration.mjs)
  // before this route ever responds.
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "narrate-entity") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    if (!body.mutationId) throw new Error("POST .../narrate-entity requires a `mutationId`.");
    const result = await narrateEntityOp(dir, w, { batchId: parts[2], mutationId: body.mutationId, note: body.note }, offlineOpts(offlineNarrateClient));
    return sendJson(res, 200, result);
  }

  // GET /api/entities/:entityId/narration?world=...
  // The current (status:'current') narration for one entity, or {narration:null}
  // if it has never been narrated (or was superseded with nothing yet
  // replacing it) -- a pure read, no model call.
  if (method === "GET" && parts.length === 4 && parts[1] === "entities" && parts[3] === "narration") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, getEntityNarrationOp(w, { entityId: parts[2] }));
  }

  // GET /api/entities/:entityId/narration-history?world=...
  // The entity's FULL history (current + every superseded entry) -- backs
  // review-ui's per-row "view history" affordance (task 10.5).
  if (method === "GET" && parts.length === 4 && parts[1] === "entities" && parts[3] === "narration-history") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, getEntityNarrationHistoryOp(w, { entityId: parts[2] }));
  }

  // GET /api/entities/:entityId/narrative-state?world=...
  // The entity's Layer-2 sidecar record (reveal/truth/stance/clock), or
  // {narrativeState:null} = no record = fully open, zero gating. Pure read.
  if (method === "GET" && parts.length === 4 && parts[1] === "entities" && parts[3] === "narrative-state") {
    const w = resolveWorld(q.get("world"));
    const dir = resolveDir();
    return sendJson(res, 200, getNarrativeStateOp(dir, w, { entityId: parts[2] }));
  }

  // POST /api/entities/:entityId/narrative-state
  //   { world, revealState?, truth?, stance?, clock?, note?, sessionNumber? }
  // Combined direct write (POST, not PUT — this server's routes are
  // GET/POST only): any subset of the four fields; null clears
  // truth/stance/clock; omitted = untouched. No review batch — sidecar
  // class, the graph is untouched (narrative-state-ops.mjs's header).
  if (method === "POST" && parts.length === 4 && parts[1] === "entities" && parts[3] === "narrative-state") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const dir = resolveDir();
    return sendJson(res, 200, setNarrativeStateOp(dir, w, {
      entityId: parts[2],
      revealState: body.revealState,
      truth: body.truth,
      stance: body.stance,
      clock: body.clock,
      note: body.note,
      sessionNumber: body.sessionNumber
    }));
  }

  // POST /api/entities/:entityId/narrative-state/tick  { world, delta }
  if (method === "POST" && parts.length === 5 && parts[1] === "entities" && parts[3] === "narrative-state" && parts[4] === "tick") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const dir = resolveDir();
    return sendJson(res, 200, tickClockOp(dir, w, { entityId: parts[2], delta: body.delta }));
  }

  // GET /api/narrative-state?world=&state=&ids=a,b,c
  // World-wide listing (names joined from the snapshot), `state` filter, or
  // `ids` bulk mode — the run-spread tab-seeding fetch.
  if (method === "GET" && parts.length === 2 && parts[1] === "narrative-state") {
    const w = resolveWorld(q.get("world"));
    const dir = resolveDir();
    const idsParam = q.get("ids");
    return sendJson(res, 200, listNarrativeStateOp(dir, w, {
      revealState: q.get("state") || undefined,
      ids: idsParam ? idsParam.split(",").filter(Boolean) : undefined
    }));
  }

  // POST /api/entities/:entityId/narrate  { world, dataDir, note }
  // Task 14.7: "Narrate This" from the standalone entity page, which has no
  // batchId of its own to call narrate-entity with directly. Looks up the
  // most recent batch/mutation that genuinely addressed this entity and
  // narrates that (narrateEntityStandaloneOp); throws NoNarratableBatchError
  // (mapped to a clean 404 below, never a silent no-op) if nothing ever has.
  if (method === "POST" && parts.length === 4 && parts[1] === "entities" && parts[3] === "narrate") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await narrateEntityStandaloneOp(dir, w, { entityId: parts[2], note: body.note }, offlineOpts(offlineNarrateClient));
    return sendJson(res, 200, result);
  }

  // POST /api/entities/:entityId/foundry-push  { world }
  // Phase 26 task 26.10, §26.F -- "Drop this into Foundry" (replaces
  // buildPlayerKnownGate). Genuinely slow/external (headless Chromium login
  // + ChatMessage.create) -- world is resolved/validated FIRST, before any
  // of that runs.
  if (method === "POST" && parts.length === 4 && parts[1] === "entities" && parts[3] === "foundry-push") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await pushEntityToFoundry(dir, w, parts[2]);
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/sync  { world, dataDir }
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "sync") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await syncOp(dir, w, { batchId: parts[2] });
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/rollback  { world, dataDir }
  if (method === "POST" && parts.length === 4 && parts[1] === "batches" && parts[3] === "rollback") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await rollbackOp(dir, w, { batchId: parts[2] });
    return sendJson(res, 200, result);
  }

  // GET /api/last-rollbackable-batch  -- what Settings' "Undo Last Batch" button targets
  if (method === "GET" && parts.length === 2 && parts[1] === "last-rollbackable-batch") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { batch: findLastRollbackableBatch(w) });
  }

  // GET /api/unreviewed-entities
  if (method === "GET" && parts.length === 2 && parts[1] === "unreviewed-entities") {
    const w = resolveWorld(q.get("world"));
    const dir = resolveDir();
    const maxAgeDays = q.get("maxAgeDays") ? Number(q.get("maxAgeDays")) : undefined;
    const maxUnreviewedAccepts = q.get("maxUnreviewedAccepts") ? Number(q.get("maxUnreviewedAccepts")) : undefined;
    return sendJson(res, 200, {
      world: w,
      defaults: { maxAgeDays: DEFAULT_MAX_AGE_DAYS, maxUnreviewedAccepts: DEFAULT_MAX_UNREVIEWED_ACCEPTS },
      entities: unreviewedEntitiesPayload(w, dir, { maxAgeDays, maxUnreviewedAccepts })
    });
  }

  // POST /api/unreviewed-entities/:entityId/mark-reviewed  { world }
  // Real gap found via hands-on use: a flagged entity only ever cleared by
  // being individually expanded inside SOME open batch that happened to
  // touch it -- an entity with no current open batch (or one the GM doesn't
  // want to open just to dismiss a flag) had no way to be acknowledged at
  // all, so it sat in "Long-unreviewed entities" indefinitely. This is a
  // standalone dismiss, no batch context required -- markHumanReviewed()
  // itself never depended on one.
  if (method === "POST" && parts.length === 4 && parts[1] === "unreviewed-entities" && parts[3] === "mark-reviewed") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    markHumanReviewed(w, [parts[2]]);
    return sendJson(res, 200, { world: w, entityId: parts[2], marked: true });
  }

  // GET /api/pending-entities
  if (method === "GET" && parts.length === 2 && parts[1] === "pending-entities") {
    const dir = resolveDir();
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { world: w, entities: pendingEntitiesPayload(w, dir) });
  }

  // ---------------------------------------------------------------------
  // Phase 37 task 37.1 -- Chronicle: world-clock, fortune, chronicle-log,
  // and the run-composition route. See review-ui/test/e2e/phase37-fixture.mjs
  // for the full pinned contract every route below implements exactly.
  // ---------------------------------------------------------------------

  // GET /api/chronicle/world-clock?world=
  if (method === "GET" && parts.length === 3 && parts[1] === "chronicle" && parts[2] === "world-clock") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, getWorldClock(w));
  }

  // POST /api/chronicle/world-clock/advance  { world, span:{days?|spanId?} }
  // THE elapsedSessions single-source rule (fixture §2): a client-supplied
  // `elapsedSessions` (or any other extraneous body field) is never read --
  // only `span` is, and advanceWorldClock computes its own return value.
  if (
    method === "POST" &&
    parts.length === 4 &&
    parts[1] === "chronicle" &&
    parts[2] === "world-clock" &&
    parts[3] === "advance"
  ) {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    return sendJson(res, 200, advanceWorldClock(w, body.span));
  }

  // GET /api/chronicle/fortune?world=
  if (method === "GET" && parts.length === 3 && parts[1] === "chronicle" && parts[2] === "fortune") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, getFortune(w));
  }

  // POST /api/chronicle/fortune  { world, stopId }
  if (method === "POST" && parts.length === 3 && parts[1] === "chronicle" && parts[2] === "fortune") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    return sendJson(res, 200, setFortune(w, body.stopId));
  }

  // GET /api/chronicle/log?world=
  if (method === "GET" && parts.length === 3 && parts[1] === "chronicle" && parts[2] === "log") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, chronicleLogPayload(w));
  }

  // POST /api/chronicle/run
  //   { world, scopeKind?, branchIds?, carriedEntryIds?, span, prompt?, tags? }
  // -> { batchId, mutationCount, headline, clock:{currentDate,sessionNumber,
  //      elapsedSessions}, fortuneAtRun, scopeKind }
  //
  // §6's scopeKind -> scope.mjs mode translation, done ONCE here regardless
  // of scopeKind so the §2 elapsedSessions single-source guard covers all
  // three: advanceWorldClock is called EXACTLY ONCE per run, and its own
  // returned elapsedSessions is the ONLY value ever merged into the resolved
  // scope spec -- a client-supplied body.elapsedSessions is NEVER read
  // anywhere in this handler (confirm by grep: `body.elapsedSessions` does
  // not appear below).
  if (method === "POST" && parts.length === 3 && parts[1] === "chronicle" && parts[2] === "run") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const dir = resolveDir();
    // MCP wave: the full composition (scope resolution, THE single
    // advanceWorldClock call, prompt-as-seed, offline-safe texturing) now
    // lives in wf-mcp-server/lib/chronicle-ops.mjs's runChronicleOp -- shared
    // verbatim with wf-mcp-server/index.mjs's wf_chronicle_run tool. See that
    // module's own doc comment for the full pinned contract.
    const result = await runChronicleOp(dir, w, body);
    return sendJson(res, 200, result);
  }

  // POST /api/chronicle/intents  { world, name, note?, tags? }
  //   -> { entityId, name, type, entries: [...] }  (one pendingEntitiesPayload row)
  //
  // The "add a manual intent by hand" flow (phase37-fixture.mjs §5, the piece
  // 37.1 deferred): resolve a free-typed NAME into an entityId via the
  // SHARED resolveOrCreateIntentEntity (task 37.5 extracted this out so the
  // run route's prompt-seed below reuses the exact same machinery), then
  // writePending with the pinned `sourceBatchId:"manual"` sentinel +
  // `cycleDescriptor: "Manual"` so the deferred lane renders it exactly like
  // a wrap-up intent. No new store: pending-ledger.mjs's EXISTING
  // writePending does the work.
  if (method === "POST" && parts.length === 3 && parts[1] === "chronicle" && parts[2] === "intents") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const dir = resolveDir();
    // MCP wave: the dedup-or-create + writePending composition now lives in
    // wf-mcp-server/lib/chronicle-ops.mjs's queueIntentOp -- shared verbatim
    // with wf-mcp-server/index.mjs's wf_queue_intent tool.
    const result = queueIntentOp(dir, w, body);
    return sendJson(res, 200, result);
  }

  // POST /api/pending-entities/:entityId/resolve  { world, dataDir, depth, maxNeighbors, elapsedTimeDescriptor }
  if (method === "POST" && parts.length === 4 && parts[1] === "pending-entities" && parts[3] === "resolve") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const { entities, edges } = loadSnapshot(dir, w).snapshot;
    // QA W1 Fix 3 (grep-driven audit): resolvePending's own textureRegion
    // call is the SAME LLM shape as POST /api/chronicle/run's texture pass
    // -- reuses offlineTextureClient, not a second texture-shaped stub.
    const result = await resolvePending(
      w,
      parts[2],
      { depth: body.depth, maxNeighbors: body.maxNeighbors },
      {
        entities, edges, elapsedTimeDescriptor: body.elapsedTimeDescriptor,
        textureOpts: offlineOpts(() => offlineTextureClient("resolved-pending"))
      }
    );
    return sendJson(res, 200, result);
  }

  // ---------------------------------------------------------------------
  // Phase 7 -- graph data route (task 7.1).
  // GET /api/graph?world=...&dataDir=...&batchId=...&depth=...   (batch-scoped, with persisted one-hop context)
  // GET /api/graph?world=...&dataDir=...&filter=...              (standalone whole-graph; filter omitted -> flagged-only default)
  // ---------------------------------------------------------------------
  if (method === "GET" && parts.length === 2 && parts[1] === "graph") {
    const w = resolveWorld(q.get("world"));
    const dir = resolveDir();
    if (q.get("batchId")) {
      const depth = q.get("depth") ? Number(q.get("depth")) : 1;
      return sendJson(res, 200, graphPayloadForBatch(w, dir, q.get("batchId"), depth));
    }
    return sendJson(res, 200, graphPayloadStandalone(w, dir, q.get("filter")));
  }

  // ---------------------------------------------------------------------
  // Phase 12 tasks 12.3/12.4 — manual node/edge create/edit/delete, and
  // "Undo Last Manual Edit". Every write here is IMMEDIATE, no review gate
  // (plans/phase-12-review.md decision 1) -- deliberately NOT exposed as MCP
  // tools, see manual-edit-ops.mjs's own doc comment.
  // ---------------------------------------------------------------------

  // POST /api/graph/nodes  { world, dataDir, name, type, description?, importance?, tags?, status?, playerKnown?, canonLocked?, role? }
  if (method === "POST" && parts.length === 3 && parts[1] === "graph" && parts[2] === "nodes") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await addNodeOp(dir, w, body);
    return sendJson(res, 200, result);
  }

  // POST /api/graph/edges  { world, dataDir, sourceId, targetId, relationshipType?, label?, strength?, valence?, notes? }
  if (method === "POST" && parts.length === 3 && parts[1] === "graph" && parts[2] === "edges") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await addEdgeOp(dir, w, body);
    return sendJson(res, 200, result);
  }

  // PATCH-style: POST /api/graph/nodes/:entityId  { world, dataDir, data:{...} }
  if (method === "POST" && parts.length === 4 && parts[1] === "graph" && parts[2] === "nodes") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await editNodeOp(dir, w, { entityId: parts[3], data: body.data });
    return sendJson(res, 200, result);
  }

  // POST /api/graph/edges/:edgeId  { world, dataDir, data:{...} }
  if (method === "POST" && parts.length === 4 && parts[1] === "graph" && parts[2] === "edges") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await editEdgeOp(dir, w, { edgeId: parts[3], data: body.data });
    return sendJson(res, 200, result);
  }

  // DELETE /api/graph/nodes/:entityId  { world, dataDir } (query or body — accept both, body is simpler for fetch())
  if (method === "DELETE" && parts.length === 4 && parts[1] === "graph" && parts[2] === "nodes") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world ?? q.get("world"));
    const result = await deleteNodeOp(dir, w, { entityId: parts[3] });
    return sendJson(res, 200, result);
  }

  // DELETE /api/graph/edges/:edgeId  { world, dataDir }
  if (method === "DELETE" && parts.length === 4 && parts[1] === "graph" && parts[2] === "edges") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world ?? q.get("world"));
    const result = await deleteEdgeOp(dir, w, { edgeId: parts[3] });
    return sendJson(res, 200, result);
  }

  // Phase 37.6 task 3 -- POST /api/graph/nodes/:entityId/develop-description
  // { world, vision } -> { suggestion }. The "✦ develop this place" affordance:
  // a GM's one-line vision + the node's current description + its real graph
  // neighborhood (buildAdjacencyContext) go to the model; the SUGGESTION comes
  // back for the frontend to show as a one-shot accept/dismiss card. NEVER
  // writes -- accepting is a SEPARATE call to the existing PATCH-style
  // POST /api/graph/nodes/:entityId route above, same no-silent-auto-write
  // discipline as assist-prep's element drafts.
  if (method === "POST" && parts.length === 5 && parts[1] === "graph" && parts[2] === "nodes" && parts[4] === "develop-description") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const { entities, edges } = loadSnapshot(dir, w).snapshot;
    // Same OFFLINE DETERMINISTIC degrade as POST /api/chronicle/run's
    // texture call -- a key-less dev/demo environment (and this route's own
    // e2e coverage) gets a real, honestly-labelled placeholder suggestion
    // instead of a thrown "missing API key" from the Anthropic SDK
    // constructor. With a key present this branch never fires.
    //
    // QA W1 Fix 4: `offline:true` is stamped on the RESPONSE (never inside
    // `suggestion` itself, which is the clean body Accept persists verbatim)
    // so the frontend can render the disclaimer as chrome above the text.
    const result = await developDescription(entities, edges, parts[3], body.vision, offlineOpts(offlineDevelopDescriptionClient));
    return sendJson(res, 200, { ...result, offline: isOffline() });
  }

  // POST /api/graph/nodes/:entityId/reparent  { world, dataDir, parentId }
  // Phase 30 task 30.1 -- atomic drag-drop reparent for the World
  // containment tree (manual-edit-ops.mjs's reparentNode): removes the
  // node's existing containment edge(s) and adds a new one to `parentId` as
  // ONE atomic undo unit. `parentId: null` unparents. Same immediate,
  // no-review-gate write surface as every other route in this block.
  if (method === "POST" && parts.length === 5 && parts[1] === "graph" && parts[2] === "nodes" && parts[4] === "reparent") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await reparentNode(dir, w, parts[3], body.parentId ?? null);
    return sendJson(res, 200, result);
  }

  // POST /api/graph/nodes/:entityId/anchor-membership  { world, parentId }
  // Phase 38 task 38.3 -- atomic drag-drop re-anchor for the World Loyalty
  // tree (manual-edit-ops.mjs's anchorMembership): removes the node's
  // existing membership/fealty PARENT edge(s) and adds a new `membership`
  // edge to `parentId` as ONE atomic undo unit. `parentId: null` unanchors.
  // A genuinely separate, sibling route to /reparent above -- reparentNode
  // (and this route) are NEVER touched by it, per the phase38 contract's
  // own "reparentNode untouched" instruction.
  if (
    method === "POST" &&
    parts.length === 5 &&
    parts[1] === "graph" &&
    parts[2] === "nodes" &&
    parts[4] === "anchor-membership"
  ) {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await anchorMembership(dir, w, parts[3], body.parentId ?? null);
    return sendJson(res, 200, result);
  }

  // POST /api/graph/nodes/:entityId/remove-reparent-up  { world }
  // -> {entityId, name, reparentedChildren, droppedEdges}
  // Phase 34 task 34.1 -- the hybrid "Remove from graph" delete
  // (manual-edit-ops.mjs's removeNodeReparentUp): every containment child
  // of the node is reparented up to the node's own parent (or unparented
  // if the node is itself a root), THEN the node is deleted cascading its
  // remaining edges -- ONE atomic undo unit. The existing
  // /remove-from-scenes route (above) is reused UNCHANGED by the frontend
  // for the opt-in "also remove from all N scenes" cleanup -- this route
  // does not touch scenes at all.
  if (
    method === "POST" &&
    parts.length === 5 &&
    parts[1] === "graph" &&
    parts[2] === "nodes" &&
    parts[4] === "remove-reparent-up"
  ) {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await removeNodeReparentUp(dir, w, parts[3]);
    return sendJson(res, 200, result);
  }

  // POST /api/graph/nodes/:entityId/remove-from-scenes  { world }  -> {removedElements, unanchoredScenes}
  // Phase 33 task 33.2 -- the opt-in cleanup behind the World inspector's
  // "Remove from graph" action's "also remove from all N scenes" checkbox.
  // Thin wrapper over removeEntityFromAllScenes (scene-lookup.mjs): strips the
  // node's kind:'graph' elements from every scene that referenced it and
  // clears any anchor pointing at it. NOT a graph write and NOT covered by the
  // manual-undo slot -- deliberately a separate, pre-delete cleanup step.
  if (method === "POST" && parts.length === 5 && parts[1] === "graph" && parts[2] === "nodes" && parts[4] === "remove-from-scenes") {
    const body = await readBody(req);
    const w = resolveWorld(body.world ?? q.get("world"));
    const result = removeEntityFromAllScenes(w, parts[3]);
    return sendJson(res, 200, result);
  }

  // GET /api/manual-edit-sync-status?world=...  -- Phase 13 task 13.1: "N
  // manual edits not yet synced to Foundry" affordance. Syncing reuses the
  // EXISTING /api/batches/:batchId/sync route below (syncOp) unmodified --
  // this route only reports which batchId to point that route at.
  if (method === "GET" && parts.length === 2 && parts[1] === "manual-edit-sync-status") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, getManualEditSyncStatusOp(w));
  }

  // GET /api/manual-undo?world=...  -- toolbar/toast status, read-only, never consumes the slot
  if (method === "GET" && parts.length === 2 && parts[1] === "manual-undo") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, getManualUndoStatusOp(w));
  }

  // POST /api/manual-undo  { world, dataDir }  -- consumes and applies the single undo slot
  if (method === "POST" && parts.length === 2 && parts[1] === "manual-undo") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await undoLastManualEditOp(dir, w);
    return sendJson(res, 200, result);
  }

  // ---------------------------------------------------------------------
  // Phase 12 task 12.6 — narration reset. Covered by the same undo
  // mechanism above (a reset's undo is a narrationUndo action, not a
  // graphMutations one — see manual-edit-ops.mjs's resetEntityNarrationOp).
  // ---------------------------------------------------------------------

  // POST /api/entities/:entityId/narration/reset  { world }
  if (method === "POST" && parts.length === 5 && parts[1] === "entities" && parts[3] === "narration" && parts[4] === "reset") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const result = resetEntityNarrationOp(w, { entityId: parts[2] });
    return sendJson(res, 200, result);
  }

  // ---------------------------------------------------------------------
  // Phase 12 task 12.5 — scan for mentioned entities. Routes through the
  // EXISTING batch/accept/reject/regenerate flow (decision 3) -- this is a
  // normal review-state.mjs batch, not the manual-edit immediate-write path.
  // ---------------------------------------------------------------------

  // POST /api/entities/:entityId/scan-mentions  { world, dataDir, text }
  // Task 14.8: a rapid double-trigger of the SAME scan (same world/entity/
  // text) -- whether a genuine double-click, a confused retry after
  // navigating away mid-request, or two tabs -- reuses the same in-flight
  // or very-recently-settled result instead of paying for and creating a
  // second, fully redundant batch. See dedupedScan's own doc comment.
  if (method === "POST" && parts.length === 4 && parts[1] === "entities" && parts[3] === "scan-mentions") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    if (typeof body.text !== "string" || !body.text.trim()) {
      throw new Error("POST .../scan-mentions requires a non-empty `text` field.");
    }
    const result = await dedupedScan(w, parts[2], body.text, () => scanMentionsOp(dir, w, { entityId: parts[2], text: body.text }, { llmOpts: offlineOpts(offlineScanMentionsClient) }));
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/mutations/:mutationId/patch-data  { world, data:{...} }
  // The "editable relationship-type dropdown" primitive (task 12.5's
  // [DECIDED] shape) for a still-PENDING mutation -- generalized as a small
  // reusable capability rather than scan-mentions-specific. Friction Wave 1
  // (W1c): now the "yes, but" merge editor's write path too, upgraded to
  // patchPendingMutationDataOp so the mutation's diff/risk are recomputed
  // against the live snapshot after the reviewer's hand edit -- the card
  // must always show what accepting would ACTUALLY apply.
  if (method === "POST" && parts.length === 6 && parts[1] === "batches" && parts[3] === "mutations" && parts[5] === "patch-data") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = patchPendingMutationDataOp(dir, w, { batchId: parts[2], mutationId: parts[4], data: body.data });
    return sendJson(res, 200, { ok: true, ...result });
  }

  // POST /api/batches/:batchId/mutations/:mutationId/redirect-to-existing
  //   { world, existingEntityId, existingEntityName? }
  // Phase 13 task 13.3: a "propose new" mention-scan row, redirected to link
  // to an already-existing entity instead of creating a duplicate.
  if (method === "POST" && parts.length === 6 && parts[1] === "batches" && parts[3] === "mutations" && parts[5] === "redirect-to-existing") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    if (typeof body.existingEntityId !== "string" || !body.existingEntityId.trim()) {
      throw new Error("POST .../redirect-to-existing requires a non-empty `existingEntityId`.");
    }
    const result = redirectMentionScanRowToExistingOp(dir, w, {
      batchId: parts[2],
      mutationId: parts[4],
      existingEntityId: body.existingEntityId,
      existingEntityName: body.existingEntityName
    });
    return sendJson(res, 200, result);
  }

  // POST /api/batches/:batchId/mutations/:mutationId/convert-to-existing
  //   { world, existingEntityId }
  // Friction Wave 1 (W1b): a still-pending proposed CREATE (writeup-import
  // batches foremost) converted into an UPDATE of a reviewer-chosen existing
  // entity, with every still-pending edge in the batch that referenced the
  // would-be-new id re-pointed automatically. Phase 13.3's redirect route
  // above is the mention-scan-specific sibling; this one is general.
  if (method === "POST" && parts.length === 6 && parts[1] === "batches" && parts[3] === "mutations" && parts[5] === "convert-to-existing") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    if (typeof body.existingEntityId !== "string" || !body.existingEntityId.trim()) {
      throw new Error("POST .../convert-to-existing requires a non-empty `existingEntityId`.");
    }
    const result = convertCreateToUpdateOfExistingOp(dir, w, {
      batchId: parts[2],
      mutationId: parts[4],
      existingEntityId: body.existingEntityId
    });
    return sendJson(res, 200, result);
  }

  // ---------------------------------------------------------------------
  // Phase 8 — rubber-duck mode: settings + the two-phase writeup flow.
  // ---------------------------------------------------------------------

  // GET /api/settings/rubber-duck
  if (method === "GET" && parts.length === 3 && parts[1] === "settings" && parts[2] === "rubber-duck") {
    return sendJson(res, 200, getUserSettings().rubberDuckMode);
  }

  // POST /api/settings/rubber-duck  { enabled }
  if (method === "POST" && parts.length === 3 && parts[1] === "settings" && parts[2] === "rubber-duck") {
    const body = await readBody(req);
    if (typeof body.enabled !== "boolean") {
      throw new Error("POST /api/settings/rubber-duck requires a boolean `enabled` field.");
    }
    return sendJson(res, 200, setRubberDuckMode(body.enabled).rubberDuckMode);
  }

  // POST /api/writeup-propose  { world, dataDir, text, mode, framing? }
  // Phase A of the two-phase flow (mirrors wf_propose_from_writeup). Rubber-duck
  // OFF: returns importWriteup()'s own result unchanged, a real batch is created.
  // Rubber-duck ON: returns {phase:'framing', framings, writeupText, mode, rubberDuck} --
  // no batch created yet. Friction Wave 1 (W2d): an optional `framing`
  // carry-over ({framings, selection, rubberDuck} -- the same body a
  // writeup-select-framing call carries) skips the framing round entirely on
  // a resubmit of already-framed material; validated + dispatched by
  // proposeFromWriteupOp, shared verbatim with the MCP tool.
  if (method === "POST" && parts.length === 2 && parts[1] === "writeup-propose") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    if (typeof body.text !== "string" || !body.text.trim()) {
      throw new Error("POST /api/writeup-propose requires a non-empty `text` field.");
    }
    // QA W1 Fix 3 (the flagship onboarding AI route): a keyless environment
    // degrades to offlineWriteupClient (handles both the rubber-duck-off
    // extraction call and the rubber-duck-on framing call -- see that
    // client's own doc comment) instead of throwing on client construction.
    const result = await proposeFromWriteupOp(dir, w, { text: body.text, mode: body.mode, framing: body.framing }, { llmOpts: offlineOpts(offlineWriteupClient) });
    // QA W3 finding 2: rubber-duck OFF means a real batch landed in one
    // shot -- give it the SAME chronicle-run sidecar a Composer-run batch
    // gets (span/fortuneAtRun/elapsedSessions null -- an intake has no
    // duration/fortune concept), sourced from the writeup's own first line,
    // so Chronicle's history rail can title it instead of falling back to a
    // raw scope label. Rubber-duck ON (result.phase === "framing") has no
    // batch yet -- nothing to record here; selectFramingForNewBatch below
    // covers that case once the batch actually exists.
    if (result && result.batchId) {
      recordChronicleRun(w, result.batchId, { span: null, fortuneAtRun: null, elapsedSessions: null, promptSummary: firstLineTruncated(body.text, 80) });
    }
    return sendJson(res, 200, result);
  }

  // POST /api/writeup-select-framing  { world, dataDir, writeupText?, batchId?, mode, framings, selection, rubberDuck? }
  // Phase B: either creates a new batch (writeupText path, the reviewer's
  // first pick) or replaces an existing batch's mutations (batchId path,
  // the reviewer's pick after a plain-reject-triggered re-framing round).
  if (method === "POST" && parts.length === 2 && parts[1] === "writeup-select-framing") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    // QA W1 Fix 3 (grep-driven audit): both branches degrade offline, same
    // offlineWriteupClient as writeup-propose's own extraction call.
    if (body.batchId) {
      const result = await selectFramingForExistingBatch(dir, w, {
        batchId: body.batchId,
        framings: body.framings,
        selection: body.selection
      }, { llmOpts: offlineOpts(offlineWriteupClient) });
      return sendJson(res, 200, result);
    }
    if (!body.writeupText) {
      throw new Error("POST /api/writeup-select-framing requires either `batchId` or `writeupText`.");
    }
    const result = await selectFramingForNewBatch(dir, w, {
      writeupText: body.writeupText,
      mode: body.mode,
      framings: body.framings,
      selection: body.selection,
      rubberDuck: body.rubberDuck
    }, { llmOpts: offlineOpts(offlineWriteupClient) });
    // QA W3 finding 2: the rubber-duck-ON new-batch path -- same sidecar as
    // the rubber-duck-OFF path above, titled from the ORIGINAL writeup text
    // (not the composed framing note), same reasoning.
    if (result && result.batchId) {
      recordChronicleRun(w, result.batchId, { span: null, fortuneAtRun: null, elapsedSessions: null, promptSummary: firstLineTruncated(body.writeupText, 80) });
    }
    return sendJson(res, 200, result);
  }

  // ---------------------------------------------------------------------
  // Phase 11 -- per-node content generation ("develop this node"). Entirely
  // separate from every /api/batches/* route above: no batchId anywhere in
  // this surface, so it is not reachable from Batch Review even in
  // principle. All routes below hang off /api/entities/:entityId/prep(...)
  // -- entityId is an already-committed entity/edge id from the live
  // snapshot, resolved the same way the narration routes above already do.
  // ---------------------------------------------------------------------

  // GET /api/entities/:entityId/prep?world=...
  if (method === "GET" && parts.length === 4 && parts[1] === "entities" && parts[3] === "prep") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, getPrepContentOp(w, { entityId: parts[2] }));
  }

  // POST /api/entities/:entityId/prep/propose-framings  { world, dataDir }
  if (method === "POST" && parts.length === 5 && parts[1] === "entities" && parts[3] === "prep" && parts[4] === "propose-framings") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await proposePrepFramingsOp(dir, w, { entityId: parts[2] }, offlineOpts(() => offlinePrepContentClient("framing")));
    return sendJson(res, 200, result);
  }

  // POST /api/entities/:entityId/prep/reframe  { world, dataDir, priorRoundCount }
  if (method === "POST" && parts.length === 5 && parts[1] === "entities" && parts[3] === "prep" && parts[4] === "reframe") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await reframePrepFramingsOp(dir, w, { entityId: parts[2], priorRoundCount: body.priorRoundCount }, offlineOpts(() => offlinePrepContentClient("framing")));
    return sendJson(res, 200, result);
  }

  // POST /api/entities/:entityId/prep/generate  { world, dataDir, selection }
  if (method === "POST" && parts.length === 5 && parts[1] === "entities" && parts[3] === "prep" && parts[4] === "generate") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    if (!body.selection) throw new Error("POST .../prep/generate requires a `selection` field.");
    // QA W1 Fix 3: the offline client's response must validate against THIS
    // entity's own `.strict()` field schema (fieldsSchemaForType) -- a cheap
    // extra read-only lookup (generatePrepContentOp does the exact same
    // findEntity internally; this doesn't duplicate any WRITE logic).
    const entityTypeForOffline = isOffline() ? findEntity(loadSnapshot(dir, w).snapshot.entities, parts[2])?.type : null;
    const result = await generatePrepContentOp(dir, w, { entityId: parts[2], selection: body.selection },
      offlineOpts(() => offlinePrepContentClient("generate", { entityType: entityTypeForOffline })));
    return sendJson(res, 200, result);
  }

  // POST /api/entities/:entityId/prep/accept  { world }
  if (method === "POST" && parts.length === 5 && parts[1] === "entities" && parts[3] === "prep" && parts[4] === "accept") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    return sendJson(res, 200, acceptPrepContentOp(w, { entityId: parts[2] }));
  }

  // POST /api/entities/:entityId/prep/discard  { world }
  if (method === "POST" && parts.length === 5 && parts[1] === "entities" && parts[3] === "prep" && parts[4] === "discard") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    return sendJson(res, 200, discardPrepContentOp(w, { entityId: parts[2] }));
  }

  // POST /api/entities/:entityId/prep/regenerate-field  { world, dataDir, fieldName, note }
  if (method === "POST" && parts.length === 5 && parts[1] === "entities" && parts[3] === "prep" && parts[4] === "regenerate-field") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    if (!body.fieldName) throw new Error("POST .../prep/regenerate-field requires a `fieldName` field.");
    const entityTypeForOffline = isOffline() ? findEntity(loadSnapshot(dir, w).snapshot.entities, parts[2])?.type : null;
    const result = await regeneratePrepFieldOp(dir, w, { entityId: parts[2], fieldName: body.fieldName, note: body.note },
      offlineOpts(() => offlinePrepContentClient("field", { fieldName: body.fieldName, entityType: entityTypeForOffline })));
    return sendJson(res, 200, result);
  }

  // POST /api/entities/:entityId/prep/mark-stale  { world }
  if (method === "POST" && parts.length === 5 && parts[1] === "entities" && parts[3] === "prep" && parts[4] === "mark-stale") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    return sendJson(res, 200, markPrepContentStaleOp(w, { entityId: parts[2] }));
  }

  // ---------------------------------------------------------------------
  // Phase 16 -- Session Planner engine (task 16.6). Every route below is a
  // thin wrapper over session-planner/{scenes,brief,session-notes}.mjs --
  // resolveWorld()/resolveDir() with NO argument, exactly like every route
  // above; no route here accepts a client-supplied `dataDir`.
  // ---------------------------------------------------------------------

  // POST /api/session-planner/scenes  { world, locationEntityId?, objectiveNote?, name? }
  // Phase 30 task 30.1: place-type guard -- the World "create a scene here"
  // affordance should only ever anchor a scene to a "place" node. The
  // lookup lives HERE (the route, which already has resolveDir()/snapshot
  // access), not in scenes.mjs's own createScene -- that store stays pure,
  // with zero graph/Foundry-facing access, per this module's own header
  // comment and scenes.test.mjs's own no-Foundry-import assertion. Only
  // guards when the referenced entity actually EXISTS and has a type other
  // than "place" -- an entityId scenes.mjs has never validated as a real FK
  // elsewhere either, so an unknown id is still allowed through unchanged.
  if (method === "POST" && parts.length === 3 && parts[1] === "session-planner" && parts[2] === "scenes") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    if (body.locationEntityId) {
      const dir = resolveDir();
      const { entities } = loadSnapshot(dir, w).snapshot;
      const locationEntity = findEntity(entities, body.locationEntityId);
      if (locationEntity && locationEntity.type !== "place") {
        throw new Error(
          `Scene locationEntityId "${body.locationEntityId}" must reference a "place" entity (found type "${locationEntity.type}").`
        );
      }
    }
    const scene = createScene(w, { locationEntityId: body.locationEntityId, objectiveNote: body.objectiveNote, name: body.name });
    return sendJson(res, 200, { scene });
  }

  // GET /api/session-planner/scenes?world=[&sort=recency]  -> { scenes }
  // Phase 30 task 30.4: a thin, read-only mirror of the existing
  // `GET /api/scene-planning/scenes` list (same underlying scenes.mjs store),
  // exposed under the `session-planner` prefix so the World surface's
  // "Create a scene here" flow can verify its just-created scene from the
  // same prefix it POSTed to. No new business logic -- wraps
  // listScenesByRecency/listScenesForWorld exactly like the sibling route.
  if (method === "GET" && parts.length === 3 && parts[1] === "session-planner" && parts[2] === "scenes") {
    const w = resolveWorld(q.get("world"));
    const scenes = q.get("sort") === "recency" ? listScenesByRecency(w) : listScenesForWorld(w);
    return sendJson(res, 200, { scenes });
  }

  // POST /api/session-planner/scenes/:id/fork  { world, locationEntityId?, objectiveNote?, name? }
  if (method === "POST" && parts.length === 5 && parts[1] === "session-planner" && parts[2] === "scenes" && parts[4] === "fork") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const scene = forkScene(w, parts[3], { locationEntityId: body.locationEntityId, objectiveNote: body.objectiveNote, name: body.name });
    return sendJson(res, 200, { scene });
  }

  // GET /api/session-planner/scenes/:id?world=...
  if (method === "GET" && parts.length === 4 && parts[1] === "session-planner" && parts[2] === "scenes") {
    const w = resolveWorld(q.get("world"));
    const scene = getScene(w, parts[3]);
    return sendJson(res, 200, { scene });
  }

  // POST /api/session-planner/scenes/:sceneId  { world, name?, objectiveNote?, mapAssetId? }  -> {scene}   Phase 29 task 29.1 -- patch-style update, independent optional fields (mirrors updateElement's own "only patch what's provided" convention). Length-4 path -- does not collide with the length-3 create route above, the length-5 fork/rename routes below, or the length-4 GET-by-id route (different method). Backs the scene page's inline objective edit. NOT a rename of the existing POST .../scenes/:id/rename route below (that stays name-only, unmodified).
  //
  // Friction Wave 1 W3b: `mapAssetId` joined the patch vocabulary -- link
  // (or clear, with null) ONE stagecraft map asset to this scene. The
  // cross-store validation lives HERE, not in scenes.mjs (that store stays
  // pure, same reasoning as the create route's place-type guard above): a
  // non-null mapAssetId must name an EXISTING stagecraft asset of
  // kind:'map' in this world -- an unknown id or a splash/music asset
  // throws a clear 400 rather than silently recording a dangling/wrong-kind
  // link the push path would later trip over.
  if (method === "POST" && parts.length === 4 && parts[1] === "session-planner" && parts[2] === "scenes") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    if (body.mapAssetId !== undefined && body.mapAssetId !== null) {
      const asset = getStagecraftAsset(w, body.mapAssetId); // throws the store's own clear "No stagecraft asset found" -> 400
      if (asset.kind !== "map") {
        throw new Error(
          `Scene mapAssetId "${body.mapAssetId}" must reference a kind:"map" stagecraft asset (found kind "${asset.kind}").`
        );
      }
    }
    const scene = updateScene(w, parts[3], {
      name: body.name, objectiveNote: body.objectiveNote, objectiveInRun: body.objectiveInRun, mapAssetId: body.mapAssetId,
      // Run layout keys (2026-08-26); the store validates shape.
      kind: body.kind, whereNote: body.whereNote, tags: body.tags, activeVariants: body.activeVariants
    });
    maybeScheduleFlush(w, scene); // Phase 36 task 36.2, §3 -- a direct scene-RECORD edit is a flush trigger too
    return sendJson(res, 200, { scene });
  }

  // POST /api/session-planner/scenes/:id/rename  { world, name }  -- Phase 26 task 26.2
  if (method === "POST" && parts.length === 5 && parts[1] === "session-planner" && parts[2] === "scenes" && parts[4] === "rename") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const scene = renameScene(w, parts[3], body.name ?? null);
    maybeScheduleFlush(w, scene); // Phase 36 task 36.2, §3
    return sendJson(res, 200, { scene });
  }

  // POST /api/session-planner/scenes/:id/stage  { world, staged:boolean }  -> {scene}
  // Phase 36 task 36.2, §2 -- thin wrapper: updateScene(w, id, {stagedForFoundry:!!body.staged}).
  // Unknown id -> the same "No scene found" 404 every other scene route
  // already produces (statusForError's /not found/i rule). Toggling `staged`
  // to true is one of the two flush TRIGGERS (§5); toggling it false
  // schedules nothing (maybeScheduleFlush is a no-op when the resulting
  // scene isn't staged).
  if (method === "POST" && parts.length === 5 && parts[1] === "session-planner" && parts[2] === "scenes" && parts[4] === "stage") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const scene = updateScene(w, parts[3], { stagedForFoundry: !!body.staged });
    maybeScheduleFlush(w, scene);
    return sendJson(res, 200, { scene });
  }

  // DELETE /api/session-planner/scenes/:sceneId   { world } (body or query, matching
  // the sibling members/plan-membership DELETE convention) -- Phase 27 task 27.1, F1.
  // A TRUE delete (scenes.mjs's deleteScene cascade) -- distinct from the plan-scoped
  // DELETE /api/scene-planning/plans/:planId/scenes/:sceneId unlink-only route below.
  if (method === "DELETE" && parts.length === 4 && parts[1] === "session-planner" && parts[2] === "scenes") {
    const body = await readBody(req);
    const w = resolveWorld(body.world ?? q.get("world"));
    const result = deleteScene(w, parts[3]);
    return sendJson(res, 200, result);
  }

  // GET /api/session-planner/brief?world=...&sceneId=...&corridorTolerance=...
  if (method === "GET" && parts.length === 3 && parts[1] === "session-planner" && parts[2] === "brief") {
    const w = resolveWorld(q.get("world"));
    const scene = getScene(w, q.get("sceneId"));
    const dir = resolveDir();
    const { entities, edges } = loadSnapshot(dir, w).snapshot;
    const corridorToleranceRaw = q.get("corridorTolerance");
    const corridorTolerance = corridorToleranceRaw ? Number(corridorToleranceRaw) : undefined;
    const brief = buildSessionBrief(w, { entities, edges }, scene, { corridorTolerance });
    return sendJson(res, 200, { brief });
  }

  // POST /api/session-planner/notes  { world, text, anchorEntityId?, sceneId? }
  if (method === "POST" && parts.length === 3 && parts[1] === "session-planner" && parts[2] === "notes") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const note = captureNote(w, { text: body.text, anchorEntityId: body.anchorEntityId, sceneId: body.sceneId });
    return sendJson(res, 200, { note });
  }

  // POST /api/session-planner/notes/intake  { world, noteIds }
  // Makes a real LLM call via proposeMentionedEntities (runBatchIntake) --
  // world format is validated (resolveWorld) BEFORE any of that runs.
  // QA W1 Fix 3 (found via the grep-driven audit, not one of the four
  // originally-named routes -- same underlying `{mentions:[]}` shape as the
  // scan-mentions route, so the same offline client is reused).
  if (method === "POST" && parts.length === 4 && parts[1] === "session-planner" && parts[2] === "notes" && parts[3] === "intake") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const dir = resolveDir();
    const { entities, edges, entityTypes } = loadSnapshot(dir, w).snapshot;
    const result = await runBatchIntake(w, body.noteIds ?? [], { entities, edges, entityTypes }, { llmOpts: offlineOpts(offlineScanMentionsClient) });
    return sendJson(res, 200, result);
  }

  // ---------------------------------------------------------------------
  // Phase 18 (task 18.7) -- Encounter Guidance engine routes. Bestiary
  // routes carry NO `world` concept at all (bestiary-store.mjs's own
  // per-user/library-wide storage decision) -- party-roster and
  // encounter-suggest routes ARE world-scoped via the same resolveWorld()
  // every other world-scoped route in this file already uses. No route
  // here accepts a client-supplied dataDir.
  // ---------------------------------------------------------------------

  // POST /api/combat-planning/bestiary/ingest   { text } or { pdfBase64 }
  // Library-wide -- deliberately no `world` parameter. Makes a real LLM
  // call via bestiary-ingest.mjs's extraction. QA W1 Fix 3: degrades to an
  // honest placeholder stat block (status 'proposed' -- reviewed/edited
  // before ever being usable) instead of throwing keyless.
  if (method === "POST" && parts.length === 4 && parts[1] === "combat-planning" && parts[2] === "bestiary" && parts[3] === "ingest") {
    const body = await readBody(req);
    const raw = body.pdfBase64
      ? await proposeBestiaryEntryFromPdf(body.pdfBase64, offlineOpts(offlineBestiaryIngestClient))
      : await proposeBestiaryEntryFromText(body.text, offlineOpts(offlineBestiaryIngestClient));
    const entry = saveBestiaryEntry({
      rawFields: raw,
      sourceText: body.pdfBase64 ? null : body.text,
      sourcePdfName: body.pdfBase64 ? (body.sourcePdfName ?? null) : null
    });
    return sendJson(res, 200, { entry });
  }

  // QA W2 fix (Group D #19): POST /api/combat-planning/bestiary/hand-add
  // { name, challengeRating?, ac?, hp?, notes? } -> {entry}. The "write one
  // by hand" affordance -- a real minimal form, not the dead div it used to
  // be. No LLM call anywhere on this path (unlike /ingest above): saves
  // rawFields straight through, ACCEPTS IMMEDIATELY (a hand-typed entry is a
  // deliberate authorship act, not a proposal needing review -- same
  // reasoning stagecraft-store.mjs's own header comment documents for its
  // hand-added rows), then attaches the optional note. deriveSourcePill
  // (bestiary-store.mjs) reads "mine" automatically -- no foundryActorRef,
  // no reskinOfEntryId, no "SRD" text anywhere on the entry.
  if (method === "POST" && parts.length === 4 && parts[1] === "combat-planning" && parts[2] === "bestiary" && parts[3] === "hand-add") {
    const body = await readBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new Error("POST /api/combat-planning/bestiary/hand-add: `name` is required.");
    if (name.length > 200) throw new Error("POST /api/combat-planning/bestiary/hand-add: `name` must be 200 characters or fewer.");
    let entry = saveBestiaryEntry({
      rawFields: {
        name,
        type: typeof body.type === "string" && body.type.trim() ? body.type.trim() : "Custom",
        ac: typeof body.ac === "number" ? body.ac : (body.ac ? Number(body.ac) : undefined),
        hp: typeof body.hp === "number" ? body.hp : (body.hp ? Number(body.hp) : undefined),
        challengeRating: body.challengeRating != null && body.challengeRating !== "" ? body.challengeRating : undefined
      }
    });
    entry = acceptBestiaryEntry(entry.id);
    if (typeof body.notes === "string" && body.notes.trim()) {
      entry = updateBestiaryEntryNote(entry.id, body.notes.trim());
    }
    return sendJson(res, 200, { entry });
  }

  // GET /api/combat-planning/bestiary   -- no `world` parameter (library-wide)
  if (method === "GET" && parts.length === 3 && parts[1] === "combat-planning" && parts[2] === "bestiary") {
    return sendJson(res, 200, { entries: listBestiaryEntries() });
  }

  // POST /api/combat-planning/bestiary/:id/accept
  if (method === "POST" && parts.length === 5 && parts[1] === "combat-planning" && parts[2] === "bestiary" && parts[4] === "accept") {
    const entry = acceptBestiaryEntry(parts[3]);
    return sendJson(res, 200, { entry });
  }

  // POST /api/combat-planning/bestiary/:id/discard
  if (method === "POST" && parts.length === 5 && parts[1] === "combat-planning" && parts[2] === "bestiary" && parts[4] === "discard") {
    const entry = discardBestiaryEntry(parts[3]);
    return sendJson(res, 200, { entry });
  }

  // -----------------------------------------------------------------------
  // Friction Wave 1 W4a -- the "Available via Plutonium" read-only source
  // layer. Library-wide like the bestiary routes (no `world` -- the bundled
  // module data isn't world-scoped), dataDir via resolveDir() ONLY (same
  // no-client-dataDir rule as every route in this file). READ-ONLY: this
  // route never touches the curated shelf; W4c's explicit per-creature
  // add-from-plutonium route below is the only bridge.
  // -----------------------------------------------------------------------

  // GET /api/combat-planning/plutonium?query=&crMin=&crMax=&type=&source=&offset=&limit=
  // -> { installed, files, count, matched, offset, limit, creatures, facets }
  // Server-side filter + window (limit default 50, cap 500) so the ~4k-row
  // index never rides one response; `installed:false` (with empty
  // creatures/facets) is the graceful "Plutonium isn't installed" state,
  // a 200, never an error.
  if (method === "GET" && parts.length === 3 && parts[1] === "combat-planning" && parts[2] === "plutonium") {
    const dir = resolveDir();
    const index = loadPlutoniumIndex(dir);
    const num = (v) => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const page = searchPlutoniumIndex(index.creatures, {
      query: q.get("query") ?? "",
      type: q.get("type"),
      source: q.get("source"),
      crMin: num(q.get("crMin")),
      crMax: num(q.get("crMax")),
      offset: num(q.get("offset")) ?? 0,
      limit: num(q.get("limit")) ?? 50
    });
    return sendJson(res, 200, {
      installed: index.installed,
      files: index.files,
      count: index.count,
      ...page,
      facets: plutoniumFacets(index.creatures)
    });
  }

  // W4c: POST /api/combat-planning/bestiary/add-from-plutonium
  // { name, source } -> {entry}. THE one explicit bridge from the read-only
  // Plutonium source layer onto the curated shelf: creates an ACCEPTED
  // bestiary entry (a deliberate per-creature act, same "hand-add accepts
  // immediately" reasoning as the sibling hand-add route) with the index
  // row's real stats mapped into rawFields and a "SOURCE pPAGE via
  // Plutonium" provenance note (also sourceText -- what deriveSourcePill's
  // new "plutonium" branch keys on). DEDUPE GUARD: adding the same
  // (name, source) creature twice -> 409 ("already exists" -> statusForError),
  // matched against non-discarded entries carrying the exact same
  // provenance line -- a DISCARDED earlier copy doesn't block a re-add.
  // Importing the actor into Foundry stays a manual Plutonium act at prep
  // time -- this writes GM_Tools's own catalog row only, nothing
  // Foundry-facing.
  if (method === "POST" && parts.length === 4 && parts[1] === "combat-planning" && parts[2] === "bestiary" && parts[3] === "add-from-plutonium") {
    const body = await readBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const source = typeof body.source === "string" ? body.source.trim() : "";
    if (!name || !source) {
      throw new Error("POST /api/combat-planning/bestiary/add-from-plutonium: `name` and `source` are both required (the dataset's identity pair).");
    }
    const dir = resolveDir();
    const creature = findPlutoniumCreature(dir, { name, source });
    if (!creature) {
      throw new Error(`No Plutonium creature matches name="${name}" source="${source}" (is Plutonium installed, and is the pair exactly as the shelf lists it?).`);
    }
    const provenance = `${creature.source}${creature.page != null ? ` p${creature.page}` : ""} via Plutonium`;
    const duplicate = listBestiaryEntries().find(
      (e) => e.status !== "discarded" && e.rawFields?.name === creature.name && e.sourceText === provenance
    );
    if (duplicate) {
      throw new Error(
        `Bestiary entry "${creature.name}" (${provenance}) already exists on the curated shelf (id "${duplicate.id}") -- not adding a second copy.`
      );
    }
    const rawFields = {
      name: creature.name,
      type: creature.type ? (creature.tags?.length ? `${creature.type} (${creature.tags.join(", ")})` : creature.type) : "Unknown",
      ...(creature.ac != null ? { ac: creature.ac } : {}),
      ...(creature.hp != null ? { hp: creature.hp } : {}),
      ...(creature.cr != null ? { challengeRating: creature.cr } : {}),
      ...(creature.size?.length ? { size: creature.size.join("/") } : {}),
      ...(creature.environment?.length ? { environment: creature.environment.join(", ") } : {}),
      ...(creature.legendary ? { legendary: true } : {})
    };
    let entry = saveBestiaryEntry({ rawFields, sourceText: provenance });
    entry = acceptBestiaryEntry(entry.id);
    entry = updateBestiaryEntryNote(entry.id, provenance);
    return sendJson(res, 200, { entry });
  }

  // POST /api/combat-planning/party-roster/ingest   { world, text } or { world, pdfBase64 }
  // World-scoped -- resolveWorld(body.world), no client-supplied dataDir.
  // Makes a real LLM call via party-roster-ingest.mjs's extraction. QA W1
  // Fix 3 (grep-driven audit): degrades to an honest placeholder name
  // instead of throwing keyless.
  if (method === "POST" && parts.length === 4 && parts[1] === "combat-planning" && parts[2] === "party-roster" && parts[3] === "ingest") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const raw = body.pdfBase64
      ? await proposePartyMemberFromPdf(body.pdfBase64, offlineOpts(offlinePartyRosterIngestClient))
      : await proposePartyMemberFromText(body.text, offlineOpts(offlinePartyRosterIngestClient));
    const member = savePartyMember(w, {
      name: raw.name,
      combatRelevant: raw.combatRelevant,
      buildRelevant: raw.buildRelevant,
      sourceText: body.pdfBase64 ? null : body.text,
      sourcePdfName: body.pdfBase64 ? (body.sourcePdfName ?? null) : null
    });
    return sendJson(res, 200, { member });
  }

  // QA W2 fix (Group D #19): POST /api/combat-planning/party-roster/hand-add
  // { world, name, class?, level?, ac?, hp? } -> {member}. Same "write one
  // by hand" pattern as the bestiary route above -- no LLM call,
  // savePartyMember's own default status:'accepted' already lands it
  // immediately (no separate accept step needed), and foundryActorRef stays
  // null so it reads as "mine" (heroCard's own `m.foundryActorRef ? ... :
  // "mine"` projection).
  if (method === "POST" && parts.length === 4 && parts[1] === "combat-planning" && parts[2] === "party-roster" && parts[3] === "hand-add") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new Error("POST /api/combat-planning/party-roster/hand-add: `name` is required.");
    if (name.length > 200) throw new Error("POST /api/combat-planning/party-roster/hand-add: `name` must be 200 characters or fewer.");
    const combatRelevant = {};
    if (typeof body.class === "string" && body.class.trim()) combatRelevant.class = body.class.trim();
    if (body.level != null && body.level !== "") combatRelevant.level = Number(body.level);
    if (body.ac != null && body.ac !== "") combatRelevant.ac = Number(body.ac);
    if (body.hp != null && body.hp !== "") combatRelevant.hp = Number(body.hp);
    const member = savePartyMember(w, { name, combatRelevant, buildRelevant: {} });
    return sendJson(res, 200, { member });
  }

  // GET /api/combat-planning/party-roster?world=...
  if (method === "GET" && parts.length === 3 && parts[1] === "combat-planning" && parts[2] === "party-roster") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { members: listPartyMembers(w) });
  }

  // -----------------------------------------------------------------------
  // Phase 32 task 32.2 -- Foundry PULL slice, the phase's primary
  // deliverable. Thin wrapper ONLY (per gm-tools-conventions' "front-ends
  // are thin wrappers, never logic duplicators") -- all classify/map/upsert
  // logic lives in wf-mcp-server/lib/foundry-pull-ops.mjs, shared verbatim
  // with wf-mcp-server/index.mjs's wf_pull_foundry_actors tool. Kept
  // tightly localized/commented here: task 32.3 (a LATER, separate task)
  // adds a SIBLING push route near this same block -- do not intermix the
  // two when that lands, keep each op's route self-contained like this one.
  // -----------------------------------------------------------------------

  // POST /api/foundry/pull-actors   { world }
  // Reads worlds/<world>/world-fabric-foundry-index.json (written by the
  // Foundry-side module's Reindex-for-GM_Tools flow, task 32.1 -- a
  // SEPARATE repo, not built here) and review-gates every actor into the
  // EXISTING bestiary/party-roster stores as status:'proposed'. Response
  // 200: { indexFound, bestiaryProposed, partyProposed, alreadyLinked, skippedActors }
  // -- see foundry-pull-ops.mjs's own header comment for the full
  // dedup/re-ingest contract. World-scoped, resolveWorld(body.world), no
  // client-supplied dataDir honored (same convention as every other route
  // in this file).
  if (method === "POST" && parts.length === 3 && parts[1] === "foundry" && parts[2] === "pull-actors") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    // Phase 38 task 38.2, §4 -- reconcile any late-arriving import result
    // FIRST, same "natural call site" reasoning as the accept route above,
    // so a re-pull's compendiumRef dedup (foundry-pull-ops.mjs's
    // upsertCompendiumBrowseRow) sees an already-imported row's CURRENT
    // (possibly just-reconciled) accepted status rather than a stale
    // still-proposed one.
    reconcilePendingCompendiumImports(dir, w);
    const result = pullFoundryActorsToStores(dir, w);
    return sendJson(res, 200, result);
  }

  // POST /api/foundry/push-scene   { world, sceneId, mapSrc?, name?, width?, height? }
  // The thin PUSH slice (task 32.3): writes a `create_scene` op onto
  // worlds/<world>/world-fabric-foundry-ops.json (plans/phase-32-bridge-
  // contract.md §2) and polls briefly (mirrors the existing sync/rollback
  // routes' own live-Foundry poll convention) for the Foundry-side watcher
  // (task 32.1, a SEPARATE repo, not built here) to apply it and echo back a
  // result. Response 200 either way:
  //   - { status:'queued', sceneId, opId, note }              -- no live
  //     Foundry client picked this batch up within the poll window.
  //   - { status:'applied', sceneId, opId, ok:true, foundryUuid, scene }
  //     -- the pushed scene's `foundrySceneRef` was written.
  //   - { status:'applied', sceneId, opId, ok:false, error }  -- Foundry
  //     itself reported a failure for this op; no ref written.
  // World-scoped, resolveWorld(body.world), no client-supplied dataDir
  // honored (same convention as every other route in this file). W3c:
  // `mapSrc` is now an OPTIONAL override -- omitted, pushSceneToFoundry
  // defaults it from the scene's linked map asset (scene.mapAssetId ->
  // asset.src, else foundryRef.imagePath; see that module's own header
  // comment). An unknown sceneId, or no mapSrc AND no resolvable linked
  // asset, throws -- same clean 400 as every other validation error in
  // this file (statusForError).
  if (method === "POST" && parts.length === 3 && parts[1] === "foundry" && parts[2] === "push-scene") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    if (!body.sceneId) throw new Error("POST /api/foundry/push-scene requires sceneId.");
    const result = await pushSceneToFoundry(dir, w, body.sceneId, {
      mapSrc: body.mapSrc,
      name: body.name,
      width: body.width,
      height: body.height
    });
    return sendJson(res, 200, result);
  }

  // -----------------------------------------------------------------------
  // Phase 34 task 34.1 -- Connection-Menu backend glue. Pre-specified route/
  // store contract, plans/phase-34-tasks.md ("orchestrator-locked so 34.0's
  // e2e ∥ this task can be built in parallel against the SAME shapes").
  // -----------------------------------------------------------------------

  // GET /api/foundry/connection?world=...
  // -> {state:'live'|'stale'|'off', exportedAt, ageMs, staleThresholdMs,
  //     counts:{actors,items,scenes,journals}|null, lastSync:{at,ok,error?}|null, world}
  // Thin wrapper over foundry-connection.mjs's deriveConnectionState; the
  // stale threshold is read from the per-world app-settings store when set
  // (falls back to deriveConnectionState's own DEFAULT_STALE_THRESHOLD_MS
  // otherwise), never from a client-supplied query param -- same
  // "settings are server-resolved, never client-overridden" convention as
  // every other route in this file.
  if (method === "GET" && parts.length === 3 && parts[1] === "foundry" && parts[2] === "connection") {
    const dir = resolveDir();
    const w = resolveWorld(q.get("world"));
    const settings = getAppSettings(w);
    const opts = settings.staleThresholdMs !== undefined ? { staleThresholdMs: settings.staleThresholdMs } : {};
    return sendJson(res, 200, deriveConnectionState(dir, w, opts));
  }

  // POST /api/foundry/sync-now  { world }
  // -> {state:'off', message} (no index yet -- 200, NOT a throw/block) or
  //    {pulled:{bestiaryProposed,partyProposed,alreadyLinked}, indexAgeMs, state}.
  // Composition (foundry-connection.mjs's syncNow): read the index (never
  // blocks on a live Foundry client) -> pullFoundryActorsToStores (the
  // EXISTING, unmodified review-gated ingest) -> append a sync-log entry.
  // Reindex triggering itself stays Foundry-side (api.reindexForGmTools()),
  // documented here, not performed by this route.
  if (method === "POST" && parts.length === 3 && parts[1] === "foundry" && parts[2] === "sync-now") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    return sendJson(res, 200, await syncNow(dir, w));
  }

  // GET /api/settings?world=...  -> the full stored AppSettings object (session-planner/app-settings.mjs)
  if (method === "GET" && parts.length === 2 && parts[1] === "settings") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, getAppSettings(w));
  }

  // POST /api/settings  { world, ...patch }  -- shallow patch, only the
  // supplied keys change (patchSettings). `world`/`dataDir` are stripped
  // before the remaining body is validated as an AppSettings patch.
  if (method === "POST" && parts.length === 2 && parts[1] === "settings") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const { world: _world, dataDir: _dataDir, ...patch } = body;
    return sendJson(res, 200, patchAppSettings(w, patch));
  }

  // POST /api/lore/worldanvil  { world, url }
  // -> the same response shape POST /api/writeup-propose (below) returns for
  // a pasted writeup -- the new review batch's own id, mutationCount,
  // importSummary, suggestions, headline -- since this route delegates to
  // the SAME importWriteup pipeline. Server-side fetch of `url`, HTML-
  // stripped to text, capped at MAX_WRITEUP_CHARS (truncated, not rejected
  // -- see worldanvil-intake.mjs's own header). An unreachable/non-2xx URL
  // throws a WorldAnvilFetchError, which falls through statusForError's
  // default branch to a clean 400 (no special-case needed there).
  if (method === "POST" && parts.length === 3 && parts[1] === "lore" && parts[2] === "worldanvil") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    if (typeof body.url !== "string" || !body.url.trim()) {
      throw new Error("POST /api/lore/worldanvil requires a non-empty `url`.");
    }
    const existingSnapshot = loadSnapshot(dir, w).snapshot;
    const result = await importFromWorldAnvil(w, body.url, existingSnapshot);
    return sendJson(res, 200, result);
  }

  // POST /api/combat-planning/encounter-suggest
  //   { world, targetDifficulty, sceneEntityId, knobs?, themeText?, attendingMemberIds?, manualCombination? }
  // World format IS validated (resolveWorld) BEFORE any LLM call runs.
  // dataDir is NEVER honored from the client -- resolveDir() with no
  // argument, same as every other route in this file.
  //
  // Phase 18 addendum (QA pass found during Phase 19 task 19.0's
  // test-authoring pass -- see review-ui/test/e2e/combat-planning-fixture.mjs's
  // header comment for the full, authoritative contract this implements):
  // as originally shipped, this route unconditionally called
  // thematic-filter.mjs's proposeThematicTags (a real LLM call) on EVERY
  // request, always against the FULL roster, with no way to score an
  // explicit DM-picked combination -- contradicting plans/phase-19-review.md
  // §2's "deterministic, local, instant, zero LLM calls except the ingestion
  // screen and an explicit, optional theme box" design claim. Three new
  // OPTIONAL, backward-compatible request fields fix this -- a caller using
  // only the original request shape (world/targetDifficulty/sceneEntityId/
  // knobs) still gets a valid { suggestion } response, no new failure mode
  // introduced, per combat-planning-fixture.mjs's own contract:
  //   - themeText: omitted/blank/whitespace-only => proposeThematicTags is
  //     SKIPPED ENTIRELY, candidatePool is the full accepted-bestiary pool
  //     (the same status:"accepted"-only pool the Phase 19 catalog browses),
  //     zero LLM calls -- this IS the new default, deliberately, since the
  //     whole point of this fix is that ordinary difficulty-rail/knob/
  //     attendance interactions never need one. Non-empty => the original
  //     shipped behavior, unchanged (a real proposeThematicTags call,
  //     narrowing that same pool by theme fit).
  //   - attendingMemberIds: when present, `party` is listPartyMembers(w)
  //     filtered to only these ids. Omitted => the full roster, unchanged.
  //   - manualCombination: when present, scores EXACTLY this combination
  //     (via encounter-heuristic.mjs's scoreCombination, applying `knobs` and
  //     computing burstCeiling/snowballDelta/asymmetricRiskFlag the IDENTICAL
  //     way suggestEncounter's own auto-fill does) instead of auto-building
  //     one via targetDifficulty -- looked up against the full accepted
  //     bestiary (not the theme-filtered pool, since a manual pick is an
  //     already-made catalog choice, not something theme-fit should
  //     silently exclude). The response's `combination` echoes back exactly
  //     what was sent. Omitted => the original shipped auto-fill behavior.
  if (method === "POST" && parts.length === 3 && parts[1] === "combat-planning" && parts[2] === "encounter-suggest") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const dir = resolveDir();

    const themeText = typeof body.themeText === "string" ? body.themeText.trim() : "";
    const acceptedPool = () =>
      listBestiaryEntries()
        .filter((e) => e.status === "accepted")
        .map((e) => ({ entryId: e.id, rawFields: e.rawFields, derivedScore: e.derivedScore }));

    let candidatePool;
    if (themeText) {
      // Task 20.5 -- CONFIRMED ROOT CAUSE (reproduced directly, not guessed):
      // this branch used to call loadSnapshot(dir, w) UNCONDITIONALLY, which
      // throws ("No World Fabric snapshot found for world ...") the instant
      // that world has never had a WF snapshot exported -- but Encounter
      // Builder is DELIBERATELY NOT graph-backed (design record §1a,
      // confirmed by review-ui/test/e2e/combat-planning-fixture.mjs's own
      // primeWorldSelection header: "combat-planning's bestiary/party-roster
      // stores are deliberately NOT graph-backed... this suite has no
      // snapshot file for GET /api/worlds to discover at all"), and
      // review-ui/public/combat-planning-view.js's onThemeSubmit never sends
      // a sceneEntityId at all (the Encounter Builder view has no scene
      // concept anywhere) -- so the snapshot, when it does exist, was never
      // even being used for anything beyond an always-absent sceneEntityId
      // lookup. The result: narrowing by theme threw a hard 400 for any
      // world without a live/ever-exported WF snapshot -- exactly the
      // real-world "just using Encounter Builder standalone" case -- instead
      // of ever reaching proposeThematicTags at all. Degrade gracefully
      // instead: only load the snapshot (for the optional scene-grounding
      // context) when one actually exists on disk; otherwise proceed with an
      // ungrounded sceneContext, matching buildAdjacencyContext's own
      // existing "degrade to the raw id rather than throwing" convention for
      // an unresolvable entityId.
      let sceneContext = { entityLabel: undefined, neighborDescriptions: [] };
      if (existsSync(snapshotFilePath(dir, w))) {
        const { entities, edges } = loadSnapshot(dir, w).snapshot;
        sceneContext = buildAdjacencyContext(entities, edges, body.sceneEntityId, DEFAULT_ENTITY_NARRATE_DEPTH);
      }
      const fullPool = listBestiaryEntries().map((e) => ({ entryId: e.id, rawFields: e.rawFields, derivedScore: e.derivedScore }));
      // QA W1 Fix 3 (grep-driven audit): degrades to "pass the whole pool
      // through unfiltered" instead of throwing keyless.
      const { filteredEntryIds } = await proposeThematicTags(sceneContext, fullPool, offlineOpts(offlineThematicFilterClient));
      const filteredIdSet = new Set(filteredEntryIds);
      candidatePool = fullPool.filter((c) => filteredIdSet.has(c.entryId));
    } else {
      candidatePool = acceptedPool();
    }

    let party = listPartyMembers(w);
    if (Array.isArray(body.attendingMemberIds)) {
      const attendingSet = new Set(body.attendingMemberIds);
      party = party.filter((m) => attendingSet.has(m.id));
    }
    // Phase 19 task 19.6 addition (small, additive, backward-compatible --
    // same category of change as the three fields above): `hpOverrides`
    // ({memberId: hp}) substitutes a WORKING-SESSION hp value into scoring
    // for this request ONLY -- never written back to party-roster-store.mjs.
    // review-ui/public/combat-planning-view.js's Resync-from-Foundry button
    // is the one caller; see that file's header for the full grounding on
    // why this (rather than a persisted write) is the correct shape for
    // "working session, not persisted record."
    if (body.hpOverrides && typeof body.hpOverrides === "object") {
      party = party.map((m) =>
        Object.prototype.hasOwnProperty.call(body.hpOverrides, m.id) && typeof body.hpOverrides[m.id] === "number"
          ? { ...m, combatRelevant: { ...m.combatRelevant, hp: body.hpOverrides[m.id] } }
          : m
      );
    }

    const suggestion = Array.isArray(body.manualCombination)
      ? scoreCombination({
          combination: body.manualCombination,
          // manualCombination is looked up against the full accepted pool,
          // not the (possibly theme-filtered) candidatePool above -- an
          // already-made manual catalog pick must never be silently dropped
          // for not matching the theme. When themeText was blank,
          // candidatePool IS already exactly this pool -- reused rather than
          // re-read.
          candidatePool: themeText ? acceptedPool() : candidatePool,
          party,
          knobs: body.knobs ?? {}
        })
      : suggestEncounter({
          targetDifficulty: body.targetDifficulty,
          candidatePool,
          party,
          knobs: body.knobs ?? {}
        });
    return sendJson(res, 200, { suggestion });
  }

  // ---------------------------------------------------------------------
  // Phase 22 (task 22.7) -- Scene Engine routes, prefix `/api/scene-planning/*`
  // matching session-planner's own `/api/session-planner/*` and
  // combat-planning's own `/api/combat-planning/*` precedent exactly. Every
  // route below is a thin wrapper over the corresponding session-planner/ or
  // mutation-engine/ module (22.1-22.6) -- resolveWorld()/resolveDir() with
  // NO client-supplied dataDir override anywhere below, and `world` is
  // always resolved (and so validated) before any snapshot read, store
  // write, or LLM-touching call for that route.
  // ---------------------------------------------------------------------

  // GET /api/scene-planning/scenes?world=&sort=recency
  // Phase 24 task 24.1 -- thin wrapper over listScenesForWorld, the one real
  // gap plans/phase-24-tasks.md's grounding pass found: Phase 22 shipped
  // linkage/transit/membership/undo/develop/quick-gen routes but never
  // exposed scenes.mjs's own listScenesForWorld over HTTP. No new store
  // logic here, same resolveWorld()/resolveDir() convention (no
  // client-supplied dataDir) as every other route in this file.
  // Phase 30 task 30.1: `sort=recency` switches to listScenesByRecency
  // (most-recently-touched first) -- the World scene-tray's own ordering
  // need. Omitted/anything else keeps the original creation-order default,
  // byte-identical to before this change.
  if (method === "GET" && parts.length === 3 && parts[1] === "scene-planning" && parts[2] === "scenes") {
    const w = resolveWorld(q.get("world"));
    const scenes = q.get("sort") === "recency" ? listScenesByRecency(w) : listScenesForWorld(w);
    return sendJson(res, 200, { scenes });
  }

  // Phase 28 task 28.5 removed GET /api/scene-planning/linkage (+ its
  // session-planner/scene-linkage.mjs import): the Scenes tab's "linked
  // scenes" panel that was its only real consumer is replaced by the
  // read-only "In plans" chip row (GET /api/scene-planning/scenes/:sceneId/
  // plans, below) -- scene-to-scene linking is dropped entirely, per the
  // design record.

  // POST /api/scene-planning/transit-entity   { world, fromEntityId, toEntityId, name? }
  if (method === "POST" && parts.length === 3 && parts[1] === "scene-planning" && parts[2] === "transit-entity") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const dir = resolveDir();
    const entity = await createTransitEntity(dir, w, {
      fromEntityId: body.fromEntityId,
      toEntityId: body.toEntityId,
      name: body.name
    });
    return sendJson(res, 200, { entity });
  }

  // Phase 22's scene-membership `.../members` (GET/POST/DELETE) +
  // `.../intervening-offer` routes were RETIRED in Phase 33 task 33.1 --
  // scene contents are now unified as scene-elements (see
  // session-planner/scene-elements.mjs's attachExistingNodeAsElement +
  // POST .../elements/from-graph below); the membership store itself is
  // deleted (session-planner/scene-membership.mjs, test/scene-planning/
  // scene-membership.test.mjs).

  // POST /api/scene-planning/scenes/:sceneId/undo/start   { world }
  if (method === "POST" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "undo" && parts[5] === "start") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const session = startSceneUndoSession(w, parts[3]);
    return sendJson(res, 200, { session });
  }

  // GET /api/scene-planning/scenes/:sceneId/undo?world=   (peek/list)
  if (method === "GET" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "undo") {
    const w = resolveWorld(q.get("world"));
    const actions = listSceneUndoActions(w, parts[3]);
    return sendJson(res, 200, { actions });
  }

  // POST /api/scene-planning/scenes/:sceneId/undo/record  { world, action }
  if (method === "POST" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "undo" && parts[5] === "record") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const session = recordSceneUndoAction(w, parts[3], body.action);
    return sendJson(res, 200, { session });
  }

  // POST /api/scene-planning/scenes/:sceneId/undo/last    { world }
  if (method === "POST" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "undo" && parts[5] === "last") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const action = undoLastSceneAction(w, parts[3]);
    return sendJson(res, 200, { action });
  }

  // POST /api/scene-planning/scenes/:sceneId/undo/all     { world }
  if (method === "POST" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "undo" && parts[5] === "all") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const actions = undoAllSceneActions(w, parts[3]);
    return sendJson(res, 200, { actions });
  }

  // POST /api/scene-planning/scenes/:sceneId/undo/clear   { world }
  if (method === "POST" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "undo" && parts[5] === "clear") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    clearSceneUndoSession(w, parts[3]);
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/scene-planning/scenes/:sceneId/develop   { world, memberEntityIds, selections?, reframeMemberIds?, priorRoundCounts? }
  // Makes real LLM calls transitively (via the prep-content operations
  // module) -- world is resolved/validated FIRST, before any of that runs.
  if (method === "POST" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "develop") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const dir = resolveDir();
    const result = await developScene(dir, w, parts[3], body.memberEntityIds ?? [], {
      selections: body.selections,
      reframeMemberIds: body.reframeMemberIds,
      priorRoundCounts: body.priorRoundCounts
    });
    return sendJson(res, 200, result);
  }

  // POST /api/scene-planning/quick-gen   { world, prompt, anchorEntityId? }
  // Makes a real LLM call -- world is resolved/validated FIRST, before any of that runs.
  //
  // Phase 37.6 task 4 (graph-context census): quick-gen's whole design point
  // is the mid-session ad-hoc "+" flow for an UNTETHERED scene ("a quick-gen
  // scene has no real-world anchor to chain to", scene-construction-fixture
  // .mjs's own §8) -- as of this writing it has no live frontend caller at
  // all (28.5's rework scrapped the chain/table UI that used to call it), so
  // there is no "anchor entity in play" TODAY. `anchorEntityId` is added here
  // additive/optional so this route's contract is ready the moment a caller
  // (a revived quick-gen control, a wf-mcp tool) DOES have one in play: when
  // supplied, the caller's own composed prompt is grounded with real graph
  // context via the SAME shared `buildAdjacencyContext` (narrate.mjs) this
  // project's other entity-centric LLM calls use, rather than quick-gen
  // staying context-free by omission. Omitting it keeps today's exact
  // behavior (quickGenerate still does no templating of its own).
  if (method === "POST" && parts.length === 3 && parts[1] === "scene-planning" && parts[2] === "quick-gen") {
    const body = await readBody(req);
    const w = resolveWorld(body.world); // validated for security parity with every other route; quickGenerate itself carries no world concept
    let prompt = body.prompt;
    if (body.anchorEntityId) {
      const { entities, edges } = loadSnapshot(resolveDir(), w).snapshot;
      prompt = groundPromptWithAnchor(body.prompt, entities, edges, body.anchorEntityId);
    }
    // QA W1 Fix 3 (grep-driven audit): degrades to a clean placeholder text
    // instead of throwing keyless.
    const result = await quickGenerate(prompt, offlineOpts(offlineQuickGenClient));
    return sendJson(res, 200, result);
  }

  // -----------------------------------------------------------------------
  // Phase 22 ADDENDUM -- "Add Encounter" persistence, same
  // `/api/scene-planning/scenes/:sceneId/*` prefix/style as this file's
  // Phase 22 `.../members` routes above (mirrored deliberately, not a new
  // convention). Thin wrappers over combat-planning/saved-encounter.mjs
  // (22.7-addendum) -- resolveWorld()/resolveDir() with NO client-supplied
  // dataDir override, same as every route in this block.
  // -----------------------------------------------------------------------

  // POST /api/scene-planning/scenes/:sceneId/encounters   { world, name?, combination, knobs?, scoreSnapshot? }
  if (method === "POST" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "encounters") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const encounter = saveEncounter(w, parts[3], {
      name: body.name,
      combination: body.combination,
      knobs: body.knobs,
      scoreSnapshot: body.scoreSnapshot
    });
    return sendJson(res, 200, { encounter });
  }

  // GET /api/scene-planning/scenes/:sceneId/encounters?world=
  if (method === "GET" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "encounters") {
    const w = resolveWorld(q.get("world"));
    const encounters = listEncountersForScene(w, parts[3]);
    return sendJson(res, 200, { encounters });
  }

  // Phase 27 task 27.2, F11 -- GET /api/scene-planning/encounters?world=
  // The world-picker feed (3-part path, distinct from the 5-part
  // scene-scoped GET above): every saved-encounter DEFINITION for the world,
  // each appearing exactly once regardless of how many scenes reference it.
  if (method === "GET" && parts.length === 3 && parts[1] === "scene-planning" && parts[2] === "encounters") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { encounters: listEncountersForWorld(w) });
  }

  // Phase 27 task 27.2, F11 -- POST /api/scene-planning/scenes/:sceneId/encounters/:encounterId/attach   { world }
  // Attaches an EXISTING encounter definition to this scene (a shared
  // reference -- not a re-saved copy). Idempotent.
  if (method === "POST" && parts.length === 7 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "encounters" && parts[6] === "attach") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const encounter = attachEncounterToScene(w, parts[5], parts[3]);
    return sendJson(res, 200, { encounter });
  }

  // DELETE /api/scene-planning/scenes/:sceneId/encounters/:encounterId   { world } (query or body, matching the sibling members route's own convention)
  // Phase 27 task 27.2, F11 -- REDEFINED as detach-from-this-scene (removes
  // ONLY this scene's membership), NOT delete-the-definition -- a shared
  // encounter definition still referenced by another scene survives.
  if (method === "DELETE" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "encounters") {
    const body = await readBody(req);
    const w = resolveWorld(body.world ?? q.get("world"));
    const encounter = detachEncounterFromScene(w, parts[5], parts[3]);
    return sendJson(res, 200, { encounter });
  }

  // -----------------------------------------------------------------------
  // Phase 26 task 26.1 -- Plan store routes, prefix `/api/scene-planning/
  // plans/*`, matching this file's established `/api/scene-planning/*`
  // prefix (Phase 22) exactly. Thin wrappers over session-planner/plans.mjs
  // only -- no independent business logic here, per gm-tools-conventions.
  // -----------------------------------------------------------------------

  // POST /api/scene-planning/plans   { world, name }
  if (method === "POST" && parts.length === 3 && parts[1] === "scene-planning" && parts[2] === "plans") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const plan = createPlan(w, { name: body.name });
    return sendJson(res, 200, { plan });
  }

  // GET /api/scene-planning/plans?world=
  // QA W2 skip (documented, not built -- representative of every list route
  // in this file): an unknown/never-created world id returns 200 + [] here,
  // same as everywhere else, DELIBERATELY -- a world only ever exists as an
  // on-disk snapshot/store file, so "no rows yet" and "world doesn't exist"
  // are indistinguishable at the storage layer, and treating an unknown
  // world as a 404 would also 404 every legitimate first-ever list call for
  // a brand-new world before its first write. Not revisited this wave.
  if (method === "GET" && parts.length === 3 && parts[1] === "scene-planning" && parts[2] === "plans") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { plans: listPlansForWorld(w) });
  }

  // GET /api/scene-planning/plans/:planId?world=
  if (method === "GET" && parts.length === 4 && parts[1] === "scene-planning" && parts[2] === "plans") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { plan: getPlan(w, parts[3]) });
  }

  // POST /api/scene-planning/plans/:planId/scenes   { world, sceneId }
  if (method === "POST" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "plans" && parts[4] === "scenes") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const plan = addSceneToPlan(w, parts[3], body.sceneId);
    return sendJson(res, 200, { plan });
  }

  // DELETE /api/scene-planning/plans/:planId/scenes/:sceneId   { world } (body or query, matching scene-membership's own DELETE convention)
  if (method === "DELETE" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "plans" && parts[4] === "scenes") {
    const body = await readBody(req);
    const w = resolveWorld(body.world ?? q.get("world"));
    const plan = removeSceneFromPlan(w, parts[3], parts[5]);
    return sendJson(res, 200, { plan });
  }

  // Phase 30 task 30.5 -- POST /api/scene-planning/plans/:planId/rename   { world, name }   -> {plan}   thin wrapper over renamePlan (mirrors the sibling POST /api/session-planner/scenes/:id/rename route one entity type over). Backs the runsheet's editable plan title. Length-5 path, parts[4]==="rename" -- does not collide with the length-5 /scenes or /reorder routes (different parts[4]).
  if (method === "POST" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "plans" && parts[4] === "rename") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const plan = renamePlan(w, parts[3], body.name ?? null);
    return sendJson(res, 200, { plan });
  }

  // Phase 28 task 28.2, §E -- POST /api/scene-planning/plans/:planId/reorder   { world, sceneIds }   -> {plan}   thin wrapper over reorderPlanScenes (validates sceneIds is a permutation of the plan's current sceneIds, throws a clear error otherwise -- surfaced as a normal sendError non-200 response, same as every other thrown-Error route in this file).
  if (method === "POST" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "plans" && parts[4] === "reorder") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const plan = reorderPlanScenes(w, parts[3], body.sceneIds);
    return sendJson(res, 200, { plan });
  }

  // Phase 28 task 28.1 -- DELETE /api/scene-planning/plans/:planId   { world } (body or query, matching this file's own established DELETE convention). Idempotent -- an unknown/already-deleted planId returns {deleted:false}, never 500. Removes ONLY the Plan record; every scene it referenced survives untouched.
  if (method === "DELETE" && parts.length === 4 && parts[1] === "scene-planning" && parts[2] === "plans") {
    const body = await readBody(req);
    const w = resolveWorld(body.world ?? q.get("world"));
    const result = deletePlan(w, parts[3]);
    return sendJson(res, 200, result);
  }

  // Phase 28 task 28.1 -- GET /api/scene-planning/scenes/:sceneId/plans?world=   -> {plans:[...]} every FULL Plan record containing this scene, in listPlansForWorld's own stable append order. [] for an orphaned scene -- never a 404.
  if (method === "GET" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "plans") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { plans: plansContainingScene(w, parts[3]) });
  }

  // Phase 30 task 30.1 -- GET /api/scene-planning/entities/:entityId/scenes?world=
  // -> {appearances:[{scene, roles}]}   the World inspector's "appears in"
  // reverse lookup (scenesForEntity, session-planner/scene-lookup.mjs).
  // [] for a node that appears in no scene -- never a 404, same
  // "absence is a valid state" convention as plansContainingScene above.
  if (method === "GET" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "entities" && parts[4] === "scenes") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { appearances: scenesForEntity(w, parts[3]) });
  }

  // -----------------------------------------------------------------------
  // Phase 28 task 28.1 -- per-scene ordered elements, prefix
  // `/api/scene-planning/scenes/:sceneId/elements*`. Thin wrappers over
  // session-planner/scene-elements.mjs only -- no independent business logic
  // here, per gm-tools-conventions.
  // -----------------------------------------------------------------------

  // POST /api/scene-planning/scenes/:sceneId/elements   { world, name, kind?, fields?, stat? }   -> {element}   (kind defaults to "local" when omitted; stat -- Phase 29 task 29.1 -- lets a create call carry an already-open stat block in one shot, e.g. the "NPC or creature" button)
  if (method === "POST" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "elements") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const element = createElement(w, parts[3], { name: body.name, kind: body.kind, fields: body.fields, stat: body.stat, run: body.run, draft: body.draft });
    touchSceneSafely(w, parts[3]); // Phase 30 task 30.1 -- content write bumps scene recency
    return sendJson(res, 200, { element });
  }

  // GET /api/scene-planning/scenes/:sceneId/elements?world=   -> {elements:[...]}, in `order`
  if (method === "GET" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "elements") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { elements: listElementsForScene(w, parts[3]).map(withBestiarySummary) });
  }

  // Run layout (2026-08-26) -- POST /api/scene-planning/scenes/:sceneId/run-layout/infer   { world }   -> {elements}
  // Writes an EXPLICIT `run` onto every element lacking one (never overwrites). Length-6 literal path, checked ahead of the generic PATCH-by-elementId route below like from-graph/reorder.
  if (method === "POST" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "run-layout" && parts[5] === "infer") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const elements = inferRunLayoutForScene(w, parts[3]);
    touchSceneSafely(w, parts[3]);
    return sendJson(res, 200, { elements: elements.map(withBestiarySummary) });
  }

  // Run layout (2026-08-26) -- POST /api/scene-planning/scenes/:sceneId/run-layout/seed   { world, kind? }   -> {kind, seeded, skipped, elements}
  // Seeds placeholder elements for every spread role the scene lacks (session-planner/run-skeleton.mjs). Idempotent by role.
  if (method === "POST" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "run-layout" && parts[5] === "seed") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const result = seedRunSkeleton(w, parts[3], { kind: body.kind });
    touchSceneSafely(w, parts[3]);
    return sendJson(res, 200, { ...result, elements: result.elements.map(withBestiarySummary) });
  }

  // Run layout (2026-08-26) -- GET /api/scene-planning/scenes/:sceneId/run-version?world=   -> {version}
  // A cheap fingerprint of everything Run mode renders (scene record +
  // elements + current narration) so the Run page can poll for live edits
  // (e.g. an agent flipping activeVariants over MCP) without re-fetching
  // the lot every tick. Stores are re-read per request anyway.
  if (method === "GET" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "run-version") {
    const w = resolveWorld(q.get("world"));
    const scene = getScene(w, parts[3]);
    const payload = JSON.stringify([scene, listElementsForScene(w, parts[3]), getCurrentSceneNarration(w, parts[3])]);
    const version = createHash("sha1").update(payload).digest("hex").slice(0, 16);
    return sendJson(res, 200, { version });
  }

  // POST /api/scene-planning/scenes/:sceneId/elements/:elementId/promote   { world }   -> {element}   makes a REAL graph node + containment edge -- resolveDir() needed, unlike the other scene-elements routes below.
  if (method === "POST" && parts.length === 7 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "elements" && parts[6] === "promote") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const dir = resolveDir();
    const element = await promoteElement(dir, w, parts[3], parts[5]);
    touchSceneSafely(w, parts[3]); // Phase 30 task 30.1 -- content write bumps scene recency
    return sendJson(res, 200, { element });
  }

  // POST /api/scene-planning/scenes/:sceneId/elements/:elementId/demote   { world }   -> {element}   never deletes the underlying graph node.
  if (method === "POST" && parts.length === 7 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "elements" && parts[6] === "demote") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const element = demoteElement(w, parts[3], parts[5]);
    touchSceneSafely(w, parts[3]); // Phase 30 task 30.1 -- content write bumps scene recency
    return sendJson(res, 200, { element });
  }

  // Phase 29 task 29.1 -- POST .../elements/from-graph and .../elements/reorder
  // are BOTH length-6 literal paths that would otherwise collide with the
  // generic PATCH-by-elementId route immediately below (which reads
  // parts[5] as an `elementId` -- "from-graph"/"reorder" would be treated as
  // literal element ids, throwing "No scene element found" -> 400). They
  // MUST be checked first, ahead of that generic handler.

  // POST /api/scene-planning/scenes/:sceneId/elements/from-graph   { world, entityId, name? }   -> {element}   attaches an EXISTING graph node (attachExistingNodeAsElement) -- creates NO new node/edge, unlike promote.
  if (method === "POST" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "elements" && parts[5] === "from-graph") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const dir = resolveDir();
    const element = await attachExistingNodeAsElement(dir, w, parts[3], body.entityId, { name: body.name });
    touchSceneSafely(w, parts[3]); // Phase 30 task 30.1 -- content write bumps scene recency
    return sendJson(res, 200, { element });
  }

  // POST /api/scene-planning/scenes/:sceneId/elements/reorder   { world, elementIds }   -> {elements}   thin wrapper over the already-built reorderElements() store op (mirrors POST /api/scene-planning/plans/:planId/reorder above, one layer down).
  if (method === "POST" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "elements" && parts[5] === "reorder") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const elements = reorderElements(w, parts[3], body.elementIds);
    touchSceneSafely(w, parts[3]); // Phase 30 task 30.1 -- content write bumps scene recency
    return sendJson(res, 200, { elements });
  }

  // POST /api/scene-planning/scenes/:sceneId/elements/:elementId   { world, name?, fields?, stat? }   -> {element}   (PATCH-style via POST, matching this file's own POST /api/graph/nodes/:entityId precedent). stat -- Phase 29 task 29.1 -- shallow-merges onto the element's existing stat object (updateElement's own merge semantics).
  if (method === "POST" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "elements") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const element = updateElement(w, parts[3], parts[5], { name: body.name, fields: body.fields, stat: body.stat, run: body.run, draft: body.draft });
    touchSceneSafely(w, parts[3]); // Phase 30 task 30.1 -- content write bumps scene recency
    return sendJson(res, 200, { element });
  }

  // DELETE /api/scene-planning/scenes/:sceneId/elements/:elementId   { world } (body or query)   -> {deleted:true}
  if (method === "DELETE" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "elements") {
    const body = await readBody(req);
    const w = resolveWorld(body.world ?? q.get("world"));
    const result = removeElement(w, parts[3], parts[5]);
    touchSceneSafely(w, parts[3]); // Phase 30 task 30.1 -- content write bumps scene recency
    return sendJson(res, 200, result);
  }

  // -----------------------------------------------------------------------
  // Phase 28 task 28.1 -- per-scene narration, prefix `/api/scene-planning/
  // scenes/:sceneId/narration`. Thin wrappers over
  // session-planner/scene-narration.mjs only.
  // -----------------------------------------------------------------------

  // POST /api/scene-planning/scenes/:sceneId/narration   { world, text }   -> {narration:{sceneId, text, ...}}
  if (method === "POST" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "narration") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const narration = saveSceneNarration(w, parts[3], { text: body.text });
    touchSceneSafely(w, parts[3]); // Phase 30 task 30.1 -- content write bumps scene recency
    return sendJson(res, 200, { narration });
  }

  // GET /api/scene-planning/scenes/:sceneId/narration?world=   -> {narration: {...}|null}   -- never a 404, absence is a valid state
  if (method === "GET" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "narration") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { narration: getCurrentSceneNarration(w, parts[3]) });
  }

  // Phase 28 task 28.1 -- POST /api/scene-planning/scenes/:sceneId/propose-updates   { world }   -- the scene-scoped mirror of POST /api/scene-planning/plans/:planId/propose-updates below. Same response shape, same review-gated "proposes, never auto-writes" contract.
  if (method === "POST" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "propose-updates") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    // QA W1 Fix 3 ("Wrap" -- the Session Planner's post-session graph
    // update): same offlineWriteupClient degrade as /api/writeup-propose
    // (this route delegates straight to the same importWriteup() call).
    const result = await proposeUpdatesForScene(dir, w, parts[3], { llmOpts: offlineOpts(offlineWriteupClient) });
    return sendJson(res, 200, result);
  }

  // Phase 28 task 28.4, §E -- POST /api/scene-planning/scenes/:sceneId/assist-prep
  // { world, mode?, elementName? } -- the inline `✦` scene assist, the ONE
  // element-suggestion affordance on the scene page (Phase 37.6 task 1 retired
  // "✦ Suggest dressing" into this same mode -- propose-elements now proposes
  // a mix of functional AND mundane-dressing elements, not a separate control).
  // mode "propose-elements" (default) / "draft-fields" -> { elements }
  // (validated drafts, never persisted server-side). mode "draft-read-aloud"
  // (also Phase 37.6 task 1 -- was a plain string concat, now a real LLM call)
  // -> { narration }.
  if (method === "POST" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "assist-prep") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    // QA W1 Fix 3 (the Session Planner's headline "✦" affordance): all three
    // modes degrade offline -- offlineAssistPrepClient picks its response
    // shape from the SAME `mode` this route already branches on.
    const result = await assistScenePrep(dir, w, parts[3], { mode: body.mode, elementName: body.elementName },
      offlineOpts(() => offlineAssistPrepClient(body.mode ?? "propose-elements", body.elementName)));
    return sendJson(res, 200, result);
  }

  // ---------------------------------------------------------------------
  // Phase 26 task 26.9, §26.E -- post-session graph update from a Plan's
  // scenes' notes. A thin composition route: assemble writeup-shaped text
  // (session-planner/plan-updates.mjs), then delegate straight to the
  // EXISTING importWriteup() -- the exact same LLM-extraction -> dry-run
  // merge -> review-state-batch pipeline POST /api/writeup-propose already
  // uses, never duplicated. `llmOpts` forwards straight through (the same
  // dependency-injection seam proposeWfiFromWriteup's own tests use).
  // ---------------------------------------------------------------------

  // POST /api/scene-planning/plans/:planId/propose-updates   { world }
  // NOTE: a TEST-INJECTED `llmOpts.client` is NOT threaded through this HTTP
  // route (same established limitation as /api/writeup-propose, per
  // rubber-duck-routes.test.mjs's own documented reasoning -- a live
  // function reference cannot survive a real HTTP JSON round trip). Tests
  // wanting a genuinely working injected client call proposeUpdatesForPlan
  // directly, in-process. QA W1 Fix 3's offline client is a DIFFERENT thing
  // -- it's constructed SERVER-SIDE off `process.env.ANTHROPIC_API_KEY`,
  // never supplied by the HTTP caller, so that limitation doesn't apply to it.
  if (method === "POST" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "plans" && parts[4] === "propose-updates") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await proposeUpdatesForPlan(dir, w, parts[3], { llmOpts: offlineOpts(offlineWriteupClient) });
    return sendJson(res, 200, result);
  }

  // ===========================================================================
  // Phase 35 task 35.1 -- Library + sync-IN stores' routes, per §8 of
  // review-ui/test/e2e/phase35-fixture.mjs (THE WRITTEN CONTRACT). Thin
  // wrappers only, per gm-tools-conventions -- no independent business logic
  // beyond the tray-drop route's own §7-pinned composition (creature-drop
  // element create/reuse), which is explicitly a ROUTE-level concern per the
  // contract's own instruction (scene-tray.mjs stays roster/budget-only).
  // ===========================================================================

  // -----------------------------------------------------------------------
  // §1/§4 -- combat-planning/item-store.mjs (Reliquary), world-scoped.
  // -----------------------------------------------------------------------

  // GET /api/combat-planning/items?world=   -> {items}
  if (method === "GET" && parts.length === 3 && parts[1] === "combat-planning" && parts[2] === "items") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { items: listItems(w) });
  }

  // QA W2 fix (Group D #19): POST /api/combat-planning/items/hand-add
  // { world, name, type?, description? } -> {item}. Same "write one by
  // hand" pattern as bestiary/party-roster above -- accepted immediately
  // (status:'accepted', explicit -- saveItem's own default is 'proposed'),
  // no Foundry refs anywhere (foundryItemRef/ownerFoundryActorUuid/
  // ownerPartyMemberId all stay null -- normalizeShelf's own `r.foundryItemRef
  // ? "foundry" : "mine"` projection reads "mine").
  if (method === "POST" && parts.length === 4 && parts[1] === "combat-planning" && parts[2] === "items" && parts[3] === "hand-add") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new Error("POST /api/combat-planning/items/hand-add: `name` is required.");
    if (name.length > 200) throw new Error("POST /api/combat-planning/items/hand-add: `name` must be 200 characters or fewer.");
    const item = saveItem(w, {
      name,
      type: typeof body.type === "string" && body.type.trim() ? body.type.trim() : null,
      description: typeof body.description === "string" && body.description.trim() ? body.description.trim() : null,
      status: "accepted"
    });
    return sendJson(res, 200, { item });
  }

  // POST /api/combat-planning/items/:id/accept   {world}   -> {item}
  if (method === "POST" && parts.length === 5 && parts[1] === "combat-planning" && parts[2] === "items" && parts[4] === "accept") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const item = acceptItem(w, parts[3]);
    return sendJson(res, 200, { item });
  }

  // POST /api/combat-planning/items/:id/discard   {world}   -> {item}
  if (method === "POST" && parts.length === 5 && parts[1] === "combat-planning" && parts[2] === "items" && parts[4] === "discard") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const item = discardItem(w, parts[3]);
    return sendJson(res, 200, { item });
  }

  // POST /api/combat-planning/items/:id/tags   {world, tag}   -> {item}   (§4 addTag)
  if (method === "POST" && parts.length === 5 && parts[1] === "combat-planning" && parts[2] === "items" && parts[4] === "tags") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const item = addItemTag(w, parts[3], body.tag);
    return sendJson(res, 200, { item });
  }

  // DELETE /api/combat-planning/items/:id/tags/:tag   {world}   -> {item}   (§4 removeTag)
  if (method === "DELETE" && parts.length === 6 && parts[1] === "combat-planning" && parts[2] === "items" && parts[4] === "tags") {
    const body = await readBody(req);
    const w = resolveWorld(body.world ?? q.get("world"));
    const item = removeItemTag(w, parts[3], decodeURIComponent(parts[5]));
    return sendJson(res, 200, { item });
  }

  // POST /api/combat-planning/items/:id/promote-to-graph   {world}   -> {item, entityId, created}
  // Phase 35.5a (task #44) -- promote a Reliquary item into a real graph
  // node. Idempotent (see item-store.mjs's promoteItemToGraph doc comment):
  // a second promote on an already-linked item returns created:false and
  // writes nothing, rather than a 409 or a duplicate node.
  if (method === "POST" && parts.length === 5 && parts[1] === "combat-planning" && parts[2] === "items" && parts[4] === "promote-to-graph") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await promoteItemToGraph(dir, w, parts[3]);
    return sendJson(res, 200, result);
  }

  // -----------------------------------------------------------------------
  // §2/§4 -- session-planner/stagecraft-store.mjs (Reliquary+Stagecraft's
  // shared tagged-shelf, this half is the Stagecraft store), world-scoped.
  // -----------------------------------------------------------------------

  // GET /api/session-planner/stagecraft?world=[&kind=map|splash|music]   -> {assets}
  if (method === "GET" && parts.length === 3 && parts[1] === "session-planner" && parts[2] === "stagecraft") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { assets: listStagecraftAssets(w, q.get("kind") || undefined) });
  }

  // QA W2 fix (Group D #19): POST /api/session-planner/stagecraft/hand-add
  // { world, name, kind, desc?, src? } -> {asset}. Same "write one by hand"
  // pattern -- this store's OWN pre-existing "hand-added splash/music row IS
  // the deliberate authorship act" convention (stagecraft-store.mjs's header
  // comment) already defaults saveStagecraftAsset to status:'accepted' and
  // source:'local' with foundryRef:null, so this route is a thin wrapper,
  // not a new policy. W3a: gained the optional `src` field (the asset's
  // Foundry-resolvable file path/URL -- see stagecraft-store.mjs's own W3a
  // header note).
  if (method === "POST" && parts.length === 4 && parts[1] === "session-planner" && parts[2] === "stagecraft" && parts[3] === "hand-add") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new Error("POST /api/session-planner/stagecraft/hand-add: `name` is required.");
    if (name.length > 200) throw new Error("POST /api/session-planner/stagecraft/hand-add: `name` must be 200 characters or fewer.");
    if (!["map", "splash", "music"].includes(body.kind)) {
      throw new Error('POST /api/session-planner/stagecraft/hand-add: `kind` must be "map", "splash", or "music".');
    }
    const asset = saveStagecraftAsset(w, {
      kind: body.kind,
      name,
      desc: typeof body.desc === "string" && body.desc.trim() ? body.desc.trim() : null,
      src: typeof body.src === "string" && body.src.trim() ? body.src.trim() : null
    });
    return sendJson(res, 200, { asset });
  }

  // -----------------------------------------------------------------------
  // Briefing (2026-08-26) -- world-level front-matter cards, prefix
  // `/api/session-planner/briefing`. Thin wrappers over
  // session-planner/briefing-store.mjs only.
  // -----------------------------------------------------------------------
  // GET /api/session-planner/briefing?world=   -> {cards} in order
  if (method === "GET" && parts.length === 3 && parts[1] === "session-planner" && parts[2] === "briefing") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { cards: listBriefingCards(w) });
  }
  // POST /api/session-planner/briefing   { world, title, eyebrow?, body?, span? }   -> {card}
  if (method === "POST" && parts.length === 3 && parts[1] === "session-planner" && parts[2] === "briefing") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    return sendJson(res, 200, { card: createBriefingCard(w, { title: body.title, eyebrow: body.eyebrow, body: body.body, span: body.span }) });
  }
  // POST /api/session-planner/briefing/reorder   { world, cardIds }   -> {cards}   (literal path, ahead of the :id patch below)
  if (method === "POST" && parts.length === 4 && parts[1] === "session-planner" && parts[2] === "briefing" && parts[3] === "reorder") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    return sendJson(res, 200, { cards: reorderBriefingCards(w, Array.isArray(body.cardIds) ? body.cardIds : []) });
  }
  // POST /api/session-planner/briefing/:id   { world, title?, eyebrow?, body?, span? }   -> {card}
  if (method === "POST" && parts.length === 4 && parts[1] === "session-planner" && parts[2] === "briefing") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    return sendJson(res, 200, { card: updateBriefingCard(w, parts[3], { title: body.title, eyebrow: body.eyebrow, body: body.body, span: body.span }) });
  }
  // DELETE /api/session-planner/briefing/:id   { world } (body or query)   -> {deleted}
  if (method === "DELETE" && parts.length === 4 && parts[1] === "session-planner" && parts[2] === "briefing") {
    const body = await readBody(req);
    const w = resolveWorld(body.world ?? q.get("world"));
    return sendJson(res, 200, removeBriefingCard(w, parts[3]));
  }

  // Run layout (2026-08-26) -- GET /api/session-planner/stagecraft/:id/image?world=
  // Streams the asset's own file from under the Foundry data dir (the same
  // root Foundry serves `src` from), for the Run spread's map thumbnail.
  // The resolved path MUST stay inside the data dir (400 otherwise); a
  // missing file is a plain 404. Never accepts a client path -- only an
  // asset id, whose `src` the GM set.
  if (method === "GET" && parts.length === 5 && parts[1] === "session-planner" && parts[2] === "stagecraft" && parts[4] === "image") {
    const w = resolveWorld(q.get("world"));
    const asset = getStagecraftAsset(w, parts[3]);
    if (!asset.src) return sendJson(res, 404, { error: "This asset has no file path (src) recorded." });
    const root = resolve(resolveDir());
    const filePath = resolve(root, asset.src);
    if (filePath !== root && !filePath.startsWith(root + sep)) return sendJson(res, 400, { error: "Asset src escapes the data directory." });
    if (!existsSync(filePath)) return sendJson(res, 404, { error: `Map file not found: ${asset.src}` });
    return serveStatic(res, filePath);
  }

  // W3a: POST /api/session-planner/stagecraft/:id/src   {world, src} -> {asset}
  // Set (or clear, src:null/"") an existing asset's file path/URL. Thin
  // wrapper over updateStagecraftAssetSrc -- status-INDEPENDENT by that
  // function's own documented convention (an accepted asset's path is an
  // ongoing table-use edit, like a bestiary note). Unknown id -> the store's
  // own "No stagecraft asset found" -> clean 400 via statusForError, same as
  // the sibling accept/discard/tags routes.
  if (method === "POST" && parts.length === 5 && parts[1] === "session-planner" && parts[2] === "stagecraft" && parts[4] === "src") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const asset = updateStagecraftAssetSrc(w, parts[3], body.src ?? null);
    return sendJson(res, 200, { asset });
  }

  // POST /api/session-planner/stagecraft/:id/accept   {world}   -> {asset}
  // Phase 36 task 36.2, §3 -- FAN-OUT touch: an asset's proposed->accepted
  // transition doesn't change any Scene record, but changes whether the
  // flush composer may legally use it (only ACCEPTED stagecraft assets are
  // eligible for background/foreground/create_journal_image inclusion, §5),
  // so every staged scene whose tray roster references this asset needs
  // re-evaluation on the next flush -- scan every scene-tray record in this
  // world for a matching `{kind:'asset', id: asset.id}` roster row and touch
  // each matching scene (touchSceneSafely itself fires scheduleFlush when
  // that scene is staged).
  //
  // Phase 38 task 38.2, §4 -- EXTENDED, not forked: when the target asset
  // carries a non-null `compendiumRef` and has no `foundryRef?.sceneUuid`
  // yet, accept is no longer a synchronous status flip -- it composes
  // `import_compendium_scene` through the ops channel
  // (importCompendiumSceneOnAccept, wf-mcp-server/lib/
  // stagecraft-import-ops.mjs) and the response shape changes to
  // `{status, ok?, asset, ...}` (see that module's own doc comment for the
  // exact three-outcome shape). A NON-compendiumRef accept (every existing
  // caller) takes the EXACT SAME PATH AS TODAY, byte-identical `{asset}`
  // response -- a hard backward-compatibility pin (phase38-fixture.mjs §4's
  // own GREEN PIN test).
  if (method === "POST" && parts.length === 5 && parts[1] === "session-planner" && parts[2] === "stagecraft" && parts[4] === "accept") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const dir = resolveDir();

    // Reconcile any late-arriving import result BEFORE deciding how to
    // handle THIS accept call -- a stale pendingImport must never
    // permanently block a retry (§4's own explicit instruction).
    reconcilePendingCompendiumImports(dir, w);

    const target = getStagecraftAsset(w, parts[3]);
    if (target.compendiumRef && !target.foundryRef?.sceneUuid) {
      const outcome = await importCompendiumSceneOnAccept(dir, w, parts[3]);
      if (outcome.status === "applied" && outcome.ok) {
        for (const rec of listSceneTrayRecordsForWorld(w)) {
          if ((rec.roster ?? []).some((r) => r.kind === "asset" && r.id === target.id)) {
            touchSceneSafely(w, rec.sceneId);
          }
        }
      }
      return sendJson(res, 200, outcome);
    }

    const asset = acceptStagecraftAsset(w, parts[3]);
    for (const rec of listSceneTrayRecordsForWorld(w)) {
      if ((rec.roster ?? []).some((r) => r.kind === "asset" && r.id === asset.id)) {
        touchSceneSafely(w, rec.sceneId);
      }
    }
    return sendJson(res, 200, { asset });
  }

  // POST /api/session-planner/stagecraft/:id/discard   {world}   -> {asset}
  if (method === "POST" && parts.length === 5 && parts[1] === "session-planner" && parts[2] === "stagecraft" && parts[4] === "discard") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const asset = discardStagecraftAsset(w, parts[3]);
    return sendJson(res, 200, { asset });
  }

  // POST /api/session-planner/stagecraft/:id/tags   {world, tag}   -> {asset}
  if (method === "POST" && parts.length === 5 && parts[1] === "session-planner" && parts[2] === "stagecraft" && parts[4] === "tags") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const asset = addStagecraftTag(w, parts[3], body.tag);
    return sendJson(res, 200, { asset });
  }

  // DELETE /api/session-planner/stagecraft/:id/tags/:tag   {world}   -> {asset}
  if (method === "DELETE" && parts.length === 6 && parts[1] === "session-planner" && parts[2] === "stagecraft" && parts[4] === "tags") {
    const body = await readBody(req);
    const w = resolveWorld(body.world ?? q.get("world"));
    const asset = removeStagecraftTag(w, parts[3], decodeURIComponent(parts[5]));
    return sendJson(res, 200, { asset });
  }

  // -----------------------------------------------------------------------
  // §3 -- session-planner/token-store.mjs, read-only.
  // -----------------------------------------------------------------------

  // GET /api/session-planner/token-index?world=[&sceneUuid=]   -> {tokens}
  if (method === "GET" && parts.length === 3 && parts[1] === "session-planner" && parts[2] === "token-index") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, { tokens: listTokens(w, q.get("sceneUuid") || undefined) });
  }

  // -----------------------------------------------------------------------
  // §7/§8 -- shared scene tray, prefix `/api/scene-planning/scenes/:sceneId/tray*`.
  // -----------------------------------------------------------------------

  // GET /api/scene-planning/scenes/:sceneId/tray?world=   -> {roster, xpBudget}   NEVER 404s.
  if (method === "GET" && parts.length === 5 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "tray") {
    const w = resolveWorld(q.get("world"));
    return sendJson(res, 200, getSceneTray(w, parts[3]));
  }

  // POST /api/scene-planning/scenes/:sceneId/tray/budget   {world, xpBudget}   -> {roster, xpBudget}
  if (method === "POST" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "tray" && parts[5] === "budget") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const result = setSceneTrayXpBudget(w, parts[3], body.xpBudget);
    touchSceneSafely(w, parts[3]); // Phase 36 task 36.2, §3 -- unconditional, every tray mutation touches its scene
    return sendJson(res, 200, result);
  }

  // POST /api/scene-planning/scenes/:sceneId/tray/drop   {world, kind, id}   -> {roster, xpBudget, element}
  // §7's pinned drop behavior, implemented AT THIS ROUTE (not in
  // scene-tray.mjs) per the contract's own instruction: a "creature" drop's
  // FIRST occurrence creates/reuses a kind:'local' SceneElement carrying a
  // stat block (dedup via fields.bestiaryEntryId, reusing createElement
  // unchanged); a repeat drop only stacks the roster, element:null. "hero"/
  // "asset" drops never touch scene-elements.mjs at all (display-only /
  // the roster row itself IS the scene-asset link). An unresolvable id for
  // the given kind throws a "No ... found" error -> 404 via statusForError.
  if (method === "POST" && parts.length === 6 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "tray" && parts[5] === "drop") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const dir = resolveDir();
    const sceneId = parts[3];
    // MCP wave: the full creature/hero/asset composition now lives in
    // wf-mcp-server/lib/planner-ops.mjs's sceneTrayDropOp -- shared verbatim
    // with wf-mcp-server/index.mjs's wf_tray_drop tool. touchSceneSafely
    // (recency bump + Phase 36 task 36.2 §3's quiet-push flush trigger)
    // stays HERE at the route layer -- see that module's own header comment
    // for why it's not part of the shared op.
    const result = await sceneTrayDropOp(dir, w, sceneId, { kind: body.kind, id: body.id });
    touchSceneSafely(w, sceneId);
    return sendJson(res, 200, result);
  }

  // DELETE /api/scene-planning/scenes/:sceneId/tray/:kind/:id   {world}   -> {roster, xpBudget}
  if (method === "DELETE" && parts.length === 7 && parts[1] === "scene-planning" && parts[2] === "scenes" && parts[4] === "tray") {
    const body = await readBody(req);
    const w = resolveWorld(body.world ?? q.get("world"));
    const result = removeFromSceneTray(w, parts[3], parts[5], decodeURIComponent(parts[6]));
    touchSceneSafely(w, parts[3]); // Phase 36 task 36.2, §3 -- unconditional on a successful removal
    return sendJson(res, 200, result);
  }

  // -----------------------------------------------------------------------
  // §5 -- bestiary/party additive fields, status-INDEPENDENT patch routes.
  // -----------------------------------------------------------------------

  // POST /api/combat-planning/bestiary/:id/note   {note}   -> {entry}
  if (method === "POST" && parts.length === 5 && parts[1] === "combat-planning" && parts[2] === "bestiary" && parts[4] === "note") {
    const body = await readBody(req);
    const entry = updateBestiaryEntryNote(parts[3], body.note);
    return sendJson(res, 200, { entry });
  }

  // POST /api/combat-planning/bestiary/:id/rating   {rating}   -> {entry}
  if (method === "POST" && parts.length === 5 && parts[1] === "combat-planning" && parts[2] === "bestiary" && parts[4] === "rating") {
    const body = await readBody(req);
    const entry = updateBestiaryEntryRating(parts[3], body.rating);
    return sendJson(res, 200, { entry });
  }

  // -----------------------------------------------------------------------
  // Phase 37.6b -- the two Library Bestiary stubs, wired for real.
  // -----------------------------------------------------------------------

  // POST /api/combat-planning/bestiary/:id/promote-to-graph   {world}   -> {entry, entityId, created}
  // "Promote to a named world figure." Mirrors items' identical
  // promote-to-graph route exactly; idempotent (see bestiary-store.mjs's
  // promoteBestiaryEntryToGraph doc comment) -- a second promote on an
  // already-linked entry returns created:false and writes nothing.
  if (method === "POST" && parts.length === 5 && parts[1] === "combat-planning" && parts[2] === "bestiary" && parts[4] === "promote-to-graph") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const result = await promoteBestiaryEntryToGraph(dir, w, parts[3]);
    return sendJson(res, 200, result);
  }

  // POST /api/combat-planning/bestiary/:id/reskin-suggest   {world, vision?}   -> {suggestions}
  // "Wear it as something else." NEVER writes anything -- see
  // combat-planning/reskin-suggest.mjs's own doc comment for the full
  // grounding/offline-degrade story. `world` supplies the graph context
  // (buildAdjacencyContext around the entry's promoted node if it has one,
  // else a compact whole-world summary); it does NOT scope the bestiary
  // entry itself (bestiary-store.mjs is library-wide, per its own
  // documented scoping decision).
  if (method === "POST" && parts.length === 5 && parts[1] === "combat-planning" && parts[2] === "bestiary" && parts[4] === "reskin-suggest") {
    const body = await readBody(req);
    const dir = resolveDir();
    const w = resolveWorld(body.world);
    const entry = getBestiaryEntry(parts[3]); // throws "No bestiary entry found" -> 404
    const { entities, edges } = loadSnapshot(dir, w).snapshot;
    // Same OFFLINE DETERMINISTIC degrade as POST /api/graph/nodes/:id/
    // develop-description's own texture-adjacent call -- a key-less
    // dev/demo environment (and this route's own e2e coverage) gets real,
    // honestly-labelled suggestions instead of a thrown "missing API key"
    // from the Anthropic SDK constructor. With a key present this branch
    // never fires. QA W1 Fix 4: `offline:true` on the response, clean
    // suggestion bodies (see offlineReskinSuggestClient's own comment).
    const result = await suggestReskins(entry, entities, edges, body.vision, offlineOpts(offlineReskinSuggestClient));
    return sendJson(res, 200, { ...result, offline: isOffline() });
  }

  // POST /api/combat-planning/bestiary/:id/reskin-accept   {suggestion:{name,description,habitatHint}}   -> {entry}
  // Accepting one of reskin-suggest's one-shot cards: creates a brand-new
  // bestiary entry (see bestiary-store.mjs's createReskinnedBestiaryEntry
  // doc comment for the full shape/status/back-link story -- identical
  // rawFields except `name`, status "accepted" immediately, never
  // foundry-linked). `:id` is the SOURCE entry being reskinned -- it is
  // never itself mutated by this route.
  if (method === "POST" && parts.length === 5 && parts[1] === "combat-planning" && parts[2] === "bestiary" && parts[4] === "reskin-accept") {
    const body = await readBody(req);
    const source = getBestiaryEntry(parts[3]); // throws "No bestiary entry found" -> 404
    const entry = createReskinnedBestiaryEntry(source, body.suggestion);
    return sendJson(res, 200, { entry });
  }

  // POST /api/combat-planning/party-roster/:id/passive   {world, passive}   -> {member}
  if (method === "POST" && parts.length === 5 && parts[1] === "combat-planning" && parts[2] === "party-roster" && parts[4] === "passive") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const member = updatePartyMemberPassive(w, parts[3], body.passive);
    return sendJson(res, 200, { member });
  }

  // POST /api/combat-planning/party-roster/:id/conditions   {world, conditions}   -> {member}
  if (method === "POST" && parts.length === 5 && parts[1] === "combat-planning" && parts[2] === "party-roster" && parts[4] === "conditions") {
    const body = await readBody(req);
    const w = resolveWorld(body.world);
    const member = updatePartyMemberConditions(w, parts[3], body.conditions);
    return sendJson(res, 200, { member });
  }

  sendJson(res, 404, { error: `No route: ${req.method} ${url.pathname}` });
}

// Guard the actual listen() behind an entrypoint check so this module can be
// imported by tests (spinning up its own server on an ephemeral port)
// without also starting a second server on DEFAULT_PORT.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = process.env.REVIEW_UI_PORT ? Number(process.env.REVIEW_UI_PORT) : DEFAULT_PORT;
  createReviewServer({ port });
  console.log(`review-ui server listening on http://localhost:${port}`);
  console.log(`  WF_DATA_DIR=${process.env.WF_DATA_DIR ?? "(not set -- pass dataDir explicitly or set this)"}`);
  console.log(`  WF_DEFAULT_WORLD=${process.env.WF_DEFAULT_WORLD ?? "(not set -- pass world explicitly or set this)"}`);
}
