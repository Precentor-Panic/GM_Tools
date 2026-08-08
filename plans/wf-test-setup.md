# wf-test Foundry test bed — 5e module set + content bed for the GM_Tools ↔ Foundry bridge

Setup pass on the local Foundry VTT install (v14.363, `http://localhost:30000`,
dataPath `/home/russell/foundrydata`) to give the GM_Tools ↔ Foundry document bridge
(Phase 32, `plans/phase-32-bridge-contract.md`) a real D&D 5e content bed to pull from.

**Date:** 2026-08-08. **Edition target:** D&D 5e **2014 / SRD 5.1 (legacy)** — NOT the 2024 revision.

---

## TL;DR / status

| Step | Status |
|---|---|
| Research community 5e module set | ✅ done |
| Inventory the install | ✅ done |
| Install QoL staple modules | ✅ done (3 modules, v14-verified) |
| Repair the `world-fabric` module install | ✅ done (dangling symlink → repointed to repo) |
| Populate wf-test with dnd5e WORLD content | ⛔ **BLOCKED** — see "Critical blocker" |
| Prove the pull with real content | ⚠️ **plumbing proven; content pull blocked** |

### Critical blocker (read this first)

**`wf-test` is not a D&D 5e world.** Its `world.json` runs the **`worldbuilding`**
system (Simple World-Building 0.8.2), and it is Russell's **live World Fabric graph
world** — 6 worldbuilding actors (Garrik Halvar, Kael, Patron1, Pickle, Quest Giver,
Shopkeep), 4 scenes (Ironveil Keep, The Crusty Barnacle, The Pleasure Palace, default),
2 users (Gamemaster; Observer→Kael), and an **active graph bridge** still writing
`world-fabric-snapshot.json` / `world-fabric-mutations.json`.

dnd5e Actors/Items **cannot exist in a `worldbuilding` world** — the actor types
(`npc`/`character`) and the `system.attributes.hp/ac`, `system.details.cr` shapes the
bridge index reads are dnd5e-system schema. So the "import ~15 monsters + items + PCs +
scenes with tokens" step **cannot be done in `wf-test`** without converting its system,
which would orphan its existing worldbuilding content and break the graph bridge that
Russell's primary project depends on. **I did not do that** — it's a destructive,
Russell-only decision.

The real dnd5e world on this install is **`rl-combat`** (dnd5e 5.3.3), which the repo's
own `foundry_worldFabric/setup-test.mjs` already targets. See "Decision needed" below.

---

## 1. Chosen module set (community-consensus, v14 + dnd5e-5.3.3 compat-checked)

### (a) Content — SRD-legal 2014 D&D 5e

**No third-party content module was installed.** The legally-clean 2014 content is
already on disk: the **dnd5e system's own SRD compendia** (system 5.3.3, ships both
2014 and 2024 rule sets). Import from the **non-`24` packs** (the 2014 / SRD-5.1 set):

| Pack id | Label | Use |
|---|---|---|
| `dnd5e.monsters` | Monsters (SRD) | monster actors (CR spread, legendary/items) |
| `dnd5e.items` | Items (SRD) | weapons / wondrous / consumables |
| `dnd5e.spells` | Spells (SRD) | spell items |
| `dnd5e.classes` | Classes (SRD) | PC class items |
| `dnd5e.heroes` | Starter Heroes | ready-made PC actors |

The `*24` packs (`monsters24`, `spells24`, `items24`, `classes24`, `content24`, …) are
the **2024 revision — do NOT import from these** for a 2014 bed. Set the world's rules
version to legacy: `game.settings.set("dnd5e", "rulesVersion", "legacy")` (dnd5e 5.3.3
exposes `rulesVersion` with a `"legacy"`/modern toggle — verified in the installed
system code). Scene backgrounds can use Foundry-shipped / dnd5e-shipped assets, so no
map-pack module is required (avoids any license ambiguity).

### (b) QoL staples — installed

Downloaded by manifest and unzipped into `/home/russell/foundrydata/Data/modules/<id>/`.
All three are system-agnostic (usable in any world) and are the near-universal community
foundation. Compatibility read from each `module.json`:

