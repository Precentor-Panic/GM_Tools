#!/usr/bin/env node
/**
 * Cross-process test fixture for Phase 2 task 2.2's resumability acceptance
 * criterion: "start a run, let it write partial progress to disk, kill the
 * *test process itself* ... then resume in a fresh process invocation."
 *
 * Run as a child process by test/resumability-crossprocess.test.mjs (never
 * directly by `npm test`/`node --test`, hence the .mjs-in-fixtures/ location
 * rather than a *.test.mjs name). Reads its configuration from env vars so
 * the same script works unmodified for both the "kill mid-run" invocation
 * and the "resume" invocation -- resumability is automatic (keyed on
 * batchId), no special --resume flag needed.
 *
 * Env vars:
 *   GM_TOOLS_REVIEW_STATE_DIR, GM_TOOLS_TIMESKIP_STATUS_DIR  -- same scratch dirs both invocations share
 *   WORKER_WORLD, WORKER_BATCH_ID
 *   WORKER_CALL_LOG_PATH   -- appended one line per texture API call (this process's only way to signal
 *                             progress to the parent test, since the parent can't see in-memory state)
 *   WORKER_DELAY_MS        -- normal per-call delay (small)
 *   WORKER_SLOW_CALL_INDEX -- this process's Nth create() call (1-based) sleeps WORKER_SLOW_DELAY_MS
 *                             BEFORE logging or responding, all other calls use WORKER_DELAY_MS. This
 *                             creates a wide, deterministic window between "call 1 fully checkpointed"
 *                             and "call 2 becomes observable" for the parent to land a kill in, without
 *                             racing against fast synchronous work between iterations of orchestrateBatch's
 *                             region loop.
 *   WORKER_SLOW_DELAY_MS
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { orchestrateBatch } from "../../time-skip/run.mjs";

const world = process.env.WORKER_WORLD;
const batchId = process.env.WORKER_BATCH_ID;
const callLogPath = process.env.WORKER_CALL_LOG_PATH;
const delayMs = Number(process.env.WORKER_DELAY_MS ?? 20);
const slowCallIndex = Number(process.env.WORKER_SLOW_CALL_INDEX ?? 2);
const slowDelayMs = Number(process.env.WORKER_SLOW_DELAY_MS ?? 400);

if (!world || !batchId || !callLogPath) {
  console.error("timeskip-worker.mjs requires WORKER_WORLD, WORKER_BATCH_ID, WORKER_CALL_LOG_PATH env vars.");
  process.exit(2);
}

// Four disjoint pairs -> four disconnected regions, giving the parent room
// to kill after 1-2 completed calls while several remain for the resume.
const entities = [
  { id: "a1", name: "A1", type: "person", importance: 0.6 },
  { id: "a2", name: "A2", type: "person", importance: 0.6 },
  { id: "b1", name: "B1", type: "person", importance: 0.6 },
  { id: "b2", name: "B2", type: "person", importance: 0.6 },
  { id: "c1", name: "C1", type: "person", importance: 0.6 },
  { id: "c2", name: "C2", type: "person", importance: 0.6 },
  { id: "d1", name: "D1", type: "person", importance: 0.6 },
  { id: "d2", name: "D2", type: "person", importance: 0.6 }
];
const edges = [
  { id: "eA", sourceId: "a1", targetId: "a2", relationshipType: "social", strength: 0.9 },
  { id: "eB", sourceId: "b1", targetId: "b2", relationshipType: "social", strength: 0.9 },
  { id: "eC", sourceId: "c1", targetId: "c2", relationshipType: "social", strength: 0.9 },
  { id: "eD", sourceId: "d1", targetId: "d2", relationshipType: "social", strength: 0.9 }
];

function mockClient() {
  let callIndex = 0;
  return {
    messages: {
      create: async (params) => {
        callIndex++;
        // The designated "slow" call sleeps BEFORE doing anything observable
        // (no log line yet), so the parent process sees a clean, wide gap
        // between "previous call's region fully checkpointed" and "this
        // call becomes visible" -- see the module doc comment above.
        const thisDelay = callIndex === slowCallIndex ? slowDelayMs : delayMs;
        await new Promise((resolve) => setTimeout(resolve, thisDelay));
        appendFileSync(callLogPath, "call\n", "utf8");
        const prompt = params.messages[0].content;
        const edgeId = ["eA", "eB", "eC", "eD"].find((id) => prompt.includes(`[edgeId=${id}]`)) ?? "eA";
        return {
          content: [{
            type: "text",
            text: JSON.stringify([{ op: "upsert_edge", id: edgeId, data: { strength: 0.1 }, rationale: "Time passed." }])
          }]
        };
      }
    }
  };
}

try {
  const result = await orchestrateBatch(world, { mode: "ambient", elapsedSessions: 10 }, "a while", {
    entities,
    edges,
    batchId,
    textureOpts: { client: mockClient() }
  });
  writeFileSync(`${callLogPath}.result.json`, JSON.stringify(result), "utf8");
  process.exit(0);
} catch (err) {
  writeFileSync(`${callLogPath}.error.txt`, err.stack || String(err), "utf8");
  process.exit(1);
}
