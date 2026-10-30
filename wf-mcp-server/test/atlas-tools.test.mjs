import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test, after } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * CONTRACT UNDER TEST -- the wf_atlas_* MCP tools, through a real MCP subprocess over stdio against a scratch atlas
 * store (GM_TOOLS_ATLAS_DIR). Pins: Claude's additions are drafts; the edit tool refuses to accept drafts; undo;
 * marks for ids the atlas doesn't have are refused.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "index.mjs");
const scratch = mkdtempSync(join(tmpdir(), "gm-tools-atlas-tools-"));
const env = { ...process.env, GM_TOOLS_ATLAS_DIR: join(scratch, "atlases"), WF_DATA_DIR: join(scratch, "foundrydata") };
delete env.ANTHROPIC_API_KEY;
delete env.WF_DEFAULT_WORLD;
process.env.GM_TOOLS_ATLAS_DIR = env.GM_TOOLS_ATLAS_DIR;

const { createAtlas } = await import("../../atlas/store.mjs");
const { millAtlas } = await import("../../test/fixtures/atlas-dungeon.mjs");
const WORLD = "atlas-tools-world";
createAtlas(WORLD, millAtlas());

const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_PATH], env, stderr: "pipe" });
const client = new Client({ name: "atlas-tools-test", version: "0.0.0" });
await client.connect(transport);
after(async () => { await client.close(); rmSync(scratch, { recursive: true, force: true }); });

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const t = res.content?.find((b) => b.type === "text")?.text;
  if (res.isError) throw new Error(t);
  return JSON.parse(t);
}

test("summary lists atlases, then summarises one", async () => {
  assert.deepEqual((await call("wf_atlas_summary", { world: WORLD })).atlases, ["old-mill"]);
  const s = await call("wf_atlas_summary", { world: WORLD, atlas: "old-mill" });
  assert.equal(s.counts.nodes, 7);
});

test("edit: Claude's additions are drafts; accept is refused; undo puts it back", async () => {
  const r = await call("wf_atlas_edit", { world: WORLD, atlas: "old-mill", ops: [
    { op: "add-node", data: { id: "well", name: "Village well", kind: "shaft", stratum: "S1", x: 100, y: -100, depth: 10 } },
  ] });
  assert.equal(r.revision, 1);
  const nb = await call("wf_atlas_query", { world: WORLD, atlas: "old-mill", kind: "search", text: "Village well" });
  assert.equal(nb[0].draft, true);
  await assert.rejects(call("wf_atlas_edit", { world: WORLD, atlas: "old-mill", ops: [{ op: "accept", ids: ["well"] }] }), /GM's call/);
  await call("wf_atlas_undo", { world: WORLD, atlas: "old-mill" });
  assert.deepEqual(await call("wf_atlas_query", { world: WORLD, atlas: "old-mill", kind: "search", text: "Village well" }), []);
});

test("route, brief and marks", async () => {
  const r = await call("wf_atlas_query", { world: WORLD, atlas: "old-mill", kind: "route", from: "mill", to: "outfall" });
  assert.ok(r.minutes > 0);
  const b = await call("wf_atlas_brief", { world: WORLD, atlas: "old-mill", section: "cellar-map" });
  assert.equal(b.exits.length, 1);
  const m = await call("wf_atlas_mark_known", { world: WORLD, atlas: "old-mill", marks: [{ id: "cellar", level: "walked" }] });
  assert.equal(m.length, 1);
  await assert.rejects(call("wf_atlas_mark_known", { world: WORLD, atlas: "old-mill", marks: [{ id: "nowhere", level: "heard" }] }), /not in the atlas/);
});
