import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same isolation pattern as test/review-state.test.mjs / test/rollback.test.mjs:
// point the review-state store at a scratch dir BEFORE any batch-writing call
// runs, so this file never touches the repo's real review-state/ directory
// (Phase 4's self-review found four existing files that skipped this).
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-writeup-import-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = scratchDir;

const {
  proposeWfiFromWriteup,
  previewWriteupImport,
  importWriteup,
  regenerateWriteupImport,
  WriteupTooLargeError,
  WriteupImportValidationError,
  MAX_WRITEUP_CHARS,
  WRITEUP_IMPORT_REGION_ID,
  DEFAULT_WRITEUP_IMPORT_MODEL,
  // Phase 8 task 8.1
  proposeFramingsFromWriteup,
  FramingProposalError,
  DEFAULT_FRAMING_MODEL,
  // Phase 8 task 8.2
  composeFramingNote,
  recordFramingRound,
  requestReframing,
  resolveRejectLoop,
  FramingRoundLimitError,
  QUICK_PICK_REASONS,
  MAX_FRAMING_ROUNDS
} = await import("../graph-import/writeup-import.mjs");
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

function mockClient(responses) {
  let call = 0;
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        const resp = responses[Math.min(call, responses.length - 1)];
        call++;
        return { content: [{ type: "text", text: typeof resp === "function" ? resp(params) : resp }] };
      }
    }
  };
}

// ============================================================ task 5.1 ==

test("DEFAULT_WRITEUP_IMPORT_MODEL is claude-sonnet-5, matching texture.mjs/resolve-seed.mjs's default", () => {
  assert.equal(DEFAULT_WRITEUP_IMPORT_MODEL, "claude-sonnet-5");
});

test("proposeWfiFromWriteup: a well-formed writeup produces a valid WFI document with per-item rationale", async () => {
  const goodResponse = JSON.stringify({
    entities: [
      {
        name: "Gerdur",
        type: "person",
        description: "Runs the mill in Riverwood.",
        importance: 0.5,
        rationale: "Introduced in paragraph 1 as the miller."
      },
      {
        name: "Riverwood",
        type: "place",
        description: "A logging village.",
        rationale: "The setting of the whole excerpt."
      }
    ],
    edges: [
      {
        source: "Gerdur",
        target: "Riverwood",
        relationshipType: "presence",
        strength: 0.7,
        rationale: "Gerdur is said to live and work in Riverwood."
      }
    ]
  });
  const client = mockClient([goodResponse]);
  const proposal = await proposeWfiFromWriteup(
    "Gerdur runs the mill in the logging village of Riverwood.",
    { client }
  );
  assert.equal(proposal.entities.length, 2);
  assert.equal(proposal.edges.length, 1);
  for (const e of proposal.entities) assert.ok(e.rationale && e.rationale.length > 0, "every entity needs a rationale");
  for (const e of proposal.edges) assert.ok(e.rationale && e.rationale.length > 0, "every edge needs a rationale");
  assert.equal(proposal.edges[0].source, "Gerdur");
  assert.equal(proposal.edges[0].target, "Riverwood");
});

test("proposeWfiFromWriteup: strips markdown code fences before parsing (same convention as texture.mjs)", async () => {
  const fenced =
    "```json\n" +
    JSON.stringify({
      entities: [{ name: "Alvor", type: "person", rationale: "The smith." }],
      edges: []
    }) +
    "\n```";
  const client = mockClient([fenced]);
  const proposal = await proposeWfiFromWriteup("Alvor is the smith.", { client });
  assert.equal(proposal.entities.length, 1);
  assert.equal(proposal.entities[0].name, "Alvor");
});

test("proposeWfiFromWriteup: retries once on invalid JSON, succeeds on second attempt", async () => {
  const badResponse = "not valid json at all";
  const goodResponse = JSON.stringify({
    entities: [{ name: "Alvor", type: "person", rationale: "Recovered on retry." }],
    edges: []
  });
  const client = mockClient([badResponse, goodResponse]);
  const proposal = await proposeWfiFromWriteup("Alvor is the smith.", { client });
  assert.equal(proposal.entities[0].rationale, "Recovered on retry.");
  assert.equal(client.calls.length, 2);
});

