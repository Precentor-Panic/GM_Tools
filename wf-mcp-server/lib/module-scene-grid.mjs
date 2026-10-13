/**
 * Reads the grid size a Foundry MODULE's own Scene documents declare for each
 * map image the module ships, so a scene pushed with one of those images can
 * carry the grid its artist drew it at.
 *
 * Why this exists (2026-10-13): the scene push sent no grid, so every pushed
 * scene got Foundry's default 100 px grid. Map packs are commonly drawn at
 * another size (140 px is usual), and the squares on the art then never line
 * up with Foundry's. The pack already says what the size is; this reads it.
 *
 * Generic on purpose: any module that ships Scene packs, no vendor names. Two
 * pack formats are read:
 *   - NeDB (`packs/<name>.db`, one JSON document per line) -- no dependency.
 *   - LevelDB (`packs/<name>/` with a CURRENT file) -- needs `classic-level`,
 *     which Foundry itself ships. It is loaded from Foundry's own install
 *     (CLASSIC_LEVEL_NODE_MODULES, or node_modules beside FOUNDRY_MAIN) and
 *     the pack is COPIED to a scratch directory first: Foundry's copy carries
 *     a LOCK and must never be opened by a second process.
 *
 * Read-only. Returns nothing rather than throwing when a module has no packs
 * (a module unpacked for its images only is common) -- the caller reports it.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/** `modules/<id>/…/file.jpg` -> `{moduleId, file}`; null for any other src. */
export function parseModuleSrc(src) {
  if (typeof src !== "string") return null;
  const m = /^\/?modules\/([^/]+)\/(.+)$/.exec(src.trim());
  if (!m) return null;
  return { moduleId: m[1], file: imageKey(m[2]) };
}

/** Comparison key for an image path: decoded, lower-case basename. Pack docs
 *  commonly URL-encode the path (`%27` for an apostrophe); asset rows do not. */
export function imageKey(path) {
  let p = String(path ?? "");
  try { p = decodeURIComponent(p); } catch { /* not encoded */ }
  return basename(p).toLowerCase();
}

/** Grid size from a Scene document of any schema generation: `grid: 140`
 *  (v9 and earlier), `grid: {size: 140}` (v10+). Null when absent or not a
 *  plausible size. */
export function gridSizeOf(sceneDoc) {
  const g = sceneDoc?.grid;
  const n = typeof g === "number" ? g : typeof g?.size === "number" ? g.size : null;
  return Number.isFinite(n) && n >= 10 && n <= 2000 ? Math.round(n) : null;
}

/** Background image of a Scene document: `background.src` (v10+) or `img`. */
export function backgroundOf(sceneDoc) {
  return sceneDoc?.background?.src ?? sceneDoc?.img ?? null;
}

/** `{imageKey: gridSize}` from already-decoded Scene documents. */
export function gridsFromSceneDocs(docs) {
  const out = {};
  for (const d of docs ?? []) {
    const src = backgroundOf(d);
    const size = gridSizeOf(d);
    if (src && size) out[imageKey(src)] = size;
  }
  return out;
}

function readNedb(path) {
  const docs = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { docs.push(JSON.parse(t)); } catch { /* a torn line is skipped */ }
  }
  return docs;
}

function loadClassicLevel(env = process.env) {
  const dirs = [
    env.CLASSIC_LEVEL_NODE_MODULES,
    env.FOUNDRY_MAIN ? join(dirname(env.FOUNDRY_MAIN), "node_modules") : null
  ].filter(Boolean);
  for (const d of dirs) {
    try { return createRequire(join(d, "noop.js"))("classic-level").ClassicLevel; } catch { /* try the next */ }
  }
  return null;
}

async function readLeveldb(packDir, env) {
  const ClassicLevel = loadClassicLevel(env);
  if (!ClassicLevel) return null; // caller reports "cannot read LevelDB packs here"
  const scratch = mkdtempSync(join(tmpdir(), "gm-tools-pack-"));
  const copy = join(scratch, "pack");
  try {
    cpSync(packDir, copy, { recursive: true });
    rmSync(join(copy, "LOCK"), { force: true });
    const db = new ClassicLevel(copy, { valueEncoding: "json" });
    await db.open();
    const scenes = [];
    const levels = {};
    for await (const [key, value] of db.iterator()) {
      const lm = /^!scenes\.levels!([^.!]+)\.([^.!]+)$/.exec(key);
      if (lm) { (levels[lm[1]] ??= {})[lm[2]] = value; continue; }
      if (/^!scenes!([^.!]+)$/.test(key) && value) scenes.push(value);
    }
    await db.close();
    // Foundry v14 moved `background` off the Scene onto its first Level, and
    // stores levels as separate keys. Resolve it back.
    for (const s of scenes) {
      if (s.background?.src || !Array.isArray(s.levels) || !s.levels.length) continue;
      const first = typeof s.levels[0] === "string" ? levels[s._id]?.[s.levels[0]] : s.levels[0];
      if (first?.background) s.background = first.background;
    }
    return scenes;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * @param {string} dataDir    Foundry's `Data` directory (holds `modules/`)
 * @param {string} moduleId
 * @param {object} [env]      for CLASSIC_LEVEL_NODE_MODULES / FOUNDRY_MAIN
 * @returns {Promise<{grids:Record<string,number>, reason:string|null}>}
 *   `grids` maps imageKey -> grid size. `reason` says why it is empty.
 */
export async function readModuleSceneGrids(dataDir, moduleId, env = process.env) {
  const moduleDir = join(dataDir, "modules", moduleId);
  if (!existsSync(moduleDir)) return { grids: {}, reason: "module is not installed" };
  const grids = {};
  let sawPack = false;
  let leveldbUnreadable = false;
  for (const sub of ["packs", "Packs"]) {
    const packsDir = join(moduleDir, sub);
    if (!existsSync(packsDir)) continue;
    for (const name of readdirSync(packsDir)) {
      const p = join(packsDir, name);
      let docs = null;
      try {
        if (statSync(p).isDirectory() && existsSync(join(p, "CURRENT"))) {
          sawPack = true;
          docs = await readLeveldb(p, env);
          if (docs === null) leveldbUnreadable = true;
        } else if (name.endsWith(".db")) {
          sawPack = true;
          docs = readNedb(p);
        }
      } catch { docs = null; }
      Object.assign(grids, gridsFromSceneDocs(docs));
    }
  }
  if (Object.keys(grids).length) return { grids, reason: null };
  if (!sawPack) return { grids, reason: "module has no scene pack installed (images only)" };
  if (leveldbUnreadable) return { grids, reason: "pack is LevelDB and classic-level was not found (set FOUNDRY_MAIN or CLASSIC_LEVEL_NODE_MODULES)" };
  return { grids, reason: "pack holds no scene with a grid and a background" };
}

/** The grid for one asset `src`, or `{size:null, reason}`. */
export async function gridForSrc(dataDir, src, env = process.env, cache = new Map()) {
  const parsed = parseModuleSrc(src);
  if (!parsed) return { size: null, reason: "not a module image" };
  if (!cache.has(parsed.moduleId)) cache.set(parsed.moduleId, await readModuleSceneGrids(dataDir, parsed.moduleId, env));
  const { grids, reason } = cache.get(parsed.moduleId);
  if (grids[parsed.file]) return { size: grids[parsed.file], reason: null };
  return { size: null, reason: reason ?? "the pack has no scene for this image" };
}
