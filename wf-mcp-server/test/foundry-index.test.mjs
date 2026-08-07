import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CONTRACT UNDER TEST — wf-mcp-server/lib/foundry-index.mjs (Phase 32 task
 * 32.2). readFoundryIndex(dataDir, world) reads
 * worlds/<world>/world-fabric-foundry-index.json per
 * plans/phase-32-bridge-contract.md §1 -- driven entirely by the 32.0
 * fixtures (wf-mcp-server/test/fixtures/foundry-bridge/), no live Foundry.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "foundry-bridge");

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

const { readFoundryIndex, FOUNDRY_INDEX_VERSION } = await import("../lib/foundry-index.mjs");
const { foundryIndexPath } = await import("../lib/snapshot.mjs");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-foundry-index-test-"));
const WORLD = "foundry-index-test-world";

function writeIndexFixture(fixtureName, world = WORLD) {
  const src = JSON.parse(readFileSync(join(FIXTURES_DIR, fixtureName), "utf8"));
  const dest = foundryIndexPath(scratchDir, world);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(src), "utf8");
  return src;
}

test("FOUNDRY_INDEX_VERSION matches the contract's v1", () => {
  assert.equal(FOUNDRY_INDEX_VERSION, 1);
});

test("readFoundryIndex: returns null (never throws) when no index file exists yet for a world", () => {
  const result = readFoundryIndex(scratchDir, "a-totally-unindexed-world");
  assert.equal(result, null);
});

test("readFoundryIndex: reads the rich sample fixture -- top-level shape + counts", () => {
  const src = writeIndexFixture("foundry-index.sample.json", "sample-world");
  const index = readFoundryIndex(scratchDir, "sample-world");
  assert.equal(index.version, 1);
  assert.equal(index.worldId, src.worldId);
  assert.equal(index.actors.length, 3);
  assert.equal(index.users.length, 2);
  assert.equal(index.scenes.length, 1);
  assert.equal(index.tokens.length, 3);
});

test("readFoundryIndex: reads the sparse minimal fixture without throwing -- empty users/tokens, one actor with mostly-null system fields", () => {
  const index = writeIndexFixture("foundry-index.minimal.json", "minimal-world") && readFoundryIndex(scratchDir, "minimal-world");
  assert.equal(index.actors.length, 1);
  assert.deepEqual(index.users, []);
  assert.equal(index.scenes.length, 1);
  assert.equal(index.scenes[0].background, null);
  assert.equal(index.actors[0].system.ac, null);
  assert.equal(index.actors[0].effects, null);
});

test("readFoundryIndex: an index with a HIGHER version than this reader understands does not throw -- best-effort read of known fields", () => {
  const src = JSON.parse(readFileSync(join(FIXTURES_DIR, "foundry-index.minimal.json"), "utf8"));
  const future = { ...src, version: 999, worldId: "future-world" };
  const dest = foundryIndexPath(scratchDir, "future-version-world");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(future), "utf8");

  const index = readFoundryIndex(scratchDir, "future-version-world");
  assert.equal(index.version, 999);
  assert.equal(index.actors.length, 1, "known top-level fields still read correctly despite the unknown-to-us version");
});

test("readFoundryIndex: tolerates unknown extra top-level fields (permissive parsing, per the contract)", () => {
  const src = JSON.parse(readFileSync(join(FIXTURES_DIR, "foundry-index.sample.json"), "utf8"));
  const withExtra = { ...src, someBrandNewField: { nested: true } };
  const dest = foundryIndexPath(scratchDir, "extra-field-world");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(withExtra), "utf8");

  const index = readFoundryIndex(scratchDir, "extra-field-world");
  assert.equal(index.actors.length, 3, "an unrecognized extra field must not break parsing of the rest of the document");
});

test("readFoundryIndex: a genuinely malformed top-level shape (actors not an array) degrades to an empty, still-valid index rather than throwing", () => {
  const dest = foundryIndexPath(scratchDir, "malformed-world");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify({ version: 1, actors: "not-an-array" }), "utf8");

  const index = readFoundryIndex(scratchDir, "malformed-world");
  assert.deepEqual(index.actors, []);
  assert.deepEqual(index.users, []);
});

test("readFoundryIndex: invalid JSON SYNTAX throws a clear error (a real corrupt-file bug, distinct from a malformed shape)", () => {
  const dest = foundryIndexPath(scratchDir, "corrupt-world");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, "{ this is not valid json", "utf8");

  assert.throws(() => readFoundryIndex(scratchDir, "corrupt-world"), /not valid JSON/);
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