test("proposeWfiFromWriteup: retries once on schema-invalid JSON (missing rationale), succeeds on second attempt", async () => {
  const invalidShape = JSON.stringify({ entities: [{ name: "Alvor", type: "person" }], edges: [] }); // missing rationale
  const validShape = JSON.stringify({ entities: [{ name: "Alvor", type: "person", rationale: "Fixed." }], edges: [] });
  const client = mockClient([invalidShape, validShape]);
  const proposal = await proposeWfiFromWriteup("Alvor.", { client });
  assert.equal(proposal.entities[0].rationale, "Fixed.");
});

test("proposeWfiFromWriteup: retries once on an invalid entity type, succeeds on second attempt", async () => {
  const invalidType = JSON.stringify({
    entities: [{ name: "Alvor", type: "npc", rationale: "x" }], // 'npc' is not one of the valid types
    edges: []
  });
  const validType = JSON.stringify({
    entities: [{ name: "Alvor", type: "person", rationale: "Fixed type." }],
    edges: []
  });
  const client = mockClient([invalidType, validType]);
  const proposal = await proposeWfiFromWriteup("Alvor.", { client });
  assert.equal(proposal.entities[0].type, "person");
});

test("proposeWfiFromWriteup: throws a typed WriteupImportValidationError after a second failure, does not silently drop the proposal", async () => {
  const client = mockClient(["still not json", "still not json either"]);
  await assert.rejects(
    proposeWfiFromWriteup("some writeup text", { client }),
    (err) => {
      assert.ok(err instanceof WriteupImportValidationError);
      assert.equal(err.attempts, 2);
      return true;
    }
  );
});

test("proposeWfiFromWriteup: passes the reviewer note through to the prompt on regenerate", async () => {
  let capturedPrompt = "";
  const client = mockClient([
    (params) => {
      capturedPrompt = params.messages[0].content;
      return JSON.stringify({ entities: [], edges: [] });
    }
  ]);
  await proposeWfiFromWriteup("some text", { client, note: "treat Gerdur as the same person" });
  assert.ok(capturedPrompt.includes("treat Gerdur as the same person"));
});

test("proposeWfiFromWriteup: throws a typed WriteupTooLargeError for a writeup over the v1 length guard, without making an API call", async () => {
  const client = mockClient(["should never be called"]);
  const huge = "x".repeat(MAX_WRITEUP_CHARS + 1);
  await assert.rejects(
    proposeWfiFromWriteup(huge, { client }),
    (err) => {
      assert.ok(err instanceof WriteupTooLargeError);
      assert.equal(err.length, MAX_WRITEUP_CHARS + 1);
      return true;
    }
  );
  assert.equal(client.calls.length, 0, "must fail fast on the length guard before ever calling the model");
});

// ============================================================ task 5.2 ==

const EXISTING_ENTITY_TYPES = [
  { id: "person", label: "Person", attributeDefs: [] },
  { id: "place", label: "Place", attributeDefs: [] }
];

