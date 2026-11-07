# Running GM Tools

First time on a machine? [README.md](README.md) lists what to install.

Three ways to launch (all go through `bin/gm-tools`, the single-instance launcher):

1. **`npm run app`** — from the repo root. Simplest if you already have `node`
   on PATH. On this machine it isn't by default:
   `export PATH="/home/russell/.local/node/bin:$PATH"` first.
2. **`bin/gm-tools`** — the same script, run directly. Also needs `node` on
   PATH (the shebang is a convenience, not a guarantee).
3. **The desktop entry** — copy `gm-tools.desktop` into
   `~/.local/share/applications/`:
   ```
   cp gm-tools.desktop ~/.local/share/applications/
   ```
   then launch "GM Tools" from your desktop's app menu like any other app.
   This entry hardcodes an absolute node path
   (`/home/russell/.local/node/bin/node`) since it can't rely on your shell's
   PATH — **machine-specific**, update `gm-tools.desktop`'s `Exec=` line if
   node moves or this repo is used on another machine.

## Always-on: the three services

For a machine that hosts a table, run everything as systemd user services
instead of launching by hand. Three units in `ops/systemd/`:

| Service | What it runs |
|---|---|
| `foundry` | Foundry VTT, with the configured world open |
| `gm-tools` | this app's server (`review-ui/server.mjs`) |
| `gm-tools-bridge` | the headless GM client (`review-ui/gm-client.mjs --daemon`) that applies GM_Tools' changes inside Foundry |

All three start at boot and restart on failure. Set up once:

```
mkdir -p ~/.config/gm-tools
cp ops/services.env.example ~/.config/gm-tools/services.env   # then edit the paths
ops/install-services.sh --start
```

Starting at boot (not just at login) needs lingering; the installer turns it
on and tells you if it could not.

**One status command:** `bin/gm-status` (`--json` for machines). It reports,
in dependency order: Foundry up, GM_Tools up, whether the server is running
code older than the tree, bridge connected, index age, queue depth, and the
service states. It exits 0 only when everything is healthy, and every failing
line names the command that fixes it.

Everyday commands:

```
bin/gm-status
systemctl --user restart gm-tools          # after changing server-side code
systemctl --user restart foundry           # also restarts the bridge
journalctl --user -u gm-tools-bridge -n 50 # what the bridge saw
```

**Your own GM tab and the bridge can be open together.** The World Fabric
module picks one client to apply changes: the bridge when it is connected,
otherwise Foundry's active GM. The one rule: **after the module's code
changes, reload your GM tab** (the bridge reloads itself when Foundry
restarts). A tab still running the old module code can disagree about who
applies.

The bridge never draws: it turns Foundry's canvas off for its own browser
profile and hides the interface, so it idles at a few percent of one core.
It refreshes the Foundry index every two minutes and after every applied
batch.

## A campaign is a git repo

GM_Tools is the tooling; a campaign is its own git repo. When a world is
registered to a campaign repo, its plans, scenes, elements, notes, map and
music assets, party, items and review history are read and written under
`<campaign repo>/data/`, one file or folder per store, so `git diff` and
`git log` there cover what you run from. A world that is not registered keeps
its data in this checkout (gitignored), as before.

    bin/campaign-adopt --world <w> --dir /path/to/campaign-repo            # report
    systemctl --user stop gm-tools
    bin/campaign-adopt --world <w> --dir /path/to/campaign-repo --apply
    systemctl --user start gm-tools

The apply copies each store, checks the copy byte for byte, renames the
original to `*.migrated-<date>` and adds the world to
`~/.config/gm-tools/campaigns.json` (`{"<world>": "/abs/dir"}`; the
`GM_TOOLS_CAMPAIGNS` env var, `world=dir;world=dir`, overrides the file). To
undo, remove the registry entry and rename the originals back.

GM_Tools only writes the files. It never commits: commit the campaign repo
when you want a checkpoint. `bin/gm-status` shows each campaign's branch and
how many files under `data/` are uncommitted.

Not moved by that command: the graph and the reveal state beside it, the
shared bestiary and rules shelves, and machine state (push lock, sync log,
undo slots, app settings, the Foundry token index).

