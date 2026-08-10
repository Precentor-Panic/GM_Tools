/**
 * World-clock store — Phase 37 task 37.1 (Chronicle). Per-world flat JSON,
 * following session-planner/app-settings.mjs's exact one-file-per-world/
 * withLock convention. Storage: `<worldClockRoot>/<world>.json`; override
 * with GM_TOOLS_WORLD_CLOCK_DIR (tests use this for isolation, same pattern
 * as every sibling store). SCHEMA_VERSION 1.
 *
 * PERSISTED shape: `{currentDate: string, sessionNumber: number, updatedAt:
 * string}` — deliberately does NOT persist `calendar`. Per
 * review-ui/test/e2e/phase37-fixture.mjs §1 (the pinned contract this module
 * implements verbatim): `calendar` is ALWAYS sourced from the EXISTING
 * session-planner/app-settings.mjs store's own `calendar` field, composed at
 * READ time by getWorldClock() — there is no setCalendar here, and changing
 * the calendar identity stays exactly where it already is today (POST
 * /api/settings {world, calendar}, app-settings.mjs's patchSettings,
 * unmodified). This is the FIRST single-source rule the fixture pins: exactly
 * one store owns calendar text, exactly one route can change it.
 *
 * `currentDate` is a plain, GM-legible, generic v1 fallback string derived
 * from an internal day-count ("Day N") — NOT a real fantasy calendar engine.
 * app-settings' own `calendar` field is a free descriptive string, not a
 * structured month/day/season definition, and there is no calendar-math
 * engine anywhere in this codebase to turn "+90 days" into a real fantasy
 * date string — building one is explicitly out of scope for Phase 37 (a real
 * future enhancement, same "noted-not-adopted" posture as
 * "everywhere-except-party" scope). parseDayCount/renderCurrentDate own this
 * parse/render pair privately (module-private, not exported) so a future
 * real calendar formatter has exactly one place to swap in a richer one
 * without touching any caller.
 *
 * THE elapsedSessions SINGLE-SOURCE RULE (fixture §2): advanceWorldClock is
 * the ONLY function in this codebase permitted to compute a "how many
 * sessions did this span represent" number — SPAN_DAYS/spanToElapsedSessions
 * live ONLY here; nothing else may define a second such table or inline
 * formula. advanceWorldClock's own return `elapsedSessions` is THIS CALL's
 * per-advance delta (e.g. 13 for a season/91-day advance), NEVER the
 * cumulative `sessionNumber` running total — feeding a monotonically-growing
 * cumulative total into mutation-engine/propagate.mjs's ambientDecay
 * half-life formula would decay every field toward zero more and more
 * aggressively on every subsequent Chronicle run regardless of how much real
 * time that specific run represents (a correctness bug, not a style choice —
 * see the fixture's own "WHY THE DELTA, NOT THE CUMULATIVE TOTAL" paragraph).
 *
 * Concurrency: ONE withLock-protected read-modify-write per advance (same
 * discipline as every sibling store) — currentDate and sessionNumber are
 * always updated together, in a single write, so no caller ever observes a
 * half-applied state via a second GET.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withLock, ConcurrentWriteError } from "../mutation-engine/review-state.mjs";
import { getSettings } from "./app-settings.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, "..", "world-clock");

export const SCHEMA_VERSION = 1;

// THE canonical span table — copied verbatim from Chronicle.dc.html's own
// seeded SPANS array (review-ui/test/e2e/phase37-fixture.mjs duplicates this
// ONLY for test-side expectation building; this is the one production
// source, per the single-source rule above). "long" = "a generation" = 22
// years x 365, matching the prototype's own "Twenty-two years on" headline
// text for spanId 'long' verbatim.
export const SPAN_DAYS = { week: 7, month: 30, season: 91, year: 365, long: 8030 };

/**
 * THE ONE canonical, deterministic days-to-decay-basis conversion. Floor of
 * 1 matches scope.mjs's own `elapsedSessions ?? 1` default — an advance must
 * always represent at least *some* passage for the decay math, never 0.
 */
export function spanToElapsedSessions(days) {
  return Math.max(1, Math.round(days / 7));
}

const WorldClockRecord = z
  .object({
    currentDate: z.string(),
    sessionNumber: z.number().int().nonnegative(),
    updatedAt: z.string()
  })
  .strict();

export function worldClockRoot() {
  return process.env.GM_TOOLS_WORLD_CLOCK_DIR || DEFAULT_ROOT;
}

