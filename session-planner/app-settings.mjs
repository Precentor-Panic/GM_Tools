/**
 * App-settings store — Phase 34 task 34.1. Per-world flat JSON, following
 * scenes.mjs/human-review.mjs's established one-file-per-world convention
 * (NOT mutation-engine/user-settings.mjs's convention, which is deliberately
 * GLOBAL -- see that module's own header for why a standing personal
 * preference like rubber-duck mode is global. This store is the opposite:
 * per-campaign knobs -- campaign name, game system, calendar, model
 * choices, the Connection-Menu's stale threshold -- that genuinely differ
 * world to world).
 *
 * Storage: `<appSettingsRoot>/<world>.json`, a flat object matching the
 * `AppSettings` shape below (every key optional). Default root is
 * GM_Tools/app-settings/ (sibling to review-state/, human-review/,
 * user-settings/, session-scenes/); override with GM_TOOLS_APP_SETTINGS_DIR
 * (tests use this for isolation, same pattern as every sibling store).
 * Reuses mutation-engine/review-state.mjs's withLock/ConcurrentWriteError
 * rather than a second file-locking implementation.
 *
 * SCHEMA_VERSION 1: `{campaignName?, gameSystem?, calendar?, proseModel?,
 * imageModel?, staleThresholdMs?}` — strings except staleThresholdMs (a
 * non-negative number, milliseconds). Per plans/phase-34-tasks.md's own
 * scope note, only campaignName/calendar/staleThresholdMs are WIRED to any
 * UI this phase (34.2's settings panel flags proseModel/imageModel as
 * stored-not-wired in its own copy) -- this store itself doesn't know or
 * care which fields are "wired" anywhere; that's a frontend rollout
 * distinction kept entirely out of the backend, per gm-tools-conventions'
 * "front-ends are thin wrappers" symmetry applied to a store too (a store
 * shouldn't need to know its own UI's rollout state to be correct).
 *
 * PATCH semantics: patchSettings does a SHALLOW merge onto whatever's
 * already stored -- an omitted key leaves the existing stored value
 * untouched. There is no "clear this field back to unset" affordance yet
 * (same scope limit every other additive per-world store in this project
 * has had until an actual need for one showed up) -- passing a key through
 * with value `undefined` is indistinguishable from omitting it entirely
 * (zod's `.optional()` strips it the same way either way).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "app-settings");

export const SCHEMA_VERSION = 1;

export const AppSettings = z
  .object({
    campaignName: z.string().optional(),
    gameSystem: z.string().optional(),
    calendar: z.string().optional(),
    proseModel: z.string().optional(),
    imageModel: z.string().optional(),
    staleThresholdMs: z.number().nonnegative().optional()
  })
  .strict();

export function appSettingsRoot() {
  return process.env.GM_TOOLS_APP_SETTINGS_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return join(appSettingsRoot(), `${world}.json`);
}

/**
 * Read a world's settings. Never throws for "no file yet" -- an absent
 * file means every field is simply absent (`{}`), matching
 * human-review.mjs's "untracked entity defaults to nothing tracked" convention.
 *
 * @param {string} world
 * @returns {object}  a validated (possibly empty) AppSettings object
 */
export function getSettings(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) return {};
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  // Passthrough-free: an unrecognized stored key (e.g. from a future field
  // this reader predates) is dropped by AppSettings' .strict() parse rather
  // than thrown -- match with .catch would be more permissive, but this
  // store has no forward-compat requirement analogous to foundry-index.mjs's
  // (nothing external writes this file), so a strict parse of our own
  // previously-written shape is the simpler, safer default.
  return AppSettings.parse(raw);
}

/**
 * Shallow-patch a world's settings — only the keys present in `patch` are
 * changed; every other previously-stored key is left untouched.
 * withLock-protected read-modify-write, same convention as every sibling
 * store's own writer.
 *
 * @param {string} world
 * @param {object} patch  a subset of AppSettings' own fields
 * @returns {object} the full updated settings object
 */
export function patchSettings(world, patch) {
  const filePath = worldFilePath(world);
  const validPatch = AppSettings.parse(patch ?? {});
  return withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    const current = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) : {};
    const updated = AppSettings.parse({ ...current, ...validPatch });
    writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf8");
    return updated;
  });
}

export { ConcurrentWriteError };
