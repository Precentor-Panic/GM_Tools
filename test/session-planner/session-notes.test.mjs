import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — session-planner/session-notes.mjs (Phase 16 task
 * 16.4). This module does not exist yet; this file is the interface spec
 * for it, per plans/phase-16-tasks.md task 16.0. It is expected to fail with
 * "Cannot find module" until 16.4 lands.
 *
 * Design record §6 ("Notes-as-deferred-intake"): notes are raw material for
 * the EXISTING writeup-import/scan-mentions pipeline, batched and deferred,
 * never a new durable "informal graph" layer. This module is a thin adapter
 * over graph-import/scan-mentions.mjs's real primitives
 * (proposeMentionedEntities, applyFuzzyPrepass, previewMentionScan) plus one
 * NEW small deterministic step (applyAnchorHint, below) that this task adds
 * specifically to make a note's capture-time anchor a genuinely
 * high-confidence resolution hint — not new intake LOGIC, a new intake
 * INPUT-SHAPING step feeding the same existing dedup machinery.
 *
 * Storage: ONE JSON file per world (human-review.mjs's convention) --
 * `<sessionNotesRoot>/<world>.json`, a flat array of SessionNote objects (the
 * store's real query pattern -- listPendingNotes -- needs "every unconsumed
 * note in this world" as a first-class scan, same reasoning
 * session-planner/scenes.mjs already uses for ITS one-file-per-world choice).
 * Default root GM_Tools/session-notes/; override with
 * GM_TOOLS_SESSION_NOTES_DIR. Reuses review-state.mjs's withLock (for its own
 * store writes) AND review-state.mjs's createBatch (runBatchIntake's actual
 * output lands as a normal Batch) -- so GM_TOOLS_REVIEW_STATE_DIR must ALSO
 * be isolated by any test importing this module.
 *
 * SessionNote shape:
 *   {
 *     id: string,
 *     world: string,
 *     text: string,
 *     anchorEntityId: string|null,
 *     sceneId: string|null,
 *     timestamp: string,             // ISO, capture time
 *     consumed: boolean,             // false until a successful runBatchIntake call
 *     consumedAt: string|null,
 *     consumedByBatchId: string|null
 *   }
 *
 * ---------------------------------------------------------------------------
 * captureNote(world, { text, anchorEntityId, sceneId }, opts)
 * ---------------------------------------------------------------------------
 * ZERO-CEREMONY capture (design §6): no validation beyond the world-id check
 * already centralized in wf-mcp-server/lib/resolve.mjs (this module itself
 * does not re-validate world format -- that's the HTTP layer's job, task
 * 16.6). anchorEntityId/sceneId both optional (default null). NEVER writes
 * to review-state.mjs, NEVER touches canon -- captureNote is a pure append
 * to this module's own store.
 *   @param {object} [opts]
 *   @param {() => string} [opts.makeId]
 *   @param {string} [opts.now]
 *   @returns {object}   the created SessionNote, consumed:false
 *
 * ---------------------------------------------------------------------------
 * listPendingNotes(world)
 * ---------------------------------------------------------------------------
 * @returns {object[]}   every SessionNote for `world` with consumed:false,
 *                        in capture order. [] if none.
 *
 * ---------------------------------------------------------------------------
 * applyAnchorHint(mentions, anchorEntity)
 * ---------------------------------------------------------------------------
 * NEW deterministic pre-pass, pure, no I/O. Runs BEFORE
 * graph-import/scan-mentions.mjs's applyFuzzyPrepass in runBatchIntake's own
 * pipeline. For every mention whose normalized name-token set (same
 * stopword-stripped tokenization scan-mentions.mjs's nameSimilarity already
 * uses conceptually -- lowercase, strip punctuation, drop "the/a/an/of/...")
 * is a non-empty SUBSET or SUPERSET of anchorEntity's own normalized
 * name-token set, rewrites that mention's `name` to anchorEntity.name
 * EXACTLY (tagging the original under `anchorMatchedFrom`, mirroring
 * applyFuzzyPrepass's own `fuzzyMatchedFrom` convention) so it resolves
 * through previewMentionScan's real dedup as a LINK to the real anchor
 * entity, not a proposed duplicate.
 *
 * WHY THIS IS GENUINELY NECESSARY, NOT REDUNDANT WITH applyFuzzyPrepass: a
 * note anchored to "Mira the Quartermaster" that just says "the
 * quartermaster" would score only ~0.5 under scan-mentions.mjs's own
 * nameSimilarity (token-Jaccard of {quartermaster} vs {mira, quartermaster}
 * = 1/2) -- well under FUZZY_MATCH_THRESHOLD (0.75), so the EXISTING
 * cross-graph fuzzy pre-pass alone would NOT catch it. The anchor is a
 * stronger, human-confirmed signal ("this note was captured specifically
 * against this entity") that this task's own step exploits with a more
 * permissive subset/superset check, deliberately scoped to just the ONE
 * anchor entity (not cross-graph) so it can afford to be looser without the
 * false-positive risk a graph-wide loose threshold would carry.
 *
 *   @param {Array<{name:string, type:string, description?:string}>} mentions
 *   @param {object|null} anchorEntity   {id, name, type, ...} or null/undefined
 *                                       -- a no-op (mentions returned
 *                                       unchanged) when there's no anchor.
 *   @returns {Array<{name:string, type:string, description?:string, anchorMatchedFrom?:string}>}
 *
 * ---------------------------------------------------------------------------
 * runBatchIntake(world, noteIds, existingSnapshot, opts)
 * ---------------------------------------------------------------------------
 * The full deferred-intake pipeline. V1 SCOPE DECISION (documented here,
 * binding for the implementation): every noteId passed in MUST have a
 * non-null anchorEntityId that resolves to a real entity in
 * existingSnapshot.entities -- runBatchIntake throws a clear error listing
 * the offending note id(s) otherwise. (Design record §6 describes capture as
 * "auto-anchored to whatever entity/scene is already current" -- in practice
 * a note always has SOME anchor; a fully anchor-less note is out of this
 * task's v1 scope, not silently dropped.)
 *
 * Pipeline, per note group (notes sharing the same anchorEntityId are
 * concatenated, in capture order, into one combined scan text):
 *   1. proposeMentionedEntities(combinedText, {name, type} of the anchor
 *      entity, opts.llmOpts ?? {})  -- THE LLM CALL, same DI convention
 *      (opts.llmOpts.client, Anthropic-SDK-shaped) as every other LLM call
 *      site in this codebase (mutation-engine/llm-call.mjs's
 *      callModelDetailed).
 *   2. applyAnchorHint(mentions, anchorEntity)
 *   3. applyFuzzyPrepass(hinted, existingSnapshot.entities)   [reused, not
 *      reimplemented, from graph-import/scan-mentions.mjs]
 *   4. previewMentionScan(prepassed, anchorEntityId, existingSnapshot, opts)
 *      [reused from graph-import/scan-mentions.mjs -- produces this group's
 *      mutations, sourceEntityId := the anchor entity, exactly like a normal
 *      "scan this entity's content for mentions" call]
 * All groups' mutations are concatenated, run through time-skip/run.mjs's
 * attachDiffs (same as scanForMentionedEntities does), and persisted as ONE
 * mutation-engine/review-state.mjs Batch via createBatch (scope.mode:
 * 'session-notes-intake') -- landing on the EXISTING pending review/accept
 * gate exactly like any other proposal (design §6: "No new 'promote to
 * canon' UI concept"). Every mutation in the freshly-created batch has
 * status:'pending' -- runBatchIntake NEVER calls acceptMutations/
 * updateMutationStatus itself, this is a hard invariant this task's tests
 * assert directly.
 *
 * ONLY once createBatch succeeds, marks every consumed noteId's SessionNote
 * consumed:true, consumedAt:now, consumedByBatchId:batch.id (matches
 * entity-narration.mjs's supersede-not-delete "nothing is silently lost"
 * convention: notes are marked consumed, never deleted).
 *
 *   @param {string} world
 *   @param {string[]} noteIds
 *   @param {{entities:object[], edges:object[], entityTypes?:object[]}} existingSnapshot
 *   @param {object} [opts]
 *   @param {object} [opts.llmOpts]     forwarded to proposeMentionedEntities
 *   @param {() => string} [opts.makeId]   batch id generator, injectable for tests
 *   @returns {Promise<{
 *     batchId: string,
 *     mutationCount: number,
 *     linkCount: number,
 *     newCount: number,
 *     headline: string,
 *     consumedNoteIds: string[]
 *   }>}
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
async function atest(name, fn) {
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

// Isolate BOTH review-state.mjs (createBatch + withLock) and this module's
// own root, before importing either.
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-session-notes-test-"));
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_SESSION_NOTES_DIR = join(scratchDir, "session-notes");

const REPO_DEFAULT_ROOT = join(new URL("../../session-notes", import.meta.url).pathname);
const beforeDirState = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();

const WORLD = "session-planner-notes-test-world";

const EXISTING_ENTITY_TYPES = [
  { id: "person", attributeDefs: [] },
  { id: "place", attributeDefs: [] },
  { id: "faction", attributeDefs: [] },
  { id: "object", attributeDefs: [] },
  { id: "event", attributeDefs: [] },
  { id: "concept", attributeDefs: [] }
];

/** Same mockClient shape as test/writeup-import.test.mjs / test/scan-mentions.smoke.mjs's own real client -- an Anthropic-SDK-shaped stub. */
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
        return { content: [{ type: "text", text: typeof resp === "function" ? resp(params) : resp }], stop_reason: "end_turn" };
      }
    }
  };
}

(async () => {
  const { captureNote, listPendingNotes, applyAnchorHint, runBatchIntake, sessionNotesRoot } =
    await import("../../session-planner/session-notes.mjs");
  const { loadBatch } = await import("../../mutation-engine/review-state.mjs");

  test("directory isolation: sessionNotesRoot() honors GM_TOOLS_SESSION_NOTES_DIR, never the repo's real default", () => {
    assert.equal(sessionNotesRoot(), process.env.GM_TOOLS_SESSION_NOTES_DIR);
    assert.notEqual(sessionNotesRoot(), REPO_DEFAULT_ROOT);
  });

  // ------------------------------------------------------------- captureNote

  test("captureNote: zero-ceremony capture -- text plus an anchor, consumed:false", () => {
    const note = captureNote(
      WORLD,
      { text: "The quartermaster mentioned a shipment going missing near the old bridge.", anchorEntityId: "mira-quartermaster", sceneId: "scene-1" },
      { makeId: () => "note-1", now: "2026-07-22T20:00:00.000Z" }
    );
    assert.equal(note.id, "note-1");
    assert.equal(note.text, "The quartermaster mentioned a shipment going missing near the old bridge.");
    assert.equal(note.anchorEntityId, "mira-quartermaster");
    assert.equal(note.sceneId, "scene-1");
    assert.equal(note.consumed, false);
    assert.equal(note.consumedAt, null);
  });

  test("listPendingNotes: returns only unconsumed notes, in capture order", () => {
    const w = "session-planner-notes-listing-world";
    captureNote(w, { text: "first", anchorEntityId: "x" }, { makeId: () => "list-note-1", now: "2026-07-22T20:01:00.000Z" });
    captureNote(w, { text: "second", anchorEntityId: "x" }, { makeId: () => "list-note-2", now: "2026-07-22T20:02:00.000Z" });
    const pending = listPendingNotes(w);
    assert.deepEqual(pending.map((n) => n.id), ["list-note-1", "list-note-2"]);
  });

  // -------------------------------------------------------------- applyAnchorHint

  test("applyAnchorHint: no-op when anchorEntity is null", () => {
    const mentions = [{ name: "the quartermaster", type: "person" }];
    assert.deepEqual(applyAnchorHint(mentions, null), mentions);
  });

  test("THE ANCHOR-HINT TEST: 'the quartermaster' resolves to the exact anchor entity name 'Mira the Quartermaster' (a partial-name near-miss the generic fuzzy pre-pass alone would NOT catch)", () => {
    const anchorEntity = { id: "mira-quartermaster", name: "Mira the Quartermaster", type: "person" };
    const mentions = [
      { name: "the quartermaster", type: "person", description: "Complained about a missing shipment." },
      { name: "the old bridge", type: "place", description: "Where the shipment went missing." }
    ];
    const hinted = applyAnchorHint(mentions, anchorEntity);
    const quartermasterMention = hinted.find((m) => m.anchorMatchedFrom === "the quartermaster");
    assert.ok(quartermasterMention, "the quartermaster mention should be tagged as anchor-matched");
    assert.equal(quartermasterMention.name, "Mira the Quartermaster", "rewritten to the anchor entity's EXACT stored name");

    const bridgeMention = hinted.find((m) => m.name === "the old bridge");
    assert.ok(bridgeMention, "an unrelated mention must pass through untouched");
    assert.equal(bridgeMention.anchorMatchedFrom, undefined);
  });

  test("applyAnchorHint: does NOT rewrite a genuinely different-sounding mention just because it shares a type with the anchor", () => {
    const anchorEntity = { id: "mira-quartermaster", name: "Mira the Quartermaster", type: "person" };
    const mentions = [{ name: "Old Kellan", type: "person" }]; // a different person entirely, no token overlap with "Mira Quartermaster"
    const hinted = applyAnchorHint(mentions, anchorEntity);
    assert.equal(hinted[0].name, "Old Kellan", "must be left alone -- no plausible relation to the anchor entity's name");
    assert.equal(hinted[0].anchorMatchedFrom, undefined);
  });

  // -------------------------------------------------------------- runBatchIntake

  await atest("THE DUPLICATE-AVOIDANCE TEST: a note anchored to 'Mira the Quartermaster' mentioning 'the quartermaster' resolves to a LINK on the EXISTING entity, never a proposed duplicate (design record §6)", async () => {
    const w = "session-planner-notes-dedup-world";
    const existingSnapshot = {
      entities: [{ id: "mira-quartermaster", name: "Mira the Quartermaster", type: "person", importance: 0.5, tags: [], attributes: {} }],
      edges: [],
      entityTypes: EXISTING_ENTITY_TYPES
    };
    const note = captureNote(
      w,
      { text: "The quartermaster grumbled about a shipment going missing near the old bridge.", anchorEntityId: "mira-quartermaster" },
      { makeId: () => "dup-note-1", now: "2026-07-22T21:00:00.000Z" }
    );

    const llmResponse = JSON.stringify({
      mentions: [
        { name: "the quartermaster", type: "person", description: "Grumbled about the missing shipment." },
        { name: "Riverside Bridge", type: "place", description: "Where the shipment went missing." }
      ]
    });
    const client = mockClient([llmResponse]);

    const result = await runBatchIntake(w, [note.id], existingSnapshot, { llmOpts: { client }, makeId: () => "intake-batch-1" });

    assert.equal(result.linkCount, 1, "the quartermaster mention must resolve as a LINK to the existing entity");
    assert.equal(result.newCount, 1, "only the genuinely new bridge entity should be proposed as new");

    const batch = loadBatch(w, result.batchId);
    const entityCreateMutations = batch.mutations.filter((m) => m.op === "upsert_entity");
    assert.equal(entityCreateMutations.length, 1, "exactly one NEW entity create -- the quartermaster mention must NOT produce a second create");
    assert.equal(entityCreateMutations[0].data.name, "Riverside Bridge");

    const edgeToQuartermaster = batch.mutations.find((m) => m.op === "upsert_edge" && m.data.targetId === "mira-quartermaster");
    assert.ok(edgeToQuartermaster, "must propose a link edge to the REAL existing quartermaster entity");
  });

  await atest("THE NEVER-AUTO-WRITES-TO-CANON TEST: runBatchIntake's output batch is entirely status:'pending', never accepted, and the source notes stay inert (consumed:false) until intake explicitly runs", async () => {
    const w = "session-planner-notes-no-autowrite-world";
    const existingSnapshot = {
      entities: [{ id: "anchor-npc", name: "Borin", type: "person", importance: 0.5, tags: [], attributes: {} }],
      edges: [],
      entityTypes: EXISTING_ENTITY_TYPES
    };
    const note = captureNote(w, { text: "Borin's cousin showed up asking about the debt.", anchorEntityId: "anchor-npc" }, {
      makeId: () => "no-autowrite-note-1",
      now: "2026-07-22T22:00:00.000Z"
    });

    // Before intake: the note is captured but stays inert -- NOT consumed,
    // and nothing whatsoever has been written to review-state.mjs yet.
    assert.equal(note.consumed, false);
    assert.deepEqual(listPendingNotes(w).map((n) => n.id), ["no-autowrite-note-1"]);

    const llmResponse = JSON.stringify({
      mentions: [{ name: "Borin's cousin", type: "person", description: "Asking about a debt." }]
    });
    const client = mockClient([llmResponse]);
    const result = await runBatchIntake(w, [note.id], existingSnapshot, { llmOpts: { client }, makeId: () => "no-autowrite-batch-1" });

    const batch = loadBatch(w, result.batchId);
    assert.equal(batch.status, "open", "a freshly-intaken batch must be 'open', never auto-synced/accepted");
    assert.ok(batch.mutations.length > 0, "sanity: the batch must actually contain the proposed mutations");
    assert.ok(batch.mutations.every((m) => m.status === "pending"), "EVERY mutation must land as 'pending' on the normal review/accept gate -- runBatchIntake must never call acceptMutations/updateMutationStatus itself");

    // AFTER intake: the note itself is now marked consumed (not deleted --
    // matches entity-narration.mjs's supersede-not-delete convention), and
    // no longer shows up as pending.
    assert.deepEqual(listPendingNotes(w), [], "the intaken note must no longer be listed as pending");
    assert.deepEqual(result.consumedNoteIds, [note.id]);
  });

  await atest("runBatchIntake throws a clear error for a noteId with no anchorEntityId (the v1 scope decision documented above)", async () => {
    const w = "session-planner-notes-noanchor-world";
    const note = captureNote(w, { text: "Something happened but nobody wrote down who." }, { makeId: () => "noanchor-note-1", now: "2026-07-22T23:00:00.000Z" });
    const existingSnapshot = { entities: [], edges: [], entityTypes: EXISTING_ENTITY_TYPES };
    await assert.rejects(
      () => runBatchIntake(w, [note.id], existingSnapshot, {}),
      /anchor/i
    );
  });

  test("no write in this file leaked into the repo's real default session-notes/ directory (the established before/after-diff isolation pattern)", () => {
    const after = existsSync(REPO_DEFAULT_ROOT) ? new Set(readdirSync(REPO_DEFAULT_ROOT)) : new Set();
    const added = [...after].filter((f) => !beforeDirState.has(f));
    assert.deepEqual(added, [], `this test run must not add new entries to ${REPO_DEFAULT_ROOT}, found: ${added}`);
  });

  console.log(`\n${passed} passed`);
})();

process.on("exit", () => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
