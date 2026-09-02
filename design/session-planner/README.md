# Handoff: GM_Tools — Session Planner, World Graph, Chronicle, Library

## Overview

Four UI surfaces plus one shared menu for the GM_Tools TTRPG session-planning app (`panic-mw/GM_Tools`, branch `master`):

1. **Session Planner** — plan shelf → plan runsheet → the scene page (the Phase 28 "one edit-in-place page that reads like a printed module"), plus a Wrap-up review panel.
2. **World Graph** — a containment-tree-first replacement for the current force-directed graph view, oriented around *"where things are in the world"*, loose-thread triage, and feeding the session planner.
3. **Chronicle** — passage of time. Deferred intents, a fortune track, scoped world mutation, and a review-gated diff of what changed.
4. **Library** — four tabs: Bestiary, Hero's Hall, Reliquary (items), Stagecraft (maps / splash art / music). Everything a scene can be given that isn't authored prose.
5. **Connection Menu** — a shared top-bar component on every page: Foundry connection state, live sync, lore intake, intake history, review gating.

These replace / complete the Phase 28 (28.2, 28.3, 28.4) and graph-view work. They were designed against the real data model in the repo — `session-planner/scene-elements.mjs`, `session-planner/plans.mjs`, `session-planner/scenes.mjs`, `plans/phase-28-tasks.md`.

## Why four pages and not one

The pages are not feature silos — they are four **working postures**, and the same objects show up in more than one of them on purpose:

| Page | You are… | Time horizon |
|---|---|---|
| Session Planner | preparing or running *tonight* | this session |
| World Graph | recording what exists and where | continuous |
| Chronicle | moving the world between sessions | months |
| Library | reaching for a thing to put in a scene | instant |

The Library looks self-sufficient because it carries the **scene tray** — the drop target that appears on every page. That tray is the app's one cross-cutting gesture (*find a thing → hand it to a scene*), not a Library feature. It is shared UI, not duplicated UI: implement it once.

The honest overlap to resolve in code: the Bestiary and the Reliquary/Stagecraft shelves are the same list-with-tags pattern, and the Chronicle diff, the Wrap-up panel, and the Connection Menu's intake review are **the same review-gated proposal component** with different sources. Build one of each and reuse.

## Reading this bundle

Each `.dc.html` opens standalone in a browser and seeds its own fake campaign in memory — that is a prototype convenience, **not** the intended architecture. In the real app there is one store (graph nodes, scenes, plans, assets, connection state) and these are four views over it. Do not port the per-file seed data or the per-file copies of shared state.

Give a developer (or Claude Code / Codex) the **whole folder**, not one file: the README is the spec, and the pages only make sense against each other.

## About the Design Files

The files in this bundle are **design references created in HTML** — prototypes showing intended look and behaviour, not production code to copy. `Session Planner.dc.html` and `World Graph.dc.html` are single-file streaming components with an inline logic class; they carry seeded fake campaign data in memory and no persistence.

The task is to **recreate these designs in `review-ui/public/`** using that codebase's established patterns: vanilla ES modules, direct DOM construction, `data-testid` attributes, `createFlushableDebounce` for autosave, `style.css` design tokens, hash routing via `app.js`'s `parseHash`. Do **not** introduce a component framework — the frontend-architecture study in `CLAUDE.md` explicitly concluded against it.

## Fidelity

**High-fidelity.** Colours, typography, spacing and interaction states are final. Recreate pixel-accurately, but express the values through `style.css` tokens rather than inline styles (the prototypes use inline styles only because of how they stream).

---

## Screens / Views

### A. Plan shelf — `#plans`

Full-width content area, `max-width: 900px`, padding `34px 40px 60px`.

- H1 "Session plans", Spectral 30px/500. Sub-line 13.5px, `oklch(0.50 0.012 70)`: "Every plan is an ordered run of scenes. Scenes are shared by reference — reusing one here doesn't fork it."
- Grid `repeat(auto-fill, minmax(280px, 1fr))`, gap 14px.
- **Plan card**: 1px border `oklch(0.87 0.010 80)`, `border-top: 3px` accent when active, radius 4px, background `oklch(0.985 0.005 85)`, padding `16px 16px 14px`. Title Spectral 18px/500. Meta line IBM Plex Mono 10.5px. Then the scene list — mono two-digit index + scene name, 12.5px rows, gap 4px. Hover: border → `oklch(0.70 0.030 185)`.
- **New-plan card**: 1px dashed `oklch(0.80 0.010 80)`, min-height 130px, centred "+ New plan". Hover turns border and text to the teal accent.

### B. Plan runsheet — `#plans/<planId>`

`max-width: 860px`, padding `32px 40px 80px`.