function worldFilePath(world) {
  return join(worldClockRoot(), `${world}.json`);
}

/** A brand-new world's default clock record — no advance has happened yet. */
function defaultRecord() {
  return { currentDate: "Day 0", sessionNumber: 0, updatedAt: null };
}

function readRecord(world) {
  const filePath = worldFilePath(world);
  if (!existsSync(filePath)) return defaultRecord();
  return WorldClockRecord.parse(JSON.parse(readFileSync(filePath, "utf8")));
}

function parseDayCount(currentDate) {
  const m = /^Day (\d+)$/.exec(currentDate ?? "");
  return m ? Number(m[1]) : 0;
}

function renderCurrentDate(dayCount) {
  return `Day ${dayCount}`;
}

/**
 * Read a world's clock, composing `calendar` from app-settings.mjs at READ
 * time (§1's single-source pin — never a separate stored copy).
 * @param {string} world
 * @returns {{world:string, calendar:string|null, currentDate:string, sessionNumber:number, updatedAt:string|null}}
 */
export function getWorldClock(world) {
  const record = readRecord(world);
  const calendar = getSettings(world).calendar ?? null;
  return { world, calendar, ...record };
}

/**
 * advanceWorldClock(world, span) — world-clock.mjs's ONE write function.
 * `span` is EXACTLY ONE of two shapes (never both, never neither — fail
 * fast, per the no-silent-auto-write project's general "fail loud, don't
 * guess" posture): `{days: number}` (explicit) or `{spanId: "week"|"month"|
 * "season"|"year"|"long"}` (named, resolved via SPAN_DAYS).
 *
 * ONE call atomically (single withLock-protected read-modify-write):
 *  (a) resolves days = span.days ?? SPAN_DAYS[span.spanId];
 *  (b) computes elapsedSessions = spanToElapsedSessions(days) — THIS call's
 *      own per-advance delta;
 *  (c) advances currentDate by `days` (day-count scheme, §1);
 *  (d) sets sessionNumber = sessionNumber + elapsedSessions (the cumulative
 *      running total — a history/display statistic only, read by the
 *      chronicle-log's history rail and NOWHERE ELSE — never fed back into
 *      the decay math, see this module's own top-of-file doc comment);
 *  (e) persists once, stamps updatedAt.
 *
 * @param {string} world
 * @param {{days?:number, spanId?:string}} span
 * @returns {{world, calendar, currentDate, sessionNumber, elapsedSessions, spanDays, updatedAt}}
 *   `elapsedSessions` here is THIS CALL's own per-advance delta, NOT the
 *   cumulative `sessionNumber` total.
 */
export function advanceWorldClock(world, span) {
  const hasDays = span != null && typeof span.days === "number";
  const hasSpanId = span != null && typeof span.spanId === "string";
  if (hasDays && hasSpanId) {
    throw new Error("advanceWorldClock: span must be EXACTLY ONE of {days} or {spanId}, never both.");
  }
  if (!hasDays && !hasSpanId) {
    throw new Error(
      `advanceWorldClock: span must be one of {days:number} or {spanId:${Object.keys(SPAN_DAYS)
        .map((id) => `'${id}'`)
        .join("|")}}.`
    );
  }
  if (hasSpanId && !(span.spanId in SPAN_DAYS)) {
    throw new Error(`advanceWorldClock: unknown spanId "${span.spanId}" (expected one of ${Object.keys(SPAN_DAYS).join(", ")}).`);
  }

  const days = hasDays ? span.days : SPAN_DAYS[span.spanId];
  const elapsedSessions = spanToElapsedSessions(days);

  const filePath = worldFilePath(world);
  const updated = withLock(filePath, () => {
    const current = existsSync(filePath)
      ? WorldClockRecord.parse(JSON.parse(readFileSync(filePath, "utf8")))
      : defaultRecord();
    const record = WorldClockRecord.parse({
      currentDate: renderCurrentDate(parseDayCount(current.currentDate) + days),
      sessionNumber: current.sessionNumber + elapsedSessions,
      updatedAt: new Date().toISOString()
    });
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
    return record;
  });

  const calendar = getSettings(world).calendar ?? null;
  return {
    world,
    calendar,
    currentDate: updated.currentDate,
    sessionNumber: updated.sessionNumber,
    elapsedSessions,
    spanDays: days,
    updatedAt: updated.updatedAt
  };
}

export { ConcurrentWriteError };
