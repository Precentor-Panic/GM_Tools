#!/usr/bin/env node
/**
 * Records, on each map asset, the grid size its image is drawn at, read from
 * the Scene pack of the Foundry module that ships the image. A scene pushed
 * with that map is then created with a grid that lines up with the art.
 *
 *   bin/map-grid --world aureus                  # report only
 *   bin/map-grid --world aureus --apply          # record what the packs say
 *   bin/map-grid --world aureus --set <assetId> 140
 *
 * --apply only fills a map that has no size recorded; it reports, and leaves
 * alone, one whose recorded size disagrees with its pack (--overwrite to
 * replace). A map whose module was unpacked for images only has no pack to
 * read: set it by hand with --set, or on its Library row.
 *
 * To change the grid of a scene that is ALREADY in Foundry, run
 * `bin/foundry-push --world <w> --plan <id> --regrid` afterwards.
 */
import { gridForSrc } from "../wf-mcp-server/lib/module-scene-grid.mjs";
import { resolveDataDir } from "../wf-mcp-server/lib/data-dir.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(name);

const world = opt("--world");
if (!world) { console.error("--world is required"); process.exit(2); }
const dataDir = opt("--data-dir") || resolveDataDir();
const base = opt("--base", "http://localhost:8787");

const post = async (path, body) => {
  const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world, ...body }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
  return json;
};
const setGrid = (id, gridSize) => post(`/api/session-planner/stagecraft/${encodeURIComponent(id)}/grid`, { gridSize });

const setAt = argv.indexOf("--set");
if (setAt >= 0) {
  const [id, size] = [argv[setAt + 1], argv[setAt + 2]];
  if (!id || !size) { console.error("--set needs <assetId> <pixels>"); process.exit(2); }
  const { asset } = await setGrid(id, size === "none" ? null : Number(size));
  console.log(`${asset.name}: grid ${asset.gridSize ?? "cleared"}`);
  process.exit(0);
}

const res = await fetch(`${base}/api/session-planner/stagecraft?world=${encodeURIComponent(world)}&kind=map`);
if (!res.ok) { console.error(`Could not list map assets: ${res.status}`); process.exit(1); }
const assets = ((await res.json()).assets ?? []).filter((a) => a.status !== "discarded");

const cache = new Map();
const rows = [];
for (const a of assets) {
  const src = a.src || a.foundryRef?.imagePath || null;
  const found = src ? await gridForSrc(dataDir, src, process.env, cache) : { size: null, reason: "no file path recorded" };
  let action = "";
  if (found.size && !a.gridSize) action = "fill";
  else if (found.size && a.gridSize !== found.size) action = "differs";
  rows.push({ a, src, found, action });
}

const apply = flag("--apply");
const overwrite = flag("--overwrite");
let wrote = 0;
for (const r of rows) {
  const will = r.action === "fill" || (r.action === "differs" && overwrite);
  if (apply && will) { await setGrid(r.a.id, r.found.size); r.done = true; wrote++; }
  const recorded = r.a.gridSize ? String(r.a.gridSize) : "-";
  const pack = r.found.size ? String(r.found.size) : "-";
  const note = r.done ? "recorded" : r.action === "fill" ? "would record" : r.action === "differs" ? `recorded size differs from the pack${overwrite ? "" : " (left alone)"}` : r.found.size ? "" : r.found.reason;
  console.log(`${recorded.padStart(5)} ${pack.padStart(5)}  ${r.a.id}  ${r.a.name.slice(0, 52).padEnd(52)}  ${note}`);
}
console.log(`\n${"have".padStart(5)} ${"pack".padStart(5)}   ${rows.length} map asset(s). ${apply ? `${wrote} recorded.` : `${rows.filter((r) => r.action === "fill").length} to record; re-run with --apply.`}`);
