/**
 * Plutonium source layer — Friction Wave 1 W4a ("Plutonium's bundled
 * 5etools data as a Library source", friction.md 2026-08-14), generalized
 * under "Aureus to the Table" task G4 from a bestiary-only indexer to a
 * family-descriptor core covering every flat 5etools data file Plutonium
 * bundles (items, spells [descriptor-only, see below], variant rules,
 * actions, conditions/diseases/statuses, skills, senses, tables) — while
 * every export that existed before G4 stays byte-compatible (same
 * signature, same returned shape, same cache-identity semantics). The
 * original bestiary-only test file (test/combat-planning/plutonium-source
 * .test.mjs) passes unmodified against this file.
 *
 * The Plutonium Foundry module bundles its complete 5etools dataset locally
 * at `<dataDir>/modules/plutonium/data/`. Plutonium itself gates content
 * behind an import wall and discourages bulk pre-import — so the planner
 * Library was blind to what's AVAILABLE. This module indexes that local
 * data READ-ONLY into a compact in-memory shape per "family" (bestiary,
 * items, ...); review-ui/server.mjs's routes are thin wrappers over these
 * functions, resolving `dataDir` via the same resolveDir() every other
 * route uses (never client-supplied).
 *
 * HARD RULE (the friction note's own watch item, unchanged by G4): this is
 * a separate, read-only source LAYER. Nothing here writes to a curated
 * shelf (bestiary-store.mjs, item-store.mjs) — an explicit per-record add
 * is the only bridge, and it lives at the route, not here. Nothing here
 * ever writes into the Plutonium module dir either (readFileSync/
 * readdirSync/statSync only — see the import list).
 *
 * FAMILY DESCRIPTORS (the generalization's core idea): each entry in
 * `FAMILIES` describes where a family's raw JSON lives (either a `dir` of
 * many numbered files matched by `filePattern`, e.g. bestiary-*.json /
 * spells-*.json, or a fixed list of `files`), which top-level array
 * `props` on each parsed file hold the raw records (some files hold more
 * than one, e.g. conditionsdiseases.json holds `condition`+`disease`+
 * `status`; items.json/items-base.json split `item`/`baseitem` across two
 * files), and a `normalize(record, {prop, family}) -> row|null` function.
 * `normalize: null` means "descriptor only, not yet consumed" (spells,
 * v1 — see below).
 *
 * MAGIC VARIANTS (deliberately NOT a family in v1): magicvariants.json is a
 * GENERATIVE cross-product (a base item × an "of Sharpness"-style enchant
 * template) rather than a flat list of concrete records — expanding it
 * correctly means running 5etools' own variant-resolution logic, which is
 * out of scope here. Named magic items already exist CONCRETELY in
 * items.json (e.g. "Sun Blade") and are covered by the `items` family as
 * normal; a generic "+N weapon"-style variant is a manual Plutonium import
 * at prep time, same as today.
 *
 * SPELLS (descriptor present, normalize deliberately null in v1): the
 * `spells` family descriptor exists so `loadPlutoniumFamily(dir, "spells")`
 * resolves the right files, but no normalizer is wired yet — no route or
 * UI in this workstream surfaces spells. A later workstream can add
 * `normalize` without touching the resolution/caching machinery.
 *
 * normalizeItem (`items` family): `{name, source, page, type (raw 5etools
 * code string, e.g. "P"/"G"/"M"/"SCF"), rarity (string; "none" for
 * mundane gear), weight, value, reqAttune (false|true|string, verbatim —
 * some items condition attunement, e.g. "by an artificer"), wondrous
 * (bool), isBase (bool — true for a baseitem.json mundane-equipment
 * record, false for an items.json record), srd (bool)}`. Records carrying
 * `_copy` are skipped outright (not just when they lack their own stats,
 * unlike normalizeMonster) — an item `_copy` shell is a reference to
 * another item's full record (e.g. a reprint under a different book) that
 * needs 5etools-side copy-resolution logic this layer doesn't implement;
 * indexing the shell as-is would show a near-empty, misleading row.
 *
 * normalizeSimpleEntry (the rules-shaped families: variantrules, actions,
 * conditionsdiseases, skills, senses, tables): `{name, source, page,
 * ruleType (the record's own field when present, else null), textPreview
 * (the record's `entries` flattened to plain text and truncated to ~300
 * chars)}`. Entries flattening is deliberately simple, not a full 5etools
 * renderer: a string entry is kept verbatim; a nested `{entries:[...]}`
 * object (5etools' "entries"/"list"/etc. wrapper shape) is recursed into;
 * any other non-string leaf (a table, an image, an inset) is skipped, not
 * rendered as "[object Object]" or similar. These families are not
 * surfaced by this workstream's own routes/UI — another workstream
 * consumes them via `loadPlutoniumFamily` directly — but are unit-tested
 * here for correct loading.
 *
 * Index shape per creature (bestiary family, UNCHANGED from before G4):
 * { name, source, page, cr (display string|null), crNum (number|null, for
 * range filtering), type, tags, size, ac, hp, environment, legendary }.
 * 5etools field quirks handled: `cr` is a string OR {cr,...}; `type` is a
 * string OR {type, tags}; `ac` is an array of number|{ac,...}; `hp` is
 * {average, formula}; `_copy` shells without their own cr (reprint stubs)
 * are skipped.
 *
 * Caching: per resolved family location, COARSE invalidation (the task's
 * own allowance): the cache is reused while the backing dir's mtimeMs AND
 * its matching-file count are unchanged (dir-based families), or while
 * every backing file's own mtimeMs/existence is unchanged (fixed-file
 * families). Module data only changes on a Plutonium update (which
 * rewrites the whole dir), so this is effectively process-lifetime in
 * practice; a changed dir/file set rebuilds on the next call.
 *
 * Graceful empty state: a missing backing dir/file set (Plutonium not
 * installed, or this family's files absent) returns `{installed: false,
 * count: 0, rows: []}` (bestiary keeps its pre-G4 `creatures` key instead
 * of `rows` — see loadPlutoniumIndex) — never a throw. Callers render
 * "Plutonium isn't installed" copy off `installed`.
 *
 * Pure/deterministic (no LLM), plain library module per gm-tools
 * conventions.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The plugin's bundled data dir, resolved from the SAME dataDir the rest of the server uses. */
