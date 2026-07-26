import assert from "node:assert/strict";
import { mkdtempSync, rmSync, openSync, closeSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate both review-state.mjs (prep-content.mjs reuses its withLock) and
// prep-content.mjs's own root before importing either -- same isolation
// pattern as test/entity-narration.test.mjs/test/user-settings.test.mjs, per
// this project's standing "no write in this file leaked into the repo's
// real default directory" regression-test convention.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-prep-content-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");

const REPO_DEFAULT_ROOT = join(new URL("../prep-content", import.meta.url).pathname);
const before = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();

const {
  getPrepContent,
  savePrepContent,
  acceptPrepContent,
  discardPrepContent,
  markPrepContentStale,
  updatePrepField,
  fieldsSchemaForType,
  fieldSpecTextForType,
  fieldDescription,
  prepContentRoot,
  ConcurrentWriteError,
  proposeFramingsForEntity,
  requestPrepReframing,
  composePrepFramingNote,
  generatePrepContent,
  regeneratePrepField,
  PrepFramingProposalError,
  PrepGenerationError,
  PrepFramingRoundLimitError,
  MAX_PREP_FRAMING_ROUNDS
} = await import("../mutation-engine/prep-content.mjs");

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
        if (resp && typeof resp === "object" && !Array.isArray(resp) && "text" in resp) {
          const text = typeof resp.text === "function" ? resp.text(params) : resp.text;
          return { content: [{ type: "text", text }], stop_reason: resp.stopReason ?? "end_turn" };
        }
        return {
          content: [{ type: "text", text: typeof resp === "function" ? resp(params) : resp }],
          stop_reason: "end_turn"
        };
      }
    }
  };
}

const WORLD = "wf-test";

const FIELDS_BY_TYPE_FIXTURE = {
  person: {
    descriptionAppearance: "A weathered smith with soot-stained hands.",
    personalityMannerisms: "Speaks slowly, taps his hammer when thinking.",
    motivationGoal: "Wants to keep the forge in the family.",
    secret: "He owes a debt to the Ashfall Company.",
    potentialRolls: [{ skill: "Insight", dc: 13, purpose: "Notice he's hiding something about his debts." }],
    hook: "His debt collector arrives in town this week."
  },
  place: {
    descriptionAtmosphere: "Smoke and heat, the ring of hammer on steel.",
    notableFeatures: "A cracked anvil said to predate the town itself.",
    secret: "A hidden cellar holds contraband weapons.",
    potentialEncounter: "The debt collector confronts the smith here.",
    potentialRolls: [{ skill: "Perception", dc: 14, purpose: "Spot the cellar's trapdoor." }]
  },
  faction: {
    publicFaceGoals: "A trade guild claiming to protect local artisans.",
    internalConflictSecret: "Its leadership is split over dealing with the Ashfall Company.",
    resourcesReach: "Controls most of the town's metalworking supply chain.",
    hookConsequence: "Crossing them cuts off the party's access to repairs."
  },
  object: {
    appearance: "A plain iron key, unusually heavy.",
    mechanicalProperties: "Opens any lock forged by Alvor himself.",
    originSecret: "Forged from meteoric iron, not ordinary ore.",
    discovery: "Found among the smith's belongings.",
    potentialRolls: [{ skill: "Arcana", dc: 15, purpose: "Recognize the meteoric iron." }]
  },
  event: {
    publicAccount: "A fire damaged the old forge district a decade ago.",
    actualTruth: "The fire was set to cover up a theft.",
    rippleConsequences: "The district was never fully rebuilt.",
    potentialRolls: [{ skill: "History", dc: 12, purpose: "Recall rumors about the fire's true cause." }]
  },
  concept: {
    description: "The town's unspoken code of debt and obligation among artisans.",
    howItSurfaces: "NPCs refuse favors that would violate an outstanding debt."
  }
};

// ------------------------------------------------------------------- basics

