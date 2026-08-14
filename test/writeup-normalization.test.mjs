import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same isolation pattern as test/writeup-import.test.mjs: point the
// review-state store at a scratch dir BEFORE any batch-writing call runs.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-writeup-normalization-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = scratchDir;

const {
  normalizeProposalNameNearMisses,
  normalizeProposalAgainstSnapshot,
  WRITEUP_NAME_REWRITE_THRESHOLD,
  importWriteup
} = await import("../graph-import/writeup-import.mjs");
const { FUZZY_MATCH_THRESHOLD } = await import("../graph-import/name-similarity.mjs");
const { summarizeBatch } = await import("../mutation-engine/grain.mjs");
const { loadBatch } = await import("../mutation-engine/review-state.mjs");

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push(
    (async () => {
      try {
        await fn();
        passed++;
        console.log(`  ok  ${name}`);
      } catch (err) {
        console.error(`FAIL  ${name}`);
        console.error(err.stack || err.message);
        process.exitCode = 1;
      }
    })()
  );
}

// ---------------------------------------------------------------------------
// REAL fixture material: entity names/types/ids copied from the actual
// kilmarn world snapshot (world-fabric-snapshot.json) as it stood when the
// live exercise's seed-3a/3b batches (batch_mssa9fid_zldbi0 /
// batch_mssaf1h2_r7ft5v) produced their duplicate creates. The proposal
// names below are the EXACT strings the real extractions emitted — this
// file is the regression guard that every one of those real dup cases now
// normalizes into a merge.
// ---------------------------------------------------------------------------
const KILMARN_CANON = [
  { id: "wf_mss38vnb_0", name: "Kilmarn", type: "place" },
  { id: "wf_mss38vnc_1", name: "The Skein", type: "concept" },
  { id: "wf_mss38vnc_4", name: "The Tangle", type: "place" },
  { id: "wf_mss38vnc_5", name: "The Span", type: "place" },
  { id: "wf_mss38vnc_6", name: "The Loom", type: "place" },
  { id: "wf_mss38vnc_8", name: "The Underbreach", type: "place" },
  { id: "wf_mss38vnc_9", name: "Kilmarn Trade Council", type: "faction" },
  { id: "wf_mss38vnc_b", name: "Dyers' Hall", type: "place" },
  { id: "wf_mss38vnc_d", name: "Founding Charter", type: "object" },
  { id: "wf_mss38vnc_f", name: "Guild Seal", type: "object" },
  { id: "wf_mss38vnc_i", name: "The Lowway", type: "place" },
  { id: "wf_mss38vnc_j", name: "Kilmarn Bridge", type: "object" },
  { id: "wf_mss975nf_0", name: "Sable Orren", type: "person" },
  { id: "wf_mss975ng_8", name: "Master Aldric Vane", type: "person" },
  { id: "wf_mss975ng_9", name: "Contract Ledger", type: "object" },
  { id: "wf_mss975ng_a", name: "Seal Ring", type: "object" },
  { id: "wf_mss975ng_b", name: "The Interest", type: "person" },
  { id: "wf_mssa9fib_1", name: "Thread T-1", type: "object" },
  { id: "wf_mssa9fib_3", name: "Thread P-1", type: "object" },
  { id: "wf_mssa9fib_4", name: "Thread P-2", type: "object" }
];

function proposalEntity(name, type, extra = {}) {
  return { name, type, rationale: "test fixture", ...extra };
}

test("threshold sits deliberately above the advisory chip threshold", () => {
  assert.ok(
    WRITEUP_NAME_REWRITE_THRESHOLD > FUZZY_MATCH_THRESHOLD,
    "auto-rewrite must be more conservative than W1a's advisory chips"
  );
});

test("W2a real Kilmarn case: leading article — 'Lowway' rewrites to canon 'The Lowway'", () => {
  const { proposal, rewrites } = normalizeProposalNameNearMisses(
    { entities: [proposalEntity("Lowway", "place")], edges: [] },
    KILMARN_CANON
  );
  assert.equal(proposal.entities[0].name, "The Lowway");
  assert.equal(proposal.entities[0].writeupNormalization.kind, "near-miss-rename");
  assert.equal(proposal.entities[0].writeupNormalization.from, "Lowway");
  assert.equal(proposal.entities[0].writeupNormalization.entityId, "wf_mss38vnc_i");
  assert.equal(rewrites.length, 1);
});

