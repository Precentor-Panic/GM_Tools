#!/usr/bin/env node
/**
 * World Fabric MCP server.
 *
 * Wraps the file-based bridge World Fabric already exports from inside
 * Foundry: world-fabric-snapshot.json (read, auto-refreshed on every graph
 * write) and world-fabric-mutations.json (write, picked up by the module's
 * mutation watcher within ~5s). See gm/wf-query.mjs and gm/wf-apply.mjs in
 * the foundry_worldFabric repo for the CLI precursor to this server.
 *
 * GraphService itself only runs inside the Foundry browser session (it
 * depends on `game.settings`), so this server never talks to Foundry
 * directly — it only reads/writes the snapshot and mutation files.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { existsSync, readFileSync } from "node:fs";
import { listWorlds } from "./lib/data-dir.mjs";
import { loadSnapshot, mutationsPath } from "./lib/snapshot.mjs";
import { neighborhood, edgesFor, findEntity, findEntityByName, findEdge } from "./lib/graph.mjs";
import { resolveWorld, resolveDir } from "./lib/resolve.mjs";

// Phase 3.5 task 3.5.2/3.5.3 — deferred/lazy consequence resolution:
// orchestrateCycle (headline-focus + backlog deferral, wrapped below as
// wf_run_cycle) and resolvePending (explicit, opt-in resolve of an
// accumulated backlog, wrapped below as wf_resolve_pending).
import { orchestrateCycle } from "../time-skip/run-cycle.mjs";
import { resolvePending } from "../time-skip/resolve-pending.mjs";

// Phase 2 task 2.0 — the propagate/scope-resolution and orchestration logic
// that used to be inlined in wf_propose_mutations's handler now lives in
// time-skip/ as reusable library code; this server just wires parameters
// through to it. See time-skip/scope.mjs, time-skip/run.mjs.
import { orchestrateBatch, attachDiffs } from "../time-skip/run.mjs";

// Phase 5 — import-from-writeup: propose a WFI-shaped document from freeform
// text (task 5.1), dry-run it through importGraph and convert the result into
// a normal review batch (task 5.2). The actual dispatch logic (proposeFromWriteupOp,
// selectFramingForNewBatch/ExistingBatch) now lives in ./lib/mutation-ops.mjs,
// which imports graph-import/writeup-import.mjs's importWriteup directly --
// nothing in THIS file needs to import it anymore.

// Phase 8 — rubber-duck creative mode: the framing-proposal step sits in
// front of Phase 5's pipeline above (unchanged when rubber-duck mode is
// off). See ./lib/mutation-ops.mjs's own doc comments for the full
// two-phase flow and the reject-loop state machine.
import { getUserSettings, setRubberDuckMode } from "../mutation-engine/user-settings.mjs";

// Phase 4 task 4.2 — unreviewed-accumulation tracking (read-only surface;
// the accept/reject-time bookkeeping itself lives in lib/mutation-ops.mjs now).
import { findUnreviewedEntities, DEFAULT_MAX_AGE_DAYS, DEFAULT_MAX_UNREVIEWED_ACCEPTS } from "../mutation-engine/human-review.mjs";

// Phase 6 — the actual review-workflow operations (accept/reject/regenerate/
// narrate/sync/rollback/review-grain) now live in lib/mutation-ops.mjs,
// shared verbatim with review-ui/server.mjs rather than kept as two
// independently-drifting copies. See that module's own doc comment.
import {
  applyMutationsToFoundry,
  reviewGrainOp,
  acceptOp,
  regenerateOp,
  narrateOp,
  syncOp,
  rollbackOp,
  proposeFromWriteupOp,
  selectFramingForNewBatch,
  selectFramingForExistingBatch,
  rejectWithLoopOp,
  narrateEntityOp,
  getEntityNarrationOp,
  getEntityNarrationHistoryOp
} from "./lib/mutation-ops.mjs";

// Phase 11 — per-node content generation ("develop this node"): a genuinely
// separate store/pipeline from mutation-ops.mjs above (see
// mutation-engine/prep-content.mjs's own doc comment for why) -- these
// tools never touch a Batch/StoredMutation and are never reachable from any
// accept/reject/sync-to-Foundry code path.
import {
  proposePrepFramingsOp,
  reframePrepFramingsOp,
  generatePrepContentOp,
  getPrepContentOp,
  acceptPrepContentOp,
  discardPrepContentOp,
  regeneratePrepFieldOp,
  markPrepContentStaleOp
} from "./lib/prep-content-ops.mjs";

// Narrative-state layer ("Layer 2", plans/ontology-assessment-2026-09-02.md):
// per-entity reveal state / GM-only truth / stance / clocks, stored beside
// the world snapshot (worlds/<world>/narrative-state/). Sidecar class —
// direct writes, no review batch (see narrative-state-ops.mjs's header for
// the invariant reasoning), never synced to the graph or Foundry.
import {
  getNarrativeStateOp,
  setNarrativeStateOp,
  setRevealStateOp,
  tickClockOp,
  listNarrativeStateOp
} from "./lib/narrative-state-ops.mjs";

// Phase 32 task 32.2 -- Foundry actor PULL ingest (the phase's primary
// deliverable): worlds/<world>/world-fabric-foundry-index.json ->
// bestiary/party-roster, review-gated. Shared verbatim with
// review-ui/server.mjs's POST /api/foundry/pull-actors route -- see
// lib/foundry-pull-ops.mjs's own header comment for the full contract.
import { pullFoundryActorsToStores } from "./lib/foundry-pull-ops.mjs";

// ======================================================================================
// MCP wave -- Session Planner / Library / Chronicle parity tools, plus
// keyless-safety wiring for every LLM-backed tool above. All of the imports
// below reuse the SAME store/lib modules review-ui/server.mjs's HTTP routes
// call -- mirroring route semantics, never forking logic (per
// gm-tools-conventions). See each tool's own registerTool block further
// down for the specific route it mirrors.
// ======================================================================================

// Session Planner: plans/scenes/elements/tray -- the direct working-state
// stores behind /api/scene-planning/* and /api/session-planner/scenes*.
import { createScene, getScene, listScenesForWorld, listScenesByRecency, updateScene, touchScene } from "../session-planner/scenes.mjs";
import { createPlan, getPlan, listPlansForWorld, addSceneToPlan, reorderPlanScenes, renamePlan } from "../session-planner/plans.mjs";
import { createElement, listElementsForScene, updateElement, removeElement, reorderElements, promoteElement, demoteElement, inferRunLayoutForScene } from "../session-planner/scene-elements.mjs";
import { getSceneTray, removeFromSceneTray, setSceneTrayXpBudget } from "../session-planner/scene-tray.mjs";
import { getCurrentSceneNarration, saveSceneNarration } from "../session-planner/scene-narration.mjs";
import { RUN_COLUMNS, RUN_ROLES } from "../session-planner/run-layout.mjs";
import { seedRunSkeleton } from "../session-planner/run-skeleton.mjs";
import { listBriefingCards, createBriefingCard, updateBriefingCard, removeBriefingCard, reorderBriefingCards } from "../session-planner/briefing-store.mjs";
// The scene-tray "drop" composition (creature/hero/asset resolution +
// stat-carrying element dedup) -- shared verbatim with review-ui/server.mjs's
// POST .../tray/drop route. See that module's own header comment for why
// review-ui's own touchSceneSafely (recency bump + background Foundry-push
// flush scheduling) is deliberately NOT part of this shared op.
import { sceneTrayDropOp } from "./lib/planner-ops.mjs";

// Library: bestiary (library-wide, no world concept)/party-roster/items/
// stagecraft (incl. compendiumRef/catalogRef browse rows -- listStagecraftAssets
// already returns everything, no separate catalog-browse function exists).
import { listBestiaryEntries, getBestiaryEntry, saveBestiaryEntry, acceptBestiaryEntry, updateBestiaryEntryNote } from "../combat-planning/bestiary-store.mjs";
import { listPartyMembers, savePartyMember } from "../combat-planning/party-roster-store.mjs";
import { listItems, saveItem } from "../combat-planning/item-store.mjs";
import { listStagecraftAssets, saveStagecraftAsset } from "../session-planner/stagecraft-store.mjs";

// G10 -- Rules Oracle (workstream B4): library-wide, no `world`, same
// resolveDir()-only convention every other Foundry-data reader in this
// server uses. See rules-oracle/index.mjs's own header for the composed
// structured (Plutonium)/book-shelf (rules-library/) contract.
import { searchRules } from "../rules-oracle/index.mjs";
import { RULE_FAMILIES } from "../rules-oracle/rules-index.mjs";

// Chronicle: world-clock/fortune/log/pending-intents (reads) + chronicle-run/
// queue-intent (mutations, both mirroring review-ui/server.mjs's own
// /api/chronicle/* composition via wf-mcp-server/lib/chronicle-ops.mjs).
import { getWorldClock } from "../session-planner/world-clock.mjs";
import { getFortune, setFortune } from "../session-planner/fortune-track.mjs";
import { chronicleLogPayload, pendingEntitiesPayload, runChronicleOp, queueIntentOp } from "./lib/chronicle-ops.mjs";

// Keyless safety: the SAME offline-degrade infrastructure review-ui/server.mjs's
// HTTP routes have used since the QA fix-wave, now shared here too -- every
// LLM-backed tool below (existing and new) passes `offlineOpts(...)` so a
// wf-mcp-server process with no ANTHROPIC_API_KEY in ITS OWN environment
// degrades to an honest, clearly-labelled placeholder instead of crashing on
// the raw Anthropic SDK's own construction-time "Could not resolve
// authentication method" error. See that module's own header comment.
import {
  offlineOpts,
  isOffline,
  offlineTextureClient,
  offlineWriteupClient,
  offlineNarrateClient,
  offlinePrepContentClient
} from "./lib/offline-clients.mjs";

const server = new McpServer({ name: "world-fabric", version: "0.1.0" });

// Multi-world safety (hard requirement -- Russell runs multiple worlds at
// once, e.g. an ongoing campaign + a separate one-shot): every NEW tool
// below requires `world` explicitly (z.string(), not .optional()) rather
// than following the pre-existing worldParam convention's silent fallback
// to WF_DEFAULT_WORLD. This is a deliberate, narrower-than-precedent schema
// for this wave's tools only -- see the MCP-wave report for why. Bestiary
// tools are the one deliberate exception (no `world` param AT ALL) --
// bestiary-store.mjs is library-wide, not world-scoped, mirroring
// GET /api/combat-planning/bestiary's own documented "no world parameter"
// convention exactly.
// Run layout (2026-08-26) -- the element's explicit spread placement; `null` clears back to inference.
// `group` (run-spread consolidation pass): elements of a scene sharing a non-empty group string
// (same column) render as ONE composite card in Run -- e.g. a payload card leading, its outcome
// read-alouds as labeled sections beneath. Explicit only; inference never invents one.
const runLayoutParam = z.object({
  column: z.enum(RUN_COLUMNS), role: z.enum(RUN_ROLES), variant: z.string().optional(), placeholder: z.boolean().optional(),
  group: z.string().min(1).optional(),
  revealTab: z.boolean().optional()
}).nullable().optional().describe("Explicit Run-spread placement {column, role, variant?, placeholder?, group?, revealTab?}; null clears to inference. Elements sharing `group` merge into one composite Run card (lead = lowest-order member). `revealTab` (needs `variant`): when the element's bound graph entity (its own graphEntityId, else the group's first-bound member's) has narrative-state revealState 'revealed', this variant becomes the card's SEEDED active tab — the mid-session reveal wire; local tab clicks at the table still override.");

// Persona round (2026-08-31, finding M1): the scene-element `fields` bag LOOKS
// open here (a zod record, for wire flexibility) but the store re-validates
// with a CLOSED .strict() vocabulary and its error names only the offending
// key -- a cold agent burned four probing calls discovering the real set. So
// the set lives on the param description, kept in sync with
// session-planner/scene-elements.mjs's SceneElementFields.
const elementFieldsParam = z.record(z.string(), z.any()).optional().describe(
  "Accepts ONLY these keys (any other is rejected with unrecognized_keys): " +
  "`trigger` (when this fires), `gives` (the main content line -- what it offers the table), " +
  "`looks` (visible/read-aloud description; renders as Effect on a role-'card' element), " +
  "`means` (subtext/GM aside; renders as GM on a read, Alternate on a card), " +
  "`checks` (array of {skill, dc, purpose?}), `function` (mechanical purpose), " +
  "`wants` (an NPC's motivation), `secret` (GM-only; renders as Failure on a card), " +
  "`statblockRef` (stat-block name/source), `bestiaryEntryId` (bestiary link)."
);

const requiredWorldParam = z.string().min(1).describe(
  "World ID (Foundry world folder name) -- REQUIRED. This server never silently defaults across worlds for this " +
  "tool, even if WF_DEFAULT_WORLD happens to be set. Call wf_list_worlds first if unsure which id to use."
);

const worldParam = z.string().optional().describe(
  "World ID (Foundry world folder name). Defaults to WF_DEFAULT_WORLD env var if set. " +
  "Use wf_list_worlds to see what's available."
);
const dataDirParam = z.string().optional().describe(
  "Override the Foundry data directory. Defaults to WF_DATA_DIR env var, then OS-typical install paths."
);

function text(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorText(err) {
  return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
}

// --- wf_list_worlds ----------------------------------------------------------

server.registerTool(
  "wf_list_worlds",
  {
    title: "List worlds with an active World Fabric snapshot",
    description: "Lists Foundry world IDs under the data directory that have an exported world-fabric-snapshot.json.",
    inputSchema: { dataDir: dataDirParam }
  },
  async ({ dataDir }) => {
    try {
      const dir = resolveDir(dataDir);
      return text({ dataDir: dir, worlds: listWorlds(dir) });
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_get_context (pre-serialized LLM context, cheapest call) --------------

server.registerTool(
  "wf_get_context",
  {
    title: "Get the pre-serialized campaign context blob",
    description:
      "Returns World Fabric's own budgeted, token-bounded text serialization of the campaign graph, plus its " +
      "system prompt and session metadata. Cheapest way to get campaign-wide context without walking entities " +
      "yourself.",
    inputSchema: { world: worldParam, dataDir: dataDirParam }
  },
  async ({ world, dataDir }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const snap = loadSnapshot(dir, w);
      return text({ meta: snap.meta, systemPrompt: snap.systemPrompt, context: snap.context });
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_get_entity -------------------------------------------------------------

server.registerTool(
  "wf_get_entity",
  {
    title: "Get one entity by ID or name, with its direct edges",
    description: "Look up a single entity (person/place/faction/object/event/concept) and the edges touching it.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      entityId: z.string().optional().describe("Exact entity ID"),
      name: z.string().optional().describe("Entity name, case-insensitive, used if entityId is omitted")
    }
  },
  async ({ world, dataDir, entityId, name }) => {
    try {
      if (!entityId && !name) throw new Error("Provide entityId or name.");
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const { entities, edges } = loadSnapshot(dir, w).snapshot;
      const entity = entityId ? findEntity(entities, entityId) : findEntityByName(entities, name);
      if (!entity) throw new Error(`Entity not found: ${entityId ?? name}`);
      return text({ entity, edges: edgesFor(edges, entity.id) });
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_get_adjacent (BFS blast radius) ----------------------------------------

server.registerTool(
  "wf_get_adjacent",
  {
    title: "Get the BFS subgraph around an entity (blast radius)",
    description:
      "Returns all entities and edges reachable from the given entity within `depth` hops. This is the blast-radius " +
      "input for event-mutation reasoning: given an event epicenter, see what it can plausibly reach.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      entityId: z.string().optional(),
      name: z.string().optional().describe("Used if entityId is omitted"),
      depth: z.number().int().min(1).max(6).default(2)
    }
  },
  async ({ world, dataDir, entityId, name, depth }) => {
    try {
      if (!entityId && !name) throw new Error("Provide entityId or name.");
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const { entities, edges } = loadSnapshot(dir, w).snapshot;
      const root = entityId ? findEntity(entities, entityId) : findEntityByName(entities, name);
      if (!root) throw new Error(`Entity not found: ${entityId ?? name}`);
      return text(neighborhood(entities, edges, root.id, depth));
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_get_entities_by_type ----------------------------------------------------

server.registerTool(
  "wf_get_entities_by_type",
  {
    title: "List all entities of a given type",
    description: "Returns every entity of the given Layer-0 type (person, place, faction, object, event, concept).",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      type: z.enum(["person", "place", "faction", "object", "event", "concept"])
    }
  },
  async ({ world, dataDir, type }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const { entities } = loadSnapshot(dir, w).snapshot;
      return text(entities.filter((e) => e.type === type));
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_get_session_state -------------------------------------------------------

server.registerTool(
  "wf_get_session_state",
  {
    title: "Get current session/export metadata",
    description:
      "Returns the snapshot's session metadata (session number, entity/edge counts, last export time). " +
      "Note: World Fabric's session layer (doom clocks, thread status) is not yet built (Layer 2, M13) — " +
      "this only reflects Layer 1 world-canon export state, not live session bookkeeping.",
    inputSchema: { world: worldParam, dataDir: dataDirParam }
  },
  async ({ world, dataDir }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const snap = loadSnapshot(dir, w);
      return text(snap.meta);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_apply_mutations ----------------------------------------------------------

const mutationSchema = z.object({
  op: z.enum(["upsert_entity", "upsert_edge", "delete_entity", "delete_edge", "upsert_type", "upsert_relationship_type"]),
  id: z.string().optional(),
  data: z.record(z.string(), z.any()).optional()
});

// applyMutationsToFoundry/applyMutationsWithHeadlessFallback/
// writeBackIdAssignments now live in ./lib/mutation-ops.mjs (Phase 6),
// shared verbatim with review-ui/server.mjs — imported above.

server.registerTool(
  "wf_apply_mutations",
  {
    title: "Write graph mutations for World Fabric to apply",
    description:
      "OVERWRITES world-fabric-mutations.json with this array — refuses (with an error) if the file still holds " +
      "queued-but-unapplied mutations, so an earlier queued write is never silently discarded. World Fabric's " +
      "in-Foundry mutation watcher polls every 5s, applies them (upsert/delete entity or edge), and clears the file. " +
      "Requires a Foundry client to have that world open and the module active — a 'queued' status in the response " +
      "means NOT applied yet, and this tool has NO headless fallback (unlike wf_sync_to_foundry). Without a live " +
      "Foundry client, route graph writes through a propose/accept/sync batch instead " +
      "(wf_propose_mutations or wf_propose_from_writeup -> accept -> wf_sync_to_foundry, which falls back to " +
      "applying against the standalone snapshot).",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      mutations: z.array(mutationSchema).min(1)
    }
  },
  async ({ world, dataDir, mutations }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      // Concurrency guard (persona round, 2026-08-31; gm-tools-conventions'
      // never-blind-overwrite rule — the same gap foundry-ops.mjs's own doc
      // comment already flagged): a bridge file that exists and isn't "[]"
      // is a previous queue nobody has drained; overwriting it silently
      // discarded those writes. The guard lives HERE (the raw tool), not in
      // the shared applyMutationsToFoundry, because sync/rollback's
      // live-then-headless fallback deliberately reuses that function with
      // its own leftover-file semantics — changing those is a separate,
      // deeper investigation.
      const bridgePath = mutationsPath(dir, w);
      if (existsSync(bridgePath)) {
        const contents = readFileSync(bridgePath, "utf8").trim();
        if (contents && contents !== "[]") {
          let pendingCount = "some";
          try { const arr = JSON.parse(contents); if (Array.isArray(arr)) pendingCount = arr.length; } catch { /* unparseable still blocks */ }
          throw new Error(
            `Refusing to overwrite ${bridgePath}: it still holds ${pendingCount} queued-but-unapplied mutation(s) ` +
            `from an earlier write. Either wait for a live Foundry client (with this world open) to drain the ` +
            `queue, or if those mutations are known-stale, clear the file to [] yourself first.`
          );
        }
      }
      const result = await applyMutationsToFoundry(dir, w, mutations);
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// ======================================================================================
// Phase 1 — conversational review MCP tools (mutation engine surface)
//
// Each tool below is a thin wrapper calling straight into mutation-engine/'s
// library functions — see plans/phase-1-tasks.md task 1.8. No independent
// business logic lives here beyond parameter wiring, scope resolution, and
// status-text formatting.
// ======================================================================================

