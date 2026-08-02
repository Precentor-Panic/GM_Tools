import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — new `session-planner/transit-entity.mjs` (Phase 22
 * task 22.2). This module does not exist yet; this file is the interface
 * spec for it, per plans/phase-22-tasks.md task 22.0. Expected to fail with
 * "Cannot find module" until 22.2 lands.
 *
 * ---------------------------------------------------------------------------
 * createTransitEntity(dir, world, { fromEntityId, toEntityId, name }, opts = {})
 * ---------------------------------------------------------------------------
 *   @param {string} dir           resolved data dir (resolveDir()'s return
 *                                 value) — REQUIRED as the first argument,
 *                                 matching every other function in this
 *                                 project that ultimately writes to the live/
 *                                 headless graph-apply path
 *                                 (wf-mcp-server/lib/manual-edit-ops.mjs's
 *                                 addNodeOp(dir, w, fields) is the exact
 *                                 sibling signature this mirrors). The
 *                                 phase-22-tasks.md task list's own shorthand
 *                                 signature omits `dir` — this is this test
 *                                 file's pinned correction, since 22.2 has no
 *                                 way to reach the live snapshot without it.
 *   @param {string} world
 *   @param {string} fields.fromEntityId   must already exist in the live snapshot
 *   @param {string} fields.toEntityId     must already exist in the live snapshot
 *   @param {string} [fields.name]         optional; see DEFAULT NAMING below
 *   @returns {Promise<{entityId:string, name:string, type:"place", isTransit:true}>}
 *
 * ENTITY-CREATION MECHANISM (per §12 of plans/phase-21-review.md and 22.2's
 * own instruction — "don't invent a second entity-creation mechanism"):
 * this is a THIN WRAPPER over the SAME established manual-entity-creation
 * route every other manual node-add in this project already uses —
 * wf-mcp-server/lib/manual-edit-ops.mjs's addNodeOp(dir, w, fields). It does
 * NOT write to world-fabric-mutations.json or the snapshot by any other
 * path. (A real consequence of this reuse, not a bug: addNodeOp also stamps
 * the GLOBAL mutation-engine/manual-undo.mjs slot and calls
 * markHumanReviewed — this is expected and correct; task 22.4's scene-
 * scoped undo is a SEPARATE, additional mechanism layered on top for the
 * "develop this scene" flow, not a replacement for this ordinary single-
 * write's own global-undo coverage.)
 *
 * ---------------------------------------------------------------------------
 * THE DISTINGUISHING-FIELD DECISION (pinned here — this test file IS the
 * contract 22.2 must match exactly, per this phase's own explicit
 * instruction) — attributes.isTransit === true, NOT a new top-level field:
 * ---------------------------------------------------------------------------
 * Per plans/phase-21-review.md §12: transit entities commit as
 * `type: "place"` (no new entity-type enum value, ever) plus "a
 * distinguishing attribute". Confirmed by direct reading of BOTH graph
 * write paths that this repo's entities pass through:
 *   - foundry_worldFabric/scripts/data/graph-service.mjs's upsertEntity()
 *     (live-Foundry path)
 *   - foundry_worldFabric/scripts/data/interchange.mjs's normalizeEntity()
 *     (headless path, reached via graph-import/headless-apply.mjs's
 *     importGraph — the path createTransitEntity's own addNodeOp call
 *     actually exercises)
 * BOTH build the persisted entity record from an EXPLICIT, closed allowlist
 * of named top-level fields (id/name/type/description/summary/importance/
 * imageUrl/tags/attributes/foundryRef/x/y/lastSession/sessionSeen/
 * namespace/rulesVerified/status/playerKnown/canonLocked/role/createdAt/
 * updatedAt/source). A field NOT on that allowlist is SILENTLY DROPPED on
 * write, on BOTH paths — a hypothetical top-level `isTransit` key would
 * round-trip to `undefined`, an invisible data-loss bug, not a working
 * feature. `attributes` is the one field on that SAME allowlist that is
 * already a generic pass-through bag on both paths
 * (`data.attributes ?? existing?.attributes ?? {}` verbatim in both files)
 * — it is the ONLY place a genuinely new, un-enum'd marker can survive a
 * write on this project's CURRENT entity schema without a
 * `foundry_worldFabric` schema change, which this phase is expressly
 * forbidden from making (see plans/phase-22-tasks.md's "How to work"
 * section).
 *
 * THE PINNED CONTRACT: createTransitEntity must call addNodeOp with
 * `data.attributes` containing (at minimum) `{ isTransit: true }` — so the
 * created entity's stored, re-readable shape is:
 *   { ..., type: "place", attributes: { isTransit: true, ... }, ... }
 * `entity.type === "place"` AND `entity.attributes?.isTransit === true`
 * together are the complete, permanent way any other code in this project
 * must recognize a transit entity going forward. `isTransit` on the
 * RETURNED convenience object (createTransitEntity's own return value) is a
 * top-level boolean for caller convenience — it does NOT imply the entity's
 * OWN stored record carries a top-level `isTransit` field; the persisted
 * entity's marker lives under `attributes` as described above.
 *
 * ---------------------------------------------------------------------------
 * DEFAULT NAMING (pinned, concrete, never "some string")
 * ---------------------------------------------------------------------------
 * If `name` is omitted or blank:
 *   - If `toEntityId` resolves to a real entity in the live snapshot,
 *     default name is the literal string `The Road to ${toEntity.name}`.
 *   - Otherwise (toEntityId does not resolve — should not normally happen
 *     given the validation below, but the default must still be defined),
 *     default name is the literal string `Path`.
 * Both forms are explicitly sanctioned by plans/phase-21-review.md §3's own
 * language ("stay exactly as generic as 'Path'... indefinitely").
 *
 * fromEntityId/toEntityId are validated against the live snapshot before
 * any write happens (mirrors addEdgeOp's own existing "No entity ... found
 * in the live graph" guard) — a missing endpoint throws, no partial entity
 * is ever created.
 *
 * NO LAZY CREATION: this function commits the entity immediately, always —
 * there is no deferred/placeholder mode (plans/phase-21-review.md §3's
 * explicit correction).
 *
 * ---------------------------------------------------------------------------
 * ENUM-FILES-UNTOUCHED (source-grep convention, matching
 * test/combat-planning/encounter-heuristic.test.mjs's own "no dependency on
 * X, confirmed by reading the module's own source" pattern)
 * ---------------------------------------------------------------------------
 * Both checks below are INDEPENDENT of transit-entity.mjs even existing —
 * they must keep passing forever as a standing regression guard, not just
 * during this phase's red window.
 */

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-transit-entity-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "transit-entity-test-world";

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
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------
// These two checks run BEFORE (and independently of) importing
// transit-entity.mjs -- plain source reads, so they hold real value as a
// permanent regression guard even in this file's currently-expected-red
// state.
// ---------------------------------------------------------------------

const ENUM_FILES = [
  "../../wf-mcp-server/index.mjs",
  "../../graph-import/scan-mentions.mjs",
  "../../graph-import/writeup-import.mjs",
  "../../mutation-engine/prep-content.mjs"
];
const ORIGINAL_ENUM_LITERAL = 'z.enum(["person", "place", "faction", "object", "event", "concept"])';

test("ENUM FILES UNCHANGED: all four known entity-type enum definitions still contain the exact original 6-value literal, byte-unchanged (independent of transit-entity.mjs existing)", () => {
  for (const rel of ENUM_FILES) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.ok(
      src.includes(ORIGINAL_ENUM_LITERAL),
      `${rel} must still contain the exact original enum literal, unmodified -- transit entities must never add a 7th enum value here`
    );
  }
});

(async () => {
  let transitEntityModule;
  try {
    transitEntityModule = await import("../../session-planner/transit-entity.mjs");
  } catch (err) {
    console.error("FAIL  import session-planner/transit-entity.mjs");
    console.error(err.stack || err.message);
    process.exitCode = 1;
    console.log(`\n${passed} test(s) passed.`);
    rmSync(scratchDir, { recursive: true, force: true });
    return;
  }
  const { createTransitEntity } = transitEntityModule;

  test("SOURCE GREP: transit-entity.mjs's own source defines no NEW z.enum(...) literal anywhere (type is always the hardcoded literal \"place\")", () => {
    const src = readFileSync(new URL("../../session-planner/transit-entity.mjs", import.meta.url), "utf8");
    assert.ok(!/z\.enum\(/.test(src), "transit-entity.mjs must never define or import a new type enum");
  });

  const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
  const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
  const { loadSnapshot } = await import("../../wf-mcp-server/lib/snapshot.mjs");

  const snapPath = snapshotFilePath(dataDir, WORLD);
  bootstrapSnapshot(snapPath, { worldId: WORLD });
  applyHeadless(snapPath, [
    { op: "upsert_entity", data: { id: "town-a", name: "Riverbend", type: "place", importance: 0.6 } },
    { op: "upsert_entity", data: { id: "town-b", name: "Ashfall Keep", type: "place", importance: 0.6 } }
  ]);

  await testAsync("creates a real entity: type:\"place\", attributes.isTransit === true, entity count increments by exactly 1", async () => {
    const before = loadSnapshot(dataDir, WORLD).snapshot.entities.length;
    const result = await createTransitEntity(dataDir, WORLD, { fromEntityId: "town-a", toEntityId: "town-b", name: "The Old Toll Road" });
    assert.ok(result.entityId);
    assert.equal(result.type, "place");
    assert.equal(result.isTransit, true);

    const after = loadSnapshot(dataDir, WORLD).snapshot;
    assert.equal(after.entities.length, before + 1);
    const stored = after.entities.find((e) => e.id === result.entityId);
    assert.ok(stored, "the created entity must be found in the live snapshot by its returned id");
    assert.equal(stored.type, "place", "stored entity's OWN type field must literally be \"place\"");
    assert.equal(stored.attributes?.isTransit, true, "the distinguishing marker must be attributes.isTransit === true on the STORED record, not a dropped top-level field");
    assert.equal(stored.name, "The Old Toll Road");
  });

  await testAsync("DEFAULT NAMING: an omitted name defaults to \"The Road to <toEntity's real name>\" when toEntityId resolves", async () => {
    const result = await createTransitEntity(dataDir, WORLD, { fromEntityId: "town-a", toEntityId: "town-b" });
    assert.equal(result.name, "The Road to Ashfall Keep");
  });

  await testAsync("throws (no entity created, no side effects) when fromEntityId does not exist in the live snapshot", async () => {
    const before = loadSnapshot(dataDir, WORLD).snapshot.entities.length;
    await assert.rejects(() => createTransitEntity(dataDir, WORLD, { fromEntityId: "does-not-exist", toEntityId: "town-b" }));
    const after = loadSnapshot(dataDir, WORLD).snapshot.entities.length;
    assert.equal(after, before, "a failed validation must create nothing");
  });

  await testAsync("throws (no entity created, no side effects) when toEntityId does not exist in the live snapshot", async () => {
    const before = loadSnapshot(dataDir, WORLD).snapshot.entities.length;
    await assert.rejects(() => createTransitEntity(dataDir, WORLD, { fromEntityId: "town-a", toEntityId: "does-not-exist" }));
    const after = loadSnapshot(dataDir, WORLD).snapshot.entities.length;
    assert.equal(after, before, "a failed validation must create nothing");
  });

  console.log(`\n${passed} test(s) passed.`);
  rmSync(scratchDir, { recursive: true, force: true });
})();