- Mono kicker "RUN SHEET" (10px, `letter-spacing: 0.1em`, uppercase).
- Plan title: `contenteditable`, Spectral 32px/500, `max-width: 20ch`. Blur → rename.
- Meta row 12.5px: "N scenes · est. M min" · "Delete plan" (hover → `oklch(0.50 0.13 25)`).
- **Scene rows**, separated by 1px top borders, padding `15px 12px 15px 6px`:
  - Mono two-digit index, 12px, `oklch(0.65 0.012 70)`, 20px column.
  - Scene name Spectral 17.5px; place name in mono 10px uppercase teal `oklch(0.50 0.075 185)`; element meta mono 10px "N elements · K key"; objective 13px `oklch(0.48 0.014 65)`, `max-width: 60ch`.
  - Right controls (22×22 hit targets): ↑ ↓ ✕. ✕ = **remove from plan** (unlink only, scene survives) with an undo toast.
  - Active row background `oklch(0.935 0.014 185)`; hover `oklch(0.925 0.009 85)`.
- **+ Add scene** → inline panel (never a modal): a wrapping row of place chips (pill, 1px border, radius 20px), plus a dashed "＋ New place…" chip that reveals a name input + "Create place" button. Creating a place writes a `place` node to the graph, then "Create scene" anchors a new scene to it and appends it to the plan.

### C. Scene page — `#session-planner/<sceneId>`

Centred column, `max-width: 780px`, padding `34px 30px 90px`.

Sub-bar above it (height ~40px, background `oklch(0.945 0.009 85)`, 1px bottom border): `← <prev scene name>` / `<next scene name> →`, then right-aligned the ONE three-way **Prep | Layout | Run** segmented control (variants round, 2026-09-01 — the old Page|Layout + Prep|Run pair collapsed into it; testids `mode-prep-btn`/`layout-board-btn`/`mode-run-btn` kept, `layout-page-btn` retired; the nonsense "board under Run" state is gone), the **▤ lanes** rail toggle (Prep only — below), and the **✦ Wrap ▸** button (1px border `oklch(0.68 0.09 65)`, text `oklch(0.42 0.09 65)`). The view persists across scene nav within a world, resets on world change / leaving the planner.

**Layout rail** (`▤ lanes`, variants round O1): a ~220px sticky column of mini lanes (Main/Side/Off, names-only cards; a grouped cluster shows as ONE stack entry, lead + `⊞ N`) disclosed BESIDE the Page rows, so organizing doesn't leave the writing surface. Every element row's ◆/◦ glyph doubles as a drag GRIP (only the glyph is draggable — click-to-edit and text selection in the row are untouched); dropping a grip or a rail card into a lane runs the SAME lane-model persist the board uses (`createLaneModel`, one contract, never two). Closed by default (`display: contents` keeps closed-layout byte-identical); hidden at ≤760px and in board/Run.

Body, in order:

1. Mono uppercase place label, teal, 10px, `letter-spacing: 0.11em`.
2. Scene name — `contenteditable`, Spectral 34px/500.
3. Objective — `contenteditable`, 14px, `oklch(0.47 0.014 65)`, `max-width: 62ch`.
4. **The place** — the anchor place's `description`, shown as a 76px mono label + editable value in a grid, bounded by 1px rules top and bottom. Editing writes back to the *graph node*, not the scene.
5. **Missing-description banner** (when the place has no description): 1px `oklch(0.80 0.070 65)` on `oklch(0.96 0.030 65)`, radius 4px, a mono `!` glyph, copy: "This place has no description in the graph. Read-aloud and dressing suggestions have nothing to draw on — *write one now*." Clicking seeds an empty description and focuses it.
6. **Read aloud** — 2px left rule `oklch(0.72 0.055 185)`, padding-left 18px. Mono uppercase label; body Spectral italic 16px (20px in run mode), `line-height: 1.55`, `contenteditable`.
   - When empty **and** the place has a description: a ghost link "✦ Draft this from the place description and the objective" (12px, teal). It composes description + objective into the narration, undoable. When the place has *no* description the link is hidden — the banner covers that case.
7. **Elements** — mono uppercase label + "N · K key".

#### Element rendering

*(Cards layout removed 2026-08-31, persona round + Russell: with Run as the
real formatted view the Cards grid was wasted space. The control is now
**Page | Layout**.)*

**Page layout** (default): rows separated by 1px top rules, `border-left: 2px` (accent `oklch(0.62 0.10 65)` for KEY, transparent for MUNDANE), padding-left 12px.
- Header line: glyph (`◆` amber KEY / `○` grey MUNDANE), name (`contenteditable`, Spectral — KEY 18px/600, MUNDANE 15px/400), a mono uppercase entity-type badge for KEY (`oklch(0.88 0.050 65)` bg), then right-aligned `⭑` promote/demote and `✕` remove.
- Field lines: `grid-template-columns: 76px 1fr`, gap 12px. Label mono 9.5px uppercase right-aligned `oklch(0.60 0.012 70)`; value `contenteditable`, KEY 13.5px `oklch(0.31 0.015 60)`, MUNDANE 12.5px `oklch(0.46 0.014 65)`, `min-height: 20px`.
- **Only fields with content render.** Below them, a wrapping row of dashed pill chips — `+ TRIGGER`, `+ GIVES`, `+ LOOKS`, `+ MEANS`, `+ CHECKS`, `+ FUNCTION`, `+ WANTS`, `+ SECRET`, `+ STAT BLOCK` — one per unfilled field. Clicking a chip opens an empty editable line for it. This is the *only* way to add a field; there is no form.
- **Field labels are role-aware** (Phase 4, persona round): the label a field line/add-chip shows comes from `runFieldLabel()` in `run-layout.mjs` — the SAME mapping the Run spread prints — so a card-role element's Looks field reads **EFFECT** in Prep too (card: gives→Phrase, looks→Effect, means→Alternate, secret→Failure; read: means→GM). One table; edit it there and every surface follows.
- **Draft marking** (Phase 4, persona round): fields written by a ✦ assist carry `element.draftFields` until the GM edits them — Prep shows an amber ✦ on the label + a dashed rule under the value (`.pf-line[data-draft]`), Run shows a quiet `✦ draft` pill on the element's card/heading. Any ordinary save of the field clears its mark (editing IS reviewing); model output is never indistinguishable from the GM's own prep.


