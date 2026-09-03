/**
 * Foundry orphan-scene ledger — the stale-scene sweep's memory.
 *
 * Why it exists (Aureus table wave B1/G1): `deleteScene` destroys the scene
 * record INCLUDING its `foundrySceneRef`, so once a GM_Tools scene that was
 * pushed to Foundry is deleted here, nothing remembers that a Foundry Scene
 * document still exists over there. This ledger captures that ref AT DELETE
 * TIME (deleteSceneEverywhere, wf-mcp-server/lib/foundry-push-ops.mjs) so
 * the stale-scene sweep can later offer — never perform unprompted — its
 * removal. Unstaged-but-still-pushed scenes need no ledger (they're
 * computable live: foundrySceneRef && !stagedForFoundry).
 *
 * SAFETY: rows only ever carry a `foundrySceneRef` that GM_Tools itself
 * wrote on a confirmed push — this ledger can never introduce a uuid the
 * push pipeline didn't create, which is half of the delete_scene safety
 * story (the other half: the module creator refuses non-Scene uuids).
 *
 * Flat one-file-per-world JSON (human-review.mjs's convention), withLock
 * from review-state.mjs, env override GM_TOOLS_FOUNDRY_ORPHANS_DIR for
 * test isolation. Rows are removed when the sweep confirms deletion (or
 * the GM dismisses one) — this is a work queue, not a history store.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "foundry-orphans");

export const SCHEMA_VERSION = 1;

export const OrphanRow = z.object({
  id: z.string(),
  sceneId: z.string(),
  name: z.string(),
  foundrySceneRef: z.string(),
  orphanedAt: z.string()
}).strict();

export function foundryOrphansRoot() {
  return process.env.GM_TOOLS_FOUNDRY_ORPHANS_DIR || DEFAULT_ROOT;
}

function filePath(world) {
  return join(foundryOrphansRoot(), `${world}.json`);
}

export function makeOrphanId() {
  return `orph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function listOrphans(world) {
  const p = filePath(world);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf8"));
}

function writeRows(world, rows) {
  const validated = rows.map((r) => OrphanRow.parse(r));
  const p = filePath(world);
  withLock(p, () => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(validated, null, 2), "utf8");
  });
  return validated;
}

/** Record a deleted-here-but-still-in-Foundry scene. Dedupes on foundrySceneRef (a re-delete of a re-pushed scene never doubles the row). */
export function recordOrphan(world, { sceneId, name, foundrySceneRef }, opts = {}) {
  if (!foundrySceneRef) throw new Error("recordOrphan: foundrySceneRef is required — a scene with no ref has nothing in Foundry to orphan.");
  const rows = listOrphans(world);
  if (rows.some((r) => r.foundrySceneRef === foundrySceneRef)) return rows;
  const row = {
    id: (opts.makeId ?? makeOrphanId)(),
    sceneId,
    name: name ?? "(unnamed scene)",
    foundrySceneRef,
    orphanedAt: opts.now ?? new Date().toISOString()
  };
  return writeRows(world, [...rows, row]);
}

/** Remove one ledger row (the sweep confirmed the Foundry deletion, or the GM dismissed it). Safe no-op for an unknown id. */
export function clearOrphan(world, orphanId) {
  const rows = listOrphans(world);
  const kept = rows.filter((r) => r.id !== orphanId);
  if (kept.length === rows.length) return rows;
  return writeRows(world, kept);
}

export { ConcurrentWriteError };
