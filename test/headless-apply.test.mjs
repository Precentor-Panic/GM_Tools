import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapSnapshot,
  applyHeadless,
  HeadlessApplyError,
  SNAPSHOT_SCHEMA_VERSION
} from "../graph-import/headless-apply.mjs";
import { ConcurrentWriteError } from "../mutation-engine/review-state.mjs";

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

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-headless-apply-test-"));

// ------------------------------------------------------------- bootstrapSnapshot

test("bootstrapSnapshot: on a non-existent path succeeds and produces a valid empty snapshot", () => {
  const snapshotPath = join(scratchDir, "worlds", "fresh-campaign", "world-fabric-snapshot.json");
  assert.equal(existsSync(snapshotPath), false, "precondition: path should not exist yet");

  const payload = bootstrapSnapshot(snapshotPath, { worldId: "fresh-campaign" });

  assert.equal(existsSync(snapshotPath), true, "bootstrapSnapshot should have created the file (and its parent dirs)");
  assert.equal(payload.meta.version, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(payload.meta.worldId, "fresh-campaign");
  assert.deepEqual(payload.snapshot.entities, []);
  assert.deepEqual(payload.snapshot.edges, []);
  assert.ok(Array.isArray(payload.snapshot.entityTypes) && payload.snapshot.entityTypes.length > 0,
    "entityTypes should be seeded with World Fabric's CORE_ENTITY_TYPES defaults, same as a brand-new in-Foundry world");
  assert.ok(payload.snapshot.entityTypes.some((t) => t.id === "person"));

  // Round-trips from disk correctly, not just the in-memory return value.
  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.deepEqual(onDisk, payload);
});

test("bootstrapSnapshot: defaults worldId to 'unknown' when not given", () => {
  const snapshotPath = join(scratchDir, "worlds", "no-id-given", "world-fabric-snapshot.json");
  const payload = bootstrapSnapshot(snapshotPath);
  assert.equal(payload.meta.worldId, "unknown");
});

// -------------------------------------------------- applyHeadless: fresh bootstrap

test("applyHeadless: a create mutation against a freshly-bootstrapped (empty) snapshot works", () => {
  const snapshotPath = join(scratchDir, "worlds", "fresh-apply", "world-fabric-snapshot.json");
  bootstrapSnapshot(snapshotPath, { worldId: "fresh-apply" });

  const result = applyHeadless(snapshotPath, [
    { op: "upsert_entity", data: { name: "Alvor", type: "person", importance: 0.5 } }
  ]);

  assert.equal(result.summary.entitiesCreated, 1);
  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.equal(onDisk.snapshot.entities.length, 1);
  assert.equal(onDisk.snapshot.entities[0].name, "Alvor");
  assert.equal(onDisk.meta.entityCount, 1);
});

// ------------------------------------ applyHeadless: ALREADY-POPULATED snapshot
//
// The realistic case (task 2.3's own explicit acceptance criterion, not just
// empty-then-apply): a snapshot file with genuine prior content already on
// disk before applyHeadless ever runs.

function writePopulatedFixture(snapshotPath) {
  const payload = {
    meta: {
      version: 1,
      worldId: "populated-world",
      sessionNumber: 4,
      exportedAt: "2026-01-01T00:00:00.000Z",
      entityCount: 3,
      edgeCount: 2,
      contextTokenEstimate: 0,
      mutationsInstruction: "..."
    },
    context: "",
    systemPrompt: "",
    snapshot: {
      entities: [
        { id: "alvor", name: "Alvor", type: "person", description: "The village smith.", summary: "A smith.", importance: 0.5, imageUrl: null, tags: ["npc"], attributes: {}, foundryRef: null, x: null, y: null, lastSession: null, sessionSeen: null, namespace: "campaign", rulesVerified: null, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", source: "manual" },
        { id: "gerdur", name: "Gerdur", type: "person", description: "Runs the mill.", summary: null, importance: 0.4, imageUrl: null, tags: [], attributes: {}, foundryRef: null, x: null, y: null, lastSession: null, sessionSeen: null, namespace: "campaign", rulesVerified: null, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", source: "manual" },
        { id: "riverwood", name: "Riverwood", type: "place", description: "A logging village.", summary: null, importance: 0.7, imageUrl: null, tags: [], attributes: {}, foundryRef: null, x: null, y: null, lastSession: null, sessionSeen: null, namespace: "campaign", rulesVerified: null, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", source: "manual" }
      ],
      edges: [
        { id: "e-alvor-gerdur", sourceId: "alvor", targetId: "gerdur", relationshipType: "kinship", label: "kinship", strength: 0.8, valence: "positive", source: "manual", notes: null, derivedFrom: null },
        { id: "e-alvor-riverwood", sourceId: "alvor", targetId: "riverwood", relationshipType: "presence", label: "presence", strength: 0.6, valence: "neutral", source: "manual", notes: null, derivedFrom: null }
      ],
      entityTypes: [{ id: "person", label: "Person" }, { id: "place", label: "Place" }]
    }
  };
  mkdirSync(join(snapshotPath, ".."), { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

test("applyHeadless: an update mutation against an ALREADY-POPULATED snapshot merges correctly, preserving untouched fields", () => {
  const snapshotPath = join(scratchDir, "worlds", "populated-update", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);

  const result = applyHeadless(snapshotPath, [
    { op: "upsert_entity", id: "alvor", data: { importance: 0.9, description: "Shaken by the siege." } }
  ]);

  assert.equal(result.summary.entitiesUpdated, 1);
  assert.equal(result.summary.entitiesCreated, 0);

  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.equal(onDisk.snapshot.entities.length, 3, "entity count should be unchanged -- this was an update, not a create");
  const alvor = onDisk.snapshot.entities.find((e) => e.id === "alvor");
  assert.equal(alvor.importance, 0.9, "the mutated field should be updated");
  assert.equal(alvor.description, "Shaken by the siege.", "the mutated field should be updated");
  assert.equal(alvor.name, "Alvor", "untouched fields must be PRESERVED from the prior on-disk content, not wiped");
  assert.equal(alvor.summary, "A smith.", "untouched fields must be preserved");
  assert.deepEqual(alvor.tags, ["npc"], "untouched fields must be preserved");

  // The other pre-existing entities/edges must survive completely untouched.
  const gerdur = onDisk.snapshot.entities.find((e) => e.id === "gerdur");
  assert.equal(gerdur.name, "Gerdur");
  assert.equal(onDisk.snapshot.edges.length, 2);
  const edge = onDisk.snapshot.edges.find((e) => e.id === "e-alvor-gerdur");
  assert.equal(edge.strength, 0.8, "pre-existing edge should be untouched by an unrelated entity mutation");
});

test("applyHeadless: a mutation with `id` only inside `data` (not top-level) still resolves against the existing record, rather than silently discarding the id and creating a duplicate (remediation-pass hardening)", () => {
  const snapshotPath = join(scratchDir, "worlds", "populated-id-in-data", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);

  // Malformed relative to mutation-engine/schema.mjs's Mutation shape (id
  // belongs top-level), but should still resolve correctly rather than
  // silently orphaning a new random-id record.
  const result = applyHeadless(snapshotPath, [
    { op: "upsert_entity", data: { id: "alvor", importance: 0.95 } }
  ]);

  assert.equal(result.summary.entitiesUpdated, 1);
  assert.equal(result.summary.entitiesCreated, 0, "must update the existing alvor record, not create a new one under a generated id");

  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.equal(onDisk.snapshot.entities.length, 3, "entity count should be unchanged");
  const alvor = onDisk.snapshot.entities.find((e) => e.id === "alvor");
  assert.equal(alvor.importance, 0.95);
  assert.equal(alvor.name, "Alvor", "untouched fields should still be preserved");
});

test("applyHeadless: an update mutation on an existing EDGE (sparse data, no sourceId/targetId) merges onto the current edge rather than being skipped", () => {
  const snapshotPath = join(scratchDir, "worlds", "populated-edge-update", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);

  // This is exactly the shape mutation-engine/texture.mjs would produce for
  // an ambient-decay edge update: `data` carries only the changed field.
  const result = applyHeadless(snapshotPath, [
    { op: "upsert_edge", id: "e-alvor-gerdur", data: { strength: 0.2 } }
  ]);

  assert.equal(result.summary.edgesUpdated, 1);
  assert.equal(result.summary.edgesSkipped, 0, "a sparse update patch must NOT be skipped for missing sourceId/targetId -- it should merge onto the existing edge first");

  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const edge = onDisk.snapshot.edges.find((e) => e.id === "e-alvor-gerdur");
  assert.equal(edge.strength, 0.2, "the mutated field should be updated");
  assert.equal(edge.sourceId, "alvor", "sourceId/targetId should be preserved from the existing edge, not lost");
  assert.equal(edge.targetId, "gerdur");
  assert.equal(edge.relationshipType, "kinship", "untouched edge fields should be preserved");
});

test("applyHeadless: a create mutation against an already-populated snapshot adds to (not replaces) existing content", () => {
  const snapshotPath = join(scratchDir, "worlds", "populated-create", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);

  applyHeadless(snapshotPath, [
    { op: "upsert_entity", data: { name: "A New Rumor", type: "concept", importance: 0.3 } }
  ]);

  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.equal(onDisk.snapshot.entities.length, 4, "should be prior 3 + 1 new, not just 1");
  assert.ok(onDisk.snapshot.entities.some((e) => e.name === "A New Rumor"));
  assert.ok(onDisk.snapshot.entities.some((e) => e.id === "alvor"), "prior content must survive a create");
});

test("applyHeadless: delete_entity cascades to that entity's own edges, matching graph-service.mjs's live behavior", () => {
  const snapshotPath = join(scratchDir, "worlds", "populated-delete", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);

  const result = applyHeadless(snapshotPath, [{ op: "delete_entity", id: "alvor" }]);

  assert.equal(result.deletedEntityCount, 1);
  assert.equal(result.deletedEdgeCount, 2, "both of alvor's edges should cascade-delete");

  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.equal(onDisk.snapshot.entities.some((e) => e.id === "alvor"), false);
  assert.equal(onDisk.snapshot.entities.length, 2, "gerdur and riverwood should survive");
  assert.equal(onDisk.snapshot.edges.length, 0, "both edges touching alvor should be gone");
});

test("applyHeadless: delete_edge removes only the targeted edge", () => {
  const snapshotPath = join(scratchDir, "worlds", "populated-delete-edge", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);

  const result = applyHeadless(snapshotPath, [{ op: "delete_edge", id: "e-alvor-gerdur" }]);
  assert.equal(result.deletedEdgeCount, 1);

  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.equal(onDisk.snapshot.edges.length, 1);
  assert.equal(onDisk.snapshot.edges[0].id, "e-alvor-riverwood");
  assert.equal(onDisk.snapshot.entities.length, 3, "deleting an edge must not delete its endpoint entities");
});

test("applyHeadless: upsert_type merges into entityTypes (additive, matching importGraph's own merge-by-id semantics)", () => {
  const snapshotPath = join(scratchDir, "worlds", "populated-upsert-type", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);

  applyHeadless(snapshotPath, [
    { op: "upsert_type", data: { id: "faction", label: "Faction" } }
  ]);

  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.ok(onDisk.snapshot.entityTypes.some((t) => t.id === "faction"));
  assert.ok(onDisk.snapshot.entityTypes.some((t) => t.id === "person"), "existing types must be preserved, not replaced");
});

test("applyHeadless: upsert_relationship_type is reported as skipped, not silently dropped or crashed on", () => {
  const snapshotPath = join(scratchDir, "worlds", "populated-rel-type", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);

  const result = applyHeadless(snapshotPath, [
    { op: "upsert_relationship_type", data: { key: "rivalry", label: "Rivalry" } }
  ]);

  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].op, "upsert_relationship_type");
  assert.ok(result.skipped[0].reason.length > 0);
});

// ------------------------------------------------------------------------- errors

test("applyHeadless: throws HeadlessApplyError for a nonexistent snapshot path (no bootstrap yet)", () => {
  const snapshotPath = join(scratchDir, "worlds", "never-bootstrapped", "world-fabric-snapshot.json");
  assert.throws(() => applyHeadless(snapshotPath, []), (err) => {
    assert.ok(err instanceof HeadlessApplyError);
    return true;
  });
});

test("applyHeadless: throws for an upsert_edge create with no sourceId/targetId, rather than silently skipping it", () => {
  const snapshotPath = join(scratchDir, "worlds", "populated-bad-edge", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);
  assert.throws(
    () => applyHeadless(snapshotPath, [{ op: "upsert_edge", data: { relationshipType: "social", strength: 0.5 } }]),
    (err) => {
      assert.ok(err instanceof HeadlessApplyError);
      assert.equal(err.op, "upsert_edge");
      return true;
    }
  );
});

// ------------------------------------------------------- idAssignments (Phase 4 task 4.1)

test("applyHeadless: an id-less upsert_entity (genuine create) is reported in idAssignments, keyed by its position in `mutations`", () => {
  const snapshotPath = join(scratchDir, "worlds", "id-assign-entity", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);

  const result = applyHeadless(snapshotPath, [
    { op: "upsert_entity", data: { name: "A New Rumor", type: "concept", importance: 0.3 } }
  ]);

  assert.equal(typeof result.idAssignments, "object");
  const assignedId = result.idAssignments["0"];
  assert.ok(assignedId && typeof assignedId === "string", "the create at index 0 should have an assigned id reported");
  assert.match(assignedId, /^wf_/, "should follow the same wf_<ts>_<n> convention interchange.mjs's own id generator uses");

  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const created = onDisk.snapshot.entities.find((e) => e.name === "A New Rumor");
  assert.ok(created, "the created entity should actually be on disk");
  assert.equal(created.id, assignedId, "the id reported in idAssignments must be the SAME id the entity actually got");
});

test("applyHeadless: an id-less upsert_edge (genuine create) is reported in idAssignments too", () => {
  const snapshotPath = join(scratchDir, "worlds", "id-assign-edge", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);

  const result = applyHeadless(snapshotPath, [
    { op: "upsert_edge", data: { sourceId: "alvor", targetId: "riverwood", relationshipType: "social", strength: 0.4 } }
  ]);

  const assignedId = result.idAssignments["0"];
  assert.ok(assignedId, "the edge create at index 0 should have an assigned id reported");

  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const created = onDisk.snapshot.edges.find((e) => e.relationshipType === "social" && e.strength === 0.4);
  assert.ok(created, "the created edge should actually be on disk");
  assert.equal(created.id, assignedId);
});

test("applyHeadless: idAssignments is keyed by index -- mixing an update (no assignment) and a create (assignment) reports only the create, at its own index", () => {
  const snapshotPath = join(scratchDir, "worlds", "id-assign-mixed", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);

  const result = applyHeadless(snapshotPath, [
    { op: "upsert_entity", id: "alvor", data: { importance: 0.6 } }, // index 0: update, known id, no assignment
    { op: "upsert_entity", data: { name: "Another New Thing", type: "object" } } // index 1: genuine create
  ]);

  assert.equal(Object.hasOwn(result.idAssignments, "0"), false, "an update with a known id must not get an assignment entry");
  assert.ok(Object.hasOwn(result.idAssignments, "1"), "the create at index 1 should be reported");

  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const created = onDisk.snapshot.entities.find((e) => e.name === "Another New Thing");
  assert.equal(created.id, result.idAssignments["1"]);
});

test("applyHeadless: idAssignments is an empty object when every mutation already targets a known id", () => {
  const snapshotPath = join(scratchDir, "worlds", "id-assign-none", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);

  const result = applyHeadless(snapshotPath, [
    { op: "upsert_entity", id: "alvor", data: { importance: 0.6 } }
  ]);

  assert.deepEqual(result.idAssignments, {});
});

test("applyHeadless: multiple genuine creates in one call each get distinct, non-colliding ids (no counter collision with importGraph's own internal id generation)", () => {
  const snapshotPath = join(scratchDir, "worlds", "id-assign-multi", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);

  const result = applyHeadless(snapshotPath, [
    { op: "upsert_entity", data: { name: "First New Thing", type: "object" } },
    { op: "upsert_entity", data: { name: "Second New Thing", type: "object" } },
    { op: "upsert_entity", data: { name: "Third New Thing", type: "object" } }
  ]);

  const ids = [result.idAssignments["0"], result.idAssignments["1"], result.idAssignments["2"]];
  assert.equal(new Set(ids).size, 3, "all three assigned ids must be distinct");

  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.equal(onDisk.snapshot.entities.length, 6, "prior 3 + 3 new");
  const allIds = onDisk.snapshot.entities.map((e) => e.id);
  assert.equal(new Set(allIds).size, allIds.length, "no id collisions anywhere on disk");
});

// ------------------------------------------------------- idResolution (QA W1 Fix 2)

test("applyHeadless: idResolution reports the requested id itself when there's no name+type collision (the common case)", () => {
  const snapshotPath = join(scratchDir, "worlds", "id-resolution-no-collision", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);

  const result = applyHeadless(snapshotPath, [
    { op: "upsert_entity", id: "wf_preassigned_1", data: { id: "wf_preassigned_1", name: "A Brand New Thing", type: "concept" } }
  ]);

  assert.equal(result.idResolution["0"], "wf_preassigned_1");
  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.ok(onDisk.snapshot.entities.some((e) => e.id === "wf_preassigned_1"), "the requested id must be the one actually persisted");
});

test("applyHeadless: idResolution reports the SURVIVOR entity's real id -- not the requested id -- when a name+type collision folds the create into an existing entity", () => {
  const snapshotPath = join(scratchDir, "worlds", "id-resolution-collision", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath); // has an existing {id:"alvor", name:"Alvor", type:"person"}

  const result = applyHeadless(snapshotPath, [
    // A genuine create's own pre-assigned id, but same type+name (case/whitespace-insensitive, mirroring
    // interchange.mjs's own findExisting()) as the fixture's pre-existing "alvor" entity.
    { op: "upsert_entity", id: "wf_phantom_id", data: { id: "wf_phantom_id", name: "  alvor  ", type: "person", description: "A second Alvor?" } }
  ]);

  assert.equal(result.idResolution["0"], "alvor", "must report the EXISTING entity's real id, not the discarded phantom");
  assert.notEqual(result.idResolution["0"], "wf_phantom_id");

  const onDisk = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.equal(onDisk.snapshot.entities.length, 3, "no second entity should have been created");
  assert.equal(onDisk.snapshot.entities.some((e) => e.id === "wf_phantom_id"), false, "the phantom id must not exist anywhere on disk");
  const survivor = onDisk.snapshot.entities.find((e) => e.id === "alvor");
  assert.equal(survivor.description, "A second Alvor?", "the collision still merges the incoming fields onto the survivor, same as before this fix");
});

test("applyHeadless: idResolution covers an id-less (assignedId) genuine create too, not just a pre-supplied id", () => {
  const snapshotPath = join(scratchDir, "worlds", "id-resolution-assigned", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);

  const result = applyHeadless(snapshotPath, [
    { op: "upsert_entity", data: { name: "Something Else Entirely", type: "object" } }
  ]);

  const assignedId = result.idAssignments["0"];
  assert.equal(result.idResolution["0"], assignedId);
});

test("applyHeadless: idResolution has no entry for upsert_edge mutations (edges never merge-fold by name)", () => {
  const snapshotPath = join(scratchDir, "worlds", "id-resolution-edge", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);

  const result = applyHeadless(snapshotPath, [
    { op: "upsert_edge", data: { sourceId: "alvor", targetId: "riverwood", relationshipType: "social" } }
  ]);

  assert.equal(Object.hasOwn(result.idResolution, "0"), false);
});

test("applyHeadless: throws for an unknown mutation op", () => {
  const snapshotPath = join(scratchDir, "worlds", "populated-bad-op", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);
  assert.throws(
    () => applyHeadless(snapshotPath, [{ op: "not_a_real_op", id: "x" }]),
    (err) => err instanceof HeadlessApplyError
  );
});

test("applyHeadless: a held lock (a concurrent sync, or a crashed process) rejects with a clear HeadlessApplyError instead of racing the write, and never touches the file on disk", () => {
  const snapshotPath = join(scratchDir, "worlds", "locked-snapshot", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);
  const before = readFileSync(snapshotPath, "utf8");

  const lockPath = `${snapshotPath}.lock`;
  const fd = openSync(lockPath, "wx");
  try {
    assert.throws(
      () => applyHeadless(snapshotPath, [{ op: "upsert_entity", data: { name: "Should not land", type: "person" } }]),
      (err) => err instanceof HeadlessApplyError && /locked/i.test(err.message)
    );
    assert.equal(readFileSync(snapshotPath, "utf8"), before, "the snapshot file must be untouched by the rejected write");
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }

  // Once the lock clears, a normal apply succeeds -- confirms this isn't a
  // permanently-broken lock path, just a real held one being respected.
  const result = applyHeadless(snapshotPath, [{ op: "upsert_entity", data: { name: "Lands fine now", type: "person" } }]);
  assert.equal(result.summary.entitiesCreated, 1);
});

// ------------------------------------------------ W2e: unresolved-endpoint stubs

test("W2e: an accepted edge with a dangling internal-id endpoint gets a legible 'Unresolved: <ref>' stub, tagged and reported -- never a bare id as a name", () => {
  const snapshotPath = join(scratchDir, "worlds", "w2e-dangling", "world-fabric-snapshot.json");
  bootstrapSnapshot(snapshotPath, { worldId: "w2e-dangling" });
  applyHeadless(snapshotPath, [
    { op: "upsert_entity", data: { id: "wf_real_0", name: "The Lowway", type: "place" } }
  ]);
  // The real kilmarn shape: the "Master Vane" create (pre-assigned id
  // wf_mssa9fia_0) was rejected, but an accepted edge still references it.
  const result = applyHeadless(snapshotPath, [
    { op: "upsert_edge", data: { sourceId: "wf_mssa9fia_0", targetId: "wf_real_0", relationshipType: "presence" } }
  ]);

  assert.deepEqual(result.unresolvedStubs, [
    { id: "wf_mssa9fia_0", name: "Unresolved: wf_mssa9fia_0", ref: "wf_mssa9fia_0" }
  ]);

  const snap = JSON.parse(readFileSync(snapshotPath, "utf8")).snapshot;
  const stub = snap.entities.find((e) => e.id === "wf_mssa9fia_0");
  assert.ok(stub, "stub exists under the dangling id (so a later sync of the real create heals it in place)");
  assert.equal(stub.name, "Unresolved: wf_mssa9fia_0", "legible flagged name -- the raw id never becomes a name");
  assert.ok(stub.tags.includes("unresolved-reference"), "tagged for review/world surfaces");
  assert.ok(!snap.entities.some((e) => e.name === "wf_mssa9fia_0"), "no entity anywhere named by the bare id");

  const edge = snap.edges.find((e) => e.targetId === "wf_real_0");
  assert.equal(edge.sourceId, "wf_mssa9fia_0", "the edge wires to the stub, not skipped");
});

test("W2e: a later sync of the original create heals the stub in place (merge by id), leaving no duplicate", () => {
  const snapshotPath = join(scratchDir, "worlds", "w2e-heal", "world-fabric-snapshot.json");
  bootstrapSnapshot(snapshotPath, { worldId: "w2e-heal" });
  applyHeadless(snapshotPath, [
    { op: "upsert_entity", data: { id: "wf_real_0", name: "The Lowway", type: "place" } },
    { op: "upsert_edge", data: { sourceId: "wf_mssb0aaa_0", targetId: "wf_real_0", relationshipType: "presence" } }
  ]);
  // The GM later un-rejects/re-proposes the create with the SAME pre-assigned id.
  applyHeadless(snapshotPath, [
    { op: "upsert_entity", id: "wf_mssb0aaa_0", data: { name: "Master Aldric Vane", type: "person", description: "Guildmaster." } }
  ]);
  const snap = JSON.parse(readFileSync(snapshotPath, "utf8")).snapshot;
  const healed = snap.entities.filter((e) => e.id === "wf_mssb0aaa_0");
  assert.equal(healed.length, 1);
  assert.equal(healed[0].name, "Master Aldric Vane", "the real entity replaced the placeholder name");
  assert.ok(!snap.entities.some((e) => String(e.name).startsWith("Unresolved:")), "no placeholder left behind");
});

test("W2e: a NAME-like dangling ref keeps importGraph's own legible stub-by-name behavior (no 'Unresolved:' prefix, not reported)", () => {
  const snapshotPath = join(scratchDir, "worlds", "w2e-name-ref", "world-fabric-snapshot.json");
  bootstrapSnapshot(snapshotPath, { worldId: "w2e-name-ref" });
  applyHeadless(snapshotPath, [
    { op: "upsert_entity", data: { id: "wf_real_0", name: "The Lowway", type: "place" } }
  ]);
  const result = applyHeadless(snapshotPath, [
    { op: "upsert_edge", data: { sourceId: "The Underbreach", targetId: "wf_real_0", relationshipType: "containment" } }
  ]);
  assert.deepEqual(result.unresolvedStubs, [], "a name ref is a normal WFI stub, not a W2e placeholder");
  const snap = JSON.parse(readFileSync(snapshotPath, "utf8")).snapshot;
  assert.ok(snap.entities.some((e) => e.name === "The Underbreach"), "importGraph's stub-by-name behavior unchanged");
});

test("W2e: resolvable endpoints (by id or by name, existing or same-call) mint no stubs at all", () => {
  const snapshotPath = join(scratchDir, "worlds", "w2e-resolvable", "world-fabric-snapshot.json");
  bootstrapSnapshot(snapshotPath, { worldId: "w2e-resolvable" });
  const result = applyHeadless(snapshotPath, [
    { op: "upsert_entity", data: { id: "wf_a_0", name: "A", type: "place" } },
    { op: "upsert_entity", data: { id: "wf_b_0", name: "B", type: "place" } },
    { op: "upsert_edge", data: { sourceId: "wf_a_0", targetId: "wf_b_0", relationshipType: "containment" } }
  ]);
  assert.deepEqual(result.unresolvedStubs, []);
  const snap = JSON.parse(readFileSync(snapshotPath, "utf8")).snapshot;
  assert.equal(snap.entities.length, 2, "exactly the two real entities, no stubs");
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
