import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — the WS-D (table round 2026-09-09) notes routes in
 * review-ui/server.mjs, wrapping session-planner/session-notes.mjs's
 * listPendingNotes / updateNoteText / deleteNote. The Add Event control
 * creates ONE note then edits it in place as the GM types (the old
 * "notes save — duplicated" gap), and the "Notes — this scene" strip in
 * Prep and Run reads them back.
 *
 *   GET    /api/session-planner/notes?world=&sceneId=   -> { notes }  (pending only)
 *   POST   /api/session-planner/notes/:noteId  { world, text } -> { note }
 *   DELETE /api/session-planner/notes/:noteId?world=      -> { note }
 *
 * Unknown id -> 404; a note already consumed by a wrap/intake batch -> 409
 * (it is history now, the strip must not be able to rewrite it).
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-session-notes-routes-test-"));
const notesDir = join(scratchDir, "session-notes");
process.env.GM_TOOLS_SESSION_NOTES_DIR = notesDir;
process.env.WF_DATA_DIR = join(scratchDir, "foundrydata");

const WORLD = "session-notes-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { createReviewServer } = await import("../server.mjs");

let server;
let base;

before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}
const getJson = (p) => call("GET", p);
const postJson = (p, b) => call("POST", p, b);
const del = (p, b) => call("DELETE", p, b);

async function createNote(text, sceneId) {
  const { status, body } = await postJson("/api/session-planner/notes", { world: WORLD, text, sceneId });
  assert.equal(status, 200);
  return body.note;
}

test("GET /api/session-planner/notes lists pending notes, filtered by sceneId when given", async () => {
  const a = await createNote("first thing that happened", "scene-A");
  const b = await createNote("second thing", "scene-A");
  const c = await createNote("elsewhere", "scene-B");

  const all = await getJson(`/api/session-planner/notes?world=${WORLD}`);
  assert.equal(all.status, 200);
  const allIds = all.body.notes.map((n) => n.id);
  for (const id of [a.id, b.id, c.id]) assert.ok(allIds.includes(id), `unfiltered list carries ${id}`);

  const sceneA = await getJson(`/api/session-planner/notes?world=${WORLD}&sceneId=scene-A`);
  assert.deepEqual(sceneA.body.notes.map((n) => n.id), [a.id, b.id], "scene filter keeps capture order");
  assert.ok(!sceneA.body.notes.some((n) => n.id === c.id));
});

test("POST /api/session-planner/notes/:noteId edits the text in place -- no second note is created", async () => {
  const note = await createNote("Gravel-Tooth re", "scene-edit");
  const before = (await getJson(`/api/session-planner/notes?world=${WORLD}&sceneId=scene-edit`)).body.notes.length;

  const { status, body } = await postJson(`/api/session-planner/notes/${note.id}`, { world: WORLD, text: "Gravel-Tooth re-opened the number" });
  assert.equal(status, 200);
  assert.equal(body.note.id, note.id);
  assert.equal(body.note.text, "Gravel-Tooth re-opened the number");

  const after = (await getJson(`/api/session-planner/notes?world=${WORLD}&sceneId=scene-edit`)).body.notes;
  assert.equal(after.length, before, "the edit rewrote the note rather than appending another");
  assert.equal(after.find((n) => n.id === note.id).text, "Gravel-Tooth re-opened the number");
});

test("POST /api/session-planner/notes/:noteId rejects a non-string text with 400", async () => {
  const note = await createNote("x", "scene-400");
  const { status } = await postJson(`/api/session-planner/notes/${note.id}`, { world: WORLD, text: 42 });
  assert.equal(status, 400);
});

test("DELETE /api/session-planner/notes/:noteId removes the note (world from the query string)", async () => {
  const note = await createNote("scratch that", "scene-del");
  const { status, body } = await del(`/api/session-planner/notes/${note.id}?world=${WORLD}`);
  assert.equal(status, 200);
  assert.equal(body.note.id, note.id);
  const list = await getJson(`/api/session-planner/notes?world=${WORLD}&sceneId=scene-del`);
  assert.equal(list.body.notes.length, 0);
});

test("edit / delete of an unknown note id -> 404", async () => {
  assert.equal((await postJson(`/api/session-planner/notes/note_nope`, { world: WORLD, text: "?" })).status, 404);
  assert.equal((await del(`/api/session-planner/notes/note_nope?world=${WORLD}`)).status, 404);
});

test("edit / delete of a note already consumed by a batch -> 409, and the note is untouched", async () => {
  const note = await createNote("already wrapped", "scene-409");
  // Mark it consumed the way runBatchIntake does (store-level, no LLM involved).
  const file = join(notesDir, `${WORLD}.json`);
  const notes = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify(notes.map((n) => (n.id === note.id ? { ...n, consumed: true, consumedAt: new Date().toISOString(), consumedByBatchId: "batch_test" } : n))));

  const edit = await postJson(`/api/session-planner/notes/${note.id}`, { world: WORLD, text: "rewrite history" });
  assert.equal(edit.status, 409);
  assert.match(edit.body.error ?? "", /already consumed/i);
  assert.equal((await del(`/api/session-planner/notes/${note.id}?world=${WORLD}`)).status, 409);

  const still = JSON.parse(readFileSync(file, "utf8")).find((n) => n.id === note.id);
  assert.equal(still.text, "already wrapped");
  // Consumed notes are history: the pending list no longer shows them.
  const list = await getJson(`/api/session-planner/notes?world=${WORLD}&sceneId=scene-409`);
  assert.equal(list.body.notes.length, 0);
});

test("SECURITY: the notes routes reject a path-traversal-shaped world id with 400", async () => {
  assert.equal((await getJson(`/api/session-planner/notes?world=${encodeURIComponent("../../../../etc")}`)).status, 400);
  assert.equal((await postJson(`/api/session-planner/notes/note_x`, { world: "../../../../etc", text: "x" })).status, 400);
  assert.equal((await del(`/api/session-planner/notes/note_x?world=${encodeURIComponent("../../../../etc")}`)).status, 400);
});
