import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — Run layout (2026-08-26): the explicit per-element
 * `run` layout {column, role, variant?, placeholder?} (session-planner/
 * scene-elements.mjs `RunLayout`), the scene-level `kind/whereNote/tags/
 * activeVariants` keys (session-planner/scenes.mjs), and the routes that
 * carry them:
 *
 *   POST /api/scene-planning/scenes/:id/elements            { ..., run? }
 *   POST /api/scene-planning/scenes/:id/elements/:elId      { run? }   (replace; null clears)
 *   POST /api/scene-planning/scenes/:id/run-layout/infer    { world }  -> {elements}  (never overwrites)
 *   GET  /api/scene-planning/scenes/:id/run-version?world=  -> {version}
 *   GET  /api/scene-planning/scenes/:id/elements?world=     -> elements carry `bestiary` summary when linked
 *   POST /api/session-planner/scenes/:id                     { kind?, whereNote?, tags?, activeVariants? }
 *   GET  /api/session-planner/stagecraft/:id/image?world=    streams the asset file from under WF_DATA_DIR
 *   GET  /shared/run-layout.mjs                              the one shared inference module, served to the browser
 *
 * Same in-process server.listen(0) + scratch-dir convention as
 * scene-planning-routes.test.mjs.
 */

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-run-layout-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PENDING_LEDGER_DIR = join(scratchDir, "pending-resolution");
process.env.GM_TOOLS_HUMAN_REVIEW_DIR = join(scratchDir, "human-review");
process.env.GM_TOOLS_ENTITY_NARRATION_DIR = join(scratchDir, "entity-narration");
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
process.env.GM_TOOLS_MANUAL_UNDO_DIR = join(scratchDir, "manual-undo");
process.env.GM_TOOLS_SESSION_SCENES_DIR = join(scratchDir, "session-scenes");
process.env.GM_TOOLS_SCENE_ELEMENTS_DIR = join(scratchDir, "scene-elements");
process.env.GM_TOOLS_SCENE_NARRATION_DIR = join(scratchDir, "scene-narration");
process.env.GM_TOOLS_SCENE_UNDO_DIR = join(scratchDir, "scene-undo");
process.env.GM_TOOLS_STAGECRAFT_DIR = join(scratchDir, "stagecraft");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "run-layout-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot } = await import("../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../server.mjs");
const { createScene } = await import("../../session-planner/scenes.mjs");
const { saveBestiaryEntry } = await import("../../combat-planning/bestiary-store.mjs");
const { saveStagecraftAsset } = await import("../../session-planner/stagecraft-store.mjs");

bootstrapSnapshot(snapshotFilePath(dataDir, WORLD), { worldId: WORLD });

let scene;
let server;
let base;

before(async () => {
  scene = createScene(WORLD, { name: "Layout test scene" });
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratchDir, { recursive: true, force: true });
});

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}
async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const elementsPath = () => `/api/scene-planning/scenes/${scene.id}/elements`;

test("element create/patch carry an explicit `run`; patch REPLACES and null clears", async () => {
  const created = await postJson(elementsPath(), { world: WORLD, name: "A beat", run: { column: "main", role: "beat" } });
  assert.equal(created.status, 200);
  assert.deepEqual(created.body.element.run, { column: "main", role: "beat" });

  const patched = await postJson(`${elementsPath()}/${created.body.element.id}`, { world: WORLD, run: { column: "side", role: "gm", variant: "Night" } });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.element.run, { column: "side", role: "gm", variant: "Night" }, "replace, not merge");

  const cleared = await postJson(`${elementsPath()}/${created.body.element.id}`, { world: WORLD, run: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.element.run, null);
});

test("a malformed `run` (unknown role) is rejected with 400 and nothing is written", async () => {
  const bad = await postJson(elementsPath(), { world: WORLD, name: "Bad", run: { column: "main", role: "hero" } });
  assert.equal(bad.status, 400);
  const list = await getJson(`${elementsPath()}?world=${WORLD}`);
  assert.ok(!list.body.elements.some((e) => e.name === "Bad"));
});

