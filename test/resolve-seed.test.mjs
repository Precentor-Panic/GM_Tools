import assert from "node:assert/strict";
import {
  resolveSeed,
  SeedResolutionError,
  DEFAULT_RESOLVE_SEED_MODEL
} from "../time-skip/resolve-seed.mjs";

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push(
    (async () => {
      try {
        await fn();
        passed++;
        console.log(`  ok  ${name}`);
      } catch (err) {
        console.error(`FAIL  ${name}`);
        console.error(err.stack || err.message);
        process.exitCode = 1;
      }
    })()
  );
}

const entities = [
  { id: "alvor", name: "Alvor", type: "person", importance: 0.5, summary: "The village smith, runs the forge." },
  { id: "gerdur", name: "Gerdur", type: "person", importance: 0.4, summary: "Alvor's sister, runs the mill." },
  { id: "riverwood-trader", name: "Riverwood Trader", type: "place", importance: 0.4, summary: "The general goods shop, run by the tavern owner Lucan." },
  { id: "sleeping-giant", name: "Sleeping Giant Inn", type: "place", importance: 0.3, summary: "The tavern, run by innkeeper Orgnar." }
];
const edges = [];

function mockClient(responses) {
  let call = 0;
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        const resp = responses[Math.min(call, responses.length - 1)];
        call++;
        return { content: [{ type: "text", text: typeof resp === "function" ? resp(params) : resp }] };
      }
    }
  };
}

// ---------------------------------------------------------------- constants

test("DEFAULT_RESOLVE_SEED_MODEL is claude-sonnet-5, matching texture.mjs's default", () => {
  assert.equal(DEFAULT_RESOLVE_SEED_MODEL, "claude-sonnet-5");
});

// ----------------------------------------------------------- single match

test("resolveSeed: single confident match resolves to that entity", async () => {
  const client = mockClient([
    JSON.stringify({ resolution: "single", entityId: "sleeping-giant", rationale: "The Sleeping Giant is the tavern." })
  ]);
  const result = await resolveSeed("the tavern owner dies", { entities, edges }, { client });
  assert.equal(result.status, "resolved");
  assert.equal(result.entityId, "sleeping-giant");
  assert.equal(result.name, "Sleeping Giant Inn");
  assert.ok(result.rationale.length > 0);
});

test("resolveSeed: strips markdown code fences before parsing (same convention as texture.mjs)", async () => {
  const client = mockClient([
    "```json\n" + JSON.stringify({ resolution: "single", entityId: "alvor", rationale: "Alvor is the smith." }) + "\n```"
  ]);
  const result = await resolveSeed("the smith is attacked", { entities, edges }, { client });
  assert.equal(result.entityId, "alvor");
});

test("resolveSeed: a single-match response naming an entityId NOT in the candidate list is treated as invalid (retried, then a typed error)", async () => {
  const client = mockClient([
    JSON.stringify({ resolution: "single", entityId: "not-a-real-id", rationale: "..." })
  ]);
  await assert.rejects(
    resolveSeed("something happens", { entities, edges }, { client }),
    (err) => err instanceof SeedResolutionError && err.kind === "invalid-response"
  );
});

// -------------------------------------------------------- multi-match: ambiguous

test("resolveSeed: multi-match disambiguation returns candidates rather than guessing (not a thrown error)", async () => {
  const client = mockClient([
    JSON.stringify({
      resolution: "ambiguous",
      candidates: [
        { entityId: "riverwood-trader", name: "Riverwood Trader", reason: "Run by a shopkeeper who could be read as 'the owner'." },
        { entityId: "sleeping-giant", name: "Sleeping Giant Inn", reason: "The actual tavern, run by an innkeeper." }
      ]
    })
  ]);
  const result = await resolveSeed("the shop owner", { entities, edges }, { client });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every((c) => entities.some((e) => e.id === c.entityId)));
});

// -------------------------------------------------------------------- no-match

test("resolveSeed: no plausible match throws a typed SeedResolutionError, not a silent no-op", async () => {
  const client = mockClient([
    JSON.stringify({ resolution: "no-match", reason: "No entity in the list is a dragon." })
  ]);
  await assert.rejects(
    resolveSeed("a dragon attacks the capital", { entities, edges }, { client }),
    (err) => {
      assert.ok(err instanceof SeedResolutionError);
      assert.equal(err.kind, "no-match");
      assert.ok(err.message.includes("dragon attacks the capital"));
      assert.equal(err.reason, "No entity in the list is a dragon.");
      return true;
    }
  );
});

// ------------------------------------------------------------------ retries

test("resolveSeed: retries once on invalid JSON, succeeds on second attempt", async () => {
  const client = mockClient([
    "not valid json at all",
    JSON.stringify({ resolution: "single", entityId: "gerdur", rationale: "Gerdur runs the mill." })
  ]);
  const result = await resolveSeed("the miller is hurt", { entities, edges }, { client });
  assert.equal(result.entityId, "gerdur");
  assert.equal(client.calls.length, 2);
});

test("resolveSeed: retries once on schema-invalid JSON (missing rationale), succeeds on second attempt", async () => {
  const client = mockClient([
    JSON.stringify({ resolution: "single", entityId: "alvor" }), // missing rationale
    JSON.stringify({ resolution: "single", entityId: "alvor", rationale: "Alvor is the smith." })
  ]);
  const result = await resolveSeed("the smith", { entities, edges }, { client });
  assert.equal(result.entityId, "alvor");
});

test("resolveSeed: ambiguous resolution is NOT retried even on a first-attempt success (not treated as a failure)", async () => {
  const client = mockClient([
    JSON.stringify({
      resolution: "ambiguous",
      candidates: [
        { entityId: "alvor", name: "Alvor", reason: "a" },
        { entityId: "gerdur", name: "Gerdur", reason: "b" }
      ]
    })
  ]);
  const result = await resolveSeed("a sibling", { entities, edges }, { client });
  assert.equal(result.status, "ambiguous");
  assert.equal(client.calls.length, 1, "ambiguous is a valid final result on the first attempt, not a retry trigger");
});

test("resolveSeed: no-match is NOT retried (it's a final result, not a validation failure)", async () => {
  const client = mockClient([
    JSON.stringify({ resolution: "no-match", reason: "Nothing fits." })
  ]);
  await assert.rejects(resolveSeed("an unrelated event", { entities, edges }, { client }));
  assert.equal(client.calls.length, 1, "no-match should not trigger a second attempt");
});

test("resolveSeed: throws a typed SeedResolutionError after a second validation failure, does not silently drop the request", async () => {
  const client = mockClient(["still not json", "still not json either"]);
  await assert.rejects(
    resolveSeed("garbled event", { entities, edges }, { client }),
    (err) => {
      assert.ok(err instanceof SeedResolutionError);
      assert.equal(err.kind, "invalid-response");
      assert.equal(err.attempts, 2);
      return true;
    }
  );
});

await Promise.all(pending);
console.log(`\n${passed} passed`);