**Run chip** (2026-08-26, both layouts): after the name, a quiet mono pill reading `column · role (· variant) (· ⊞ group)` — the element's placement in the Run spread (§E). Dashed + prefixed `auto ·` when inferred from the name rather than set; amber border for `side`, struck-through for `off`. Click → a small popover (Column ×3 radios, Role ×8 radios, Variant text, **Group** text with a datalist of the scene's existing group names — read off sibling chips' `data-group` stamps, no extra fetch — **Save** / **Auto**) writing `element.run` through the ordinary element patch route; **Auto** clears it back to inference; saving with the Group field emptied clears just the group (`run` replaces, never merges). Hidden in Run with the rest of the edit chrome.

**Layout board** (`Layout` in the three-way control, 2026-08-26; group gestures 2026-09-01): replaces the rows with two lanes — **Main** (3fr) | **Side** (2fr) — and an **Off** shelf below. One compact card per UNGROUPED element (Spectral name, run chip, first ~72 chars of its primary field; KEY cards carry the entity-type colour on the left rule, seeded placeholders are dashed); a GROUP renders as one **stack card** (dashed-amber rule): lead on top, a tab-preview chip row of its variant names, and the other members as individually-draggable sub-rows. **Drop a card ONTO a card's middle band to JOIN its group** (`.layout-card--join-target`, dashed amber): the target's group, or a fresh one slugged from the target's after-dash name; the joined element takes the target's column and lands right after the group's last member. **Drag IS how a state is added** (the "+ variant" chip was cut — Russell, 2026-09-01: make the state element with + element in Prep, then drag it on): a variant-less element joining a group that already has states gets a variant derived from its after-dash name; joining an untabbed card stays a plain combine, and clearing a member's variant in the chip popover demotes a state to an always-shown section. **One layer deep, always**: a multi-member stack dragged by its lead never lights a join target — the drop falls through to reorder (the run.group data model cannot nest; the gesture honors it). A member sub-row dropped on LANE space splits it off (group cleared, placed at the drop point); dragging a stack's card moves the whole group. Card edges still mean reorder; `↑ ↓` and the `in main | → side | → off` select stay as the keyboard path (acting on whole entries). Every move persists as: patch `run.column` on each moved element that changed, then `POST …/elements/reorder` with the FULL id order (main ⧺ side ⧺ off, stacks contiguous) so `order` stays one global sequence — all through the shared `createLaneModel`, which the Prep rail reuses verbatim. Toolbar: hint text + **Infer layout for untagged** (`POST …/run-layout/infer` — writes explicit `run` only where absent, never overwrites). Entering/leaving the board re-renders the list (it is a different DOM).

**Seed run skeleton** (ghost link beside `✦ propose elements here`, 2026-08-26): `▤ seed run skeleton` → `POST …/run-layout/seed` creates placeholder elements for every spread role the scene lacks, by `scene.kind` (narrative: read-aloud, 3 dressing, 2 beats, GM note, exits; combat adds Enemies + Sketch; transit: read, beat, exits), falling back to the name prefix. Placeholders (`run.placeholder`) render dashed with a `· fill me` suffix in Prep, are hidden in Run while empty, and drop the flag on their first real edit. Idempotent by role.

#### Stat blocks

Any element can carry one (`+ STAT BLOCK` chip, or the **▣ NPC or creature** button which creates a scene-local element with an open, empty stat block).

Disclosure line: `▸ <statblockRef>  ×N`. Open panel: 1px border, `border-top: 3px solid oklch(0.55 0.11 40)`, background `oklch(0.985 0.008 75)`, padding `12px 14px`.
- Header: element name Spectral 15px/600 in `oklch(0.38 0.11 40)`; right-aligned `− N +` count stepper.
- Four editable boxes in a `repeat(4, 1fr)` grid: **AC / HP / Speed / CR** (mono 12.5px on white, 1px border, radius 3px).
- A single `contenteditable` mono 11.5px `white-space: pre-wrap` block labelled "Paste the rest — abilities, traits, actions". This is deliberately free text so a DM can paste a stat block straight out of a PDF.
- A **Foundry** line: mono, editable, holds the actor id (e.g. `Actor.7fQ2mXnP`). Teal when set, grey placeholder when not. This is the hook for pushing the creature to Foundry (`foundry-push.mjs`).