| Module | Version | compat.verified | Why | Manifest |
|---|---|---|---|---|
| `lib-wrapper` | 1.13.5.1 | 14 | Foundational shim required by most 5e QoL modules; the single most-recommended base module | https://github.com/ruipin/fvtt-lib-wrapper/releases/latest/download/module.json |
| `socketlib` | v1.1.4 (farling42 fork) | 14 | Standard multi-client socket helper; dependency of many 5e automation modules | https://github.com/farling42/foundryvtt-socketlib/releases/latest/download/module.json |
| `dice-so-nice` | 6.2.9 | 14.365 | Community-consensus 3D dice; the most-cited "essential" QoL pick | https://gitlab.com/riccisi/foundryvtt-dice-so-nice/-/raw/master/module/module.json |

Intentionally NOT installed: heavier automation (Midi-QoL, Ready-Set-Roll, DFreds
Convenient Effects, Times-Up) — they only matter inside a live dnd5e world and add
config/compat surface not needed to exercise the bridge. Add later if wanted; they build
on the three above. (Research corroborated by community "essential modules" lists —
Roger's Hobby Center 2024 guide, r/FoundryVTT threads — which consistently name
lib-wrapper, socketlib, and Dice So Nice as the base layer.)

---

## 2. Inventory findings

- **Foundry:** running (PID 1119073), v14.363, node 24, launched
  `cd /home/russell/foundryvtt && node main.js --dataPath=/home/russell/foundrydata --port=30000 --world=wf-test`.
  A stable update to 14.365 is available (not applied).
- **Data dir:** `/home/russell/foundrydata/Data`. GM_Tools resolves this automatically —
  `.env` has **no** `WF_DATA_DIR`, and `wf-mcp-server/lib/data-dir.mjs` falls back to
  `~/foundrydata/Data`, which is correct. No `.env` change needed.
- **Systems:** `dnd5e` 5.3.3 (compat min 13.347 / verified 14), `worldbuilding` 0.8.2.
- **Worlds:** `wf-test` (**worldbuilding** — the active one), `rl-combat` (**dnd5e 5.3.3**).
- **`wf-test` content (via headless client):** 6 actors, 4 scenes (3 with placed tokens,
  none with a real background image), 0 items, 0 journals, 2 users, 1 folder.
- **Modules before:** `world-fabric` (symlink), `pinned-cards` (inactive). `world-fabric`
  showed `active:true` but **`api` was empty** in the running session.
- **How `world-fabric` was installed:** a **symlink**
  `Data/modules/world-fabric → /home/russell/foundry_worldFabric`, but that target **no
  longer exists** (the repo was moved to `/opt/dev/foundry_worldFabric`). So the symlink
  was **dangling** — the running server had only the stale pre-Phase-32 module cached from
  its Jul-22 startup (hence no `api.reindexForGmTools`, no `foundry-bridge.mjs`).

---

## 3. What was installed / changed (all inside the Foundry data dir only)

- **Installed modules** (new dirs): `Data/modules/lib-wrapper/`, `Data/modules/socketlib/`,
  `Data/modules/dice-so-nice/`.
- **Repaired the `world-fabric` symlink:**
  `Data/modules/world-fabric` now points to `/opt/dev/foundry_worldFabric` (the current
  repo, HEAD `da0f249`), which contains `scripts/data/foundry-bridge.mjs` and wires
  `game.modules.get("world-fabric").api.reindexForGmTools()`
  (`scripts/module.mjs:180`). Command used:
  ```
  ln -sfn /opt/dev/foundry_worldFabric /home/russell/foundrydata/Data/modules/world-fabric
  ```
- **No other world touched.** `rl-combat` and every other data dir untouched. Neither git
  repo was modified (both verified with `git status --short`).

### How `world-fabric`-in-Foundry is kept current

It is a **symlink to the repo**, so it tracks the repo automatically — no rsync/copy step
needed. To pick up new module code, Foundry must **re-scan modules**, which happens on a
**world relaunch** (return to Setup and launch the world, or restart the server).
The current running session still holds the stale copy in memory; **a relaunch is
required** before `api.reindexForGmTools` is available live.

