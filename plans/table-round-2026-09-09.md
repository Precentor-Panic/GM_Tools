# Table round — 2026-09-09: corrections after the first live session

Source: `plans/table-feedback-2026-09-09.md` (seven items from Russell plus
three defects found during the session-one intake). This is the build
plan. Everything here is campaign-agnostic; the Aureus data fixes that
fall out of it are listed at the end as campaign-repo work.

Ordering principle: cheapest fix with the widest blast radius first
(the bridge), then the two things that made the session hard to run
(spoilers, reading order), then capture, then the nice-to-haves.

---

## WS-A — Bridge fixes (`/opt/dev/foundry_worldFabric`, one commit)

All three are in `scripts/data/foundry-bridge.mjs`'s `startFoundryOpsWatcher`
creators. None change the op contract's shape for existing callers.

**A1. Tokens land HOSTILE (feedback "also in scope").**
`buildTokenData` (~line 737) hand-composes `{name,x,y,actorId,texture}`;
TokenDocument's schema default for `disposition` is `-1`. Replace the
hand-composition with the actor's own prototype token:

```js
const doc = await actor.getTokenDocument({ x: t.x, y: t.y });
const data = doc.toObject();
if (t.img) data.texture.src = t.img;
```

This also restores vision, bars, size and displayName from the prototype
— every pushed PC token has been hostile-red and blind since Phase 36.
Fallback when `actorUuid` doesn't resolve: keep the current shape.

**A2. Scene music keys.** `createScene`'s `createData` and `updateScene`'s
whitelist (`["name","width","height","grid"]`, line 771) gain `playlist`
and `playlistSound`. The op carries `playlist: "Playlist.<id>"` (uuid, as
the index already exports) and `playlistSound: "<track name>"`; the bridge
resolves both to the bare ids Scene wants (`fromUuid` → `.id`;
`playlist.sounds.getName(name)?.id`). Unresolvable → per-op error, never
a silent skip. Also add `id` to `extractPlaylist`'s tracks so a later
round can address a track by id instead of name.

**A3. `update_actor` op (for token art, WS-F).** New whitelisted patch:
`{ img?, "prototypeToken.texture.src"? }` only. Same shape/discipline as
`update_item`. Contract doc (`plans/phase-32-bridge-contract.md`) gets a
v5 amendment line for A2/A3.

Verify live: push one scratch scene from GM_Tools with a PC + a creature,
confirm `disposition` on each token via the keeper, confirm the scene's
`playlist`/`playlistSound` populated and that activating the scene starts
the track (Foundry does this natively once the fields are set).

---

## WS-B — Spoiler-safe scene names (feedback 3)

What actually leaked: the scene NAME carries the subtitle after the dash
("Fight Night — Vashan dies and the body is taken"), and the push sends
`scene.name` verbatim to Foundry (`resolveSceneName`,
`wf-mcp-server/lib/foundry-push-ops.mjs:106`). Foundry scene names show
in the players' navigation bar. The Run header (`buildRunSpread`, ~line
4023) shows the same string, which is fine for the GM but is the same
habit.

Not doing: auto-stripping after the dash on push. The combat variants
legitimately use the dash ("The Sermon and the Sand — COMBAT: …") and
stripping would collapse them to identical Foundry names.

Doing:

1. **Generator rule.** `.claude/skills/scene-authoring/SKILL.md` gains a
   hard rule under §1: *a scene name is a place-and-moment label, never an
   outcome. The after-dash part, if any, is a variant label (COMBAT:,
   session end, any night). Nothing after the dash may state what happens
   in the scene.* Same line in `prompts/` wherever scenes are named by a
   model call (grep `objectiveNote`/`name` in `session-planner/brief.mjs`
   and `element-assist.mjs`).
2. **Show, don't guess.** Detecting an outcome-shaped subtitle by pattern
   is too clever. Instead the push result echoes the exact Foundry name it
   is about to write, and the Prep chip row shows "Foundry name: …" under
   the scene title. The GM sees what the players will see before
   confirming.
3. **Aureus data**: rename the 13 pushed scenes (campaign task, list at
   the end) and push `update_scene` name patches.

---

## WS-C — Run-spread reading order (feedback 4) — the substantial piece

Diagnosis from the real Kit Table scene as stored:

