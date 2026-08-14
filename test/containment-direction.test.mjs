import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same isolation pattern as test/writeup-normalization.test.mjs: point the
// review-state store at a scratch dir BEFORE any batch-writing call runs.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-containment-direction-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = scratchDir;

const {
  normalizeProposalContainmentDirection,
  normalizeProposalAgainstSnapshot,
  importWriteup
} = await import("../graph-import/writeup-import.mjs");
const { summarizeBatch } = await import("../mutation-engine/grain.mjs");
const { loadBatch } = await import("../mutation-engine/review-state.mjs");

// ---------------------------------------------------------------------------
// Friction Wave 1, W5a (import half) — deterministic containment-DIRECTION
// normalization for proposed edges. The tree convention is child = source ->
// parent = target (world-view.js/world-tree.mjs); the REAL bug: the Kilmarn
// stage-1 extraction phrased "Kilmarn has five quarters" as Kilmarn ->
// quarter (semantic "contains", i.e. parent-first), inverting the convention
// and — once a correctly-directed Underbreach -> Kilmarn edge arrived —
// closing the containment cycle that silently unrooted both.
// ---------------------------------------------------------------------------

const KILMARN_SNAPSHOT_ENTITIES = [
  { id: "wf_mss38vnb_0", name: "Kilmarn", type: "place" },
  { id: "wf_mss38vnc_8", name: "The Underbreach", type: "place" },
  { id: "wf_mss38vnc_i", name: "The Lowway", type: "place" },
  { id: "wf_mss38vnc_d", name: "Founding Charter", type: "object" }
];

function edge(source, target, extra = {}) {
  return { source, target, relationshipType: "containment", rationale: "r", ...extra };
}

test("W5a real Kilmarn case: a parent-first 'has' label flips the edge to child->parent, recorded on the edge", () => {
  const proposal = {
    entities: [],
    edges: [edge("Kilmarn", "The Underbreach", { label: "has five quarters" })]
  };
  const { proposal: out, flips } = normalizeProposalContainmentDirection(proposal, KILMARN_SNAPSHOT_ENTITIES);
  const e = out.edges[0];
  assert.equal(e.source, "The Underbreach", "flipped: the quarter is the CHILD (source)");
  assert.equal(e.target, "Kilmarn", "flipped: Kilmarn is the PARENT (target)");
  assert.equal(e.writeupNormalization.kind, "containment-direction-flipped");
  assert.equal(e.writeupNormalization.reason, "label");
  assert.deepEqual(e.writeupNormalization.from, { source: "Kilmarn", target: "The Underbreach" });
  assert.equal(flips.length, 1);
});

test("W5a: child-first phrasings ('located in', 'kept …', 'stands at …' — the real kilmarn labels) are confidently KEPT, untagged", () => {
  const proposal = {
    entities: [],
    edges: [
      edge("Sable Orren's Lending House", "The Tangle", { label: "located in" }),
      edge("Founding Charter", "The Underbreach", { label: "kept somewhere in its depths" }),
      edge("Ceremonial Mooring Post", "Kilmarn Bridge", { label: "stands at bridge's east end" })
    ]
  };
  const { proposal: out, flips, uncertainties } = normalizeProposalContainmentDirection(proposal, KILMARN_SNAPSHOT_ENTITIES);
  assert.equal(flips.length, 0);
  assert.equal(uncertainties.length, 0);
  for (let i = 0; i < proposal.edges.length; i++) {
    assert.equal(out.edges[i].source, proposal.edges[i].source, "direction untouched");
    assert.equal(out.edges[i].writeupNormalization, undefined, "no tag on a confident keep");
  }
});

test("W5a type asymmetry: label-less place -> object flips (object-in-place); non-place -> place keeps", () => {
  const proposal = {
    entities: [{ name: "The Shuttered Shop", type: "place", rationale: "r" }],
    edges: [
      // Claims a place is inside an object — flipped.
      edge("The Lowway", "Founding Charter"),
      // The canonical thing-in-place — kept, untagged.
      edge("Founding Charter", "The Lowway")
    ]
  };
  const { proposal: out, flips } = normalizeProposalContainmentDirection(proposal, KILMARN_SNAPSHOT_ENTITIES);
  assert.equal(out.edges[0].source, "Founding Charter");
  assert.equal(out.edges[0].target, "The Lowway");
  assert.equal(out.edges[0].writeupNormalization.reason, "type-asymmetry");
  assert.equal(out.edges[1].source, "Founding Charter");
  assert.equal(out.edges[1].writeupNormalization, undefined);
  assert.equal(flips.length, 1);
});

test("W5a low confidence: a conflicting label tags the edge but leaves direction ALONE", () => {
  const proposal = {
    entities: [],
    // "has a shrine hidden in" matches both lexicons ("has" + "hidden"/"in").
    edges: [edge("Kilmarn", "The Underbreach", { label: "has a shrine hidden in it" })]
  };
  const { proposal: out, flips, uncertainties } = normalizeProposalContainmentDirection(proposal, KILMARN_SNAPSHOT_ENTITIES);
  assert.equal(out.edges[0].source, "Kilmarn", "direction untouched");
  assert.equal(out.edges[0].writeupNormalization.kind, "containment-direction-uncertain");
  assert.equal(out.edges[0].writeupNormalization.reason, "conflicting-label");
  assert.equal(flips.length, 0);
  assert.equal(uncertainties.length, 1);
});