test("directory isolation: prepContentRoot() honors GM_TOOLS_PREP_CONTENT_DIR, never the repo's real default", () => {
  assert.equal(prepContentRoot(), process.env.GM_TOOLS_PREP_CONTENT_DIR);
  assert.notEqual(prepContentRoot(), REPO_DEFAULT_ROOT);
});

test("getPrepContent: an entity never developed returns null, not an error", () => {
  assert.equal(getPrepContent(WORLD, "never-developed"), null);
});

for (const entityType of Object.keys(FIELDS_BY_TYPE_FIXTURE)) {
  test(`save-then-get round trip for entity type "${entityType}"`, () => {
    const entityId = `entity-${entityType}`;
    const saved = savePrepContent(
      WORLD,
      entityId,
      { entityType, framingUsed: "a test framing", fields: FIELDS_BY_TYPE_FIXTURE[entityType] },
      { now: "2026-01-01T00:00:00.000Z" }
    );
    assert.equal(saved.status, "proposed", "savePrepContent defaults to status:'proposed'");
    assert.equal(saved.entityId, entityId);
    assert.equal(saved.entityType, entityType);
    assert.equal(saved.generatedAt, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(saved.fields, FIELDS_BY_TYPE_FIXTURE[entityType]);

    const fetched = getPrepContent(WORLD, entityId);
    assert.deepEqual(fetched, saved);
  });
}

test("savePrepContent rejects a fields object that doesn't match the entity type's template", () => {
  assert.throws(() =>
    savePrepContent(WORLD, "bad-fields", { entityType: "person", framingUsed: "x", fields: { onlyOneField: "nope" } })
  );
});

test("fieldsSchemaForType throws for an unknown entity type", () => {
  assert.throws(() => fieldsSchemaForType("not-a-real-type"));
});

test("fieldSpecTextForType/fieldDescription return real text for every known type", () => {
  for (const type of Object.keys(FIELDS_BY_TYPE_FIXTURE)) {
    assert.ok(fieldSpecTextForType(type).length > 0);
    const firstField = Object.keys(fieldsSchemaForType(type).shape)[0];
    assert.notEqual(fieldDescription(type, firstField), "(no description recorded for this field)");
  }
});

// --------------------------------------------------------------- accept / discard

test("acceptPrepContent flips status to 'accepted' without touching fields", () => {
  const entityId = "accept-me";
  savePrepContent(WORLD, entityId, { entityType: "place", framingUsed: "f", fields: FIELDS_BY_TYPE_FIXTURE.place });
  const accepted = acceptPrepContent(WORLD, entityId);
  assert.equal(accepted.status, "accepted");
  assert.deepEqual(accepted.fields, FIELDS_BY_TYPE_FIXTURE.place);
});

test("acceptPrepContent throws when nothing has been proposed yet", () => {
  assert.throws(() => acceptPrepContent(WORLD, "never-proposed"));
});

test("discardPrepContent removes a 'proposed' draft and is a safe no-op on nothing", () => {
  const entityId = "discard-me";
  savePrepContent(WORLD, entityId, { entityType: "concept", framingUsed: "f", fields: FIELDS_BY_TYPE_FIXTURE.concept });
  assert.ok(getPrepContent(WORLD, entityId));
  const result = discardPrepContent(WORLD, entityId);
  assert.deepEqual(result, { entityId, discarded: true });
  assert.equal(getPrepContent(WORLD, entityId), null);

  assert.equal(discardPrepContent(WORLD, "nothing-here-either"), null);
});

test("discardPrepContent refuses to remove an accepted or stale doc", () => {
  const entityId = "protected-doc";
  savePrepContent(WORLD, entityId, { entityType: "object", framingUsed: "f", fields: FIELDS_BY_TYPE_FIXTURE.object });
  acceptPrepContent(WORLD, entityId);
  assert.throws(() => discardPrepContent(WORLD, entityId));
  assert.ok(getPrepContent(WORLD, entityId), "still there after the refused discard");
});

// --------------------------------------------------------------- staleness (task 11.1/11.4)

test("markPrepContentStale flips status without deleting fields", () => {
  const entityId = "stale-me";
  savePrepContent(WORLD, entityId, { entityType: "event", framingUsed: "f", fields: FIELDS_BY_TYPE_FIXTURE.event });
  acceptPrepContent(WORLD, entityId);
  const staled = markPrepContentStale(WORLD, entityId);
  assert.equal(staled.status, "stale");
  assert.deepEqual(staled.fields, FIELDS_BY_TYPE_FIXTURE.event, "fields are untouched by going stale");
});

test("markPrepContentStale on an entity with no prep content is a safe no-op", () => {
  assert.equal(markPrepContentStale(WORLD, "never-touched"), null);
});

test("markPrepContentStale is idempotent (staling an already-stale doc doesn't error)", () => {
  const entityId = "already-stale";
  savePrepContent(WORLD, entityId, { entityType: "faction", framingUsed: "f", fields: FIELDS_BY_TYPE_FIXTURE.faction });
  markPrepContentStale(WORLD, entityId);
  const again = markPrepContentStale(WORLD, entityId);
  assert.equal(again.status, "stale");
});

// --------------------------------------------------------------- field-granular edit (task 11.1)

test("updatePrepField mutates one field without touching any other", () => {
  const entityId = "field-edit-me";
  savePrepContent(WORLD, entityId, { entityType: "person", framingUsed: "f", fields: FIELDS_BY_TYPE_FIXTURE.person });
  const updated = updatePrepField(WORLD, entityId, "secret", "A completely different secret now.", { now: "2026-03-01T00:00:00.000Z" });
  assert.equal(updated.fields.secret, "A completely different secret now.");
  for (const key of Object.keys(FIELDS_BY_TYPE_FIXTURE.person)) {
    if (key === "secret") continue;
    assert.deepEqual(updated.fields[key], FIELDS_BY_TYPE_FIXTURE.person[key], `field "${key}" must be untouched`);
  }
  assert.equal(updated.lastRegeneratedAt, "2026-03-01T00:00:00.000Z");
});

test("updatePrepField rejects an unknown field name", () => {
  const entityId = "field-edit-unknown";
  savePrepContent(WORLD, entityId, { entityType: "person", framingUsed: "f", fields: FIELDS_BY_TYPE_FIXTURE.person });
  assert.throws(() => updatePrepField(WORLD, entityId, "notARealField", "x"));
});

test("updatePrepField rejects a value that doesn't match the field's own shape", () => {
  const entityId = "field-edit-bad-shape";
  savePrepContent(WORLD, entityId, { entityType: "person", framingUsed: "f", fields: FIELDS_BY_TYPE_FIXTURE.person });
  assert.throws(() => updatePrepField(WORLD, entityId, "potentialRolls", "not an array"));
});

test("updatePrepField throws for an entity with no prep content at all", () => {
  assert.throws(() => updatePrepField(WORLD, "no-doc-yet", "secret", "x"));
});

// --------------------------------------------------------------- concurrency

test("concurrent write: an existing lock file causes savePrepContent to throw ConcurrentWriteError, not silently clobber", () => {
  const entityId = "concurrent-entity";
  savePrepContent(WORLD, entityId, { entityType: "place", framingUsed: "f", fields: FIELDS_BY_TYPE_FIXTURE.place });
  const before2 = getPrepContent(WORLD, entityId);

  const lockPath = join(prepContentRoot(), WORLD, `${entityId}.json.lock`);
  const fd = openSync(lockPath, "wx");
  try {
    assert.throws(
      () => savePrepContent(WORLD, entityId, { entityType: "place", framingUsed: "different", fields: FIELDS_BY_TYPE_FIXTURE.place }),
      ConcurrentWriteError
    );
    assert.deepEqual(getPrepContent(WORLD, entityId), before2, "must be unchanged after a rejected concurrent write");
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }

  savePrepContent(WORLD, entityId, { entityType: "place", framingUsed: "after lock clears", fields: FIELDS_BY_TYPE_FIXTURE.place });
  assert.equal(getPrepContent(WORLD, entityId).framingUsed, "after lock clears");
});

// =====================================================================
// Task 11.2: framing + generation calls (mocked LLM -- orchestration/
// validation/retry logic only, per gm-tools-conventions; no assertion on
// exact LLM-produced text).
// =====================================================================

const personEntity = { id: "alvor", name: "Alvor", type: "person", description: "A smith in Riverwood." };
const placeEntity = { id: "riverwood", name: "Riverwood", type: "place", description: "A small trading town." };

function validFramingsJson(prefix = "") {
  return JSON.stringify({
    framings: [
      { id: "a", sentence: `${prefix}Angle A.` },
      { id: "b", sentence: `${prefix}Angle B.` },
      { id: "c", sentence: `${prefix}Angle C.` }
    ]
  });
}

test("proposeFramingsForEntity: returns exactly 3 validated framings on a clean response", async () => {
  const client = mockClient([validFramingsJson()]);
  const { framings } = await proposeFramingsForEntity(personEntity, { neighborDescriptions: ["Gerdur (kinship)"] }, { client });
  assert.equal(framings.length, 3);
  assert.deepEqual(new Set(framings.map((f) => f.id)), new Set(["a", "b", "c"]));
});

test("proposeFramingsForEntity: retries once on invalid JSON, then succeeds", async () => {
  const client = mockClient(["not json at all", validFramingsJson("retried-")]);
  const { framings } = await proposeFramingsForEntity(personEntity, [], { client });
  assert.equal(client.calls.length, 2);
  assert.equal(framings[0].sentence, "retried-Angle A.");
});

test("proposeFramingsForEntity: throws PrepFramingProposalError after two failures", async () => {
  const client = mockClient(["nope", "still nope"]);
  await assert.rejects(() => proposeFramingsForEntity(personEntity, [], { client }), PrepFramingProposalError);
});

test("proposeFramingsForEntity: throws on truncation after doubling the budget once", async () => {
  const client = mockClient([{ text: "{incomplete", stopReason: "max_tokens" }]);
  await assert.rejects(() => proposeFramingsForEntity(personEntity, [], { client, maxTokens: 10 }), PrepFramingProposalError);
});

test("proposeFramingsForEntity: throws for an unknown entity type before spending a call", async () => {
  const client = mockClient([validFramingsJson()]);
  await assert.rejects(() => proposeFramingsForEntity({ name: "X", type: "not-a-type" }, [], { client }));
  assert.equal(client.calls.length, 0);
});

test("requestPrepReframing: refuses (throws PrepFramingRoundLimitError) once the bounded budget is spent, without spending a call", async () => {
  const client = mockClient([validFramingsJson()]);
  await assert.rejects(
    () => requestPrepReframing(personEntity, [], MAX_PREP_FRAMING_ROUNDS, { client }),
    PrepFramingRoundLimitError
  );
  assert.equal(client.calls.length, 0, "must not spend an API call once the budget is already exhausted");
});

test("requestPrepReframing: succeeds when budget remains", async () => {
  const client = mockClient([validFramingsJson()]);
  const { framings } = await requestPrepReframing(personEntity, [], MAX_PREP_FRAMING_ROUNDS - 1, { client });
  assert.equal(framings.length, 3);
});

test("composePrepFramingNote: builds steering text from a primary selection, plus an optional blend", () => {
  const note = composePrepFramingNote({ primary: { id: "a", sentence: "He's secretly in debt." } });
  assert.match(note, /secretly in debt/);
  const withBlend = composePrepFramingNote({ primary: { id: "a", sentence: "X." }, blend: "also bring in Y" });
  assert.match(withBlend, /also bring in Y/);
});

test("composePrepFramingNote: throws without a valid primary", () => {
  assert.throws(() => composePrepFramingNote({}));
});

// ----------------------------------------------------- generatePrepContent

test("generatePrepContent: a PERSON produces the person template shape (regression guard: type-appropriate structure, not generic)", async () => {
  const client = mockClient([JSON.stringify({ fields: FIELDS_BY_TYPE_FIXTURE.person })]);
  const { fields } = await generatePrepContent(personEntity, [], "steer toward the debt angle", { client });
  assert.deepEqual(new Set(Object.keys(fields)), new Set(Object.keys(fieldsSchemaForType("person").shape)));
});

test("generatePrepContent: a PLACE produces the place template shape, genuinely different keys than person's", async () => {
  const client = mockClient([JSON.stringify({ fields: FIELDS_BY_TYPE_FIXTURE.place })]);
  const { fields } = await generatePrepContent(placeEntity, [], "steer toward the hidden cellar", { client });
  const placeKeys = new Set(Object.keys(fields));
  assert.deepEqual(placeKeys, new Set(Object.keys(fieldsSchemaForType("place").shape)));
  const personKeys = new Set(Object.keys(fieldsSchemaForType("person").shape));
  assert.notDeepEqual(placeKeys, personKeys, "place and person templates must have genuinely different field shapes");
});

test("generatePrepContent: rejects a response missing required fields", async () => {
  const client = mockClient([JSON.stringify({ fields: { descriptionAppearance: "only one field" } }), JSON.stringify({ fields: { descriptionAppearance: "still incomplete" } })]);
  await assert.rejects(() => generatePrepContent(personEntity, [], "note", { client }), PrepGenerationError);
});

test("generatePrepContent: rejects a response with fields from the WRONG entity type (e.g. person fields for a place)", async () => {
  const client = mockClient([JSON.stringify({ fields: FIELDS_BY_TYPE_FIXTURE.person }), JSON.stringify({ fields: FIELDS_BY_TYPE_FIXTURE.person })]);
  await assert.rejects(() => generatePrepContent(placeEntity, [], "note", { client }), PrepGenerationError);
});

// ----------------------------------------------------- regeneratePrepField

test("regeneratePrepField: returns just the new value for the named field, validated against its own schema", async () => {
  const client = mockClient([JSON.stringify({ value: "A brand-new secret entirely." })]);
  const newValue = await regeneratePrepField(personEntity, [], FIELDS_BY_TYPE_FIXTURE.person, "secret", "make it darker", { client });
  assert.equal(newValue, "A brand-new secret entirely.");
});

test("regeneratePrepField: validates an array-shaped field (potentialRolls) correctly", async () => {
  const newRolls = [{ skill: "Persuasion", dc: 16, purpose: "Talk him down." }];
  const client = mockClient([JSON.stringify({ value: newRolls })]);
  const newValue = await regeneratePrepField(personEntity, [], FIELDS_BY_TYPE_FIXTURE.person, "potentialRolls", undefined, { client });
  assert.deepEqual(newValue, newRolls);
});

test("regeneratePrepField: rejects an unknown field name before spending a call", async () => {
  const client = mockClient([JSON.stringify({ value: "x" })]);
  await assert.rejects(() => regeneratePrepField(personEntity, [], FIELDS_BY_TYPE_FIXTURE.person, "notAField", undefined, { client }));
  assert.equal(client.calls.length, 0);
});

test("no write in this file leaked into the repo's real default prep-content/ directory (the Phase 4 lesson)", () => {
  const after = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();
  const added = [...after].filter((f) => !before.has(f));
  assert.deepEqual(added, [], `this test run must not add new entries to ${REPO_DEFAULT_ROOT}, found: ${added}`);
});

await Promise.all(pending);
console.log(`\n${passed} passed`);

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
