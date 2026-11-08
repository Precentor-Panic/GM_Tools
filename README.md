# GM_Tools

Tools for preparing and running tabletop sessions on Foundry VTT:

- a campaign knowledge graph, where every LLM-proposed change passes a GM review before it lands;
- a session planner, with a Run view for the table;
- pushing scenes, tokens and items to Foundry;
- a rules lookup over books you own;
- map-plan makers, which turn a recipe and a seed into rooms, walls, doors and lights.

This file covers what a fresh clone needs. [RUN.md](RUN.md) covers running it day to day (services, campaigns, map
grids). [PLAN.md](PLAN.md) has the architecture. [CLAUDE.md](CLAUDE.md) is the orientation for coding agents.

## What you need

### The core

You need all of these to run the app and the tests.

| What | Version | Why |
|---|---|---|
| Node.js, with npm | 22.9 or newer (developed on 24) | Everything is ES modules on Node. The npm scripts use `--env-file-if-exists`, which arrived in 22.9. |
| git | any recent | The world timeline commits each synced batch, and `bin/ip-check` reads history. |
| Linux | developed on Ubuntu 22.04 | The `bin/` scripts are POSIX sh, and the always-on services are systemd user units. macOS and Windows are untested. |

There are three npm packages, one per folder, and each one needs its own `npm install`.

| Folder | Packages |
|---|---|
| repo root | `zod` (all schema validation) and `@anthropic-ai/sdk` (LLM calls) |
| `wf-mcp-server/` | `@modelcontextprotocol/sdk` and `zod` |
| `review-ui/` | `playwright`, which drives a headless Chromium for the Foundry GM client and the browser tests |

The web app has no framework and no build step. Its server is plain `node:http`.

### For the table: Foundry VTT

GM_Tools runs on files without Foundry. To reach a live game you also need these.

| What | Notes |
|---|---|
| Foundry VTT | Version 13 or 14 (checked on 14), on your own licence. |
| The World Fabric module | A Foundry module in its own repository, not shipped with this one. It holds the graph inside Foundry and runs the file bridge GM_Tools writes to. Without it, nothing reaches Foundry. |
| The dnd5e system | Built against 5.x. The party rail, stat blocks and passive scores read dnd5e data. The graph and the planner work under other systems. The D&D-specific parts don't. |
| Playwright's Chromium | Install it with `npx playwright install chromium` in `review-ui/`. On a bare Linux box you may also need `npx playwright install-deps chromium`. The bridge client (`review-ui/gm-client.mjs`) logs in to Foundry as a GM user with it. |
| The Plutonium module (optional) | Its bundled 5etools data feeds the creature and item imports and the structured rules backend. GM_Tools reads `<Data>/modules/plutonium/data/`. |

### Optional, by feature

Each row turns on one feature. Leave any of them out and the rest of the app still works.

