# Friction Wave 1 — Morning Review

*Everything below lives on the `friction-wave-1` branch in THIS worktree
(`/opt/dev/GM_Tools-wave`). Your running app and `/opt/dev/GM_Tools` were
never touched. Five agents, one commit per task, `3156e48..` onward;
per-cluster handoffs in `notes-agent1..4.md`.*

## TL;DR

All 25 tasks from the Kilmarn friction log landed, plus the closing sweep.
The review screen now does the duplicate-hunting for you (near-match chips,
one-click convert-create-to-update with edge re-pointing, a "yes, but" merge
editor, reject-cascade, triage tags, readable edge cards, and a persistent
"Apply to world" banner so accept never dead-ends again); the writeup
importer catches the "Lowway"/"Master Vane"/"Kilmarn Bridge" dup families
before they ever become cards, fails fast on dense writeups with real
guidance, and carries a framing across a resubmit; scenes finally *have*
maps (`scene.mapAssetId` + `stagecraftAsset.src`, chips everywhere,
push-scene defaults from the link); the Library sees all 4,126 Plutonium
creatures without importing any; the World tab got the containment/cycle fix
that ate Kilmarn, your requested rail redesign (Spatial | Loyalty | Graph),
and the one-hop local graph panel; the gear menu now lists every world
folder on disk so attaching `kilmarn` is one click; and SKILL.md now matches
the real tool surface. Every suite is green — including the FULL e2e suite
in one uninterrupted run, and the root suite for the first time since Phase
18 (the old `snowball-delta` failure was a test-fixture arithmetic
coincidence, fixed in its own clearly-labeled commit).

## What landed, cluster by cluster

### W1 — Review cards stop making you do the tool's job (`1d0bc88`..`555532f`)

Your round-3 theme was "**not enough agency over duplication**, and the
reviewer is doing work the tool should do." Specifically the manual
tab-flip loop: *"for every proposed create, flip to the World tab, search,
'is this already in the world?'"*

- **Near-match chips (W1a)** — every proposed CREATE card shows its live-graph
  near matches right on the card (your proposed quick win, verbatim).
  Deterministic, no LLM.
- **"This is not a new node — it's an update to THIS node" (W1b)** — pick a
  chip (or search), the create converts in place into an update of that
  entity, and every pending edge in the batch re-points automatically.
- **"Yes, but" merge editor (W1c)** — an editable staged-text area on
  update/create cards ("✎ Edit staged text", with an "Insert old text"
  helper). Hand-combine the two texts, accept applies YOUR version. This is
  the round-1 ask about destructive updates: accept-as-shown no longer means
  losing the original narration.
- **Edge automation tied to node decisions (W1d)** — reject a create and its
  pending edges grey out with an Undo; accept a create and you get
  "Accept all N connections."
- **Triage tags are back (W1e)** — `possible duplicate` / `fights canon` /
  `low risk` / `needs review` on every proposed mutation, deterministic v1.
- **The Triaged toggle bug (W1f)** — reproduced in a real browser first (it
  was a view-layer bug: the card never wrote decisions back to the shared
  object, so any re-render restored stale state), then fixed. A view filter
  can never mutate selection state again — regression-pinned.
- **Edge legibility (W1g)** — edges read "Source —label→ Target" with real
  names, never `m46`-style ids, and ALSO nest indented under every node card
  they touch (your open question: an edge touching two shown nodes renders
  under both, sharing one accept state).
- **Accept → apply CTA (W1h)** — the "accept-all → now what?" dead end from
  day one: a persistent "N accepted mutations not yet applied — Apply to
  world" banner wired to the existing sync route.

### W2 — The importer stops creating the duplicates at all (`93203ee`..`8ed55fc`)

- **W2a/W2b** — the near-miss pass now runs in the writeup path BEFORE the
  dry-run: "Master Vane", "The Lowway"/"Lowway", "Trade Council",
  "Guild Seal (Dyers' Hall)" all resolve to canon names and dedup as
  updates; an exact name with a different type guess ("Kilmarn Bridge"
  place-vs-object, "The Interest") resolves onto the existing entity,
  keeping its type. All the real Kilmarn cases are pinned as test fixtures.
  Every rewrite is surfaced as a "matched to canon" note on the card.