#### Below the elements

- `+ Add element` (defaults MUNDANE) · `▣ NPC or creature` · `◇ From graph` · `✦ Suggest dressing`.
- **From graph** opens an inline picker: search box + list of every graph node not already in the scene, showing name, mono type, and a right-aligned hint ("add as key element" / "this scene's place"). Picking one creates an element with `kind:'graph'` + `graphEntityId` — it never duplicates the node.
- **Suggest dressing** appends up to 3 MUNDANE elements chosen by matching the anchor place's *name + description* against keyword sets (forge/smith, vault/crypt/temple, waystation/inn/tavern, tower/bell, market/dock). Toast copy distinguishes three cases: matched with a description, matched on name only ("add a description for sharper ones"), and no match (generic dressing).
- **Table notes** — mono 12.5px, `white-space: pre-wrap`, 1px border, min-height 96px, background `oklch(0.975 0.006 85)`. Caption: "Wrap reads these notes and proposes graph edits — nothing is written without your say-so."
- **Beyond this room** — collapsed disclosure listing the anchor place's graph neighbours (relationship label in a 74px mono right-aligned column + name + type).

### D. Wrap-up panel

400px right rail, background `oklch(0.945 0.009 85)`, 1px left border. Header "✦ Wrap up scene" + ✕. Blurb: "Read your table notes for this scene and proposed N graph edits. Nothing is written until you apply."

**Proposal card** (1px border, radius 4px, padding `11px 12px`, 8px gap):
- Kind badge (mono 9px uppercase pill): `promote` on amber `oklch(0.90 0.045 65)`, everything else on teal `oklch(0.90 0.030 185)`. Kinds used: `promote`, `field edit`, `new edge`, `new node`.
- Target name 13px/500, right-aligned status word ("accepted" / "rejected").
- Diff rows: removed line `−` on `oklch(0.90 0.030 25 / 0.35)`, added line `+` on `oklch(0.90 0.045 150 / 0.40)`. Only render the `−` row when there is a prior value.
- Rationale, 11.5px grey.
- **Accept** / **Reject** buttons; accepted card turns green-bordered on `oklch(0.96 0.020 150)`, rejected card goes flat grey.
- Footer: "Accept all" (ghost) and a primary "Apply N to graph" that is disabled-looking until at least one is accepted.

### E. Run mode — the runnable spread (rewritten 2026-08-26)

A **Prep | Run** segmented control in the top bar. Run hides every piece of edit chrome (rows, chips, ghost links, add buttons, wrap, the beyond-this-room drawer — the map chip row and the stage-dressing chip row stay, they are at-a-glance info) and renders the scene as a **runnable spread** (`.scene-run-spread`, built by `buildRunSpread` in `session-planner-view.js`), the module-style format a GM can run straight from:

