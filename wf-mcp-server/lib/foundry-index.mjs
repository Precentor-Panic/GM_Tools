/**
 * Foundry-index reader — Phase 32 task 32.2. Reads
 * worlds/<world>/world-fabric-foundry-index.json, the Foundry → GM_Tools
 * PULL file defined by plans/phase-32-bridge-contract.md §1 (written by the
 * Foundry-side module, task 32.1 — a SEPARATE repo, never built here).
 *
 * Contract rules this module implements directly (§Compatibility rules):
 *   1. A HIGHER `version` than this reader understands is NOT a hard
 *      failure — best-effort read of known top-level keys, log a warning.
 *      The index is read-only/informational, so a stale reader should still
 *      get a partially-useful pull rather than nothing.
 *   2. Permissive parsing — unknown fields are tolerated (zod's default
 *      non-`.strict()` behavior silently drops them), matching
 *      RawBestiaryFields/RawPartyMemberFields's own established convention.
 *   3. A MISSING index file is not an error either — readFoundryIndex
 *      returns null, never throws, matching task 32.2's own instruction
 *      ("never throw on a missing file"). A world simply hasn't had a
 *      Foundry-side reindex run yet; that's an ordinary, expected state.
 *
 * A genuinely malformed top-level shape (not JSON, or JSON that isn't even
 * loosely index-shaped) also does NOT throw — it degrades to an
 * empty-but-valid index (same reasoning as rule 1: informational file, a
 * partial/empty read beats an exception propagating into a pull route).
 * Invalid JSON syntax DOES throw (that's a real corrupt-file bug worth
 * surfacing, distinct from "a field is the wrong shape").
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { foundryIndexPath } from "./snapshot.mjs";

export const FOUNDRY_INDEX_VERSION = 1;

// Deliberately loose (z.array(z.record(z.any())), not a fully-modeled Actor/
// User/Scene shape) — the pure mappers in
// combat-planning/foundry-actor-mapper.mjs are what actually reach into an
// actor's fields, and THEY tolerate every field being absent per the
// contract's own "no mapper may assume any system.* field is present" rule.
// This schema only guards the TOP-LEVEL shape (the arrays exist and are
// arrays) — re-validating every nested field here would duplicate the
// mappers' own tolerance logic in a second place.
const FoundryIndexShape = z
  .object({
    version: z.number().optional(),
    worldId: z.string().optional(),
    exportedAt: z.string().optional(),
    actors: z.array(z.record(z.any())).optional().default([]),
    users: z.array(z.record(z.any())).optional().default([]),
    scenes: z.array(z.record(z.any())).optional().default([]),
    tokens: z.array(z.record(z.any())).optional().default([])
  })
  .passthrough();

function emptyIndex(world) {
  return { version: null, worldId: world, exportedAt: null, actors: [], users: [], scenes: [], tokens: [] };
}

/**
 * @param {string} dataDir
 * @param {string} world
 * @returns {object|null}   the parsed+validated index, or null if the file doesn't exist yet (not an error).
 * @throws {Error}          only on genuinely invalid JSON syntax.
 */
export function readFoundryIndex(dataDir, world) {
  const p = foundryIndexPath(dataDir, world);
  if (!existsSync(p)) return null;

  let raw;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    throw new Error(`world-fabric-foundry-index.json at ${p} is not valid JSON: ${err.message}`);
  }

  const result = FoundryIndexShape.safeParse(raw);
  if (!result.success) {
    // Contract §Compatibility rule 1's "never hard-fail" reasoning extended
    // to a malformed top-level shape too, not just an unknown-but-higher
    // version -- degrade to an empty, still-valid index rather than
    // throwing into a pull route.
    return emptyIndex(world);
  }

  const index = result.data;
  if (typeof index.version === "number" && index.version > FOUNDRY_INDEX_VERSION) {
    console.warn(
      `world-fabric-foundry-index.json at ${p} has version ${index.version}, newer than this reader ` +
      `understands (${FOUNDRY_INDEX_VERSION}) -- reading known top-level fields only, per the bridge contract's ` +
      `forward-compatibility rule.`
    );
  }

  return index;
}
