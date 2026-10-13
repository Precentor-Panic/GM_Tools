#!/usr/bin/env node
/**
 * Makes a registered world's campaign repo the owner of its graph: writes
 * `<campaignDir>/data/graph.json` from the world's Foundry-exported snapshot,
 * copies the reveal state beside it (`data/narrative-state/`), and publishes
 * the copy Foundry reads. From then on GM_Tools reads and writes the campaign
 * file directly.
 *
 *   bin/campaign-adopt-graph --world aureus            # report only
 *   bin/campaign-adopt-graph --world aureus --apply
 *   bin/campaign-adopt-graph --world aureus --from <snapshot.json> [--apply]
 *
 * --from takes the graph from another snapshot-shaped file instead of the
 * world's current Foundry export (for a graph rebuilt after Foundry's copy
 * fell behind). The freshness and unsynced-edit checks then do not apply: the
 * file is taken to be the graph you mean.
 *
 * Before --apply: nothing may be waiting (no queued mutations, no unsynced
 * manual edits), the snapshot must be a fresh export from Foundry, and the
 * app server must be stopped. After it: switch the module to read the file
 * (`review-ui/gm-client.mjs --graph-source file`) and reload Foundry clients.
 *
 * The snapshot file and Foundry's settings copy are left in place, frozen.
 * To undo: delete data/graph.json and data/narrative-state, and set the
 * module back with `--graph-source settings`.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { campaignDataDir } from "../mutation-engine/campaign-home.mjs";
import { campaignGraphPath, campaignOwnsGraph, publishGraphToFoundry, toGraphFile, readGraphPayload } from "../graph-import/graph-file.mjs";
import { resolveDataDir } from "../wf-mcp-server/lib/data-dir.mjs";
import { mutationsPath } from "../wf-mcp-server/lib/snapshot.mjs";
import { getManualEditSyncStatusOp } from "../wf-mcp-server/lib/manual-edit-ops.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(name);
const stop = (msg) => { console.error(`\nStopped: ${msg}`); process.exit(1); };

const world = opt("--world");
if (!world) { console.error("--world <id> is required"); process.exit(2); }
const data = campaignDataDir(world);
if (!data) { console.error(`"${world}" is not registered to a campaign repo. Run bin/campaign-adopt first.`); process.exit(2); }
if (campaignOwnsGraph(world)) { console.log(`${campaignGraphPath(world)} already exists: the campaign repo owns this graph.`); process.exit(0); }
const dataDir = opt("--data-dir") || resolveDataDir();
if (!dataDir) { console.error("No Foundry data folder found (set WF_DATA_DIR)."); process.exit(2); }
const apply = flag("--apply");
const base = opt("--base", `http://localhost:${process.env.REVIEW_UI_PORT ?? "8787"}`);
const maxAgeMin = Number(opt("--max-age", "30"));

// The Foundry-side files, addressed directly: snapshot.mjs would resolve to
// the campaign file the moment it exists.
const worldDir = join(dataDir, "worlds", world);
const from = opt("--from");
const snapshotPath = from ?? join(worldDir, "world-fabric-snapshot.json");
const nsSrc = join(worldDir, "narrative-state");
const nsDest = join(data, "narrative-state");
const graphPath = campaignGraphPath(world);
if (!existsSync(snapshotPath)) stop(`no snapshot at ${snapshotPath}`);

const payload = JSON.parse(readFileSync(snapshotPath, "utf8"));
const { entities = [], edges = [], entityTypes = [] } = payload.snapshot ?? {};
const ageMin = (Date.now() - Date.parse(payload.meta?.exportedAt ?? 0)) / 60000;
console.log(`${world}: ${entities.length} entities, ${edges.length} edges, ${entityTypes.length} entity types; session ${payload.meta?.sessionNumber ?? 0}`);
console.log(`  snapshot exported ${Number.isFinite(ageMin) ? `${ageMin.toFixed(1)} min ago` : "at an unknown time"} (${snapshotPath})`);

const problems = [];

// 1. Nothing waiting.
let queued = [];
try { const t = readFileSync(mutationsPath(dataDir, world), "utf8").trim(); queued = t ? JSON.parse(t) : []; } catch { /* no file */ }
if (queued.length) problems.push(`${queued.length} mutation(s) are queued for Foundry in world-fabric-mutations.json`);
const manual = getManualEditSyncStatusOp(world);
if (manual.unsyncedCount && !from) problems.push(`${manual.unsyncedCount} manual edit(s) are not synced to Foundry (batch ${manual.batchId}); sync them in the app first`);
console.log(`  waiting: ${queued.length} queued mutation(s), ${manual.unsyncedCount} unsynced manual edit(s)`);

