/**
 * The campaign-owned graph file — pure, Foundry-free.
 *
 * A world registered to a campaign repo (mutation-engine/campaign-home.mjs)
 * can keep its graph at `<campaignDir>/data/graph.json`. When that file
 * exists it IS the graph: GM_Tools reads and writes it directly, the campaign
 * repo tracks it, and Foundry reads a published copy
 * (`worlds/<world>/world-fabric-graph.json`) instead of owning the data in its
 * world settings. A world without the file keeps the old arrangement (Foundry
 * settings own the graph, `world-fabric-snapshot.json` is its export).
 *
 * File shape (GRAPH_SCHEMA_VERSION 1):
 *   { schemaVersion, meta: { worldId, sessionNumber }, entityTypes, entities, edges }
 * Each array is sorted by id and the file is pretty-printed, so a change to
 * one entity is a small line diff. Nothing derived is stored: counts, the
 * export time and the LLM context text are rebuilt on read.
 *
 * Every other module keeps working with the snapshot PAYLOAD shape
 * (`{meta, context, systemPrompt, snapshot: {entities, edges, entityTypes}}`):
 * `readGraphPayload` returns it from either kind of file, and
 * `writeGraphPayload` accepts it for either kind of file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { campaignDataDir } from "../mutation-engine/campaign-home.mjs";
import { budgetedContext, SYSTEM_PROMPT } from "../../foundry_worldFabric/scripts/data/llm-context.mjs";
// The one import from the ops layer: where Foundry's data folder is, so a
// write can publish the copy Foundry reads.
import { resolveDataDir } from "../wf-mcp-server/lib/data-dir.mjs";

export const GRAPH_SCHEMA_VERSION = 1;
export const GRAPH_FILE_NAME = "graph.json";
export const PUBLISHED_GRAPH_FILE_NAME = "world-fabric-graph.json";

/** `<campaignDir>/data/graph.json` for a registered world (whether it exists yet or not), else null. */
export function campaignGraphPath(world) {
  const data = campaignDataDir(world);
  return data ? join(data, GRAPH_FILE_NAME) : null;
}

/** True when the campaign repo owns this world's graph: registered AND the graph file exists. */
export function campaignOwnsGraph(world) {
  const p = campaignGraphPath(world);
  return Boolean(p && existsSync(p));
}

/** Where the copy Foundry reads is published. */
export function publishedGraphPath(dataDir, world) {
  return join(dataDir, "worlds", world, PUBLISHED_GRAPH_FILE_NAME);
}

function isGraphFile(path) {
  return basename(path) === GRAPH_FILE_NAME;
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sorted = (arr) => [...(arr ?? [])].sort(byId);

/** The canonical file object for a graph. */
export function toGraphFile({ worldId, sessionNumber, entities, edges, entityTypes }) {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    meta: { worldId: worldId ?? "unknown", sessionNumber: sessionNumber ?? 0 },
    entityTypes: sorted(entityTypes),
    entities: sorted(entities),
    edges: sorted(edges)
  };
}

function payloadFromGraphFile(file, exportedAt) {
  if (file.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    throw new Error(`Unsupported graph file schemaVersion ${JSON.stringify(file.schemaVersion)} (this build reads ${GRAPH_SCHEMA_VERSION}).`);
  }
  const snapshot = { entities: file.entities ?? [], edges: file.edges ?? [], entityTypes: file.entityTypes ?? [] };
  const sessionNumber = file.meta?.sessionNumber ?? 0;
  const payload = {
    meta: {
      version: 1,
      worldId: file.meta?.worldId ?? "unknown",
      sessionNumber,
      exportedAt,
      entityCount: snapshot.entities.length,
      edgeCount: snapshot.edges.length,
      campaignOwned: true
    },
    systemPrompt: SYSTEM_PROMPT,
    snapshot
  };
  // The context text is only read by wf_get_context; build it on first use.
  let context;
  Object.defineProperty(payload, "context", {
    enumerable: true,
    configurable: true,
    get() {
      if (context === undefined) {
        const built = budgetedContext(snapshot, [], { sessionNumber });
        context = built.text;
        payload.meta.contextTokenEstimate = built.tokenEstimate;
      }
      return context;
    }
  });
  return payload;
}

/** Read either kind of file and return the snapshot payload shape. */
export function readGraphPayload(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!isGraphFile(path)) return parsed;
  return payloadFromGraphFile(parsed, statSync(path).mtime.toISOString());
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/**
 * Publish the copy Foundry reads. No-op (returns null) when there is no
 * Foundry data folder or the world has no folder in it: a campaign can be
 * worked on with no Foundry install at all.
 */
export function publishGraphToFoundry(file, { dataDir = resolveDataDir() } = {}) {
  const world = file.meta?.worldId;
  if (!dataDir || !world || !existsSync(join(dataDir, "worlds", world))) return null;
  const path = publishedGraphPath(dataDir, world);
  writeJsonAtomic(path, { ...file, publishedAt: new Date().toISOString() });
  return path;
}

/**
 * Write a snapshot payload to either kind of file. A campaign graph file is
 * written in the canonical shape and then published for Foundry; a failed
 * publish never fails the write (the campaign file is the truth, and the next
 * write publishes again).
 */
export function writeGraphPayload(path, payload) {
  if (!isGraphFile(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
    return;
  }
  const file = toGraphFile({
    worldId: payload.meta?.worldId,
    sessionNumber: payload.meta?.sessionNumber,
    entities: payload.snapshot?.entities,
    edges: payload.snapshot?.edges,
    entityTypes: payload.snapshot?.entityTypes
  });
  writeJsonAtomic(path, file);
  try { publishGraphToFoundry(file); } catch (err) {
    console.warn(`[graph-file] wrote ${path} but could not publish it for Foundry: ${err.message}`);
  }
}