// resolveMutationIds/entityIdsForMutations/flaggedEntityIdSet/nextMutationIndex
// now live in ./lib/mutation-ops.mjs (Phase 6), imported above and reused
// verbatim inside that module's own acceptOp/rejectOp/regenerateOp/
// reviewGrainOp — nothing left to wire here beyond parameter passthrough.

const proposeScopeSchema = z.object({
  mode: z.enum(["seed", "ambient", "tag", "region", "contained-in"]),
  anchorId: z.string().optional().describe(
    "Entity ID to propagate impact from (mode='seed', required unless seeds[] is given) or to scope the " +
    "traversal from (mode='region'/'contained-in', required)."
  ),
  depth: z.number().int().min(1).max(1000).optional().describe(
    "Max BFS hops. mode='seed': default 3. mode='region': default 2 (an intentionally shallow proximity " +
    "radius). mode='contained-in': default effectively-unbounded (1000) — a district -> building -> room " +
    "chain is the multi-hop case this mode exists for."
  ),
  tag: z.string().optional().describe("Tag to scope an ambient-decay pass to (mode='tag')."),
  elapsedSessions: z.number().min(0).optional().describe(
    "Sessions elapsed, for the ambient-decay half-life calculation " +
    "(mode='ambient'/'tag'/'region'/'contained-in' when no seeds are given). Default 1."
  )
});

// --- wf_propose_mutations ----------------------------------------------------------

