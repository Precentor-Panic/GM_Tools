/**
 * CONTRACT UNDER TEST — wf-mcp-server/lib/foundry-push-orchestrator.mjs.
 *
 * Each test here corresponds to one of the five real failures the session-three
 * push hit by hand; they are regression guards, not coverage padding.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  withPushLock, clientLooksLive, awaitQueueDrain, awaitOpResult, pushOne, verifyWorld, OP_TIMEOUT_MS
} = await import("../wf-mcp-server/lib/foundry-push-orchestrator.mjs");

const WORLD = "orch-test-world";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "gm-tools-orch-"));
  mkdirSync(join(dir, "worlds", WORLD), { recursive: true });
  return dir;
}
const opsPath = (d) => join(d, "worlds", WORLD, "world-fabric-foundry-ops.json");
const resPath = (d) => join(d, "worlds", WORLD, "world-fabric-foundry-results.json");
const idxPath = (d) => join(d, "worlds", WORLD, "world-fabric-foundry-index.json");
const write = (p, v) => writeFileSync(p, JSON.stringify(v), "utf8");

// --- (1) concurrency: the duplicate-scene cause ----------------------------

test("the push lock refuses a second concurrent run", async () => {
  const dir = scratch();
  try {
    let inner = null;
    await withPushLock(dir, WORLD, async () => {
      inner = await withPushLock(dir, WORLD, async () => "should not run").then(
        () => "no error", (e) => e.message);
    });
    assert.match(inner, /Another push is already running/, "a second pusher must be refused");
    assert.match(inner, /duplicate scenes/, "and the message must say why it matters");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the lock is released on success and on throw, and a stale lock is reclaimed", async () => {
  const dir = scratch();
  try {
    await withPushLock(dir, WORLD, async () => "fine");
    assert.equal(existsSync(join(dir, "worlds", WORLD, ".gm-tools-push.lock")), false, "released after success");

    await assert.rejects(() => withPushLock(dir, WORLD, async () => { throw new Error("boom"); }), /boom/);
    assert.equal(existsSync(join(dir, "worlds", WORLD, ".gm-tools-push.lock")), false, "released after a throw");

    // A lock left by a dead process must not wedge the next run forever.
    writeFileSync(join(dir, "worlds", WORLD, ".gm-tools-push.lock"),
      JSON.stringify({ pid: 999999999, at: new Date().toISOString() }), "utf8");
    assert.equal(await withPushLock(dir, WORLD, async () => "reclaimed"), "reclaimed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- (4) the client check --------------------------------------------------

test("clientLooksLive distinguishes no index, a stale index and a live one", () => {
  const dir = scratch();
  try {
    assert.equal(clientLooksLive(dir, WORLD).live, false, "no index at all");
    assert.match(clientLooksLive(dir, WORLD).reason, /has ever been exported/);

    write(idxPath(dir), { exportedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    const stale = clientLooksLive(dir, WORLD);
    assert.equal(stale.live, false);
    assert.match(stale.reason, /may not be connected/, "the reason names the likely cause");
    assert.match(stale.reason, /idle clients also look like this/,
      "and admits the signal is advisory -- an idle-but-connected client goes stale on index age alone");
    assert.equal(stale.stale, true);
    assert.equal(Math.round(stale.ageMs / 60000), 60);

    write(idxPath(dir), { exportedAt: new Date().toISOString() });
    assert.equal(clientLooksLive(dir, WORLD).live, true);

    write(idxPath(dir), { exportedAt: "not a date" });
    assert.equal(clientLooksLive(dir, WORLD).live, false, "unparseable is not live");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- (2) results are consumed before the next op ---------------------------

test("awaitQueueDrain returns true on an empty queue and false on a timeout", async () => {
  const dir = scratch();
  try {
    write(opsPath(dir), []);
    assert.equal(await awaitQueueDrain(dir, WORLD, { timeoutMs: 1000 }), true);
    write(opsPath(dir), [{ opId: "op1" }]);
    assert.equal(await awaitQueueDrain(dir, WORLD, { timeoutMs: 1200 }), false, "a stuck queue times out rather than hanging");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("awaitOpResult only reads results once the queue is empty, and matches by opId", async () => {
  const dir = scratch();
  try {
    // Result present but the queue is still in flight -> must NOT be trusted yet.
    write(opsPath(dir), [{ opId: "op-current" }]);
    write(resPath(dir), [{ opId: "op-current", ok: true, foundryUuid: "Scene.X" }]);
    assert.equal(await awaitOpResult(dir, WORLD, "op-current", { timeoutMs: 1200 }), null,
      "a result must not be consumed while the queue still holds ops");

    write(opsPath(dir), []);
    const hit = await awaitOpResult(dir, WORLD, "op-current", { timeoutMs: 4000 });
    assert.deepEqual(hit, { opId: "op-current", ok: true, foundryUuid: "Scene.X" });

    // A result for a DIFFERENT op must never be mistaken for ours — that is how
    // the wrong uuid gets written onto a record.
    write(resPath(dir), [{ opId: "op-someone-else", ok: true, foundryUuid: "Scene.WRONG" }]);
    assert.equal(await awaitOpResult(dir, WORLD, "op-mine", { timeoutMs: 1200 }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- pushOne: the three outcomes a caller must tell apart ------------------

test("pushOne skips an already-pushed record, and force overrides", async () => {
  const dir = scratch();
  try {
    write(opsPath(dir), []); write(idxPath(dir), { exportedAt: new Date().toISOString() });
    let queued = 0;
    const base = { dataDir: dir, world: WORLD, label: "Vane", alreadyPushed: true, timeoutMs: 2000,
      queueFn: async () => { queued++; return { opId: "op1" }; }, reconcileFn: async () => {} };
    const skipped = await pushOne(base);
    assert.equal(skipped.status, "skipped");
    assert.equal(queued, 0, "a skipped push must not touch the bridge at all");

    write(resPath(dir), [{ opId: "op1", ok: true, foundryUuid: "Actor.A" }]);
    const forced = await pushOne({ ...base, force: true });
    assert.equal(forced.status, "ok");
    assert.equal(queued, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pushOne reconciles the ref, and reports loudly when reconciliation fails", async () => {
  const dir = scratch();
  try {
    write(opsPath(dir), []); write(idxPath(dir), { exportedAt: new Date().toISOString() });
    write(resPath(dir), [{ opId: "op2", ok: true, foundryUuid: "Scene.Good" }]);

    let got = null;
    const ok = await pushOne({
      dataDir: dir, world: WORLD, label: "The count", alreadyPushed: false, timeoutMs: 4000,
      queueFn: async () => ({ opId: "op2" }), reconcileFn: async (ref) => { got = ref; }
    });
    assert.equal(ok.status, "ok");
    assert.equal(got, "Scene.Good", "the uuid is handed to the reconciler");

    const bad = await pushOne({
      dataDir: dir, world: WORLD, label: "The count", alreadyPushed: false, timeoutMs: 4000,
      queueFn: async () => ({ opId: "op2" }), reconcileFn: async () => { throw new Error("store write failed"); }
    });
    assert.equal(bad.status, "failed");
    assert.match(bad.reason, /applied in Foundry as Scene.Good but the ref could not be reconciled/,
      "a document that exists in Foundry but is unknown to the store is the orphan/duplicate cause — say so");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a stale index does NOT block a push; a stuck queue fails and carries the liveness hint", async () => {
  const dir = scratch();
  try {
    // Stale index but an empty queue: the client may simply be idle, so the
    // push must still be attempted rather than refused on a guess.
    write(opsPath(dir), []);
    write(idxPath(dir), { exportedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    write(resPath(dir), [{ opId: "op-idle", ok: true, foundryUuid: "Actor.Idle" }]);
    const attempted = await pushOne({ dataDir: dir, world: WORLD, label: "x", alreadyPushed: false, timeoutMs: 4000,
      queueFn: async () => ({ opId: "op-idle" }), reconcileFn: async () => {} });
    assert.equal(attempted.status, "ok", "an idle-but-connected client must not be mistaken for a dead one");

    // Stuck queue + stale index: now it fails, and the message says why.
    write(opsPath(dir), [{ opId: "someone-elses" }]);
    const stuck = await pushOne({ dataDir: dir, world: WORLD, label: "x", alreadyPushed: false, timeoutMs: 1500,
      queueFn: async () => ({ opId: "nope" }) });
    assert.equal(stuck.status, "failed");
    assert.match(stuck.reason, /never drained/);
    assert.match(stuck.reason, /may not be connected/, "the drain failure carries the liveness hint");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pushOne fails cleanly on a bad queue response and a bridge error", async () => {
  const dir = scratch();
  try {
    write(opsPath(dir), []);

    write(idxPath(dir), { exportedAt: new Date().toISOString() });
    const noOp = await pushOne({ dataDir: dir, world: WORLD, label: "x", alreadyPushed: false, timeoutMs: 2000,
      queueFn: async () => ({ status: "queued" }) });
    assert.equal(noOp.status, "failed");
    assert.match(noOp.reason, /returned no opId/);

    write(resPath(dir), [{ opId: "op3", ok: false, error: "Scene already exists" }]);
    const rejected = await pushOne({ dataDir: dir, world: WORLD, label: "x", alreadyPushed: false, timeoutMs: 4000,
      queueFn: async () => ({ opId: "op3" }) });
    assert.equal(rejected.status, "failed");
    assert.match(rejected.reason, /Scene already exists/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- (3) verification: tokens and duplicates ------------------------------

test("verifyWorld reports duplicate scene names and per-scene token counts", () => {
  const dir = scratch();
  try {
    write(idxPath(dir), {
      exportedAt: "2026-10-06T23:51:20.784Z",
      scenes: [
        { uuid: "Scene.a", name: "The count" },
        { uuid: "Scene.b", name: "The count" },
        { uuid: "Scene.c", name: "The debt" }
      ],
      tokens: [
        { sceneUuid: "Scene.a" }, { sceneUuid: "Scene.a" }, { sceneUuid: "Scene.a" }
      ]
    });
    const v = verifyWorld(dir, WORLD);
    assert.equal(v.exportedAt, "2026-10-06T23:51:20.784Z");
    assert.deepEqual(v.duplicates, [{ name: "The count", uuids: ["Scene.a", "Scene.b"] }]);
    assert.equal(v.scenes.find((s) => s.uuid === "Scene.a").tokens, 3);
    assert.equal(v.scenes.find((s) => s.uuid === "Scene.b").tokens, 0,
      "an empty duplicate is exactly what a lost ref produces — it must be visible");
    assert.equal(v.scenes.find((s) => s.uuid === "Scene.c").tokens, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verifyWorld degrades to empty on a missing or malformed index", () => {
  const dir = scratch();
  try {
    assert.deepEqual(verifyWorld(dir, WORLD), { exportedAt: null, scenes: [], duplicates: [] });
    writeFileSync(idxPath(dir), "{not json", "utf8");
    assert.deepEqual(verifyWorld(dir, WORLD), { exportedAt: null, scenes: [], duplicates: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the default op timeout budgets for the slow first op, not the fast ones", () => {
  assert.ok(OP_TIMEOUT_MS >= 8 * 60 * 1000,
    "the first op after a client connects was measured at ~8 minutes; a shorter default reports a false hang");
});
