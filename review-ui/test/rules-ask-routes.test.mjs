import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";

/**
 * CONTRACT UNDER TEST -- the rules oracle's ask surfaces (B4/G13):
 *   POST /api/rules/ask          {question} -> {answer, hits, offline, terms} | {noSources:true,...}
 *   POST /api/rules/post-ruling  {question, answer} -> (400 validation only here --
 *     the real chat post launches headless Chromium against a live Foundry
 *     client and is covered by the documented live smoke, same category as
 *     the entity chat push).
 * Keyless end to end: this process never sets ANTHROPIC_API_KEY, so the ask
 * exercises the REAL offline degrade (honest canned note, retrieval intact).
 */
const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-rules-ask-routes-test-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.WF_DATA_DIR = dataDir;
process.env.WF_DEFAULT_WORLD = "rules-ask-test-world";
delete process.env.ANTHROPIC_API_KEY;

// Synthetic backends only (the IP rule extends to fixtures).
const plutoniumData = join(dataDir, "modules", "plutonium", "data");
mkdirSync(plutoniumData, { recursive: true });
writeFileSync(join(plutoniumData, "actions.json"), JSON.stringify({
  action: [{ name: "Shove", source: "TSTB", page: 12, entries: ["Knock a creature prone or push it 5 feet."] }]
}));
const shelf = join(scratchDir, "rules-library");
mkdirSync(join(shelf, "5e"), { recursive: true });
writeFileSync(join(shelf, "5e", "tst.txt"), "[[tst p.3]]\nShoving uses a contested Athletics check.\n");
process.env.GM_TOOLS_RULES_DIR = shelf;

const { createReviewServer } = await import("../server.mjs");

let server, base;
before(async () => {
  server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(scratchDir, { recursive: true, force: true }); });
async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test("ask: keyless degrade — honest canned note as the answer, retrieval hits intact, offline:true", async () => {
  const { status, body } = await postJson("/api/rules/ask", { question: "How does shoving work?" });
  assert.equal(status, 200);
  assert.equal(body.offline, true);
  assert.match(body.answer, /Offline — no ANTHROPIC_API_KEY/);
  assert.ok(body.hits.structured.matches.some((m) => m.name === "Shove"), "structured retrieval unaffected by keylessness");
  assert.ok(body.hits.books.matches.some((m) => m.page === 3), "book retrieval unaffected");
});

test("ask: zero sources => noSources, and even the offline client is never consulted", async () => {
  const { status, body } = await postJson("/api/rules/ask", { question: "What is the airspeed of an unladen swallow?" });
  assert.equal(status, 200);
  assert.equal(body.noSources, true);
  assert.equal(body.answer, null);
});

test("ask: empty question is a 400", async () => {
  const { status } = await postJson("/api/rules/ask", { question: "  " });
  assert.equal(status, 400);
});

test("post-ruling: missing question/answer is a 400 (the chat post itself is live-smoke territory)", async () => {
  assert.equal((await postJson("/api/rules/post-ruling", { question: "q" })).status, 400);
  assert.equal((await postJson("/api/rules/post-ruling", { answer: "a" })).status, 400);
});
