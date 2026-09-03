import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST -- G10's GET /api/rules?query=&family=&book=&limit=
 * (workstream B4, rules-oracle/). Thin route composing BOTH backends:
 * the structured (Plutonium) arm via WF_DATA_DIR, the books arm via
 * GM_TOOLS_RULES_DIR -- both scratch/synthetic fixtures here, never the
 * real Plutonium install or the real (gitignored) rules-library/.
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-rules-lookup-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "rules-lookup-routes-test-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const plutoniumDataDir = join(dataDir, "modules", "plutonium", "data");
mkdirSync(plutoniumDataDir, { recursive: true });
writeFileSync(
  join(plutoniumDataDir, "variantrules.json"),
  JSON.stringify({ variantrule: [{ name: "Ability Check", source: "XPHB", page: 360, ruleType: "C", entries: ["Uses a {@variantrule D20 Test|XPHB}."] }] }),
  "utf8"
);
writeFileSync(
  join(plutoniumDataDir, "actions.json"),
  JSON.stringify({ action: [{ name: "Grapple", source: "PHB", page: 195, entries: ["A grapple attempt uses the {@action Attack|XPHB} action."] }] }),
  "utf8"
);
writeFileSync(join(plutoniumDataDir, "conditionsdiseases.json"), JSON.stringify({ condition: [], disease: [], status: [] }), "utf8");
writeFileSync(join(plutoniumDataDir, "skills.json"), JSON.stringify({ skill: [] }), "utf8");
writeFileSync(join(plutoniumDataDir, "senses.json"), JSON.stringify({ sense: [] }), "utf8");
writeFileSync(join(plutoniumDataDir, "tables.json"), JSON.stringify({ table: [] }), "utf8");

const rulesLibraryDir = join(scratchDir, "rules-library");
const shelf5e = join(rulesLibraryDir, "5e");
mkdirSync(shelf5e, { recursive: true });
writeFileSync(
  join(shelf5e, "testbook.txt"),
  ["[[testbook p.1]]", "Front matter.", "[[testbook p.2]]", "To Grapple a creature, use the Attack action; the target's speed becomes 0."].join("\n"),
  "utf8"
);
process.env.GM_TOOLS_RULES_DIR = rulesLibraryDir;

const { createReviewServer } = await import("../server.mjs");
const { clearRulesIndexCache } = await import("../../rules-oracle/rules-index.mjs");
const { clearBookPageCache } = await import("../../rules-oracle/rules-library-search.mjs");

let server, base;

before(async () => {
  clearRulesIndexCache();
  clearBookPageCache();
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

test("GET /api/rules: composes both backends for a shared query", async () => {
  const { status, body } = await getJson("/api/rules?query=grapple+attack");
  assert.equal(status, 200);
  assert.equal(body.structured.installed, true);
  assert.equal(body.books.installed, true);
  assert.ok(body.structured.matches.some((m) => m.name === "Grapple"));
  assert.ok(body.books.matches.some((m) => m.book === "testbook" && m.page === 2));
});

test("GET /api/rules: family narrows the structured arm only", async () => {
  const { body } = await getJson("/api/rules?query=ability+check&family=variantrules");
  assert.ok(body.structured.matches.every((m) => m.family === "variantrules"));
  assert.ok(body.structured.matches.some((m) => m.name === "Ability Check"));
});

test("GET /api/rules: book narrows the books arm only", async () => {
  const { body } = await getJson("/api/rules?query=grapple&book=testbook");
  assert.ok(body.books.matches.every((m) => m.book === "testbook"));
  assert.ok(body.books.matches.length >= 1);
});

test("GET /api/rules: missing query is a 400", async () => {
  const { status, body } = await getJson("/api/rules");
  assert.equal(status, 400);
  assert.match(body.error, /query/i);
});

test("GET /api/rules: empty query is a 400", async () => {
  const { status } = await getJson("/api/rules?query=");
  assert.equal(status, 400);
});
