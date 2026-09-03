import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same isolation pattern as test/writeup-normalization.test.mjs: point the
// review-state store at a scratch dir BEFORE any batch-writing call runs.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-writeup-narrative-state-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = scratchDir;

const {
  proposeWfiFromWriteup,
  normalizeProposalAgainstSnapshot,
  previewWriteupImport,
  importWriteup
} = await import("../graph-import/writeup-import.mjs");

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

function proposalEntity(name, type, extra = {}) {
  return { name, type, rationale: "test fixture", ...extra };
}

// ---------------------------------------------------------------------------
// 1. RawWfiEntity round-trip (WS4 fix): truth/stance/revealState must SURVIVE
// zod validation instead of being silently stripped as unknown keys, while a
// genuinely unrecognized key still gets stripped (zod's normal, desired
// behavior for everything else).
// ---------------------------------------------------------------------------

test("RawWfiEntity round-trip: truth/stance/revealState survive parsing, a genuinely unknown key does not", async () => {
  const extraction = JSON.stringify({
    entities: [
      {
        name: "The Sealed Vault",
        type: "place",
        description: "A locked stone chamber beneath the guildhall.",
        truth: "The vault was emptied a decade ago; the guild quietly refills it with fakes before every audit.",
        stance: "concealing",
        revealState: "hidden",
        totallyMadeUpField: "should not survive",
        rationale: "Mentioned as the guild's treasury."
      }
    ],
    edges: []
  });
  const proposal = await proposeWfiFromWriteup("The guild keeps its treasury in a sealed vault.", {
    client: mockClient([extraction])
  });
  const entity = proposal.entities[0];
  assert.equal(entity.truth, "The vault was emptied a decade ago; the guild quietly refills it with fakes before every audit.");
  assert.equal(entity.stance, "concealing");
  assert.equal(entity.revealState, "hidden");
  assert.equal(entity.totallyMadeUpField, undefined, "a genuinely unknown key is still stripped");
});

// ---------------------------------------------------------------------------
// 2. Normalization carry-through: the three fields must survive every
// deterministic pre-pass rebuild, proven directly rather than trusted —
// exercise a proposal entity that actually gets renamed (W2a) so the rebuild
// path is genuinely exercised, not just a pass-through no-op case.
// ---------------------------------------------------------------------------

const CANON = [
  { id: "e_lowway", name: "The Lowway", type: "place" },
  { id: "e_vane", name: "Master Aldric Vane", type: "person" }
];

test("normalization carry-through: a renamed/merged entity still carries truth/stance/revealState afterward", () => {
  const { proposal } = normalizeProposalAgainstSnapshot(
    {
      entities: [
        proposalEntity("Lowway", "place", {
          truth: "The Lowway floods every spring; the council hides the maintenance costs.",
          stance: "concealing",
          revealState: "hinted"
        })
      ],
      edges: []
    },
    CANON
  );
  const pe = proposal.entities[0];
  // Confirm the rename genuinely happened (this pass IS exercised, not a
  // no-op) before asserting the three fields survived it.
  assert.equal(pe.name, "The Lowway");
  assert.equal(pe.writeupNormalization.kind, "near-miss-rename");
  assert.equal(pe.truth, "The Lowway floods every spring; the council hides the maintenance costs.");
  assert.equal(pe.stance, "concealing");
  assert.equal(pe.revealState, "hinted");
});

test("normalization carry-through: a type-conflict-resolved entity still carries the three fields afterward", () => {
  const { proposal } = normalizeProposalAgainstSnapshot(
    {
      entities: [
        proposalEntity("Master Vane", "person", {
          truth: "Vane is secretly the last living founder of the guild.",
          stance: "undisclosed",
          revealState: "unrevealed"
        })
      ],
      edges: []
    },
    [{ id: "e_vane_diff_type", name: "Master Vane", type: "place" }]
  );
  const pe = proposal.entities[0];
  assert.equal(pe.type, "place", "canon's type won — confirms the type-conflict pass genuinely ran");
  assert.equal(pe.writeupNormalization.kind, "type-conflict-resolved");
  assert.equal(pe.truth, "Vane is secretly the last living founder of the guild.");
  assert.equal(pe.stance, "undisclosed");
  assert.equal(pe.revealState, "unrevealed");
});

