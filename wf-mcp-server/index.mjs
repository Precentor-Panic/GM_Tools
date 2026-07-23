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
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveDataDir, listWorlds } from "./lib/data-dir.mjs";
import { loadSnapshot, mutationsPath } from "./lib/snapshot.mjs";
import { neighborhood, edgesFor, findEntity, findEntityByName } from "./lib/graph.mjs";

const server = new McpServer({ name: "world-fabric", version: "0.1.0" });

const worldParam = z.string().optional().describe(
  "World ID (Foundry world folder name). Defaults to WF_DEFAULT_WORLD env var if set. " +
  "Use wf_list_worlds to see what's available."
);
const dataDirParam = z.string().optional().describe(
  "Override the Foundry data directory. Defaults to WF_DATA_DIR env var, then OS-typical install paths."
);

function resolveWorld(world) {
  const resolved = world ?? process.env.WF_DEFAULT_WORLD;
  if (!resolved) {
    throw new Error(
      "No world specified and WF_DEFAULT_WORLD is not set. Call wf_list_worlds to see available worlds, " +
      "then pass one explicitly."
    );
  }
  return resolved;
}

function resolveDir(dataDir) {
  const dir = resolveDataDir(dataDir);
  if (!dir) {
    throw new Error(
      "Could not locate the Foundry data directory. Pass dataDir explicitly or set WF_DATA_DIR."
    );
  }
  return dir;
}

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

server.registerTool(
  "wf_apply_mutations",
  {
    title: "Write graph mutations for World Fabric to apply",
    description:
      "Writes a mutations array to world-fabric-mutations.json. World Fabric's in-Foundry mutation watcher polls " +
      "every 5s, applies them (upsert/delete entity or edge), and clears the file. Requires a Foundry client to " +
      "have that world open and the module active — this tool cannot apply mutations if nobody has the world loaded. " +
      "Polls briefly to report whether the mutation was picked up.",
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
      const path = mutationsPath(dir, w);
      writeFileSync(path, JSON.stringify(mutations, null, 2), "utf8");

      // The watcher clears the file back to "[]" once applied. Poll briefly.
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        if (!existsSync(path)) break;
        const contents = readFileSync(path, "utf8").trim();
        if (contents === "[]") {
          return text({ status: "applied", count: mutations.length, path });
        }
      }
      return text({
        status: "queued",
        count: mutations.length,
        path,
        note: "Not confirmed applied within 7s — check that a Foundry client has this world open with World Fabric active."
      });
    } catch (err) {
      return errorText(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