test("previewWriteupImport: THE DEDUP TEST — a writeup mentioning an existing entity by name+type produces an UPDATE, not a second create", () => {
  const existingSnapshot = {
    entities: [
      { id: "existing-gerdur", name: "Gerdur", type: "person", description: "The miller.", importance: 0.4, tags: [], attributes: {} }
    ],
    edges: [],
    entityTypes: EXISTING_ENTITY_TYPES
  };
  const proposal = {
    entities: [
      {
        name: "Gerdur",
        type: "person",
        description: "The miller in Riverwood, sister of Alvor the smith.",
        importance: 0.6,
        rationale: "Paragraph 2 expands on Gerdur's relationship to Alvor."
      },
      {
        name: "Alvor",
        type: "person",
        description: "The village smith.",
        rationale: "Paragraph 2 introduces Alvor for the first time."
      }
    ],
    edges: []
  };

  const { mutations, summary } = previewWriteupImport(proposal, existingSnapshot);

  assert.equal(mutations.length, 2, "one update for Gerdur, one create for Alvor — not two creates");

  const gerdurMutation = mutations.find((m) => m.data.name === "Gerdur");
  const alvorMutation = mutations.find((m) => m.data.name === "Alvor");

  assert.ok(gerdurMutation, "Gerdur's mutation should exist");
  assert.equal(gerdurMutation.id, "existing-gerdur", "Gerdur's mutation must target the EXISTING entity's real id");
  assert.equal(gerdurMutation.data.description, "The miller in Riverwood, sister of Alvor the smith.");
  assert.equal(gerdurMutation.rationale, "Paragraph 2 expands on Gerdur's relationship to Alvor.");
  assert.equal(gerdurMutation.sourceKind, "writeup-import");
  assert.equal(gerdurMutation.regionId, WRITEUP_IMPORT_REGION_ID);

  assert.ok(alvorMutation, "Alvor's mutation should exist");
  assert.ok(
    typeof alvorMutation.id === "string" && alvorMutation.id.length > 0 && alvorMutation.id !== "existing-gerdur",
    "Alvor is a genuine create but STILL gets a real, pre-assigned id (see this module's ID-STABILITY doc " +
      "comment) -- unlike other producers, writeup-import can't omit id on a create, since a create and an edge " +
      "referencing it in the same batch must resolve to the same id at actual apply time"
  );

  // Prove it via the underlying importGraph summary too, not just this
  // module's own bookkeeping -- the whole point of reusing importGraph.
  assert.equal(summary.entitiesUpdated, 1);
  assert.equal(summary.entitiesCreated, 1);
  assert.deepEqual(summary.updatedNames, ["Gerdur"]);
  assert.deepEqual(summary.createdNames, ["Alvor"]);
});

test("previewWriteupImport: dedup is genuinely case-insensitive and type-scoped, matching importGraph's own findExisting", () => {
  const existingSnapshot = {
    entities: [{ id: "existing-riverwood", name: "Riverwood", type: "place", importance: 0.5, tags: [], attributes: {} }],
    edges: [],
    entityTypes: EXISTING_ENTITY_TYPES
  };
  const proposal = {
    entities: [
      { name: "riverwood", type: "place", description: "Updated description.", rationale: "x" }, // different case, same type -> update
      { name: "Riverwood", type: "person", description: "A person coincidentally also named Riverwood.", rationale: "y" } // same name, different type -> create
    ],
    edges: []
  };
  const { mutations } = previewWriteupImport(proposal, existingSnapshot);
  assert.equal(mutations.length, 2);
  const placeMutation = mutations.find((m) => m.data.type === "place");
  const personMutation = mutations.find((m) => m.data.type === "person");
  assert.equal(placeMutation.id, "existing-riverwood", "case-insensitive name match against the existing place should update it");
  assert.ok(
    typeof personMutation.id === "string" && personMutation.id !== "existing-riverwood",
    "same name but a different type must NOT match -- a fresh create, with its own real pre-assigned id"
  );
});

