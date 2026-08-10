// Phase 38 task 38.0 -- the import-on-accept flow (phase38-fixture.mjs §4):
// accepting a compendiumRef Stagecraft row composes `import_compendium_scene`
// through the ops channel, reusing the pending/reconcile machinery's SHAPE.
// Deterministic -- no live Foundry, a fake watcher plays that role (mirrors
// phase36-flush-ops-shapes.e2e.mjs's own established convention exactly).
// Read phase38-fixture.mjs's header (§4) FIRST.
//
// EXPECTED RED (tests 1-2): today's `POST .../stagecraft/:id/accept` route
// calls `acceptStagecraftAsset(w, id)` UNCONDITIONALLY -- it has no
// awareness of `compendiumRef` at all (confirmed by direct read before
// writing this file), so it never composes any op onto the ops channel and
// never sets `foundryRef`. Test 3 is a DELIBERATE GREEN PIN: an ordinary
// (non-compendiumRef) accept must produce the EXACT SAME response shape
// today AND after 38.2 lands -- a regression there would silently break
// every other Reliquary/Stagecraft accept caller in the app.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {
  setupPhase38Env,
  cleanupScratchEnv,
  acceptStagecraftAssetViaRoute,
  seedCompendiumBrowseRow,
  readFoundryOpsFileSync,
  armFakeFoundryWatcher
} from "./phase38-fixture.mjs";

const { scratchDir, dataDir } = setupPhase38Env("gm-tools-e2e-p38-import-");
const WORLD = "e2e-p38-import-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../../server.mjs");
const { saveStagecraftAsset } = await import("../../../session-planner/stagecraft-store.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

let server, base;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupScratchEnv(scratchDir);
});

test("ops-file shape: accepting a compendiumRef row writes ONE import_compendium_scene op {packId, entryId}", async () => {
  const row = await seedCompendiumBrowseRow(WORLD, {
    name: "The Drowned Anchor",
    packId: "czepeku-taverns.scenes",
    entryId: "scnEntryTavernA"
  });

  const acceptPromise = acceptStagecraftAssetViaRoute(base, WORLD, row.id);
  // Give the route a moment to write the ops file BEFORE any watcher would
  // clear it (there is none armed yet) -- deterministic window, mirrors
  // phase36-flush-ops-shapes.e2e.mjs's own "read mid-flight, then arm" pattern.
  await new Promise((r) => setTimeout(r, 200));
  const ops = readFoundryOpsFileSync(dataDir, WORLD);

  assert.equal(
    ops.length,
    1,
    `accepting a compendiumRef row must write exactly ONE op onto the ops channel, got ${ops.length} -- ` +
    `today's accept route ignores compendiumRef entirely and never touches the ops channel`
  );
  if (ops.length === 1) {
    assert.equal(ops[0].kind, "import_compendium_scene");
    assert.deepEqual(ops[0].data, { packId: "czepeku-taverns.scenes", entryId: "scnEntryTavernA" });
    assert.equal(typeof ops[0].opId, "string");
    // Unblock the still-pending accept call so this test doesn't leak a
    // hanging promise into the next test.
    armFakeFoundryWatcher(dataDir, WORLD, [{ opId: ops[0].opId, ok: true, foundryUuid: "Scene.tavernAImported" }], 10);
  }
  await acceptPromise.catch(() => {});
});

test("applied round trip: ok:true result completes the row -- foundryRef.sceneUuid set, status accepted, response {status:'applied', ok:true, asset}", async () => {
  const row = await seedCompendiumBrowseRow(WORLD, {
    name: "The Gilded Cask",
    packId: "czepeku-taverns.scenes",
    entryId: "scnEntryTavernB"
  });

  // Arm the fake watcher FIRST this time (short delay) so the route's own
  // poll picks up a confirmed ok:true within its budget -- proves the FULL
  // accept -> op -> result -> row-completes round trip, not just the
  // outbound op shape.
  const acceptPromise = acceptStagecraftAssetViaRoute(base, WORLD, row.id);
  await new Promise((r) => setTimeout(r, 150));
  const ops = readFoundryOpsFileSync(dataDir, WORLD);
  if (ops.length === 1) {
    armFakeFoundryWatcher(dataDir, WORLD, [{ opId: ops[0].opId, ok: true, foundryUuid: "Scene.gildedCaskImported" }], 10);
  }
  const { status, body } = await acceptPromise;

  assert.equal(status, 200, `accept must still return 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body?.status, "applied", 'response must report {status:"applied"} once the import op resolves');
  assert.equal(body?.ok, true);
  assert.equal(
    body?.asset?.foundryRef?.sceneUuid,
    "Scene.gildedCaskImported",
    "the completed row must gain foundryRef.sceneUuid from the import op's result -- got none, import-on-accept isn't implemented yet"
  );
  assert.equal(body?.asset?.status, "accepted", "a successfully-imported row must transition to accepted (normal accepted-map behavior)");
});

test("GREEN PIN: an ordinary (non-compendiumRef) accept is UNCHANGED -- response is exactly {asset}, no status/ok keys", async () => {
  const asset = saveStagecraftAsset(WORLD, {
    kind: "splash",
    name: "Hand-added splash art",
    source: "local",
    status: "proposed"
  });

  const { status, body } = await acceptStagecraftAssetViaRoute(base, WORLD, asset.id);
  assert.equal(status, 200, `an ordinary accept must still succeed (it's a reused, already-shipped route), got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body?.asset?.status, "accepted");
  assert.deepEqual(
    Object.keys(body || {}).sort(),
    ["asset"],
    `an ordinary accept's response must be EXACTLY {asset} with no extra status/ok keys -- got keys ${JSON.stringify(Object.keys(body || {}))}. ` +
    "A careless 'extend accept' implementation that always wraps the response would regress every other Stagecraft/Reliquary accept caller."
  );
});
