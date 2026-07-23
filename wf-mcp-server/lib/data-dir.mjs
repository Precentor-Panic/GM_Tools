import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

/**
 * Locate the Foundry VTT data directory (the one containing "worlds/").
 * Checks, in order: explicit arg, WF_DATA_DIR env var, then OS-typical
 * install locations. Foundry servers vary a lot in where data lives
 * (native install, Docker volume, custom --dataPath), so this is a
 * best-effort guess — pass dataDir explicitly when it doesn't match.
 */
export function resolveDataDir(explicit) {
  if (explicit) return explicit;
  if (process.env.WF_DATA_DIR) return process.env.WF_DATA_DIR;

  const os = platform();
  const home = homedir();
  const candidates = os === "darwin"
    ? [join(home, "Library/Application Support/FoundryVTT/Data")]
    : os === "win32"
      ? [join(process.env.LOCALAPPDATA ?? home, "Local/FoundryVTT/Data")]
      : [
          join(home, "foundrydata/Data"),
          join(home, ".local/share/FoundryVTT/Data"),
          "/data/foundrydata/Data"
        ];

  for (const p of candidates) {
    if (existsSync(join(p, "worlds"))) return p;
  }
  return null;
}

/** List world IDs under dataDir that have an active World Fabric snapshot. */
export function listWorlds(dataDir) {
  const worldsDir = join(dataDir, "worlds");
  if (!existsSync(worldsDir)) return [];
  return readdirSync(worldsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(worldsDir, name, "world-fabric-snapshot.json")));
}