// ---------------------------------------------------------------------------
// 3. previewWriteupImport: the mutation carries entityContext.narrativeState,
// and `data` never contains truth/stance/revealState.
// ---------------------------------------------------------------------------

test("previewWriteupImport: entityContext.narrativeState is populated, data excludes truth/stance/revealState", () => {
  const snapshot = { entities: [], edges: [], entityTypes: [] };
  const proposal = {
    entities: [
      proposalEntity("Hollow Cairn", "place", {
        description: "A cairn on the moor that travelers avoid.",
        truth: "The cairn seals an old plague pit; no one alive remembers why.",
        stance: "unaware",
        revealState: "hidden"
      })
    ],
    edges: []
  };
  const { mutations } = previewWriteupImport(proposal, snapshot, { makeId: (() => {
    let n = 0;
    return () => `test_id_${n++}`;
  })() });

  assert.equal(mutations.length, 1);
  const m = mutations[0];
  assert.deepEqual(m.entityContext.narrativeState, {
    truth: "The cairn seals an old plague pit; no one alive remembers why.",
    stance: "unaware",
    revealState: "hidden"
  });
  for (const key of ["truth", "stance", "revealState"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(m.data, key), false, `data must not carry ${key}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Absence, not an empty object: a proposal with NO narrative-state fields
// produces mutations deep-equal to what this pipeline always produced — no
// entityContext.narrativeState key at all.
// ---------------------------------------------------------------------------

test("previewWriteupImport: no narrative-state fields on the proposal -> no entityContext.narrativeState key at all", () => {
  const snapshot = { entities: [], edges: [], entityTypes: [] };
  const proposal = {
    entities: [proposalEntity("Plain Village", "place", { description: "An ordinary village." })],
    edges: []
  };
  const { mutations } = previewWriteupImport(proposal, snapshot, { makeId: (() => {
    let n = 0;
    return () => `test_id_${n++}`;
  })() });

  assert.equal(mutations.length, 1);
  const m = mutations[0];
  assert.equal(
    Object.prototype.hasOwnProperty.call(m.entityContext, "narrativeState"),
    false,
    "absence, not an empty object"
  );
});

test("importWriteup end-to-end: narrativeState reaches the stored batch mutation, data stays clean", async () => {
  const snapshot = { entities: [], edges: [], entityTypes: [] };
  const extraction = JSON.stringify({
    entities: [
      {
        name: "Widow's Rest",
        type: "place",
        description: "A quiet inn at the edge of town.",
        truth: "The innkeeper poisons troublesome guests and buries them in the cellar.",
        stance: "concealing",
        revealState: "hidden",
        rationale: "Mentioned as where the party is staying."
      }
    ],
    edges: []
  });
  const { loadBatch } = await import("../mutation-engine/review-state.mjs");
  const result = await importWriteup("narrative-state-test-world", "…seed text…", snapshot, {
    llmOpts: { client: mockClient([extraction]) }
  });
  const batch = loadBatch("narrative-state-test-world", result.batchId);
  const m = batch.mutations.find((mm) => mm.data?.name === "Widow's Rest");
  assert.ok(m, "the entity was proposed");
  assert.deepEqual(m.entityContext.narrativeState, {
    truth: "The innkeeper poisons troublesome guests and buries them in the cellar.",
    stance: "concealing",
    revealState: "hidden"
  });
  assert.equal(m.data.truth, undefined);
  assert.equal(m.data.stance, undefined);
  assert.equal(m.data.revealState, undefined);
});

// ---------------------------------------------------------------------------
// 5. The prompt template contains the load-bearing GM-only-truth instruction.
// ---------------------------------------------------------------------------

test("prompts/writeup-import.md contains the load-bearing 'NEVER in description' instruction", () => {
  const template = readFileSync(new URL("../prompts/writeup-import.md", import.meta.url), "utf8");
  assert.ok(
    /NEVER in `description`/.test(template) || /never in `description`/i.test(template),
    "the template must explicitly instruct that GM-only truth never lands in `description`"
  );
  assert.ok(/`truth`/.test(template), "the template must document the `truth` field");
  assert.ok(/`revealState`/.test(template), "the template must document the `revealState` field");
  assert.ok(/`stance`/.test(template), "the template must document the `stance` field");
});

await Promise.all(pending);
console.log(`\n${passed} passed`);