The graph is a second, separate step, because it changes who owns it:

    bin/campaign-adopt-graph --world <w>             # report; lists anything that blocks it
    systemctl --user stop gm-tools gm-tools-bridge
    bin/campaign-adopt-graph --world <w> --apply
    (cd review-ui && node --env-file-if-exists=../.env gm-client.mjs --graph-source file)
    systemctl --user restart foundry && systemctl --user start gm-tools

After it, `data/graph.json` is the graph: GM_Tools writes it directly (a manual
edit or a sync lands at once, with Foundry open or closed), Foundry reads the
published copy `worlds/<w>/world-fabric-graph.json` and saves nothing of the
graph, and the reveal state is in `data/narrative-state/`. Reload any open
Foundry tab once. To undo: delete `data/graph.json` and
`data/narrative-state/`, and run the client with `--graph-source settings`.

## Map grids

A map asset can record the grid its image is drawn at (pixels per square). A
scene created from it gets that grid; without it Foundry uses 100 px, which
does not line up with most map packs.

```
bin/map-grid --world <world>            # what each map has, and what its pack says
bin/map-grid --world <world> --apply    # record the pack's size where none is recorded
bin/map-grid --world <world> --set <assetId> 140
bin/foundry-push --world <world> --plan <planId> --regrid
```

`--regrid` sets the grid on scenes that are already in Foundry. It is a
separate, explicit step because it resizes the tokens on those scenes. The
Library's Stagecraft rows show and edit the same value.

## What it does

- **Already running** — if something matching GM_Tools is already answering
  on port 8787, the launcher just opens your browser to it. It never starts
  a second server.
- **Not running** — it spawns `review-ui/server.mjs`, waits (up to 15s) for
  it to come up, then opens your browser. The launcher stays attached to the
  server: closing it (Ctrl-C, or closing the desktop entry's terminal
  window) stops the server too. There's no separate "stop" command because
  there's no detached background process to stop — simplest correct model
  for a dev-ish tool.
- **Foreign process on 8787** — if something else (not GM_Tools) is already
  listening on the port, the launcher refuses to start and prints a clear
  error rather than silently picking a different port.
