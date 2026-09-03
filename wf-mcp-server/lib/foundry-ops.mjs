/**
 * Foundry-ops writer — Phase 32 task 32.3 (the thin PUSH slice's transport
 * layer). Writes worlds/<world>/world-fabric-foundry-ops.json (GM_Tools ->
 * Foundry PUSH file, plans/phase-32-bridge-contract.md §2) and polls
 * worlds/<world>/world-fabric-foundry-results.json (§3) for the matching,
 * opId-correlated results — mirroring wf-mcp-server/lib/mutation-ops.mjs's
 * applyMutationsToFoundry (write-then-poll-for-"[]", :109-129) but split
 * across two files instead of one: the ops file signals "processed" by
 * going back to "[]" (same "overwrite empty, can't delete" mechanic as
 * world-fabric-mutations.json), while the ACTUAL payload GM_Tools needs
 * (the created doc's UUID) lives in the separate results file, read once the
 * ops file clears.
 *
 * Concurrency safety (gm-tools-conventions.md): before writing a new ops
 * batch, refuse to clobber a still-in-flight prior one — an ops file that
 * exists and is neither absent nor "[]" means a previous push hasn't been
 * picked up (or fully applied) by the Foundry-side watcher yet. This is a
 * real gap `mutation-ops.mjs`'s own applyMutationsToFoundry doesn't guard
 * against (it blindly overwrites world-fabric-mutations.json) — added here
 * per the phase-32 task's own explicit instruction, not copied verbatim.
 *
 * Consumer-side clearing (§3): once this module has read a batch's results
 * (correlated by opId), it overwrites world-fabric-foundry-results.json
 * back to "[]" — GM_Tools is the CONSUMER of that file (the direction is
 * reversed from the ops file, where GM_Tools is the producer).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { foundryOpsPath, foundryResultsPath } from "./snapshot.mjs";

// Tracked here + in plans/phase-32-bridge-contract.md's own doc-comment
// convention, NOT as an in-file field — see that contract's "Shape decision"
// section for why ops/results deliberately carry no in-file version (they
// must stay bare, Array.isArray()-checkable arrays).
export const FOUNDRY_OPS_SCHEMA_VERSION = 1;
export const FOUNDRY_RESULTS_SCHEMA_VERSION = 1;

/**
 * Thrown by writeFoundryOps when a prior ops batch is still mid-flight (the
 * ops file exists and isn't cleared to "[]"/absent yet). Mapped to 409 by
 * review-ui/server.mjs's statusForError, same convention as
 * review-state.mjs's ConcurrentWriteError.
 */
export class FoundryOpsInFlightError extends Error {
  constructor(message) {
    super(message);
    this.name = "FoundryOpsInFlightError";
  }
}

function readJsonArray(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

/** `op_<ts>_<rand>`, matching the contract fixture's own convention (foundry-ops.create-scene.sample.json). Injectable now/rand for deterministic tests. */
export function makeOpId(opts = {}) {
  const now = opts.now ?? Date.now();
  const rand = opts.rand ?? Math.random().toString(36).slice(2, 8);
  return `op_${now}_${rand}`;
}

/** Sync write step, concurrency-checked. Not exported as part of the public API — writeFoundryOps below is the one documented deliverable, this is its internal helper. */
function writeOpsFileChecked(dir, world, ops) {
  const path = foundryOpsPath(dir, world);
  if (existsSync(path)) {
    const contents = readFileSync(path, "utf8").trim();
    if (contents !== "" && contents !== "[]") {
      throw new FoundryOpsInFlightError(
        `world-fabric-foundry-ops.json for world "${world}" is not empty/"[]" -- a prior push batch may still be ` +
        `mid-flight (the Foundry-side watcher hasn't applied+cleared it yet). Refusing to overwrite it; wait for ` +
        `the prior batch to clear, or investigate a stuck watcher, before pushing a new one.`
      );
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ops, null, 2), "utf8");
  return path;
}

/**
 * Write an ops batch to the file bridge, then poll briefly for the
 * Foundry-side watcher to apply + clear it back to "[]" (mirrors
 * mutation-ops.mjs's applyMutationsToFoundry poll convention exactly,
 * including "the file went missing mid-poll" being treated as inconclusive
 * -> queued, not applied). Once cleared, reads world-fabric-foundry-
 * results.json, keeps only the entries whose `opId` belongs to THIS batch
 * (§3's "only ever treat results as new if their opId matches an
 * outstanding op it's currently waiting on"), clears the results file back
 * to "[]", and returns them.
 *
 * @param {string} dir
 * @param {string} world
 * @param {object[]} ops   [{opId, kind, data}, ...] — plans/phase-32-bridge-contract.md §2
 * @param {object} [opts]
 * @param {number} [opts.pollMs]      poll interval, default 500 (mirrors mutation-ops.mjs's own hardcoded interval)
 * @param {number} [opts.timeoutMs]   total poll budget, default 7000 (mirrors mutation-ops.mjs's 7s)
 * @returns {Promise<
 *   {status:'applied', results:object[], opsPath:string, resultsPath:string} |
 *   {status:'queued', opsPath:string, resultsPath:string, note:string}
 * >}
 */
export async function writeFoundryOps(dir, world, ops, opts = {}) {
  const pollMs = opts.pollMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 7000;

  const opsPath = writeOpsFileChecked(dir, world, ops);
  const resultsPath = foundryResultsPath(dir, world);
  const opIds = new Set(ops.map((o) => o.opId));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (!existsSync(opsPath)) break; // inconclusive, same as mutation-ops.mjs -- falls through to 'queued' below
    const contents = readFileSync(opsPath, "utf8").trim();
    if (contents === "[]") {
      const allResults = readJsonArray(resultsPath);
      const results = allResults.filter((r) => opIds.has(r.opId));
      // Consumer-side clear, §3 — but only of THIS batch's own results
      // (G12, Aureus table wave): the old unconditional `"[]"` write
      // destroyed a sibling producer's late results (scene push, item
      // push and compendium import all share this transport, correlated
      // by opId and reconciled from pending ledgers). The contract
      // already frames GM_Tools as consuming *recognized* opIds; this
      // aligns the code with it.
      const survivors = allResults.filter((r) => !opIds.has(r.opId));
      writeFileSync(resultsPath, survivors.length ? JSON.stringify(survivors, null, 2) : "[]", "utf8");
      return { status: "applied", results, opsPath, resultsPath };
    }
  }

  return {
    status: "queued",
    opsPath,
    resultsPath,
    note:
      "Not confirmed applied within the poll window -- check that a Foundry client has this world open with the " +
      "World Fabric Foundry-ops watcher active."
  };
}