// 2. The snapshot must be what Foundry holds now.
if (!from && !(ageMin <= maxAgeMin)) problems.push(`the snapshot is older than ${maxAgeMin} min; restart Foundry (systemctl --user restart foundry) to export a fresh one, or pass --max-age <minutes>`);

// 3. Internal consistency: ids unique, every edge endpoint exists.
const entityIds = new Set(entities.map((e) => e.id));
if (entityIds.size !== entities.length) problems.push("the snapshot has duplicate entity ids");
if (new Set(edges.map((e) => e.id)).size !== edges.length) problems.push("the snapshot has duplicate edge ids");
const brokenEdges = edges.filter((e) => !entityIds.has(e.sourceId) || !entityIds.has(e.targetId));
if (brokenEdges.length) problems.push(`${brokenEdges.length} edge(s) point at an entity that is not in the graph: ${brokenEdges.slice(0, 5).map((e) => e.id).join(", ")}`);

// 4. Every entity id the campaign data refers to exists in the graph.
const ID_KEYS = new Set(["graphEntityId", "locationEntityId", "anchorEntityId", "entityId"]);
const dangling = new Map(); // id -> where
function scan(value, where) {
  if (Array.isArray(value)) { for (const v of value) scan(v, where); return; }
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (ID_KEYS.has(k) && typeof v === "string" && v && !entityIds.has(v)) { if (!dangling.has(v)) dangling.set(v, where); }
    else scan(v, where);
  }
}
for (const name of ["session-scenes.json", "scene-elements.json", "scene-tray.json", "session-notes.json", "items.json", "party-roster.json"]) {
  const p = join(data, name);
  if (existsSync(p)) { try { scan(JSON.parse(readFileSync(p, "utf8")), name); } catch { problems.push(`${p} is not valid JSON`); } }
}
const nsFiles = existsSync(nsSrc) ? readdirSync(nsSrc).filter((f) => f.endsWith(".json")) : [];
for (const f of nsFiles) { const id = f.slice(0, -5); if (!entityIds.has(id)) dangling.set(id, "narrative-state"); }
console.log(`  reveal state: ${nsFiles.length} record(s)`);
console.log(`  references from campaign data: ${dangling.size ? `${dangling.size} id(s) NOT in the graph` : "all resolve"}`);
for (const [id, where] of [...dangling].slice(0, 20)) console.log(`    ${id}   (${where})`);
if (dangling.size && !flag("--allow-dangling")) problems.push(`${dangling.size} reference(s) from campaign data name an entity that is not in the graph (listed above); pass --allow-dangling if they are known`);

if (existsSync(nsDest)) problems.push(`${nsDest} already exists`);

if (problems.length) stop(problems.map((p, i) => `${problems.length > 1 ? `(${i + 1}) ` : ""}${p}`).join("\n         ") + "\nNothing was changed.");
if (!apply) { console.log(`\nReady. --apply writes ${graphPath}, copies the reveal state to ${nsDest} and publishes the graph for Foundry.`); process.exit(0); }

let serverUp = false;
try { serverUp = (await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) })).status > 0; } catch { /* not answering */ }
if (serverUp && !flag("--while-running")) stop(`the app server is answering at ${base}. Stop it first (systemctl --user stop gm-tools), run this again, then start it.`);

// Reveal state first: the graph file is the switch, so it is written last.
if (nsFiles.length) {
  mkdirSync(nsDest, { recursive: true });
  for (const f of nsFiles) {
    cpSync(join(nsSrc, f), join(nsDest, f), { preserveTimestamps: true });
    if (!readFileSync(join(nsSrc, f)).equals(readFileSync(join(nsDest, f)))) stop(`${join(nsDest, f)} does not match its original after the copy`);
  }
}
const file = toGraphFile({ worldId: world, sessionNumber: payload.meta?.sessionNumber ?? 0, entities, edges, entityTypes });
mkdirSync(data, { recursive: true });
writeFileSync(graphPath, JSON.stringify(file, null, 2) + "\n", "utf8");

// Read it back through the normal reader and compare with the source.
const back = readGraphPayload(graphPath).snapshot;
const key = (arr) => JSON.stringify([...arr].sort((a, b) => (a.id < b.id ? -1 : 1)));
if (key(back.entities) !== key(entities) || key(back.edges) !== key(edges) || key(back.entityTypes) !== key(entityTypes)) stop(`${graphPath} does not read back equal to the snapshot. Delete it to undo.`);
const published = publishGraphToFoundry(file, { dataDir });

console.log(`\nDone: ${graphPath} (${statSync(graphPath).size} bytes) now holds the graph; ${nsFiles.length} reveal record(s) copied.`);
console.log(published ? `Published for Foundry: ${published}` : "Not published: no Foundry folder for this world.");
console.log("Next: switch the module (gm-client.mjs --graph-source file), restart the services, then review and commit the campaign repo.");
