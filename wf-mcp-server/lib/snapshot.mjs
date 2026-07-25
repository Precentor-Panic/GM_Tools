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
