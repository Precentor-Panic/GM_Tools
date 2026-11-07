# Map quality — critique and plan

v2, 2026-11-03: revised after the GM's answers on the review page (link in memory, `map-quality-plan`). Supersedes
the "layout engine" sprints in `map-recombination-and-dungeondraft.md`; that file stays the record of the segment
library and the wall-detection research, which stays paused.

## What the GM asked for

- Maps that immerse players and play well, "nearly as stunning as the czepeku maps".
- Square, rigid shapes when they're right; organic and irregular shapes when they're right.
- Deterministic tooling (algorithms, checks) so quality doesn't depend on Claude typing coordinates.
- The table workflow he knows: rifle through map sheets, pick one that's close, drop minis on it. Czepeku maps are
  bespoke and hard to drop in; rifling through thousands of files is too slow.
- Keep the discussion loop with Claude. Show a sample set of maps across a wider range of themes.

## His answers (2026-11-03)

- The critique matches what he sees.
- Order: the plan format first, then the shelf. His note: he likes the shelf and wants Czepeku walls out of Foundry
  data "or something else". Dungeondraft is heavy for this laptop; a better machine is coming, but don't plan on it.
  "Be clever": from the rough shape of the map wanted plus the Czepeku walls, make a quick shelf lookup. "Building an
  understanding for what makes the map (format?) and how to define its character makes the shelf useful."
- Sample set: the eight proposed plus a tavern interior.
- Ceiling: very good Forgotten Adventures-style maps (light, edges, composition), but "don't shut the door on the real
  art path with your development choices".
- Czepeku in the shelf: yes, local search plus prop overlays.
- Start: yes, with his notes taken in.

## Correction

The v1 page said only 7 of 361 Czepeku packs ship walls. That counted the packs installed at the time. The wall
research fetched each pack's Foundry scene data: 344 packs, **1,157 scenes with walls** (about 1,030 distinct
layouts), 213,888 walls, 3,335 doors, 24,494 lights, all on this machine as numbers
(`.claude-archive/2026-10-26-wall-research/extra/<pack>/scenes.json`). So the walls are already out, without
Dungeondraft and without looking at the art.

## Design rules taken from his notes

1. **Geometry is the map; art is a layer.** A map is its format (areas, walls, doors, lights, marks). Any image aligned
   to its grid can sit under it: a Dungeondraft render, our own preview, a Czepeku map found by shape, or later a
   painted pass on a better machine. Nothing in the format assumes Dungeondraft, so the real art path stays open.
2. **Light on this laptop.** The format, the profile, the shelf lookup and the play check are pure code (Node, plus
   numpy/PIL where images are involved). No GPU. Dungeondraft is only for final art, run in batches, never in the loop
   for a check or a search.
3. **Character, then lookup.** Every map, ours or Czepeku's, gets a character profile computed from its walls: size,
   how enclosed, rooms and their sizes, the room graph (loops, dead ends), how square or organic the walls are,
   openness and sightlines, doors and exits, light density, and a small footprint picture. A rough shape (a brief, a
   sketch, or a plan) gets the same profile, and the shelf returns the nearest maps.

## Evidence (measured on our own Dungeondraft maps; no Czepeku art left the machine)

- Long gallery: 1,014 of 2,128 squares are floor (48%); the rest is one flat rock fill.
- Dressing density per 10 squares: Room 8 0.3 (8 objects on 240 squares); the rooms dressed for the aftermath 2.5–3.2.
- Play lint spike: 43% of floor squares exposed (wide view, no cover within one square), 28% with cover within one
  square, longest sightline 44 squares, room graph 14 rooms / 14 links / 1 loop, dead ends at rooms 3, 5, walkway.
- Finishing-pass spike: a blanket multiply on the flat PNG goes muddy; the real pass needs layered exports.
- Shape spike: raw cellular automata give swiss cheese; the same cave carved from a 5-node brief reads as a place.
- Why the maps are square: the spec, not Dungeondraft (shaped rooms can't take doors or inner walls; every map so far
  is hand-typed coordinates). Spike sources: `.claude-archive/2026-11-03-map-critique/`.

## The critics (short form; the review page has the long form)

| Critic | Verdict |
|---|---|
| Battlemap illustrator | Legible and correct, not yet beautiful. The gap is light, edges and the frame, not assets. |
| Encounter / level designer | A route, not a battlefield. The checks that would show it are cheap and deterministic. |
| Procedural-generation researcher | There's no generator yet. Fix the representation first; then a shape-maker per material, driven by a brief. |
| Veteran table GM | Good for set pieces, too slow for "they turned left". Build the shelf: browse, pick, dress. |
| Foundry technician | Our maps have exact walls. Keep geometry the source of truth; bake shadow, not light. |
| The player's seat | Players see light, walls and what stands out. Exits, interactables and landmarks must read through fog. |
| Skeptic | Don't build a generator empire while the table needs maps. Be honest about the ceiling; the GM's eye is the gate. |

## Plan (v2)

