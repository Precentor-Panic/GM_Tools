# Map recombination + Dungeondraft — plan and state

Last updated 2026-10-27. This file is the durable record of the mapping-tool plan. Each sprint ends with a review page for the GM, and the next sprint starts only after the GM answers.

## The goal

Cobble together unique maps from existing map art for a better player experience. Sources are:

- whole Czepeku maps as they are (no cutting), and
- blocks made in Dungeondraft.

Scenes come from the session planner. The map tool only lays maps into a scene. It never creates scenes, and never recreates a pushed one. It re-lays in place through `set_scene_layout`.

Maps must carry **walls**, because Foundry lighting and vision need them. They should also carry doors and lights.

## Where things stand

| Piece | State |
|---|---|
| Segment schemas, assembler, clash checks (`map-segments/`) | Built. Segment v2, composition v1, `clash.mjs` warns and never blocks. |
| `bin/scene-layout` + bridge op `set_scene_layout` | Built and used live. |
| Puzzle panel (jug locks) in the module | Built and used live. |
| Sprint 1 (tags + clash checks) | Done, commit e3eba9f. |
| Sprint 2 (cut screen + wall tracing) | **On hold** until automatic wall detection works (GM's call: "fully automatic, no fixing"). |
| Sprints 3–7 (first kit, composer, layout engine, push form, second kit) | Not started. |
| Wall detection research | Rounds 1–5 done; round 6 (more training data) running. |
| Dungeondraft bridge (mod + MCP server) | Built and live-tested 2026-10-28: walls, doors, read-back, PNG and UVTT export all work. |

The sprint order stays as agreed:

- **Sprint 3:** the sewer kit on standard sockets.
- **Sprint 4:** the composer (Maps tab in the Library; no rotation; warn, don't block).
- **Sprint 5:** the layout engine. It searches over the kit with no image AI. The engine suggests and the GM picks.
- **Sprint 6:** the push, the puzzle form and dressing tiles.
- **Sprint 7:** a second kit, of city streets and market.

## Track A — automatic walls from painted maps

The work and data live outside this repo, in the local research archive (`.claude-archive/2026-10-26-wall-research/`). Map art never leaves the machine.

**Score.** Sight agreement is the visible-area overlap from 40 viewpoints. 1.0 means the same vision as the pack's own walls. Scoring is leave-one-pack-out, so each test pack is never seen in training. The test packs are sewer, black market and inn.

| Method | Sewer | Black market | Inn |
|---|---|---|---|
| No walls | .14 | .21 | .33 |
| Classical edges + any preprocessing | below "no walls" on two packs | | |
| Segment Anything borders | .28 | .13 | .09 |
| GM labels on SAM pieces, best possible (ceiling) | — | .45 | — |
| ResUNet (ResNet18 encoder pre-trained on ImageNet), 7 packs | .40 | .33 | .34 |
| Same, plus 30 more packs (phase 4) | .40 | .31 | **.45** |
| Same, plus 120 more packs, 2× steps (phase 5) | *running* | | |

**What we learned:**

- The pack walls run down the middle of thick stone walls, and clutter is see-through. No edge or segment border lines up with that, so a trained net is the only route that scales.
- More packs mainly help the test pack least like the training set (inn).
- Training data is cheap. Each pack's scene database plus one map per wall layout is about 27 MB, fetched by partial download from the GM's own pack links. Those links are never stored or logged.

**Decision rule:**

- If phase 5 gains again, fetch the remaining ~240 packs (~6.5 GB, local only) and retrain.
- If it plateaus, the next levers are:
  - the GPU (a GTX 950M; it needs the NVIDIA driver, which the GM installs);
  - a bigger encoder or input size;
  - the Empty-variant difference as a free clutter mask;
  - learning from the GM's fixes in Dungeondraft (Track B).

**Done when** detected walls score close to the pack's own walls on unseen packs, judged on a review page. The bar is the GM's eye, not a number.

## Track B — Dungeondraft as the editor

The GM owns Dungeondraft 1.2.0.1 (Linux). It's unpacked locally in `/opt/dev/dungeondraft/` and not installed system-wide.

**Licence.** The program is never decompiled or redistributed. Mods are fine: the GM reads the licence as being about reselling a competing tool.

**The bridge.** It works like the Foundry bridge: a file queue plus an MCP server.

- **Mod:** `dungeondraft/mods/gm_bridge/` (`gm_bridge.ddmod`, `gm_bridge.gd`). Its job queue is `dungeondraft/bridge/inbox/*.json`, it writes replies to `outbox/`, and it writes `heartbeat.json` every 2 s.
- **Ops:** ping, run (a GDScript snippet), open_map, save_map, export (PNG/JPEG/WEBP/Universal VTT), vtt_data, add_wall, assets.
- **MCP server:** `dungeondraft/mcp/server.mjs`. It's registered as `dungeondraft` and exposes the tools `dd_status`, `dd_open_map`, `dd_save_map`, `dd_render`, `dd_export`, `dd_vtt_data`, `dd_add_wall`, `dd_assets` and `dd_run`. Its test, `mcp/test/fake-mod.test.mjs`, passes against a fake mod.
- **Gotchas:**
  - A tool's `update()` only runs while there's input, so the mod ticks from a Timer.
  - Dungeondraft keeps a mod's script until it quits, so a changed mod needs a restart and then a map load.
  - **No clicks needed (2026-10-28):** Dungeondraft opens a map given on its command line (`Dungeondraft.x86_64 <map>`), and the mod, once enabled in its Mods list, starts with it.
    - The MCP server uses this. Any tool call starts Dungeondraft on its last map when it isn't running, and relaunches it when it's running but silent (start screen, hung or crashed).
    - `dd_restart` does the same on demand. Dungeondraft runs detached, so it outlives the server.
    - Leftover inbox jobs are dropped on launch.
    - "Live" means a fresh heartbeat AND a running process. The heartbeat file stays fresh for up to 10 s after a kill.
    - `Exporter.ExportResolution` reads 0×0 until an image export has run. Take the map size from `World.Width/Height/WorldRect`.
  - One map open from the start screen crashed inside Dungeondraft's own loader (`Editor.DisableMenuButtons`, a null reference) before any mod code ran.

**Next steps, in order:**

1. **Live test. DONE 2026-10-28** against mod v0.1.1 on `maps/test`. What broke and how it's handled:
   - `Exporter.ExportLOS` / `ExportPortals` throw a NullReferenceException when called from a mod. That breaks the mod's `vtt_data` and Dungeondraft's own Universal VTT export, which writes only `<path>.png`.
     - The MCP server now reads walls (`Points`, `Loop`), doors (`Begin`/`End`/`Closed`, via the wall's `get_Portals()`) and lights straight from the level nodes through `run`.
     - It assembles the `.dd2vtt` itself: a PNG export plus that data, with walls split around their doors.
   - `Walls.AddWall` takes 8 arguments: `(points, texture, color, loop, shadow, type, joint, normalizeUV)`. With only 4 it returns a node that never joins the level.
   - `dd_add_door` is new. It puts a door between two points on one wall segment, using `Wall.AddPortal(texture, closed, position, direction, pointIndex, radius, flip)`.
   - Asset categories are case-sensitive (`Walls`, `Objects`, `Portals`). A wrong name throws inside Dungeondraft and returns null.
   - Mod v0.1.2 (fixed `add_wall`, retired `vtt_data`) loads on the next Dungeondraft start. The MCP server doesn't depend on it.
1b. **Map authoring from a layout spec. DONE 2026-10-28.**
   - `dd_build_layout` builds a whole map: rooms in squares, openings, floors, objects sized in squares, lights. `dd_dress` iterates on dressing.
   - The workflow is in skill `/opt/dev/.claude/skills/dungeondraft-maps`, and the reference is `dungeondraft/mcp/README.md`.
   - First real use: the Aureus flood locks rebuilt from its composition. Not pushed to Foundry.
1c. **The rest of Dungeondraft's built-in elements in the layout spec. DONE 2026-10-28.**
   - **Result:** all nine stages are built, plus four extras:
     - doors on a room's outside wall;
     - cave mouths;
     - object tint colours (343 tintable assets found by a pixel scan, marked in the skill's catalogue);
     - doors drawn wall-thick.
   - **Showcase:** `dungeondraft/mcp/examples/showcase.mjs` ("Saltmere", 48×34) uses every element.
   - **Flood locks:** rebuilt with a round landing, the channel and a chain rail (campaign commit 7d3d5fa). Not pushed.
   - **Differences from the plan:**
     - Scripted cave and material strokes never register, so those bitmaps are written into the file.
     - Cave walls are traced into the `.dd2vtt`.
   - The formats and quirks are in the server README.
   - The original plan follows.
   - **Licence:** default assets only. They ship inside the program, and the EULA allows any lawful personal use. Third-party asset packs are separate purchases with their own terms and stay out of scope.
   - **What exists.** Each element is a node on the level, with draw and load calls (probed live 2026-10-28):
     - `WaterMesh`: DrawRect, DrawCircle, DrawPolygon, AddPath.
     - `Pathways`: CreatePath. 47 path textures.
     - `MaterialMeshes`: 12 materials, each a tile texture plus a border texture.
     - `PatternShapes`: DrawRect, DrawCircle, DrawPolygon, AddLayer.
     - `FloorShapes`: DrawCircle and DrawPolygon, beside the DrawRect used today.
     - `CaveMesh`: a bitmap, `colorable` and `rocky` textures.
     - `Terrain`: Paint, Fill, SetPolygonToTerrain, ExpandSlots (up to 8 blended ground textures).
     - `Texts`: CreateText.
     - `Roofs`: CreateRoof. 8 roof textures.
   - **Method, the same for every element:**
     1. Draw a sample by script.
     2. Save, and read the new section of the map JSON, or call the node's own `Save()` if the editor's save drops the sample (scripted objects and lights were dropped).
     3. Pin the JSON shape in `lib/layout.mjs` with a test.
     4. Add the spec field, validation, and a README entry for any quirk found.
     5. Build a sample map live and render it. The element only counts when the reopened map shows it.
   - **Stages, in order of value:**
     1. **Water.** Rectangle, circle and polygon areas, with deep and shallow colours. On the flood locks, use it only for water that never changes, such as the channel. The puzzle's water levels stay as Foundry overlays, because baked-in water couldn't drain.
     2. **Paths.** A texture drawn along a line, with a width: stairs, fences, rails, rope and chain, blood and wagon trails, cliff edges, the wooden bridge.
     3. **Shaped rooms.** Circle and polygon rooms. Interior walls today come from shared grid edges, so a shaped room joins the others only through explicit openings, and its wall is Dungeondraft's outline. This is the round landing on the flood locks.
     4. **Materials.** Area patches: acid, lava, ice, sludge, gold, grass, rock and others.
     5. **Patterns.** Inset areas: a rug, a dais, a mosaic. First find where Dungeondraft keeps its pattern textures; `res://textures/patterns` is empty.
     6. **Ground blending.** Several ground textures per map, painted by area, such as dirt paths through grass.
     7. **Caves.** Irregular cave walls from the cave bitmap.
     8. **Text.** Labels, kept off the players' export by default.
     9. **Roofs.** For town and outdoor maps.
   - **Each stage closes with:**
     - the field added to the guardhouse example, or to a new sample map;
     - `npm test` passing;
     - the skill's assets list and README updated.
   - **The round closes with:**
     - a review page for the GM, with a render of each element;
     - the flood locks rebuilt with water, paths and a round landing.

     Nothing is pushed to Foundry without the GM's OK.
2. **UVTT → segment importer.** Turn a Dungeondraft Universal VTT export (image + walls + doors + lights) into a segment (`segment.json` + variants). Editor-made blocks then enter the library with exact walls and no detection.
3. **Block template.** A standard socket grid for blocks, so Dungeondraft pieces snap to the kit's exits. Doors sit at sockets.
4. **Walls for whole Czepeku maps.**
   - Open the map as Dungeondraft's trace image.
   - Have the net's predicted walls drawn in with `add_wall`, and let the GM correct them in the editor.
   - Export to UVTT. The corrections become training data for Track A.
   - This is a semi-automatic bridge until Track A is good enough on its own.
5. **Composer integration (sprint 4).** The composer can ask Dungeondraft to render or export a block on demand.

## Rules

- This repo stays campaign-agnostic. Campaign compositions live in the campaign repo.
- Czepeku art is processed locally. Nothing goes to a cloud service without the GM's licence call. Pack download links never go in this repo, in logs or in commits.
- Never recreate a pushed Foundry scene. Re-lay in place.
- Every step that needs the GM's input goes to a review page, with buttons and notes read back from its database.
