/**
 * Atlas store — `<atlases dir>/<atlasId>.json` (GM truth) and `<atlasId>.known.json` (what the table knows).
 *
 * The folder resolves through campaign-home (store "atlases", never "atlas": a store's fallback folder is its own
 * name inside the checkout, and `atlas/` is this library). Override with GM_TOOLS_ATLAS_DIR for tests.
 *
 * Writes: `updateAtlas(world, id, fn)` reads, applies `fn`, validates and writes INSIDE one lock, so an edit from the
 * browser and one from Claude can't interleave; ops address ids, so neither needs the other's revision. A lock held
 * by someone else is retried a few times, then surfaces as ConcurrentWriteError. Only `replaceAtlas` (a whole-file
 * write) takes `ifRevision`. Output is written with sorted keys and id-sorted lists so git diffs stay readable.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { campaignStoreDir } from "../mutation-engine/campaign-home.mjs";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";
import { parseAtlas, KnownFile, emptyKnown, ATLAS_SCHEMA_VERSION } from "./schema.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEGACY_ROOT = join(__dirname, "..", "atlases");

export { ConcurrentWriteError };

export class RevisionMismatchError extends Error {
  constructor(id, expected, actual) {
    super(`Atlas "${id}" is at revision ${actual}, not ${expected}. Reload it and try again.`);
    this.name = "RevisionMismatchError";
    this.code = "revision_mismatch";
    this.actual = actual;
  }
}

export function atlasDir(world) {
  return campaignStoreDir(world, { store: "atlases", envVar: "GM_TOOLS_ATLAS_DIR", legacyRoot: LEGACY_ROOT });
}

const atlasPath = (world, id) => join(atlasDir(world), `${id}.json`);
const knownPath = (world, id) => join(atlasDir(world), `${id}.known.json`);

export function listAtlases(world) {
  const dir = atlasDir(world);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".known.json")).map((f) => f.slice(0, -5)).sort();
}

export function atlasExists(world, id) {
  return existsSync(atlasPath(world, id));
}

export function loadAtlas(world, id) {
  const p = atlasPath(world, id);
  if (!existsSync(p)) throw new Error(`No atlas "${id}" for world "${world}" (looked in ${atlasDir(world)})`);
  return parseAtlas(JSON.parse(readFileSync(p, "utf8")));
}

/** Stable JSON: object keys sorted, lists of {id} records sorted by id. Points and other arrays keep their order. */
export function stableStringify(value) {
  const norm = (v) => {
    if (Array.isArray(v)) {
      const out = v.map(norm);
      return out.every((x) => x && typeof x === "object" && !Array.isArray(x) && typeof x.id === "string")
        ? out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) : out;
    }
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
    return v;
  };
  return JSON.stringify(norm(value), null, 1) + "\n";
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function withRetry(path, fn, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      return withLock(path, fn);
    } catch (e) {
      if (!(e instanceof ConcurrentWriteError) || i >= tries - 1) throw e;
      const until = Date.now() + 40 * (i + 1);
      while (Date.now() < until) { /* brief spin: writes are milliseconds */ }
    }
  }
}

/** Create a new atlas. Refuses if one with that id exists. */
export function createAtlas(world, raw) {
  const atlas = parseAtlas({ schemaVersion: ATLAS_SCHEMA_VERSION, revision: 0, units: "ft", ...raw });
  const p = atlasPath(world, atlas.id);
  return withRetry(p, () => {
    if (existsSync(p)) throw new Error(`Atlas "${atlas.id}" already exists for world "${world}"`);
    writeAtomic(p, stableStringify(atlas));
    return atlas;
  });
}

/**
 * Read, change, validate and write under one lock. `fn(atlas)` returns the new atlas (or mutates and returns
 * nothing). The revision goes up by one. Returns { atlas, before }.
 */
export function updateAtlas(world, id, fn) {
  const p = atlasPath(world, id);
  return withRetry(p, () => {
    const before = loadAtlas(world, id);
    const draft = structuredClone(before);
    const changed = fn(draft) ?? draft;
    const atlas = parseAtlas({ ...changed, revision: before.revision + 1 });
    writeAtomic(p, stableStringify(atlas));
    return { atlas, before };
  });
}

/** Whole-file replace, guarded by the revision the caller last saw. */
export function replaceAtlas(world, id, raw, { ifRevision } = {}) {
  const p = atlasPath(world, id);
  return withRetry(p, () => {
    const current = loadAtlas(world, id);
    if (ifRevision !== undefined && ifRevision !== current.revision) throw new RevisionMismatchError(id, ifRevision, current.revision);
    const atlas = parseAtlas({ ...raw, id, revision: current.revision + 1 });
    writeAtomic(p, stableStringify(atlas));
    return atlas;
  });
}

export function loadKnown(world, id) {
  const p = knownPath(world, id);
  if (!existsSync(p)) return emptyKnown(id);
  return KnownFile.parse(JSON.parse(readFileSync(p, "utf8")));
}

/**
 * Record what the table now knows. `marks` = [{id, level, note?}], level heard|seen|walked|forgotten. A level never
 * drops by accident: marking "heard" on something already "walked" is ignored unless `force`. "forgotten" removes it.
 * Every applied change is appended to the log.
 */
export function markKnown(world, id, marks, { by = "gm", force = false, at = new Date().toISOString() } = {}) {
  const p = knownPath(world, id);
  const rank = { heard: 1, seen: 2, walked: 3 };
  return withRetry(p, () => {
    const file = loadKnown(world, id);
    const applied = [];
    for (const m of marks) {
      const cur = file.known[m.id];
      if (m.level === "forgotten") {
        if (!cur) continue;
        delete file.known[m.id];
      } else {
        if (cur && !force && rank[cur] >= rank[m.level]) continue;
        file.known[m.id] = m.level;
      }
      const entry = { at, id: m.id, level: m.level, by, ...(m.note ? { note: m.note } : {}) };
      file.log.push(entry);
      applied.push(entry);
    }
    const parsed = KnownFile.parse(file);
    writeAtomic(p, JSON.stringify({ ...parsed, known: Object.fromEntries(Object.entries(parsed.known).sort()) }, null, 1) + "\n");
    return { known: parsed, applied };
  });
}