- **W2c** — the max_tokens hard-fail that cost you two full API calls plus
  the framing round: budget raised to 16384 and env-configurable
  (`WF_WRITEUP_IMPORT_MAX_TOKENS`), and truncation now fails on the FIRST
  attempt with an approximate entity count and "split the writeup" guidance.
  (The auto-split stretch was deliberately skipped — see stubs.)
- **W2d** — a resubmit of already-framed material (exactly your session's
  3a/3b split) can carry the framing forward and skip the rubber-duck round.
- **W2e** — stubs from unresolved edge endpoints are named
  "Unresolved: <name>" and tagged for review, never "wf_mssa9fia_0"; an
  id-keyed stub heals in place when the original create syncs later.

### W3 — Scenes can finally reference a map (`f686324`, `73d87c6`, `10476dd`)

Your finding: *"a scene↔map pairing cannot be recorded anywhere, so the UI
has nothing to show."*

- `stagecraftAsset.src` is a real, durable file-path field (edit it from the
  Stagecraft shelf — no more paths smuggled into `desc`).
- `scene.mapAssetId` links a scene to a map asset; the scene page gets a
  picker and an always-visible chip (green when linked, muted "No map
  linked" otherwise — absence is visible, not inferred), with glyph chips on
  tray rows and run-sheet rows.
- `POST /api/foundry/push-scene` no longer requires `mapSrc` — it defaults
  from the linked asset. Your 9 kilmarn scenes' "MAP: ..." objectiveNote
  workaround lines were deliberately left untouched (see stubs).

### W4 — The Library sees Plutonium (`a9a5662`, `eb0b0a9`, `d9dbde5`)

Your ask: *"can the planner 'library' know what's AVAILABLE (names + meta)
without importing?"* — Yes, exactly as the friction note sketched:

- A read-only indexer over the module's bundled 5etools data — verified
  against your real install: 127 source files, 4,126 creatures, 191ms cold
  then cached (Arcanaloth MM p313 CR 12, the note's own finding).
- An "Available via Plutonium" shelf in the Bestiary tab, BELOW the curated
  grid and never mixed into it: search, CR range, type/source filters,
  windowed pages, a distinct rust source pill.
- Per-creature "Add to shelf" creates an accepted bestiary entry with real
  stats and a "SOURCE pPAGE via Plutonium" note (409 on duplicates). The UI
  copy states plainly that importing the actor into Foundry stays a manual
  Plutonium act at prep time.

### W5 — World tab: the disappearing-places bug + your rail redesign (`f59fbe1`..`c14c39e`)

- **W5a** — both halves of the bug that ate Kilmarn and the Underbreach:
  imports now normalize containment direction ("Kilmarn has five quarters"
  can't invert the tree again), and the tree builder detects cycles —
  cycle members render at root with a `⚠ cycle` badge naming the loop
  instead of silently vanishing.
- **W5b** — the redesign as you specced it: a Library-style sub-bar under
  the World header with a **Spatial | Loyalty | Graph** rail selector,
  "search the world" + the icon filters moved down onto it. The clipped
  "Spatial/Loya" toggle is gone (superseded). Graph mode revives the full
  graph view (the shared renderer, zoom/pan/popovers live, search+filters
  narrow it too).
- **W5c** — your world-name suspicion from the bug report, turned into a
  permanent guard: a quiet, non-blocking "≙ world" marker whenever an
  entity name equals the world id/name.
- **W5d (stretch, built)** — round-3 item 6's panel completed: entity click
  shows a one-hop local graph (selected entity centered, color-coded
  relationship types, legend, neighbor-click navigates) beneath the
  title/description/develop/contents/actions/loose-threads that already
  lived there.

### W6 — Glue (`c94e925`, `1f07a32`, `d4dc0b9`)

- **W6a** — *"Gear menu: no way to point at an EXISTING Foundry world."*
  One shared picker now lists every `Data/worlds/*` folder — already a
  GM_Tools world (Select), a plain Foundry world (**Attach** — bootstraps
  the snapshot into that folder), or a name that can't be a world id
  (shown, explained). It's mounted in the gear panel's no-Foundry card, the
  connected card's "switch world" list, AND the zero-worlds first-run
  landing — the "two world lists should probably be one surface" gap is
  closed, and typing an existing id into the create blank now answers
  "select it from the list above" instead of a raw error.
- **W6b** — SKILL.md rewritten against the verified registry. Root cause of
  "the tools don't exist": they DO — the MCP wave landed them (4e4d923,
  Aug 13 02:38) mid-exercise, but your agent's session was attached to a
  server process started before that. The contract now enumerates all 66
  real tools, documents the W2d `framing` param and the W1 accept≠applied /
  reject-cascade behaviors, adds the HTTP routes that have no MCP mirror
  (scene↔map, Plutonium, convert/patch-data/revert, manual graph edits =
  deliberately not MCP), and opens with a "if a tool errors as unknown,
  restart the server — don't improvise" rule.
- **Pre-existing failure fixed** (`d4dc0b9`, clearly labeled NOT wave
  scope) — `snowball-delta.test.mjs` had failed since Phase 18 because its
  fixture accidentally engineered the exact arithmetic coincidence its own
  assertion forbids (2·40+30 = 2·10+90 = 110 under the linear stub score).
  The module was always correct; one fixture number changed (30→20).

## How to try it

**Your app is currently running on 8787 (checked live during the sweep), so
plain `npm run app` from this worktree would health-check 8787, find YOUR
running app, and just open a browser tab at the OLD code.** To drive the
wave build side by side:

```bash
cd /opt/dev/GM_Tools-wave
REVIEW_UI_PORT=8788 npm run app     # (node needs ~/.local/node/bin on PATH)
```

Two things to know about what you'll see on 8788:

- **World graphs are your real ones** (snapshots live in
  `/home/russell/foundrydata/Data`), so the World tab, world picker, and
  Plutonium shelf all show real data immediately. Accepting/syncing a batch
  there writes the real snapshot exactly like the main app would — browse
  kilmarn freely, but do write-experiments on `wf-test`.
- **Planner/Library/review stores are repo-relative**, so the wave app
  starts with empty plans/scenes/bestiary shelves (your kilmarn scenes stay
  in the main worktree's stores until the merge). To see the W3 map chips
  on your real 9 scenes pre-merge, either copy the stores over
  (`cp -r /opt/dev/GM_Tools/{session-scenes,session-plans,stagecraft,scene-tray,scene-elements} /opt/dev/GM_Tools-wave/`)
  or just make a quick test scene. After the merge this distinction
  disappears.

Suggested 10-minute tour, in order:

1. **Gear menu (W6a)** — open the ⚙ panel, hit "switch world": every world
   folder on disk in one list, badges and all.
2. **World tab on kilmarn (W5)** — the new sub-bar; flip
   Spatial → Loyalty → Graph; click an entity and scroll the detail pane to
   the one-hop local graph; search/filters from the bar.
3. **Chronicle → Receive new information (W1+W2)** — paste a paragraph that
   mentions an existing entity by a shorthand name ("Master Vane" style).
   Watch the card come back as an update with a "matched to canon" note —
   or, for a genuinely new near-dup, chips + Convert + the merge editor +
   triage tags. Reject a create with edges to see the cascade; accept
   things and watch the "Apply to world" banner appear.
4. **Library → Bestiary (W4)** — scroll below the curated grid to the
   Plutonium shelf; search "arcanaloth"; add something to the shelf.
5. **Any scene page (W3)** — the map chip + picker; link a map asset, note
   the tray/run-sheet glyphs.

## Deliberate stubs — wants your Designer pass

- **W5b graph-mode popovers are READ-ONLY** (name/type/meta + "Develop this
  node →"). No node/edge editing in the World tab's Graph mode — the
  standalone Graph nav view keeps the full manual-edit surface. Wiring it
  is a known, contained change (pass `editable: true` + the six handlers
  into `renderWorldGraph()`), deliberately not duplicated for a rough pass.
- **The whole W5b sub-bar is rough-by-design** — existing tokens, Library
  idiom. Per the Designer→Wire model it wants a `.dc.html` from Claude
  Designer as source of truth; everything is behind testids so a reskin
  won't break pins.
- **W6a picker** — same story: functional, mimics the conn-panel idiom,
  happy to be reskinned.
- **W5d cosmetic nit** — on a vertical edge the midpoint type label can
  overlap the center node's name (legend disambiguates).
- **W1 card additions** (chips, merge editor, cascade notices, banner) reuse
  the proposal-card idiom — fine, but included here for completeness.

## Deferred follow-ups (from all handoffs)

1. **Quiet-flush composer still sources `background` from TRAY roster map
   assets, not `scene.mapAssetId`** (Agent 3). W3c fixed the push-scene
   route's default; re-pointing `composeSceneOps` would change phase36's
   pinned flush contract. Natural follow-up: prefer the scene link, fall
   back to the roster scan.
2. **No data migration of kilmarn's workarounds** — the "MAP: ..."
   objectiveNote lines and desc-field paths were deliberately never
   rewritten ("never mutate the real kilmarn stores"). Going forward the
   real fields exist; migrating the 9 scenes is a 5-minute manual task in
   the UI if you want it.
3. **W2c stretch (auto-split a too-dense writeup into one merged batch)** —
   skipped on purpose; fail-fast + W2d's carry-over covers the real
   recovery flow at far lower complexity.
4. **W2e live-Foundry path** — stub naming is fixed on the headless path
   (where it actually happened); a live client's GraphService keeps its own
   resolveEndpoint behavior (same class of documented live-path limitation
   as Phase 4's id write-back).
5. **`wf_update_scene` doesn't take `mapAssetId`** — the scene↔map link is
   HTTP-only for now (documented in SKILL.md §8). Add to the MCP tool if
   agent co-planning wants it.
6. **W5a's import normalization covers the writeup-import path only** —
   mention-scan/manual edges don't run it (they can't produce the bug
   today; flagged in case a future producer emits containment edges).
7. **Whole-batch LLM triage** — tags stay deterministic v1 per the wave
   plan's own deferral.
8. **Real-API smoke re-run suggestion** (Agent 2): no paid calls were made
   during the wave; `wf-mcp-server/test/writeup-import-roundtrip.smoke.mjs`
   is the one path where a real model's output now flows through the new
   W2a/W2b normalization — worth one run when convenient.
9. **W1h re-applies ALL accepted mutations on accept-after-sync** (the
   store only tracks batch-level sync status; upserts are idempotent so
   this is safe, just noted).

## Merge plan

```bash
cd /opt/dev/GM_Tools               # the main worktree, your running app
git merge friction-wave-1          # fast-forward-ish; master hasn't moved (merge-base 18328a6 = master HEAD)
# restart the app: stop the running 8787 server (Ctrl-C its terminal, or kill the node serving 8787), then
npm run app
# optional cleanup once you're happy:
git worktree remove /opt/dev/GM_Tools-wave
git branch -d friction-wave-1
```

Nothing in the wave migrates data or changes store schemas destructively —
every new field is additive-optional and your existing records were
verified (by Agent 3, read-only) to load cleanly through the updated
stores.

## Test status (final sweep, all fresh runs at HEAD)

| Suite | Result | Note |
|---|---|---|
| root `npm test` | **101/101** | first all-green root since Phase 18 (`snowball-delta` fixture fixed, own commit `d4dc0b9`) |
| `wf-mcp-server` `npm test` | **43/43** (41 files) | |
| review-ui deterministic `npm test` | **322/322** | was 268 pre-wave |
| review-ui **FULL e2e** `npm run test:e2e` | **258/258** | all 58 files, ONE uninterrupted run (92s) — no parallel-load flakes this time; every wave e2e included |
| `foundry_worldFabric` | untouched | wave made no module changes (W3c stayed GM_Tools-side) |
