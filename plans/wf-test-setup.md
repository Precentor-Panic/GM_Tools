# wf-test-5e Foundry test bed — 5e module set + content bed for the GM_Tools ↔ Foundry bridge

Setup pass on the local Foundry VTT install (v14.363, `http://localhost:30000`,
dataPath `/home/russell/foundrydata`) to give the GM_Tools ↔ Foundry document bridge
(Phase 32, `plans/phase-32-bridge-contract.md`) a real D&D 5e content bed to pull from.

**Date:** 2026-08-08. **Edition target:** D&D 5e **2014 / SRD 5.1 (legacy)** — NOT the 2024 revision.
**Status: COMPLETE.** Content bed built in a fresh dnd5e world `wf-test-5e`; index rich; pull proven live.

---

## TL;DR / status

| Step | Status |
|---|---|
| Research community 5e module set | ✅ done |
| Inventory the install | ✅ done |
| Install QoL staple modules | ✅ done (3 modules, v14-verified) |
| Repair the `world-fabric` module install | ✅ done (dangling symlink → repointed to repo) |
| Create fresh dnd5e world `wf-test-5e` (Option B) | ✅ done |
| Enable modules + set 2014 rules | ✅ done |
| Import dnd5e 2014/SRD WORLD content | ✅ done (15 monsters, 3 PCs, 10 items, user, 2 scenes+tokens) |
| Reindex + verify index richness | ✅ done |
| Prove the pull (connection live + proposals) | ✅ done |

### Why a NEW world (not `wf-test`)
`wf-test` runs the **`worldbuilding`** system and is Russell's live World Fabric graph world
(6 worldbuilding actors + an active graph bridge). dnd5e Actors can't live there, so per
Russell's decision (**Option B**) a fresh dnd5e world **`wf-test-5e`** was created as the
content bed. `wf-test` and `rl-combat` were left untouched.

### Active-world before/after
- **Before:** `wf-test` (worldbuilding) active.
- **After:** **`wf-test-5e` (dnd5e) left active** (as instructed). The server was restarted
  onto `--world=wf-test-5e` by Russell/coordinator (the agent's own restart was blocked by
  the Claude Code auto-mode permission classifier).

---

## 1. Chosen module set (community-consensus, v14 + dnd5e-5.3.3 compat-checked)

### (a) Content — SRD-legal 2014 D&D 5e (no third-party module)
The legally-clean 2014 content is the **dnd5e system's own SRD compendia** (system 5.3.3,
ships both 2014 and 2024 rule sets). Imported from the **non-`24` packs** only:

| Pack id | Label | Used for |
|---|---|---|
| `dnd5e.monsters` | Monsters (SRD) | 15 monster actors |
| `dnd5e.items` | Items (SRD) | 10 world items |
| `dnd5e.heroes` | Starter Heroes | 3 PC actors |

The `*24` packs (`monsters24`, `items24`, …) are the **2024 revision — not touched**. World
set to legacy rules: `game.settings.set("dnd5e","rulesVersion","legacy")` (verified `="legacy"`).

### (b) QoL staples — installed & enabled
Downloaded by manifest into `/home/russell/foundrydata/Data/modules/<id>/`, all v14-verified,
all enabled for `wf-test-5e` and confirmed `active:true`:

| Module | Version | compat.verified | Why | Manifest |
|---|---|---|---|---|
| `lib-wrapper` | 1.13.5.1 | 14 | Base shim most 5e modules require | https://github.com/ruipin/fvtt-lib-wrapper/releases/latest/download/module.json |
| `socketlib` | v1.1.4 (farling42 fork) | 14 | Standard multi-client socket dependency | https://github.com/farling42/foundryvtt-socketlib/releases/latest/download/module.json |
| `dice-so-nice` | 6.2.9 | 14.365 | Consensus 3D dice | https://gitlab.com/riccisi/foundryvtt-dice-so-nice/-/raw/master/module/module.json |

