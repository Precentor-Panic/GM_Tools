/**
 * World/data-dir resolution — tiny, shared by every front-end that needs to
 * turn an optional `world`/`dataDir` argument into a concrete value using
 * this project's established env-var fallbacks (WF_DEFAULT_WORLD,
 * WF_DATA_DIR/OS-typical paths via lib/data-dir.mjs's resolveDataDir).
 *
 * Extracted out of wf-mcp-server/index.mjs (Phase 6) so review-ui/server.mjs
 * can resolve the same way without a second, drifting copy of this logic —
 * both front-ends read the same env vars and should fail with the same
 * message when neither an explicit value nor an env var is set.
 */
import { resolveDataDir } from "./data-dir.mjs";

export function resolveWorld(world) {
  const resolved = world ?? process.env.WF_DEFAULT_WORLD;
  if (!resolved) {
    throw new Error(
      "No world specified and WF_DEFAULT_WORLD is not set. Call wf_list_worlds (or GET /api/worlds) to see " +
      "available worlds, then pass one explicitly."
    );
  }
  return resolved;
}

export function resolveDir(dataDir) {
  const dir = resolveDataDir(dataDir);
  if (!dir) {
    throw new Error("Could not locate the Foundry data directory. Pass dataDir explicitly or set WF_DATA_DIR.");
  }
  return dir;
}
