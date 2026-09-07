import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Path to a world's world-fabric-snapshot.json, whether it exists yet or not (used by both the live-read path and headless-apply's standalone-file path). */
export function snapshotFilePath(dataDir, world) {
  return join(dataDir, "worlds", world, "world-fabric-snapshot.json");
}

/** Read and parse the world-fabric-snapshot.json for a given world. */
export function loadSnapshot(dataDir, world) {
  const snapPath = snapshotFilePath(dataDir, world);
  if (!existsSync(snapPath)) {
    throw new Error(
      `No World Fabric snapshot found for world "${world}" at ${snapPath}. ` +
      `Is Foundry running with that world loaded and the World Fabric module active?`
    );
  }
  return JSON.parse(readFileSync(snapPath, "utf8"));
}

export function mutationsPath(dataDir, world) {
  return join(dataDir, "worlds", world, "world-fabric-mutations.json");
}

/**
 * Phase 32 task 32.2 — path to a world's world-fabric-foundry-index.json
 * (Foundry → GM_Tools PULL file, plans/phase-32-bridge-contract.md §1).
 * Sibling helper to snapshotFilePath/mutationsPath above, same "same
 * worlds/<world>/ directory as the existing bridge" convention the contract
 * itself calls out — no new directory/resolution logic introduced.
 */
export function foundryIndexPath(dataDir, world) {
  return join(dataDir, "worlds", world, "world-fabric-foundry-index.json");
}

/**
 * Phase 32 task 32.3 — paths to a world's world-fabric-foundry-ops.json /
 * world-fabric-foundry-results.json (the GM_Tools -> Foundry PUSH channel +
 * its per-op result echo, plans/phase-32-bridge-contract.md §2/§3). Same
 * sibling-helper convention as foundryIndexPath above — same worlds/<world>/
 * directory, no new resolution logic.
 */
export function foundryOpsPath(dataDir, world) {
  return join(dataDir, "worlds", world, "world-fabric-foundry-ops.json");
}

export function foundryResultsPath(dataDir, world) {
  return join(dataDir, "worlds", world, "world-fabric-foundry-results.json");
}

/**
 * Path to a world's world-fabric-player-notes.json (Foundry → GM_Tools PULL,
 * bridge contract §4). Same worlds/<world>/ directory + resolution as the
 * other bridge files.
 */
export function playerNotesPath(dataDir, world) {
  return join(dataDir, "worlds", world, "world-fabric-player-notes.json");
}

/**
 * Read a world's player notes. Unlike loadSnapshot, an ABSENT file is NOT an
 * error — a world may simply have no player notes yet (Foundry closed, or no
 * one has written a Session Notes journal). Degrades to an empty envelope so
 * the analysis pass returns an honest zero-note result instead of throwing.
 */
export function loadPlayerNotes(dataDir, world) {
  const p = playerNotesPath(dataDir, world);
  if (!existsSync(p)) return { version: null, notes: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return { version: parsed.version ?? null, notes: Array.isArray(parsed.notes) ? parsed.notes : [] };
  } catch {
    return { version: null, notes: [] };
  }
}