| Feature | What it needs |
|---|---|
| LLM features: proposals, narration, drafting, rulings | `ANTHROPIC_API_KEY` in `.env`. Without it the app starts, and those features say they're off. |
| Token faces, splash art | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`). It also uses `python3` with Pillow to crop faces to 512 px squares. Without Pillow, the face is kept uncropped. |
| An agent working through the tool | Claude Code, or another MCP client, attached to `wf-mcp-server/`. Copy `.mcp.json.example` to `.mcp.json` and fill it in. The agent skills are in `.claude/skills/`. |
| The rules shelf | Your own rule books, as page-marked text under `rules-library/`. The folder is ignored by git, and nothing ships with the repo. |
| Grid sizes from module scene packs | Foundry's own `classic-level`, for LevelDB packs. Set `FOUNDRY_MAIN` or `CLASSIC_LEVEL_NODE_MODULES`. |
| Map segment tools (`map-segments/tools/*.py`) | Python 3.10 or newer, with `numpy` and `pillow`. `tag.py` also needs `torch` and `open_clip_torch`. |
| The map picture model (`map-plan/tools/look.py`, `bin/map-shelf`) | A Python with `torch` (the CPU build is enough), `open_clip_torch` and `pillow`. Install torch from the CPU index (`https://download.pytorch.org/whl/cpu`) so torch and torchvision match. Point the tools at that Python with `--python` or `MAP_LOOK_PYTHON`. |
| Map art from a plan | Dungeondraft (a licensed desktop app), its GM Bridge mod, and a Dungeondraft MCP server. All three live outside this repo and aren't published, because the theme that picks pack art names other people's files. Without them, `bin/map-make` still gives the plan, an SVG preview and Foundry walls. |
| Always-on services | A systemd user session. See RUN.md, "Always-on: the three services". |
| Opening the browser on launch | `xdg-open`. Without it, the launcher prints the URL instead. |

## Install

```
git clone <this repo> GM_Tools && cd GM_Tools
npm install
(cd wf-mcp-server && npm install)
(cd review-ui && npm install && npx playwright install chromium)
cp .env.example .env          # add keys if you have them; the app runs without
npm test                      # no keys and no Foundry needed
npm run app                   # starts the server on :8787 and opens the browser
```

To connect a Foundry world, set `WF_DATA_DIR` to the folder that contains `worlds/`, install the World Fabric module in
that Foundry, and follow RUN.md.

## Configuration

Secrets go in `.env` at the repo root. That file is ignored by git, and `.env.example` is the template. Machine paths
for the services go in `~/.config/gm-tools/services.env`, from `ops/services.env.example`. The campaign repos you
register are listed in `~/.config/gm-tools/campaigns.json`.

| Variable | Used by | What it does |
|---|---|---|
| `WF_DATA_DIR` | app, MCP server, CLIs | Foundry's `Data` folder, the one that contains `worlds/`. |
| `WF_DEFAULT_WORLD` | app, `bin/gm-status` | The world to use when a call doesn't name one. |
| `REVIEW_UI_PORT` | app, launcher | The app's port. The default is 8787. |
| `ANTHROPIC_API_KEY` | LLM features | Optional. See above. |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY`, `WF_IMAGE_MODEL` | token faces, splash art | Optional. |
| `FOUNDRY_URL`, `FOUNDRY_GM_USER`, `FOUNDRY_GM_PASSWORD`, `FOUNDRY_DATA_DIR`, `WF_WORLD` | bridge client | How the headless GM client logs in to Foundry, and which world it joins. |
| `FOUNDRY_PORT` | `bin/gm-status` | Foundry's port. The default is 30000. |
| `GM_TOOLS_CAMPAIGNS` | all | Overrides `campaigns.json` (`world=dir;world=dir`). |
| `WF_TIMELINE_GIT` | sync | Set it to `0` to turn off the world-timeline commits. |
| `MAP_LOOK_PYTHON`, `FOUNDRY_MAIN`, `CLASSIC_LEVEL_NODE_MODULES` | map tools | See the optional features above. |
| `GM_TOOLS_*_DIR` | tests | Moves one data store somewhere else, so tests never touch real data. |

## Tests

```
npm test                                # root suites
(cd wf-mcp-server && npm test)
(cd review-ui && npm test)              # route and unit tests
(cd review-ui && npm run test:e2e)      # real-browser tests; needs Playwright's Chromium
```

These suites need no API key. The `*.smoke.mjs` files make real, small model calls. Run them by hand with a key set.

## Moving to another machine

Git carries the code. It doesn't carry these, so copy them across:

- **`.env`**, which holds your keys.
- **The data stores in this checkout.** These are the ignored folders, such as `bestiary/`, `items/`, `party-roster/`,
  `review-state/`, `session-scenes/`, `stagecraft/`, `rules-library/` and `tokens/`. The library-wide stores stay here
  even when a world has a campaign repo. The simplest way is to copy the whole checkout and then run `git status` on
  the new machine.
- **`~/.config/gm-tools/`**, which holds `services.env` and `campaigns.json`. Fix any paths in them that changed.
- **Foundry's `Data` folder**, which holds worlds, modules and systems. Copy Foundry itself, or reinstall it.
- **Each campaign repo.** Push it, or copy it, and re-register it if its path changed.

Rebuild everything else on the new machine: `node_modules/` (the install steps above), Playwright's Chromium, and any
Python virtualenvs. Then re-run `ops/install-services.sh` if you use the services, and check with `bin/gm-status`.

## What isn't in the repo

- **Your campaign.** The data stores are ignored folders in this checkout, unless a world is registered to its own
  campaign repo (see RUN.md, "A campaign is a git repo").
- **Other people's IP.** Rule-book text, published maps, asset packs and their file names stay out, along with anything
  derived from them. This repo is public. Run `bin/ip-check` before each commit and `bin/ip-check --push` before each
  push.
