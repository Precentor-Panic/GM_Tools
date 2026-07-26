/**
 * Global user settings store — Phase 8 task 8.3. Follows human-review.mjs's
 * established convention exactly: a single flat JSON file, an
 * env-overridable root, withLock-protected writes (reusing
 * review-state.mjs's exported withLock rather than a second file-locking
 * implementation).
 *
 * Deliberately GLOBAL, not per-world — this is a standing personal setting
 * ("flipped maybe twice a year, tied to why the GM is working," per the
 * design doc's GM-requirements section), not a per-import toggle and not
 * scoped to any one campaign. Default root is GM_Tools/user-settings/
 * (sibling to review-state/, human-review/, pending-resolution/); override
 * with GM_TOOLS_USER_SETTINGS_DIR (tests use this for isolation, same
 * pattern as every sibling store — Phase 4's self-review found this bit the
 * project once already by skipping it, so it's non-negotiable here).
 *
 * Kept deliberately minimal per task 8.3's own instruction: this is a
 * single global toggle for this phase, not a general settings framework —
 * don't speculatively build a key-value store abstraction beyond what's
 * needed. If a second global setting is ever needed, extend the stored
 * shape additively (matching the schema-versioning discipline every other
 * persisted format in this project follows) rather than generalizing this
 * module ahead of that actual need.
 *
 * THE READ-ONCE INVARIANT (Phase 8's most important correctness property,
 * called out explicitly in the phase task file): getUserSettings() is meant
 * to be called exactly ONCE, at writeup-submission time, by the 8.4
 * tool/route handler — never from inside graph-import/writeup-import.mjs
 * itself (which stays free of any global-settings dependency, matching its
 * existing pure-function style), and never again after a batch has been
 * created. The read result gets snapshotted onto batch.scope.rubberDuck at
 * that moment; every later action against that batch must read the BATCH's
 * own stamped snapshot, not call getUserSettings() again — so a mid-review
 * toggle flip can't retroactively change an in-flight batch's behavior.
 * This module has no way to enforce that on its own (it's just a settings
 * store) — see mutation-ops.mjs / wf-mcp-server/index.mjs / review-ui/
 * server.mjs for where the invariant is actually upheld, and the phase's
 * closing self-review remediation pass for confirmation no other call site
 * re-reads it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock, ConcurrentWriteError } from "./review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "user-settings");
const SETTINGS_FILE_NAME = "settings.json";

export function userSettingsRoot() {
  return process.env.GM_TOOLS_USER_SETTINGS_DIR || DEFAULT_ROOT;
}

function settingsFilePath() {
  return join(userSettingsRoot(), SETTINGS_FILE_NAME);
}

function defaultSettings() {
  return { rubberDuckMode: { enabled: false, updatedAt: null } };
}

/**
 * Read the current global settings. Never throws for "no file yet" — an
 * absent file means every default, same as human-review.mjs's "untracked
 * entity defaults to never-reviewed" convention.
 *
 * @returns {{rubberDuckMode: {enabled: boolean, updatedAt: string|null}}}
 */
export function getUserSettings() {
  const filePath = settingsFilePath();
  if (!existsSync(filePath)) return defaultSettings();
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  // Shallow-merge onto the default shape so a partially-written or
  // older-shaped file (before a future additive field lands) still reads
  // back with every key present, matching StoredMutation-adjacent modules'
  // own "don't let a caller see undefined for a documented field" care.
  return {
    ...defaultSettings(),
    ...parsed,
    rubberDuckMode: { ...defaultSettings().rubberDuckMode, ...(parsed.rubberDuckMode ?? {}) }
  };
}

/**
 * Set the global rubber-duck-mode toggle. withLock-protected, matching
 * every sibling store's write convention.
 *
 * @param {boolean} enabled
 * @param {object} [opts]
 * @param {string} [opts.now]  injectable ISO timestamp, for deterministic tests
 * @returns {{rubberDuckMode: {enabled: boolean, updatedAt: string}}} the full updated settings
 */
export function setRubberDuckMode(enabled, opts = {}) {
  const filePath = settingsFilePath();
  const now = opts.now ?? new Date().toISOString();
  return withLock(filePath, () => {
    mkdirSync(dirname(filePath), { recursive: true });
    const current = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) : defaultSettings();
    const updated = { ...current, rubberDuckMode: { enabled: !!enabled, updatedAt: now } };
    writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf8");
    return updated;
  });
}

export { ConcurrentWriteError };
