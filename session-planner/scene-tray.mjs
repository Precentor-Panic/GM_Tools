/**
 * Scene tray store — Phase 35 task 35.1, §7 of review-ui/test/e2e/
 * phase35-fixture.mjs (THE WRITTEN CONTRACT; this file's own header pins
 * the store shape/persistence rules 35.3's UI wiring builds against — §7 is
 * explicit that "35.3 WIRES this; 35.0 SPECS it", and 35.1 (this task)
 * BUILDS the store + the routes listed in §8, per the task's own dispatch
 * instructions).
 *
 * Per-world, ONE JSON file per world (`<sceneTrayRoot>/<world>.json`), a
 * flat array of `{sceneId, world, roster, xpBudget, updatedAt}` records —
 * ONE per (world, sceneId) that has EVER received a drop or an explicit
 * budget set (a scene with no tray activity has NO record at all). Default
 * root GM_Tools/scene-tray/; override GM_TOOLS_SCENE_TRAY_DIR (tests use
 * this for isolation — the exact env var name is pinned by
 * review-ui/test/e2e/phase35-fixture.mjs's own setupPhase35Env). Reuses
 * review-state.mjs's withLock/ConcurrentWriteError, same as every other
 * store in this project.
 *
 * `getSceneTray` NEVER throws/404s for an unknown sceneId — it returns the
 * default `{roster:[], xpBudget:null}` shape, per the contract's own
 * explicit pin ("a scene with no tray activity simply has no record").
 *
 * roster entries: `{id, n, kind:'creature'|'hero'|'asset'}`. STACKING
 * (Library.dc.html's own `drop:` handler, copied verbatim, not
 * reinterpreted): a "creature" drop INCREMENTS an existing entry's `n` by 1;
 * "hero"/"asset" drops always RESET `n` to 1 on a repeat drop (never
 * stack).
 *
 * XP BUDGET: `xpBudget` is persisted ON THE TRAY RECORD ITSELF, not on
 * session-planner/scenes.mjs's own Scene record (§7's own pinned decision —
 * an XP budget is tray/encounter-prep state, not a core scene property).
 * This store only PERSISTS whatever number a GM sets — the literal CR->XP
 * arithmetic itself stays entirely client-side (§7's locked decision, no
 * verdict language), no route here computes or returns an XP total.
 *
 * This module is DELIBERATELY roster/budget bookkeeping ONLY — it knows
 * nothing about bestiary entries, scene elements, or item/stagecraft
 * lookups. The "creature drop creates a stat-carrying scene element on
 * first occurrence" composition (§7's own pinned decision) lives at the
 * ROUTE level (review-ui/server.mjs's POST .../tray/drop handler), per the
 * task's own explicit instruction — this keeps the store free of a
 * cross-store import tangle (bestiary-store + scene-elements + item-store +
 * stagecraft-store all at once) for a concern that's really about one
 * route's request handling, not persistence.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "scene-tray");

export function sceneTrayRoot() {
  return process.env.GM_TOOLS_SCENE_TRAY_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return join(sceneTrayRoot(), `${world}.json`);
}

function readTray(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) return [];
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeTray(world, records) {
  const filePath = worldFilePath(world);
  withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(records, null, 2), "utf8");
  });
  return records;
}

function findRecord(records, sceneId) {
  return records.find((r) => r.sceneId === sceneId);
}

function projectPublic(rec) {
  return rec ? { roster: rec.roster, xpBudget: rec.xpBudget } : { roster: [], xpBudget: null };
}

function findOrCreateRecord(world, sceneId, records, now) {
  let rec = findRecord(records, sceneId);
  if (!rec) {
    rec = { sceneId, world, roster: [], xpBudget: null, updatedAt: now };
    records.push(rec);
  }
  return rec;
}

/**
 * @param {string} world
 * @param {string} sceneId
 * @returns {{roster:object[], xpBudget:number|null}}   NEVER throws/404s for an unknown sceneId.
 */
export function getSceneTray(world, sceneId) {
  const records = readTray(world);
  return projectPublic(findRecord(records, sceneId));
}

/**
 * Adds/stacks a roster entry per the STACKING rule documented above.
 * @param {string} world
 * @param {string} sceneId
 * @param {{id:string, kind:'creature'|'hero'|'asset'}} entry
 * @param {object} [opts]
 * @param {string} [opts.now]
 * @returns {{roster:object[], xpBudget:number|null}}
 */
export function addToSceneTray(world, sceneId, { id, kind }, opts = {}) {
  const now = opts.now ?? new Date().toISOString();
  const records = readTray(world);
  const rec = findOrCreateRecord(world, sceneId, records, now);
  const existing = rec.roster.find((r) => r.id === id && r.kind === kind);
  if (existing) {
    existing.n = kind === "creature" ? existing.n + 1 : 1;
  } else {
    rec.roster.push({ id, n: 1, kind });
  }
  rec.updatedAt = now;
  writeTray(world, records);
  return projectPublic(rec);
}

/**
 * Full splice removal — never a decrement. Idempotent: removing an
 * already-absent row (or a row for a scene with no tray record at all) is a
 * safe no-op, matching scene-elements.mjs's removeElement's own idempotent
 * convention.
 * @returns {{roster:object[], xpBudget:number|null}}
 */
export function removeFromSceneTray(world, sceneId, kind, id) {
  const records = readTray(world);
  const rec = findRecord(records, sceneId);
  if (!rec) return projectPublic(null);
  rec.roster = rec.roster.filter((r) => !(r.id === id && r.kind === kind));
  writeTray(world, records);
  return projectPublic(rec);
}

/**
 * Persists a GM-set XP budget number. No server-side XP computation happens
 * anywhere in this project — this store just persists whatever number a GM
 * sets; the CR->XP arithmetic and the meter's "N / budget xp" composition
 * are entirely client-side (§7's locked decision).
 * @returns {{roster:object[], xpBudget:number|null}}
 */
export function setSceneTrayXpBudget(world, sceneId, xpBudget, opts = {}) {
  // QA W2 fix (Group B #11): a negative number or a plain string (e.g.
  // "lots") used to round-trip silently -- this store just persisted
  // whatever value it was handed, with zero validation. `null`/`undefined`
  // still explicitly clears the budget; everything else must be a finite
  // number >= 0.
  if (xpBudget !== null && xpBudget !== undefined) {
    if (typeof xpBudget !== "number" || !Number.isFinite(xpBudget) || xpBudget < 0) {
      throw new Error(`Invalid xpBudget: must be a finite number >= 0, or null to clear (got ${JSON.stringify(xpBudget)})`);
    }
  }
  const now = opts.now ?? new Date().toISOString();
  const records = readTray(world);
  const rec = findOrCreateRecord(world, sceneId, records, now);
  rec.xpBudget = xpBudget ?? null;
  rec.updatedAt = now;
  writeTray(world, records);
  return projectPublic(rec);
}

/**
 * Phase 36 task 36.2, §3 -- every raw tray record for `world` (full shape,
 * including `sceneId`/`roster`, not the projected `{roster,xpBudget}` shape
 * `getSceneTray` returns). Backs two call sites: the stagecraft-accept
 * fan-out touch (scan every scene's roster for a just-accepted assetId,
 * server.mjs) and the flush composer's own roster reads
 * (wf-mcp-server/lib/foundry-push-ops.mjs uses `getSceneTray` per-scene
 * instead, but this whole-world enumeration is what the fan-out needs and
 * nothing else in this store previously exposed).
 * @param {string} world
 * @returns {object[]}
 */
export function listSceneTrayRecordsForWorld(world) {
  return readTray(world);
}

export { ConcurrentWriteError };
