import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapSnapshot,
  applyHeadless,
  HeadlessApplyError,
  SNAPSHOT_SCHEMA_VERSION
} from "../graph-import/headless-apply.mjs";

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

test("applyHeadless: throws for an unknown mutation op", () => {
  const snapshotPath = join(scratchDir, "worlds", "populated-bad-op", "world-fabric-snapshot.json");
  writePopulatedFixture(snapshotPath);
  assert.throws(
    () => applyHeadless(snapshotPath, [{ op: "not_a_real_op", id: "x" }]),
    (err) => err instanceof HeadlessApplyError
  );
});

console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
