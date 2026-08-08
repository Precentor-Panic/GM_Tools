import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — session-planner/app-settings.mjs (Phase 34 task
 * 34.1): per-world flat JSON store, `{campaignName?, gameSystem?, calendar?,
 * proseModel?, imageModel?, staleThresholdMs?}`, shallow-patch semantics.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-app-settings-test-"));
process.env.GM_TOOLS_APP_SETTINGS_DIR = join(scratchDir, "app-settings");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state"); // transitively needed for withLock, same convention as scenes.test.mjs

const { getSettings, patchSettings, appSettingsRoot, SCHEMA_VERSION, AppSettings } = await import("../../session-planner/app-settings.mjs");

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

test("appSettingsRoot() honors GM_TOOLS_APP_SETTINGS_DIR", () => {
  assert.equal(appSettingsRoot(), join(scratchDir, "app-settings"));
});

test("getSettings: no file yet -- returns {} (every field simply absent), not an error", () => {
  assert.deepEqual(getSettings("app-settings-fresh-world"), {});
});

test("patchSettings: a first patch sets exactly the supplied fields, nothing else", () => {
  const result = patchSettings("app-settings-world-a", { campaignName: "The Threadbare City", staleThresholdMs: 600000 });
  assert.deepEqual(result, { campaignName: "The Threadbare City", staleThresholdMs: 600000 });
  assert.deepEqual(getSettings("app-settings-world-a"), result);
});

test("patchSettings: a SECOND patch only changes the keys it supplies -- prior stored keys survive untouched", () => {
  patchSettings("app-settings-world-b", { campaignName: "Merrath", gameSystem: "D&D 5e" });
  const result = patchSettings("app-settings-world-b", { calendar: "Harptos" });
  assert.deepEqual(result, { campaignName: "Merrath", gameSystem: "D&D 5e", calendar: "Harptos" });
});

test("patchSettings: overwrites an existing key when re-supplied", () => {
  patchSettings("app-settings-world-c", { proseModel: "claude-sonnet-5" });
  const result = patchSettings("app-settings-world-c", { proseModel: "claude-opus-4-8" });
  assert.equal(result.proseModel, "claude-opus-4-8");
});

test("patchSettings: stored-not-wired fields (proseModel/imageModel) round-trip exactly like wired ones -- this store draws no distinction", () => {
  const result = patchSettings("app-settings-world-d", { imageModel: "some-image-model", proseModel: "some-prose-model" });
  assert.equal(result.imageModel, "some-image-model");
  assert.equal(result.proseModel, "some-prose-model");
});

test("AppSettings schema: rejects an unrecognized field (.strict())", () => {
  assert.throws(() => AppSettings.parse({ notARealField: true }));
});

test("AppSettings schema: rejects a negative staleThresholdMs", () => {
  assert.throws(() => AppSettings.parse({ staleThresholdMs: -1 }));
});

test("patchSettings: two different worlds are fully isolated from each other", () => {
  patchSettings("app-settings-world-e1", { campaignName: "World E1" });
  patchSettings("app-settings-world-e2", { campaignName: "World E2" });
  assert.equal(getSettings("app-settings-world-e1").campaignName, "World E1");
  assert.equal(getSettings("app-settings-world-e2").campaignName, "World E2");
});

console.log(`\n${passed} test(s) passed.`);

process.on("exit", () => rmSync(scratchDir, { recursive: true, force: true }));
