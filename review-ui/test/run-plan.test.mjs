import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * CONTRACT UNDER TEST -- planRunSpread (run-spread consolidation pass,
 * review-ui/public/run-layout.mjs): the ONE pure element-sequence ->
 * spread-plan step. No server, no DOM -- this suite pins the consolidation
 * rules themselves:
 *   - MAIN: lowest-order ungrouped read opens; ALL ungrouped main dressing
 *     folds into ONE card regardless of interleaving; the rest keep order.
 *   - SIDE: ungrouped gm boxes fold into one card only at >=2; blocks/
 *     cards/sketches always stay individual.
 *   - Explicit run.group -> one composite card per (column, group),
 *     positioned by its lead (lowest-order member); one-member groups
 *     render plain; grouped elements never join an auto-fold pool.
 *   - CONSERVATION: every input element appears in the output exactly once.
 */
const { planRunSpread, runFieldLabel, RUN_LAYOUT_VERSION } = await import("../public/run-layout.mjs");

let nextId = 0;
function item(role, opts = {}) {
  nextId++;
  return {
    el: { id: `el-${nextId}`, name: opts.name ?? `${role} ${nextId}`, fields: {} },
    run: {
      column: opts.column ?? (["block", "card", "gm", "sketch"].includes(role) ? "side" : "main"),
      role,
      ...(opts.variant ? { variant: opts.variant } : {}),
      ...(opts.group ? { group: opts.group } : {})
    }
  };
}

function flattenPlan(plan) {
  const ids = [];
  for (const unit of [...plan.main, ...plan.side]) {
    if (unit.kind === "element") ids.push(unit.el.id);
    else if (unit.kind === "group") ids.push(...unit.members.map((m) => m.el.id));
    else ids.push(...unit.members.map((m) => m.el.id));
  }
  return ids;
}

test("RUN_LAYOUT_VERSION is 3 (the variant-tabs shape)", () => {
  assert.equal(RUN_LAYOUT_VERSION, 3);
});

test("runFieldLabel: the ONE role-aware label mapping Prep and Run both consume", () => {
  // Card vocabulary — the relabels two personas independently flagged as
  // silently morphing between Prep and Run; now one shared table.
  assert.equal(runFieldLabel("card", "looks"), "Effect");
  assert.equal(runFieldLabel("card", "means"), "Alternate");
  assert.equal(runFieldLabel("card", "secret"), "Failure");
  assert.equal(runFieldLabel("card", "gives"), "Phrase");
  assert.equal(runFieldLabel("read", "means"), "GM");
  // Unmapped role/field pairs fall back to the caller's generic label.
  assert.equal(runFieldLabel("beat", "looks", "Looks"), "Looks");
  assert.equal(runFieldLabel("card", "trigger", "Trigger"), "Trigger");
  assert.equal(runFieldLabel("gm", "secret", "Secret"), "Secret");
});

test("interleaved main dressing folds into ONE card, placed after the opening read and before the beats", () => {
  const read = item("read", { name: "Read Aloud — opener" });
  const d1 = item("dressing");
  const beat1 = item("beat");
  const d2 = item("dressing");
  const beat2 = item("beat");
  const d3 = item("dressing");
  const plan = planRunSpread([d1, read, beat1, d2, beat2, d3]);

  assert.deepEqual(plan.main.map((u) => u.kind), ["element", "dressing", "element", "element"]);
  assert.equal(plan.main[0].el.id, read.el.id, "the read opens the column even when a dressing row preceded it in order");
  assert.deepEqual(plan.main[1].members.map((m) => m.el.id), [d1.el.id, d2.el.id, d3.el.id], "all three dressing rows, stable by order, one card");
  assert.deepEqual([plan.main[2].el.id, plan.main[3].el.id], [beat1.el.id, beat2.el.id]);
});

test("only the LOWEST-order read is hoisted as the opener; later reads keep their place in the flow", () => {
  const beat = item("beat");
  const read1 = item("read", { name: "Read Aloud — opener" });
  const read2 = item("read", { name: "Read Aloud — later" });
  const plan = planRunSpread([beat, read1, read2]);
  assert.deepEqual(
    plan.main.map((u) => u.el.id),
    [read1.el.id, beat.el.id, read2.el.id]
  );
});

test("explicit group: members render as ONE composite card at the lead's position, excluded from auto-folds", () => {
  const read = item("read");
  const threadCard = item("card", { column: "main", group: "P-2" });
  const dressing = item("dressing");
  const groupedDressing = item("dressing", { group: "P-2" }); // grouped -> NOT in the dressing fold
  const outcomeBeat = item("beat", { group: "P-2" });
  const plan = planRunSpread([read, threadCard, dressing, groupedDressing, outcomeBeat]);

  const groupUnits = plan.main.filter((u) => u.kind === "group");
  assert.equal(groupUnits.length, 1);
  const g = groupUnits[0];
  assert.equal(g.group, "P-2");
  assert.equal(g.lead.el.id, threadCard.el.id, "lead = lowest-order member");
  assert.deepEqual(g.members.map((m) => m.el.id), [threadCard.el.id, groupedDressing.el.id, outcomeBeat.el.id]);

  const dressingUnit = plan.main.find((u) => u.kind === "dressing");
  assert.deepEqual(dressingUnit.members.map((m) => m.el.id), [dressing.el.id], "the grouped dressing row stays out of the fold");
});

