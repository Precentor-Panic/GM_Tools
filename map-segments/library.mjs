// Read segments from a library folder under the Foundry Data dir (WF_DATA_DIR).
// The only fs-touching part of map-segments; assemble.mjs stays pure.
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";

export function foundryDataDir() {
  return process.env.WF_DATA_DIR || join(homedir(), "foundrydata", "Data");
}

/** A loader for assembleComposition. Refuses paths that climb out of the Data dir. */
export function segmentLoader(dataDir = foundryDataDir()) {
  const root = resolve(dataDir);
  const cache = new Map();
  return (segmentId, library) => {
    const file = resolve(root, library, segmentId, "segment.json");
    if (!file.startsWith(root + sep)) throw new Error(`segment path escapes the Data dir: ${library}/${segmentId}`);
    if (!cache.has(file)) {
      if (!existsSync(file)) throw new Error(`no segment.json for ${library}/${segmentId}`);
      cache.set(file, JSON.parse(readFileSync(file, "utf8")));
    }
    return cache.get(file);
  };
}