test("run-layout/infer writes `run` only where absent, keys off naming conventions, and never overwrites an explicit layout", async () => {
  const s2 = createScene(WORLD, { name: "Infer scene" });
  const p = `/api/scene-planning/scenes/${s2.id}/elements`;
  const readAloud = (await postJson(p, { world: WORLD, name: "Read Aloud — Night", fields: { looks: "Dark." } })).body.element;
  const backdrop = (await postJson(p, { world: WORLD, name: "Backdrop — Present", fields: { looks: "Busy." } })).body.element;
  const exits = (await postJson(p, { world: WORLD, name: "→ Where this leads", fields: { gives: "ONWARD (plot): go → 'Elsewhere'" } })).body.element;
  const explicit = (await postJson(p, { world: WORLD, name: "Read Aloud — Day", run: { column: "off", role: "read" } })).body.element;
  const plain = (await postJson(p, { world: WORLD, name: "A lamp", fields: { looks: "Lit." } })).body.element;

  const inferred = await postJson(`/api/scene-planning/scenes/${s2.id}/run-layout/infer`, { world: WORLD });
  assert.equal(inferred.status, 200);
  const byId = new Map(inferred.body.elements.map((e) => [e.id, e]));
  assert.deepEqual(byId.get(readAloud.id).run, { column: "main", role: "read", variant: "Night" });
  assert.deepEqual(byId.get(backdrop.id).run, { column: "side", role: "gm", variant: "Present" });
  assert.deepEqual(byId.get(exits.id).run, { column: "main", role: "exits" });
  assert.deepEqual(byId.get(explicit.id).run, { column: "off", role: "read" }, "explicit layout untouched");
  assert.deepEqual(byId.get(plain.id).run, { column: "main", role: "dressing" });

  // Idempotent: a second run changes nothing.
  const again = await postJson(`/api/scene-planning/scenes/${s2.id}/run-layout/infer`, { world: WORLD });
  assert.deepEqual(again.body.elements.map((e) => e.run), inferred.body.elements.map((e) => e.run));
});

test("a seeded placeholder loses its flag once real content is written", async () => {
  const el = (await postJson(elementsPath(), { world: WORLD, name: "Seeded", run: { column: "main", role: "read", placeholder: true } })).body.element;
  assert.equal(el.run.placeholder, true);
  const filled = await postJson(`${elementsPath()}/${el.id}`, { world: WORLD, fields: { looks: "Now there is text." } });
  assert.deepEqual(filled.body.element.run, { column: "main", role: "read" });
});

