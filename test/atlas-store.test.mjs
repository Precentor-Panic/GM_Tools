import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "atlas-store-"));
process.env.GM_TOOLS_ATLAS_DIR = dir;

const { parseAtlas, referenceProblems, Atlas } = await import("../atlas/schema.mjs");
const store = await import("../atlas/store.mjs");
const { millAtlas } = await import("./fixtures/atlas-dungeon.mjs");

const W = "test-world";

test("the fixture parses, with defaults filled in", () => {
  const a = parseAtlas({ schemaVersion: 1, revision: 0, units: "ft", ...millAtlas() });
  const cellar = a.nodes.find((n) => n.id === "cellar");
  assert.deepEqual(cellar.tells, ["flour dust on the steps"]);
  assert.equal(a.edges.find((e) => e.id === "cellar-shaft").water, "dry");
});

test("reference problems: unknown endpoint, duplicate id, path route without points", () => {
  const raw = Atlas.parse({ schemaVersion: 1, revision: 0, units: "ft", ...millAtlas() });
  raw.edges.push({ ...raw.edges[0], id: "bad", to: "nowhere" });
  raw.nodes.push({ ...raw.nodes[0] });
  raw.edges.push({ ...raw.edges[0], id: "bent", route: "path", path: undefined });
  const p = referenceProblems(raw);
  assert.ok(p.some((x) => x.includes('unknown node "nowhere"')));
  assert.ok(p.some((x) => x.includes('duplicate id "mill"')));
  assert.ok(p.some((x) => x.includes('"bent" has route "path" but no bend points')));
});

test("ids must be lower-case hyphenated words", () => {
  assert.throws(() => parseAtlas({ schemaVersion: 1, revision: 0, units: "ft", ...millAtlas(), id: "Old Mill" }));
});

test("create, load, list; a second create refuses", () => {
  const a = store.createAtlas(W, millAtlas());
  assert.equal(a.revision, 0);
  assert.deepEqual(store.listAtlases(W), ["old-mill"]);
  assert.equal(store.loadAtlas(W, "old-mill").nodes.length, 7);
  assert.throws(() => store.createAtlas(W, millAtlas()), /already exists/);
});

test("written sorted and stable: lists by id, keys alphabetical", () => {
  const text = readFileSync(join(dir, W, "old-mill.json"), "utf8");
  const ids = JSON.parse(text).nodes.map((n) => n.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(store.stableStringify(JSON.parse(text)), text);
});

test("updateAtlas bumps the revision and validates; a bad change leaves the file alone", () => {
  const { atlas } = store.updateAtlas(W, "old-mill", (a) => { a.nodes.find((n) => n.id === "cellar").x = 15; });
  assert.equal(atlas.revision, 1);
  assert.equal(store.loadAtlas(W, "old-mill").nodes.find((n) => n.id === "cellar").x, 15);
  assert.throws(() => store.updateAtlas(W, "old-mill", (a) => { a.edges[0].to = "nowhere"; }), /inconsistent/);
  assert.equal(store.loadAtlas(W, "old-mill").revision, 1);
});

test("replaceAtlas checks ifRevision", () => {
  const cur = store.loadAtlas(W, "old-mill");
  assert.throws(() => store.replaceAtlas(W, "old-mill", cur, { ifRevision: 0 }), (e) => e.code === "revision_mismatch");
  assert.equal(store.replaceAtlas(W, "old-mill", cur, { ifRevision: 1 }).revision, 2);
});

test("known: no file means nothing known; levels only rise unless forced; forgotten removes; log is append-only", () => {
  assert.deepEqual(store.loadKnown(W, "old-mill").known, {});
  store.markKnown(W, "old-mill", [{ id: "cellar", level: "walked" }, { id: "drain-head", level: "heard" }], { at: "t1" });
  const r = store.markKnown(W, "old-mill", [{ id: "cellar", level: "heard" }, { id: "drain-head", level: "seen" }], { at: "t2" });
  assert.deepEqual(r.known.known, { cellar: "walked", "drain-head": "seen" });
  assert.equal(r.applied.length, 1);
  store.markKnown(W, "old-mill", [{ id: "cellar", level: "forgotten" }], { at: "t3" });
  const k = store.loadKnown(W, "old-mill");
  assert.deepEqual(k.known, { "drain-head": "seen" });
  assert.deepEqual(k.log.map((e) => e.at), ["t1", "t1", "t2", "t3"]);
});

test("the store never writes outside its override folder", () => {
  assert.ok(existsSync(join(dir, W, "old-mill.known.json")));
  assert.equal(store.atlasDir(W), join(dir, W));
});
