import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — session-planner/fortune-track.mjs (Phase 37 task
 * 37.1): ONE global per-world track, {stopId, updatedAt}, FIVE discrete
 * stops with bounds -2..2, default 'middling'/bias 0.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-fortune-track-test-"));
process.env.GM_TOOLS_FORTUNE_DIR = join(scratchDir, "fortune-track");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state"); // transitively needed for withLock

const { getFortune, setFortune, fortuneRoot, SCHEMA_VERSION, FORTUNE_STOPS } = await import("../../session-planner/fortune-track.mjs");

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

test("fortuneRoot() honors GM_TOOLS_FORTUNE_DIR", () => {
  assert.equal(fortuneRoot(), join(scratchDir, "fortune-track"));
});

test("FORTUNE_STOPS: exactly the 5 prototype stops in prototype order, bounds -2..2", () => {
  assert.deepEqual(
    FORTUNE_STOPS.map((f) => f.stopId),
    ["bountiful", "fair", "middling", "lean", "ruinous"]
  );
  for (const f of FORTUNE_STOPS) {
    assert.ok(f.bias >= -2 && f.bias <= 2, `bias out of bounds for ${f.stopId}: ${f.bias}`);
  }
  assert.equal(FORTUNE_STOPS.find((f) => f.stopId === "bountiful").bias, 2);
  assert.equal(FORTUNE_STOPS.find((f) => f.stopId === "ruinous").bias, -2);
});

test("getFortune: a brand-new world defaults to 'middling'/bias 0, not an error", () => {
  const fortune = getFortune("ft-fresh-world");
  assert.equal(fortune.stopId, "middling");
  assert.equal(fortune.bias, 0);
  assert.equal(fortune.updatedAt, null);
});

test("setFortune: persists a valid stopId and reports the matching bias", () => {
  const set = setFortune("ft-set-world", "bountiful");
  assert.equal(set.stopId, "bountiful");
  assert.equal(set.bias, 2);
  const refetched = getFortune("ft-set-world");
  assert.equal(refetched.stopId, "bountiful");
  assert.equal(refetched.bias, 2);
});

test("setFortune: a SECOND call overwrites the first", () => {
  setFortune("ft-overwrite-world", "fair");
  setFortune("ft-overwrite-world", "lean");
  assert.equal(getFortune("ft-overwrite-world").stopId, "lean");
});

test("setFortune: rejects an unknown stopId -- throws, never a silent fallback to middling", () => {
  assert.throws(() => setFortune("ft-reject-world", "apocalyptic"), /Unknown fortune stopId/);
  // The world's own record must be untouched by the rejected call.
  assert.equal(getFortune("ft-reject-world").stopId, "middling");
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
