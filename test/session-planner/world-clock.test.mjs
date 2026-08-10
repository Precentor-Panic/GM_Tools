import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — session-planner/world-clock.mjs (Phase 37 task
 * 37.1): per-world flat JSON, `{currentDate, sessionNumber, updatedAt}`,
 * `calendar` composed from app-settings.mjs at READ time, advanceWorldClock
 * as the ONE elapsedSessions-computing function in this codebase. Mirrors
 * review-ui/test/e2e/phase37-fixture.mjs §1/§2's own pinned expectations at
 * the unit level (this file exercises the library directly, no HTTP).
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-world-clock-test-"));
process.env.GM_TOOLS_WORLD_CLOCK_DIR = join(scratchDir, "world-clock");
process.env.GM_TOOLS_APP_SETTINGS_DIR = join(scratchDir, "app-settings");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state"); // transitively needed for withLock

const { getWorldClock, advanceWorldClock, worldClockRoot, SCHEMA_VERSION, SPAN_DAYS, spanToElapsedSessions } =
  await import("../../session-planner/world-clock.mjs");
const { patchSettings } = await import("../../session-planner/app-settings.mjs");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

test("SCHEMA_VERSION is exported per gm-tools-conventions' schema-versioning discipline", () => {
  assert.equal(typeof SCHEMA_VERSION, "number");
});

test("worldClockRoot() honors GM_TOOLS_WORLD_CLOCK_DIR", () => {
  assert.equal(worldClockRoot(), join(scratchDir, "world-clock"));
});

test("SPAN_DAYS matches the canonical table verbatim", () => {
  assert.deepEqual(SPAN_DAYS, { week: 7, month: 30, season: 91, year: 365, long: 8030 });
});

test("spanToElapsedSessions: floors at 1, rounds otherwise", () => {
  assert.equal(spanToElapsedSessions(7), 1);
  assert.equal(spanToElapsedSessions(1), 1); // floor of 1, never 0
  assert.equal(spanToElapsedSessions(91), 13);
  assert.equal(spanToElapsedSessions(365), 52);
});

test("getWorldClock: a brand-new world defaults to Day 0 / sessionNumber 0 / calendar null", () => {
  const clock = getWorldClock("wc-fresh-world");
  assert.equal(clock.currentDate, "Day 0");
  assert.equal(clock.sessionNumber, 0);
  assert.equal(clock.calendar, null);
  assert.equal(clock.updatedAt, null);
});

test("getWorldClock: composes `calendar` from app-settings.mjs at READ time -- never a separate stored copy", () => {
  patchSettings("wc-calendar-world", { calendar: "Harptos" });
  const clock = getWorldClock("wc-calendar-world");
  assert.equal(clock.calendar, "Harptos");
});

test("advanceWorldClock: a single {spanId:'week'} advance produces elapsedSessions=1 and Day 7", () => {
  const result = advanceWorldClock("wc-advance-a", { spanId: "week" });
  assert.equal(result.currentDate, "Day 7");
  assert.equal(result.elapsedSessions, 1);
  assert.equal(result.sessionNumber, 1);
  assert.equal(result.spanDays, 7);
});

test("advanceWorldClock: accumulates on top of a prior advance -- currentDate/sessionNumber both carry forward", () => {
  advanceWorldClock("wc-advance-b", { spanId: "week" });
  const result = advanceWorldClock("wc-advance-b", { spanId: "season" });
  assert.equal(result.currentDate, "Day 98"); // 7 + 91
  assert.equal(result.elapsedSessions, 13, "THIS call's own delta only");
  assert.equal(result.sessionNumber, 14, "cumulative total: 1 + 13");
});

test("advanceWorldClock: also accepts an explicit {days:N} span", () => {
  const result = advanceWorldClock("wc-advance-days", { days: 14 });
  assert.equal(result.elapsedSessions, spanToElapsedSessions(14));
  assert.equal(result.currentDate, "Day 14");
});

test("advanceWorldClock: rejects a span with BOTH days and spanId", () => {
  assert.throws(() => advanceWorldClock("wc-reject-both", { days: 10, spanId: "week" }), /EXACTLY ONE/);
});

test("advanceWorldClock: rejects a span with NEITHER days nor spanId", () => {
  assert.throws(() => advanceWorldClock("wc-reject-neither", {}), /span must be one of/);
});

test("advanceWorldClock: rejects an unknown spanId", () => {
  assert.throws(() => advanceWorldClock("wc-reject-unknown", { spanId: "fortnight" }), /unknown spanId/);
});

test("advanceWorldClock: response IS the fully-updated record -- getWorldClock afterward matches exactly", () => {
  const advanced = advanceWorldClock("wc-consistency", { spanId: "month" });
  const fetched = getWorldClock("wc-consistency");
  assert.equal(fetched.currentDate, advanced.currentDate);
  assert.equal(fetched.sessionNumber, advanced.sessionNumber);
});

test("advanceWorldClock: 'long' spanId matches the 22-years-in-days constant", () => {
  const result = advanceWorldClock("wc-long-span", { spanId: "long" });
  assert.equal(result.spanDays, 22 * 365);
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