test("previewWriteupImport: edges referencing entities purely by name resolve correctly, and stub creation happens for a referenced-but-undescribed entity", () => {
  const existingSnapshot = {
    entities: [{ id: "existing-alvor", name: "Alvor", type: "person", importance: 0.5, tags: [], attributes: {} }],
    edges: [],
    entityTypes: EXISTING_ENTITY_TYPES
  };
  const proposal = {
    entities: [
      // Alvor is only referenced (matches existing), not re-described here.
    ],
    edges: [
      {
        source: "Alvor",
        target: "Riverwood Trading Post", // never described anywhere -- must become a stub entity
        relationshipType: "ownership",
        strength: 0.8,
        rationale: "Paragraph 3 says Alvor owns the Riverwood Trading Post."
      }
    ]
  };

  const { mutations, summary } = previewWriteupImport(proposal, existingSnapshot);

  const edgeMutation = mutations.find((m) => m.op === "upsert_edge");
  assert.ok(edgeMutation, "an edge mutation should be produced");
  assert.equal(edgeMutation.id, undefined, "importGraph never dedups edges by identity -- every proposed edge is a create");
  assert.equal(edgeMutation.data.sourceId, "existing-alvor", "the edge should resolve to Alvor's REAL existing id, not a new stub for Alvor");
  assert.equal(edgeMutation.data.relationshipType, "ownership");
  assert.equal(edgeMutation.rationale, "Paragraph 3 says Alvor owns the Riverwood Trading Post.");

  const stubMutation = mutations.find((m) => m.op === "upsert_entity" && m.data.name === "Riverwood Trading Post");
  assert.ok(stubMutation, "a stub entity mutation for the undescribed edge endpoint should be produced");
  assert.ok(
    typeof stubMutation.id === "string" && stubMutation.id.length > 0,
    "the stub is a genuine create but still gets a real, pre-assigned id -- see ID-STABILITY note"
  );
  assert.match(stubMutation.rationale, /Stub entity auto-created/);

  // THE CROSS-REFERENCE REGRESSION TEST: the edge's targetId must be the
  // EXACT SAME id as the stub entity's own mutation id -- this is precisely
  // the case that broke before the ID-STABILITY fix (found via this phase's
  // own real MCP-server smoke test): a dry-run-only id on the edge that
  // didn't match whatever id the entity ACTUALLY got assigned at apply time
  // caused importGraph to treat the stale id as an unresolvable name and
  // silently spawn a phantom stub entity.
  assert.equal(
    edgeMutation.data.targetId,
    stubMutation.id,
    "the edge's targetId MUST equal the stub entity mutation's own id -- otherwise applying the entity create " +
      "and the edge create as separate mutations later (headless or live) would resolve to two different ids " +
      "and leave the edge dangling / spawn a phantom stub"
  );
  assert.notEqual(edgeMutation.data.targetId, "existing-alvor");

  assert.equal(summary.stubsCreated, 1, "importGraph's own summary should agree exactly one stub was created");
  assert.equal(summary.edgesCreated, 1);
});

test("previewWriteupImport: an entity with no importance/tags/attributes still produces a valid mutation (defaults applied by importGraph)", () => {
  const existingSnapshot = { entities: [], edges: [], entityTypes: EXISTING_ENTITY_TYPES };
  const proposal = {
    entities: [{ name: "A New Rumor", type: "concept", rationale: "Mentioned in the last line." }],
    edges: []
  };
  const { mutations } = previewWriteupImport(proposal, existingSnapshot);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].data.importance, 0.3, "importGraph's normalizeEntity default");
});

test("previewWriteupImport: mode='replace' does not crash and still classifies every proposed entity as a create (importGraph's own replace semantics)", () => {
  const existingSnapshot = {
    entities: [{ id: "existing-gerdur", name: "Gerdur", type: "person", importance: 0.4, tags: [], attributes: {} }],
    edges: [],
    entityTypes: EXISTING_ENTITY_TYPES
  };
  const proposal = {
    entities: [{ name: "Gerdur", type: "person", description: "Replacement-mode Gerdur.", rationale: "x" }],
    edges: []
  };
  const { mutations } = previewWriteupImport(proposal, existingSnapshot, { mode: "replace" });
  assert.equal(mutations.length, 1);
  assert.ok(
    typeof mutations[0].id === "string" && mutations[0].id !== "existing-gerdur",
    "in replace mode importGraph ignores the pre-existing entity map entirely -- even a same-name entity is a " +
      "fresh create, with its own real pre-assigned id distinct from the (now-irrelevant) existing one"
  );
});

