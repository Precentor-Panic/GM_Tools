#!/usr/bin/env node
// Lay out a Foundry scene from a map-segment composition: tiles + walls via the
// bridge's set_scene_layout op. Replaces only tiles/walls the bridge placed.
//
//   bin/scene-layout --world <w> --scene <Scene.uuid> --composition <file.json> [--data-dir <Data>] [--apply]
//
// Dry run by default: assembles, validates the openings against the segments'
// exit tags, and prints what the op would do. --apply writes the op and waits
// for a GM client's watcher to apply it. Problems (a door into solid art, a
// piece off the map) refuse --apply unless --force.
import { readFileSync } from "node:fs";
import { assembleComposition, layoutOpData } from "../map-segments/assemble.mjs";
import { segmentLoader } from "../map-segments/library.mjs";
import { resolveDataDir } from "../wf-mcp-server/lib/data-dir.mjs";
import { writeFoundryOps } from "../wf-mcp-server/lib/foundry-ops.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(name);
const world = opt("--world"), sceneUuid = opt("--scene"), compPath = opt("--composition");
if (!world || !sceneUuid || !compPath) {
  console.error("usage: scene-layout --world <w> --scene <Scene.uuid> --composition <file.json> [--data-dir <Data>] [--apply [--force]]");
  process.exit(2);
}
if (!/^Scene\.[A-Za-z0-9]{16}$/.test(sceneUuid)) { console.error(`--scene must be a Scene uuid (Scene.<16 chars>), got "${sceneUuid}"`); process.exit(2); }
const dataDir = opt("--data-dir") || resolveDataDir();
const a = assembleComposition(JSON.parse(readFileSync(compPath, "utf8")), segmentLoader(dataDir));
const data = layoutOpData(sceneUuid, a);
const doors = a.walls.filter((w) => w.door);
console.log(`${a.name}: ${a.width}x${a.height} px at ${a.gridSize}/square`);
console.log(`  tiles ${a.tiles.length} (${a.tiles.filter((t) => t.key.startsWith("piece:")).length} pieces, ${a.tiles.filter((t) => t.key.startsWith("overlay:")).length} overlays, ${a.tiles.filter((t) => t.key.startsWith("seam:")).length} seams)`);
console.log(`  walls ${a.walls.length} (${a.walls.filter((w) => w.key === "edge").length} edge, ${doors.length} doors, ${doors.filter((w) => w.ds === 2).length} locked)`);
for (const p of a.problems) console.log(`  PROBLEM ${p}`);
if (!flag("--apply")) { console.log(`dry run: nothing written. Target ${world} ${sceneUuid}. Add --apply to send.`); process.exit(a.problems.length ? 1 : 0); }
if (a.problems.length && !flag("--force")) { console.error("refusing --apply with problems (add --force to send anyway)"); process.exit(1); }
const out = await writeFoundryOps(dataDir, world, [{ opId: `layout_${Date.now().toString(36)}`, kind: "set_scene_layout", data }], { timeoutMs: 30000 });
if (out.status !== "applied") { console.error(`queued, not confirmed: ${out.note}`); process.exit(3); }
const r = out.results[0];
console.log(r?.ok ? `applied: ${JSON.stringify(r.result ?? r)}` : `FAILED: ${r?.error}`);
process.exit(r?.ok ? 0 : 1);