Each sprint ends with a review page that re-makes the benchmark set, scored, so progress is comparable. The next
sprint starts after his answers.

| Sprint | What | Where | Size |
|---|---|---|---|
| S0 | **Benchmark and baseline.** Nine generic briefs; a rubric (look, play, fit, speed); today's maps profiled as the baseline. | `map-plan/bench/` | 1 |
| S1 | **The map format and its character.** Plan schema (areas, walls, doors, lights, marks; versioned). Readers for our `.dd2vtt` exports and Foundry scene walls (both wall eras). Walls → rooms and room graph. The character profile and a similarity measure. An SVG preview with no Dungeondraft. Unit tests on synthetic fixtures only. | `map-plan/` | 2 |
| S2 | **The shelf index.** Profiles for the 1,157 walled Czepeku scenes and our maps, stored locally (never in git). Query by brief, by rough shape or by "like this map". A local review in GM_Tools, since Czepeku art can't go to a cloud page. | `map-plan/`, `bin/map-shelf`, `stagecraft/` (ignored) | 1–2 |
| S3 | **Shape-makers.** Masonry with irregularity, cave from a brief, wear and collapse, all emitting the plan format; compile to Dungeondraft (polygon floors, explicit wall lines, doors) in batches. | `map-plan/makers/` | 2–3 |
| S4 | **Play check and dressing.** The profile grows the play check (exposure, cover, chokes, travel time, exit and interactable legibility, repetition), with targets per scene type; dressing by use and story. | `map-plan/`, `scatter.mjs` | 2 |
| S5 | **Finishing pass.** Layered exports (floor, objects, lights) → shadows, light pools, frame, grade, WebP. The same pass takes any art layer. | `tools/finish.py` | 1–2 |
| S6 | **Outdoor and street makers.** Height field → cliffs and ledges, rivers and roads, lots along streets, hulls. | `map-plan/makers/` | 2–3 |
| S7 | **The shelf at the table.** Flip-through in the Library's Maps tab, one click to lay a map (with its walls) into a scene, story props as movable tiles, our own sheets alongside Czepeku's. | review-ui, bridge | 2–3 |
| S8 | **Brief to map in conversation.** Claude writes the brief with the GM, not coordinates; the makers build it, or the shelf finds it; circle-and-note marks adjust it. | skill + MCP | 1–2 |

## Benchmark set

Sewer junction · cave with a river and a ledge · desert wash ambush · crooked night market · temple hall · ruined
fort, overgrown · ship at a dock · forest or swamp clearing · tavern interior.

## Rules

- **Other people's IP never enters this repo** (it is public). No Czepeku, Forgotten Adventures or DnDungeon images,
  pack files, catalogues, wall extracts or profiles computed from them, and no download links. Czepeku-derived data
  lives under `stagecraft/` (ignored) or outside the repo. Test fixtures are synthetic. Run `bin/ip-check` before
  every commit in this work, and `bin/ip-check --push` before every push: it reads every version of every file the
  push would send, not just the tip. A file named for a map vendor counts as their data whatever it holds.
- Found by the first `--push` run (2026-11-03): a segment spec for a Czepeku sewer map (our room cuts plus their
  image file names) had been committed on the unpushed `atlas` line. It was removed from that history before the
  first push and kept under `stagecraft/map-segment-specs/` (ignored).
- Never send Czepeku art to a cloud service; FA and DnDungeon renders on private review pages are fine. Wall drawings
  derived from Czepeku scenes count as Czepeku data until the GM says otherwise.
- Packs are read only through Dungeondraft's catalogues and the index. Never decompile the `.pck`.
- GM_Tools and the Dungeondraft tooling stay campaign-agnostic; the benchmark briefs are generic.
- Wall detection on painted maps stays paused (his call, 2026-10-29). Reading walls Czepeku authored is not detection.
- No push to Foundry without his pick; never recreate a pushed scene.

## Status

**S0 + S1 built 2026-11-03** (branch `map-quality`), awaiting the GM's review.
- `map-plan/plan.mjs` (plan v1), `readers.mjs` (dd2vtt; Foundry scenes, both wall eras), `profile.mjs` (profile v1),
  `similar.mjs` (distance, brief ranges, nearest), `svg.mjs` (preview), `bench/briefs.json` (nine briefs with `want`
  ranges and theme `words`). `bin/map-profile`. Tests: `test/map-plan.test.mjs` (11, synthetic fixtures).