test("previewWriteupImport: a NEW entity and an edge referencing it (by name) in the SAME proposal resolve to the SAME id -- the id-stability regression test", () => {
  const existingSnapshot = { entities: [], edges: [], entityTypes: EXISTING_ENTITY_TYPES };
  const proposal = {
    entities: [
      { name: "Gerdur", type: "person", description: "The miller.", rationale: "x" },
      { name: "Riverwood", type: "place", description: "A logging village.", rationale: "y" }
    ],
    edges: [
      { source: "Gerdur", target: "Riverwood", relationshipType: "presence", rationale: "z" }
    ]
  };
  const { mutations } = previewWriteupImport(proposal, existingSnapshot);
  const gerdur = mutations.find((m) => m.op === "upsert_entity" && m.data.name === "Gerdur");
  const riverwood = mutations.find((m) => m.op === "upsert_entity" && m.data.name === "Riverwood");
  const edge = mutations.find((m) => m.op === "upsert_edge");

  assert.ok(gerdur.id && riverwood.id, "both brand-new entities must carry a real pre-assigned id");
  assert.notEqual(gerdur.id, riverwood.id);
  assert.equal(edge.data.sourceId, gerdur.id, "the edge's sourceId must be the SAME id as Gerdur's own create mutation");
  assert.equal(edge.data.targetId, riverwood.id, "the edge's targetId must be the SAME id as Riverwood's own create mutation");
});

// ==================================================== task 5.1+5.2 combined (importWriteup) ==

test("importWriteup: end-to-end (mocked LLM) creates a real review-state batch with writeup-import mutations, diffs, and the original text recorded for regenerate", async () => {
  const goodResponse = JSON.stringify({
    entities: [
      { name: "Gerdur", type: "person", description: "The miller.", importance: 0.5, rationale: "Intro paragraph." }
    ],
    edges: []
  });
  const client = mockClient([goodResponse]);
  const existingSnapshot = { entities: [], edges: [], entityTypes: EXISTING_ENTITY_TYPES };

  const result = await importWriteup("wf-writeup-test", "Gerdur runs the mill.", existingSnapshot, {
    llmOpts: { client }
  });

  assert.ok(result.batchId);
  assert.equal(result.mutationCount, 1);
  assert.ok(result.headline.includes("writeup-import") || result.headline.length > 0);

  const batch = loadBatch("wf-writeup-test", result.batchId);
  assert.equal(batch.scope.mode, "writeup-import");
  assert.equal(batch.scope.text, "Gerdur runs the mill.", "original text must be recorded for a later regenerate");
  assert.equal(batch.mutations.length, 1);
  assert.equal(batch.mutations[0].sourceKind, "writeup-import");
  assert.equal(batch.mutations[0].status, "pending");
  assert.ok(Array.isArray(batch.mutations[0].diff), "attachDiffs should have run");
  assert.equal(batch.mutations[0].diff[0].field, "(created)", "a brand-new entity against an empty snapshot should get the (created) marker");
});

test("importWriteup: an update against a real existing snapshot produces a genuine field-level diff (not just '(created)')", async () => {
  const goodResponse = JSON.stringify({
    entities: [
      { name: "Gerdur", type: "person", description: "Now also runs the tavern.", importance: 0.6, rationale: "New info in the writeup." }
    ],
    edges: []
  });
  const client = mockClient([goodResponse]);
  const existingSnapshot = {
    entities: [{ id: "existing-gerdur", name: "Gerdur", type: "person", description: "The miller.", importance: 0.4, tags: [], attributes: {} }],
    edges: [],
    entityTypes: EXISTING_ENTITY_TYPES
  };

  const result = await importWriteup("wf-writeup-test-2", "Gerdur now also runs the tavern.", existingSnapshot, {
    llmOpts: { client }
  });
  const batch = loadBatch("wf-writeup-test-2", result.batchId);
  const m = batch.mutations[0];
  assert.equal(m.id, "existing-gerdur");
  const descChange = m.diff.find((d) => d.field === "description");
  assert.ok(descChange, "a real field-level diff should be present for the update case");
  assert.equal(descChange.from, "The miller.");
  assert.equal(descChange.to, "Now also runs the tavern.");
});

// ===================================================== regenerateWriteupImport ==