test("a one-member group renders as a plain element (no wrapper penalty for a half-built group)", () => {
  const lone = item("card", { column: "main", group: "P-9" });
  const plan = planRunSpread([lone]);
  assert.deepEqual(plan.main.map((u) => u.kind), ["element"]);
  assert.equal(plan.main[0].el.id, lone.el.id);
});

test("group keying is per (column, group): the same group name in main and side makes two cards", () => {
  const mainA = item("card", { column: "main", group: "X" });
  const mainB = item("beat", { column: "main", group: "X" });
  const sideA = item("gm", { column: "side", group: "X" });
  const sideB = item("block", { column: "side", group: "X" });
  const plan = planRunSpread([mainA, mainB, sideA, sideB]);
  assert.equal(plan.main.filter((u) => u.kind === "group").length, 1);
  assert.equal(plan.side.filter((u) => u.kind === "group").length, 1);
});

// ===================== variant tabs (v3, 2026-09-01) =====================
// The caller STAMPS variantHidden (the activeVariants gating result) instead
// of filtering; folded units turn their states into tabs, loose gated
// elements still drop.

test("a group's variant members become tabs: names in member order (deduped), members off the active tab are flagged hidden, never dropped", () => {
  const lead = item("card", { column: "main", group: "P-2" });
  const fires = item("read", { column: "main", group: "P-2", variant: "Fires in place" });
  const redirect = item("read", { column: "main", group: "P-2", variant: "Redirected" });
  const aftermath = item("beat", { column: "main", group: "P-2" });
  const plan = planRunSpread([lead, fires, redirect, aftermath]);
  const g = plan.main.find((u) => u.kind === "group");
  assert.deepEqual(g.tabs, ["Fires in place", "Redirected"]);
  assert.equal(g.activeTab, "Fires in place", "no gating, no local pick -> the FIRST tab (adjudicated default)");
  assert.equal(g.key, "main::P-2");
  assert.equal(g.members.length, 4, "hidden members stay in the unit");
  assert.deepEqual(g.members.map((m) => !!m.hidden), [false, false, true, false], "only the non-active state hides");
});

test("activeTab precedence: a local pick (opts.activeTabs) beats the activeVariants seed beats the first tab", () => {
  const mk = () => {
    const lead = item("card", { column: "main", group: "G" });
    const a = item("read", { column: "main", group: "G", variant: "A" });
    const b = item("read", { column: "main", group: "G", variant: "B" });
    return [lead, a, b];
  };
  // activeVariants gated A out (stamped hidden) -> seed = B
  let [lead, a, b] = mk();
  a.variantHidden = true;
  let g = planRunSpread([lead, a, b]).main.find((u) => u.kind === "group");
  assert.equal(g.activeTab, "B", "the member gating left visible seeds the tab");
  // a local pick overrides the seed
  [lead, a, b] = mk();
  a.variantHidden = true;
  g = planRunSpread([lead, a, b], { activeTabs: new Map([["main::G", "A"]]) }).main.find((u) => u.kind === "group");
  assert.equal(g.activeTab, "A", "the GM's local flip wins over the seed");
  // a stale local pick naming no real tab falls back to the seed chain
  [lead, a, b] = mk();
  g = planRunSpread([lead, a, b], { activeTabs: new Map([["main::G", "Gone"]]) }).main.find((u) => u.kind === "group");
  assert.equal(g.activeTab, "A", "an unknown local pick is ignored");
});

test("lead = lowest-order NON-hidden member; a variant lead off the active tab yields to the next visible member", () => {
  const vlead = item("read", { column: "main", group: "G", variant: "A" });
  const b = item("read", { column: "main", group: "G", variant: "B" });
  const tail = item("beat", { column: "main", group: "G" });
  const g = planRunSpread([vlead, b, tail], { activeTabs: new Map([["main::G", "B"]]) }).main.find((u) => u.kind === "group");
  assert.equal(g.activeTab, "B");
  assert.equal(g.lead.el.id, b.el.id, "the A-state lead hides; the B member leads");
});

