import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bridge-state-"));
process.env.GM_TOOLS_STATE_DIR = dir;
const { bridgeStatePath, bridgeLiveness, HEARTBEAT_FRESH_MS } = await import("../lib/bridge-state.mjs");
const W = "bridge-state-test-world";
const beat = (fields) => writeFileSync(bridgeStatePath(W), JSON.stringify({ world: W, pid: process.pid, state: "connected", beatAt: new Date().toISOString(), ...fields }));

test("no heartbeat on record is not connected", () => {
  const l = bridgeLiveness("never-" + W);
  assert.equal(l.connected, false);
  assert.equal(l.state, null);
});
test("a fresh heartbeat from a live process is connected", () => {
  beat({});
  assert.equal(bridgeLiveness(W).connected, true);
});
test("a stale heartbeat is not connected", () => {
  beat({ beatAt: new Date(Date.now() - HEARTBEAT_FRESH_MS - 1000).toISOString() });
  assert.equal(bridgeLiveness(W).connected, false);
});
test("a fresh heartbeat that says stopped or degraded is not connected", () => {
  beat({ state: "stopped" });
  assert.equal(bridgeLiveness(W).connected, false);
  beat({ state: "degraded" });
  assert.equal(bridgeLiveness(W).connected, false);
});
test("a fresh heartbeat from a process that is gone is not connected", () => {
  beat({ pid: 2 ** 22 + 12345 }); // above the default pid_max
  const l = bridgeLiveness(W);
  assert.equal(l.connected, false);
  assert.equal(l.pidAlive, false);
});
test.after(() => rmSync(dir, { recursive: true, force: true }));
