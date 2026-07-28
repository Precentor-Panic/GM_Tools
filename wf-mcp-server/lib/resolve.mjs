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

// Same format POST /api/worlds (review-ui/server.mjs) has always required
// for a NEWLY CREATED world id -- applied here too, centrally, so it also
// covers every other route that resolves an EXISTING world by name. Found
// via a real security review: this value gets join()'d directly into a file
// path in all seven of this project's flat-JSON stores plus the snapshot/
// mutations-bridge paths (review-state.mjs, entity-narration.mjs,
// human-review.mjs, pending-ledger.mjs, prep-content.mjs, manual-undo.mjs,
// user-settings.mjs, snapshot.mjs) -- node:path's join() does not stop `..`
// traversal, so an unvalidated world string from an unauthenticated HTTP
// request (review-ui/server.mjs has no auth layer -- see its own top-of-file
// comment) was a real arbitrary-file-path primitive, not just "pick the
// wrong campaign." Every legitimate world id in this project has always
// been a simple slug (wf-test, rl-combat, etc.), so this is not expected to
// reject anything real.
const VALID_WORLD_ID = /^[a-zA-Z0-9_-]+$/;

export function resolveWorld(world) {
  const resolved = world ?? process.env.WF_DEFAULT_WORLD;
  if (!resolved) {
    throw new Error(
      "No world specified and WF_DEFAULT_WORLD is not set. Call wf_list_worlds (or GET /api/worlds) to see " +
      "available worlds, then pass one explicitly."
    );
  }
  if (!VALID_WORLD_ID.test(resolved)) {
    throw new Error(
      `Invalid world id "${resolved}" -- only letters, digits, hyphens, and underscores are allowed.`
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