test("W2a real Kilmarn case: possessive — 'Vane's Seal Ring' rewrites to canon 'Seal Ring'", () => {
  const { proposal } = normalizeProposalNameNearMisses(
    { entities: [proposalEntity("Vane's Seal Ring", "object")], edges: [] },
    KILMARN_CANON
  );
  assert.equal(proposal.entities[0].name, "Seal Ring");
  assert.equal(proposal.entities[0].writeupNormalization.entityId, "wf_mss975ng_a");
});

test("W2a real Kilmarn case: subset-of-canon-name — 'Master Vane' and 'Trade Council'", () => {
  const { proposal } = normalizeProposalNameNearMisses(
    {
      entities: [
        proposalEntity("Master Vane", "person"),
        proposalEntity("Trade Council", "faction")
      ],
      edges: []
    },
    KILMARN_CANON
  );
  assert.equal(proposal.entities[0].name, "Master Aldric Vane");
  assert.equal(proposal.entities[0].writeupNormalization.entityId, "wf_mss975ng_8");
  assert.equal(proposal.entities[1].name, "Kilmarn Trade Council");
  assert.equal(proposal.entities[1].writeupNormalization.entityId, "wf_mss38vnc_9");
});

test("W2a real Kilmarn case: 'X of <world>' suffix — 'Founding Charter of Kilmarn' rewrites to canon 'Founding Charter'", () => {
  const { proposal } = normalizeProposalNameNearMisses(
    { entities: [proposalEntity("Founding Charter of Kilmarn", "object")], edges: [] },
    KILMARN_CANON
  );
  assert.equal(proposal.entities[0].name, "Founding Charter");
  assert.equal(proposal.entities[0].writeupNormalization.entityId, "wf_mss38vnc_d");
});

test("W2a real Kilmarn extras: 'Guild Seal (Dyers' Hall)' (parenthetical) and 'Vane's Contract Ledger' (possessive) both rewrite", () => {
  const { proposal } = normalizeProposalNameNearMisses(
    {
      entities: [
        proposalEntity("Guild Seal (Dyers' Hall)", "object"),
        proposalEntity("Vane's Contract Ledger", "object")
      ],
      edges: []
    },
    KILMARN_CANON
  );
  assert.equal(proposal.entities[0].name, "Guild Seal");
  assert.equal(proposal.entities[1].name, "Contract Ledger");
});

test("edges referencing a rewritten name are re-pointed to the canon name (case-insensitively)", () => {
  const { proposal } = normalizeProposalNameNearMisses(
    {
      entities: [proposalEntity("Master Vane", "person"), proposalEntity("The Shuttered Shop", "place")],
      edges: [
        { source: "master vane", target: "The Shuttered Shop", relationshipType: "presence", rationale: "r" },
        { source: "The Shuttered Shop", target: "Master Vane", relationshipType: "ownership", rationale: "r" }
      ]
    },
    KILMARN_CANON
  );
  assert.equal(proposal.edges[0].source, "Master Aldric Vane");
  assert.equal(proposal.edges[0].target, "The Shuttered Shop", "an untouched name stays untouched");
  assert.equal(proposal.edges[1].target, "Master Aldric Vane");
});

test("conservatism: same-type only — a cross-type containment near-miss is never rewritten", () => {
  // 'Underbreach Unsealing' (event) contains canon 'The Underbreach' (place)
  // token-wise... actually containment requires ALL shorter-name tokens in the
  // longer; 'underbreach' ⊂ {underbreach, unsealing} holds. Type differs, so
  // nothing may happen.
  const { proposal, rewrites } = normalizeProposalNameNearMisses(
    { entities: [proposalEntity("Underbreach Unsealing", "event")], edges: [] },
    KILMARN_CANON
  );
  assert.equal(proposal.entities[0].name, "Underbreach Unsealing");
  assert.equal(proposal.entities[0].writeupNormalization, undefined);
  assert.equal(rewrites.length, 0);
});

