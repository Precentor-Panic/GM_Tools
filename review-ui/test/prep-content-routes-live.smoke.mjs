#!/usr/bin/env node
/**
 * Phase 11 task 11.3's real-API smoke test: "real-API smoke test covering
 * the full flow (frame -> pick -> generate -> accept -> later regenerate
 * one field -> confirm the rest of the fields are untouched)", exercised at
 * the HTTP route layer (real fetch() requests against a real running
 * review-ui/server.mjs instance), matching this project's established
 * *.test.mjs (mocked/no-LLM) vs. *.smoke.mjs (real API) split -- the
 * underlying MCP tools (wf-mcp-server/index.mjs's wf_propose_prep_framings/
 * wf_generate_prep_content/etc.) are thin wrappers calling the exact same
 * wf-mcp-server/lib/prep-content-ops.mjs functions this route layer calls,
 * so this one real round trip covers both front-ends' actual logic.
 *
 * NOT run as part of `node --test` — it makes real, billed Anthropic API
 * calls. Run it manually once ANTHROPIC_API_KEY is set:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node review-ui/test/prep-content-routes-live.smoke.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratchDir = mkdtempSync(join(tmpdir(), "gm-tools-prep-routes-live-smoke-"));
const dataDir = join(scratchDir, "foundrydata");
process.env.GM_TOOLS_REVIEW_STATE_DIR = join(scratchDir, "review-state");
process.env.GM_TOOLS_PREP_CONTENT_DIR = join(scratchDir, "prep-content");
process.env.WF_DATA_DIR = dataDir;

const WORLD = "prep-routes-live-smoke-world";
process.env.WF_DEFAULT_WORLD = WORLD;

const { snapshotFilePath } = await import("../../wf-mcp-server/lib/snapshot.mjs");
const { bootstrapSnapshot, applyHeadless } = await import("../../graph-import/headless-apply.mjs");
const { createReviewServer } = await import("../server.mjs");

async function postJson(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  const json = await res.json();
  return { status: res.status, body: json };
}
async function getJson(base, path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. This smoke test makes real Anthropic API calls and cannot run without credentials.");
    process.exitCode = 1;
    return;
  }

  const snapPath = snapshotFilePath(dataDir, WORLD);
  bootstrapSnapshot(snapPath, { worldId: WORLD });
  applyHeadless(snapPath, [
    { op: "upsert_entity", data: { id: "mira", name: "Mira", type: "person", importance: 0.6, description: "A retired mercenary running the town's only inn." } },
    { op: "upsert_entity", data: { id: "the-crossing", name: "The Crossing", type: "place", importance: 0.5, description: "A river-ford town, once a battlefield." } },
    { op: "upsert_edge", data: { id: "e1", sourceId: "mira", targetId: "the-crossing", relationshipType: "presence", strength: 0.7 } }
  ]);

  const server = createReviewServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://localhost:${server.address().port}`;

  try {
    console.log("=== 1. propose-framings (round 1) ===");
    const framingResp = await postJson(base, "/api/entities/mira/prep/propose-framings", { world: WORLD, dataDir });
    console.log(JSON.stringify(framingResp.body, null, 2));
    if (framingResp.status !== 200 || framingResp.body.framings.length !== 3) throw new Error("propose-framings did not return 3 framings");

    console.log("\n=== 2. pick a framing, generate ===");
    const selection = { primary: framingResp.body.framings[0] };
    const genResp = await postJson(base, "/api/entities/mira/prep/generate", { world: WORLD, dataDir, selection });
    console.log(JSON.stringify(genResp.body, null, 2));
    if (genResp.status !== 200 || genResp.body.status !== "proposed") throw new Error("generate did not produce a 'proposed' draft");
    const personFieldKeys = Object.keys(genResp.body.fields).sort();

    console.log("\n=== 3. accept ===");
    const acceptResp = await postJson(base, "/api/entities/mira/prep/accept", { world: WORLD });
    console.log(JSON.stringify(acceptResp.body, null, 2));
    if (acceptResp.status !== 200 || acceptResp.body.status !== "accepted") throw new Error("accept did not flip status");

    console.log("\n=== 4. regenerate ONE field (hook), confirm the rest untouched ===");
    const beforeFields = acceptResp.body.fields;
    const regenResp = await postJson(base, "/api/entities/mira/prep/regenerate-field", { world: WORLD, dataDir, fieldName: "hook", note: "make it more urgent" });
    console.log(JSON.stringify(regenResp.body, null, 2));
    if (regenResp.status !== 200) throw new Error("regenerate-field failed");
    let othersUntouched = true;
    for (const key of personFieldKeys) {
      if (key === "hook") continue;
      if (JSON.stringify(regenResp.body.fields[key]) !== JSON.stringify(beforeFields[key])) othersUntouched = false;
    }
    const hookChanged = JSON.stringify(regenResp.body.fields.hook) !== JSON.stringify(beforeFields.hook);
    console.log(`hook field changed: ${hookChanged}`);
    console.log(`every other field byte-identical: ${othersUntouched}`);

    console.log("\n=== 5. GET confirms persistence ===");
    const getResp = await getJson(base, `/api/entities/mira/prep?world=${WORLD}`);
    const persistedOk = getResp.body.prepContent?.status === "accepted" && JSON.stringify(getResp.body.prepContent.fields.hook) === JSON.stringify(regenResp.body.fields.hook);
    console.log(`persisted correctly and readable via GET: ${persistedOk}`);

    console.log("\n=== 6. develop a PLACE too, confirm genuinely different field shape ===");
    const placeFraming = await postJson(base, "/api/entities/the-crossing/prep/propose-framings", { world: WORLD, dataDir });
    const placeGen = await postJson(base, "/api/entities/the-crossing/prep/generate", {
      world: WORLD, dataDir, selection: { primary: placeFraming.body.framings[0] }
    });
    const placeFieldKeys = Object.keys(placeGen.body.fields).sort();
    const shapesDiffer = JSON.stringify(personFieldKeys) !== JSON.stringify(placeFieldKeys);
    console.log(`person field keys: ${personFieldKeys.join(", ")}`);
    console.log(`place field keys: ${placeFieldKeys.join(", ")}`);
    console.log(`shapes genuinely differ: ${shapesDiffer}`);

    const allOk = hookChanged && othersUntouched && persistedOk && shapesDiffer;
    if (allOk) {
      console.log("\nSMOKE TEST PASSED: full frame -> pick -> generate -> accept -> regenerate-one-field flow works end to end over real HTTP against the live Anthropic API.");
    } else {
      console.error("\nSMOKE TEST FAILED -- see above.");
      process.exitCode = 1;
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

await main().finally(() => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});
