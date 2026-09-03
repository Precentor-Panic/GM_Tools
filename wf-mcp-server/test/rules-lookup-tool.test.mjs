import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * CONTRACT UNDER TEST -- the G10 MCP tool `wf_rules_lookup` (workstream B4,
 * rules-oracle/). Real MCP subprocess over stdio, same harness as
 * narrative-state-tools.test.mjs: a scratch WF_DATA_DIR carrying a fake
 * Plutonium install (the structured arm) and a scratch GM_TOOLS_RULES_DIR
 * carrying a fake book shelf (the books arm) -- both SYNTHETIC, invented
 * for this test (the IP rule extends to fixtures: never real book text).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.mjs");

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-rules-lookup-tool-test-"));
const dataDir = join(scratchDir, "foundrydata");
const plutoniumDataDir = join(dataDir, "modules", "plutonium", "data");
mkdirSync(plutoniumDataDir, { recursive: true });
writeFileSync(
  join(plutoniumDataDir, "variantrules.json"),
  JSON.stringify({
    variantrule: [
      { name: "Ability Check", source: "XPHB", page: 360, ruleType: "C", entries: ["Uses a {@variantrule D20 Test|XPHB}."] }
    ]
  })
);
writeFileSync(
  join(plutoniumDataDir, "actions.json"),
  JSON.stringify({ action: [{ name: "Grapple", source: "PHB", page: 195, entries: ["A grapple attempt uses the {@action Attack|XPHB} action."] }] })
);
writeFileSync(join(plutoniumDataDir, "conditionsdiseases.json"), JSON.stringify({ condition: [], disease: [], status: [] }));
writeFileSync(join(plutoniumDataDir, "skills.json"), JSON.stringify({ skill: [] }));
writeFileSync(join(plutoniumDataDir, "senses.json"), JSON.stringify({ sense: [] }));
writeFileSync(join(plutoniumDataDir, "tables.json"), JSON.stringify({ table: [] }));

const rulesLibraryDir = join(scratchDir, "rules-library");
const shelf5e = join(rulesLibraryDir, "5e");
mkdirSync(shelf5e, { recursive: true });
writeFileSync(
  join(shelf5e, "testbook.txt"),
  ["[[testbook p.1]]", "Front matter.", "[[testbook p.2]]", "To Grapple a creature, use the Attack action; the target's speed becomes 0."].join("\n")
);

const env = {
  ...process.env,
  WF_DATA_DIR: dataDir,
  GM_TOOLS_RULES_DIR: rulesLibraryDir
};
delete env.ANTHROPIC_API_KEY;
delete env.WF_DEFAULT_WORLD;

const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_PATH], env, stderr: "pipe" });
const client = new Client({ name: "rules-lookup-tool-test-client", version: "0.0.0" });
await client.connect(transport);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const textBlock = res.content?.find((b) => b.type === "text");
  if (res.isError) throw new Error(textBlock?.text ?? "unknown MCP tool error");
  return textBlock ? JSON.parse(textBlock.text) : null;
}
async function callExpectError(name, args) {
  const res = await client.callTool({ name, arguments: args });
  assert.equal(res.isError, true, `expected ${name} to error`);
  return res.content?.find((b) => b.type === "text")?.text ?? "";
}

await test("wf_rules_lookup: no world param needed, composes structured + books hits for a shared query", async () => {
  const res = await call("wf_rules_lookup", { query: "grapple attack" });
  assert.equal(res.structured.installed, true);
  assert.equal(res.books.installed, true);
  assert.ok(res.structured.matches.some((m) => m.name === "Grapple"));
  assert.ok(res.books.matches.some((m) => m.book === "testbook" && m.page === 2));
});

await test("wf_rules_lookup: family narrows the structured arm only", async () => {
  const res = await call("wf_rules_lookup", { query: "ability check", family: "variantrules" });
  assert.ok(res.structured.matches.every((m) => m.family === "variantrules"));
  assert.ok(res.structured.matches.some((m) => m.name === "Ability Check"));

  const noHits = await call("wf_rules_lookup", { query: "ability check", family: "skills" });
  assert.deepEqual(noHits.structured.matches, []);
});

await test("wf_rules_lookup: book narrows the books arm only", async () => {
  const res = await call("wf_rules_lookup", { query: "grapple", book: "testbook" });
  assert.ok(res.books.matches.every((m) => m.book === "testbook"));
  assert.ok(res.books.matches.length >= 1);
});

await test("wf_rules_lookup: an invalid family enum value is a clean schema error, not a crash", async () => {
  const errText = await callExpectError("wf_rules_lookup", { query: "grapple", family: "not-a-real-family" });
  assert.match(errText, /family|invalid|enum/i);
});

await test("wf_rules_lookup: an empty query is a clean schema error", async () => {
  const errText = await callExpectError("wf_rules_lookup", { query: "" });
  assert.ok(errText.length > 0);
});

after(async () => {
  await client.close();
  rmSync(scratchDir, { recursive: true, force: true });
});
