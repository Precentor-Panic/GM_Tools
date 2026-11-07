# map-plan: the map format, a map's character, and the shelf

Plan and status: `plans/map-quality-plan.md`.

- **A plan** (`plan.mjs`) is a battle map as geometry: areas, walls, doors, lights, marks and items, in squares. Art is
  an optional layer under it. Readers (`readers.mjs`) take a Dungeondraft `.dd2vtt` export or a Foundry scene document.
- **A profile** (`profile.mjs`) is the plan's character, computed from its walls: size, rooms and their size bands,
  buildings, the room graph, how square or organic the walls are, openness, features, items.
- **Theme and contents** (`vocab.json`, `theme.mjs`) come from words: names, briefs, the names of placed objects.
- **The picture** (`tools/look.py`, `look.mjs`), when the art is on this machine: what each room seems to hold, the
  map's likely place and terrain, and an embedding a description can be matched against. A hint, scored by rank.
- **The shelf** (`shelf.mjs`) groups variants into layouts, writes a character card in words, and answers a brief
  (`bench/briefs.json`) by shape, theme, contents and picture, with what matched. Theme also gates the fit.
- **The makers** (`makers/`) make plans from a recipe and a seed, deterministically:
  - `canvas.mjs` is the drawing surface: rooms, open ground and solid masses painted onto a grid of 8 cells per
    square. Straight and round shapes leave guides (their exact outlines).
  - `trace.mjs` turns the grid into walls and floor outlines. Each boundary is simplified once, so neighbours share
    it exactly. Masonry snaps back onto its guides; rough edges (cave rock, rubble) are smoothed. Links cut doors,
    arches and windows into straight stretches, edge overrides make a boundary a ledge or leave it open, and every
    wall gets a material.
  - `build.mjs` is the masonry kit the recipes use (rooms, links, furniture placement that keeps doors clear).
    `wear.mjs` breaches, fells and crumbles masonry, and `transform.mjs` turns and mirrors a finished plan.
  - Recipes: `tavern.mjs`, `temple.mjs`, `fort.mjs` (with wear), `sewer.mjs`, and `cave.mjs` (chambers and passages
    carved from rock, with a river, ledges, pillars and dressing). `index.mjs` names them.
- **Writers** (`writers.mjs`): a plan to Universal VTT for Foundry, walls from the plan itself.

## Commands

```
bin/map-profile --scenes <dir with **/scenes.json> --out stagecraft/map-shelf/profiles.jsonl --look-job stagecraft/map-shelf/look-job.jsonl
bin/map-profile --modules <Foundry Data dir> --match '<module regex>' --out stagecraft/map-shelf/modules.jsonl --look-job stagecraft/map-shelf/look-job-modules.jsonl
bin/map-profile <map.dd2vtt>=<layout.json>... --out stagecraft/map-shelf/ours.jsonl --look-job stagecraft/map-shelf/look-job-ours.jsonl
<python> map-plan/tools/look.py index <look-job.jsonl> <look*.jsonl>      # look.jsonl, look-modules.jsonl, look-ours.jsonl
<python> map-plan/tools/look.py thumbs <look-job.jsonl> stagecraft/map-shelf/thumbs
bin/map-shelf brief <id>|all     bin/map-shelf like <map id>|<plan.json>     bin/map-shelf text "<description>"
bin/map-shelf card <map id>      bin/map-shelf html                         # then open stagecraft/map-shelf/shelf.html
bin/map-make <recipe> --seed N [--out plan.json] [--svg preview.svg] [--brief <id>]   # tavern, temple, fort, sewer, cave
```

A picture of a made plan comes from a renderer outside this repo: the Dungeondraft tooling compiles a plan to a
layout spec (floors, explicit walls, doors, ground, water, caves, objects by a theme that names asset-pack files) and
builds it. Keeping the asset names there keeps third-party pack names out of this public repo.

LevelDB module packs need Foundry's own `classic-level`: set `FOUNDRY_MAIN` (or `CLASSIC_LEVEL_NODE_MODULES`).

## The picture model (optional)

`look.py` needs a Python with `torch`, `open_clip_torch` and `pillow`. CPU is enough: ViT-B-32 reads about 20 maps a
minute on a laptop. Install torch and torchvision from the CPU index (`https://download.pytorch.org/whl/cpu`), or the
two won't match. Point `bin/map-shelf` at it with `--python` or `MAP_LOOK_PYTHON`. Every map on one shelf must be read
with the same model, because scores are relative to the whole shelf.

## Other people's IP

This repo is public. Profiles, picture numbers, thumbnails, wall drawings and the shelf page made from published maps
are derived from someone else's product: they live under `stagecraft/` (ignored), never in a tracked file.
`bin/map-profile` refuses a tracked `--out`. Test fixtures are synthetic. Run `bin/ip-check` before committing and
`bin/ip-check --push` before pushing.
