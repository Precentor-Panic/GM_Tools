import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CONTRACT UNDER TEST — rules-oracle/rules-answer.mjs (B4/G13): the one
 * LLM call of the rules oracle. Mocked client, prompt-content assertions:
 * excerpts + citations reach the prompt; the answer-only-from-excerpts
 * instruction is present; zero retrieved sources => NO model call at all;
 * the stopword-stripped term derivation + two-longest-terms retry.
 * Synthetic fixtures only (the IP rule extends to fixtures).
 */

let passed = 0;
async function test(name, fn) {
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

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-rules-answer-test-"));
const dataDir = join(scratchDir, "foundrydata");
// Synthetic structured family (grappling rule) + a synthetic marked book.
const plutoniumData = join(dataDir, "modules", "plutonium", "data");
mkdirSync(plutoniumData, { recursive: true });
writeFileSync(join(plutoniumData, "variantrules.json"), JSON.stringify({
  variantrule: [
    { name: "Grappling Contest", source: "TSTB", page: 42, entries: ["To grapple, make a contested Athletics check against the target."] }
  ]
}));
const shelf = join(scratchDir, "rules-library");
mkdirSync(join(shelf, "5e"), { recursive: true });
writeFileSync(join(shelf, "5e", "tst.txt"), [
  "[[tst p.7]]",
  "A creature can drag a grappled target at half speed during a grappling move.",
  "[[tst p.8]]",
  "Unrelated page about lighting."
].join("\n"));
process.env.GM_TOOLS_RULES_DIR = shelf;

const { answerRulesQuestion, extractSearchTerms } = await import("../rules-oracle/rules-answer.mjs");

function mockClient(reply) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params.messages[0].content);
        return { content: [{ type: "text", text: reply }], stop_reason: "end_turn" };
      }
    }
  };
}

await test("extractSearchTerms strips stopwords/punctuation and keeps content terms", () => {
  assert.deepEqual(
    extractSearchTerms("Can my character drag someone while grappling them?"),
    ["drag", "grappl"],
    "stopwords stripped, light stem bridges grappling/grappled/grapple"
  );
});

await test("the prompt carries the question, both excerpt kinds WITH citations, and the grounding discipline", async () => {
  const client = mockClient("Yes — half speed while dragging (TSTB p.42).");
  // "grappling" alone matches BOTH the structured rule (by name) and the
  // book page (by text) — the one-term question keeps all-terms honest.
  const res = await answerRulesQuestion(dataDir, "How does grappling work?", { client });
  assert.equal(res.answer, "Yes — half speed while dragging (TSTB p.42).");
  const prompt = client.calls[0];
  assert.match(prompt, /How does grappling work\?/);
  assert.match(prompt, /\(TSTB p\.42\) Grappling Contest/, "structured excerpt cited");
  assert.match(prompt, /\(TST p\.7\)/, "book excerpt cited with its PDF page");
  assert.match(prompt, /drag a grappled target at half speed/, "book snippet text present");
  assert.match(prompt, /Answer ONLY from the excerpts/i);
  assert.match(prompt, /not found in the library/);
});

await test("zero retrieved sources => noSources result and the model is NEVER called", async () => {
  const client = mockClient("should never be reached");
  const res = await answerRulesQuestion(dataDir, "What is the airspeed of an unladen swallow?", { client });
  assert.equal(res.answer, null);
  assert.equal(res.noSources, true);
  assert.equal(client.calls.length, 0, "no sources, no spend");
});

await test("a wordy question that all-terms can't match retries on the two longest content terms", async () => {
  const client = mockClient("Half speed (TST p.7).");
  // "grappling" and "dragging" both appear only in separate sources, so the
  // full term set matches nothing; the two longest terms retry finds them.
  const res = await answerRulesQuestion(dataDir, "When somebody is grappling somebody and also dragging, movement penalty applies right?", { client });
  assert.ok(res.answer, "the OR-fallback found sources");
  assert.ok(res.terms.length >= 2 && res.terms.length <= 4, "fell back to the top longest terms");
});

await test("empty question is refused before any work", async () => {
  await assert.rejects(() => answerRulesQuestion(dataDir, "  ", {}), /non-empty question/);
});

console.log(`\n${passed} passed`);
rmSync(scratchDir, { recursive: true, force: true });