- Baseline: our seven Dungeondraft maps profiled (all near-square: squareness 0.74–1.0).
- The 1,157 walled Czepeku scenes profile in 24 s on this laptop into `stagecraft/map-shelf/profiles.jsonl` (ignored).
- Found while validating: walls on the map's own edge fell off the grid (fixed); "enclosure" as share of open floor
  counted the rock round a dungeon as floor (now the share of the map's area, less walls, inside rooms); published
  walls stop short by up to half a square (closed before finding rooms); Czepeku maps are scenes, a building in its
  surroundings, so briefs like "tavern" target the largest building (`building` in the profile).
- Lookup: shape alone is ambiguous across 1,157 maps; theme words from pack and scene names plus shape works for most
  briefs. Open for S2: variants crowd the results (dedupe by layout), the market brief favours shops, and the sewer
  brief has only 3 named matches because the installed sewer pack isn't in the fetched set.

**S1 review answers (2026-11-03):** the profile mostly fits; he picks by "room size, contents, theme, and that sort of
shape factor". The lookups question wasn't clear ("provide a more clear example"). Wall-line drawings of Czepeku
scenes may go on private review pages (lines only, never the art). Push: yes, "make double sure" nothing leaks. S2:
after the changes in his notes.

**S2 part 1 built 2026-11-03:**
- The character speaks his four words. Room size in bands (closet < 9, small < 36, medium < 100, large < 300, hall).
  Theme (place, terrain, mood, inside/out) from names via `map-plan/vocab.json` + `theme.mjs`. Contents from placed
  objects (plan `items`; our layout specs) and from the picture.
- Pictures are read on the laptop by `map-plan/tools/look.py` (CLIP ViT-B-32, CPU, optional venv): per-room content
  phrases, map place/terrain, and an embedding for description search. About 50 minutes for the 1,157 pictures the
  wall research saved. Output only under `stagecraft/map-shelf/`. Measured: on our maps the top three contents per
  room held 19 of 50 known kinds (~3x chance; ViT-B-16 21, ViT-L-14 23 at 2.5x / 10x the time). Against Czepeku's own
  names the picture's first terrain guess matches about a third of the time, top three over half; places about one
  in ten, a third. So names count in full, picture guesses by rank (`RANK_CREDIT`), and theme gates the fit.
- `shelf.mjs` groups variants into layouts (1,164 maps, about 590 layouts), writes a character card in words, and
  answers a brief by shape, theme, contents and picture, with what matched. `bin/map-shelf` (brief, like, text, card,
  html) and a local page (`map-plan/shelf-page.html` → `stagecraft/map-shelf/shelf.html`) with thumbnails and wall
  lines over them, local only.
- Still open: the installed packs (sewer and others) aren't on the shelf; the sewer brief stays weak until they are.

**S2 review answers (2026-11-03):** he couldn't mark the shelf's picks from wall drawings: "I can't see the vibe.
Seeing is believing." He'd pull the "western, indoor" folder from the filing drawer and look at the actual maps. The
shelf page: not tried yet. Next: S3. "The shelf at table is not the workflow I envision. I'm prepping beforehand.
This doesn't need to be super fast turnaround. Just high quality." So S7 as planned is dropped, and every map review
shows the real art.

**S3 built 2026-11-04 (makers):**
- `map-plan/makers/`: the canvas and tracer (masonry snaps true, rough edges smooth, shared outlines exact, doors cut
  into walls, ledge edges, wall materials), the masonry kit, wear, turning; recipes for the tavern, temple, ruined
  fort, sewer junction and river cave. `bin/map-make`. `writers.mjs` (plan to Universal VTT). Tests:
  `test/map-makers.test.mjs` (determinism, true walls, recipes near their briefs, wear, turning, profile v3).
- Profile v3: a space that only leaves the map through a mouth or tunnel is a room; a solid mass a room runs round
  counts as a loop; a plan with areas counts only its open ground as outside floor (the rock round a dungeon never).
  The shelf was re-profiled (1,381 maps; the installed sewer pack now has 22 walled scenes).
- Briefs v3: the fort's enclosure and the sewer's enclosure and rooms were S0 guesses the made maps proved wrong.
  Published maps are walled lightly for Foundry (most have no loops and few doors), so their numbers describe the
  shelf, not a target for a made map.
- The Dungeondraft tooling (outside this repo) gained explicit walls and doors in a layout spec, a plan compiler and
  themes (asset-pack names), and a fix to its boot wait after a pack load. Each map builds in about a minute once the
  packs are loaded.

**S3 renders checked 2026-11-06:** all five recipes, two seeds each, rebuilt in Dungeondraft and looked at before
review (FA and DnDungeon renders only). The look found, and the build fixed: FA window frames are only the jambs
(DnDungeon windows carry frame and glass); colourable sacks and bedrolls drawn in raw paint colours; the only puddles
in the packs are blood (the colourable ones, now coloured as water); a counter stretched past its own thickness (now in
pieces of three squares and a return); the sewer without its south drain left a third of the map as rock (the map now
stops below the junction); the cave's camp went to the smallest chamber (now the den, the shrine gets a statue); the
ford's stepping stones sat under the water layer; the ruined fort's yard was bare dirt (now patches of grass and
weeds); the barracks' bunks were double beds and the chapel statues were wing add-ons (asset lookups by plain words that picked the wrong type). Forgotten Adventures art fills about two thirds of its named footprint, so objects at their footprint size read at real-world size; a counter's pieces are sized by the share they fill so they meet. Sewer seeds 1-3 all skip the south drain, so the review shows seeds 1 and 4. Dungeondraft holds about 5 GB
after ten maps; the batch closes it at the end.
