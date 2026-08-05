# Handoff: Session Planner + World Graph UI (GM_Tools)

## Overview

Two UI surfaces for the GM_Tools TTRPG session-planning app (`panic-mw/GM_Tools`, branch `master`):

1. **Session Planner** — plan shelf → plan runsheet → the scene page (the Phase 28 "one edit-in-place page that reads like a printed module"), plus a Wrap-up review panel.
2. **World Graph** — a containment-tree-first replacement for the current force-directed graph view, oriented around *"where things are in the world"*, loose-thread triage, and feeding the session planner.

These replace / complete the Phase 28 (28.2, 28.3, 28.4) and graph-view work. They were designed against the real data model in the repo — `session-planner/scene-elements.mjs`, `session-planner/plans.mjs`, `session-planner/scenes.mjs`, `plans/phase-28-tasks.md`.

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

Sub-bar above it (height ~40px, background `oklch(0.945 0.009 85)`, 1px bottom border): `← <prev scene name>` / `<next scene name> →`, then right-aligned **Page | Cards** segmented control and the **✦ Wrap ▸** button (1px border `oklch(0.68 0.09 65)`, text `oklch(0.42 0.09 65)`).

Body, in order:

1. Mono uppercase place label, teal, 10px, `letter-spacing: 0.11em`.
2. Scene name — `contenteditable`, Spectral 34px/500.
3. Objective — `contenteditable`, 14px, `oklch(0.47 0.014 65)`, `max-width: 62ch`.
4. **The place** — the anchor place's `description`, shown as a 76px mono label + editable value in a grid, bounded by 1px rules top and bottom. Editing writes back to the *graph node*, not the scene.
5. **Missing-description banner** (when the place has no description): 1px `oklch(0.80 0.070 65)` on `oklch(0.96 0.030 65)`, radius 4px, a mono `!` glyph, copy: "This place has no description in the graph. Read-aloud and dressing suggestions have nothing to draw on — *write one now*." Clicking seeds an empty description and focuses it.
6. **Read aloud** — 2px left rule `oklch(0.72 0.055 185)`, padding-left 18px. Mono uppercase label; body Spectral italic 16px (20px in run mode), `line-height: 1.55`, `contenteditable`.
   - When empty **and** the place has a description: a ghost link "✦ Draft this from the place description and the objective" (12px, teal). It composes description + objective into the narration, undoable. When the place has *no* description the link is hidden — the banner covers that case.
7. **Elements** — mono uppercase label + "N · K key".

#### Element rendering — two layouts

**Page layout** (default): rows separated by 1px top rules, `border-left: 2px` (accent `oklch(0.62 0.10 65)` for KEY, transparent for MUNDANE), padding-left 12px.
- Header line: glyph (`◆` amber KEY / `○` grey MUNDANE), name (`contenteditable`, Spectral — KEY 18px/600, MUNDANE 15px/400), a mono uppercase entity-type badge for KEY (`oklch(0.88 0.050 65)` bg), then right-aligned `⭑` promote/demote and `✕` remove.
- Field lines: `grid-template-columns: 76px 1fr`, gap 12px. Label mono 9.5px uppercase right-aligned `oklch(0.60 0.012 70)`; value `contenteditable`, KEY 13.5px `oklch(0.31 0.015 60)`, MUNDANE 12.5px `oklch(0.46 0.014 65)`, `min-height: 20px`.
- **Only fields with content render.** Below them, a wrapping row of dashed pill chips — `+ TRIGGER`, `+ GIVES`, `+ LOOKS`, `+ MEANS`, `+ CHECKS`, `+ FUNCTION`, `+ WANTS`, `+ SECRET`, `+ STAT BLOCK` — one per unfilled field. Clicking a chip opens an empty editable line for it. This is the *only* way to add a field; there is no form.

**Cards layout**: `repeat(auto-fill, minmax(320px, 1fr))` grid, gap 12px. Same content; card = 1px border, `border-top: 3px` (KEY amber / MUNDANE grey), radius 3px, padding `13px 14px 12px`, KEY background `oklch(0.985 0.008 78)`. Field label sits above its value rather than beside it.

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

### E. Run mode

A **Prep | Run mode** segmented control in the top bar. In run mode: all edit chrome hides (`display: none` on ✕/⭑/add-field chips/add buttons/reorder arrows), read-aloud jumps to 20px, MUNDANE elements collapse to their **Gives** line only, KEY elements stay full, and the Wrap panel is force-closed.

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

## Files

- `Session Planner.dc.html` — plan shelf, plan runsheet, scene page (both layouts), stat blocks, Wrap panel, run mode.
- `World Graph.dc.html` — containment tree, contents pane, loose threads, detail panel, scene tray.
- `support.js` — the prototype runtime. **Not part of the design**; ignore it when porting.

Open either file directly in a browser. All data is seeded in the logic class at the top of each file.