test("regenerateWriteupImport: re-runs against the batch's originally-stored text plus a note, replacing the mutation set", async () => {
  const firstResponse = JSON.stringify({
    entities: [{ name: "Gerdur", type: "person", description: "The miller.", rationale: "x" }],
    edges: []
  });
  const client1 = mockClient([firstResponse]);
  const existingSnapshot = { entities: [], edges: [], entityTypes: EXISTING_ENTITY_TYPES };
  const result = await importWriteup("wf-writeup-regen-test", "Gerdur runs the mill.", existingSnapshot, {
    llmOpts: { client: client1 }
  });
  const batch = loadBatch("wf-writeup-regen-test", result.batchId);

  let capturedPrompt = "";
  const secondResponse = JSON.stringify({
    entities: [{ name: "Gerdur", type: "person", description: "The miller, now described differently.", rationale: "steered" }],
    edges: []
  });
  const client2 = mockClient([
    (params) => {
      capturedPrompt = params.messages[0].content;
      return secondResponse;
    }
  ]);

  const { mutations } = await regenerateWriteupImport(batch, "make her more prominent", existingSnapshot, {
    llmOpts: { client: client2 }
  });

  assert.ok(capturedPrompt.includes("Gerdur runs the mill."), "must re-use the ORIGINAL writeup text, not something new");
  assert.ok(capturedPrompt.includes("make her more prominent"), "must include the steering note");
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].data.description, "The miller, now described differently.");
});

test("regenerateWriteupImport: throws a clear error if the batch has no recorded writeup text", async () => {
  const batchWithoutText = { id: "batch-no-text", scope: { mode: "manual" }, mutations: [] };
  await assert.rejects(
    regenerateWriteupImport(batchWithoutText, "a note", { entities: [], edges: [] }, {}),
    /no original writeup text/
  );
});

// ============================================================ task 8.1 ==

test("DEFAULT_FRAMING_MODEL is a distinct, cheaper/faster tier than DEFAULT_WRITEUP_IMPORT_MODEL", () => {
  assert.equal(DEFAULT_FRAMING_MODEL, "claude-haiku-4-5");
  assert.notEqual(DEFAULT_FRAMING_MODEL, DEFAULT_WRITEUP_IMPORT_MODEL);
});

test("proposeFramingsFromWriteup: a well-formed writeup produces exactly 3 framings with ids a/b/c", async () => {
  const goodResponse = JSON.stringify({
    framings: [
      { id: "a", sentence: "A political-intrigue reading centered on the merchant houses." },
      { id: "b", sentence: "A frontier/exploration reading centered on the ruins." },
      { id: "c", sentence: "A personal-stakes reading centered on the narrator." }
    ]
  });
  const client = mockClient([goodResponse]);
  const result = await proposeFramingsFromWriteup("Some writeup about ruins and merchant houses.", { client });
  assert.equal(result.framings.length, 3);
  assert.deepEqual(result.framings.map((f) => f.id).sort(), ["a", "b", "c"]);
  for (const f of result.framings) assert.ok(f.sentence && f.sentence.length > 0);
});

test("proposeFramingsFromWriteup: uses DEFAULT_FRAMING_MODEL and a small maxTokens by default, not DEFAULT_WRITEUP_IMPORT_MODEL's settings", async () => {
  let capturedParams;
  const client = mockClient([
    (params) => {
      capturedParams = params;
      return JSON.stringify({
        framings: [
          { id: "a", sentence: "x" },
          { id: "b", sentence: "y" },
          { id: "c", sentence: "z" }
        ]
      });
    }
  ]);
  await proposeFramingsFromWriteup("Some writeup.", { client });
  assert.equal(capturedParams.model, DEFAULT_FRAMING_MODEL);
  assert.ok(capturedParams.max_tokens <= 1024, "framing call must be deliberately cheap (small maxTokens)");
});

