// graph-import/graph-file.mjs: the campaign-owned graph file, and the read /
// write / publish paths that resolve to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratchDir = mkdtempSync(join(tmpdir(), "graph-file-test-"));
const campaign = join(scratchDir, "campaign");
const dataDir = join(scratchDir, "Data");
const W = "gf-world";
mkdirSync(join(campaign, "data"), { recursive: true });
mkdirSync(join(dataDir, "worlds", W), { recursive: true });
process.env.GM_TOOLS_CAMPAIGNS = `${W}=${campaign}`;
process.env.WF_DATA_DIR = dataDir;
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.WF_TIMELINE_GIT = "1";

const {
  GRAPH_SCHEMA_VERSION, campaignGraphPath, campaignOwnsGraph, publishedGraphPath, toGraphFile, readGraphPayload
} = await import("../graph-import/graph-file.mjs");
const { snapshotFilePath, loadSnapshot } = await import("../wf-mcp-server/lib/snapshot.mjs");
const { applyHeadless } = await import("../graph-import/headless-apply.mjs");
const { applyMutationsWithHeadlessFallback } = await import("../wf-mcp-server/lib/mutation-ops.mjs");
const { narrativeStateRoot } = await import("../mutation-engine/narrative-state.mjs");
const { commitWorldTimeline } = await import("../mutation-engine/world-timeline.mjs");

const legacySnapshot = join(dataDir, "worlds", W, "world-fabric-snapshot.json");
const graphPath = join(campaign, "data", "graph.json");
const entity = (id, name) => ({ id, name, type: "person", description: "", importance: 0.3, tags: [] });

test("before the graph file exists the world reads the Foundry snapshot", () => {
  writeFileSync(legacySnapshot, JSON.stringify({ meta: { worldId: W, sessionNumber: 4 }, context: "c", systemPrompt: "s", snapshot: { entities: [entity("b", "Bea")], edges: [], entityTypes: [] } }));
  assert.equal(campaignGraphPath(W), graphPath);
  assert.equal(campaignOwnsGraph(W), false);
  assert.equal(snapshotFilePath(dataDir, W), legacySnapshot);
  assert.equal(loadSnapshot(dataDir, W).context, "c");
  assert.equal(narrativeStateRoot(dataDir, W), join(dataDir, "worlds", W, "narrative-state"));
});

test("once the graph file exists it is the graph, read in the payload shape", () => {
  const file = toGraphFile({
    worldId: W, sessionNumber: 4,
    entities: [entity("b", "Bea"), entity("a", "Ansel")],
    edges: [{ id: "e1", sourceId: "a", targetId: "b", relationshipType: "knows", strength: 0.5 }],
    entityTypes: [{ id: "person", label: "Person" }]
  });
  assert.deepEqual(file.entities.map((e) => e.id), ["a", "b"], "arrays are sorted by id");
  writeFileSync(graphPath, JSON.stringify(file, null, 2));

  assert.equal(campaignOwnsGraph(W), true);
  assert.equal(snapshotFilePath(dataDir, W), graphPath);
  const snap = loadSnapshot(dataDir, W);
  assert.equal(snap.meta.worldId, W);
  assert.equal(snap.meta.sessionNumber, 4);
  assert.equal(snap.meta.entityCount, 2);
  assert.equal(snap.meta.edgeCount, 1);
  assert.equal(snap.meta.campaignOwned, true);
  assert.ok(snap.meta.exportedAt);
  assert.equal(snap.snapshot.entities.length, 2);
  assert.ok(snap.systemPrompt.length > 0);
  assert.match(snap.context, /Ansel|Bea/, "context text is derived on read");
  assert.equal(narrativeStateRoot(dataDir, W), join(campaign, "data", "narrative-state"));
});

test("a headless write keeps the canonical shape, changes only what it touched, and publishes for Foundry", () => {
  const before = JSON.parse(readFileSync(graphPath, "utf8"));
  const result = applyHeadless(graphPath, [
    { op: "upsert_entity", id: "a", data: { name: "Ansel Rook" } },
    { op: "upsert_entity", data: { id: "0-first", name: "Zed", type: "person" } }
  ]);
  assert.equal(result.idResolution[0], "a");
  const after = JSON.parse(readFileSync(graphPath, "utf8"));
  assert.deepEqual(Object.keys(after), ["schemaVersion", "meta", "entityTypes", "entities", "edges"]);
  assert.equal(after.schemaVersion, GRAPH_SCHEMA_VERSION);
  assert.deepEqual(after.meta, { worldId: W, sessionNumber: 4 });
  assert.deepEqual(after.entities.map((e) => e.id), ["0-first", "a", "b"]);
  assert.equal(after.entities.find((e) => e.id === "a").name, "Ansel Rook");
  assert.deepEqual(after.entities.find((e) => e.id === "b"), before.entities.find((e) => e.id === "b"), "an untouched entity is byte-stable");
  assert.deepEqual(after.edges, before.edges);
  assert.ok(!existsSync(`${graphPath}.lock`));

  const published = JSON.parse(readFileSync(publishedGraphPath(dataDir, W), "utf8"));
  assert.ok(published.publishedAt);
  assert.deepEqual(published.entities, after.entities);
  assert.deepEqual(published.edges, after.edges);
  assert.equal(JSON.parse(readFileSync(legacySnapshot, "utf8")).snapshot.entities.length, 1, "the old Foundry snapshot is left alone");
});

test("sync applies at once for a campaign-owned graph and never writes the Foundry queue file", async () => {
  const started = Date.now();
  const out = await applyMutationsWithHeadlessFallback(dataDir, W, [{ op: "delete_entity", id: "0-first" }]);
  assert.ok(Date.now() - started < 2000, "no 7 s wait for a Foundry client");
  assert.equal(out.path, "headless");
  assert.equal(out.liveResult.status, "not-attempted");
  assert.equal(out.snapshotPath, graphPath);
  assert.ok(!existsSync(join(dataDir, "worlds", W, "world-fabric-mutations.json")));
  assert.deepEqual(readGraphPayload(graphPath).snapshot.entities.map((e) => e.id), ["a", "b"]);
});

test("the world timeline stands down for a campaign-owned graph", () => {
  const out = commitWorldTimeline(dataDir, W, { batchId: "b1" });
  assert.deepEqual(out, { committed: false });
  assert.ok(!existsSync(join(dataDir, "worlds", W, ".git")));
});

test("a world with no Foundry folder still writes; publishing is skipped", () => {
  const other = join(scratchDir, "campaign-2");
  mkdirSync(join(other, "data"), { recursive: true });
  process.env.GM_TOOLS_CAMPAIGNS = `${W}=${campaign};nofoundry=${other}`;
  const p = join(other, "data", "graph.json");
  writeFileSync(p, JSON.stringify(toGraphFile({ worldId: "nofoundry", entities: [], edges: [], entityTypes: [] })));
  applyHeadless(p, [{ op: "upsert_entity", data: { id: "x", name: "X", type: "person" } }]);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).entities.length, 1);
  assert.ok(!existsSync(join(dataDir, "worlds", "nofoundry")));
});

test("an unknown schemaVersion is refused, not guessed at", () => {
  const p = join(scratchDir, "v99", "graph.json");
  mkdirSync(join(scratchDir, "v99"));
  writeFileSync(p, JSON.stringify({ schemaVersion: 99, entities: [] }));
  assert.throws(() => readGraphPayload(p), /schemaVersion/);
});
