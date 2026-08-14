import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST — Friction Wave 1 W4a's route:
 * GET /api/combat-planning/plutonium?query&crMin&crMax&type&source&offset&limit
 * -> { installed, files, count, matched, offset, limit, creatures, facets }
 *
 * Thin wrapper over combat-planning/plutonium-source.mjs, dataDir resolved
 * via resolveDir() (WF_DATA_DIR) ONLY — a client-supplied dataDir is
 * ignored (the security convention every route in server.mjs follows).
 * READ-ONLY: never touches the curated bestiary store. Fixture module dir
 * only, never the real Plutonium install.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-w4a-plutonium-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_BESTIARY_DIR = join(scratchDir, "bestiary");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "w4a-plutonium-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const bestiaryDir = join(dataDir, "modules", "plutonium", "data", "bestiary");
mkdirSync(bestiaryDir, { recursive: true });
writeFileSync(join(bestiaryDir, "bestiary-mm.json"), JSON.stringify({
  monster: [
    { name: "Guard", source: "MM", page: 347, cr: "1/8", type: { type: "humanoid", tags: ["any race"] }, size: ["M"], ac: [{ ac: 16 }], hp: { average: 11 }, environment: ["urban"] },
    { name: "Veteran", source: "MM", page: 350, cr: "3", type: { type: "humanoid" }, size: ["M"], ac: [17], hp: { average: 58 } },
    { name: "Arcanaloth", source: "MM", page: 313, cr: "12", type: { type: "fiend", tags: ["yugoloth"] }, size: ["M"], ac: [17], hp: { average: 104 } }
  ]
}), "utf8");
writeFileSync(join(bestiaryDir, "bestiary-tob.json"), JSON.stringify({
  monster: [
    { name: "Cave Goblin", source: "ToB", page: 12, cr: "1/4", type: { type: "humanoid", tags: ["goblinoid"] }, size: ["S"], ac: [13], hp: { average: 7 } }
  ]
}), "utf8");

const { createReviewServer } = await import("../server.mjs");
const { listBestiaryEntries } = await import("../../combat-planning/bestiary-store.mjs");
const { clearPlutoniumIndexCache } = await import("../../combat-planning/plutonium-source.mjs");

let server, base;

before(async () => {
  clearPlutoniumIndexCache();
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

test("GET /api/combat-planning/plutonium: full index summary + first page + facets", async () => {
  const { status, body } = await getJson("/api/combat-planning/plutonium");
  assert.equal(status, 200);
  assert.equal(body.installed, true);
  assert.equal(body.files, 2);
  assert.equal(body.count, 4);
  assert.equal(body.matched, 4);
  assert.equal(body.creatures.length, 4);
  const guard = body.creatures.find((c) => c.name === "Guard");
  assert.deepEqual(
    { source: guard.source, page: guard.page, cr: guard.cr, type: guard.type, ac: guard.ac, hp: guard.hp },
    { source: "MM", page: 347, cr: "1/8", type: "humanoid", ac: 16, hp: 11 }
  );
  assert.ok(body.facets.sources.some((s) => s.id === "MM" && s.count === 3));
  assert.ok(body.facets.types.some((t) => t.id === "humanoid" && t.count === 3));
});

test("GET .../plutonium: query + CR range + source filters and pagination all work server-side", async () => {
  const byQuery = await getJson("/api/combat-planning/plutonium?query=arcan");
  assert.deepEqual(byQuery.body.creatures.map((c) => c.name), ["Arcanaloth"]);

  const byCr = await getJson("/api/combat-planning/plutonium?crMin=0.25&crMax=3");
  assert.deepEqual(byCr.body.creatures.map((c) => c.name).sort(), ["Cave Goblin", "Veteran"]);

  const bySource = await getJson("/api/combat-planning/plutonium?source=ToB");
  assert.deepEqual(bySource.body.creatures.map((c) => c.name), ["Cave Goblin"]);

  const page = await getJson("/api/combat-planning/plutonium?limit=2&offset=2");
  assert.equal(page.body.matched, 4, "matched stays the filtered total");
  assert.equal(page.body.creatures.length, 2, "the window is the page");
});

test("READ-ONLY: browsing the Plutonium shelf never lands anything on the curated bestiary shelf", async () => {
  await getJson("/api/combat-planning/plutonium");
  await getJson("/api/combat-planning/plutonium?query=guard");
  assert.deepEqual(listBestiaryEntries(), [], "the source LAYER must never leak rows into the curated store");
});

test("graceful not-installed state: WF_DATA_DIR without a plutonium module -> 200 {installed:false}, never an error", async () => {
  // A second server over a different, plutonium-less dataDir.
  const bareDataDir = join(scratchDir, "bare-foundrydata");
  mkdirSync(bareDataDir, { recursive: true });
  const prev = process.env.WF_DATA_DIR;
  process.env.WF_DATA_DIR = bareDataDir;
  try {
    const bareServer = createReviewServer({ port: 0 });
    await new Promise((resolve) => bareServer.once("listening", resolve));
    const bareBase = `http://localhost:${bareServer.address().port}`;
    const res = await fetch(`${bareBase}/api/combat-planning/plutonium`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.installed, false);
    assert.deepEqual(body.creatures, []);
    assert.equal(body.count, 0);
    await new Promise((resolve) => bareServer.close(resolve));
  } finally {
    process.env.WF_DATA_DIR = prev;
  }
});