test("conservatism: below the confident threshold nothing is rewritten (advisory chips' territory)", () => {
  // 'Thread P-3' vs canon 'Thread P-1'/'Thread P-2' — genuinely new sibling,
  // score ~0.5. The real seed-3b batch created it correctly; it must stay a create.
  const { proposal, rewrites } = normalizeProposalNameNearMisses(
    { entities: [proposalEntity("Thread P-3", "object")], edges: [] },
    KILMARN_CANON
  );
  assert.equal(proposal.entities[0].name, "Thread P-3");
  assert.equal(rewrites.length, 0);
});

test("conservatism: a score tie between two distinct existing entities rewrites nothing", () => {
  // Construct two same-type canon entities that BOTH contain the extracted
  // name's tokens at an identical ratio — ambiguous, so hands off.
  const canon = [
    { id: "e1", name: "Old Mill North", type: "place" },
    { id: "e2", name: "Old Mill South", type: "place" }
  ];
  const { proposal, rewrites } = normalizeProposalNameNearMisses(
    { entities: [proposalEntity("Old Mill", "place")], edges: [] },
    canon
  );
  assert.equal(proposal.entities[0].name, "Old Mill");
  assert.equal(rewrites.length, 0);
});

test("conservatism: no rewrite when the canon name is already its own proposal item (no silent collapse of two rows into one)", () => {
  const { proposal, rewrites } = normalizeProposalNameNearMisses(
    {
      entities: [
        proposalEntity("Master Aldric Vane", "person"),
        proposalEntity("Master Vane", "person")
      ],
      edges: []
    },
    KILMARN_CANON
  );
  assert.equal(proposal.entities[1].name, "Master Vane", "would collapse onto the sibling row — left for the advisory chips");
  assert.equal(rewrites.length, 0);
});

test("an exact name match (any type) is not this pass's territory — left completely alone", () => {
  // Exact name+type: importGraph's own dedup already merges it. Exact name,
  // different type ('Kilmarn Bridge' place-vs-object): W2b's resolution, not
  // a near-miss rename.
  const { proposal, rewrites } = normalizeProposalNameNearMisses(
    {
      entities: [
        proposalEntity("The Lowway", "place"),
        proposalEntity("Kilmarn Bridge", "place")
      ],
      edges: []
    },
    KILMARN_CANON
  );
  assert.equal(proposal.entities[0].name, "The Lowway");
  assert.equal(proposal.entities[0].writeupNormalization, undefined);
  assert.equal(proposal.entities[1].name, "Kilmarn Bridge");
  assert.equal(rewrites.length, 0);
});

test("the input proposal object is not mutated (pure pass)", () => {
  const input = { entities: [proposalEntity("Lowway", "place")], edges: [] };
  normalizeProposalNameNearMisses(input, KILMARN_CANON);
  assert.equal(input.entities[0].name, "Lowway");
  assert.equal(input.entities[0].writeupNormalization, undefined);
});

// ---------------------------------------------------------------------------
// End-to-end: importWriteup with a mocked extraction whose output contains a
// real Kilmarn near-miss — the batch must contain an UPDATE of the existing
// entity (not a duplicate create), carrying the normalization record that
// grain.mjs surfaces on batch-detail rows.
// ---------------------------------------------------------------------------
function mockClient(responses) {
  let call = 0;
  return {
    messages: {
      create: async () => {
        const resp = responses[Math.min(call, responses.length - 1)];
        call++;
        return { content: [{ type: "text", text: resp }], stop_reason: "end_turn" };
      }
    }
  };
}

