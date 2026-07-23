import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Read and parse the world-fabric-snapshot.json for a given world. */
export function loadSnapshot(dataDir, world) {
  const snapPath = join(dataDir, "worlds", world, "world-fabric-snapshot.json");
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
