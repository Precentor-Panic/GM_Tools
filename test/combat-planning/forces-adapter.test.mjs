import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

/**
 * CONTRACT UNDER TEST — combat-planning/forces-adapter.mjs (WS-4,
 * opforce-plan-2026-09-12.md §3). `toForces` is pure/no-I/O;
 * `scoreWithSimulator` is the one function in this module that ever touches
 * the network, and only when `endpoint` is explicitly configured.
 *
 * SHAPE CHECK: this schema mirrors `rl-combat/training/eval.py`'s
 * `_stage_to_forces` verbatim -- each side is a list of
 * `{"name": str, "actorName": str, "x": int, "y": int}` dicts (see that
 * function's own `blue`/`red` list-comprehension literals). Zod is this
 * codebase's own established schema-validation tool (gm-tools-conventions
 * SKILL.md: "Zod for all schema validation. Don't introduce a second
 * validation library.") -- used here as the "JSON schema check" this task
 * asks for, rather than pulling in a JSON-Schema library this project has
 * never used anywhere else.
 */
const ForceUnit = z.object({
  name: z.string().min(1),
  actorName: z.string().min(1),
  x: z.number().int(),
  y: z.number().int()
});
const StageToForcesShape = z.object({
  blue: z.array(ForceUnit),
  red: z.array(ForceUnit)
});

const { toForces } = await import("../../combat-planning/forces-adapter.mjs");
const { scoreWithSimulator } = await import("../../combat-planning/forces-adapter.mjs");

// An invented 4-PC party and a small invented composition -- no campaign names.
const PARTY = [
  { id: "pc-1", name: "Rowan", combatRelevant: { class: "Fighter" } },
  { id: "pc-2", name: "Sable", combatRelevant: { class: "Rogue" } },
  { id: "pc-3", name: "Ilse", combatRelevant: { class: "Cleric" } },
  { id: "pc-4", name: "Devin", combatRelevant: { class: "Wizard" } }
];

const COMPOSITION = {
  archetype: "mixed",
  units: [
    { entryId: "gob-1", count: 2 },
    { entryId: "ogre-1", count: 1 }
  ]
};

test("toForces: round-trips a composition to the {blue, red} forces shape, validated against _stage_to_forces's own schema", () => {
  const forces = toForces(COMPOSITION, { party: PARTY });
  const parsed = StageToForcesShape.parse(forces); // throws on any shape mismatch
  assert.equal(parsed.blue.length, 4, "one blue unit per party member");
  assert.equal(parsed.red.length, 3, "count:2 + count:1 expands to 3 individual red units");
});

test("toForces: expands `count` into numbered units, unnumbered when count is 1", () => {
  const forces = toForces(COMPOSITION, { party: PARTY });
  const names = forces.red.map((u) => u.name);
  assert.deepEqual(names, ["gob-1 1", "gob-1 2", "ogre-1"], "count:2 numbers both, count:1 stays unnumbered");
});

test("toForces: strips the Actor. UUID prefix from a party member's foundryActorRef when no class is present", () => {
  const party = [{ id: "pc-1", name: "Unclassed", foundryActorRef: "Actor.abc123xyz" }];
  const forces = toForces({ units: [] }, { party });
  assert.equal(forces.blue[0].actorName, "abc123xyz");
});

test("toForces: prefers combatRelevant.class over a foundryActorRef for actorName (a system-agnostic 'what kind of PC' label)", () => {
  const party = [{ id: "pc-1", name: "Classed", foundryActorRef: "Actor.abc123", combatRelevant: { class: "Ranger" } }];
  const forces = toForces({ units: [] }, { party });
  assert.equal(forces.blue[0].actorName, "Ranger");
});

test("toForces: a red unit's own resolved name/actorName (when the caller already attached them from a bestiary entry) wins over the bare entryId", () => {
  const composition = { units: [{ entryId: "ogre-1", count: 1, name: "Bog Ogre", actorName: "Ogre" }] };
  const forces = toForces(composition, { party: [] });
  assert.deepEqual(forces.red, [{ name: "Bog Ogre", actorName: "Ogre", x: forces.red[0].x, y: forces.red[0].y }]);
});