test("importWriteup end-to-end: a near-miss create dedups into an update of the existing entity, normalization surfaced on the batch row", async () => {
  const snapshot = {
    entities: KILMARN_CANON.map((e) => ({ ...e, description: "canon text", importance: 0.5 })),
    edges: [],
    entityTypes: []
  };
  const extraction = JSON.stringify({
    entities: [
      { name: "Lowway", type: "place", description: "A sunken commercial street.", rationale: "Mentioned as 'off the Lowway'." },
      { name: "Brand-New Shrine", type: "place", description: "A new shrine.", rationale: "Introduced fresh." }
    ],
    edges: [
      { source: "Brand-New Shrine", target: "Lowway", relationshipType: "containment", rationale: "The shrine sits off the Lowway." }
    ]
  });
  const result = await importWriteup("norm-test-world", "…seed text…", snapshot, {
    llmOpts: { client: mockClient([extraction]) }
  });

  const batch = loadBatch("norm-test-world", result.batchId);
  const lowway = batch.mutations.find((m) => m.data?.name === "The Lowway");
  assert.ok(lowway, "the extracted 'Lowway' resolved to canon 'The Lowway'");
  assert.equal(lowway.id, "wf_mss38vnc_i", "targets the EXISTING entity — an update, not a duplicate create");
  assert.notEqual(lowway.diff?.[0]?.field, "(created)", "diffs as an update against the live snapshot");
  assert.equal(lowway.entityContext.writeupNormalization.kind, "near-miss-rename");
  assert.equal(lowway.entityContext.writeupNormalization.from, "Lowway");

  // No duplicate 'Lowway' create anywhere in the batch.
  assert.ok(!batch.mutations.some((m) => m.data?.name === "Lowway"), "no duplicate create for the shorthand name");

  // The edge referencing the old name resolved to the existing entity's id
  // (importGraph resolves the rewritten name), not to a fresh stub.
  const edge = batch.mutations.find((m) => m.op === "upsert_edge");
  assert.equal(edge.data.targetId, "wf_mss38vnc_i", "edge re-pointed to the canon entity");

  // grain.mjs surfaces the record on the batch-detail row (what
  // batchDetailPayload spreads into the review card's data).
  const summary = summarizeBatch(batch);
  const rows = summary.regions.flatMap((r) => r.entities);
  const row = rows.find((r) => r.mutationId === lowway.mutationId);
  assert.equal(row.writeupNormalization.kind, "near-miss-rename");
  const shrineRow = rows.find((r) => r.name === "Brand-New Shrine");
  assert.equal(shrineRow.writeupNormalization, null, "an untouched create carries no normalization record");
});

// ---------------------------------------------------------------------------
// W2b: exact name + different extracted type — the real Kilmarn misses
// "Kilmarn Bridge" (batch `place` vs canon `object`, seed 3a) and
// "The Interest" (batch `faction` vs canon `person`, seed 3b).
// ---------------------------------------------------------------------------

test("W2b real Kilmarn case: 'Kilmarn Bridge' extracted as place resolves onto the canon object, keeping ITS type", async () => {
  const { normalizeProposalTypeConflicts } = await import("../graph-import/writeup-import.mjs");
  const { proposal, resolutions } = normalizeProposalTypeConflicts(
    { entities: [proposalEntity("Kilmarn Bridge", "place")], edges: [] },
    KILMARN_CANON
  );
  const pe = proposal.entities[0];
  assert.equal(pe.type, "object", "canon keeps its type — never retyped by an extraction guess");
  assert.equal(pe.name, "Kilmarn Bridge");
  assert.deepEqual(pe.writeupNormalization, {
    kind: "type-conflict-resolved",
    name: "Kilmarn Bridge",
    extractedType: "place",
    keptType: "object",
    entityId: "wf_mss38vnc_j"
  });
  assert.equal(resolutions.length, 1);
});

test("W2b real Kilmarn case: 'The Interest' extracted as faction resolves onto the canon person", async () => {
  const { normalizeProposalTypeConflicts } = await import("../graph-import/writeup-import.mjs");
  const { proposal } = normalizeProposalTypeConflicts(
    { entities: [proposalEntity("The Interest", "faction")], edges: [] },
    KILMARN_CANON
  );
  assert.equal(proposal.entities[0].type, "person");
  assert.equal(proposal.entities[0].writeupNormalization.entityId, "wf_mss975ng_b");
});

