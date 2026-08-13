# Running GM Tools

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