test("proposeFramingsFromWriteup: wrong count is retried once then surfaces a typed error", async () => {
  const wrongCount = JSON.stringify({ framings: [{ id: "a", sentence: "x" }, { id: "b", sentence: "y" }] });
  const client = mockClient([wrongCount, wrongCount]);
  await assert.rejects(
    proposeFramingsFromWriteup("Some writeup.", { client }),
    (err) => {
      assert.ok(err instanceof FramingProposalError);
      assert.equal(err.attempts, 2);
      return true;
    }
  );
  assert.equal(client.calls.length, 2);
});

test("proposeFramingsFromWriteup: duplicate ids (missing the full a/b/c set) is retried once then surfaces a typed error", async () => {
  const duplicateIds = JSON.stringify({
    framings: [
      { id: "a", sentence: "x" },
      { id: "a", sentence: "y" },
      { id: "b", sentence: "z" }
    ]
  });
  const good = JSON.stringify({
    framings: [
      { id: "a", sentence: "x" },
      { id: "b", sentence: "y" },
      { id: "c", sentence: "z" }
    ]
  });
  const client = mockClient([duplicateIds, good]);
  const result = await proposeFramingsFromWriteup("Some writeup.", { client });
  assert.deepEqual(result.framings.map((f) => f.id).sort(), ["a", "b", "c"]);
  assert.equal(client.calls.length, 2, "should have retried once after the duplicate-id failure");
});

test("proposeFramingsFromWriteup: missing sentence is retried once then surfaces a typed error", async () => {
  const missingSentence = JSON.stringify({
    framings: [{ id: "a", sentence: "" }, { id: "b", sentence: "y" }, { id: "c", sentence: "z" }]
  });
  const client = mockClient([missingSentence, missingSentence]);
  await assert.rejects(proposeFramingsFromWriteup("Some writeup.", { client }), FramingProposalError);
});

test("proposeFramingsFromWriteup: reuses the shared WriteupTooLargeError guard, without making an API call", async () => {
  const client = mockClient(["should never be called"]);
  const huge = "x".repeat(MAX_WRITEUP_CHARS + 1);
  await assert.rejects(proposeFramingsFromWriteup(huge, { client }), WriteupTooLargeError);
  assert.equal(client.calls.length, 0);
});

// ============================================================ task 8.2 ==

test("composeFramingNote: a plain pick with no blend", () => {
  const note = composeFramingNote({ primary: { id: "a", sentence: "A political-intrigue reading." } });
  assert.match(note, /A political-intrigue reading\./);
});

test("composeFramingNote: a pick plus a blend line includes both", () => {
  const note = composeFramingNote({
    primary: { id: "a", sentence: "A political-intrigue reading." },
    blend: "also pull in the ruins from framing B"
  });
  assert.match(note, /A political-intrigue reading\./);
  assert.match(note, /also pull in the ruins from framing B/);
});

test("composeFramingNote: throws a clear error without a valid primary selection", () => {
  assert.throws(() => composeFramingNote({}), /primary/);
  assert.throws(() => composeFramingNote(null), /selection/);
});

test("recordFramingRound: appends one entry per call, framingHistory accumulates, confirmed by inspecting the actual object", () => {
  const batch = { id: "b1", scope: { mode: "writeup-import", text: "x" } };
  recordFramingRound(batch, { framings: [{ id: "a", sentence: "1" }], selection: { primary: { id: "a", sentence: "1" } }, note: "n1" });
  assert.equal(batch.scope.framingHistory.length, 1);
  recordFramingRound(batch, { framings: [{ id: "a", sentence: "2" }], selection: { primary: { id: "a", sentence: "2" } }, note: "n2" });
  assert.equal(batch.scope.framingHistory.length, 2);
  assert.equal(batch.scope.framingHistory[0].note, "n1");
  assert.equal(batch.scope.framingHistory[1].note, "n2");
});