test("W2b conservatism: a same-type exact match is left to plain dedup; two differently-typed same-name entities are ambiguous", async () => {
  const { normalizeProposalTypeConflicts } = await import("../graph-import/writeup-import.mjs");
  const canon = [
    { id: "a1", name: "The Ford", type: "place" },
    { id: "a2", name: "The Ford", type: "event" }
  ];
  const { proposal, resolutions } = normalizeProposalTypeConflicts(
    {
      entities: [
        proposalEntity("Kilmarn Bridge", "object"), // exact name+type match — plain dedup territory
        proposalEntity("The Ford", "faction") // ambiguous: two differently-typed canon entities share the name
      ],
      edges: []
    },
    [...KILMARN_CANON, ...canon]
  );
  assert.equal(proposal.entities[0].writeupNormalization, undefined);
  assert.equal(proposal.entities[0].type, "object");
  assert.equal(proposal.entities[1].writeupNormalization, undefined);
  assert.equal(proposal.entities[1].type, "faction");
  assert.equal(resolutions.length, 0);
});

test("W2b conservatism: no resolution when the canon name+type is already its own proposal item", async () => {
  const { normalizeProposalTypeConflicts } = await import("../graph-import/writeup-import.mjs");
  const { proposal, resolutions } = normalizeProposalTypeConflicts(
    {
      entities: [
        proposalEntity("Kilmarn Bridge", "object"),
        proposalEntity("Kilmarn Bridge", "place")
      ],
      edges: []
    },
    KILMARN_CANON
  );
  assert.equal(proposal.entities[1].type, "place", "would collapse onto the sibling row — left alone");
  assert.equal(resolutions.length, 0);
});

test("W2b: the combined wrapper resolves type conflicts first, then near-misses, and reports both", () => {
  const { proposal, rewrites, typeResolutions } = normalizeProposalAgainstSnapshot(
    {
      entities: [
        proposalEntity("Kilmarn Bridge", "place"), // W2b case
        proposalEntity("Master Vane", "person") // W2a case
      ],
      edges: []
    },
    KILMARN_CANON
  );
  assert.equal(proposal.entities[0].type, "object");
  assert.equal(proposal.entities[0].writeupNormalization.kind, "type-conflict-resolved");
  assert.equal(proposal.entities[1].name, "Master Aldric Vane");
  assert.equal(proposal.entities[1].writeupNormalization.kind, "near-miss-rename");
  assert.equal(typeResolutions.length, 1);
  assert.equal(rewrites.length, 1);
});

test("W2b end-to-end: importWriteup turns an exact-name/different-type guess into an update of the existing entity, suggestion surfaced on the row", async () => {
  const snapshot = {
    entities: KILMARN_CANON.map((e) => ({ ...e, description: "canon text", importance: 0.5 })),
    edges: [],
    entityTypes: []
  };
  const extraction = JSON.stringify({
    entities: [
      {
        name: "Kilmarn Bridge",
        type: "place",
        description: "canon text Threads are tied to the central span during the ceremony.",
        rationale: "The bridge hosts the mooring ceremony."
      }
    ],
    edges: []
  });
  const result = await importWriteup("norm-test-world-w2b", "…seed text…", snapshot, {
    llmOpts: { client: mockClient([extraction]) }
  });

  const batch = loadBatch("norm-test-world-w2b", result.batchId);
  const bridge = batch.mutations.find((m) => m.data?.name === "Kilmarn Bridge");
  assert.equal(bridge.id, "wf_mss38vnc_j", "targets the EXISTING entity — never a silent duplicate create");
  assert.equal(bridge.data.type, "object", "the existing entity's type is kept");
  assert.notEqual(bridge.diff?.[0]?.field, "(created)");
  assert.equal(bridge.entityContext.writeupNormalization.kind, "type-conflict-resolved");

  const rows = summarizeBatch(batch).regions.flatMap((r) => r.entities);
  const row = rows.find((r) => r.mutationId === bridge.mutationId);
  assert.equal(row.writeupNormalization.kind, "type-conflict-resolved");
  assert.equal(row.writeupNormalization.extractedType, "place");
});

await Promise.all(pending);
console.log(`\n${passed} passed`);