- **Head band** — Spectral 21px title, pills (`combat` when `scene.kind === "combat"`, then `scene.tags`; anything with "live" in it goes rust), and a right-aligned mono uppercase **where** line (`scene.whereNote`, else the place name; the linked map's name on a second line unless whereNote already names one).
- **3:2 grid** (consolidation pass, 2026-08-31 — the Kilmarn retro's "17 sibling cards" fix; column plans are built by the ONE pure `planRunSpread()` in `run-layout.mjs`, the renderer consumes the plan verbatim). MAIN column, in this fixed section order: the scene narration as an italic sensory opener; the lowest-`order` ungrouped read-aloud as the opening read (rust-ruled 18px Spectral, `trigger` as a small when-line, `means` as a `GM` aside); then the ONE **Dressing card** — ALL the scene's ungrouped main dressing rows folded into a single bullet list *regardless of how they were interleaved in Prep order* ("it's just dressing" — the at-a-glance details belong together near the top); then everything else in element `order` — further read-alouds, interaction beats (`.ixh`-style mono heading + labelled lines + DC chips), and composite **group cards** (below); and the **exits** footer (dashed rule; each line parsed as `LABEL: text → 'Target scene'` into a Plot / Explore / Linger label, the text, and a bold target). SIDE column: the objective box, the **map slot** (sketch elements in place; otherwise a 160px cover thumbnail of the linked map asset via `GET /api/session-planner/stagecraft/:id/image`), **stat blocks** (name, `×N`, `AC · HP · CR` from a linked bestiary entry or the `statblockRef` text, checks, tactics, raw stat paste), **payload cards** (gold dashed rule: italic phrase, Effect / Alternate / Failure lines), the **GM notes card** — ungrouped GM boxes (backdrops, notes, tone-state texture) fold into ONE card with per-member section labels whenever there are ≥2 (a lone GM box keeps its own plain box), sketches (inline SVG through a small sanitiser + caption). Auto-folding merges and repositions, it NEVER drops — every visible element renders exactly once (the standing anti-simplification rule). Two honesty rules (Phase 4, persona round): a stat block with no actual numbers (no linked bestiary entry, no `stat.raw`/`ac`/`hp` — a bare `statblockRef` name doesn't count) renders a visible "No stats entered" line instead of a clean nameplate that looks prepped; and an element still carrying unreviewed ✦-drafted fields shows a `✦ draft` pill on its heading (see §C's draft marking).

**Where each element goes is data, not guesswork.** `element.run = { column: main|side|off, role: read|dressing|beat|exits|block|card|gm|sketch, variant?, placeholder?, group? }` (zod `RunLayout`, `session-planner/scene-elements.mjs`). An element without `run` falls back to `inferRunLayout()` in `session-planner/run-layout.mjs` — the ONE shared module, the canonical copy sits in `review-ui/public/run-layout.mjs` and `session-planner/run-layout.mjs` re-exports it — which keys off the naming conventions the scene-authoring skill already recommends ("Read Aloud — X", "Backdrop — X", "→ Where this leads", stat/bestiary fields). Explicit always wins; the row chip shows which is in force (§C).

**Groups — one card for one thing.** Elements sharing a non-empty `run.group` (free string, per column) render as ONE composite card: the lowest-`order` visible member is the **lead** (its name heads the card, its content renders per its own role — a payload card's phrase/Effect lines, say), every other member follows as a labeled section (heading = the after-dash title, else the variant, else the name; its variant as a quiet pill). Built for the fate-thread shape — "here's what the thread does" and its outcome read-alouds on the same card instead of five near-duplicate siblings — but the mechanism is world-agnostic. Variants gate per-MEMBER: a gated member's section simply doesn't render, the card stays; if the lead is gated the next visible member leads; a group with every member hidden renders no card; a one-member group renders as a plain element. `group` is EXPLICIT ONLY — `inferRunLayout()` never invents one (composition is a GM decision, not name-pattern guesswork). Cosmetic specifics of the composite card (section label styling, the shared dashed-amber accent) are pending the context-free persona round.

**Variants — tabs on the card** (Treatment B, adjudicated 2026-09-01 via the design-canvas round). Inside a group card or the GM-notes fold, the variant-carrying members' names render as a clickable **tab row** (mono uppercase, active = ink + rust underline; the active state's own section heading is suppressed — the tab IS its heading; variant-less members always show with headings). **Clicking a tab is a LOCAL flip only** — nothing is written; variants turn the page on *data*, while a real change of what the table sees is a scene switch (the future Foundry push/unstage/activate pass). `scene.activeVariants` stays the persistent, MCP-visible switch and SEEDS the tabs (a listed variant's tab starts active; else the FIRST tab — the adjudicated default); the GM's local flips override the seed, survive live-refresh rebuilds (an MCP burn landing mid-session never resets your tabs) and Prep↔Run trips, and clear when a different scene renders. Gated gm boxes COUNT toward the ≥2 fold (they become tabs). LOOSE variant elements (ungrouped, not in the fold) keep the old plain gating: empty activeVariants = visible, gated = dropped. The rules live in `planRunSpread` (`run-layout.mjs`, v3 — gating is a `variantHidden` STAMP reaching the planner, no longer a pre-filter).

**Live refresh.** While in Run the page polls `GET …/run-version` (a sha1 over scene record + elements + narration) every 3 s (chained `setTimeout`, never an unbounded interval; paused while the tab is hidden, stopped on Prep/navigation) and rebuilds the spread only when the fingerprint changes — an `updated just now` tag flashes on the head band. So an edit from another tab, or an agent over MCP (`wf_set_element_run`, `wf_set_scene_active_variants`, `wf_add/update/delete_scene_element`, `wf_set_scene_narration`, `wf_reorder_scene_elements`), lands on the table within a few seconds.

Routes: `POST …/elements` / `POST …/elements/:id` carry `run`; `POST …/run-layout/infer`; `POST …/run-layout/seed`; `GET …/run-version`; `GET …/elements` attaches a read-only `bestiary {name, ac, hp, cr, note}` summary when `fields.bestiaryEntryId` is set. Scene patch (`POST /api/session-planner/scenes/:id`) carries `kind`, `whereNote`, `tags`, `activeVariants`.

### F. World Graph — containment tree

Three panes.

**Top bar**: campaign name · **Session planner | World** segmented control (this same control appears on the Session Planner page — they are the app's primary navigation) · flexible spacer · a 260px "Search the world…" input · six type-filter pills with mono glyphs: Place `▢` teal, Person `◉` amber, Object `◆` violet `oklch(0.52 0.08 300)`, Faction `⬗` green `oklch(0.50 0.09 145)`, Event `✧` rust `oklch(0.55 0.11 40)`, Concept `◌` slate `oklch(0.55 0.03 260)`.

**Left — "Where things are"** (318px): the containment tree. Rows indent `8 + depth*15` px, chevron ▸/▾ in a 12px column, type glyph, name (places `oklch(0.26 0.015 60)`, everything else `oklch(0.42 0.014 65)`), an amber 6px dot for unreviewed, and a mono child count. Selected row `oklch(0.90 0.020 185)`. Searching or type-filtering auto-expands and keeps only matching nodes *plus their ancestor chain*. Footer hint: "Drag any node onto a place to put it inside. That single edge is all the detail you owe it."

**Middle — the selected node**: breadcrumb of ancestors joined with `›`; glyph + editable name (Spectral 30px) + mono type; editable description (editing it also clears the node's unreviewed flag). Then **Inside <name>** — children grouped by type, each a draggable chip (1px border, 2px left accent in the type colour, radius 4px) showing glyph, name, unreviewed dot, and a mono sub-label ("3 inside" / "no detail"). Note: the search/type filter must **not** filter this pane — it is a contents view, not a find affordance.

Actions: `+ Add something here` (inline name input + type pills, creates the node already parented), `⌁ Mark something related` (search picker that creates a bare `related` edge — caption: "Creates an untyped `related` edge. Wrap-up reads your session notes and proposes what it actually is — you approve it then."), and, only when the selection is a place, a filled teal **▸ Create a scene here**.

**Loose threads** lane at the bottom of the middle pane. A node's reasons are computed as: `not placed` (no parent), `no detail` (no description), `never used in a scene` (not referenced by any scene and not a scene's anchor place), `no links` (no non-containment edges). Default list = nodes with ≥2 reasons, capped at 8, sorted by reason count. Filter chips with live counts — one per reason — switch the list to *everything* with that single reason (cap 24); clicking an active chip clears it. Each row is draggable, shows its reason badges (amber mono pills), and carries a "place in <selected place>" shortcut.

**Right — detail + scene tray** (320px):
- Header: node name + "Open full page →".
- **Contained in**: the parent as a clickable row, or an amber panel "Nowhere in particular — drag it onto a place to fix that."
- **Tied to**: non-containment edges as dashed rows — name, relationship kind (the literal `related` renders amber to mark it as unrefined), and an ✕ to remove.
- **Appears in**: scenes that reference the node, *including* scenes anchored to it (rendered "The Antechamber (anchor place)").
- **Drop into a scene**: a "Find a scene…" filter input and the scene list ordered **most recently touched first**, each showing "place · N elements · 5h ago". Each row is a drop target — dropping a node adds it to that scene as a KEY element and bumps the scene's recency.

---

## Interactions & Behaviour

- **Click-to-edit, never focus-to-edit.** Values are `contenteditable` and invisible at rest: hover paints a 4px halo `oklch(0.90 0.012 85)`, focus paints `oklch(0.86 0.045 185 / 0.45)`. No Edit/Save buttons, no modals. Autosave on blur via `createFlushableDebounce`; never full-re-render on keystroke.
- **Undo toasts** for every reversible action: remove-from-plan, remove element, promote/demote, reparent, delete plan, add-to-scene, remove link, create scene. Fixed bottom-centre pill, `oklch(0.26 0.015 60)` on white text, 6s timeout, teal "Undo".
- **Keyboard**: `[` previous scene, `]` next scene, `Esc` closes the Wrap panel and inline panels. Suppressed while a `contenteditable` has focus.
- **Drag and drop** (HTML5): dragging a tree row or a contents chip onto a tree row reparents it (with a cycle guard — a node can never become its own descendant); dragging onto a scene-tray row adds it to that scene. Drop targets highlight with a teal border.
- **Promote/demote**: `⭑` on an element. Promote creates a graph node and a `containment` edge to the scene's anchor place, then sets `kind:'graph'` + `graphEntityId`. Demote clears the bookkeeping and **never deletes the node** — the toast says so explicitly.
- **Deletes are four distinct verbs** and must stay distinct: remove-from-plan (unlink) ≠ delete-scene (guarded) ≠ delete-plan ≠ delete-node-from-graph (guarded, warns if referenced).
- **LLM work is additive and interruptible, never a gate.** Every scene must be runnable with hand-typed elements and zero round-trips.

## State Management

Session Planner: `view` (`plans` | `plan` | `scene`), `planId`, `sceneId`, `mode` (`prep` | `run`), `layout` (`page` | `cards`), `wrapOpen`, `railOpen`, `statOpen` (per element), `openFields` (per element — which empty field lines are showing), `drawerOpen`, `addSceneOpen`, `newPlaceOpen`, `pickedPlaceId`, `graphPickerOpen`, `graphQuery`, `decisions` (per wrap proposal), `toast`. **URL is the single source of truth for location** — no localStorage where-am-I heuristics.

World Graph: `nodes`, `rels`, `scenes`, `sceneRefs`, `expanded`, `selectedId`, `query`, `types[]`, `dragId`, `dropTarget`, `addOpen`/`addName`/`addType`, `relPickerOpen`/`relQuery`, `looseOpen`/`looseFilter`, `sceneQuery`, `toast`.

### Data / routes this maps onto

| UI | Repo |
|---|---|
| Scene elements, promote/demote, reorder | `session-planner/scene-elements.mjs`, `/api/scene-planning/scenes/:sceneId/elements*` |
| Read-aloud | `session-planner/scene-narration.mjs` |
| Plan CRUD, scene membership | `session-planner/plans.mjs`, `scenes.mjs`, `scene-membership.mjs` |
| Wrap proposals | `proposeUpdatesForScene` in `session-planner/plan-updates.mjs` → the existing review-batch accept/reject pipeline |
| Graph reads | `GET /api/graph` |
| Manual node/edge CRUD, reparent, related-edge | `wf-mcp-server/lib/manual-edit-ops.mjs` (`addNodeOp`, `addEdgeOp`, `deleteNodeOp`) |
| Unreviewed flag | `mutation-engine/human-review.mjs`, `GET /api/unreviewed-entities` |
| Stat block → Foundry actor | `foundry-push.mjs` (the `Foundry` field on a stat block holds the actor id) |

The element field vocabulary is fixed and must match `SceneElementFields` exactly: `trigger, gives, looks, means, checks[{skill, dc, purpose?}], function, wants, secret, statblockRef`. **Trigger and Gives are the core two**; everything else is show-only-if-filled. The stat-block structure in these designs (`count, ac, hp, speed, cr, raw, foundryActor`) is **new** — it needs either a store of its own or an extension to `SceneElement`.

## Design Tokens

All colours are oklch (the prototypes use no hex).

**Surfaces** — page `oklch(0.955 0.008 85)`; chrome/rails `oklch(0.938 0.009 85)`; top bar `oklch(0.925 0.009 85)`; cards `oklch(0.985 0.005 85)`; inputs `oklch(1 0 0)`; sub-bar `oklch(0.945 0.009 85)`.
**Rules & borders** — hairline `oklch(0.88 0.010 80)`; control border `oklch(0.86 0.010 80)`; dashed `oklch(0.80 0.010 80)`.
**Ink** — primary `oklch(0.27 0.015 60)`; headings `oklch(0.24 0.015 60)`; secondary `oklch(0.47 0.014 65)`; muted/mono labels `oklch(0.58 0.012 70)`.
**Accents** — teal (primary/UI) `oklch(0.55 0.075 185)`, selected fill `oklch(0.90 0.020 185)`; amber (KEY elements, unreviewed, wrap) `oklch(0.62 0.10 65)`; rust (stat blocks) `oklch(0.55 0.11 40)`; danger `oklch(0.50 0.13 25)`; accept-green `oklch(0.55 0.070 150)`.
**Type** — Spectral (serif: titles, element names, read-aloud); IBM Plex Sans (UI); IBM Plex Mono (labels, ids, numbers, table notes). Mono labels are 9–10.5px, uppercase, `letter-spacing: 0.07–0.11em`.
**Spacing** — 4 / 6 / 8 / 12 / 14 / 18 / 26 / 34 px. **Radii** — 3px (paper-ish panels), 4px (rows, inputs), 5–6px (buttons), 20px (pills). **Shadows** — only the toast: `0 8px 26px oklch(0.26 0.015 60 / 0.28)`.

## Assets

None. No images, no icon library — every glyph is a Unicode character rendered in IBM Plex Mono (`◆ ○ ◇ ⭑ ✦ ✕ ↑ ↓ ▸ ▾ ▢ ◉ ⬗ ✧ ◌ ⌁ ▣ ! −`). Fonts load from Google Fonts.

---

## G. Chronicle — passage of time

Three panes under a 40px sub-bar (mono kicker "CHRONICLE" + the world clock, e.g. current in-world date).

**Left (306px) — Deferred.** Intents queued from play ("Sella's brother's ring — who has it now?"), each a checkbox row; checked intents are the ones the next time-pass must answer. Footer: a hand-add input, same styling as the scene-tray filter.

**Middle — two modes**, switched by a segmented control:
- **Composer** — "Let time pass", Spectral 27px, blurb 13.5px `oklch(0.48 0.014 65)` max-width 62ch. A prose textarea ("Three months pass…"), then **How far it reaches**: whole world / queued intents only / picked branches. Picking branches opens an inline search picker over graph nodes ("Find a place, faction, event, or object…"); picks render as removable chips.
- **Timeline** — "Drag the world forward": a horizontal time scrubber with deferred intents marked on the line, an optional colouring prompt, and the **fortune track** — five stops, Bountiful · Fair · Mixed · Hard · Ruinous, with optional nudge tags. Fortune biases the proposals; it never writes anything by itself.

**What changed** (below either mode) — the review-gated diff: same proposal card as the Wrap-up panel (kind badge, target, −/+ diff rows, rationale, Accept/Reject, "Apply N to graph"). Nothing is written to the graph until applied.

**Right (306px) — The chronicle**: past time-passes, newest first, each with its date range, scope, fortune, and how many edits were applied. This is the world's history log.

## H. Library — four tabs

Top bar (42px) holds the tab control (label + mono count) and per-tab controls on the right.

- **Bestiary** — habitat tree (from the graph) at left, creature cards centre, full stat block at right. Cards carry a per-table rating stepper, source pill (`srd` / `foundry` / `mine`), and a personal note. Right rail: Foundry push state + actor id, a reskin suggester, and the note ("stays here — never pushed to Foundry").
- **Hero's Hall** — the party, in Cards or Side-by-side layouts. HP/AC/passive, Saves, Notable skills (✦ marks expertise), conditions, and a free-form per-PC note. Read from Foundry actors.
- **Reliquary** — items. Simple searchable list; each row is name + kind/meta + source pill + description + tags. Descriptions come across from Foundry when the item has one; rows without one say so in italic grey rather than rendering empty.
- **Stagecraft** — maps, splash art, music, filtered by an All / Maps / Splash art / Music segmented control. Rows are **references only** — the files themselves live in Foundry (scene id, image path, playlist id); this UI exists so the right one is findable mid-session.

**Shelf row anatomy** (Reliquary + Stagecraft share it): 1px border `oklch(0.88 0.010 80)`, `border-left: 3px` in the kind accent (item teal `oklch(0.55 0.075 185)`, map green `oklch(0.50 0.09 145)`, splash amber `oklch(0.58 0.10 65)`, music violet `oklch(0.52 0.09 300)`), radius 4px, background `oklch(0.985 0.005 85)`, padding `10px 13px`, `cursor: grab`. Mono kind glyph (`◈ ▦ ◐ ♪`), Spectral 16px name, mono 9.5px meta ("Map · 40×30 grid · walls set"), right-aligned source pill, description 12px max-width 78ch, then the tag row.

**Tags** are the whole findability model: pills at 11px, radius 20px. Clicking a tag filters by it; ✕ removes it from that row; `+ tag` opens an inline input (Enter commits, Esc cancels). The left rail lists every tag in the current tab with live counts; selected tags AND together, with a "Clear tag filter" escape. Free-text search matches name, description, and tags at once.

Every row on all four tabs is draggable onto the **scene tray** in the left rail. Creatures stack (`×N`) and count against the scene's XP budget; heroes and props (items/maps/art/music) are single and cost nothing — the tray meta reads "N creatures · N heroes · N props".

## J. Briefing — world-level front matter (2026-08-26)

A fifth shell surface (`#briefing`, nav button after Library): the campaign's front matter — premise, clock, cast, party, town map, table rules — as an ordered grid of **cards** the GM wants in front of them before the first scene. Same paper treatment as the Run spread one level up: `max-width: 1080px`, two columns (a card may `span` both), Spectral titles, mono rust eyebrows.

Card = `{ title, eyebrow, body, span: 1|2, order }` (`session-planner/briefing-store.mjs`, `briefing/<world>.json`). Title and eyebrow are click-to-edit (the planner's own `makeClickToEditField`); the body is light HTML (paragraphs, lists, tables, emphasis, headings, inline SVG — the brief's `.stat`/`.phrase`/`.pill`/sketch classes are styled) rendered through a whitelist sanitiser at rest and swapped for a raw textarea on click. Hover tools: `↑ ↓`, span toggle (`⇔`/`⇤`), delete (confirm). **+ Add card** appends an empty card.

Routes: `GET/POST /api/session-planner/briefing`, `POST …/briefing/reorder`, `POST …/briefing/:id`, `DELETE …/briefing/:id`. MCP: `wf_list_briefing_cards`, `wf_upsert_briefing_card`, `wf_delete_briefing_card`, `wf_reorder_briefing_cards` — the intended way to have an agent write a world's briefing from its notes.

## I. Connection Menu (shared)

A compact chip in every page's top bar — mono, e.g. `Foundry · live · 312 ▾` — dot colour carries state (live teal / stale amber / off grey). Opens a 620×720 panel: connection setup, live sync with intake review (bulk accept or drill into a single proposal), lore intake (paste text or a World Anvil URL), and intake history. Its review surface is the same component as Chronicle's "What changed".

**Every page mounts this same component** — it is the single place external I/O is configured, and the reason no page needs its own settings screen.

---

## Files

- `Session Planner.dc.html` — plan shelf, plan runsheet, scene page (both layouts), stat blocks, Wrap panel, run mode.
- `World Graph.dc.html` — containment tree, contents pane, loose threads, detail panel, scene tray. The detail panel's destructive action is **remove from graph**: two-click arm ("remove — sure?"), children reparent up one level, non-containment edges drop, undo toast.
- `Chronicle.dc.html` — deferred intents, composer, timeline + fortune track, review diff, chronicle log.
- `Library.dc.html` — Bestiary, Hero's Hall, Reliquary, Stagecraft, and the shared scene tray.
- `Connection Menu.dc.html` — the top-bar chip and its panel; imported by all four pages.
- `support.js` — the prototype runtime. **Not part of the design**; ignore it when porting.

### Ported once, used everywhere

1. **Scene tray** — filter + recency-ordered scene list + drop target (all four pages).
2. **Proposal / diff card** — Wrap-up, Chronicle, and intake review.
3. **Tagged shelf list** — Reliquary, Stagecraft, and (with a stat block attached) the Bestiary.
4. **Top bar** — 52px, brand + primary nav + Connection Menu chip. Identical on every page.

Open either file directly in a browser. All data is seeded in the logic class at the top of each file.
