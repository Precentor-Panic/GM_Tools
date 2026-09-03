import assert from "node:assert/strict";
import {
  partitionForTable,
  renderAllusionInstruction,
  renderGmTruthBlock
} from "../mutation-engine/narrative-gate.mjs";

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

const ENTITIES = [
  { id: "vane", name: "Corvin Vane" },
  { id: "source", name: "The Source" },
  { id: "inn", name: "The Gilded Ewer" },
  { id: "guild", name: "Dyers' Guild" },
  { id: "marek", name: "Marek" }
];

function states(entries) {
  return new Map(Object.entries(entries));
}

// --------------------------------------------------------- partitionForTable

test("absence of any record = zero gating: everything visible, nothing withheld (the gin-up guarantee)", () => {
  const { visible, withheld } = partitionForTable(ENTITIES, new Map());
  assert.deepEqual(visible, ENTITIES);
  assert.deepEqual(withheld, []);
});

test("hidden entities are excluded from visible entirely — and never appear in withheld either", () => {
  const { visible, withheld } = partitionForTable(ENTITIES, states({
    source: { revealState: "hidden", truth: "a failing lostech siphon", stance: "concealing" }
  }));
  assert.ok(!visible.some((e) => e.id === "source"), "hidden entity removed");
  assert.equal(visible.length, ENTITIES.length - 1);
  assert.deepEqual(withheld, [], "a hidden entity's stance never travels");
});

test("unrevealed + truth => withheld (and still visible: surface is player-safe)", () => {
  const { visible, withheld } = partitionForTable(ENTITIES, states({
    vane: { revealState: "unrevealed", truth: "he drains the Source" }
  }));
  assert.ok(visible.some((e) => e.id === "vane"));
  assert.deepEqual(withheld, [{ id: "vane", name: "Corvin Vane", revealState: "unrevealed" }]);
});

test("stance-only record (no truth prose yet) still joins withheld — a stance signals there's a there there", () => {
  const { withheld } = partitionForTable(ENTITIES, states({
    marek: { revealState: "unrevealed", stance: "concealing" }
  }));
  assert.deepEqual(withheld, [{ id: "marek", name: "Marek", revealState: "unrevealed", stance: "concealing" }]);
});

test("a record with neither truth nor stance is NOT withheld (nothing to allude to)", () => {
  const { withheld } = partitionForTable(ENTITIES, states({
    inn: { revealState: "unrevealed" }
  }));
  assert.deepEqual(withheld, []);
});

test("revealed records gate nothing", () => {
  const { visible, withheld } = partitionForTable(ENTITIES, states({
    guild: { revealState: "revealed", truth: "they launder for the Copper Hand", stance: "concealing" }
  }));
  assert.equal(visible.length, ENTITIES.length);
  assert.deepEqual(withheld, []);
});

test("hinted + truth => withheld, carrying the hinted state", () => {
  const { withheld } = partitionForTable(ENTITIES, states({
    vane: { revealState: "hinted", truth: "he drains the Source", stance: "unaware" }
  }));
  assert.deepEqual(withheld, [{ id: "vane", name: "Corvin Vane", revealState: "hinted", stance: "unaware" }]);
});

test("accepts a plain object for statesById and entityId-keyed entities", () => {
  const { withheld } = partitionForTable(
    [{ entityId: "x1", name: "X" }],
    { x1: { revealState: "unrevealed", truth: "t" } }
  );
  assert.equal(withheld.length, 1);
  assert.equal(withheld[0].id, "x1");
});

test("empty/undefined inputs degrade to empty results, never throw", () => {
  assert.deepEqual(partitionForTable([], new Map()), { visible: [], withheld: [] });
  assert.deepEqual(partitionForTable(undefined, undefined), { visible: [], withheld: [] });
});

// ------------------------------------------------- renderAllusionInstruction

test("empty withheld renders empty string (templates carry an empty-default slot)", () => {
  assert.equal(renderAllusionInstruction([]), "");
  assert.equal(renderAllusionInstruction(undefined), "");
});

test("concealing stance renders deflection guidance without any truth content", () => {
  const block = renderAllusionInstruction([{ id: "m", name: "Marek", revealState: "unrevealed", stance: "concealing" }]);
  assert.match(block, /Marek: actively concealing/);
  assert.match(block, /never state, confirm, or invent/i);
  assert.match(block, /NEVER reveal/i);
});

test("unaware stance renders sincere-but-wrong guidance", () => {
  const block = renderAllusionInstruction([{ id: "r", name: "The Ruin", revealState: "unrevealed", stance: "unaware" }]);
  assert.match(block, /The Ruin: sincerely unaware/);
  assert.match(block, /discovery must come from outside/);
});

test("undisclosed stance renders defer-to-GM guidance (the prompt has no truth to surface)", () => {
  const block = renderAllusionInstruction([{ id: "i", name: "The Ledger", revealState: "unrevealed", stance: "undisclosed" }]);
  assert.match(block, /The Ledger: holds it merely undisclosed/);
  assert.match(block, /leave space for the GM/);
});

test("absent stance renders the generic allude-don't-disclose line", () => {
  const block = renderAllusionInstruction([{ id: "v", name: "Corvin Vane", revealState: "unrevealed" }]);
  assert.match(block, /Corvin Vane: holds something the players have not learned/);
});

test("hinted entities get the already-hinted marker", () => {
  const block = renderAllusionInstruction([{ id: "v", name: "Corvin Vane", revealState: "hinted" }]);
  assert.match(block, /already caught a hint/);
  const unhinted = renderAllusionInstruction([{ id: "v", name: "Corvin Vane", revealState: "unrevealed" }]);
  assert.ok(!/already caught a hint/.test(unhinted));
});

// ------------------------------------------------------- renderGmTruthBlock

test("no record / neither truth nor stance renders empty string", () => {
  assert.equal(renderGmTruthBlock(null), "");
  assert.equal(renderGmTruthBlock({ revealState: "unrevealed" }), "");
});

test("truth + stance render together with the GM-only label and reveal state", () => {
  const block = renderGmTruthBlock(
    { revealState: "unrevealed", truth: "He is the siphon's architect.", stance: "concealing" },
    { name: "Corvin Vane" }
  );
  assert.match(block, /^GM TRUTH — Corvin Vane \[reveal: unrevealed\]/);
  assert.match(block, /never shown to players/);
  assert.match(block, /Stance: concealing/);
  assert.match(block, /He is the siphon's architect\./);
});

test("stance-only record still renders a GM block (the stance is prep-relevant even before the prose exists)", () => {
  const block = renderGmTruthBlock({ revealState: "unrevealed", stance: "unaware" });
  assert.match(block, /Stance: unaware/);
  assert.ok(!/undefined/.test(block));
});

console.log(`\n${passed} passed`);