```
main/read      Read Aloud — the fighters' tunnel, kit hour
side/block     Vashan the Gleam — tonight's headliner   (looks, wants, secret, checks, stats)
main/dressing  The charm (object)                        (trigger, gives, secret)
main/dressing  Residue                                   (gives)
main/exits     → Where this leads
main/dressing  Levers & Landmines — Vashan
main/dressing  Outcomes
side/gm        IF THEY DERAIL
```

Three structural causes, all in `review-ui/public/run-layout.mjs`:

- `inferRunLayout` line 119 sends a person/object WITH checks or a secret
  to the SIDE ("reads best as an interaction card"). That is exactly the
  element the GM has to deliver, and it is the courier-bundle-top-right
  miss.
- `planRunSpread` folds EVERY ungrouped main `dressing` into ONE card
  regardless of what it is — so the charm, Residue, Levers and Outcomes
  become one undifferentiated bullet list after the read-aloud.
- There is no role for "what is happening right now". "Residue" (what
  changes regardless of outcome — a chronicle feed line) is what sits in
  that slot today, and it reads as nothing at the table.

### C1. Vocabulary (run-layout.mjs, `RUN_LAYOUT_VERSION = 5`)

- New role **`now`** — label "What's happening". Main column, slot 2.
  Fields: `looks` (what is in motion right now, present tense) and
  `gives` (what changes because of it — today's Residue content, kept:
  useful but never complete on its own). **Residue is renamed to this,
  not dropped** (Russell 2026-09-09: "if we aren't renaming it, I'd drop
  it"). May be empty when the read-aloud already carries it; the
  renderer skips an empty one.
- New role **`person`** — label "Person". Main column. ONE card,
  nothing split (Russell: "why have the info split?"): `looks` (the
  3-line at-a-glance, see C4), `wants`, `means`, `checks`, `secret`, then
  the **compact stat block inline** in the PHB/MM abbreviated style (AC,
  HP, speed, the six scores in a row, the 3–5 skill mods, attacks) — the
  same `stat`/`bestiaryEntryId` data the side block renders today, in
  the compact renderer the elements-list summary already computes from.
  The side `block` role survives only for unnamed baked enemies
  ("ENEMIES (baked)") that have no description to deliver.
- New role **`object`** — label "Object". Main column. `trigger`, `checks`,
  `secret`, `gives`. (Today an object is a dressing bullet.)
- `dressing` keeps its meaning: incidental colour, one folded list.
- Right-column roles unchanged: `block`, `card`, `gm`, `sketch`, plus the
  map snapshot and objective the renderer already places there.

`ROLE_DEFAULT_COLUMN`: now/person/object → main. `inferRunLayout`: the
side-on-checks rule (line 119) is deleted; a graph person → `person`; an
element whose name matches `/^what.?s happening|^now\b/i` → `now`;
`/\(object\)|^object\b/` → `object`. Explicit `run` still always wins.

### C2. Column order (planRunSpread)

MAIN, top to bottom, with the principle stated in the file header:
*left column = what comes out of the GM's mouth, in the order it comes
out; right column = what the GM reaches for only if something happens.*

1. opening `read` (scene narration text stays above it as today)
2. `now`
3. `person` cards, then `object` cards, in element order (groups honoured)
4. the one `dressing` fold
5. everything else main in element order
6. `exits` last (already the footer)

SIDE, top to bottom: objective (if `objectiveInRun`), map snapshot,
`card`s (optional events), the `gm` fold (linger / derail / fallbacks /
afterward as tabs or sections), `block`s, `sketch`es.

The renderer (`buildRunSpread` / `appendRoleContent` in
session-planner-view.js) needs the two new role builders (person, object)
and the stats-only block variant. Anchored edits only — the file is a
known bulk-edit hazard.

### C3. Prep follows

The run-chip popover role list reads from `RUN_ROLES`, so the new roles
appear on their own. `ROLE_LABELS` feeds the Layout board lane cards.
`wf_set_element_run`'s zod enum in `session-planner/scene-elements.mjs`
(`RunLayout`) must list the new roles or the MCP path rejects them.

### C4. Content rule for people (skill + prompts)

`.claude/skills/scene-authoring/SKILL.md` §2 People, `looks` becomes a
fixed shape, always three lines:

```
<race/ancestry>, <build/age>, <one visual tell>
Mannerism: <one physical habit>
Voice: <one line of how they talk>
```

`prompts/element-assist` draft-fields and `propose-elements` get the same
shape. This is the "describe a person rapidly out loud" requirement — a
layout change alone would put an empty card at the top of the column.

### C5. Migration + tests

- Existing worlds: nothing breaks — v4 records parse unchanged, inference
  only changes for elements with no explicit `run`. Aureus elements were
  mostly explicit (`side/block` for people), so the campaign gets a
  one-shot re-tag script (`wf_set_element_run` per element; campaign
  repo) rather than the app guessing.
- `review-ui/test/run-layout-routes.test.mjs` + a new pure test for
  `planRunSpread` order (read → now → person → object → dressing → exits).
- `run-spread.e2e.mjs`: assert the DOM order of the left column on a
  fixture with all roles.
- README §E rewritten around the two-column principle.

---

## WS-D — Notes in Run + notes read-back + session wrap (feedback 1, 2)

Facts: `mountAddEventControl` (session-planner-view.js:504) has one call
site, the Prep page (line ~5106). Notes POST to
`/api/session-planner/notes` → `session-notes/<world>.json`. They ARE
read back by one path: `assembleWriteupTextForPlan`
(`session-planner/plan-updates.mjs:36`) gathers every pending note across
a PLAN's scenes for the wrap suggester — so the wrap is already
session-grained. What's missing is the Run mount and any place the GM can
SEE notes.

- **D1.** Mount the same control in the Run header (`buildRunSpread` head
  band, beside the activate row) with testid `run-add-event-btn`. Same
  POST, `sceneId` = the scene being run.
- **D2.** `GET /api/session-planner/notes?world=&sceneId=` (list pending
  notes, newest last). A "Notes — this scene" strip at the bottom of the
  Run SIDE column and the Prep page: timestamp + text, delete affordance.
  Render inside the 3 s run poll's rebuild so a note typed on a phone
  shows on the laptop.
- **D3.** Plan page wrap panel: rename its heading to "Wrap the session",
  show "N notes across M scenes" from `assembleWriteupTextForPlan`'s
  counts, and link each scene's count to that scene's Prep notes strip.
  No grain change — making the existing grain legible.
- Tests: route test for the GET; e2e `run-notes.e2e.mjs` (add in Run,
  appears in the strip, survives a poll rebuild).

---

## WS-E — Music baked into scenes (feedback 6)

- **E1.** Lift the "music rows are hand-added only" lock in
  `stagecraft-store.mjs`: the Foundry pull (`foundry-pull-ops.mjs`) lands
  each playlist TRACK as a `kind:'music'` asset, `source:'foundry'`,
  `foundryRef: { playlistUuid, trackName }`, status `proposed`, dedup on
  (playlistUuid, trackName). The ten hand-added local music rows stay as
  they are (no foundryRef → not pushable, still listable).
- **E2.** Scene field `musicAssetId` (nullable) beside `mapAssetId`:
  `scenes.mjs` create/update/fork-inherit, route, `wf_update_scene`.
  Prep band: a "Music: …" chip next to the Stage+map chip, picker filtered
  to accepted `music` assets with a foundryRef.
- **E3.** `composeSceneOps` emits `playlist`/`playlistSound` from the
  linked asset's foundryRef on BOTH create and update paths (so a scene
  already in Foundry can be given music without re-creating it). Skips
  recorded when the asset has no foundryRef.