- **First run, no worlds yet** — the browser opens on the Create-World view
  (currently `#settings`; Phase 34 task 34.2 will fold this into the new
  Connection Menu panel and re-point this). Once a world exists, it opens on
  the planner (`#planner/plans`, `app.js`'s own default hash).
- **Missing `ANTHROPIC_API_KEY`** — prints one notice line and keeps going.
  LLM-backed features (mutation proposals, narration, etc.) are disabled
  until it's set, but the app itself launches and runs fine without it.

## Env vars

| Var | Required? | What it does |
|---|---|---|
| `REVIEW_UI_PORT` | optional (default `8787`) | Port the server listens on and the launcher health-checks. The launcher never port-hops on its own — set this yourself if 8787 is taken. |
| `ANTHROPIC_API_KEY` | optional | See above. Set in `.env` (copy `.env.example`) or your shell env. |
| `WF_DATA_DIR`, `WF_DEFAULT_WORLD` | optional | Passed straight through to `review-ui/server.mjs`; its own startup log line shows what it resolved. |
| `GM_TOOLS_NO_BROWSER` | optional, testing only | Set to `1` to skip the actual browser-open call (the URL is still printed). Used by this launcher's own shell tests so they don't pop a real browser window. |

`bin/gm-tools` reads `.env` (repo root, gitignored, copy from `.env.example`)
itself before spawning the server, using a small built-in parser — no new
dependency added for it.

## Logs

The server's stdout/stderr are inherited straight into whichever terminal ran
the launcher (or the desktop entry's terminal window). There's no separate
log file.

## Connect an agent

`wf-mcp-server/` (`GM_Tools/wf-mcp-server/index.mjs`) exposes the whole stack
— the World Fabric graph, the review-gate workflow, the Session Planner, the
Library, and the Chronicle — as MCP tools, so a Claude Code session can
co-plan a real session or one-shot with you *through the tool*, not just
narrate around its edges. See `wf-mcp-server/README.md` for the full tool
list.

### 3-step attach (Claude Code)

1. **Point it at your Foundry data dir.** Copy `.mcp.json.example` (repo
   root) to `.mcp.json` (same location Claude Code auto-discovers project
   MCP servers from) and fill in `WF_DATA_DIR` — the folder containing
   `worlds/` (on a typical install, `.../FoundryVTT/Data`). Leave
   `ANTHROPIC_API_KEY` blank if you don't have one handy — every tool still
   works, LLM-backed ones just degrade to an honest placeholder instead of
   real model output (see wf-mcp-server/README.md's "Keyless / offline
   safety"). `command`/`args` in the example (`node`, `wf-mcp-server/index.mjs`)
   are resolved relative to the project root Claude Code loaded — if `node`
   isn't on your shell's PATH (it isn't by default on this machine — see the
   top of this file), replace `"command": "node"` with the absolute path
   (`which node`).
   Equivalent one-liner instead of hand-editing JSON:
   `claude mcp add world-fabric -- node wf-mcp-server/index.mjs` (run from
   the repo root, then set `WF_DATA_DIR`/`ANTHROPIC_API_KEY` via `claude mcp
   add`'s `--env` flag or by editing the resulting `.mcp.json` entry).
2. **Restart/reconnect Claude Code** (or run `/mcp` to reconnect) so it
   picks up the new server. Confirm with `wf_list_worlds` — it should list
   every world under `WF_DATA_DIR` that has an exported
   `world-fabric-snapshot.json`.
3. **Load the agent contract skill.** `.claude/skills/gm-tools-agent/SKILL.md`
   is a repo skill any attached agent should load before touching this
   surface — the collaborator rules (always pull fabric context first,
   `world` explicit on every call, what goes through a review gate vs. what
   writes directly, prose intake = `wf_propose_from_writeup`).

### What an attached agent can / can't do

- **Can read** the whole graph, the Session Planner (plans/scenes/elements/
  tray), the Library (bestiary/party/items/stagecraft), and the Chronicle
  (clock/fortune/log/pending intents) — always with an explicit `world`.
- **Can write directly, no review gate**: Session Planner working-state
  (creating/editing a scene, plan, element, tray drop — the same kind of
  edit the UI's own forms make) and Library hand-authoring (adding a
  bestiary entry/party member/item/stagecraft asset by hand). This is
  planner scratch-space / deliberate hand-authorship, not world canon.
- **Must go through a review gate** for anything that proposes new/changed
  *world canon*: `wf_propose_mutations`, `wf_propose_from_writeup` (+
  `wf_select_framing`), `wf_chronicle_run`, `wf_run_cycle`/
  `wf_resolve_pending` — each creates a batch that only reaches the graph
  after an explicit `wf_accept` (or the equivalent Accept in the app's own
  review UI — either side of the same review-state store).
- **Cannot** bypass the graph mutation gate (`wf_apply_mutations`/
  `wf_sync_to_foundry` still only ever write *accepted* mutations), restart
  or otherwise control a live Foundry client, or reach anything the HTTP app
  itself can't reach.
- **The multi-world rule**: every tool that touches world-scoped state
  requires `world` explicitly and never silently defaults across worlds —
  real for Russell, who runs more than one world at a time (an ongoing
  campaign plus a separate one-shot, each its own graph/planner/library
  state). Don't assume a "current" world; ask or call `wf_list_worlds`.

## Troubleshooting

- **"port 8787 is in use by something else"** — another process (not a
  previous GM_Tools instance — the launcher would have detected and reused
  that) is bound to 8787. Find it (`lsof -i :8787` or `ss -ltnp | grep 8787`)
  and stop it, or set `REVIEW_UI_PORT` to a different port and re-run.
- **Nothing opens in the browser** — `xdg-open` may be missing or
  unconfigured for your desktop environment. The launcher always prints the
  URL it tried to open; copy that into a browser manually.
- **Want to force-restart** — there's no in-launcher "restart". Stop the
  running server (Ctrl-C wherever it was launched from, or kill its PID)
  and run the launcher again.
