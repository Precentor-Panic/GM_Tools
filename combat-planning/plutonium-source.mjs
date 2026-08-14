/**
 * Plutonium source layer — Friction Wave 1 W4a ("Plutonium's bundled
 * 5etools data as a Library source", friction.md 2026-08-14).
 *
 * The Plutonium Foundry module bundles its complete 5etools bestiary
 * dataset locally at `<dataDir>/modules/plutonium/data/bestiary/
 * bestiary-*.json` (~127 source files, ~4,126 creatures with full stat
 * meta). Plutonium itself gates creatures behind an import wall and
 * discourages bulk pre-import — so the planner Library was blind to what's
 * AVAILABLE. This module indexes that local data READ-ONLY into a compact
 * in-memory shape the Library's "Available via Plutonium" shelf (W4b) and
 * the per-creature add-to-shelf action (W4c) consume.
 *
 * HARD RULE (the friction note's own watch item): this is a separate,
 * read-only source LAYER. Nothing here writes to the curated bestiary
 * shelf (bestiary-store.mjs) — W4c's explicit per-creature add is the only
 * bridge, and it lives at the route, not here. Nothing here ever writes
 * into the Plutonium module dir either (readFileSync/readdirSync/statSync
 * only — see the import list).
 *
 * Index shape per creature (the scratch proof-of-concept's normalization,
 * productionized): { name, source, page, cr (display string|null),
 * crNum (number|null, for range filtering), type, tags, size, ac, hp,
 * environment, legendary }.
 * 5etools field quirks handled: `cr` is a string OR {cr,...}; `type` is a
 * string OR {type, tags}; `ac` is an array of number|{ac,...}; `hp` is
 * {average, formula}; `_copy` shells without their own cr (reprint stubs)
 * are skipped.
 *
 * Caching: per resolved bestiary dir, COARSE invalidation (the task's own
 * allowance): the cache is reused while the dir's mtimeMs AND its
 * bestiary-*.json file count are unchanged. Module data only changes on a
 * Plutonium update (which rewrites the whole dir), so this is effectively
 * process-lifetime in practice; a changed dir rebuilds on the next call.
 *
 * Graceful empty state: a missing module dir (Plutonium not installed)
 * returns { installed: false, files: 0, count: 0, creatures: [] } — never
 * a throw. Callers render "Plutonium isn't installed" copy off `installed`.
 *
 * Pure/deterministic (no LLM), plain library module per gm-tools
 * conventions — review-ui/server.mjs's routes are thin wrappers over these
 * functions, resolving `dataDir` via the same resolveDir() every other
 * route uses (never client-supplied).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The bundled bestiary data dir, resolved from the SAME dataDir the rest of the server uses. */
export function plutoniumBestiaryDir(dataDir) {
  return join(dataDir, "modules", "plutonium", "data", "bestiary");
}

/**
 * PURE. "1/8" -> 0.125, "5" -> 5, non-numeric ("Unknown", null, "—") -> null.
 * @param {string|number|null|undefined} cr
 * @returns {number|null}
 */
export function crToNumber(cr) {
  if (cr == null) return null;
  if (typeof cr === "number") return Number.isFinite(cr) ? cr : null;
  const s = String(cr).trim();
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const denom = Number(frac[2]);
    return denom === 0 ? null : Number(frac[1]) / denom;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** PURE. One raw 5etools monster record -> the compact index row (null if it should be skipped). */
export function normalizeMonster(m) {
  if (!m || typeof m.name !== "string" || !m.name) return null;
  if (m._copy && !m.cr) return null; // reprint shells without their own stats
  const cr = m.cr == null ? null : (typeof m.cr === "string" ? m.cr : (m.cr.cr ?? null));
  const type = typeof m.type === "string" ? m.type : (typeof m.type?.type === "string" ? m.type.type : null);
  const tags = (typeof m.type === "object" && Array.isArray(m.type?.tags))
    ? m.type.tags.filter((t) => typeof t === "string")
    : null;
  const ac = Array.isArray(m.ac)
    ? (typeof m.ac[0] === "number" ? m.ac[0] : (m.ac[0]?.ac ?? null))
    : (typeof m.ac === "number" ? m.ac : null);
  return {
    name: m.name,
    source: typeof m.source === "string" ? m.source : null,
    page: m.page ?? null,
    cr,
    crNum: crToNumber(cr),
    type,
    tags,
    size: Array.isArray(m.size) ? m.size.filter((s) => typeof s === "string") : null,
    ac,
    hp: typeof m.hp?.average === "number" ? m.hp.average : null,
    environment: Array.isArray(m.environment) ? m.environment.filter((e) => typeof e === "string") : null,
    legendary: !!m.legendary
  };
}

/** Uncached build. Prefer loadPlutoniumIndex (same result, cached). */
export function buildPlutoniumIndex(dataDir) {
  const dir = plutoniumBestiaryDir(dataDir);
  if (!existsSync(dir)) {
    return { installed: false, dir, files: 0, count: 0, creatures: [], builtAt: new Date().toISOString() };
  }
  const fileNames = readdirSync(dir).filter((f) => f.startsWith("bestiary-") && f.endsWith(".json"));
  const creatures = [];
  let files = 0;
  for (const f of fileNames) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue; // one unreadable file never takes the whole shelf down
    }
    if (!Array.isArray(parsed?.monster)) continue;
    files++;
    for (const m of parsed.monster) {
      const row = normalizeMonster(m);
      if (row) creatures.push(row);
    }
  }
  // Stable name-then-source order so pagination offsets mean the same thing
  // across calls (readdir order is filesystem-dependent).
  creatures.sort((a, b) => (a.name.localeCompare(b.name)) || String(a.source).localeCompare(String(b.source)));
  return { installed: true, dir, files, count: creatures.length, creatures, builtAt: new Date().toISOString() };
}

