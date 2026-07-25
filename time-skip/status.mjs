/**
 * time-skip run status — pure, Foundry-free, unit-testable.
 *
 * Persists incremental progress for orchestrateBatch's texturing loop
 * (Phase 2 task 2.2: resumability), so a crashed/killed process can resume
 * from where it left off instead of re-running (and re-billing) already-
 * textured regions.
 *
 * File-per-batch JSON, mirroring review-state.mjs's own layout convention:
 * <statusRoot>/<world>/<batchId>.status.json. Default root is
 * GM_Tools/time-skip-status/ (sibling to time-skip/); override with
 * GM_TOOLS_TIMESKIP_STATUS_DIR (tests use this for isolation, same pattern
 * as review-state.mjs's GM_TOOLS_REVIEW_STATE_DIR).
 *
 * No lock file here (unlike review-state.mjs's withLock) -- per
 * gm-tools-conventions' "no job/queue runner" guidance, a time-skip run is a
 * single sequential loop against one batchId; a resumed run only starts
 * after the prior process has already exited or been killed, so there is no
 * scenario (by construction of how this module is used) where two live
 * processes write the same status file concurrently the way review-state.mjs's
 * lock guards against for a live-diff call racing a sync action.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "time-skip-status");

export const STATUS_SCHEMA_VERSION = 1;

export const PHASES = ["propagating", "texturing", "done"];

export function statusRoot() {
  return process.env.GM_TOOLS_TIMESKIP_STATUS_DIR || DEFAULT_ROOT;
}

function statusFilePath(world, batchId) {
  return join(statusRoot(), world, `${batchId}.status.json`);
}

/** Build a fresh status object for a brand-new run. Not yet persisted -- call saveStatus() to write it. */
export function initStatus(world, batchId) {
  const now = new Date().toISOString();
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    batchId,
    world,
    phase: "propagating",
    processedNodeIds: [],
    mutations: [],
    totalRegions: null,
    createdAt: now,
    updatedAt: now
  };
}

/** Load a batch's persisted status. Returns null if no status file exists yet (fresh run, not a resume). */
export function loadStatus(world, batchId) {
  const filePath = statusFilePath(world, batchId);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** Persist a status object, stamping updatedAt. Called after every unit of completed work, not just at the end. */
export function saveStatus(status) {
  const filePath = statusFilePath(status.world, status.batchId);
  mkdirSync(dirname(filePath), { recursive: true });
  const stamped = { ...status, updatedAt: new Date().toISOString() };
  writeFileSync(filePath, JSON.stringify(stamped, null, 2), "utf8");
  return stamped;
}
