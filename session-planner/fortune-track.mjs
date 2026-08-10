/**
 * Fortune-track store — Phase 37 task 37.1 (Chronicle). ONE GLOBAL track per
 * world (not per-branch — per-branch fortune is the explicitly noted-future
 * flag, see plans/phase-37-tasks.md's own "Settled decisions"). Per-world
 * flat JSON, `<fortuneRoot>/<world>.json` (GM_TOOLS_FORTUNE_DIR), following
 * session-planner/app-settings.mjs's exact one-file-per-world/withLock
 * convention. SCHEMA_VERSION 1.
 *
 * PERSISTED shape: `{stopId: FortuneStopId, updatedAt: string}`. FIVE
 * ordered, discrete stops (no continuous slider), taken verbatim from
 * Chronicle.dc.html's own seeded FORTUNES array — see
 * review-ui/test/e2e/phase37-fixture.mjs §3 for the pinned FORTUNE_STOPS
 * table this module implements exactly. `bias` (integer, -2..2 inclusive) is
 * a NEW, task-37.0-added convenience derivation not present in the
 * prototype's own seed data (which only ever needed a discrete id for its
 * own display) — added so 37.1's texture-prompt plumbing has a ready-made
 * numeric knob without inventing its own id-to-number mapping. `middling`
 * (bias 0) is the default for a world with no fortune record yet, matching
 * the prototype's own initial `state.fortune: "middling"`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "fortune-track");

export const SCHEMA_VERSION = 1;

export const FORTUNE_STOPS = [
  { stopId: "bountiful", label: "Bountiful", bias: 2 },
  { stopId: "fair", label: "Fair", bias: 1 },
  { stopId: "middling", label: "Middling", bias: 0 },
  { stopId: "lean", label: "Lean", bias: -1 },
  { stopId: "ruinous", label: "Ruinous", bias: -2 }
];

const FORTUNE_STOP_IDS = FORTUNE_STOPS.map((f) => f.stopId);
const DEFAULT_STOP_ID = "middling";

const FortuneRecord = z
  .object({
    stopId: z.enum(FORTUNE_STOP_IDS),
    updatedAt: z.string()
  })
  .strict();

export function fortuneRoot() {
  return process.env.GM_TOOLS_FORTUNE_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return join(fortuneRoot(), `${world}.json`);
}

function stopById(stopId) {
  return FORTUNE_STOPS.find((f) => f.stopId === stopId);
}

/**
 * Read a world's fortune. Defaults to 'middling'/bias 0 for a world with no
 * record yet — matches the prototype's own initial state, never an error.
 * @param {string} world
 * @returns {{world, stopId, bias, updatedAt: string|null}}
 */
export function getFortune(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) {
    return { world, stopId: DEFAULT_STOP_ID, bias: stopById(DEFAULT_STOP_ID).bias, updatedAt: null };
  }
  const record = FortuneRecord.parse(JSON.parse(readFileSync(filePath, "utf8")));
  return { world, stopId: record.stopId, bias: stopById(record.stopId).bias, updatedAt: record.updatedAt };
}

/**
 * Set a world's fortune stop. Rejects an unknown stopId outright (throws —
 * a real caller error, NEVER a silent fallback to middling).
 * @param {string} world
 * @param {string} stopId
 * @returns {{world, stopId, bias, updatedAt}}
 */
export function setFortune(world, stopId) {
  const stop = stopById(stopId);
  if (!stop) {
    throw new Error(`Unknown fortune stopId "${stopId}" (expected one of ${FORTUNE_STOP_IDS.join(", ")}).`);
  }
  const filePath = worldFilePath(world);
  const record = withLock(filePath, () => {
    const validated = FortuneRecord.parse({ stopId, updatedAt: new Date().toISOString() });
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(validated, null, 2), "utf8");
    return validated;
  });
  return { world, stopId: record.stopId, bias: stop.bias, updatedAt: record.updatedAt };
}

export { ConcurrentWriteError };
