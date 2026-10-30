# Atlas: the places, depths and passages of a site, as data drawn as maps

**Status:** APPROVED with changes, 2026-10-30 (review page https://claude.ai/artifact/M9BEPPBepKqGYWuiT1sUzV).
Revised after the architect's review (§7). Russell's answers (§8) override anything above them.

Origin: Russell, 2026-10-29/30, planning Aureus session six. His words: "map and gather together what we need to
build out the entire sewer system… use a metamodel of the larger network… then we can build maps of sections of
it using the assets." The proposal page is https://claude.ai/artifact/2w7C4KhfkQaCju2MDjBZs9; he approved the
layered model (q-model) there. Wonderdraft 1.1.8.2 was ruled out: it has no mod or scripting API, and its licence
forbids reverse engineering. He then asked for our own tool in GM_Tools: "Graph is truth for you. [A real map]
would be excellent for me and the players."

## 1. The problem

1. **The table can't see its choices.** Session five's maps were a corridor. The players couldn't tell where the
   sewers went, so they stalled. They need a map they can read, and junctions that say something about each exit.
2. **A city's underground doesn't fit at battle scale.** Aureus is about 2 miles across, roughly 2,000 squares.
   It doesn't fit in Claude's context, in a Foundry scene, or in a Dungeondraft map.
3. **Russell reads maps, not dots and lines.** Claude needs a graph it can query and check. Both have to be the
   same data, or they drift apart.
4. **Battle maps have to join up.** Each section's exits must be where the network says they are.

## 2. Long-term vision

An **Atlas** in GM_Tools, kept campaign-agnostic: the spatial layer under the story graph.

- **The data is the truth; every picture is drawn from it.** The GM plan, the cross-section, the players' survey,
  print copies and each section's build brief all come from one file.
- **Passages are drawn as passages.** Tunnels follow rings, radials and bends. Chambers have shapes. The drawing
  reads as a surveyor's sheet of a real place, not a diagram.
- **Two editors, one file.** Russell drags on a map in the browser. Claude edits through MCP tools without loading
  the whole file.
- **Checks catch nonsense early.** For example, water running uphill, a depth change with no shaft, a section exit
  that leads nowhere, or a survey that would leak a GM secret.
- **The players own a survey that fills in.** It's an image they open in Foundry while deciding. It's re-drawn as
  they hear of, see and walk places, and can show their wrong beliefs too (Sabri's rhyme).
- **Sections become battle maps.** Each section's brief drives a Dungeondraft build with the asset packs, a
  Czepeku map, or a segment composition. Its exits are checked against the network.
- **Later:**
  - a pointcrawl in Run mode (choose an exit, spend the time, roll for the passage's users);
  - region maps (the wastes and the dying holds as a gradient toward the Wreck);
  - several scales per atlas;
  - the composer filling sections from Czepeku segments;
  - Kilmarn's sketch redraw.

**Out of scope for good:** painted Wonderdraft-style art inside GM_Tools. The asset packs can't feed our renderer;
their pack.json says `allow_3rd_party_mapping_software_to_read: false`. Painted art stays in Dungeondraft and
Czepeku, at section scale.

## 3. Architecture

Follows `.claude/skills/gm-tools-conventions`:
- a pure library with thin front-ends;
- Zod, with a `SCHEMA_VERSION`;
- flat JSON;
- no framework and no build step;
- tests run with `node --test`.

### 3.1 Stores (campaign-home; store names `atlases` and `atlas-known`, never `atlas`)

The store `atlases` would land in the library's own folder name if it were called `atlas` (campaign-home.mjs:39).

- `atlases/<atlasId>.json`: GM truth. It is written sorted, like graph-file.mjs, so git diffs stay readable.
- `atlases/<atlasId>.known.json`: what the table knows. `{schemaVersion, known: {id: heard|seen|walked}, log: [...]}`,
  with `log` append-only.
  - **Not narrative-state.** There, no record means fully open (narrative-state.mjs:103); here, no record has to
    mean unknown.
  - narrative-state's revealState is about whether the *truth* has been revealed, not whether the party knows a
    place exists.
  - Its ops refuse ids that aren't graph entities (narrative-state-ops.mjs:43).
  - Three features read every narrative-state record (session wrap, player-notes analysis, element assist).
    Hundreds of atlas records would swamp them.
  - A graph place whose narrative-state is `hidden` is still kept off the survey: the survey reads that state, and
    never writes it.

### 3.2 Data model (`atlas/schema.mjs`, `ATLAS_SCHEMA_VERSION = 1`)

```
Atlas { schemaVersion, id, name, revision, units: "ft",
  frame:   { origin, north, bounds },                        // one frame per atlas in v1
  areas:   [{ id, name, kind, shape: circle|annulus|sector|polygon, geom, wf?, draft? }],
  strata:  [{ id, name, top, bottom, era, what }],
  systems: [{ id, name, who, logic, colour, dash }],          // a colour-blind-safe palette, plus dash patterns
  nodes:   [{ id, name?, kind, stratum, x, y, depth, shape?: {circle r | rect w h rot | polygon},
              systems[], owner?, wf?, tells[], note?, draft?, partyOnly?, standsFor? }],
  edges:   [{ id, from, to, route: straight|arc|radial, path?: [{x,y}], kind, systems[], water, flow, width,
              minutes?, gate?: {kind: sluice|grate|seal|door|collapse|breach, state, controlledBy}, tells[], draft? }],
  sections:[{ id, name, vibe, origin: {x,y}, rotation, sizeSq: {w,h}, sceneId?,
              build?: {kind: dd-layout|composition|asset, ref}, exits?: [{edge, side, order}] }] }
```

- **Shapes and routes are why it reads as a map.**
  - `route: arc` follows a ring and `radial` runs straight out from the centre. Most passages draw this way with
    no hand-routing.
  - `path` holds bend points for the rest.
  - Travel minutes come from the drawn length, unless set by hand.
- **Names.** A node with `wf` reads its name from the graph unless it has one of its own.
- **Claude's additions are drafts.** A new place, passage or hook Claude adds is `draft: true`. Drafts show as
  pencil on the GM plan, and stay out of briefs and the survey until Russell accepts them. Position moves are
  trusted. This is the ✦ convention, and it matches how he treated hooks (q-hooks).
- **Wrong beliefs.** A `partyOnly` node with `standsFor` (Sabri's rhyme placing the Midnight Sea under Bone Row)
  appears only on the survey.
- **Sections are a rectangle at a fixed 5 ft square:** an origin, a rotation and a size.
  - `sceneId` points at the planner scene, which already holds the Foundry reference. Nothing is duplicated.
  - `build` points at what already exists.
  - Exits are worked out from the edges that cross the section's boundary. They're checked by side and order,
    not to the foot, because a network placed to ±100 ft can't match a 155 ft battle map exactly.
  - Section openings reuse the `{line, at, from, to, kind}` shape that composition.mjs and the Dungeondraft layout
    spec already share.

### 3.3 Writes

- Ops address ids and are applied one at a time. The read-modify-write happens inside `withLock`; today the lock
  wraps only the write (review-state.mjs:80). A `ConcurrentWriteError` is retried.
- The browser polls `revision` every 3 s, as Run mode does, and refetches when idle.
- `ifRevision` is required only for replacing the whole file. That way an edit from Claude doesn't break
  Russell's next autosave.

### 3.4 Library (`atlas/`, pure)

| Module | Job |
|---|---|
| `schema.mjs` | Zod schema, version number, migration stub |
| `store.mjs` | load/save, lock, sorted output, the known file |
| `geometry.mjs` | xy↔(radius, bearing), arc and radial routing, path length, travel minutes, point-in-area |
| `query.mjs` | neighbourhood, paths, "what's in this section/area/stratum", LLM-sized summaries |
| `ops.mjs` | add/move/update/remove; accept-draft; **radial remap** (grow or shrink rings by moving everything in a band; this is the "bigger city, thin Suq" op) |
| `lint.mjs` | the checks, each with an id, warn or error, never blocking a save |
| `section-brief.mjs` | section → build brief (session-planner/brief.mjs already exists, hence the name) |
| `survey.mjs` | atlas + known + hidden graph places → the players' subset |

The renderer is shared with the browser. The canonical copy lives in `review-ui/public/atlas-render.mjs`, with no
dependencies, and `atlas/render.mjs` re-exports it. This is the run-layout precedent
(session-planner/run-layout.mjs:1–9). The browser can't import zod.

### 3.5 Front-ends

- **review-ui:** `/api/atlas/:id` routes, plus `atlas-view.js` in Library → Maps (full width, no tray rail).
- **MCP:** `wf_atlas_summary`, `wf_atlas_query`, `wf_atlas_edit`, `wf_atlas_lint`, `wf_atlas_render`,
  `wf_atlas_brief`, `wf_atlas_mark_known`.
- **CLI:** `bin/atlas` (lint, render, brief, survey).
- **Foundry, with no module wave.** Existing bridge ops are enough:
  - `update_journal` updates an image page in place and sets ownership (contract v6, :506);
  - `update_scene` changes a background (:587).
- **How the survey goes out:** re-render it and replace the image.
  - This is the only route that can't leak, because tiles or fog would still ship the full image to every player.
  - A new file name per render gets past Foundry's image cache.
  - Only the players' render is written into Foundry Data.
- **PNG:** Playwright, which is already a dependency. Nothing new.

### 3.6 Tests

- **Spoiler test.** The players' SVG contains no id, name, note or title of a GM-only node, edge or draft. It's
  checked structurally, not by eye.
- **Render tests** assert on a list of what was drawn (paths, labels, layers), never on pixels.
- **Editor e2e** uses Pointer Events in Playwright, at phone width too.

## 4. Track 0: session six, now, with today's tools (campaign repo only)

This runs before S0 and doesn't wait on the Atlas.

1. **Re-lay Under the well and the siphon bay in place.** Both are pushed scenes, so neither is recreated. The
   re-lay keeps:
   - the jug-lock piping and level panel, with the walls keyed `door:c-8` and `door:float-gate`;
   - the water overlays `water:8/5/3` and the 31×28 footprint at 100 px per square;
   - the tokens: the PCs and Jabir at (2500,600).

   Built in Dungeondraft with the packs. Russell's OK is needed before the push.
2. **Survey v0.** The party-known part of the draft network, in a quick ink style, as a players' journal image.
3. **Exit tells.** Draft exits elements on the session-six scenes from the network's tells (which way the water
   runs, whose marks are on the wall, what you hear).

Est. 1.5–2 days. Nothing here is thrown away later: the Atlas sections point at these builds (`build.ref`) rather
than regenerating them.

## 5. Sprints

Each sprint ends with a review page, and the next starts only after Russell answers. Estimates are Claude
working days and include a fix round.

| # | Sprint | Est. | Ends with |
|---|---|---|---|
| S0 | **Contract.** Schema v1 (shapes, routes, paths, sections, drafts, beliefs), the known file, a converter from the draft JSON (lives in the campaign repo), a made-up generic fixture for GM_Tools tests, the lint list, red tests | 1 | Page: the schema in plain words, the checks |
| S1 | **Library + MCP.** geometry, query, ops including radial remap and accept-draft, lint, the `wf_atlas_*` tools, CLI, one-at-a-time writes | 1.5 | Claude answers real questions about Aureus from summary and query alone |
| S2 | **The look.** Renderer in two or three treatments on one design canvas (recommended: a surveyor's sheet in ink with hatching, depth soundings and a cross-section strip; plus a coloured atlas style). Auto-routing, label placement, legend, PNG, spoiler test | 2.5–3 | Canvas: Russell picks a treatment |
| S3 | **Survey live.** Mark heard/seen/walked (MCP + a small panel), re-render, push as a journal image | 1 | Live at the next session |
| S4 | **Editor-lite.** Pointer Events with capture, viewBox zoom at the cursor, drag places and bend points, click to add or connect, property panel, system and depth toggles, undo, autosave. **Plus ring and area handles** (circles and annuli) so Russell can resize the city himself; polygons later. Style filters off while dragging | 2.5 + 1 fixes | A hosted try-out |
| S5 | **Aureus v1 with Russell.** He sets the city (bigger, thin Suq) in the editor; Claude fills the seven systems as drafts; he accepts them; lint clean | 1 + his time | Accept frame and network |
| S6 | **Sections.** Frame, exits worked out from edges, `section-brief.mjs`, exit check against existing builds, exits elements from tells | 1.5, + 0.5–1 per section built | Briefs + one new build |

**Total:** about 13–14 days plus section builds, spread over sessions with review gates. Track 0 is extra
(1.5–2).

**Later, not estimated:**
- the full editor (polygons, gate UI, drawing paths freehand);
- the pointcrawl in Run mode (after the survey has been used for two sessions; the world clock counts only days
  today);
- region maps and more than one scale per atlas;
- the composer;
- Kilmarn.

## 6. Risks

- **The look is the make-or-break.** If no treatment satisfies "a real map", the editor doesn't matter. That's why
  S2 is a canvas pick before any editor work.
- **The editor has a history.** graph-view.js needed fix rounds in Phases 13, 14 and 20, for event-order bugs that
  only showed up in a browser. Reuse its lessons and its e2e pattern, not its code: it has no node drag, uses
  mouse events only, and zooms by resizing.
- **Survey spoilers.** Guarded by the structural test, by drafts staying out, and by hidden graph places staying out.
- **Track 0 re-lays live scenes.** Keep the puzzle keys and tokens, re-lay in place, and push only with Russell's
  OK.
- **Licence wording.** map-recombination-and-dungeondraft.md still says "default assets only"
  (map-recombination-and-dungeondraft.md:119), while the packs are now in use. Reconcile it in writing during S0.

## 7. Architect review (2026-10-30) and what changed

The review's verdict was "build with changes". Adopted:

| Review point | Change |
|---|---|
| The model could only draw dots and lines | Added `route`, `path` and node `shape`; travel time from path length |
| The look came last (S8) | Moved to S2 as a canvas pick |
| The survey came too late, and needed no module wave | Survey v0 in Track 0; S3 is the live survey via `update_journal`/`update_scene`; no module wave |
| narrative-state was the wrong home for "known" | Its own known file; hidden graph places are only read |
| A 3-day editor was unrealistic | Editor-lite, 2.5 + 1 for fixes, on Pointer Events |
| Track 0 touches pushed, tokened scenes | Re-lay in place, keep the keys and tokens, `build.ref` instead of regenerating |
| ifRevision on every write was the wrong shape | Per-op writes inside the lock; ifRevision only for whole-file replaces |
| Smaller points | store name `atlases`; renderer shared via review-ui/public; drafts; `sceneId` only; the shared openings shape; one frame; radial remap; converter in the campaign repo; `section-brief.mjs`; `wf_atlas_*`; spoiler and render tests; the licence note; S7 pointcrawl deferred |

Where I differ from the review:

- **Area handles are in editor-lite.** The review left area editing to Claude through MCP. Russell asked for a
  tool he can place the city with himself ("this is where… some actual mapping tool would help me"), and resizing
  the rings is the first thing he'll do. Circles and annuli are cheap; polygons wait. +0.5 day.
- **The canvas offers a coloured atlas treatment beside the surveyor's sheet.** The review recommends the sheet,
  and so do I, but Russell's reference point was Wonderdraft, so he should see the alternative before choosing.

## 8. Russell's answers (2026-10-30) — these override the sections above

- **q-plan: approved with changes.** "I also want to minimize by hand adjustments. I'd rather do some designer
  style interaction where you suggest and I provide feedback, maybe circling or identifying a region or element to
  change." **S4 is no longer a drag editor.** It becomes a **markup page**: the rendered map, where he circles a
  region or taps an element and writes a note; the notes are saved, Claude reads them and makes the change through
  the ops, re-renders, and the next page shows before/after. q-editor agrees: "even lighter".
- **q-start:** Track 0, then S0.
- **q-style:** surveyor's sheet only (ink, hatching, soundings). The S2 canvas shows variations within that style.
- **q-channel: the survey is its own Foundry scene**, not a journal image. Re-render and replace the scene
  background (`update_scene`). The planner creates the scene; the atlas lays the image in.
- **q-pushok:** standing OK for survey pushes, with a confirm button each time.
- **q-reveal:** heard / seen / walked. **q-belief:** yes, wrong beliefs show on the survey.
- **q-drafts:** new places and hooks are drafts; moves are trusted.
- **q-pointcrawl:** deferred. His note: if it means moving between battle maps along the network, "we should just
  get [it] for free along the way" — sections' exits linked to edges give that.
