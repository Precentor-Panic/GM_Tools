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
