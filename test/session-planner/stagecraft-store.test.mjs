import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — session-planner/stagecraft-store.mjs (Phase 35 task
 * 35.1, §2 of review-ui/test/e2e/phase35-fixture.mjs). Per-world, one JSON
 * file per world; status gate default 'accepted' (party-roster's own
 * default-accepted-unless-Foundry-pull convention).
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

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-stagecraft-store-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_STAGECRAFT_DIR = join(scratchDir, "stagecraft");

const REPO_DEFAULT_ROOT = join(new URL("../../stagecraft", import.meta.url).pathname);
const before = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();

const WORLD = "stagecraft-store-test-world";

(async () => {
  const {
    stagecraftRoot,
    saveStagecraftAsset,
    getStagecraftAsset,
    listStagecraftAssets,
    acceptStagecraftAsset,
    discardStagecraftAsset,
    updateStagecraftAssetFields,
    addStagecraftTag,
    removeStagecraftTag,
    setStagecraftAssetPendingImport,
    markStagecraftAssetImported
  } = await import("../../session-planner/stagecraft-store.mjs");

  test("directory isolation: stagecraftRoot() honors GM_TOOLS_STAGECRAFT_DIR, never the repo's real default", () => {
    assert.equal(stagecraftRoot(), process.env.GM_TOOLS_STAGECRAFT_DIR);
    assert.notEqual(stagecraftRoot(), REPO_DEFAULT_ROOT);
  });

  test("listStagecraftAssets: [] for a world with no assets yet -- not an error", () => {
    assert.deepEqual(listStagecraftAssets("a-totally-new-world"), []);
  });

  test("saveStagecraftAsset: a hand-added row defaults to status:'accepted' (the deliberate authorship act)", () => {
    const asset = saveStagecraftAsset(
      WORLD,
      { kind: "splash", name: "Cover Art", desc: "The party approaches the chantry." },
      { makeId: () => "sc-1", now: "2026-08-08T00:00:00.000Z" }
    );
    assert.equal(asset.id, "sc-1");
    assert.equal(asset.kind, "splash");
    assert.equal(asset.status, "accepted");
    assert.equal(asset.source, "local");
    assert.deepEqual(asset.tags, []);
  });

  test("saveStagecraftAsset: an explicit status:'proposed' round-trips (the Foundry-pull map-ref path)", () => {
    const asset = saveStagecraftAsset(
      WORLD,
      { kind: "map", name: "The Sunken Chantry", source: "foundry", meta: "4000x3000, grid 100/5ft", foundryRef: { sceneUuid: "Scene.chantry" }, status: "proposed" },
      { makeId: () => "sc-2", now: "2026-08-08T00:01:00.000Z" }
    );
    assert.equal(asset.status, "proposed");
    assert.equal(asset.foundryRef.sceneUuid, "Scene.chantry");
  });

  test("getStagecraftAsset: round-trips a saved asset by id, throws a clear error for an unknown id", () => {
    assert.equal(getStagecraftAsset(WORLD, "sc-1").name, "Cover Art");
    assert.throws(() => getStagecraftAsset(WORLD, "no-such-asset"), /no-such-asset/);
  });

  test("listStagecraftAssets: optional kind filter", () => {
    assert.deepEqual(listStagecraftAssets(WORLD).map((a) => a.id), ["sc-1", "sc-2"]);
    assert.deepEqual(listStagecraftAssets(WORLD, "map").map((a) => a.id), ["sc-2"]);
    assert.deepEqual(listStagecraftAssets(WORLD, "music"), []);
  });

  test("no write in this file leaked into the repo's real default stagecraft/ directory", () => {
    const after = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();
    const added = [...after].filter((f) => !before.has(f));
    assert.deepEqual(added, [], `this test run must not add new entries to ${REPO_DEFAULT_ROOT}, found: ${added}`);
  });

  // -------------------------------------------------------------------------
  // status gate / re-ingest update
  // -------------------------------------------------------------------------

  test("acceptStagecraftAsset: proposed -> accepted", () => {
    const updated = acceptStagecraftAsset(WORLD, "sc-2");
    assert.equal(updated.status, "accepted");
  });

  test("discardStagecraftAsset: refuses to discard an already-accepted asset", () => {
    assert.throws(() => discardStagecraftAsset(WORLD, "sc-2"), /accepted/i);
  });

  test("discardStagecraftAsset: a still-'proposed' asset discards cleanly", () => {
    const asset = saveStagecraftAsset(WORLD, { kind: "map", name: "Discard Me", status: "proposed" }, { makeId: () => "sc-3" });
    const updated = discardStagecraftAsset(WORLD, asset.id);
    assert.equal(updated.status, "discarded");
  });

  test("updateStagecraftAssetFields: overwrites fields on a still-'proposed' asset, preserving id/world/kind/createdAt/status/tags", () => {
    const asset = saveStagecraftAsset(WORLD, { kind: "map", name: "Old Name", meta: "1x1", status: "proposed" }, { makeId: () => "sc-4", now: "2026-08-08T00:02:00.000Z" });
    const updated = updateStagecraftAssetFields(WORLD, asset.id, { name: "New Name", meta: "2x2" });
    assert.equal(updated.id, "sc-4");
    assert.equal(updated.kind, "map");
    assert.equal(updated.status, "proposed");
    assert.equal(updated.createdAt, "2026-08-08T00:02:00.000Z");
    assert.equal(updated.name, "New Name");
    assert.equal(updated.meta, "2x2");
  });

  test("updateStagecraftAssetFields: NEVER silently overwrites an already-'accepted' asset", () => {
    assert.throws(() => updateStagecraftAssetFields(WORLD, "sc-2", { name: "Should Not Land" }), /accepted/i);
  });

  // -------------------------------------------------------------------------
  // tags (§4 wrapper)
  // -------------------------------------------------------------------------

  test("addStagecraftTag/removeStagecraftTag: real persistence via §4's shared helper", () => {
    const tagged = addStagecraftTag(WORLD, "sc-1", "cover");
    assert.deepEqual(tagged.tags, ["cover"]);
    const reread = getStagecraftAsset(WORLD, "sc-1");
    assert.deepEqual(reread.tags, ["cover"]);
    const untagged = removeStagecraftTag(WORLD, "sc-1", "cover");
    assert.deepEqual(untagged.tags, []);
  });

  // -------------------------------------------------------------------------
  // Phase 38 task 38.2, §3/§4 -- compendiumRef/thumb/pendingImport (additive)
  // -------------------------------------------------------------------------

  test("saveStagecraftAsset: compendiumRef/thumb/pendingImport default null, round-trip an explicit compendiumRef browse row", () => {
    const plain = saveStagecraftAsset(WORLD, { kind: "map", name: "Plain", status: "proposed" }, { makeId: () => "sc-5" });
    assert.equal(plain.compendiumRef, null);
    assert.equal(plain.thumb, null);
    assert.equal(plain.pendingImport, null);

    const browseRow = saveStagecraftAsset(
      WORLD,
      {
        kind: "map",
        name: "The Drowned Anchor",
        source: "foundry",
        meta: "in compendium — import to stage",
        foundryRef: null,
        compendiumRef: { packId: "czepeku-taverns.scenes", entryId: "scnEntryTavernA" },
        thumb: "modules/czepeku-taverns/thumbs/tavern-a.webp",
        status: "proposed"
      },
      { makeId: () => "sc-6" }
    );
    assert.deepEqual(browseRow.compendiumRef, { packId: "czepeku-taverns.scenes", entryId: "scnEntryTavernA" });
    assert.equal(browseRow.thumb, "modules/czepeku-taverns/thumbs/tavern-a.webp");
    assert.equal(browseRow.foundryRef, null);
  });

  test("saveStagecraftAsset: catalogRef (38.4 catalog tier) defaults null, round-trips a not-installed catalog row", () => {
    const plain = saveStagecraftAsset(WORLD, { kind: "map", name: "Plain2", status: "proposed" }, { makeId: () => "sc-cat-0" });
    assert.equal(plain.catalogRef, null);

    const catalogRow = saveStagecraftAsset(
      WORLD,
      {
        kind: "map",
        name: "Hippodrome",
        source: "local",
        meta: "Czepeku pack — in catalog, not installed",
        tags: ["czepeku"],
        catalogRef: { manifestUrl: "https://example.com/hippodrome/module.json", packId: "czepeku-hippodrome" },
        status: "accepted"
      },
      { makeId: () => "sc-cat-1" }
    );
    assert.deepEqual(catalogRow.catalogRef, { manifestUrl: "https://example.com/hippodrome/module.json", packId: "czepeku-hippodrome" });
    assert.equal(catalogRow.foundryRef, null);
    assert.equal(catalogRow.compendiumRef, null);
  });

  test("updateStagecraftAssetFields: thumb refreshes on a re-ingest, like name/meta", () => {
    const asset = saveStagecraftAsset(
      WORLD,
      { kind: "map", name: "Old", meta: "old meta", thumb: "old.webp", status: "proposed" },
      { makeId: () => "sc-7" }
    );
    const updated = updateStagecraftAssetFields(WORLD, asset.id, { name: "New", meta: "new meta", thumb: "new.webp" });
    assert.equal(updated.thumb, "new.webp");
  });

  test("setStagecraftAssetPendingImport: sets and clears the {opId, requestedAt} ledger, additive/independent of status", () => {
    const asset = saveStagecraftAsset(WORLD, { kind: "map", name: "Pending Import", status: "proposed" }, { makeId: () => "sc-8" });
    const pending = setStagecraftAssetPendingImport(WORLD, asset.id, { opId: "op_1", requestedAt: "2026-08-10T00:00:00.000Z" });
    assert.deepEqual(pending.pendingImport, { opId: "op_1", requestedAt: "2026-08-10T00:00:00.000Z" });
    assert.equal(pending.status, "proposed", "setting pendingImport never changes status by itself");

    const cleared = setStagecraftAssetPendingImport(WORLD, asset.id, null);
    assert.equal(cleared.pendingImport, null);
  });

  test("markStagecraftAssetImported: sets foundryRef.sceneUuid, flips status to accepted, clears pendingImport", () => {
    const asset = saveStagecraftAsset(
      WORLD,
      {
        kind: "map",
        name: "The Gilded Cask",
        source: "foundry",
        meta: "in compendium — import to stage",
        compendiumRef: { packId: "czepeku-taverns.scenes", entryId: "scnEntryTavernB" },
        status: "proposed"
      },
      { makeId: () => "sc-9" }
    );
    setStagecraftAssetPendingImport(WORLD, asset.id, { opId: "op_2", requestedAt: "2026-08-10T00:00:00.000Z" });

    const imported = markStagecraftAssetImported(WORLD, asset.id, "Scene.gildedCaskImported");
    assert.deepEqual(imported.foundryRef, { sceneUuid: "Scene.gildedCaskImported" });
    assert.equal(imported.status, "accepted");
    assert.equal(imported.pendingImport, null);
    // compendiumRef itself is left untouched -- it's the dedup key a future
    // re-pull still needs to find THIS now-accepted row.
    assert.deepEqual(imported.compendiumRef, { packId: "czepeku-taverns.scenes", entryId: "scnEntryTavernB" });
  });

  console.log(`\n${passed} passed`);
})();

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
