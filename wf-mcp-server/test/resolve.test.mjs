import assert from "node:assert/strict";

/**
 * Security review finding, not a routine unit test: resolveWorld()'s
 * returned value gets join()'d directly into a file path in all seven of
 * this project's flat-JSON stores plus the snapshot/mutations-bridge paths
 * (review-state.mjs, entity-narration.mjs, human-review.mjs,
 * pending-ledger.mjs, prep-content.mjs, manual-undo.mjs, user-settings.mjs,
 * snapshot.mjs). node:path's join() does not stop `..` traversal, and
 * review-ui/server.mjs (the actual network-facing consumer of this
 * function) has no authentication layer at all -- so an unvalidated world
 * string was a real, unauthenticated arbitrary-file-path primitive, not a
 * theoretical concern. This test is the permanent regression guard for that
 * fix: it must keep failing loudly if the validation is ever removed or
 * loosened, not just pass once and be forgotten.
 */
const { resolveWorld } = await import("../lib/resolve.mjs");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

test("resolveWorld: a normal, real-shaped world id (letters, digits, hyphens, underscores) is accepted unchanged", () => {
  assert.equal(resolveWorld("wf-test"), "wf-test");
  assert.equal(resolveWorld("rl_combat_2"), "rl_combat_2");
});

test("SECURITY: resolveWorld rejects a path-traversal-shaped world id rather than passing it through to a file path", () => {
  assert.throws(() => resolveWorld("../../../etc"), /Invalid world id/);
  assert.throws(() => resolveWorld("../secrets"), /Invalid world id/);
});

test("SECURITY: resolveWorld rejects an absolute-path-shaped world id", () => {
  assert.throws(() => resolveWorld("/etc/passwd"), /Invalid world id/);
});

test("SECURITY: resolveWorld rejects a world id containing a path separator, even without literal '..'", () => {
  assert.throws(() => resolveWorld("foo/bar"), /Invalid world id/);
  assert.throws(() => resolveWorld("foo\\bar"), /Invalid world id/);
});

test("resolveWorld: still throws its own original, distinct error when nothing is specified and no default is set", () => {
  const prior = process.env.WF_DEFAULT_WORLD;
  delete process.env.WF_DEFAULT_WORLD;
  try {
    assert.throws(() => resolveWorld(undefined), /No world specified/);
  } finally {
    if (prior !== undefined) process.env.WF_DEFAULT_WORLD = prior;
  }
});

console.log(`\n${passed} passed`);
