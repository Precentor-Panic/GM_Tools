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

## Producer live smoke (run with the spike)

**Status: NOT RUN** — same reason as the spike above (no live Foundry
client in the build environment, 2026-09-03). This section is the
end-to-end smoke for the workstream B2 (G7/G8) producers built on top of
the spike's verified API surface — `wf-mcp-server/lib/foundry-item-push-
ops.mjs`'s `pushItemToFoundry`/`pushBestiaryEntryToFoundry`, and their two
HTTP routes (`POST /api/foundry/push-item`, `POST /api/foundry/push-
bestiary-entry`). Everything below this line is DOCUMENTED, not executed —
run it against `wf-test-5e` (or any dnd5e world with Plutonium enabled)
alongside the spike's own procedure.

### Setup

1. Start `review-ui`'s server (`node review-ui/server.mjs`, or however the
   live session normally launches it) pointed at the SAME `WF_DATA_DIR` the
   target Foundry world reads/writes.
2. Open the target world in a live Foundry client with Plutonium enabled and
   the World Fabric ops-channel watcher active (same precondition
   `push-scene`'s own live smoke already requires).
3. In the Library's Reliquary tab, use the "Available via Plutonium" shelf
   (G6) to add a REAL stock item (e.g. "Bag of Holding", DMG) onto the
   curated shelf — confirms `sourceText` really does stamp `"DMG p155 via
   Plutonium"` against the real bundled dataset, not a fixture.

### Case 1 — Plutonium-sourced item, no overrides

4. Click "Push to Foundry" on the added row.
5. **Expect**: within a few seconds (one Foundry watcher tick), the row's
   button is replaced by the quiet "in Foundry" pill; the new World Item
   appears in Foundry's own Items sidebar with a real dnd5e `system` payload
   (rarity/weight/etc. populated by Plutonium's own conversion, not
   GM_Tools's).
6. Confirm `combat-planning/items/<world>.json`'s matching row now carries a
   real `foundryItemRef` (an `Item.<id>` uuid), and that the Foundry item's
   `_stats`/flags show it came through Plutonium's importer (not a bare
   `Item.create`).

### Case 2 — the lostech two-op flow

7. Add a second stock item with real charges (e.g. "Wand of Magic Missiles",
   or any item with `system.uses` after import) to the shelf.
8. Open its "lostech…" toggle, set `usesValue: 1`, `usesMax: 1`, leave
   "recharges on rest" UNCHECKED, save.
9. Click "Push to Foundry".
10. **Expect**: TWO visible Foundry-side effects in sequence — the item is
    created (Plutonium's own conversion), then its `system.uses` is patched
    down to `{value:1, max:1, recovery:[]}`. Confirm in Foundry's own item
    sheet that Uses reads 1/1 and the Recovery dropdown shows no configured
    recovery (non-recharging) — the scarcity actually took.
11. Repeat with "recharges on rest" CHECKED instead: **expect** the update
    patch carries no `recovery` key at all, so whatever recovery profile
    Plutonium's own conversion assigned survives untouched (open the item
    sheet and confirm Recovery still shows Plutonium's own configured
    value, not cleared).

### Case 3 — hand-authored item

12. Use the Reliquary's "or write one by hand" form to add a plain item
    with a description, no Plutonium provenance.
13. Push it. **Expect**: a real Foundry Item appears with the GM_Tools-
    composed `system.description.value` (the plain-text description
    wrapped in `<p>…</p>`) and no activities/spell effects — confirms the
    fidelity boundary holds against a real dnd5e sheet, not just the ops
    JSON shape.

### Case 4 — actorUuid (into an actor's inventory)

14. With a party member in the world that already has a `foundryActorRef`
    (pulled via `pull-actors`/`sync-now`), push a Reliquary item using the
    row's "→ into `<name>`'s inventory" option.
15. **Expect**: the item appears directly in that actor's own sheet
    inventory, NOT in the world Items sidebar.

### Case 5 — curated Bestiary push

16. On the Bestiary tab, add a real creature from "Available via Plutonium"
    onto the curated shelf, then click its "Import to Foundry" button.
17. **Expect**: a real Actor document appears (Plutonium's creature
    importer), the curated entry's `foundryActorRef` is set, and — the
    load-bearing cross-check — that entry now shows up as a droppable
    token option in a scene's tray roster (composeSceneOps' own token-
    eligibility scan reads the SAME `foundryActorRef` field this push
    writes).

### Case 6 — best-effort failure framing

18. Disable Plutonium (or point at a world without it) and attempt a push.
    **Expect**: a clean per-op failure surfaced as `ok:false` with an honest
    error (naming Plutonium/the API as missing), NOT a thrown 500 — matches
    `import_via_plutonium`'s own "best-effort" contract.

Record real console/network output + Plutonium version here once this is
actually run.