---

## 4. Index verification & pull result

- **Index:** could **not** produce a real dnd5e `world-fabric-foundry-index.json` this
  session — blocked (wf-test is worldbuilding; no dnd5e world was populated). No index
  file exists in `worlds/wf-test/` yet.
- **Pull plumbing — PROVEN (safe, non-destructive).** In-process `createReviewServer({port:0})`
  against the real data dir, world `wf-test`:
  - `GET /api/foundry/connection?world=wf-test` → `200 {state:"off", exportedAt:null, counts:null, world:"wf-test"}`
  - `POST /api/foundry/pull-actors {world:"wf-test"}` → `200 {indexFound:false, bestiaryProposed:[], partyProposed:[], alreadyLinked:{bestiary:[],party:[]}, skippedActors:[]}`

  This confirms the consumer side is fully wired: it resolves `~/foundrydata/Data`, reads
  `worlds/wf-test/`, and honestly reports "no index yet" without error. **No proposals
  were written to any store** (nothing to propose). The only missing piece is a dnd5e
  world producing an index. When one does, `pull-actors` will write `proposed` records
  into GM_Tools' `bestiary/` and `party-roster/` stores (left for Library review — do not
  auto-accept).

---

## 5. Decision needed + manual steps for Russell

The remaining work (import dnd5e content, reindex, pull real content) needs a **dnd5e
world**. Pick one:

- **Option A (recommended): use `rl-combat`** — it already runs dnd5e 5.3.3 and is what
  the repo's `setup-test.mjs` targets. Non-destructive to `wf-test`. GM_Tools pull takes
  `{world}`, so target `rl-combat`.
- **Option B: create a fresh `wf-test-5e` dnd5e world** — cleanest separation; keeps the
  name close. Requires activating it (deactivates the `wf-test` graph session).
- **Option C: convert `wf-test` to dnd5e** — **NOT recommended**; destroys its
  worldbuilding content and breaks the World Fabric graph bridge.

Whichever world (call it `<W>`), the steps are:

1. **Relaunch Foundry / the world** so the repaired `world-fabric` module (with the
   Phase-32 bridge) loads. Confirm in console:
   `game.modules.get("world-fabric").api.reindexForGmTools` is a function.
2. **Enable modules for `<W>`** (Manage Modules): `world-fabric`, and optionally
   `lib-wrapper`, `socketlib`, `dice-so-nice`.
3. **Set 2014 rules:** `game.settings.set("dnd5e","rulesVersion","legacy")`.
4. **Import content from the 2014 SRD packs** (`dnd5e.monsters`, `.items`, `.spells`,
   `.heroes`) into the WORLD — ~12–20 monsters across CR 1/4→10+ (include legendary +
   inventory-carrying ones), ~10 items, 2–3 `character` PCs, a player user with
   `user.character`, and 2 scenes with a real background + tokens placed via
   `scene.createEmbeddedDocuments("Token", …)` from each actor's prototypeToken.
5. **Reindex:** `game.modules.get("world-fabric").api.reindexForGmTools()`. Verify
   `worlds/<W>/world-fabric-foundry-index.json` is fresh and rich (actors carry
   `system.hp/ac/cr` + `items[]`; users carry `characterUuid`; scenes carry
   `background.src` + token summaries).
6. **Pull:** `POST /api/foundry/pull-actors {world:"<W>"}` (or the in-process proof script
   at `scratchpad/wf-test-setup/pull-proof.mjs`). Expect non-empty
   `bestiaryProposed`/`partyProposed`. **Do not accept** — leave `proposed` for Library
   review. Note that this writes into the real `bestiary/` and `party-roster/` stores.

A ready-to-run headless populate script can be built on the repo's
`foundry_worldFabric/setup-test.mjs` pattern (playwright → `/join` → Gamemaster →
`waitForFunction(game.ready)` → `page.evaluate` with `game.*`), parameterized by world.

### What could NOT be done headlessly this session

- Import/populate + real pull — blocked on the world-system decision above.
- Loading the repaired module live — the running server needs a relaunch (I did not stop
  the running instance, per the "prefer not to stop a running instance" rule).