test("requestReframing: a plain reject produces a new framing round, with the rejection reason threaded into the prompt", async () => {
  const batch = { id: "b2", scope: { mode: "writeup-import", text: "Some writeup text.", framingHistory: [{ framings: [], selection: {}, note: "n0" }] } };
  let capturedPrompt = "";
  const client = mockClient([
    (params) => {
      capturedPrompt = params.messages[0].content;
      return JSON.stringify({
        framings: [{ id: "a", sentence: "1" }, { id: "b", sentence: "2" }, { id: "c", sentence: "3" }]
      });
    }
  ]);
  const result = await requestReframing(batch, "wrong-emphasis", { llmOpts: { client } });
  assert.equal(result.framings.length, 3);
  assert.match(capturedPrompt, /Some writeup text\./, "must re-use the batch's original recorded text");
  assert.match(capturedPrompt, new RegExp(QUICK_PICK_REASONS["wrong-emphasis"]), "the picked reason must be threaded into the new framing call, not a blind repeat");
});

test("requestReframing: throws for an unknown quick-pick reason code", async () => {
  const batch = { id: "b3", scope: { mode: "writeup-import", text: "x", framingHistory: [] } };
  await assert.rejects(requestReframing(batch, "not-a-real-reason", {}), /Unknown quick-pick reason/);
});

test("requestReframing: a SECOND plain reject is refused with FramingRoundLimitError once the bounded round budget is spent, rather than silently offering quick-picks again", async () => {
  const batch = {
    id: "b4",
    scope: {
      mode: "writeup-import",
      text: "x",
      framingHistory: [
        { framings: [], selection: {}, note: "initial round" },
        { framings: [], selection: {}, note: "re-framing round" }
      ]
    }
  };
  assert.equal(batch.scope.framingHistory.length, MAX_FRAMING_ROUNDS, "sanity: budget already fully spent");
  await assert.rejects(requestReframing(batch, "wrong-scope", {}), FramingRoundLimitError);
});

test("resolveRejectLoop: an EXPLICIT-note reject resolves straight to {kind:'regenerate', note} and never touches the framing path (no API call made)", async () => {
  const batch = { id: "b5", scope: { mode: "writeup-import", text: "x", framingHistory: [{ framings: [], selection: {}, note: "n0" }] } };
  const client = mockClient(["should never be called"]);
  const decision = await resolveRejectLoop(batch, { note: "I know exactly what's wrong" }, { llmOpts: { client } });
  assert.deepEqual(decision, { kind: "regenerate", note: "I know exactly what's wrong" });
  assert.equal(client.calls.length, 0, "an explicit-note reject must never call the framing model");
});

test("resolveRejectLoop: a PLAIN reject (quickPickReason, no note) resolves to {kind:'reframe', framings}", async () => {
  const batch = { id: "b6", scope: { mode: "writeup-import", text: "x", framingHistory: [{ framings: [], selection: {}, note: "n0" }] } };
  const client = mockClient([JSON.stringify({ framings: [{ id: "a", sentence: "1" }, { id: "b", sentence: "2" }, { id: "c", sentence: "3" }] })]);
  const decision = await resolveRejectLoop(batch, { quickPickReason: "missing-something" }, { llmOpts: { client } });
  assert.equal(decision.kind, "reframe");
  assert.equal(decision.framings.length, 3);
});

test("resolveRejectLoop: a whitespace-only note is treated as a PLAIN reject (falls through to quickPickReason), not an explicit note", async () => {
  const batch = { id: "b7", scope: { mode: "writeup-import", text: "x", framingHistory: [{ framings: [], selection: {}, note: "n0" }] } };
  const client = mockClient([JSON.stringify({ framings: [{ id: "a", sentence: "1" }, { id: "b", sentence: "2" }, { id: "c", sentence: "3" }] })]);
  const decision = await resolveRejectLoop(batch, { note: "   ", quickPickReason: "not-feeling-it-yet" }, { llmOpts: { client } });
  assert.equal(decision.kind, "reframe");
});

test("resolveRejectLoop: neither note nor quickPickReason throws a clear error", async () => {
  const batch = { id: "b8", scope: { mode: "writeup-import", text: "x", framingHistory: [] } };
  await assert.rejects(resolveRejectLoop(batch, {}, {}), /requires either an explicit `note` or a `quickPickReason`/);
});

await Promise.all(pending);
console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