test("the gm-fold tabs its variant members (key 'gmfold'); gated gm boxes COUNT toward the >=2 fold and variant-less members never hide", () => {
  const present = item("gm", { variant: "Present" });
  const bad = item("gm", { variant: "Bad turn" });
  bad.variantHidden = true; // activeVariants = ["Present"]
  const always = item("gm");
  const plan = planRunSpread([present, bad, always]);
  const fold = plan.side.find((u) => u.kind === "gm-fold");
  assert.deepEqual(fold.tabs, ["Present", "Bad turn"]);
  assert.equal(fold.activeTab, "Present");
  assert.equal(fold.members.length, 3, "the gated backdrop stays as a tab, not a drop");
  assert.equal(fold.members.find((m) => m.el.id === always.el.id).hidden, false, "variant-less members always show");
  assert.equal(fold.members.find((m) => m.el.id === bad.el.id).hidden, true);
});

test("LOOSE gated elements still drop: an ungrouped main read/dressing with variantHidden never reaches the plan, and a lone gated gm box drops too", () => {
  const read = item("read");
  const gatedRead = item("read", { variant: "Night" });
  gatedRead.variantHidden = true;
  const gatedDressing = item("dressing", { variant: "Night" });
  gatedDressing.variantHidden = true;
  const loneGatedGm = item("gm", { variant: "Night" });
  loneGatedGm.variantHidden = true;
  const plan = planRunSpread([read, gatedRead, gatedDressing, loneGatedGm]);
  const ids = flattenPlan(plan);
  assert.deepEqual(ids, [read.el.id], "only the visible loose element survives");
});

test("a single-tab unit shows its one state with no tab choice pressure (tabs.length 1, activeTab = that state, nothing hidden)", () => {
  const lead = item("card", { column: "main", group: "G" });
  const only = item("read", { column: "main", group: "G", variant: "Only" });
  const g = planRunSpread([lead, only]).main.find((u) => u.kind === "group");
  assert.deepEqual(g.tabs, ["Only"]);
  assert.equal(g.activeTab, "Only");
  assert.ok(g.members.every((m) => !m.hidden));
});

test("side gm boxes fold into one card only at >=2, positioned where the first sat; a lone gm box stays plain", () => {
  const block = item("block");
  const gm1 = item("gm");
  const sketch = item("sketch");
  const gm2 = item("gm");
  const plan = planRunSpread([block, gm1, sketch, gm2]);
  assert.deepEqual(plan.side.map((u) => u.kind), ["element", "gm-fold", "element"]);
  assert.deepEqual(plan.side[1].members.map((m) => m.el.id), [gm1.el.id, gm2.el.id]);
  assert.equal(plan.side[2].el.id, sketch.el.id);

  const planLone = planRunSpread([block, gm1, sketch]);
  assert.deepEqual(planLone.side.map((u) => u.kind), ["element", "element", "element"], "a single gm box gets no pointless wrapper");
});

test("side blocks/cards/sketches never fold -- they stay individual cards", () => {
  const b1 = item("block");
  const b2 = item("block");
  const c1 = item("card");
  const c2 = item("card");
  const s1 = item("sketch");
  const plan = planRunSpread([b1, b2, c1, c2, s1]);
  assert.equal(plan.side.length, 5);
  assert.ok(plan.side.every((u) => u.kind === "element"));
});

test("CONSERVATION: every input element appears in the output exactly once (consolidation never drops)", () => {
  const inputs = [
    item("read"), item("dressing"), item("beat"), item("dressing"),
    item("card", { column: "main", group: "G" }), item("read", { group: "G" }),
    item("exits"), item("gm"), item("gm"), item("block"),
    item("sketch"), item("card"), item("beat", { column: "side" })
  ];
  const plan = planRunSpread(inputs);
  const outIds = flattenPlan(plan).sort();
  const inIds = inputs.map((i) => i.el.id).sort();
  assert.deepEqual(outIds, inIds);
});

test("golden legacy plan: an ungrouped scene with no interleaving reproduces the classic spread shapes in order", () => {
  // The pre-consolidation Loom-shaped baseline: read, dressing run, beats,
  // exits in main; gm boxes + blocks in side. With dressing already
  // consecutive and the read first, consolidation must change NOTHING
  // except folding gm boxes (>=2) -- the legacy dressing fold already
  // existed for the consecutive case.
  const read = item("read");
  const d1 = item("dressing");
  const d2 = item("dressing");
  const beat = item("beat");
  const exits = item("exits");
  const gm1 = item("gm");
  const gm2 = item("gm");
  const block = item("block");
  const plan = planRunSpread([read, d1, d2, beat, exits, gm1, gm2, block]);
  assert.deepEqual(plan.main.map((u) => u.kind), ["element", "dressing", "element", "element"]);
  assert.equal(plan.main[0].el.id, read.el.id);
  assert.equal(plan.main[2].el.id, beat.el.id);
  assert.equal(plan.main[3].el.id, exits.el.id, "exits stay in the element flow (the renderer owns the footer placement)");
  assert.deepEqual(plan.side.map((u) => u.kind), ["gm-fold", "element"]);
});
