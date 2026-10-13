/**
 * Campaign home — where a world's campaign data lives.
 *
 * A campaign is its own git repo, separate from this one. When a world is
 * registered here, its campaign stores (plans, scenes, elements, notes, map
 * assets, review history, ...) are read and written under
 * `<campaignDir>/data/`, so the campaign repo tracks them. A world that is not
 * registered keeps the legacy layout: one folder per store inside the GM_Tools
 * checkout, gitignored.
 *
 * This module only resolves paths. It never commits: the GM commits the
 * campaign repo on demand.
 *
 * Registry, first match wins:
 *   1. `GM_TOOLS_CAMPAIGNS` env — `world=/abs/dir;other=/abs/dir`. Set but
 *      empty means "no campaigns".
 *   2. `<config>/gm-tools/campaigns.json` — `{ "<world>": "/abs/dir" }`, where
 *      <config> is `XDG_CONFIG_HOME` or `~/.config`. A file rather than only an
 *      env var because the app server, the CLI tools, the MCP server and
 *      campaign scripts are separate processes that must all agree on where a
 *      world's data is.
 * Under `node --test` the file is ignored (only the env var counts), so a test
 * run can never reach a real campaign repo.
 *
 * Per-store precedence (`campaignStoreFile` / `campaignStoreDir`):
 *   1. the store's own `GM_TOOLS_<X>_DIR` override, legacy layout under it
 *      (tests use this for isolation);
 *   2. the campaign repo: `<campaignDir>/data/<store>.json` or
 *      `<campaignDir>/data/<store>/`;
 *   3. the legacy root: `<legacyRoot>/<world>.json` or `<legacyRoot>/<world>/`.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";

export const CAMPAIGN_DATA_DIRNAME = "data";

/**
 * The stores that are campaign data, by name. A store's name is both its
 * legacy folder inside the GM_Tools checkout and its name under
 * `<campaignDir>/data/`. `file` = one JSON file per world; `dir` = a folder
 * per world. Each store module passes its own entry to `campaignStoreFile` /
 * `campaignStoreDir`; this list is what `bin/campaign-adopt` walks.
 *
 * Not here on purpose: machine state (push lock, sync log, orphan ledger,
 * undo slots, time-skip status, tokens, app and user settings), the shared
 * bestiary and rules shelves, and narrative-state, which stays beside the
 * graph so one commit captures both.
 */
export const CAMPAIGN_STORES = Object.freeze([
  { store: "session-plans", kind: "file" },
  { store: "session-scenes", kind: "file" },
  { store: "scene-elements", kind: "file" },
  { store: "scene-tray", kind: "file" },
  { store: "scene-narration", kind: "dir" },
  { store: "session-notes", kind: "file" },
  { store: "truth-notes", kind: "dir" },
  { store: "player-notes-analysis", kind: "file" },
  { store: "briefing", kind: "file" },
  { store: "stagecraft", kind: "file" },
  { store: "party-roster", kind: "file" },
  { store: "items", kind: "file" },
  { store: "saved-encounters", kind: "file" },
  { store: "world-clock", kind: "file" },
  { store: "fortune-track", kind: "file" },
  { store: "chronicle-run", kind: "dir" },
  { store: "entity-narration", kind: "dir" },
  { store: "prep-content", kind: "dir" },
  { store: "pending-resolution", kind: "dir" },
  { store: "human-review", kind: "file" },
  { store: "review-state", kind: "dir" }
]);

export function campaignRegistryPath() {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(config, "gm-tools", "campaigns.json");
}

function parseEnvRegistry(text) {
  const out = {};
  for (const pair of text.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const world = pair.slice(0, eq).trim();
    const dir = pair.slice(eq + 1).trim();
    if (world && dir) out[world] = dir;
  }
  return out;
}

// The registry file is read on every path resolution; cache it by mtime.
let fileCache = { path: null, mtimeMs: null, registry: {} };

function readFileRegistry() {
  const path = campaignRegistryPath();
  let mtimeMs;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return {}; }
  if (fileCache.path === path && fileCache.mtimeMs === mtimeMs) return fileCache.registry;
  let registry = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [world, dir] of Object.entries(parsed)) {
        if (typeof dir === "string" && dir) registry[world] = dir;
      }
    }
  } catch { registry = {}; }
  fileCache = { path, mtimeMs, registry };
  return registry;
}

/** Every registered campaign: `{ world: absoluteDir }`. */
export function listCampaigns() {
  const env = process.env.GM_TOOLS_CAMPAIGNS;
  const raw = env !== undefined
    ? parseEnvRegistry(env)
    : (process.env.NODE_TEST_CONTEXT ? {} : readFileRegistry());
  const out = {};
  for (const [world, dir] of Object.entries(raw)) {
    if (isAbsolute(dir)) out[world] = dir;
  }
  return out;
}

/** The campaign repo folder for a world, or null when the world has none (or the folder is missing). */
export function campaignDir(world) {
  const dir = listCampaigns()[world];
  return dir && existsSync(dir) ? dir : null;
}

/** `<campaignDir>/data`, or null. */
export function campaignDataDir(world) {
  const dir = campaignDir(world);
  return dir ? join(dir, CAMPAIGN_DATA_DIRNAME) : null;
}

/**
 * Path of a one-file-per-world store.
 * @param {string} world
 * @param {{store: string, envVar?: string, legacyRoot: string}} spec
 */
export function campaignStoreFile(world, { store, envVar, legacyRoot }) {
  const override = envVar ? process.env[envVar] : undefined;
  if (override) return join(override, `${world}.json`);
  const data = campaignDataDir(world);
  if (data) return join(data, `${store}.json`);
  return join(legacyRoot, `${world}.json`);
}

/**
 * Path of a folder-per-world store (one file per batch, entity, scene, ...).
 * @param {string} world
 * @param {{store: string, envVar?: string, legacyRoot: string}} spec
 */
export function campaignStoreDir(world, { store, envVar, legacyRoot }) {
  const override = envVar ? process.env[envVar] : undefined;
  if (override) return join(override, world);
  const data = campaignDataDir(world);
  if (data) return join(data, store);
  return join(legacyRoot, world);
}