function pluginDataDir(dataDir) {
  return join(dataDir, "modules", "plutonium", "data");
}

/** The bundled bestiary data dir, resolved from the SAME dataDir the rest of the server uses. */
export function plutoniumBestiaryDir(dataDir) {
  return join(pluginDataDir(dataDir), "bestiary");
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

/**
 * PURE. One raw 5etools item/baseitem record -> the compact index row (null
 * if it should be skipped). `_copy` records are always skipped — see the
 * module header's "normalizeItem" section for why (unlike normalizeMonster,
 * which only skips a _copy shell that ALSO lacks its own cr).
 * @param {object} item
 * @param {{prop?: string}} [ctx]   ctx.prop === "baseitem" marks isBase
 */
export function normalizeItem(item, ctx = {}) {
  if (!item || typeof item.name !== "string" || !item.name) return null;
  if (item._copy) return null;
  return {
    name: item.name,
    source: typeof item.source === "string" ? item.source : null,
    page: item.page ?? null,
    type: typeof item.type === "string" ? item.type : null,
    rarity: typeof item.rarity === "string" && item.rarity ? item.rarity : "none",
    weight: typeof item.weight === "number" ? item.weight : null,
    value: typeof item.value === "number" ? item.value : null,
    reqAttune: item.reqAttune === true ? true : (typeof item.reqAttune === "string" ? item.reqAttune : false),
    wondrous: !!item.wondrous,
    isBase: ctx.prop === "baseitem",
    srd: !!item.srd
  };
}

/**
 * PURE, internal. 5etools "entries" flattening: a string is kept verbatim;
 * an object carrying its own array `entries` (the "entries"/"list"/"inset"
 * etc. wrapper shape) is recursed into; any other non-string leaf (a
 * table, an image, ...) is skipped. Depth-capped defensively — this data
 * is bundled JSON, not adversarial input, but a cycle would hang otherwise.
 */
function flattenEntryText(entries, depth = 0) {
  if (!Array.isArray(entries) || depth > 8) return [];
  const out = [];
  for (const e of entries) {
    if (typeof e === "string") out.push(e);
    else if (e && typeof e === "object" && Array.isArray(e.entries)) out.push(...flattenEntryText(e.entries, depth + 1));
    // else: non-string leaf (table/image/inset/...) -- skipped, not stringified
  }
  return out;
}

/**
 * PURE. One raw 5etools "rules-shaped" record (variant rule, action,
 * condition/disease/status, skill, sense, table) -> the compact row (null
 * if unnamed). See the module header's "normalizeSimpleEntry" section.
 * @param {object} record
 */
export function normalizeSimpleEntry(record) {
  if (!record || typeof record.name !== "string" || !record.name) return null;
  const flat = flattenEntryText(record.entries).join(" ").trim();
  const textPreview = flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
  return {
    name: record.name,
    source: typeof record.source === "string" ? record.source : null,
    page: record.page ?? null,
    ruleType: typeof record.ruleType === "string" ? record.ruleType : null,
    textPreview
  };
}

/**
 * Family descriptors — see the module header. `dir`-based families glob
 * `filePattern`-matching files under that subdirectory; `files`-based
 * families read a fixed list of filenames directly under the plugin data
 * dir. `normalize: null` marks a descriptor-only family (spells, v1).
 */
const FAMILIES = {
  bestiary: { dir: "bestiary", filePattern: /^bestiary-.+\.json$/, props: ["monster"], normalize: normalizeMonster },
  items: { files: ["items.json", "items-base.json"], props: ["item", "baseitem"], normalize: normalizeItem },
  spells: { dir: "spells", filePattern: /^spells-.+\.json$/, props: ["spell"], normalize: null },
  variantrules: { files: ["variantrules.json"], props: ["variantrule"], normalize: normalizeSimpleEntry },
  actions: { files: ["actions.json"], props: ["action"], normalize: normalizeSimpleEntry },
  conditionsdiseases: { files: ["conditionsdiseases.json"], props: ["condition", "disease", "status"], normalize: normalizeSimpleEntry },
  skills: { files: ["skills.json"], props: ["skill"], normalize: normalizeSimpleEntry },
  senses: { files: ["senses.json"], props: ["sense"], normalize: normalizeSimpleEntry },
  tables: { files: ["tables.json"], props: ["table"], normalize: normalizeSimpleEntry }
};

/** Resolve a family descriptor's on-disk location(s) under this dataDir. */
function resolveFamilyPaths(dataDir, descriptor) {
  const base = pluginDataDir(dataDir);
  if (descriptor.dir) {
    return { kind: "dir", path: join(base, descriptor.dir), pattern: descriptor.filePattern };
  }
  return { kind: "files", paths: descriptor.files.map((f) => join(base, f)) };
}

function familyInstalled(resolved) {
  return resolved.kind === "dir" ? existsSync(resolved.path) : resolved.paths.some((p) => existsSync(p));
}

/** Coarse cache key: dir mtime+matching-file-count, or each fixed file's own mtime/absence. */
function cacheKeyForFamily(resolved) {
  if (resolved.kind === "dir") {
    if (!existsSync(resolved.path)) return "not-installed";
    try {
      const stat = statSync(resolved.path);
      const fileCount = readdirSync(resolved.path).filter((f) => resolved.pattern.test(f)).length;
      return `${stat.mtimeMs}:${fileCount}`;
    } catch {
      return "not-installed";
    }
  }
  return resolved.paths
    .map((p) => {
      if (!existsSync(p)) return "missing";
      try {
        return String(statSync(p).mtimeMs);
      } catch {
        return "missing";
      }
    })
    .join("|");
}

/** Uncached build. Prefer loadPlutoniumFamily (same result, cached). */
function buildPlutoniumFamily(dataDir, family, descriptor, resolved) {
  const builtAt = new Date().toISOString();
  if (!familyInstalled(resolved)) {
    return { installed: false, family, files: 0, count: 0, rows: [], raw: [], builtAt };
  }

  const rows = [];
  const raw = [];
  let files = 0;

  const consumeParsedFile = (parsed) => {
    if (!parsed) return;
    let sawAnyProp = false;
    for (const prop of descriptor.props) {
      const list = parsed[prop];
      if (!Array.isArray(list)) continue;
      sawAnyProp = true;
      for (const record of list) {
        const row = descriptor.normalize ? descriptor.normalize(record, { prop, family }) : null;
        if (row) {
          rows.push(row);
          raw.push(record);
        }
      }
    }
    if (sawAnyProp) files++;
  };

  const parseFile = (filePath) => {
    try {
      return JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      return null; // one unreadable/corrupt file never takes the whole family down
    }
  };

  if (resolved.kind === "dir") {
    const fileNames = existsSync(resolved.path)
      ? readdirSync(resolved.path).filter((f) => resolved.pattern.test(f))
      : [];
    for (const f of fileNames) consumeParsedFile(parseFile(join(resolved.path, f)));
  } else {
    for (const p of resolved.paths) {
      if (existsSync(p)) consumeParsedFile(parseFile(p));
    }
  }

  // Stable name-then-source order so pagination offsets mean the same thing
  // across calls (readdir/file-list order is filesystem-dependent); raw[]
  // is reordered in lockstep so raw[i] always backs rows[i].
  const order = rows.map((_, i) => i).sort((a, b) =>
    rows[a].name.localeCompare(rows[b].name) || String(rows[a].source).localeCompare(String(rows[b].source))
  );
  const sortedRows = order.map((i) => rows[i]);
  const sortedRaw = order.map((i) => raw[i]);

  return { installed: true, family, files, count: sortedRows.length, rows: sortedRows, raw: sortedRaw, builtAt };
}

// `${family}::${dataDir}` -> { key, data } — see the header's coarse-invalidation note.
const familyCache = new Map();

/**
 * The cached read every caller should use for a non-bestiary family (and
 * what loadPlutoniumIndex now delegates to internally for bestiary too).
 * @param {string} dataDir
 * @param {keyof typeof FAMILIES} family
 * @returns {{installed:boolean, family:string, files:number, count:number, rows:object[], raw:object[], builtAt:string}}
 */
export function loadPlutoniumFamily(dataDir, family) {
  const descriptor = FAMILIES[family];
  if (!descriptor) throw new Error(`Unknown Plutonium family: "${family}"`);
  const resolved = resolveFamilyPaths(dataDir, descriptor);
  const cacheKey = `${family}::${dataDir}`;
  const key = cacheKeyForFamily(resolved);
  const cached = familyCache.get(cacheKey);
  if (cached && cached.key === key) return cached.data;
  const data = buildPlutoniumFamily(dataDir, family, descriptor, resolved);
  familyCache.set(cacheKey, { key, data });
  return data;
}

/** Test seam: drop every cached family (coarse invalidation is otherwise mtime-driven). */
export function clearPlutoniumFamilyCache() {
  familyCache.clear();
}

/**
 * PURE. Filter + window a family's rows for a shelf.
 * @param {object[]} rows        loadPlutoniumFamily(...).rows
 * @param {{query?:string, filters?:Record<string,string>, offset?:number, limit?:number}} [opts]
 *   - query: case-insensitive substring on `name`, OR on `textPreview` when
 *     the row has one (the rules-shaped families)
 *   - filters: exact, case-insensitive match per named row field (e.g.
 *     {type:"P", rarity:"common", source:"DMG"} for the items family)
 *   - offset/limit: the window (limit defaults 50, hard cap 500)
 * @returns {{matched:number, offset:number, limit:number, rows:object[]}}
 */
export function searchPlutoniumFamily(rows, opts = {}) {
  const query = typeof opts.query === "string" ? opts.query.trim().toLowerCase() : "";
  const filters = opts.filters && typeof opts.filters === "object" ? opts.filters : {};
  const activeFilters = Object.entries(filters)
    .filter(([, v]) => typeof v === "string" && v.trim())
    .map(([k, v]) => [k, v.trim().toLowerCase()]);
  const offset = Number.isInteger(opts.offset) && opts.offset > 0 ? opts.offset : 0;
  const limit = Math.min(Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 50, 500);

  const filtered = (rows || []).filter((r) => {
    if (query) {
      const nameHit = typeof r.name === "string" && r.name.toLowerCase().includes(query);
      const textHit = typeof r.textPreview === "string" && r.textPreview.toLowerCase().includes(query);
      if (!nameHit && !textHit) return false;
    }
    for (const [key, val] of activeFilters) {
      const rv = r[key];
      if (typeof rv !== "string" || rv.toLowerCase() !== val) return false;
    }
    return true;
  });

  return { matched: filtered.length, offset, limit, rows: filtered.slice(offset, offset + limit) };
}

/**
 * PURE. Facet lists (id+count, most-common first) for one or more row
 * fields, over the WHOLE row set (not the current filter — a dropdown that
 * only lists what already matches can never widen a search).
 * @param {object[]} rows
 * @param {string[]} keys   row field names to facet, e.g. ["source","type","rarity"]
 * @returns {Record<string, {id:string,count:number}[]>}
 */
export function familyFacets(rows, keys) {
  const result = {};
  for (const key of keys) {
    const counts = new Map();
    for (const r of rows || []) {
      const v = r[key];
      if (!v || typeof v !== "string") continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    result[key] = [...counts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  }
  return result;
}

/**
 * Exact lookup by the dataset's own (name, source) identity pair,
 * case-insensitive on both. Returns the NORMALIZED row, or null.
 */
export function findPlutoniumRecord(dataDir, family, { name, source } = {}) {
  if (!name || !source) return null;
  const { rows } = loadPlutoniumFamily(dataDir, family);
  const n = String(name).trim().toLowerCase();
  const s = String(source).trim().toLowerCase();
  return rows.find((r) => (r.name ?? "").toLowerCase() === n && (r.source ?? "").toLowerCase() === s) ?? null;
}

/**
 * Exact lookup by (name, source), returning the FULL raw 5etools JSON
 * record verbatim (not the normalized row) — a later push feature composes
 * bridge ops from the real record, which the compact row deliberately
 * doesn't retain in full. Returns null on a miss.
 */
export function getRawPlutoniumEntry(dataDir, family, { name, source } = {}) {
  if (!name || !source) return null;
  const { rows, raw } = loadPlutoniumFamily(dataDir, family);
  const n = String(name).trim().toLowerCase();
  const s = String(source).trim().toLowerCase();
  const idx = rows.findIndex((r) => (r.name ?? "").toLowerCase() === n && (r.source ?? "").toLowerCase() === s);
  return idx === -1 ? null : raw[idx];
}

/** Uncached build. Prefer loadPlutoniumIndex (same result, cached). */
export function buildPlutoniumIndex(dataDir) {
  const descriptor = FAMILIES.bestiary;
  const resolved = resolveFamilyPaths(dataDir, descriptor);
  const family = buildPlutoniumFamily(dataDir, "bestiary", descriptor, resolved);
  const dir = resolved.path;
  if (!family.installed) {
    return { installed: false, dir, files: 0, count: 0, creatures: [], builtAt: family.builtAt };
  }
  return { installed: true, dir, files: family.files, count: family.count, creatures: family.rows, builtAt: family.builtAt };
}

// dir path -> { key, index } — see the header's coarse-invalidation note.
const indexCache = new Map();

/**
 * The cached read every caller should use.
 * @param {string} dataDir
 * @returns {{installed:boolean, dir:string, files:number, count:number, creatures:object[], builtAt:string}}
 */
export function loadPlutoniumIndex(dataDir) {
  const descriptor = FAMILIES.bestiary;
  const resolved = resolveFamilyPaths(dataDir, descriptor);
  const dir = resolved.path;
  const key = cacheKeyForFamily(resolved);
  const cached = indexCache.get(dir);
  if (cached && cached.key === key) return cached.index;
  const family = buildPlutoniumFamily(dataDir, "bestiary", descriptor, resolved);
  const index = family.installed
    ? { installed: true, dir, files: family.files, count: family.count, creatures: family.rows, builtAt: family.builtAt }
    : { installed: false, dir, files: 0, count: 0, creatures: [], builtAt: family.builtAt };
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