// dir path -> { key, index } — see the header's coarse-invalidation note.
const indexCache = new Map();

function cacheKeyFor(dir) {
  if (!existsSync(dir)) return "not-installed";
  try {
    const stat = statSync(dir);
    const fileCount = readdirSync(dir).filter((f) => f.startsWith("bestiary-") && f.endsWith(".json")).length;
    return `${stat.mtimeMs}:${fileCount}`;
  } catch {
    return "not-installed";
  }
}

/**
 * The cached read every caller should use.
 * @param {string} dataDir
 * @returns {{installed:boolean, dir:string, files:number, count:number, creatures:object[], builtAt:string}}
 */
export function loadPlutoniumIndex(dataDir) {
  const dir = plutoniumBestiaryDir(dataDir);
  const key = cacheKeyFor(dir);
  const cached = indexCache.get(dir);
  if (cached && cached.key === key) return cached.index;
  const index = buildPlutoniumIndex(dataDir);
  indexCache.set(dir, { key, index });
  return index;
}

/** Test seam: drop every cached index (coarse invalidation is otherwise mtime-driven). */
export function clearPlutoniumIndexCache() {
  indexCache.clear();
}

/**
 * PURE. Filter + window the compact index for the shelf.
 * @param {object[]} creatures   loadPlutoniumIndex(...).creatures
 * @param {{query?:string, crMin?:number|null, crMax?:number|null, type?:string|null, source?:string|null, offset?:number, limit?:number}} [opts]
 *   - query: case-insensitive substring on name
 *   - crMin/crMax: numeric bounds on crNum; when EITHER bound is set,
 *     creatures with no numeric CR are excluded (a CR filter asks a
 *     question a CR-less row can't answer)
 *   - type/source: case-insensitive exact match
 *   - offset/limit: the window (limit defaults 50, hard cap 500 — 4k rows
 *     must never ride one response)
 * @returns {{matched:number, offset:number, limit:number, creatures:object[]}}
 */
export function searchPlutoniumIndex(creatures, opts = {}) {
  const query = typeof opts.query === "string" ? opts.query.trim().toLowerCase() : "";
  const type = typeof opts.type === "string" && opts.type.trim() ? opts.type.trim().toLowerCase() : null;
  const source = typeof opts.source === "string" && opts.source.trim() ? opts.source.trim().toLowerCase() : null;
  const crMin = typeof opts.crMin === "number" && Number.isFinite(opts.crMin) ? opts.crMin : null;
  const crMax = typeof opts.crMax === "number" && Number.isFinite(opts.crMax) ? opts.crMax : null;
  const offset = Number.isInteger(opts.offset) && opts.offset > 0 ? opts.offset : 0;
  const limit = Math.min(Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 50, 500);

  const filtered = (creatures || []).filter((c) => {
    if (query && !c.name.toLowerCase().includes(query)) return false;
    if (type && (c.type ?? "").toLowerCase() !== type) return false;
    if (source && (c.source ?? "").toLowerCase() !== source) return false;
    if (crMin !== null || crMax !== null) {
      if (c.crNum === null || c.crNum === undefined) return false;
      if (crMin !== null && c.crNum < crMin) return false;
      if (crMax !== null && c.crNum > crMax) return false;
    }
    return true;
  });

  return { matched: filtered.length, offset, limit, creatures: filtered.slice(offset, offset + limit) };
}

/**
 * PURE. Facet lists for the shelf's filter dropdowns, over the WHOLE index
 * (not the current filter — a dropdown that only lists what already matches
 * can never widen a search).
 * @returns {{sources:{id:string,count:number}[], types:{id:string,count:number}[]}}
 */
export function plutoniumFacets(creatures) {
  const count = (getter) => {
    const counts = new Map();
    for (const c of creatures || []) {
      const v = getter(c);
      if (!v) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([id, n]) => ({ id, count: n }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  };
  return { sources: count((c) => c.source), types: count((c) => c.type) };
}

/**
 * Exact lookup for W4c's add-to-shelf: (name, source) is the dataset's own
 * identity pair (the same creature name recurs across sources). Case-
 * insensitive on both. Returns the index row or null.
 */
export function findPlutoniumCreature(dataDir, { name, source } = {}) {
  if (!name || !source) return null;
  const { creatures } = loadPlutoniumIndex(dataDir);
  const n = String(name).trim().toLowerCase();
  const s = String(source).trim().toLowerCase();
  return creatures.find((c) => c.name.toLowerCase() === n && (c.source ?? "").toLowerCase() === s) ?? null;
}
