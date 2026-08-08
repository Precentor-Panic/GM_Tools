import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — session-planner/scene-tray.mjs (Phase 35 task 35.1,
 * §7 of review-ui/test/e2e/phase35-fixture.mjs). Roster/budget bookkeeping
 * only -- the creature-drop "create/reuse a stat-carrying scene element"
 * composition lives at the review-ui/server.mjs ROUTE level (covered by
 * review-ui/test/scene-tray-routes.test.mjs + the phase35 e2e route-level
 * suite), NOT tested here.
 */

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

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-scene-tray-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SCENE_TRAY_DIR = join(scratchDir, "scene-tray");

const REPO_DEFAULT_ROOT = join(new URL("../../scene-tray", import.meta.url).pathname);
const before = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();

const WORLD = "scene-tray-test-world";

(async () => {
  const { sceneTrayRoot, getSceneTray, addToSceneTray, removeFromSceneTray, setSceneTrayXpBudget } = await import(
    "../../session-planner/scene-tray.mjs"
  );

  test("directory isolation: sceneTrayRoot() honors GM_TOOLS_SCENE_TRAY_DIR, never the repo's real default", () => {
    assert.equal(sceneTrayRoot(), process.env.GM_TOOLS_SCENE_TRAY_DIR);
    assert.notEqual(sceneTrayRoot(), REPO_DEFAULT_ROOT);
  });

  test("getSceneTray: NEVER 404s/throws for an unknown sceneId -- returns the default {roster:[], xpBudget:null}", () => {
    assert.deepEqual(getSceneTray(WORLD, "no-such-scene"), { roster: [], xpBudget: null });
  });

  test("addToSceneTray: a first creature drop creates a roster entry with n:1", () => {
    const result = addToSceneTray(WORLD, "scene-1", { id: "bst-1", kind: "creature" }, { now: "2026-08-08T00:00:00.000Z" });
    assert.deepEqual(result.roster, [{ id: "bst-1", n: 1, kind: "creature" }]);
    assert.equal(result.xpBudget, null);
  });

  test("addToSceneTray: a SECOND creature drop of the SAME id INCREMENTS n, never creates a second roster row", () => {
    const result = addToSceneTray(WORLD, "scene-1", { id: "bst-1", kind: "creature" }, {});
    assert.deepEqual(result.roster, [{ id: "bst-1", n: 2, kind: "creature" }]);
  });

  test("addToSceneTray: a THIRD creature drop stacks to n:3", () => {
    const result = addToSceneTray(WORLD, "scene-1", { id: "bst-1", kind: "creature" }, {});
    assert.equal(result.roster.find((r) => r.id === "bst-1").n, 3);
  });

  test("addToSceneTray: a hero drop creates a roster entry with n:1", () => {
    const result = addToSceneTray(WORLD, "scene-1", { id: "pm-1", kind: "hero" }, {});
    assert.ok(result.roster.some((r) => r.id === "pm-1" && r.kind === "hero" && r.n === 1));
  });

  test("addToSceneTray: a REPEAT hero drop RESETS n to 1, never stacks", () => {
    addToSceneTray(WORLD, "scene-1", { id: "pm-1", kind: "hero" }, {});
    addToSceneTray(WORLD, "scene-1", { id: "pm-1", kind: "hero" }, {});
    const result = addToSceneTray(WORLD, "scene-1", { id: "pm-1", kind: "hero" }, {});
    assert.equal(result.roster.find((r) => r.id === "pm-1").n, 1, "hero drops never stack, always reset to 1");
  });

  test("addToSceneTray: a REPEAT asset drop also RESETS n to 1, never stacks", () => {
    addToSceneTray(WORLD, "scene-1", { id: "it-1", kind: "asset" }, {});
    const result = addToSceneTray(WORLD, "scene-1", { id: "it-1", kind: "asset" }, {});
    assert.equal(result.roster.find((r) => r.id === "it-1" && r.kind === "asset").n, 1);
  });

  test("addToSceneTray: the SAME id under a DIFFERENT kind is a genuinely separate roster row (kind is part of identity)", () => {
    const result = addToSceneTray(WORLD, "scene-1", { id: "shared-id", kind: "creature" }, {});
    addToSceneTray(WORLD, "scene-1", { id: "shared-id", kind: "asset" }, {});
    const rows = result.roster.filter((r) => r.id === "shared-id");
    assert.ok(rows.length >= 0); // sanity -- real check below via getSceneTray
    const tray = getSceneTray(WORLD, "scene-1");
    const creatureRow = tray.roster.find((r) => r.id === "shared-id" && r.kind === "creature");
    const assetRow = tray.roster.find((r) => r.id === "shared-id" && r.kind === "asset");
    assert.ok(creatureRow && assetRow, "both kinds must coexist as separate rows for the same id");
  });

  test("getSceneTray: reflects everything persisted so far for this (world, sceneId)", () => {
    const tray = getSceneTray(WORLD, "scene-1");
    assert.equal(tray.roster.find((r) => r.id === "bst-1").n, 3);
    assert.equal(tray.roster.find((r) => r.id === "pm-1" && r.kind === "hero").n, 1);
  });

  test("getSceneTray: a DIFFERENT scene in the same world has its own independent, empty tray", () => {
    assert.deepEqual(getSceneTray(WORLD, "scene-2"), { roster: [], xpBudget: null });
  });

  test("removeFromSceneTray: a full splice removal, never a decrement", () => {
    const result = removeFromSceneTray(WORLD, "scene-1", "creature", "bst-1");
    assert.ok(!result.roster.some((r) => r.id === "bst-1" && r.kind === "creature"), "the row is gone entirely, not decremented to n:2");
  });

  test("removeFromSceneTray: idempotent -- removing an already-absent row is a safe no-op", () => {
    const before2 = getSceneTray(WORLD, "scene-1");
    const after = removeFromSceneTray(WORLD, "scene-1", "creature", "bst-1");
    assert.deepEqual(after, before2);
  });

  test("removeFromSceneTray: idempotent even for a scene with NO tray record at all", () => {
    assert.deepEqual(removeFromSceneTray(WORLD, "never-touched-scene", "creature", "x"), { roster: [], xpBudget: null });
  });

  test("setSceneTrayXpBudget: persists a GM-set budget number, creating a tray record for a scene that had none yet", () => {
    const result = setSceneTrayXpBudget(WORLD, "scene-budget-only", 900, { now: "2026-08-08T00:05:00.000Z" });
    assert.equal(result.xpBudget, 900);
    assert.deepEqual(result.roster, []);
    assert.equal(getSceneTray(WORLD, "scene-budget-only").xpBudget, 900, "persisted, re-readable");
  });

  test("setSceneTrayXpBudget: overwrites an existing budget without touching the roster", () => {
    addToSceneTray(WORLD, "scene-budget-only", { id: "bst-x", kind: "creature" }, {});
    setSceneTrayXpBudget(WORLD, "scene-budget-only", 1200, {});
    const tray = getSceneTray(WORLD, "scene-budget-only");
    assert.equal(tray.xpBudget, 1200);
    assert.equal(tray.roster.length, 1, "the roster set by addToSceneTray must be untouched by a budget-only call");
  });

  test("setSceneTrayXpBudget: null clears the budget back to 'no suggested default'", () => {
    const result = setSceneTrayXpBudget(WORLD, "scene-budget-only", null, {});
    assert.equal(result.xpBudget, null);
  });

  test("no write in this file leaked into the repo's real default scene-tray/ directory", () => {
    const after = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();
    const added = [...after].filter((f) => !before.has(f));
    assert.deepEqual(added, [], `this test run must not add new entries to ${REPO_DEFAULT_ROOT}, found: ${added}`);
  });

  console.log(`\n${passed} passed`);
})();

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