test("scene patch carries kind/whereNote/tags/activeVariants; kind is validated", async () => {
  const ok = await postJson(`/api/session-planner/scenes/${scene.id}`, { world: WORLD, kind: "combat", whereNote: "The square · by the well", tags: ["live combat"], activeVariants: ["Present"] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.scene.kind, "combat");
  assert.equal(ok.body.scene.whereNote, "The square · by the well");
  assert.deepEqual(ok.body.scene.tags, ["live combat"]);
  assert.deepEqual(ok.body.scene.activeVariants, ["Present"]);

  const bad = await postJson(`/api/session-planner/scenes/${scene.id}`, { world: WORLD, kind: "musical" });
  assert.equal(bad.status, 400);
  const fresh = await getJson(`/api/session-planner/scenes/${scene.id}?world=${WORLD}`);
  assert.equal(fresh.body.scene.kind, "combat", "a rejected patch leaves the record untouched");
});

test("run-version changes when an element, the scene record, or the narration changes — and not otherwise", async () => {
  const v0 = (await getJson(`/api/scene-planning/scenes/${scene.id}/run-version?world=${WORLD}`)).body.version;
  const v0b = (await getJson(`/api/scene-planning/scenes/${scene.id}/run-version?world=${WORLD}`)).body.version;
  assert.equal(v0, v0b, "stable across reads with no writes");
  await postJson(elementsPath(), { world: WORLD, name: "Another" });
  const v1 = (await getJson(`/api/scene-planning/scenes/${scene.id}/run-version?world=${WORLD}`)).body.version;
  assert.notEqual(v1, v0);
  await postJson(`/api/session-planner/scenes/${scene.id}`, { world: WORLD, activeVariants: ["Night"] });
  const v2 = (await getJson(`/api/scene-planning/scenes/${scene.id}/run-version?world=${WORLD}`)).body.version;
  assert.notEqual(v2, v1);
  await postJson(`/api/scene-planning/scenes/${scene.id}/narration`, { world: WORLD, text: "Read this." });
  const v3 = (await getJson(`/api/scene-planning/scenes/${scene.id}/run-version?world=${WORLD}`)).body.version;
  assert.notEqual(v3, v2);
});

test("elements list attaches a read-only bestiary summary for a linked entry, and nothing for a dangling id", async () => {
  const entry = saveBestiaryEntry({ rawFields: { name: "Test Thug", ac: 11, hp: 32, challengeRating: "1/2" } });
  await postJson(elementsPath(), { world: WORLD, name: "Thugs", fields: { bestiaryEntryId: entry.id }, run: { column: "side", role: "block" } });
  await postJson(elementsPath(), { world: WORLD, name: "Ghost", fields: { bestiaryEntryId: "bst_nope" } });
  const list = (await getJson(`${elementsPath()}?world=${WORLD}`)).body.elements;
  const thugs = list.find((e) => e.name === "Thugs");
  assert.equal(thugs.bestiary.ac, 11);
  assert.equal(thugs.bestiary.hp, 32);
  assert.equal(thugs.bestiary.cr, "1/2");
  assert.equal(list.find((e) => e.name === "Ghost").bestiary, undefined);
});

test("stagecraft image route streams the asset's file from under WF_DATA_DIR and refuses to escape it", async () => {
  mkdirSync(join(dataDir, "maps"), { recursive: true });
  writeFileSync(join(dataDir, "maps", "square.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const asset = saveStagecraftAsset(WORLD, { kind: "map", name: "Square", src: "maps/square.png" });
  const ok = await fetch(`${base}/api/session-planner/stagecraft/${asset.id}/image?world=${WORLD}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
  assert.equal((await ok.arrayBuffer()).byteLength, 4);

  const evil = saveStagecraftAsset(WORLD, { kind: "map", name: "Evil", src: "../../etc/passwd" });
  const bad = await fetch(`${base}/api/session-planner/stagecraft/${evil.id}/image?world=${WORLD}`);
  assert.equal(bad.status, 400);

  const none = saveStagecraftAsset(WORLD, { kind: "map", name: "Missing", src: "maps/missing.png" });
  const nf = await fetch(`${base}/api/session-planner/stagecraft/${none.id}/image?world=${WORLD}`);
  assert.equal(nf.status, 404);
});

test("the shared run-layout module is served to the browser as JavaScript", async () => {
  const res = await fetch(`${base}/shared/run-layout.mjs`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /javascript/);
  assert.match(await res.text(), /export function inferRunLayout/);
});

test("run-layout/seed creates placeholder elements per role for the scene's kind, skips roles already present, and is idempotent", async () => {
  const s3 = createScene(WORLD, { name: "Combat — Bridge fight" });
  const p = `/api/scene-planning/scenes/${s3.id}`;
  // Pre-existing read-aloud (untagged -> inferred role 'read') must NOT be duplicated.
  await postJson(`${p}/elements`, { world: WORLD, name: "Read Aloud — Opening", fields: { looks: "Fog." } });
  const first = await postJson(`${p}/run-layout/seed`, { world: WORLD });
  assert.equal(first.status, 200);
  assert.equal(first.body.kind, "combat", "kind from the name prefix");
  assert.ok(first.body.skipped.includes("read"));
  const roles = first.body.seeded.map((e) => e.run.role);
  assert.deepEqual([...new Set(roles)], ["dressing", "block", "sketch", "beat", "gm", "exits"]);
  assert.ok(first.body.seeded.every((e) => e.run.placeholder === true));
  const exits = first.body.seeded.find((e) => e.run.role === "exits");
  assert.match(exits.fields.gives, /^ONWARD \(plot\)/);
  const again = await postJson(`${p}/run-layout/seed`, { world: WORLD });
  assert.equal(again.body.seeded.length, 0, "idempotent by role");
  assert.equal(again.body.elements.length, first.body.elements.length);
  const explicitKind = await postJson(`${p}/run-layout/seed`, { world: WORLD, kind: "musical" });
  assert.equal(explicitKind.status, 200, "an unknown override falls back rather than erroring");
});