test("toForces: default two-line layout places blue on the left column, red on the right column, given {grid_w, grid_h}", () => {
  const forces = toForces(COMPOSITION, { party: PARTY, positions: { grid_w: 30, grid_h: 30 } });
  for (const u of forces.blue) assert.equal(u.x, 2);
  for (const u of forces.red) assert.equal(u.x, 27);
  // y spaced out per unit, not all stacked on the same square.
  assert.deepEqual(forces.blue.map((u) => u.y), [0, 2, 4, 6]);
});

test("toForces: explicit positions are used verbatim, one entry per EXPANDED unit", () => {
  const forces = toForces(COMPOSITION, {
    party: PARTY,
    positions: {
      blue: [{ x: 1, y: 1 }, { x: 1, y: 3 }, { x: 1, y: 5 }, { x: 1, y: 7 }],
      red: [{ x: 9, y: 1 }, { x: 9, y: 3 }, { x: 9, y: 5 }]
    }
  });
  assert.deepEqual(forces.blue.map((u) => [u.x, u.y]), [[1, 1], [1, 3], [1, 5], [1, 7]]);
  assert.deepEqual(forces.red.map((u) => [u.x, u.y]), [[9, 1], [9, 3], [9, 5]]);
});

test("toForces: an empty party and/or empty composition never throws, just yields an empty side", () => {
  assert.deepEqual(toForces({ units: [] }, { party: [] }), { blue: [], red: [] });
  const onlyRed = toForces(COMPOSITION, { party: [] });
  assert.equal(onlyRed.blue.length, 0);
  assert.equal(onlyRed.red.length, 3);
});

// -----------------------------------------------------------------------
// scoreWithSimulator: the heuristic path must be untouched -- always
// resolves to null on any failure, never throws.
// -----------------------------------------------------------------------

test("scoreWithSimulator: no endpoint configured -> null immediately, no network attempt", async () => {
  const result = await scoreWithSimulator({ blue: [], red: [] }, { grid_w: 20, grid_h: 20 }, {});
  assert.equal(result, null);
});

test("scoreWithSimulator: a connection failure (nothing listening on this port) resolves to null, never throws", async () => {
  // Port 1 is (almost) never a real listening service in a test sandbox --
  // a real ECONNREFUSED, not a mock.
  const result = await scoreWithSimulator(
    { blue: [], red: [] },
    { grid_w: 20, grid_h: 20 },
    { endpoint: "http://127.0.0.1:1/score", timeoutMs: 2000 }
  );
  assert.equal(result, null);
});

test("scoreWithSimulator: a well-formed response is returned with exactly the four required fields", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ win_rate: 0.42, mean_rounds: 5.5, p_any_pc_down: 0.3, p_tpk: 0.05, extra: "ignored" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const result = await scoreWithSimulator({ blue: [], red: [] }, { grid_w: 20, grid_h: 20 }, { endpoint: `http://127.0.0.1:${port}/score` });
    assert.deepEqual(result, { win_rate: 0.42, mean_rounds: 5.5, p_any_pc_down: 0.3, p_tpk: 0.05 });
  } finally {
    server.close();
  }
});

test("scoreWithSimulator: a malformed response body (missing a required field) resolves to null, not a thrown parse error", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ win_rate: 0.5 })); // missing mean_rounds/p_any_pc_down/p_tpk
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const result = await scoreWithSimulator({ blue: [], red: [] }, { grid_w: 20, grid_h: 20 }, { endpoint: `http://127.0.0.1:${port}/score` });
    assert.equal(result, null);
  } finally {
    server.close();
  }
});

test("scoreWithSimulator: a non-2xx response resolves to null, not a thrown error", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const result = await scoreWithSimulator({ blue: [], red: [] }, { grid_w: 20, grid_h: 20 }, { endpoint: `http://127.0.0.1:${port}/score` });
    assert.equal(result, null);
  } finally {
    server.close();
  }
});