test("W5a low confidence: place 'inside' a concept (the real lending-house -> Fate-threads pollution) is tagged, never auto-flipped", () => {
  const proposal = {
    entities: [{ name: "Fate-threads", type: "concept", rationale: "r" }],
    edges: [edge("The Lowway", "Fate-threads")]
  };
  const { proposal: out, flips, uncertainties } = normalizeProposalContainmentDirection(proposal, KILMARN_SNAPSHOT_ENTITIES);
  assert.equal(out.edges[0].source, "The Lowway", "direction untouched — this is a mis-TYPED edge, not a mis-directed one");
  assert.equal(out.edges[0].writeupNormalization.reason, "place-inside-nonplace");
  assert.equal(flips.length, 0);
  assert.equal(uncertainties.length, 1);
});

test("W5a conservatism: place-in-place with no label signal, unknown endpoints, and non-containment edges are all untouched", () => {
  const proposal = {
    entities: [],
    edges: [
      edge("The Underbreach", "Kilmarn"), // both places, no label — plausible either way, hands off
      edge("Total Mystery A", "Total Mystery B"), // unknown types — hands off
      { source: "Kilmarn", target: "The Underbreach", relationshipType: "presence", label: "has watchers in", rationale: "r" }
    ]
  };
  const { proposal: out, flips, uncertainties } = normalizeProposalContainmentDirection(proposal, KILMARN_SNAPSHOT_ENTITIES);
  assert.equal(flips.length, 0);
  assert.equal(uncertainties.length, 0);
  for (let i = 0; i < proposal.edges.length; i++) {
    assert.equal(out.edges[i].source, proposal.edges[i].source);
    assert.equal(out.edges[i].writeupNormalization, undefined);
  }
});

test("W5a: the combined normalizeProposalAgainstSnapshot runs the direction pass LAST — a near-miss-renamed endpoint still resolves for the type lookup", () => {
  const proposal = {
    entities: [{ name: "Lowway", type: "place", description: "d", rationale: "r" }],
    // Endpoint uses the shorthand name; W2a rewrites it to "The Lowway"
    // BEFORE the direction pass, whose snapshot lookup then hits.
    edges: [edge("Lowway", "Founding Charter")]
  };
  const result = normalizeProposalAgainstSnapshot(proposal, KILMARN_SNAPSHOT_ENTITIES);
  assert.equal(result.rewrites.length, 1, "W2a near-miss rename still fires");
  const e = result.proposal.edges[0];
  assert.equal(e.source, "Founding Charter", "flipped: object-in-place after the rename resolved the endpoint");
  assert.equal(e.target, "The Lowway");
  assert.equal(result.containmentFlips.length, 1);
  assert.equal(result.containmentUncertainties.length, 0);
});

// ---------------------------------------------------------------------------
// End-to-end: importWriteup with a mocked extraction emitting the exact
// inverted "Kilmarn has quarters" shape — the stored edge mutation must have
// the CONVENTION-correct sourceId/targetId and carry the flip record that
// grain.mjs surfaces for the review card.
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

test("W5a end-to-end: importWriteup stores the flipped edge (child=sourceId -> parent=targetId) with the record surfaced on the batch row", async () => {
  const snapshot = {
    entities: KILMARN_SNAPSHOT_ENTITIES.map((e) => ({ ...e, description: "canon text", importance: 0.5 })),
    edges: [],
    entityTypes: []
  };
  const extraction = JSON.stringify({
    entities: [],
    edges: [
      { source: "Kilmarn", target: "The Underbreach", relationshipType: "containment", label: "has five quarters", rationale: "The writeup says Kilmarn has five quarters." }
    ]
  });
  const result = await importWriteup("w5a-direction-world", "…seed text…", snapshot, {
    llmOpts: { client: mockClient([extraction]) }
  });

  const batch = loadBatch("w5a-direction-world", result.batchId);
  const edgeMut = batch.mutations.find((m) => m.op === "upsert_edge");
  assert.ok(edgeMut, "the edge made it into the batch");
  assert.equal(edgeMut.data.sourceId, "wf_mss38vnc_8", "CHILD (the Underbreach) is sourceId — the UI convention");
  assert.equal(edgeMut.data.targetId, "wf_mss38vnb_0", "PARENT (Kilmarn) is targetId");
  assert.equal(edgeMut.entityContext.writeupNormalization.kind, "containment-direction-flipped");

  const rows = summarizeBatch(batch).regions.flatMap((r) => r.entities);
  const row = rows.find((r) => r.mutationId === edgeMut.mutationId);
  assert.equal(row.writeupNormalization.kind, "containment-direction-flipped", "grain.mjs surfaces it for the review card");
});