- Depends on A2. Test: composer unit test pins the two keys; live check
  per WS-A.

---

## WS-F — Token art for named NPCs (feedback 5)

- **F1.** Bestiary row field `tokenImg` (nullable Foundry-resolvable
  path) + a Library input on the row. Convention for where files live:
  `<Data>/gm-tools/tokens/<world>/<slug>.webp` — hand-dropped or
  generated; the app never guesses a path.
- **F2.** Push: `composeSceneOps`'s `tokens[]` already has an `img` slot
  the bridge honours (`buildTokenData`'s `t.img`), so the create path
  carries it with no bridge change. The bestiary push adds an
  `update_actor` (A3) setting `prototypeToken.texture.src` so future
  tokens from that actor — including ones the GM drags from the Foundry
  sidebar — carry the face too.
- **F3.** Generated from the `looks` line (Russell 2026-09-09): a
  `stagecraft/token-art.mjs` one-call image producer (Gemini image model
  via the existing `GEMINI_API_KEY`; reuse whatever image path the
  campaign's `art-descriptions.json` flow already exercises) writing a
  square token-cropped webp to the convention path, review-gated: the
  Library row shows the candidate, GM accepts → `tokenImg` set. Never
  auto-pushed.

---

## WS-G — Box resizing / text jumping (feedback 7)

Measure before touching anything.

- **G1.** `review-ui/test/e2e/layout-stability.probe.mjs` (a probe, not a
  pass/fail test yet): load a fixture scene, then for each transition
  Prep→Layout→Run→Prep→(click into each field kind: looks, means, checks,
  read-aloud)→blur, record `getBoundingClientRect()` for every
  `.scene-field`, `.scene-element-row`, `.rs-box`, the head band, and the
  page scroll height. Emit a diff table: element, transition, Δheight,
  Δtop. Run at 1280 and 1920 widths.
- **G2.** Fix each cause the table names, one commit each, re-running the
  probe. Known candidates to rule in or out: scrollbar appearing/vanishing
  (`scrollbar-gutter: stable`), the map thumbnail loading without
  intrinsic dimensions, textarea vs span line-height/padding mismatch
  beyond what `.scene-field--editing` covers, the `▤ lanes` rail
  toggling width, web-font swap.
- **G3.** Promote the probe to a real e2e assertion: no element's top
  moves by more than N px across any transition on the fixture.

---

## WS-H — Retired bestiary rows stay droppable (found during intake)

Renaming a row "(retired)" keeps `foundryActorRef`, so `eligibleTokenActors`
and the tray still offer it. Add a real `status:'retired'` (bestiary-store
already has proposed/accepted/discarded — retired is "was accepted, keep
for history, never push again"). Tray and `eligibleTokenActors` exclude
it; Library gets a Retire action. Aureus: flip the two "(retired)" rows.

---

## Campaign-side work (repo `/opt/dev/campaigns/aureus`, not the app)

- Rename the 13 pushed scenes to place-and-moment names; push name
  patches. Draft list for Russell's approval before any push:
  - Terms at the Trench Bench / The Wet Survey / The Sermon and the Sand /
    The Kit Table / Where the Dead Go / Fight Night / The Undercard /
    Into the Tunnels (main scenes: drop everything after the dash)
  - variants keep their dash label: "Fight Night — COMBAT: crowd
    scramble", "… — COMBAT: the House at the bay", "The Sermon and the
    Sand — COMBAT: Marek", "Into the Tunnels — COMBAT: the hand-off crew",
    "Into the Tunnels — session end (splash)"
- Re-tag session-one elements to the new roles (person/object/now/
  afterward) once WS-C lands; add a `now` element and the 3-line `looks`
  to every named person.
- Session-one cast ingest (Vashan, the fake charm, Tariq al-Zahabi, the
  second ledger) via `wf_propose_from_writeup` with truth/stance, per the
  ingest runbook — unblocks reveal-state tracking for the charm.
- Set `musicAssetId` on each scene from `notes/alraml-music-draft.md`.
- Token art for Ledger-Man, Tariq, Vane, Marek (after WS-F).
- Delete the stray "Dio - Fixed" actor; remove the retired token from the
  Undercard scene.

---

## Order of work

1. WS-A (bridge) — half a day, unblocks E and F, fixes every future push.
2. WS-B (names) — small; the Aureus renames need Russell's list approval.
3. WS-C (reading order) — the big one; 1–2 days with tests.
4. WS-D (notes) — half a day.
5. WS-H (retired rows) — an hour.
6. WS-E (music) — half a day after A2.
7. WS-F (token art) — half a day after A3, plus art sourcing.
8. WS-G (layout stability) — probe first, then whatever it names.

## Decisions (Russell, 2026-09-09)

1. **Residue** → renamed "What's happening"; content kept and extended
   with present-tense motion. Not dropped.
2. **People**: one card in the left column, description + compact stat
   block together. No split.
3. **Scene renames**: draft list approved.
4. **Token art**: generated from the `looks` line, review-gated.
5. **Music**: one track per scene.

Corrective work first; next week's session prep starts after it lands.
