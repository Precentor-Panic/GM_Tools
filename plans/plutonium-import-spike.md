# Plutonium programmatic-import spike (S0 of the Aureus table wave)

**Status: PENDING a live Foundry client** (none running when the wave was
built, 2026-09-03). The API surface is already verified STATICALLY against
the installed module source (`~/foundrydata/Data/modules/plutonium/js/
Bundle.js`, v2.17.2.v14, ~line 187661): `game.modules.get("plutonium").api
= Api._API` exposing `api.importer.creature.pImportEntry(entry, opts)`,
`api.importer.spell.pImportEntry(...)`, `api.importer.pGetImporter({page|
prop})` (returns an initialized ImportList for any prop, e.g. `"item"`),
and `api.importer.ImportOpts`. `pImportEntry` takes a **raw 5etools
record**, gates only on `game.user.role >= Config.get("import",
"minimumRole")`, and returns an `ImportSummary` whose
`getPrimaryDocument()` is a real Foundry doc.

The bridge op `import_via_plutonium` (contract v4) is built DEFENSIVELY
against exactly this surface — the spike validates live behavior before
the GM_Tools item/creature push producers ship, and settles one open
question (step 7).

## Procedure (GM console in any dnd5e world with Plutonium enabled — the
`wf-test-5e` world works; ~30 minutes; record outputs below)

```js
// 1. API present?
const api = game.modules.get("plutonium")?.api;
console.log(!!api, Object.keys(api?.importer ?? {}));

// 2. Item importer obtainable without UI?
const imp = await api.importer.pGetImporter({ prop: "item" });
console.log(!!imp);

// 3. Import a stock item from the raw data.
const json = await (await fetch("modules/plutonium/data/items.json")).json();
const entry = json.item.find(i => i.name === "Bag of Holding");
const summary = await imp.pImportEntry(entry, new api.importer.ImportOpts({}));

// 4. Real world Item with sane dnd5e system data?
const doc = summary.getPrimaryDocument();
console.log(doc?.uuid, doc?.system?.rarity, doc?.system?.uses);

// 5. Actor-targeted: lands in an inventory?
const actor = game.actors.contents[0];
const s5 = await imp.pImportEntry(entry, new api.importer.ImportOpts({ actor }));
console.log(s5.getPrimaryDocument()?.parent?.uuid === actor.uuid);

// 6. Creature path.
const bj = await (await fetch("modules/plutonium/data/bestiary/bestiary-mm.json")).json();
const mon = bj.monster.find(m => m.name === "Goblin");
const s6 = await api.importer.creature.pImportEntry(mon, {});
console.log(s6.getPrimaryDocument()?.uuid);

// 7. SYNTHETIC minimal entry — decides whether hand-authored GM_Tools
// items can ride import_via_plutonium, or only create_item.
const s7 = await imp.pImportEntry(
  { name: "Ashvane Signet", source: "GMTOOLS", rarity: "rare", entries: ["A ring of office."] },
  new api.importer.ImportOpts({})
);
console.log(s7.getPrimaryDocument()?.uuid ?? `status: ${s7.status}`);

// 8. A _copy shell creature — EXPECTED to fail; confirms the
// "non-_copy rows only" pushability rule GM_Tools enforces.
const shell = bj.monster.find(m => m._copy) ?? { name: "x", _copy: { name: "Goblin", source: "MM" } };
try { console.log((await api.importer.creature.pImportEntry(shell, {}))?.getPrimaryDocument()?.uuid); }
catch (e) { console.log("copy-shell failed as expected:", e.message); }
```

## Decision gate

- Steps 1–4 green → `import_via_plutonium` is the fidelity path for stock
  items; 6 green → and for stat blocks. (Both expected, given the static
  read.)
- Step 7 green → hand-authored items MAY ride the same op; red →
  hand-authored push uses `create_item` only (the current GM_Tools
  producer default — safe either way).
- Everything red (not expected) → producers fall back to `create_item`
  for items; stat blocks stay a manual Plutonium act (the pre-wave
  status quo).

## Evidence

_(paste console outputs + Plutonium version here when run)_
