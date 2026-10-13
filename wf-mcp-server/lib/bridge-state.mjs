import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Where the headless bridge client (review-ui/gm-client.mjs) writes its
 * heartbeat, and how everything else reads it.
 *
 * It lives in the user's state dir, not in Foundry's world folder: the world
 * folder is Foundry's, and an exported index is no evidence of a connection
 * (an idle client and an absent one produce the same stale file). A heartbeat
 * written every few seconds by the client itself is.
 */
export const HEARTBEAT_FRESH_MS = 20000;

export function bridgeStateDir() {
  const dir = process.env.GM_TOOLS_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "gm-tools");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function bridgeStatePath(world) {
  return join(bridgeStateDir(), `bridge-${world}.json`);
}

/** The last heartbeat, or null if none was ever written / it is unreadable. */
export function readBridgeState(world) {
  const p = bridgeStatePath(world);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/** `{connected, ageMs, state}` -- connected means a fresh heartbeat that says so. */
export function bridgeLiveness(world, now = Date.now()) {
  const state = readBridgeState(world);
  if (!state?.beatAt) return { connected: false, ageMs: null, state };
  const ageMs = now - Date.parse(state.beatAt);
  // A killed client leaves a heartbeat that stays fresh for a few seconds.
  let pidAlive = true;
  try { if (state.pid) process.kill(state.pid, 0); } catch (e) { pidAlive = e.code === "EPERM"; }
  return { connected: pidAlive && state.state === "connected" && ageMs < HEARTBEAT_FRESH_MS, ageMs, state, pidAlive };
}