Not installed: heavier automation (Midi-QoL, Ready-Set-Roll, DFreds) — not needed to
exercise the bridge; they build on the three above. (Corroborated by community "essential
modules" lists, which consistently name lib-wrapper / socketlib / Dice So Nice as the base.)

---

## 2. Inventory findings

- **Foundry:** v14.363, node 24, `--dataPath=/home/russell/foundrydata --port=30000`.
- **Data dir:** `/home/russell/foundrydata/Data`. GM_Tools auto-resolves this (`.env` has no
  `WF_DATA_DIR`; `data-dir.mjs` falls back to `~/foundrydata/Data`). No `.env` change needed.
- **Systems:** `dnd5e` 5.3.3, `worldbuilding` 0.8.2.
- **Worlds:** `wf-test` (worldbuilding — untouched), `rl-combat` (dnd5e — untouched),
  **`wf-test-5e` (dnd5e — created here)**.
- **`world-fabric` install:** was a **dangling symlink**
  `Data/modules/world-fabric → /home/russell/foundry_worldFabric` (a path that no longer
  exists; repo moved to `/opt/dev/foundry_worldFabric`). The running server had only a stale
  pre-Phase-32 copy with an empty `api`.

---

## 3. What was changed (Foundry data dir only — no repo edits)

- **Installed modules:** `Data/modules/{lib-wrapper,socketlib,dice-so-nice}/`.
- **Repaired the `world-fabric` symlink:**
  `ln -sfn /opt/dev/foundry_worldFabric /home/russell/foundrydata/Data/modules/world-fabric`
  (repo HEAD `da0f249`, carries `scripts/data/foundry-bridge.mjs` + `api.reindexForGmTools`).
  It is a **symlink to the repo**, so it tracks the repo automatically; new module code loads
  on a world relaunch.
- **Created world:** `Data/worlds/wf-test-5e/world.json` (dnd5e 5.3.3, modeled on `rl-combat`).
- **First live validation of the Phase-32 bridge:** on relaunch onto `wf-test-5e`, after
  enabling `world-fabric`, `game.modules.get("world-fabric").api.reindexForGmTools` is a
  **function** — the repaired symlink loads the current bridge correctly.

---

## 4. Content imported (2014/SRD packs only)

**15 monsters** (CR 1/8 → 17), incl. **3 with legendary actions** (Aboleth, Vampire, Adult
Red Dragon) and inventory carriers (Gladiator 8 items, Knight 7, Vampire 15):

| CR | Monsters |
|---|---|
| 1/8–1/2 | Kobold, Goblin, Wolf, Hobgoblin |
| 1–3 | Bugbear, Ogre, Owlbear, Knight |
| 5–8 | Gladiator, Troll, Mage, Frost Giant |
| 10–17 | Aboleth (leg.), Vampire (leg.), Adult Red Dragon (leg.) |

**3 PC actors** from `dnd5e.heroes`: Randal (Human Fighter), Zanna (Gnome Wizard),
Krusk (Half-Orc Paladin) — each with class item + inventory.
**Player user** "Player One" (role PLAYER) with `user.character` = Randal (`Actor.2Pdtnswo8Nj2nafY`)
and OWNER ownership on Randal.
**10 items** into world Items: Longsword, Dagger, Greataxe, Chain Mail, Shield, Leather
Armor, Potion of Healing, Rope of Climbing, Torch, Ring of Invisibility.
**2 scenes** with real backgrounds + 4 placed monster tokens each:
- *Ironhold Approach* — bg `nue/defaultscene/fvtt-background.webp` (core-shipped), tokens: Kobold, Goblin, Wolf, Hobgoblin.
- *Dragon's Lair* — bg `systems/dnd5e/ui/official/dnd5e-background.webp` (dnd5e-shipped), tokens: Bugbear, Ogre, Owlbear, Knight.
- (plus the auto-created default scene *Foundry Virtual Tabletop*, 0 tokens.)

### v14 gotcha (worth recording)
In **Foundry v14, `Scene#background` is deprecated** ("Use `Level#background`/`Level#textures`").
Setting `scene.background.src` on create/update is silently ignored — the background now lives
on the scene's embedded **Level** doc (`defaultLevel0000`). Fix used:
`scene.updateEmbeddedDocuments("Level",[{_id:"defaultLevel0000","background.src":<path>}])`.
The deprecated `scene.background.src` **getter still reflects** the Level background (back-compat),
so the bridge module's `extractScene` (which reads `scene.background?.src`) correctly emits it —
verified below. No module change was needed.

---

## 5. Index verification (`worlds/wf-test-5e/world-fabric-foundry-index.json`, 518 KB)

`version:1`, `worldId:"wf-test-5e"`, fresh `exportedAt`. 18 actors, 2 users, 3 scenes,
8 flat tokens. Quoted samples:

**Monster (legendary + items):**
```json
{ "uuid": "Actor.ZyIBOoZZD0nDaO2s", "name": "Adult Red Dragon", "type": "npc",
  "system": { "hp": {"value":256,"max":256}, "ac": 19, "cr": 17 },
  "items": [ {"name":"Legendary Resistance","type":"feat"}, {"name":"Multiattack","type":"feat"},
             {"name":"Frightful Presence","type":"feat"}, {"name":"Fire Breath","type":"feat"}, … (11) ] }
```
**User with characterUuid:**
```json
{ "id":"29YQuWkR9z9249Hx", "name":"Player One", "role":1, "characterUuid":"Actor.2Pdtnswo8Nj2nafY" }
```
**Scene with background + tokens:**
```json
{ "name":"Ironhold Approach", "background": {"src":"nue/defaultscene/fvtt-background.webp"},
  "grid": {"size":100,"distance":5,"units":"ft"},
  "tokens": [ {"name":"Kobold","x":400,"y":400,"actorUuid":"Scene.sGF….Actor.5ngb…"}, … (4) ] }
```
**PC:** Randal — `type:"character"`, `level:1`, `hp {12,12}`, `ac 19`, class item "Fighter", 27 items.

---

## 6. Pull result (proven live; proposals left UNACCEPTED)

In-process `createReviewServer({port:0})`, no `WF_DATA_DIR` (fallback `~/foundrydata/Data`):

- `GET /api/foundry/connection?world=wf-test-5e` → **`{state:"live", counts:{actors:18, scenes:3, items:0, journals:0}}`**
  (index-contract has no top-level items/journals arrays yet → 0 by design).
- `POST /api/foundry/pull-actors {world:"wf-test-5e"}` → `indexFound:true`, and
  (with the Phase-35 expanded pull that landed concurrently):
  - **bestiaryProposed: 15** (the 15 monsters; matched to Foundry by `foundryActorRef`)
  - **partyProposed: 3** (Krusk, Randal, Zanna)
  - **itemsProposed: 47** (Phase-35 item ingest — from actor inventories + world items)
  - **scenesProposed / stagecraftProposed** (Phase-35 scene/stagecraft ingest) + **tokensSynced** [4,0,4]
  - `alreadyLinked:{bestiary:[],party:[],items:[]}`, `skippedActors:0`.
  All entries are **`status:"proposed"`** — nothing accepted (left for Russell's Library review).

### Store files created (all in `/opt/dev/GM_Tools/`)
- `bestiary/` — **15 new** `bst_mskohjy*/bst_mskohjz*.json` (added to 5 pre-existing; `bestiary/*` gitignored).
- `party-roster/wf-test-5e.json` — 3 PC entries (new; `party-roster/*` gitignored).
- (Phase-35 stores also written by the concurrent expanded pull: `items/wf-test-5e.json`,
  `stagecraft/wf-test-5e.json`, `tokens/wf-test-5e.json`, `session-scenes/…` — those belong
  to the concurrent Phase-35 work, noted for completeness.)

To clean up later: delete the 15 new `bestiary/bst_msko*.json`, `party-roster/wf-test-5e.json`
(and, if desired, the Phase-35 `wf-test-5e.json` store files), or accept/reject them in Library.

---

## 7. How `world-fabric`-in-Foundry stays current
Symlink to the repo (`/opt/dev/foundry_worldFabric`) — tracks the repo automatically; a world
relaunch loads new module code. No copy/rsync step.

## 8. Notes / honesty
- The one disruptive action (server restart to switch active world) was blocked for the agent
  by the Claude Code auto-mode permission classifier; Russell/coordinator performed it. All
  other steps ran headlessly (playwright → GM → `page.evaluate` with `game.*`).
- Concurrent Phase-35 work was modifying GM_Tools pull code/stores during this pass; the pull
  response therefore carries extra keys (itemsProposed/stagecraftProposed/tokensSynced). The
  connection=live + rich index are the load-bearing proof; the orchestrator re-proves the full
  pull at 35.4.
- `wf-test-5e` left active per instruction.