server.registerTool(
  "wf_propose_mutations",
  {
    title: "Propose a batch of graph mutations (propagate + texture + create batch)",
    description:
      "Runs the deterministic propagation pass (time-skip/scope.mjs: seed-based BFS impact for mode='seed', " +
      "ambient time-decay for mode='ambient', decay filtered to a tag for mode='tag', all-types BFS proximity " +
      "for mode='region' [a GM time-skipping one area/faction without touching the rest of the graph], and " +
      "containment-edges-only reachability for mode='contained-in' [\"what's structurally inside this place " +
      "right now\" — district/building/room chains; never follows origin or presence edges]) to find candidate " +
      "changes, then makes one Anthropic API call per affected region (never one per entity) to texture them " +
      "into concrete mutations with rationale, then writes a new review batch to review-state/. Returns batchId " +
      "+ a headline summary — call wf_review_batch next to drill in. Requires ANTHROPIC_API_KEY to be set in " +
      "THIS server process's environment for the texturing call — separate from any credential the calling " +
      "Claude Code session uses, since this call is outbound from the MCP server itself. LATENCY (measured, " +
      "Phase 3 task 3.1, 5 real timed runs each at depth=2 and depth=3, mode='seed' against a 50-entity/129-edge " +
      "fixture whose 15-17 texture-eligible entities land in a single connected region): depth=3 min=34.4s " +
      "p50=59.0s p90=59.9s max=59.9s; depth=2 min=26.1s p50=51.4s p90=62.5s max=62.5s. Depth barely moves this " +
      "— the real cost driver is texture-eligible entity count within ONE affected region (-> output token count " +
      "for that single API call), not raw BFS hop count. This is NOT reliably sub-5s live for a moderately-" +
      "connected anchor. A calling Claude Code session should say something like 'resolving, one moment' to the " +
      "user BEFORE invoking this tool for a 'seed' proposal, rather than letting the call appear to hang " +
      "silently for up to a minute.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      scope: proposeScopeSchema,
      elapsedTimeDescriptor: z.string().optional().describe(
        "Human-readable descriptor stored on the batch, e.g. '2 sessions' or 'a few hours'."
      ),
      seeds: z
        .array(z.object({ entityId: z.string(), magnitude: z.number().min(0).max(1) }))
        .optional()
        .describe(
          "Multiple simultaneous seed epicenters (mode='seed' only). If omitted, scope.anchorId with " +
          "magnitude 1.0 is used as a single seed. Results from multiple seeds are merged, keeping the " +
          "strongest impact reaching each entity."
        )
    }
  },
  async ({ world, dataDir, scope, elapsedTimeDescriptor, seeds }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const { entities, edges } = loadSnapshot(dir, w).snapshot;
      // Keyless safety: degrades to offlineTextureClient (one honest
      // placeholder edit per region) when ANTHROPIC_API_KEY is not set in
      // this server process's own environment -- see lib/offline-clients.mjs.
      const result = await orchestrateBatch(w, scope, elapsedTimeDescriptor, {
        entities,
        edges,
        seeds,
        textureOpts: offlineOpts(() => offlineTextureClient("unspecified"))
      });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_propose_from_writeup -------------------------------------------------------

// Framing shapes shared by wf_propose_from_writeup's W2d `framing` carry-over
// and wf_select_framing below (declared here, above both).
const framingItemSchema = z.object({ id: z.enum(["a", "b", "c"]), sentence: z.string() });
const framingSelectionSchema = z.object({
  primary: framingItemSchema.describe("The framing the reviewer picked as primary."),
  blend: z.string().optional().describe("Optional freeform blend line, e.g. 'also pull in elements of framing C: ...'.")
});

server.registerTool(
  "wf_propose_from_writeup",
  {
    title: "Propose graph entities/edges extracted from freeform text (bring your own world)",
    description:
      "Given freeform text (a campaign pitch, prep notes, a wiki export, a session recap), makes one Anthropic " +
      "API call to extract a WFI-shaped proposal (entities/edges, endpoints referenced by name -- graph-import/" +
      "writeup-import.mjs's proposeWfiFromWriteup), dry-runs it through interchange.mjs's importGraph against the " +
      "live snapshot WITHOUT persisting (existing name+type dedup: an entity the writeup mentions that already " +
      "exists in the graph merges into an UPDATE instead of duplicating; edges referencing an undescribed name " +
      "get a stub entity, exactly like any other WFI import), and writes the result as a normal review batch -- " +
      "same review gate (wf_review_batch/wf_accept/wf_reject/wf_regenerate/wf_sync_to_foundry) every other batch " +
      "goes through. Works against a freshly-bootstrapped empty snapshot (a genuinely new campaign) just as well " +
      "as an existing populated one. `mode='replace'` only changes how THIS PREVIEW classifies create-vs-existing " +
      "(importGraph's own replace semantics) -- the actual commit at wf_sync_to_foundry time always applies each " +
      "mutation individually and never wipes anything not mentioned in the batch. Requires ANTHROPIC_API_KEY in " +
      "this server process's own environment, same as wf_propose_mutations -- WITHOUT a key this degrades to an " +
      "offline placeholder client whose extraction is honestly EMPTY: the response carries `offline: true` and an " +
      "explanatory `offlineNote`, and the resulting 0-mutation batch means OFFLINE, not that your text contained " +
      "nothing extractable. PHASE 8 -- rubber-duck mode: if the " +
      "GM's global setting (wf_get_rubber_duck_mode) is OFF, this behaves EXACTLY as above, single call, single " +
      "batch, unchanged from Phase 5. If it's ON, this call instead returns `{phase:'framing', framings, " +
      "writeupText, mode, rubberDuck}` -- three cheap one-sentence interpretive framings (graph-import/" +
      "writeup-import.mjs's proposeFramingsFromWriteup, a faster/cheaper model tier) and NO batch is created yet. " +
      "Pick one (or blend) and call wf_select_framing next, passing `writeupText`, `framings`, `selection`, and " +
      "the exact `rubberDuck` object echoed back here -- this is a stateless MCP tool call, so the caller carries " +
      "these values forward rather than this server holding session state. FRICTION WAVE 1 (W2d) -- resubmitting " +
      "already-framed material (e.g. after splitting a writeup that hit the W2c truncation fail-fast): pass the " +
      "optional `framing` argument ({framings, selection, rubberDuck} -- the same values a wf_select_framing call " +
      "would carry, echoed forward by the caller) to SKIP the phase-A framing round entirely; the extraction runs " +
      "immediately with that steering, and the carried framings/selection are recorded on the new batch's " +
      "framingHistory audit trail exactly as a phase-B pick would be. The live rubber-duck setting is NOT re-read " +
      "on that path -- the carried snapshot stays authoritative for the whole resubmit family.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      text: z.string().min(1).describe("Freeform writeup text to extract graph entities/edges from."),
      mode: z.enum(["merge", "replace"]).optional().describe("Passed through to importGraph's dry-run preview. Default 'merge'."),
      framing: z
        .object({
          framings: z.array(framingItemSchema).length(3).describe("The 3 framings originally shown to the reviewer -- recorded on the audit trail."),
          selection: framingSelectionSchema,
          rubberDuck: z.object({ enabled: z.boolean(), updatedAt: z.string().nullable() }).describe("The settings snapshot echoed back by the ORIGINAL phase-A response.")
        })
        .optional()
        .describe(
          "W2d framing carry-over: a framing/steering selection already made for this material -- skips the " +
          "rubber-duck phase-A round entirely on a resubmit (split or rephrased writeup) instead of re-asking the GM."
        )
    }
  },
  async ({ world, dataDir, text: writeupText, mode, framing }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      // Keyless safety -- see lib/offline-clients.mjs.
      const result = await proposeFromWriteupOp(dir, w, { text: writeupText, mode, framing }, { llmOpts: offlineOpts(offlineWriteupClient) });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_select_framing (Phase 8) ----------------------------------------------------

server.registerTool(
  "wf_select_framing",
  {
    title: "Select (or blend) a framing to steer writeup extraction (Phase 8 rubber-duck mode)",
    description:
      "Phase B of the rubber-duck-mode two-phase flow started by wf_propose_from_writeup. Composes the " +
      "reviewer's `selection` into a steering note (reusing the EXISTING note/regenerate mechanism -- no new " +
      "prompt slot) and runs the real extraction. Two mutually exclusive modes, selected by which of " +
      "`writeupText`/`batchId` is given: (1) `writeupText` set, `batchId` omitted -- the reviewer's FIRST framing " +
      "pick, right after wf_propose_from_writeup's phase A; creates a brand-new batch (also requires `rubberDuck`, " +
      "the exact snapshot object echoed back by that phase-A call -- carried forward, never re-read live here, " +
      "per the read-once invariant). (2) `batchId` set, `writeupText` omitted -- the reviewer's pick after a " +
      "PLAIN reject on an existing rubber-duck batch triggered a new framing round (see wf_reject); replaces that " +
      "batch's mutations wholesale via the existing regenerate path. Either way, `framings` (the 3 shown to the " +
      "reviewer) is recorded onto the batch's audit trail (batch.scope.framingHistory) alongside the selection " +
      "and composed note -- this is also what enforces the bounded one-re-framing-round rule end to end. Requires " +
      "ANTHROPIC_API_KEY, same as wf_propose_from_writeup.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      writeupText: z.string().optional().describe("Required (with `rubberDuck`) when `batchId` is omitted -- the original writeup text, echoed back by wf_propose_from_writeup's phase A."),
      batchId: z.string().optional().describe("Required when `writeupText` is omitted -- re-framing an existing batch after a plain reject."),
      mode: z.enum(["merge", "replace"]).optional().describe("Only used on the writeupText path. Default 'merge'."),
      framings: z.array(framingItemSchema).length(3).describe("The exact 3 framings shown to the reviewer -- recorded for the audit trail."),
      selection: framingSelectionSchema,
      rubberDuck: z
        .object({ enabled: z.boolean(), updatedAt: z.string().nullable() })
        .optional()
        .describe("Required on the writeupText path -- the exact object echoed back by wf_propose_from_writeup's phase A.")
    }
  },
  async ({ world, dataDir, writeupText, batchId, mode, framings, selection, rubberDuck }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      // Keyless safety -- see lib/offline-clients.mjs.
      if (batchId) {
        const result = await selectFramingForExistingBatch(dir, w, { batchId, framings, selection }, { llmOpts: offlineOpts(offlineWriteupClient) });
        return text(result);
      }
      if (!writeupText) {
        throw new Error("wf_select_framing requires either `batchId` (re-framing an existing batch) or `writeupText` (a first framing pick).");
      }
      const result = await selectFramingForNewBatch(dir, w, { writeupText, mode, framings, selection, rubberDuck }, { llmOpts: offlineOpts(offlineWriteupClient) });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_get_rubber_duck_mode / wf_set_rubber_duck_mode (Phase 8) ---------------------

server.registerTool(
  "wf_get_rubber_duck_mode",
  {
    title: "Get the global rubber-duck-mode setting",
    description:
      "Reads mutation-engine/user-settings.mjs's standing global toggle (not per-world, not per-import). When " +
      "on, wf_propose_from_writeup's first response is 3 cheap interpretive framings instead of the real " +
      "extraction -- see wf_propose_from_writeup's own description. This is a live read of the CURRENT setting; " +
      "an already-created writeup-import batch is unaffected by any later change (it carries its own stamped " +
      "batch.scope.rubberDuck snapshot from the moment it was submitted).",
    inputSchema: {}
  },
  async () => {
    try {
      return text(getUserSettings().rubberDuckMode);
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_set_rubber_duck_mode",
  {
    title: "Set the global rubber-duck-mode setting",
    description:
      "Flips mutation-engine/user-settings.mjs's standing global toggle. Takes effect for the NEXT " +
      "wf_propose_from_writeup submission only -- any batch already in review keeps whatever value was in " +
      "effect when it was submitted (batch.scope.rubberDuck), never retroactively affected by this call.",
    inputSchema: { enabled: z.boolean() }
  },
  async ({ enabled }) => {
    try {
      return text(setRubberDuckMode(enabled).rubberDuckMode);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_review_batch -----------------------------------------------------------------

server.registerTool(
  "wf_review_batch",
  {
    title: "Render a proposed mutation batch at a given grain",
    description:
      "Renders the requested detail level for a batch created by wf_propose_mutations: 'headline' (whole batch, " +
      "collapsed by importance -- an entity flagged by long-unreviewed-accumulation tracking is forced into the " +
      "headline regardless of importance, see wf_get_unreviewed_entities), 'region' (one region's mutations, full " +
      "detail for important ones), or 'entity' (one mutation's full drill-down, regardless of collapse). Viewing " +
      "at 'region'/'entity' grain marks the entities actually shown as human-reviewed (Phase 4 task 4.2) -- " +
      "'headline' grain does NOT, since a collapsed one-liner isn't a genuine review of the diff underneath it.",
    inputSchema: {
      world: worldParam,
      batchId: z.string(),
      grain: z.enum(["headline", "region", "entity"]),
      regionId: z.string().optional().describe("Required for grain='region'."),
      entityId: z.string().optional().describe("mutationId or target entity/edge id — required for grain='entity'.")
    }
  },
  async ({ world, batchId, grain, regionId, entityId }) => {
    try {
      const w = resolveWorld(world);
      const { rendered } = reviewGrainOp(w, { batchId, grain, regionId, entityId });
      return text({ rendered });
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_accept / wf_reject -------------------------------------------------------------

const scopeIdParam = z.string().optional().describe(
  "regionId (scope='region') or mutationId/target entity-or-edge id (scope='entity'). Not needed for scope='batch'."
);

server.registerTool(
  "wf_accept",
  {
    title: "Accept mutation(s) in a review batch",
    description:
      "Marks mutation(s) accepted via review-state.mjs, capturing each target's pre-mutation entity/edge state " +
      "(from the live snapshot) for rollback.mjs's later use. Scope 'batch' accepts every mutation in the batch, " +
      "'region' accepts one region's mutations, 'entity' accepts a single mutation. If this batch originated from " +
      "wf_resolve_pending or a wf_run_cycle growth-bound sweep, accepting the affected region/batch also clears " +
      "(resolves) the pending-ledger entries it was resolving -- reported in the response as `ledgerResolved` when " +
      "applicable, omitted otherwise. Phase 4 task 4.2: scope 'region'/'entity' counts as a genuine human review " +
      "of the entities touched (updates lastHumanReviewedAt); scope 'batch' (accept-all) deliberately does NOT -- " +
      "it instead accumulates an unreviewed-accept count per entity, surfaced by wf_get_unreviewed_entities. This " +
      "is the entire point of the feature: a GM batch-accepting everything without reading any of it must not " +
      "count as having reviewed it.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      batchId: z.string(),
      scope: z.enum(["batch", "region", "entity"]),
      id: scopeIdParam
    }
  },
  async ({ world, dataDir, batchId, scope, id }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const result = await acceptOp(dir, w, { batchId, scope, id });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_reject",
  {
    title: "Reject mutation(s) in a review batch",
    description:
      "Marks mutation(s) rejected via review-state.mjs. Same scope semantics as wf_accept. If this batch " +
      "originated from wf_resolve_pending or a wf_run_cycle growth-bound sweep, rejecting the affected region/batch " +
      "reverts the pending-ledger entries it was resolving back to 'pending' (never deleted) -- reported as " +
      "`ledgerReverted` when applicable. Phase 4 task 4.2: scope 'region'/'entity' still counts as a genuine human " +
      "review of the entities touched (a deliberate reject is still an examined diff) -- updates " +
      "lastHumanReviewedAt. Scope 'batch' does not (consistent with wf_accept), but also does NOT accumulate an " +
      "unreviewed-accept count, since a rejected mutation never lands on the graph -- there's no unreviewed " +
      "content debt left behind by a reject. PHASE 8 -- rubber-duck mode's reject loop: for a batch created with " +
      "rubber-duck mode on (batch.scope.rubberDuck.enabled), a scope='batch'/'region' reject requires either " +
      "`note` or `quickPickReason` and behaves differently from normal mode's silent reject-and-wait -- an " +
      "EXPLICIT `note` skips straight to the existing regenerate path (response includes " +
      "`rubberDuckLoop:{kind:'regenerate',...}`); a `quickPickReason` (one of: wrong-emphasis, wrong-scope, " +
      "missing-something, not-feeling-it-yet) triggers a new bounded round of framings (response includes " +
      "`rubberDuckLoop:{kind:'reframe', framings}` -- call wf_select_framing with `batchId` set next). A SECOND " +
      "quickPickReason reject on the same batch is refused (FramingRoundLimitError) -- the reviewer must supply " +
      "an explicit `note` instead. Scope='entity', or any batch not in rubber-duck mode, is completely unaffected " +
      "by all of the above -- exactly the pre-Phase-8 behavior, no new fields in the response.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      batchId: z.string(),
      scope: z.enum(["batch", "region", "entity"]),
      id: scopeIdParam,
      note: z.string().optional().describe(
        "Phase 8 rubber-duck mode only: an explicit reason. Skips the framing loop entirely, straight to regenerate."
      ),
      quickPickReason: z.enum(["wrong-emphasis", "wrong-scope", "missing-something", "not-feeling-it-yet"]).optional().describe(
        "Phase 8 rubber-duck mode only: a quick-pick reason (no free text). Triggers a new bounded framing round."
      )
    }
  },
  async ({ world, dataDir, batchId, scope, id, note, quickPickReason }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const result = await rejectWithLoopOp(dir, w, { batchId, scope, id, note, quickPickReason });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_regenerate ---------------------------------------------------------------------

server.registerTool(
  "wf_regenerate",
  {
    title: "Regenerate texturing for mutation(s), with a steering note",
    description:
      "Re-invokes the texturing pass (mutation-engine/texture.mjs) for the selected scope, appending `note` to " +
      "the prompt. REPLACES (does not stack onto) the prior proposal for that scope: the targeted mutations are " +
      "removed and new ones (status:'pending') take their place. Still makes one API call per affected region, " +
      "not one per mutation. Requires ANTHROPIC_API_KEY in this server's environment, same as wf_propose_mutations. " +
      "Phase 4 task 4.2: scope 'region'/'entity' counts as a genuine human review of the targeted entities (asking " +
      "for a redo is still an examined diff) -- updates lastHumanReviewedAt. Scope 'batch' does not. " +
      "Phase 5: for a batch produced by wf_propose_from_writeup (sourceKind 'writeup-import'), this instead " +
      "re-invokes graph-import/writeup-import.mjs's proposeWfiFromWriteup against the batch's ORIGINAL source text " +
      "plus `note`, then re-runs the dry-run merge -- writeup extraction is one holistic pass over the whole text, " +
      "not a per-entity delta, so scope='batch'/'region' (equivalent for a writeup-import batch -- it always has " +
      "exactly one region) replace the WHOLE proposal; scope='entity' is refused with a clear error rather than " +
      "attempting an unsound partial replace.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      batchId: z.string(),
      scope: z.enum(["batch", "region", "entity"]),
      id: scopeIdParam,
      note: z.string().describe("Steering note appended to the texturing prompt, e.g. 'make the tone darker'.")
    }
  },
  async ({ world, dataDir, batchId, scope, id, note }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      // Keyless safety -- both opts are passed unconditionally; regenerateOp
      // itself dispatches to whichever one its batch's sourceKind actually
      // needs (writeup-import vs. texture) -- see lib/offline-clients.mjs.
      const result = await regenerateOp(dir, w, { batchId, scope, id, note }, {
        writeupOpts: { llmOpts: offlineOpts(offlineWriteupClient) },
        textureOpts: offlineOpts(() => offlineTextureClient("regenerated"))
      });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_sync_to_foundry ------------------------------------------------------------------

server.registerTool(
  "wf_sync_to_foundry",
  {
    title: "Sync a batch's accepted mutations to Foundry",
    description:
      "Writes every 'accepted' mutation in the given batch to world-fabric-mutations.json via the same file " +
      "bridge wf_apply_mutations uses (the live path — requires a Foundry client to have the world open). " +
      "If that path reports 'queued' (no live client picked it up within the poll window), falls back to " +
      "graph-import/headless-apply.mjs's applyHeadless() against the standalone world-fabric-snapshot.json " +
      "directly — no live Foundry client required. Always reports which path was actually used (`path`: " +
      "'live' or 'headless') — never just a bare 'success'. Marks the batch 'synced' either way. If the headless " +
      "path assigned an id to a newly-created entity/edge (a mutation with no id at propose time), that " +
      "assignment is written back onto the batch's stored mutation entry and reported under `idAssignments` " +
      "(mutationId -> assigned id) — this is what lets wf_rollback_batch later target the creation for a " +
      "delete-based rollback instead of skipping it (Phase 4 task 4.1). Known limitation of the headless path: " +
      "if this world ALSO has a live Foundry client that is merely closed right now (not a genuinely " +
      "headless-only campaign), that client's own next export will overwrite the snapshot file from its " +
      "in-Foundry game.settings state, silently discarding a headless-applied change — there is no " +
      "reconciliation path back into game.settings yet (a foundry_worldFabric-side change, out of this phase's scope).",
    inputSchema: { world: worldParam, dataDir: dataDirParam, batchId: z.string() }
  },
  async ({ world, dataDir, batchId }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const result = await syncOp(dir, w, { batchId });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_narrate_batch ---------------------------------------------------------------------

server.registerTool(
  "wf_narrate_batch",
  {
    title: "Narrate an accepted mutation batch as in-fiction, player-facing prose",
    description:
      "Generates 2-3 paragraphs of scene/consequence narration for a batch's mutations (mutation-engine/narrate.mjs) " +
      "-- what the players actually see, read aloud at the table. This is NOT the reviewer-facing `rationale` field " +
      "reused; it's new prose written for a different audience, with no meta-commentary. Hard-gated: every mutation " +
      "in the batch must already be status:'accepted' (via wf_accept) -- if any mutation is still pending/rejected/" +
      "regenerate-requested, this is refused with a clear typed error listing which ones, never partially narrated " +
      "and never silently skipped. Pass `note` to regenerate with steering guidance (e.g. 'make the tone darker') " +
      "-- this never touches review-state.mjs's mutation-acceptance status, only produces new prose. Requires " +
      "ANTHROPIC_API_KEY in this server process's own environment, same as wf_propose_mutations.",
    inputSchema: {
      world: worldParam,
      batchId: z.string(),
      note: z.string().optional().describe(
        "Steering note for regenerating narration with different tone/guidance, e.g. 'make it more ominous'. " +
        "Produces new prose only -- does not affect any mutation's accepted status."
      )
    }
  },
  async ({ world, batchId, note }) => {
    try {
      const w = resolveWorld(world);
      const dir = resolveDir();
      // Keyless safety -- see lib/offline-clients.mjs.
      const result = await narrateOp(dir, w, { batchId, note }, offlineOpts(offlineNarrateClient));
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// ======================================================================================
// Phase 10 -- per-entity narration & persistence (mutation-engine/narrate.mjs's
// narrateEntity, mutation-engine/entity-narration.mjs's durable history store).
// This is now the DEFAULT narration path (review-ui uses these, not
// wf_narrate_batch above) -- see plans/phase-10-review.md for the root cause
// this replaces: whole-batch narration meant every row in a batch showed the
// same text, "regenerate" recycled that same generic text, and nothing ever
// persisted across a page reload. wf_narrate_batch itself is unchanged and
// still available for a whole-scene summary if that's ever independently
// useful.
// ======================================================================================

// --- wf_narrate_entity ---------------------------------------------------------------------

server.registerTool(
  "wf_narrate_entity",
  {
    title: "Narrate ONE accepted mutation as in-fiction, player-facing prose, grounded in its real graph neighbors",
    description:
      "Generates 2-3 paragraphs of narration for a SINGLE mutation within a batch (mutation-engine/narrate.mjs's " +
      "narrateEntity), not the whole batch -- the per-entity replacement for wf_narrate_batch. Grounds the prompt " +
      "in the targeted entity's own real, immediate graph neighbors (depth-1 adjacency) instead of an empty " +
      "location/area pair, so the result is specific to this entity rather than a generic scene-setting framing. " +
      "Hard-gated exactly like wf_narrate_batch, but at ENTITY grain: only the targeted mutation must be " +
      "status:'accepted' -- sibling mutations elsewhere in the batch being pending/rejected does not block this " +
      "call. On success, the result is persisted durably via mutation-engine/entity-narration.mjs (a genuine " +
      "history, not an overwritten 'latest' value) -- survives a page reload, and remains recallable via " +
      "wf_get_entity_narration_history even after a later regenerate or re-mutation supersedes it. Pass `note` to " +
      "regenerate with steering guidance -- this creates a NEW history entry, it does not overwrite the prior one " +
      "in place. Requires ANTHROPIC_API_KEY in this server process's own environment, same as wf_propose_mutations.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      batchId: z.string(),
      mutationId: z.string().describe("Which mutation within the batch to narrate (StoredMutation.mutationId, not the target entity id)."),
      note: z.string().optional().describe(
        "Steering note for regenerating this entity's narration with different tone/guidance. Produces a NEW " +
        "history entry (the prior one is marked superseded, never deleted), not an in-place overwrite."
      )
    }
  },
  async ({ world, dataDir, batchId, mutationId, note }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      // Keyless safety -- see lib/offline-clients.mjs.
      const result = await narrateEntityOp(dir, w, { batchId, mutationId, note }, offlineOpts(offlineNarrateClient));
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_get_entity_narration -----------------------------------------------------------------

server.registerTool(
  "wf_get_entity_narration",
  {
    title: "Get an entity's current (not superseded) narration, if any",
    description:
      "Reads mutation-engine/entity-narration.mjs's store for the one narration entry with status:'current' for " +
      "this entity, or null if it has never been narrated (or its only narration has since been superseded by a " +
      "re-mutation or regenerate with nothing yet replacing it). Does not call the model or spend a token -- a " +
      "pure read. Use wf_get_entity_narration_history for the entity's full history including superseded entries.",
    inputSchema: { world: worldParam, entityId: z.string() }
  },
  async ({ world, entityId }) => {
    try {
      const w = resolveWorld(world);
      return text(getEntityNarrationOp(w, { entityId }));
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_get_entity_narration_history ----------------------------------------------------------

server.registerTool(
  "wf_get_entity_narration_history",
  {
    title: "Get an entity's FULL narration history, including superseded entries",
    description:
      "Reads mutation-engine/entity-narration.mjs's full history array for this entity -- every narration ever " +
      "generated for it, oldest first, each marked 'current' or 'superseded'. Nothing is ever deleted: a prior " +
      "accepted narration remains recallable here even after a newer one exists or the entity has since been " +
      "re-mutated. Returns an empty array for an entity that has never been narrated -- not an error.",
    inputSchema: { world: worldParam, entityId: z.string() }
  },
  async ({ world, entityId }) => {
    try {
      const w = resolveWorld(world);
      return text(getEntityNarrationHistoryOp(w, { entityId }));
    } catch (err) {
      return errorText(err);
    }
  }
);

// ======================================================================================
// Phase 11 -- per-node content generation ("develop this node"): an opt-in,
// entity-scoped, framing-first two-stage pipeline (mutation-engine/
// prep-content.mjs) producing structured, type-specific GM prep content
// (description, secret, potential rolls, hooks -- different fields per
// entity type). Triggered from an already-committed entity, NEVER a Batch
// Review row action -- there is no batchId parameter anywhere below, so
// these tools are not reachable from the batch-review tool surface even in
// principle. Stored in its own separate store, never synced to Foundry:
// no tool below writes to world-fabric-mutations.json or the standalone
// snapshot, and none is called by wf_sync_to_foundry/wf_apply_mutations.
// ======================================================================================

// --- wf_propose_prep_framings ---------------------------------------------------------

server.registerTool(
  "wf_propose_prep_framings",
  {
    title: "Propose 3 framings for developing an entity's prep content (Phase 11, round 1)",
    description:
      "Given an already-committed entity (person/place/faction/object/event/concept), makes one cheap Anthropic " +
      "API call (mutation-engine/prep-content.mjs's proposeFramingsForEntity, haiku tier) grounded in the entity's " +
      "own recorded fields AND its real immediate graph neighborhood, returning 3 one-sentence interpretive angles " +
      "-- the same framing-first discipline as the whole-writeup rubber-duck mode (wf_propose_from_writeup), one " +
      "level down to a single entity. No content is generated yet and nothing is persisted. Pick one (or write a " +
      "custom framing) and call wf_generate_prep_content next. Requires ANTHROPIC_API_KEY in this server " +
      "process's own environment.",
    inputSchema: { world: worldParam, dataDir: dataDirParam, entityId: z.string().describe("An already-committed entity/edge id from the live snapshot.") }
  },
  async ({ world, dataDir, entityId }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      // Keyless safety -- see lib/offline-clients.mjs.
      const result = await proposePrepFramingsOp(dir, w, { entityId }, offlineOpts(() => offlinePrepContentClient("framing")));
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_reframe_prep_framings ----------------------------------------------------------

server.registerTool(
  "wf_reframe_prep_framings",
  {
    title: "Request one bounded re-framing round for an entity's prep content (Phase 11)",
    description:
      "If the reviewer doesn't like any of wf_propose_prep_framings' three angles, this requests ONE more round " +
      "(bounded, mirroring writeup-import's MAX_FRAMING_ROUNDS precedent) -- pass `priorRoundCount` (1 right after " +
      "the initial proposal). A second reframe attempt is refused (PrepFramingRoundLimitError) -- pick one of the " +
      "current framings, or write a fully custom one, instead. Requires ANTHROPIC_API_KEY.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      entityId: z.string(),
      priorRoundCount: z.number().int().min(1).optional().describe("How many framing rounds have already happened for this entity's in-progress 'develop this node' session. Default 1.")
    }
  },
  async ({ world, dataDir, entityId, priorRoundCount }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      // Keyless safety -- see lib/offline-clients.mjs.
      const result = await reframePrepFramingsOp(dir, w, { entityId, priorRoundCount }, offlineOpts(() => offlinePrepContentClient("framing")));
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_generate_prep_content ------------------------------------------------------------

const prepFramingItemSchema = z.object({ id: z.string(), sentence: z.string() });
const prepFramingSelectionSchema = z.object({
  primary: prepFramingItemSchema.describe("The framing picked as primary (or a custom {id:'d', sentence} the reviewer wrote themselves)."),
  blend: z.string().optional().describe("Optional freeform blend line.")
});

server.registerTool(
  "wf_generate_prep_content",
  {
    title: "Generate this entity's structured prep content, steered by the chosen framing (Phase 11, round 2)",
    description:
      "The fuller generation call (mutation-engine/prep-content.mjs's generatePrepContent), steered by `selection` " +
      "(composed into a steering note the same way wf_select_framing composes a writeup-import selection), grounded " +
      "in the entity's real fields and graph neighborhood. Produces a STRUCTURED, type-specific object (not flat " +
      "prose) -- different fields for a person vs. a place vs. a faction vs. an object vs. an event vs. a reduced " +
      "concept template, per this phase's design. Immediately persisted as a 'proposed' draft (mutation-engine/" +
      "prep-content.mjs's own store, NOT the mutation-engine/review-state.mjs pipeline, NEVER synced to Foundry) " +
      "-- call wf_accept_prep_content to confirm it, or wf_discard_prep_content to throw it away. Requires " +
      "ANTHROPIC_API_KEY.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      entityId: z.string(),
      selection: prepFramingSelectionSchema
    }
  },
  async ({ world, dataDir, entityId, selection }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      // Keyless safety -- entityType is read for the offline client's
      // per-type placeholder shape ONLY when actually offline (mirrors
      // review-ui/server.mjs's own entityTypeForOffline convention). See
      // lib/offline-clients.mjs.
      const entityTypeForOffline = isOffline() ? findEntity(loadSnapshot(dir, w).snapshot.entities, entityId)?.type : null;
      const result = await generatePrepContentOp(dir, w, { entityId, selection }, offlineOpts(() => offlinePrepContentClient("generate", { entityType: entityTypeForOffline })));
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_get_prep_content -----------------------------------------------------------------

server.registerTool(
  "wf_get_prep_content",
  {
    title: "Get an entity's current prep content, if any",
    description:
      "Reads mutation-engine/prep-content.mjs's store for this entity -- a pure read, no model call, no cost. " +
      "Returns {entityId, prepContent:null} if this entity has never been developed.",
    inputSchema: { world: worldParam, entityId: z.string() }
  },
  async ({ world, entityId }) => {
    try {
      const w = resolveWorld(world);
      return text(getPrepContentOp(w, { entityId }));
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_accept_prep_content / wf_discard_prep_content ------------------------------------

server.registerTool(
  "wf_accept_prep_content",
  {
    title: "Accept a 'proposed' prep-content draft",
    description:
      "Flips status 'proposed' -> 'accepted', with no model call and no change to `fields`. Required before " +
      "wf_regenerate_prep_field's living-doc field-granular editing is meaningful, per this phase's design (the " +
      "review gate: nothing about a generated draft is treated as settled prep material until explicitly " +
      "accepted). Throws if nothing has been proposed yet for this entity.",
    inputSchema: { world: worldParam, entityId: z.string() }
  },
  async ({ world, entityId }) => {
    try {
      const w = resolveWorld(world);
      return text(acceptPrepContentOp(w, { entityId }));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_discard_prep_content",
  {
    title: "Discard a not-yet-accepted 'proposed' prep-content draft",
    description:
      "Deletes a 'proposed' draft outright -- safe because it was never confirmed as real prep material. Refuses " +
      "(throws) to discard 'accepted' or 'stale' content: that is never deleted by this phase, only ever marked " +
      "stale (wf_mark_prep_content_stale). A safe no-op if there's nothing at all yet for this entity.",
    inputSchema: { world: worldParam, entityId: z.string() }
  },
  async ({ world, entityId }) => {
    try {
      const w = resolveWorld(world);
      return text(discardPrepContentOp(w, { entityId }));
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_regenerate_prep_field ------------------------------------------------------------

server.registerTool(
  "wf_regenerate_prep_field",
  {
    title: "Regenerate ONE field of an entity's prep content (Phase 11 living-doc editing)",
    description:
      "The field-granular living-doc revision path (mutation-engine/prep-content.mjs's regeneratePrepField + " +
      "updatePrepField): regenerates exactly the one named field, grounded in the entity's OTHER current fields " +
      "(for consistency) plus its real graph neighborhood, and persists ONLY that field -- every other field stays " +
      "byte-identical. Pass `note` for steering guidance (e.g. 'reveal a different secret'). Requires " +
      "ANTHROPIC_API_KEY.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      entityId: z.string(),
      fieldName: z.string().describe("Which field to regenerate, e.g. 'secret' or 'potentialRolls' -- must be a real field for this entity's type."),
      note: z.string().optional()
    }
  },
  async ({ world, dataDir, entityId, fieldName, note }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      // Keyless safety -- see lib/offline-clients.mjs.
      const entityTypeForOffline = isOffline() ? findEntity(loadSnapshot(dir, w).snapshot.entities, entityId)?.type : null;
      const result = await regeneratePrepFieldOp(dir, w, { entityId, fieldName, note }, offlineOpts(() => offlinePrepContentClient("field", { fieldName, entityType: entityTypeForOffline })));
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_mark_prep_content_stale -----------------------------------------------------------

server.registerTool(
  "wf_mark_prep_content_stale",
  {
    title: "Manually flag an entity's prep content as stale",
    description:
      "Flips status -> 'stale' without touching `fields` at all -- the same function task 11.4's accept-time hook " +
      "calls automatically when the underlying entity is re-mutated; exposed here too for a GM who wants to flag " +
      "it themselves. A safe no-op for an entity with no prep content yet.",
    inputSchema: { world: worldParam, entityId: z.string() }
  },
  async ({ world, entityId }) => {
    try {
      const w = resolveWorld(world);
      return text(markPrepContentStaleOp(w, { entityId }));
    } catch (err) {
      return errorText(err);
    }
  }
);

// ======================================================================================
// Narrative-state layer ("Layer 2") -- reveal state / GM truth / stance /
// clocks. Everything below is a DIRECT sidecar write with no review batch
// (adjudicated: the graph is untouched, so the no-silent-auto-write
// invariant doesn't apply; the GM action IS the review — see
// lib/narrative-state-ops.mjs's header). Records live beside the world
// snapshot (worlds/<world>/narrative-state/) so the git world-timeline
// captures graph + table-knowledge atomically. An entity with NO record is
// fully open: no gating anywhere, which is what keeps quick generation fast.
// ======================================================================================

const revealStateParam = z.enum(["hidden", "unrevealed", "hinted", "revealed"]).describe(
  "hidden = players don't know this entity EXISTS (excluded from table-facing prompts entirely); " +
  "unrevealed = existence known, truth withheld; hinted = players have caught a hint; revealed = fully open."
);
const stanceParam = z.enum(["concealing", "unaware", "undisclosed"]).describe(
  "Why the truth is withheld — about the TRUTH, not the holder: 'concealing' (someone knows and actively hides " +
  "it), 'unaware' (the holder doesn't know it themselves; for places/objects, no one living knows), " +
  "'undisclosed' (merely obscure, hasn't come up). Stance reaches table-facing prompts as roleplay guidance; " +
  "the truth text never does."
);
const clockParam = z.object({
  value: z.number().int().min(0),
  max: z.number().int().min(1),
  cadence: z.string().optional().describe("Freeform display hint ('per session'); no auto-tick in v1.")
}).describe("A progress clock for this entity/thread.");

// --- wf_get_narrative_state ---------------------------------------------------------------

server.registerTool(
  "wf_get_narrative_state",
  {
    title: "Read an entity's narrative state (reveal/truth/stance/clock)",
    description:
      "Pure read of mutation-engine/narrative-state.mjs's sidecar record for one entity. " +
      "narrativeState:null means the entity has NO record — fully open, zero gating anywhere. " +
      "The `truth` field is GM-only prose: it never syncs to the graph and never reaches a table-facing prompt.",
    inputSchema: { world: worldParam, dataDir: dataDirParam, entityId: z.string() }
  },
  async ({ world, dataDir, entityId }) => {
    try {
      return text(getNarrativeStateOp(resolveDir(dataDir), resolveWorld(world), { entityId }));
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_set_narrative_state ---------------------------------------------------------------

server.registerTool(
  "wf_set_narrative_state",
  {
    title: "Set an entity's narrative state (any subset: reveal/truth/stance/clock)",
    description:
      "DIRECT write, no review batch (sidecar class — the graph is untouched; reveal state, truth, stance and " +
      "clocks are the GM's own table-state bookkeeping). Any subset of the four fields in one call; pass null to " +
      "clear truth/stance/clock; omitted fields are untouched. Creating a record via truth/stance/clock alone " +
      "starts it at revealState 'unrevealed' (writing a truth means withholding it). `truth` is GM-only: kept out " +
      "of every table-facing prompt structurally; put the player-safe surface in the entity's ordinary " +
      "description instead. Reveal changes append to the record's permanent transition history.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      entityId: z.string().describe("An already-committed entity id from the live snapshot."),
      revealState: revealStateParam.optional(),
      truth: z.string().min(1).nullable().optional().describe("GM-only truth prose (null clears). Surface stays in the entity's description."),
      stance: stanceParam.nullable().optional(),
      clock: clockParam.nullable().optional(),
      note: z.string().optional().describe("Optional note stamped onto a reveal transition."),
      sessionNumber: z.number().int().optional().describe("Session number to stamp onto a reveal transition.")
    }
  },
  async ({ world, dataDir, entityId, revealState, truth, stance, clock, note, sessionNumber }) => {
    try {
      return text(setNarrativeStateOp(resolveDir(dataDir), resolveWorld(world), { entityId, revealState, truth, stance, clock, note, sessionNumber }));
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_set_reveal_state ------------------------------------------------------------------

server.registerTool(
  "wf_set_reveal_state",
  {
    title: "Move an entity's reveal state (appends to its transition history)",
    description:
      "The focused reveal transition: hidden|unrevealed|hinted|revealed. Appends to the record's append-only " +
      "transition history with source/note/sessionNumber; setting the state it already has is a safe no-op. " +
      "DIRECT sidecar write, no review batch. Reveal state is what the table-facing knowledge gate reads: " +
      "'hidden' entities vanish from table prompts entirely; 'unrevealed'/'hinted' ones are alluded to but " +
      "never disclosed; 'revealed' lifts the gate.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      entityId: z.string(),
      to: revealStateParam,
      note: z.string().optional(),
      sessionNumber: z.number().int().optional()
    }
  },
  async ({ world, dataDir, entityId, to, note, sessionNumber }) => {
    try {
      return text(setRevealStateOp(resolveDir(dataDir), resolveWorld(world), { entityId, to, note, sessionNumber }));
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_tick_clock ------------------------------------------------------------------------

server.registerTool(
  "wf_tick_clock",
  {
    title: "Tick an entity's clock",
    description:
      "Advance (default +1) or rewind (negative delta) the entity's clock, clamped to [0, max]. Errors — not a " +
      "quiet success — for an entity with no clock set (set one via wf_set_narrative_state first). No auto-tick " +
      "exists in v1: clocks move only when the GM (or an explicitly GM-directed agent call) ticks them.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      entityId: z.string(),
      delta: z.number().int().optional().describe("Steps to advance (negative to rewind). Default 1.")
    }
  },
  async ({ world, dataDir, entityId, delta }) => {
    try {
      return text(tickClockOp(resolveDir(dataDir), resolveWorld(world), { entityId, delta }));
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_list_narrative_state --------------------------------------------------------------

server.registerTool(
  "wf_list_narrative_state",
  {
    title: "List a world's narrative-state records (filterable)",
    description:
      "Every entity with a narrative-state record (names joined from the live snapshot; an orphaned record — " +
      "entity gone from the graph — shows its raw id rather than being hidden). Filter with `revealState`, or " +
      "pass `ids` for a bulk lookup of just those entities (the run-spread tab-seeding fetch). Entities absent " +
      "from the result have no record and are fully open.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      revealState: revealStateParam.optional(),
      ids: z.array(z.string()).optional().describe("Bulk mode: return records for exactly these entity ids.")
    }
  },
  async ({ world, dataDir, revealState, ids }) => {
    try {
      return text(listNarrativeStateOp(resolveDir(dataDir), resolveWorld(world), { revealState, ids }));
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_rollback_batch -------------------------------------------------------------------

server.registerTool(
  "wf_rollback_batch",
  {
    title: "Roll back the most-recently-accepted batch",
    description:
      "Computes the mutations needed to restore this batch's accepted entries to their captured pre-accept " +
      "state (rollback.mjs), applies them via the live Foundry file bridge first and falls back to " +
      "graph-import/headless-apply.mjs's applyHeadless() against the standalone snapshot if no live client picks " +
      "them up within the poll window — same live-then-headless behavior wf_sync_to_foundry uses, and always " +
      "reports which path was used (`path`: 'live' or 'headless'), same convention (Phase 4 task 4.1: this tool " +
      "previously had no headless fallback at all, so a rollback against a genuinely headless-only campaign could " +
      "never actually apply). Marks the batch 'rolled-back' either way. Confirmed Phase-1 scope: the " +
      "most-recently-accepted batch only — pass that batch's id explicitly. Entries accepted before rollback.mjs " +
      "existed, or a newly-created entity/edge whose id was never written back onto this batch (this now happens " +
      "automatically when a create was synced via wf_sync_to_foundry's headless path, but NOT for one applied via " +
      "the live-Foundry path — Foundry does not report a created id back through the file bridge), are reported " +
      "in `skipped` rather than silently dropped.",
    inputSchema: { world: worldParam, dataDir: dataDirParam, batchId: z.string() }
  },
  async ({ world, dataDir, batchId }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const result = await rollbackOp(dir, w, { batchId });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// ======================================================================================
// Phase 4 task 4.2 — unreviewed-accumulation tracking (mutation-engine/human-review.mjs).
// Thin wrapper, same convention as everything above: no independent business logic
// beyond parameter wiring.
// ======================================================================================

// --- wf_get_unreviewed_entities -----------------------------------------------------------

server.registerTool(
  "wf_get_unreviewed_entities",
  {
    title: "Surface entities whose applied-but-unreviewed history has gone too long",
    description:
      "Runs mutation-engine/human-review.mjs's findUnreviewedEntities(): entities that have accumulated real, " +
      "applied graph mutations without a human ever genuinely reviewing them (viewing at 'region'/'entity' grain " +
      "via wf_review_batch, or a scoped 'region'/'entity' accept/reject/regenerate) -- a whole-batch accept-all " +
      "never counts as review, by design, so it's exactly the debt this surfaces. An entity is flagged if it was " +
      "never reviewed at all ('never-reviewed'), last reviewed more than `maxAgeDays` ago ('stale'), or has " +
      "accumulated at least `maxUnreviewedAccepts` batch-accept-all touches since its last real review " +
      "('accumulated') -- either threshold alone is enough. Only entities with SOME tracked accept/review history " +
      "appear at all; an entity nothing has ever touched has no debt to flag. The same flagged set also forces a " +
      "flagged entity into wf_review_batch's headline rendering regardless of importance.",
    inputSchema: {
      world: worldParam,
      maxAgeDays: z.number().min(0).optional().describe(`Default ${DEFAULT_MAX_AGE_DAYS}.`),
      maxUnreviewedAccepts: z.number().int().min(1).optional().describe(`Default ${DEFAULT_MAX_UNREVIEWED_ACCEPTS}.`)
    }
  },
  async ({ world, maxAgeDays, maxUnreviewedAccepts }) => {
    try {
      const w = resolveWorld(world);
      const flagged = findUnreviewedEntities(w, { maxAgeDays, maxUnreviewedAccepts });
      return text({ world: w, count: flagged.length, entities: flagged });
    } catch (err) {
      return errorText(err);
    }
  }
);

// ======================================================================================
// Phase 3.5 — deferred/lazy consequence resolution (mutation-engine/pending-ledger.mjs,
// time-skip/run-cycle.mjs, time-skip/resolve-pending.mjs). Thin wrappers, same convention
// as everything above: no independent business logic beyond parameter wiring.
// ======================================================================================

// --- wf_run_cycle ------------------------------------------------------------------------

server.registerTool(
  "wf_run_cycle",
  {
    title: "Run one deferred-resolution time-skip cycle (headline focus now, everything else deferred)",
    description:
      "Runs time-skip/run-cycle.mjs's orchestrateCycle(): resolves `cycleScope` (same shape as " +
      "wf_propose_mutations' `scope` -- everything this cycle could plausibly touch) via time-skip/scope.mjs, " +
      "eagerly textures a small 'headline' neighborhood (region-mode BFS around `headlineAnchorId`, depth " +
      "`headlineDepth`) into a real review batch, and defers EVERYTHING ELSE in cycleScope -- including deltas " +
      "that would have cleared needsLLM on their own -- to mutation-engine/pending-ledger.mjs instead of texturing " +
      "or discarding it. Zero further API cost is ever spent on a deferred entity unless wf_resolve_pending is " +
      "later called on it explicitly. Any entity touched by this cycle whose ledger already exceeds " +
      "`growthBoundThreshold` (default 5) gets its full accumulated backlog folded into THIS cycle's resolution " +
      "too (one more texture call), rather than left to grow further unbounded. Requires ANTHROPIC_API_KEY in " +
      "this server process's own environment for the headline texturing call (and the growth-bound sweep call, " +
      "if triggered) -- same latency caveat as wf_propose_mutations applies to the headline call.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      cycleScope: proposeScopeSchema.describe(
        "Full scope for this cycle -- same shape as wf_propose_mutations' `scope`. Everything this could " +
        "plausibly touch; the headline subset (below) is textured now, everything else is deferred."
      ),
      headlineAnchorId: z.string().describe("Entity id to eagerly texture THIS cycle -- the 'headline' focus."),
      headlineDepth: z.number().int().min(1).max(6).default(1).describe(
        "BFS depth around headlineAnchorId textured now. Default 1 (the anchor plus its close neighborhood) -- " +
        "deliberately small, this is the 'spend real money here' half of the cycle."
      ),
      elapsedTimeDescriptor: z.string().optional().describe("Human-readable descriptor stored on the batch, e.g. '1 month'."),
      cycleDescriptor: z.string().describe(
        "Short label for this cycle, e.g. 'month 3'. Stored on every deferred ledger entry this cycle writes and " +
        "used for chronological ordering when wf_resolve_pending eventually renders them."
      ),
      growthBoundThreshold: z.number().int().min(1).optional().describe(
        "Pending-entry count above which an already-bloated entity touched by this cycle gets swept into this " +
        "cycle's resolution instead of growing further. Default 5."
      )
    }
  },
  async ({ world, dataDir, cycleScope, headlineAnchorId, headlineDepth, elapsedTimeDescriptor, cycleDescriptor, growthBoundThreshold }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const { entities, edges } = loadSnapshot(dir, w).snapshot;
      // Keyless safety -- see lib/offline-clients.mjs.
      const result = await orchestrateCycle(
        w,
        { cycleScope, headlineAnchorId, headlineDepth, elapsedTimeDescriptor, cycleDescriptor },
        { entities, edges, growthBoundThreshold, textureOpts: offlineOpts(() => offlineTextureClient("unspecified")) }
      );
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_resolve_pending ------------------------------------------------------------------

server.registerTool(
  "wf_resolve_pending",
  {
    title: "Resolve an entity's accumulated pending-ledger backlog (explicit, opt-in only)",
    description:
      "Runs time-skip/resolve-pending.mjs's resolvePending(): the ONLY way anything ever gets pulled out of " +
      "mutation-engine/pending-ledger.mjs's backlog and turned into a real review batch. Gathers `entityId`'s own " +
      "pending ledger, finds its BFS neighborhood (depth), filters to neighbors that also carry a pending backlog, " +
      "sorts them by highest single pending impactScore descending, and folds in only the top `maxNeighbors` " +
      "(default 8) -- THE FAN-OUT CAP, which bounds cost regardless of how large or high-degree the neighborhood " +
      "is. Excluded neighbors are left untouched (still 'pending', still available for a future resolve). " +
      "Everything included gets hydrated with its full source-batch context and rendered chronologically by cycle " +
      "before ONE texturing call produces the resulting mutations. " +
      "IMPORTANT: this tool is NEVER invoked automatically by wf_get_entity, wf_get_context, or wf_get_adjacent, " +
      "or by any other read-path tool -- resolving costs a real API call, so it only ever runs when explicitly " +
      "requested here. An incidental read that happens to touch a tagged entity must never silently trigger a " +
      "resolve. Requires ANTHROPIC_API_KEY in this server process's own environment, same as wf_propose_mutations.",
    inputSchema: {
      world: worldParam,
      dataDir: dataDirParam,
      entityId: z.string().describe("The entity a GM is asking about -- its accumulated backlog (if any) gets resolved."),
      depth: z.number().int().min(1).max(4).optional().describe("Neighbor BFS depth. Default 1."),
      maxNeighbors: z.number().int().min(1).max(50).optional().describe(
        "The fan-out cap: max neighboring pending-bearing entities folded into this same resolve call, ranked by " +
        "highest single pending impactScore. Default 8."
      ),
      elapsedTimeDescriptor: z.string().optional()
    }
  },
  async ({ world, dataDir, entityId, depth, maxNeighbors, elapsedTimeDescriptor }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const { entities, edges } = loadSnapshot(dir, w).snapshot;
      // Keyless safety -- see lib/offline-clients.mjs.
      const result = await resolvePending(w, entityId, { depth, maxNeighbors }, {
        entities,
        edges,
        elapsedTimeDescriptor,
        textureOpts: offlineOpts(() => offlineTextureClient("resolved-pending"))
      });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- wf_pull_foundry_actors -------------------------------------------------

server.registerTool(
  "wf_pull_foundry_actors",
  {
    title: "Pull Foundry actors into the bestiary + party roster (review-gated)",
    description:
      "Reads worlds/<world>/world-fabric-foundry-index.json (written by the Foundry-side module's Reindex-for-" +
      "GM_Tools flow, Phase 32 task 32.1 -- a separate repo) and classifies every actor as a monster or a PC " +
      "(users[].characterUuid ownership is the authoritative signal; actor.type='character' is only a fallback " +
      "when no user claims it). Maps each into the EXISTING bestiary/party-roster stores' raw-field shapes and " +
      "saves as status:'proposed' -- NEVER silently 'accepted', matching this project's no-silent-auto-write " +
      "invariant; a human still has to accept each candidate. Re-running this against the same actor updates its " +
      "still-proposed candidate in place (never a duplicate); an already-accepted entry/member for that actor is " +
      "left completely untouched and reported back under alreadyLinked instead. Attacks/multiattack/recharge/" +
      "legendary-action fields are BEST-EFFORT, derived from the actor's embedded items -- read them as a " +
      "starting draft to review, not ground truth. Returns null-safe empty results (never throws) when no index " +
      "has been written yet for this world -- check `indexFound` to tell 'never reindexed' apart from 'reindexed, " +
      "but had zero actors'.",
    inputSchema: { world: worldParam, dataDir: dataDirParam }
  },
  async ({ world, dataDir }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const result = pullFoundryActorsToStores(dir, w);
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// ======================================================================================
// MCP wave -- Session Planner / Library / Chronicle parity tools. Agents can
// already work the graph/review/prep/writeup surface above; the tools below
// give an attached agent the SAME reach into the Session Planner (scenes/
// plans/elements/tray), the Library (bestiary/party/items/stagecraft), and
// the Chronicle (clock/fortune/intents/runs) that the review-ui app itself
// has -- so Russell + a Claude agent can co-plan a session THROUGH the tool,
// not just narrate around its edges.
//
// Every tool below reuses the SAME store/lib module review-ui/server.mjs's
// matching HTTP route calls (mirroring route semantics, never forking
// logic) -- see each tool's description for which route it mirrors, and
// wf-mcp-server/lib/chronicle-ops.mjs / lib/planner-ops.mjs for the two
// pieces of route composition logic that were extracted out to a shared
// module so both front-ends call the exact same code.
//
// RECONCILED, not duplicated: the task brief called for a "wf_receive_information"
// prose-intake tool ("writeup text -> importWriteup, both rubber-duck
// phases"). wf_propose_from_writeup (above) already does exactly this --
// off mode it returns a normal batch, rubber-duck-on mode returns
// {phase:'framing', framings, writeupText, mode, rubberDuck} for the caller
// to pick from -- and wf_select_framing (above) is already the framing-pick
// companion tool the brief asked to confirm exists. Nothing was added here;
// prose intake for an attached agent IS wf_propose_from_writeup.
// ======================================================================================

// --- Session Planner: reads --------------------------------------------------------

server.registerTool(
  "wf_list_plans",
  {
    title: "List every Plan for a world",
    description:
      "READ. Mirrors GET /api/scene-planning/plans -- session-planner/plans.mjs's listPlansForWorld(), in creation " +
      "(append) order. [] for a world with no plans yet (never a 404 -- a world only ever exists as an on-disk " +
      "store file, so 'no rows yet' and 'unknown world' are indistinguishable at the storage layer).",
    inputSchema: { world: requiredWorldParam }
  },
  async ({ world }) => {
    try {
      const w = resolveWorld(world);
      return text({ plans: listPlansForWorld(w) });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_get_plan",
  {
    title: "Get one Plan by id",
    description: "READ. Mirrors GET /api/scene-planning/plans/:planId -- session-planner/plans.mjs's getPlan(). Throws a clear error if not found.",
    inputSchema: { world: requiredWorldParam, planId: z.string() }
  },
  async ({ world, planId }) => {
    try {
      const w = resolveWorld(world);
      return text({ plan: getPlan(w, planId) });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_list_scenes",
  {
    title: "List every Scene for a world",
    description:
      "READ. Mirrors GET /api/session-planner/scenes[?sort=recency] -- session-planner/scenes.mjs's " +
      "listScenesForWorld() (creation order) or listScenesByRecency() (`recency:true` -- most-recently-touched " +
      "first, the same ordering the Session Planner UI's own scene list defaults to).",
    inputSchema: { world: requiredWorldParam, recency: z.boolean().optional().describe("true -- most-recently-touched first. Default false (creation order).") }
  },
  async ({ world, recency }) => {
    try {
      const w = resolveWorld(world);
      return text({ scenes: recency ? listScenesByRecency(w) : listScenesForWorld(w) });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_get_scene",
  {
    title: "Get one Scene, fully composed: record + elements + tray + narration",
    description:
      "READ. Composes FOUR existing reads into one call for planning convenience (session-planner/scenes.mjs's " +
      "getScene, scene-elements.mjs's listElementsForScene, scene-tray.mjs's getSceneTray, scene-narration.mjs's " +
      "getCurrentSceneNarration) -- the same four pieces the Session Planner UI's own scene page renders together, " +
      "no HTTP route composes them into one response today. `scene` throws a clear error if the id doesn't exist; " +
      "`elements`/`tray`/`narration` degrade gracefully (empty roster / null narration) rather than erroring.",
    inputSchema: { world: requiredWorldParam, sceneId: z.string() }
  },
  async ({ world, sceneId }) => {
    try {
      const w = resolveWorld(world);
      const scene = getScene(w, sceneId);
      const elements = listElementsForScene(w, sceneId);
      const tray = getSceneTray(w, sceneId);
      const narration = getCurrentSceneNarration(w, sceneId);
      return text({ scene, elements, tray, narration });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_get_scene_elements",
  {
    title: "List a Scene's ordered elements",
    description: "READ. Mirrors GET /api/scene-planning/scenes/:sceneId/elements -- session-planner/scene-elements.mjs's listElementsForScene(). [] if none.",
    inputSchema: { world: requiredWorldParam, sceneId: z.string() }
  },
  async ({ world, sceneId }) => {
    try {
      const w = resolveWorld(world);
      return text({ elements: listElementsForScene(w, sceneId) });
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- Session Planner: direct working-state mutations (like the UI) ------------------
// GATE POSTURE for every tool in this block: NONE -- these write directly,
// same as the review-ui frontend's own scene/plan/element/tray forms do.
// This is planner SCRATCH-SPACE (session prep the GM is actively drafting),
// not world canon -- it never touches the World Fabric graph except via the
// two explicit graph-linking ops (promote/from-graph, not exposed here --
// see manual-edit-ops.mjs's own header comment for why those stay UI-only)
// or a scene's own optional locationEntityId reference.

server.registerTool(
  "wf_create_plan",
  {
    title: "Create a new Plan",
    description: "MUTATION -- direct write, no review gate (planner scratch-space). Mirrors POST /api/scene-planning/plans. `sceneIds` starts empty.",
    inputSchema: { world: requiredWorldParam, name: z.string().optional() }
  },
  async ({ world, name }) => {
    try {
      const w = resolveWorld(world);
      return text({ plan: createPlan(w, { name }) });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_rename_plan",
  {
    title: "Rename a Plan",
    description: "MUTATION -- direct write, no review gate. Mirrors POST /api/scene-planning/plans/:planId/rename.",
    inputSchema: { world: requiredWorldParam, planId: z.string(), name: z.string().nullable() }
  },
  async ({ world, planId, name }) => {
    try {
      const w = resolveWorld(world);
      return text({ plan: renamePlan(w, planId, name) });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_add_scene_to_plan",
  {
    title: "Add an existing Scene to a Plan",
    description: "MUTATION -- direct write, no review gate. Mirrors POST /api/scene-planning/plans/:planId/scenes. Appends; use wf_reorder_plan to resequence.",
    inputSchema: { world: requiredWorldParam, planId: z.string(), sceneId: z.string() }
  },
  async ({ world, planId, sceneId }) => {
    try {
      const w = resolveWorld(world);
      return text({ plan: addSceneToPlan(w, planId, sceneId) });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_reorder_plan",
  {
    title: "Reorder a Plan's scenes",
    description:
      "MUTATION -- direct write, no review gate. Mirrors POST /api/scene-planning/plans/:planId/reorder. " +
      "`sceneIds` must be a permutation of the plan's CURRENT sceneIds -- throws a clear error otherwise (not a " +
      "silent partial reorder).",
    inputSchema: { world: requiredWorldParam, planId: z.string(), sceneIds: z.array(z.string()) }
  },
  async ({ world, planId, sceneIds }) => {
    try {
      const w = resolveWorld(world);
      return text({ plan: reorderPlanScenes(w, planId, sceneIds) });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_create_scene",
  {
    title: "Create a new Scene",
    description:
      "MUTATION -- direct write, no review gate. Mirrors POST /api/session-planner/scenes. If `locationEntityId` " +
      "is given and it resolves to an existing graph entity, that entity MUST be type 'place' -- rejected with a " +
      "clear error otherwise (an unknown id is allowed through unchanged, same as the route: the guard only fires " +
      "when the entity actually exists with a non-place type).",
    inputSchema: {
      world: requiredWorldParam,
      dataDir: dataDirParam,
      name: z.string().optional(),
      locationEntityId: z.string().optional().describe("Must reference a 'place'-type graph entity if it resolves to an existing one."),
      objectiveNote: z.string().optional()
    }
  },
  async ({ world, dataDir, name, locationEntityId, objectiveNote }) => {
    try {
      const w = resolveWorld(world);
      if (locationEntityId) {
        const dir = resolveDir(dataDir);
        const { entities } = loadSnapshot(dir, w).snapshot;
        const locationEntity = findEntity(entities, locationEntityId);
        if (locationEntity && locationEntity.type !== "place") {
          throw new Error(`Scene locationEntityId "${locationEntityId}" must reference a "place" entity (found type "${locationEntity.type}").`);
        }
      }
      return text({ scene: createScene(w, { locationEntityId, objectiveNote, name }) });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_update_scene",
  {
    title: "Patch a Scene's name/objective/kind/whereNote/tags/activeVariants",
    description:
      "MUTATION -- direct write, no review gate. Mirrors POST /api/session-planner/scenes/:sceneId (patch-style -- only supplied fields change). " +
      "Run-layout keys: `kind` (narrative|combat|transit|null) drives the seed skeleton + a 'combat' pill; `whereNote` is the Run spread's " +
      "where-line; `tags` render as pills; `activeVariants` gates which variant-tagged elements Run mode shows (empty = show all) -- " +
      "prefer wf_set_scene_active_variants for that one during live play. `objectiveInRun: false` keeps the objective GM-only " +
      "(the Run spread drops its Objective box; absent/true = shown).",
    inputSchema: {
      world: requiredWorldParam, sceneId: z.string(), name: z.string().optional(), objectiveNote: z.string().optional(),
      objectiveInRun: z.boolean().nullable().optional(),
      kind: z.enum(["narrative", "combat", "transit"]).nullable().optional(), whereNote: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(), activeVariants: z.array(z.string()).optional()
    }
  },
  async ({ world, sceneId, name, objectiveNote, objectiveInRun, kind, whereNote, tags, activeVariants }) => {
    try {
      const w = resolveWorld(world);
      return text({ scene: updateScene(w, sceneId, { name, objectiveNote, objectiveInRun, kind, whereNote, tags, activeVariants }) });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_add_scene_element",
  {
    title: "Add an element (prop/NPC/detail) to a Scene",
    description:
      "MUTATION -- direct write, no review gate. Mirrors POST /api/scene-planning/scenes/:sceneId/elements. " +
      "`kind` defaults to 'local' (a scene-scoped detail, not a graph node). `stat` lets a create call carry an " +
      "already-open stat block in one shot (e.g. dropping in an NPC/creature with hp/ac/cr).",
    inputSchema: {
      world: requiredWorldParam,
      sceneId: z.string(),
      name: z.string(),
      kind: z.enum(["local", "graph"]).optional(),
      fields: elementFieldsParam,
      stat: z.record(z.string(), z.any()).optional(),
      run: runLayoutParam
    }
  },
  async ({ world, sceneId, name, kind, fields, stat, run }) => {
    try {
      const w = resolveWorld(world);
      return text({ element: createElement(w, sceneId, { name, kind, fields, stat, run }) });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_update_scene_element",
  {
    title: "Patch a Scene element, including its stat block",
    description:
      "MUTATION -- direct write, no review gate. Mirrors POST /api/scene-planning/scenes/:sceneId/elements/:elementId. " +
      "Only supplied fields change; `stat` SHALLOW-MERGES onto the element's existing stat object (does not replace it wholesale).",
    inputSchema: {
      world: requiredWorldParam,
      sceneId: z.string(),
      elementId: z.string(),
      name: z.string().optional(),
      fields: elementFieldsParam,
      stat: z.record(z.string(), z.any()).optional(),
      run: runLayoutParam
    }
  },
  async ({ world, sceneId, elementId, name, fields, stat, run }) => {
    try {
      const w = resolveWorld(world);
      return text({ element: updateElement(w, sceneId, elementId, { name, fields, stat, run }) });
    } catch (err) {
      return errorText(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Run layout + live-play element tools (2026-08-26). All MUTATIONS are direct
// planner writes (no review gate -- prep working state, per the
// gm-tools-agent contract), mirroring the review-ui routes 1:1 so what an
// agent does over MCP and what the GM does in the UI are the same writes.
// The Run page polls a run-version fingerprint, so every one of these lands
// on an open Run screen within a few seconds.
// ---------------------------------------------------------------------------

server.registerTool(
  "wf_delete_scene_element",
  {
    title: "Remove an element from a Scene",
    description: "MUTATION -- direct write, no review gate. Mirrors DELETE /api/scene-planning/scenes/:sceneId/elements/:elementId. Idempotent; never touches a promoted element's graph node.",
    inputSchema: { world: requiredWorldParam, sceneId: z.string(), elementId: z.string() }
  },
  async ({ world, sceneId, elementId }) => {
    try {
      const w = resolveWorld(world);
      const result = removeElement(w, sceneId, elementId);
      touchScene(w, sceneId);
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_reorder_scene_elements",
  {
    title: "Reorder a Scene's elements",
    description: "MUTATION -- direct write, no review gate. Mirrors POST .../elements/reorder: `elementIds` is the FULL desired order (each listed element's `order` becomes its index; unlisted ones keep theirs).",
    inputSchema: { world: requiredWorldParam, sceneId: z.string(), elementIds: z.array(z.string()).min(1) }
  },
  async ({ world, sceneId, elementIds }) => {
    try {
      const w = resolveWorld(world);
      const elements = reorderElements(w, sceneId, elementIds);
      touchScene(w, sceneId);
      return text({ elements });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_promote_scene_element",
  {
    title: "Promote a scene-local element to a KEY graph node",
    description:
      "MUTATION -- direct write. Mirrors POST .../elements/:elementId/promote: creates a REAL graph node + containment " +
      "edge (the one planner write that touches the graph -- the element becomes kind:'graph'). BE AWARE of what the " +
      "node actually gets: only the element's NAME carries over (its `fields` do NOT -- describe the node afterwards " +
      "via a reviewed graph mutation); its type is `type` if you pass one, else inferred 'person' when the element " +
      "carries a stat block, else 'object'; and the containment edge always targets the SCENE'S OWN location entity, " +
      "not any place named in the element's text.",
    inputSchema: {
      world: requiredWorldParam, dataDir: dataDirParam, sceneId: z.string(), elementId: z.string(),
      type: z.enum(["person", "place", "faction", "object", "event", "concept"]).optional()
        .describe("Entity type for the created node; omit to use the stat-block inference (stat -> person, else object).")
    }
  },
  async ({ world, dataDir, sceneId, elementId, type }) => {
    try {
      const w = resolveWorld(world);
      const dir = resolveDir(dataDir);
      const element = await promoteElement(dir, w, sceneId, elementId, type ? { type } : {});
      touchScene(w, sceneId);
      return text({ element });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_demote_scene_element",
  {
    title: "Demote a KEY element back to scene-local (keeps the graph node)",
    description: "MUTATION -- direct write, no review gate. Mirrors POST .../elements/:elementId/demote. Never deletes the underlying graph node.",
    inputSchema: { world: requiredWorldParam, sceneId: z.string(), elementId: z.string() }
  },
  async ({ world, sceneId, elementId }) => {
    try {
      const w = resolveWorld(world);
      const element = demoteElement(w, sceneId, elementId);
      touchScene(w, sceneId);
      return text({ element });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_set_scene_narration",
  {
    title: "Set a Scene's read-aloud narration (the spread's opening line)",
    description: "MUTATION -- direct write, no review gate. Mirrors POST /api/scene-planning/scenes/:sceneId/narration. Appends a new current version (history kept).",
    inputSchema: { world: requiredWorldParam, sceneId: z.string(), text: z.string() }
  },
  async ({ world, sceneId, text: narrationText }) => {
    try {
      const w = resolveWorld(world);
      const narration = saveSceneNarration(w, sceneId, { text: narrationText });
      touchScene(w, sceneId);
      return text({ narration });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_set_element_run",
  {
    title: "Place an element in the Run spread (column · role · variant)",
    description:
      "MUTATION -- direct write, no review gate. Writes the element's EXPLICIT `run` layout (session-planner/run-layout.mjs): " +
      "column main|side|off; role read|dressing|beat|exits|block|card|gm|sketch; optional free-string `variant` (gated by the scene's " +
      "activeVariants); optional free-string `group` -- elements sharing a group render as ONE composite Run card (lead = " +
      "lowest-order member; use it to keep a payload/thread card and its outcome read-alouds together instead of as near-duplicate " +
      "sibling cards). Pass `clear:true` to drop the explicit layout and fall back to inference (a re-set without `group` clears " +
      "just the group). `revealTab:true` (needs `variant`): when the element's bound graph entity has narrative-state " +
      "revealState 'revealed', this variant becomes the card's SEEDED active tab (the mid-session reveal wire; local table " +
      "tab clicks still override).",
    inputSchema: {
      world: requiredWorldParam, sceneId: z.string(), elementId: z.string(),
      column: z.enum(RUN_COLUMNS).optional(), role: z.enum(RUN_ROLES).optional(), variant: z.string().nullable().optional(),
      group: z.string().nullable().optional(),
      revealTab: z.boolean().optional(),
      clear: z.boolean().optional()
    }
  },
  async ({ world, sceneId, elementId, column, role, variant, group, revealTab, clear }) => {
    try {
      const w = resolveWorld(world);
      if (clear) {
        const element = updateElement(w, sceneId, elementId, { run: null });
        touchScene(w, sceneId);
        return text({ element });
      }
      if (!column || !role) throw new Error("wf_set_element_run needs both `column` and `role` (or `clear:true`).");
      const run = { column, role };
      if (variant) run.variant = variant;
      if (group) run.group = group;
      if (revealTab && variant) run.revealTab = true;
      const element = updateElement(w, sceneId, elementId, { run });
      touchScene(w, sceneId);
      return text({ element });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_set_scene_active_variants",
  {
    title: "Switch which variant(s) a Scene shows in Run mode",
    description:
      "MUTATION -- direct write, no review gate. Sets `scene.activeVariants` (free strings matching elements' run.variant). " +
      "Elements without a variant always show; an EMPTY list shows every variant. This is the PERSISTENT switch: one call flips a " +
      "whole scene from one state to another and the open Run page picks it up within a few seconds. Note (variants round, " +
      "2026-09-01): on cards with state TABS (grouped elements / the GM-notes fold), this call SEEDS which tab starts active -- " +
      "the GM's own tab clicks in Run are local-only and never write back, and a GM's existing local pick on a card is not " +
      "overridden by this call; loose (ungrouped) variant elements are still hard-gated by it.",
    inputSchema: { world: requiredWorldParam, sceneId: z.string(), variants: z.array(z.string()) }
  },
  async ({ world, sceneId, variants }) => {
    try {
      const w = resolveWorld(world);
      return text({ scene: updateScene(w, sceneId, { activeVariants: variants }) });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_infer_run_layout",
  {
    title: "Write an explicit Run layout onto every untagged element of a Scene",
    description: "MUTATION -- direct write, no review gate. Mirrors POST .../run-layout/infer: uses run-layout.mjs's naming-convention inference for elements with no `run`; never overwrites an existing one (idempotent).",
    inputSchema: { world: requiredWorldParam, sceneId: z.string() }
  },
  async ({ world, sceneId }) => {
    try {
      const w = resolveWorld(world);
      const elements = inferRunLayoutForScene(w, sceneId);
      touchScene(w, sceneId);
      return text({ elements });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_seed_run_skeleton",
  {
    title: "Seed a Scene with placeholder elements for every Run-spread role it lacks",
    description:
      "MUTATION -- direct write, no review gate. Mirrors POST .../run-layout/seed (session-planner/run-skeleton.mjs). Template by `kind` " +
      "(narrative | combat | transit; defaults from the scene's own kind, then its name prefix). Placeholders are hidden in Run until filled; " +
      "idempotent by role -- re-running only fills genuine gaps.",
    inputSchema: { world: requiredWorldParam, sceneId: z.string(), kind: z.enum(["narrative", "combat", "transit"]).optional() }
  },
  async ({ world, sceneId, kind }) => {
    try {
      const w = resolveWorld(world);
      const result = seedRunSkeleton(w, sceneId, { kind });
      touchScene(w, sceneId);
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Briefing (2026-08-26) -- world-level front-matter cards (session-planner/
// briefing-store.mjs). Direct planner writes, mirroring
// /api/session-planner/briefing/* 1:1.
// ---------------------------------------------------------------------------
server.registerTool(
  "wf_list_briefing_cards",
  {
    title: "List a world's Briefing cards (front matter) in order",
    description: "READ. Mirrors GET /api/session-planner/briefing. Cards are {id, title, eyebrow, body (light HTML), span 1|2, order}.",
    inputSchema: { world: requiredWorldParam }
  },
  async ({ world }) => {
    try { return text({ cards: listBriefingCards(resolveWorld(world)) }); } catch (err) { return errorText(err); }
  }
);

server.registerTool(
  "wf_upsert_briefing_card",
  {
    title: "Create or patch a Briefing card",
    description:
      "MUTATION -- direct write, no review gate. Without `cardId`: creates a card (title required) appended at the end. With `cardId`: " +
      "patches only the supplied keys. `body` is light HTML (p/ul/ol/table/b/i/h3/inline svg…), sanitised at render time; plain text is fine too. " +
      "`span` 2 = full width. Use `eyebrow` for the small-caps category label (\"The premise\", \"Cast\", \"Table rules\").",
    inputSchema: {
      world: requiredWorldParam, cardId: z.string().optional(), title: z.string().optional(), eyebrow: z.string().nullable().optional(),
      body: z.string().optional(), span: z.union([z.literal(1), z.literal(2)]).optional()
    }
  },
  async ({ world, cardId, title, eyebrow, body, span }) => {
    try {
      const w = resolveWorld(world);
      const card = cardId ? updateBriefingCard(w, cardId, { title, eyebrow, body, span }) : createBriefingCard(w, { title, eyebrow, body, span });
      return text({ card });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_delete_briefing_card",
  {
    title: "Delete a Briefing card",
    description: "MUTATION -- direct write, no review gate. Mirrors DELETE /api/session-planner/briefing/:id. Idempotent.",
    inputSchema: { world: requiredWorldParam, cardId: z.string() }
  },
  async ({ world, cardId }) => {
    try { return text(removeBriefingCard(resolveWorld(world), cardId)); } catch (err) { return errorText(err); }
  }
);

server.registerTool(
  "wf_reorder_briefing_cards",
  {
    title: "Reorder a world's Briefing cards",
    description: "MUTATION -- direct write, no review gate. Mirrors POST /api/session-planner/briefing/reorder: `cardIds` is the full desired order.",
    inputSchema: { world: requiredWorldParam, cardIds: z.array(z.string()).min(1) }
  },
  async ({ world, cardIds }) => {
    try { return text({ cards: reorderBriefingCards(resolveWorld(world), cardIds) }); } catch (err) { return errorText(err); }
  }
);

server.registerTool(
  "wf_tray_drop",
  {
    title: "Drop a creature/hero/asset into a Scene's tray",
    description:
      "MUTATION -- direct write, no review gate. Mirrors POST /api/scene-planning/scenes/:sceneId/tray/drop " +
      "(wf-mcp-server/lib/planner-ops.mjs's sceneTrayDropOp -- shared verbatim with that route). A 'creature' " +
      "drop's FIRST occurrence creates/reuses a stat-carrying scene element (dedup'd against the same bestiary " +
      "entry); a repeat drop only stacks the roster count. 'hero'/'asset' drops are display-only -- the roster row " +
      "itself is the link, no scene element is created. An unresolvable id for the given kind throws a clear error. " +
      "`kind:'asset'` resolves item-store first, then stagecraft-store.",
    inputSchema: {
      world: requiredWorldParam,
      dataDir: dataDirParam,
      sceneId: z.string(),
      kind: z.enum(["creature", "hero", "asset"]),
      id: z.string().describe("bestiaryEntryId (creature) / partyMemberId (hero) / itemId or stagecraftAssetId (asset).")
    }
  },
  async ({ world, dataDir, sceneId, kind, id }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const result = await sceneTrayDropOp(dir, w, sceneId, { kind, id });
      try { touchScene(w, sceneId); } catch { /* best-effort recency bump only -- see planner-ops.mjs's header comment */ }
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_tray_remove",
  {
    title: "Remove a roster row from a Scene's tray",
    description: "MUTATION -- direct write, no review gate. Mirrors DELETE /api/scene-planning/scenes/:sceneId/tray/:kind/:id. Idempotent -- removing an already-absent row is a safe no-op.",
    inputSchema: { world: requiredWorldParam, sceneId: z.string(), kind: z.enum(["creature", "hero", "asset"]), id: z.string() }
  },
  async ({ world, sceneId, kind, id }) => {
    try {
      const w = resolveWorld(world);
      const result = removeFromSceneTray(w, sceneId, kind, id);
      try { touchScene(w, sceneId); } catch { /* best-effort recency bump only */ }
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_set_xp_budget",
  {
    title: "Set a Scene tray's XP budget",
    description: "MUTATION -- direct write, no review gate. Mirrors POST /api/scene-planning/scenes/:sceneId/tray/budget.",
    inputSchema: { world: requiredWorldParam, sceneId: z.string(), xpBudget: z.number().nullable() }
  },
  async ({ world, sceneId, xpBudget }) => {
    try {
      const w = resolveWorld(world);
      const result = setSceneTrayXpBudget(w, sceneId, xpBudget);
      try { touchScene(w, sceneId); } catch { /* best-effort recency bump only */ }
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- Library: reads -------------------------------------------------------------------

server.registerTool(
  "wf_list_bestiary",
  {
    title: "List bestiary entries (library-wide -- no world)",
    description:
      "READ. Mirrors GET /api/combat-planning/bestiary -- combat-planning/bestiary-store.mjs's listBestiaryEntries(). " +
      "DELIBERATELY NO `world` PARAMETER: the bestiary is a library-wide shelf, not world-scoped (bestiary-store.mjs's " +
      "own storage decision) -- do not pass one, it wouldn't be honored. Client-side filters (not a store-level " +
      "feature): `status` ('proposed'|'accepted'|'discarded') and `source` (the entry's own derived sourcePill, " +
      "e.g. 'mine'|'foundry'|'reskin').",
    inputSchema: {
      status: z.enum(["proposed", "accepted", "discarded"]).optional(),
      source: z.string().optional().describe("Filters on the entry's own deriveSourcePill value, e.g. 'mine', 'foundry', 'reskin'.")
    }
  },
  async ({ status, source }) => {
    try {
      let entries = listBestiaryEntries();
      if (status) entries = entries.filter((e) => e.status === status);
      if (source) entries = entries.filter((e) => e.sourcePill === source);
      return text({ entries });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_get_bestiary_entry",
  {
    title: "Get one bestiary entry (library-wide -- no world)",
    description: "READ. Mirrors the bestiary entry lookup combat-planning/bestiary-store.mjs's getBestiaryEntry() does. NO `world` parameter -- see wf_list_bestiary.",
    inputSchema: { entryId: z.string() }
  },
  async ({ entryId }) => {
    try {
      return text({ entry: getBestiaryEntry(entryId) });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_list_party",
  {
    title: "List a world's party roster",
    description: "READ. Mirrors GET /api/combat-planning/party-roster -- combat-planning/party-roster-store.mjs's listPartyMembers().",
    inputSchema: { world: requiredWorldParam }
  },
  async ({ world }) => {
    try {
      const w = resolveWorld(world);
      return text({ members: listPartyMembers(w) });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_list_items",
  {
    title: "List a world's Reliquary items",
    description: "READ. Mirrors GET /api/combat-planning/items -- combat-planning/item-store.mjs's listItems().",
    inputSchema: { world: requiredWorldParam }
  },
  async ({ world }) => {
    try {
      const w = resolveWorld(world);
      return text({ items: listItems(w) });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_list_stagecraft",
  {
    title: "List a world's Stagecraft assets (maps/splash/music), including catalog + compendium browse rows",
    description:
      "READ. Mirrors GET /api/session-planner/stagecraft -- session-planner/stagecraft-store.mjs's " +
      "listStagecraftAssets(). Returns EVERY asset regardless of status/origin -- hand-added rows, Foundry-pulled " +
      "rows, `compendiumRef` browse rows (a Foundry compendium Scene not yet imported), and `catalogRef` rows (the " +
      "built-in map catalog) all come back in one list. An agent suggesting maps for a scene needs the whole " +
      "catalog, not just already-accepted assets -- filter client-side on `status`/`compendiumRef`/`catalogRef` if " +
      "you only want a subset.",
    inputSchema: { world: requiredWorldParam, kind: z.enum(["map", "splash", "music"]).optional() }
  },
  async ({ world, kind }) => {
    try {
      const w = resolveWorld(world);
      return text({ assets: listStagecraftAssets(w, kind) });
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- Library: hand-authoring parity (accepted immediately, no LLM call) -------------
// GATE POSTURE for every tool in this block: NONE -- these are the QA-W2
// hand-create routes' own semantics, mirrored exactly: a hand-typed entry is
// a deliberate authorship act, not a proposal needing review, so each saves
// and (where the store defaults to 'proposed') immediately self-accepts,
// same as the HTTP route.

server.registerTool(
  "wf_add_bestiary_entry",
  {
    title: "Hand-author a bestiary entry (library-wide -- no world, accepted immediately)",
    description:
      "MUTATION -- no review gate (hand-authored, accepted immediately). Mirrors POST /api/combat-planning/bestiary/" +
      "hand-add. NO `world` parameter (library-wide, see wf_list_bestiary). No LLM call.",
    inputSchema: {
      name: z.string().min(1).max(200),
      type: z.string().optional().describe("Default 'Custom'."),
      ac: z.number().optional(),
      hp: z.number().optional(),
      challengeRating: z.union([z.string(), z.number()]).optional(),
      notes: z.string().optional()
    }
  },
  async ({ name, type, ac, hp, challengeRating, notes }) => {
    try {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("wf_add_bestiary_entry: `name` is required.");
      let entry = saveBestiaryEntry({
        rawFields: { name: trimmed, type: type?.trim() || "Custom", ac, hp, challengeRating: challengeRating === "" ? undefined : challengeRating }
      });
      entry = acceptBestiaryEntry(entry.id);
      if (notes?.trim()) entry = updateBestiaryEntryNote(entry.id, notes.trim());
      return text({ entry });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_add_party_member",
  {
    title: "Hand-author a party roster member (accepted immediately)",
    description: "MUTATION -- no review gate (hand-authored, savePartyMember's own default status is already 'accepted'). Mirrors POST /api/combat-planning/party-roster/hand-add. No LLM call.",
    inputSchema: {
      world: requiredWorldParam,
      name: z.string().min(1).max(200),
      class: z.string().optional(),
      level: z.number().optional(),
      ac: z.number().optional(),
      hp: z.number().optional()
    }
  },
  async ({ world, name, class: className, level, ac, hp }) => {
    try {
      const w = resolveWorld(world);
      const trimmed = name.trim();
      if (!trimmed) throw new Error("wf_add_party_member: `name` is required.");
      const combatRelevant = {};
      if (className?.trim()) combatRelevant.class = className.trim();
      if (level != null) combatRelevant.level = level;
      if (ac != null) combatRelevant.ac = ac;
      if (hp != null) combatRelevant.hp = hp;
      return text({ member: savePartyMember(w, { name: trimmed, combatRelevant, buildRelevant: {} }) });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_add_item",
  {
    title: "Hand-author a Reliquary item (accepted immediately)",
    description: "MUTATION -- no review gate (hand-authored). Mirrors POST /api/combat-planning/items/hand-add (status explicitly 'accepted', saveItem's own default is 'proposed'). No LLM call.",
    inputSchema: { world: requiredWorldParam, name: z.string().min(1).max(200), type: z.string().optional(), description: z.string().optional() }
  },
  async ({ world, name, type, description }) => {
    try {
      const w = resolveWorld(world);
      const trimmed = name.trim();
      if (!trimmed) throw new Error("wf_add_item: `name` is required.");
      return text({ item: saveItem(w, { name: trimmed, type: type?.trim() || null, description: description?.trim() || null, status: "accepted" }) });
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_add_stagecraft_asset",
  {
    title: "Hand-author a Stagecraft asset (map/splash/music, accepted immediately)",
    description: "MUTATION -- no review gate (hand-authored, saveStagecraftAsset's own default is already status:'accepted'/source:'local'). Mirrors POST /api/session-planner/stagecraft/hand-add. No LLM call.",
    inputSchema: { world: requiredWorldParam, name: z.string().min(1).max(200), kind: z.enum(["map", "splash", "music"]), desc: z.string().optional() }
  },
  async ({ world, name, kind, desc }) => {
    try {
      const w = resolveWorld(world);
      const trimmed = name.trim();
      if (!trimmed) throw new Error("wf_add_stagecraft_asset: `name` is required.");
      return text({ asset: saveStagecraftAsset(w, { kind, name: trimmed, desc: desc?.trim() || null }) });
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- Chronicle: reads ------------------------------------------------------------------

server.registerTool(
  "wf_get_world_clock",
  {
    title: "Get a world's current in-fiction date/session number",
    description: "READ. Mirrors GET /api/chronicle/world-clock -- session-planner/world-clock.mjs's getWorldClock(). To ADVANCE the clock, use wf_chronicle_run -- there is no standalone 'advance' tool (the single-source elapsedSessions rule: advancing only ever happens as part of a real Chronicle run).",
    inputSchema: { world: requiredWorldParam }
  },
  async ({ world }) => {
    try {
      const w = resolveWorld(world);
      return text(getWorldClock(w));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_get_fortune",
  {
    title: "Get a world's current Fortune Track state",
    description: "READ. Mirrors GET /api/chronicle/fortune -- session-planner/fortune-track.mjs's getFortune().",
    inputSchema: { world: requiredWorldParam }
  },
  async ({ world }) => {
    try {
      const w = resolveWorld(world);
      return text(getFortune(w));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_list_chronicle_log",
  {
    title: "List a world's Chronicle run history",
    description:
      "READ. Mirrors GET /api/chronicle/log (wf-mcp-server/lib/chronicle-ops.mjs's chronicleLogPayload -- shared " +
      "verbatim with that route): every batch, newest-first, with its friendly headline plus (for a batch actually " +
      "created via wf_chronicle_run) its span/fortuneAtRun/promptSummary sidecar -- null for any other batch, a " +
      "real valid state, never a thrown error.",
    inputSchema: { world: requiredWorldParam }
  },
  async ({ world }) => {
    try {
      const w = resolveWorld(world);
      return text(chronicleLogPayload(w));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_list_pending_intents",
  {
    title: "List a world's queued/deferred Chronicle intents",
    description:
      "READ. Mirrors GET /api/pending-entities (wf-mcp-server/lib/chronicle-ops.mjs's pendingEntitiesPayload -- " +
      "shared verbatim with that route): every entity with an available pending-ledger backlog, plus a friendly " +
      "name/type and its entries -- the same 'queued intents' list the Chronicle Composer shows for picking what " +
      "to carry into the next wf_chronicle_run.",
    inputSchema: { world: requiredWorldParam, dataDir: dataDirParam }
  },
  async ({ world, dataDir }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      return text({ world: w, entities: pendingEntitiesPayload(w, dir) });
    } catch (err) {
      return errorText(err);
    }
  }
);

// --- Chronicle: mutations --------------------------------------------------------------

server.registerTool(
  "wf_chronicle_run",
  {
    title: "Run a Chronicle pass -- advance the world clock and propose consequences (through review gate)",
    description:
      "MUTATION -- THROUGH THE REVIEW GATE: creates a new mutation batch (status 'pending') requiring wf_accept/" +
      "wf_reject before anything reaches the graph, exactly like wf_propose_mutations. Mirrors POST /api/chronicle/run " +
      "EXACTLY (wf-mcp-server/lib/chronicle-ops.mjs's runChronicleOp, shared verbatim with that route) including: " +
      "(1) the single-source elapsedSessions rule -- `span` is the ONLY input to the world clock's advance, " +
      "computed exactly once per call, never re-derived from anything else you pass; (2) prompt-as-seed -- a typed " +
      "`prompt` describing what happens is dedup-or-created as a real graph entity and seeded into the propagation " +
      "pass, so a queued-intents run with nothing queued/carried still earns >=1 reviewable proposal instead of a " +
      "zero-mutation batch. `scopeKind` ('queued-intents' default | 'branches' | 'whole-world') selects what the " +
      "pass considers; 'branches' requires a non-empty `branchIds`. Requires ANTHROPIC_API_KEY in this server " +
      "process's own environment for the texturing call, same latency caveat as wf_propose_mutations -- degrades " +
      "to an honest offline placeholder if unset, never crashes.",
    inputSchema: {
      world: requiredWorldParam,
      dataDir: dataDirParam,
      scopeKind: z.enum(["queued-intents", "branches", "whole-world"]).optional().describe("Default 'queued-intents'."),
      branchIds: z.array(z.string()).optional().describe("Required (non-empty) when scopeKind='branches'."),
      carriedEntryIds: z.array(z.string()).optional().describe("scopeKind='queued-intents' only. Omit for 'everything currently queued'; an explicit [] means 'carry nothing this pass' (a real, distinct no-op run)."),
      span: z.object({ days: z.number().optional(), spanId: z.string().optional() }).describe("How much in-fiction time this run covers -- THE single source for this run's elapsedSessions."),
      prompt: z.string().optional().describe("Freeform 'say what happens' text -- seeded into the pass as a real entity (see description)."),
      tags: z.array(z.string()).optional().describe("Nudge tags forwarded into the propagation pass.")
    }
  },
  async ({ world, dataDir, scopeKind, branchIds, carriedEntryIds, span, prompt, tags }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      const result = await runChronicleOp(dir, w, { scopeKind, branchIds, carriedEntryIds, span, prompt, tags });
      return text(result);
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_queue_intent",
  {
    title: "Queue a manual Chronicle intent by hand (pending-ledger, manual sentinel)",
    description:
      "MUTATION -- direct write, no review gate (this only queues a THREAD for a future wf_chronicle_run to " +
      "resolve; it does not itself touch the graph). Mirrors POST /api/chronicle/intents (wf-mcp-server/lib/" +
      "chronicle-ops.mjs's queueIntentOp -- shared verbatim with that route): dedup-or-creates `name` as a graph " +
      "entity, then writes a pending-ledger entry with the pinned `sourceBatchId:\"manual\"`/`cycleDescriptor:" +
      "\"Manual\"` sentinel so it renders in the deferred lane exactly like a wrap-up intent.",
    inputSchema: {
      world: requiredWorldParam,
      dataDir: dataDirParam,
      name: z.string().min(1).max(200).describe("The intent's subject -- dedup-or-created as a graph entity."),
      note: z.string().optional().describe("Default 'Added by hand.'"),
      tags: z.array(z.string()).optional()
    }
  },
  async ({ world, dataDir, name, note, tags }) => {
    try {
      const dir = resolveDir(dataDir);
      const w = resolveWorld(world);
      return text(queueIntentOp(dir, w, { name, note, tags }));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_set_fortune",
  {
    title: "Set a world's Fortune Track stop",
    description: "MUTATION -- direct write, no review gate. Mirrors POST /api/chronicle/fortune -- session-planner/fortune-track.mjs's setFortune(). Affects the BIAS the next wf_chronicle_run's texturing pass uses -- does not itself touch the graph.",
    inputSchema: { world: requiredWorldParam, stopId: z.string() }
  },
  async ({ world, stopId }) => {
    try {
      const w = resolveWorld(world);
      return text(setFortune(w, stopId));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.registerTool(
  "wf_rules_lookup",
  {
    title: "Look up TTRPG rules text (Plutonium's bundled mechanics data + Russell's owned rulebook shelf)",
    description:
      "READ. Library-wide -- NO `world` parameter (rules text isn't world-scoped, see wf_list_bestiary). Composes " +
      "TWO sources (rules-oracle/index.mjs's searchRules): a STRUCTURED index over Plutonium's bundled 5etools " +
      "mechanics data (variant rules, actions, conditions/diseases/statuses, skills, senses, tables -- `family` " +
      "narrows this arm) and a full-text search over the extracted rulebook shelf at rules-library/ (5e + Draw " +
      "Steel -- `book` narrows this arm, e.g. 'phb', 'ds-heroes'). Either arm independently degrades to " +
      "`installed:false` (Plutonium not installed / rules-library/ not populated on this machine) without " +
      "blocking the other. CITE a books hit as `(LABEL p.N)` -- N is the PDF page, never the printed folio. " +
      "Snippets are DELIBERATELY CAPPED (short windows around the match, at most a handful per call) -- for a " +
      "full table, stat block, or multi-paragraph rule, read the cited PDF page directly rather than assuming " +
      "the snippet is the whole entry.",
    inputSchema: {
      query: z.string().min(1).describe("Search terms, ALL of which must match (case-insensitive) a hit's name/text."),
      family: z.enum(Object.keys(RULE_FAMILIES)).optional().describe("Narrows the structured (Plutonium) arm only, e.g. 'conditionsdiseases'."),
      book: z.string().optional().describe("Narrows the books arm only to one shelf slug, e.g. 'phb', 'ds-heroes'."),
      limit: z.number().int().positive().optional().describe("Per-arm cap. Structured caps at 50, books caps at 8, regardless of a higher value here.")
    }
  },
  async ({ query, family, book, limit }) => {
    try {
      const dir = resolveDir();
      return text(searchRules(dir, { query, family, book, limit }));
    } catch (err) {
      return errorText(err);
    }
  }
);

// Guard the actual stdio connect behind an entrypoint check so this module
// can be imported (e.g. by test/*.test.mjs, to unit-test attachDiffs against
// this file's real wiring) without spinning up a live MCP transport.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Exported for testing only (attachDiffs is pure/deterministic; see
// test/propose-diff.test.mjs). Not part of the MCP tool surface.
export { attachDiffs };
