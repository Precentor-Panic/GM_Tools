# Phase 31 — UX Interaction Audit (World + Session Planner shell)

Read-only audit of the just-built front end (`review-ui/public/`) against the Claude-Designer
prototypes (`design/session-planner/*.dc.html` + `README.md` §"Interactions & Behaviour").
Goal: for every affordance that *looks* interactive, say whether it is **WIRED**, **BROKEN**,
**MISSING**, **NO-FEEDBACK**, or **PARTIAL**, with `file:line` and a concrete fix so the next
two waves (QE hardening tests, implementer wiring) need no re-guessing.

**Fixes must NOT change the visual design.** Everything below is wiring + minimal feedback
affordances only, expressed through existing `--sp-*` tokens and the existing `showUndoToast`
(plans-view.js). No new components, no re-skin.

Status legend:
- **WIRED** — handler exists and works.
- **BROKEN** — handler exists but fails / does the wrong thing.
- **MISSING** — no handler; the element looks interactive (cursor/hover/underline).
- **NO-FEEDBACK** — persists server-side but the UI gives no visible confirmation, so it reads as broken.
- **PARTIAL** — works but deviates from the prototype's specified behavior.

---

## 0. Headline: the "drag alvor into gladiator arena doesn't stick" bug — root-caused

There are **two visually similar drop targets** and they do **different things**:

| Drop target | Where it lives | Operation | Code |
|---|---|---|---|
| (a) tree row / contents chip / loose row → **tree row** | left "Where things are" pane | **reparent** (containment edge) | `wireReparentTarget` world-view.js:372-383 → `reparent` :385 |
| (b) any dragged node → **scene-tray row** | right inspector, "Drop into a scene" | **add-to-scene** (KEY member) | `srow` world-view.js:871-885 → `addToScene` :898 |

### The wiring itself is correct (both persist)
- `startDrag` (:368) sets `dragId` **and** `dataTransfer.setData("text/plain")`; the module-level
  `dragId` is what the drops actually read.
- reparent-target `dragover` calls `e.preventDefault()` (:373) and the drop reads `dragId`, clears
  it, and calls `reparent(src,tgt)` (:375-382).
- scene-tray `dragover` preventDefaults (:876) and the drop calls `addToScene(src,s)` (:878-883).
- `dragId` is only ever cleared inside a `drop` handler, so it is **not** cleared prematurely; no
  re-render fires during a drag (nothing calls `renderTree` between dragstart and drop).
- Server side both routes are real and persist: `POST /api/graph/nodes/:id/reparent`
  (server.mjs:1246 → `reparentNode`, manual-edit-ops.mjs:368, which has its **own** cycle guard and
  atomic edge swap) and `POST /api/scene-planning/scenes/:id/members` (server.mjs:1857 →
  `addNodeToScene`, scene-membership.mjs:73). The drop-target CSS highlight also works: `.wv-tree-row`
  has `border:1px solid transparent` (style.css:2803) so `.wv-drop-target { border-color: teal }`
  (:2807) is visible; scene rows likewise (:3001).

So in a real browser the drops **do fire and do persist.** "Doesn't stick" is therefore **not** a
dead handler. It is a combination of two things:

### Root cause A (primary) — the user is aiming at the wrong target model
"Gladiator arena" is a **scene**. Scene membership is added **only** by dropping on the right-pane
**scene tray** (`srow`). If the GM instead drags "alvor" onto a **place row in the tree** (e.g. the
place the scene is anchored to, which may also be named/aliased "gladiator arena"), the drop runs
**reparent** — it creates a *containment* edge alvor→place. That is a legitimate, persisted edit,
but it is **not** scene membership: alvor never becomes an element of the scene, so when the GM
looks at the scene in the planner, "nothing stuck." The tree *did* change (alvor nests under the
place), but that is not what the GM was watching.
If no place named "gladiator arena" exists at all, dropping anywhere in the tree/centre that is not
a row is a literal no-op (only rows are drop targets; the tree container and empty space are not),
so it reads as "nothing happens."

### Root cause B (compounding) — a *successful* scene-add gives almost no visible feedback
Even when the GM correctly drops onto the scene-tray row, the confirmation the **prototype** relied
on is absent in the build:

1. **The tray row omits the element count.** Prototype meta is `place · N elements · ago`
   (World Graph.dc.html:608) and the drop does `count: count+1, visited: Date.now()` inline
   (:618-624) so the row visibly ticks up **and jumps to the top**. The build's `srow` meta is only
   `` `${placeName} · ${agoLabel(s)}` `` (world-view.js:875) — **no count**.
2. **Member-add never bumps recency.** `addNodeToScene` (scene-membership.mjs:73) does **not** call
   `touchScene()` / stamp `updatedAt`. So after `refreshScenes()` (sorted by recency,
   world-view.js:1026) the scene does **not** move to the top and `agoLabel` does **not** flip to
   "just now." The tray is byte-for-byte identical before and after a successful add.
3. **The inspector only reflects the *selected* node.** `addToScene` calls `renderInspector()`
   (:908) which rebuilds the tray + "Appears in" for `selectedId` — **not** for the dragged node.
   If the GM dragged a node that is *not* currently selected (the common case: drag alvor from the
   tree while some other node's inspector is showing), alvor's "Appears in" is never on screen, so
   nothing updates.

Net: the only signal a correct add ever produced is the **6-second toast** (:910). Miss it, or add
a non-selected node, and a fully-successful operation is indistinguishable from a no-op.

### Success feedback the GM *should* see (fix spec, no visual redesign)
- Restore the element count in the tray meta: `place · N elements · ago` (matches prototype;
  `.wv-scene-drop-meta` already styles it). Populate N from the same
  `/scenes/:id/elements` count the runsheet already fetches (app-shell.js:680).
- Make `addNodeToScene` call `touchScene(world, sceneId)` (scenes.mjs:227 already exists) so the
  scene bumps to the top and reads "just now" after a drop.
- After `addToScene`, briefly flash the dropped-on `srow` (teal `--sp-accent-teal` fade, reuse the
  `.wv-drop-target` token) so confirmation is anchored to the row, not just the toast.
- Optional but high-value: on the **tree-row** reparent drop, if the drag came from a node the GM
  likely meant to "put in the scene," this is inherent ambiguity — do **not** auto-convert, but the
  tray flash + count above makes the correct gesture obviously the one that changes the scene.

---

## 1. Per-surface interaction tables

### 1A. World surface (`world-view.js`)

| Affordance | Expected (prototype) | Status | Notes / root-cause (file:line) |
|---|---|---|---|
| Tree row click → select | select node, update `#world/<id>`, expand ancestors | **WIRED** | :358 `select` → goto; deep-link works (e2e proven) |
| Tree chevron ▸/▾ | toggle expand of that node only | **WIRED** | :343-349, `e.stopPropagation()` guards select |
| expand-all / collapse-all toggle | expand every parent / collapse all | **WIRED** | :199, `toggleExpandAll` :312; label flips at >6 |
| Drag tree row → tree row | reparent (containment) + undo toast | **WIRED** (persists) | :360/:372/:385; but see Root cause A — easily mistaken for scene-add |
| Drag chip/loose/tree node → **scene tray** row | add as KEY member + toast + tray count/recency bump | **NO-FEEDBACK** | persists (:898) but tray shows no count, no recency bump, inspector only reflects selected node — see Root cause B |
| Reparent cycle (drag parent onto own descendant) | blocked with a message | **WIRED** (server) | no client guard, but server rejects → `Could not move: …cycle` toast (:407); acceptable |
| Detail name (contenteditable) | click-to-edit, blur = rename | **WIRED** | :439-445 `saveName` :950 |
| Detail description (contenteditable) | edit autosaves, clears unreviewed | **WIRED** | :450-461 `saveDescription` :967 sets `flaggedUnreviewed=false` |
| Contents chip click | select that child | **WIRED** | :507 |
| Contents chip drag | drag onto scene/place | **WIRED** (persists) | :508; same NO-FEEDBACK on the scene-add landing |
| "+ Add something here" | inline name+type pills, creates parented node | **WIRED** | :516/:541 `doAdd` :569 |
| "⁁ Mark something related" | search picker → untyped `related` edge + toast | **WIRED** | :518/:591 `markRelated` :632 |
| "▸ Create a scene here" (place only) | create scene, **jump into planner** with it open + undo | **WIRED** | :522-530 `createSceneHere` :653, cross-surface jump proven in e2e |
| Loose-thread header ▾/▸ | collapse/expand lane | **WIRED** | :705 |
| Loose filter chips (4 reasons, live counts) | switch list to single-reason (cap 24) / clear | **WIRED** | :708-716 |
| Loose row "place in <place>" shortcut | reparent into selected place | **WIRED** | :731-734 |
| Loose row drag / click | drag to scene/place; click select | **WIRED** | :736-737 |
| Inspector "Contained in" parent row | click → select parent | **WIRED** | :769 |
| Inspector "Tied to" ✕ remove link | delete edge + undo toast | **WIRED** | :790-791 `removeLink` :927 |
| Inspector "Appears in" list | scenes referencing node (anchor tagged) | **WIRED** | :814 `fillAppearsIn`, e2e proven |
| Inspector **"Open full page →"** | (looks like a link; `cursor:pointer`, hover underline) | **MISSING** | :760 — **no click handler**. Matches prototype (also unwired), but reads as interactive. Decide: wire to entity full page or drop the affordance. |
| Detail breadcrumb ancestors | (rendered as text joined with `›`) | **PARTIAL / MISSING** | :433 plain text, not clickable. Ancestors are reachable via the tree + inspector parent; low priority. |
| Topbar search (auto-expand + ancestor keep) | filter tree, keep matches+ancestors, auto-expand | **WIRED** | :246 → `renderTree`; `visibleRows` keep-set :286-311 |
| Topbar 6 type-filter chips | toggle type filter, auto-expand | **WIRED** | :259-264 |
| Scene-tray "Find a scene…" filter | filter tray by scene/place name | **WIRED** | :865 |

### 1B. Shell — topbar / breadcrumb / rail (`app-shell.js`)

| Affordance | Expected | Status | Notes (file:line) |
|---|---|---|---|
| Session planner \| World toggle | navigate to each surface's canonical entry | **WIRED** | :147-150 |
| World select (dropdown) | switch world, re-render current view | **WIRED** | :152-161 |
| Breadcrumb "Plans" / plan segments | clickable navigation | **WIRED** | :207, :224 |
| Breadcrumb scene leaf | deliberately non-navigating | **WIRED (by design)** | :237 comment — intentional, not a bug |
| Rail "+ New plan" | create plan, open it | **WIRED** | :262-264 → `createNewPlanAndOpen` :345 |
| Rail plan item click | open plan runsheet | **WIRED** | :303 |
| Rail scene-library row click | open scene | **WIRED** | :325 |
| Rail scene-library "+" add-to-open-plan | add to the open plan; dedupe/no-target notices | **WIRED, weak feedback** | :335 → `addSceneToOpenPlan` :365. Notices at :373/:393 are `div`s with **no class** → rely on `.shell-rail-notices` padding only (:2625); confirm they are visibly styled, else NO-FEEDBACK for the "open a plan first" / "already in plan" cases. |

### 1C. Plan shelf (`app-shell.js renderPlansSurface`, README §A)

| Affordance | Expected | Status | Notes (file:line) |
|---|---|---|---|
| Plan card click | open runsheet | **WIRED** | :493 |
| "+ New plan" card | create + open | **WIRED** | :499 |
| Card hover (teal border) | visual only | **WIRED (CSS)** | presentational |

### 1D. Plan runsheet (`app-shell.js renderPlanSurface`, README §B)

| Affordance | Expected | Status | Notes (file:line) |
|---|---|---|---|
| Plan title (contenteditable) | blur = rename, propagate to rail+breadcrumb | **WIRED** | :545-565 `savePlanName` :634 |
| "Delete plan" | guarded confirm → delete → back to shelf | **WIRED** | :576 `confirmDeletePlan` :606 (distinct verb: scenes survive) |
| Scene row body click | open scene | **WIRED** | :701 |
| ↑ / ↓ reorder | reorder within plan | **WIRED** | :704-705 `reorderRunsheet` :724 |
| ✕ remove-from-plan | unlink only + undo toast | **WIRED** | :706 `removeSceneFromPlan` :735 (distinct verb) |
| "+ Add scene" panel | inline place chips + new-place + create-scene | **WIRED** | :592-601 reuses `buildAddScenePanel` (plans-view.js) |
| Reorder / remove feedback | list re-renders | **WIRED** | :732/:741 re-fills rows |

### 1E. Scene page (`session-planner-view.js`, README §C/§E)

| Affordance | Expected | Status | Notes (file:line) |
|---|---|---|---|
| All value fields click-to-edit (not focus-to-edit) | contenteditable, invisible at rest, autosave on blur | **WIRED** | `makeClickToEditField` throughout |
| Scene name / objective / place description edits | inline autosave (place desc → graph node) | **WIRED** | scene page render |
| Missing-description banner → seed+focus | click seeds empty desc, focuses | **WIRED** | §C.5 path present |
| "✦ Draft this from the place description…" | compose read-aloud, undoable | **WIRED** | :2277-2305 `draft-read-aloud-link` + undo toast |
| Add-field chips (+TRIGGER/+GIVES/…) | open one empty editable field line | **WIRED** | add-field chips |
| Page \| Cards segmented control | swap element layout | **WIRED** | :2619 segmented; `data-layout` :1380 |
| Prep \| Run segmented control | hide edit chrome, bump read-aloud, collapse MUNDANE, force-close Wrap | **WIRED** | `applyMode` :2892-2902 |
| `⭑` promote / demote element | graph node + containment / clear bookkeeping (never delete) + toast | **WIRED** | :1233 verb, promote/demote routes |
| `✕` remove element | remove + undo toast | **WIRED** | elements list |
| `+ STAT BLOCK` chip / `▣ NPC or creature` | open editable stat block | **WIRED** | :975-991 |
| Stat block AC/HP/Speed/CR/raw edits | autosave (PATCH-merge) | **WIRED** | :1098-1135 |
| Stat block `− N +` count stepper | floor at ×1 | **WIRED** | :1082-1083 |
| Stat block **Foundry** actor field | store actor id | **PARTIAL (by design)** | :1017 comment — value stored, **no push wired**; expected per design record, flag so QE doesn't test a push |
| `◇ From graph` picker | search graph, attach existing node (no dup) | **WIRED** | from-graph flow |
| `✦ Suggest dressing` | append ≤3 MUNDANE + case-specific toast | **WIRED** | assist-prep flow |
| `← prev` / `next →` | step within plan order | **WIRED, label deviates** | :1432-1448 renders `‹ Prev` / `Next ›` **buttons**, not the design's `← <prev scene name>` / `<name> →`. Behavior correct; label/name fidelity off (note for design, not a wiring fix) |
| **Keyboard `[` / `]`** prev/next | step scene; **suppressed while editing** | **BROKEN** | :2935-2939 guard only checks `TEXTAREA`/`INPUT`. Editable fields are **contenteditable** → typing `[`/`]` in a scene name / objective / read-aloud / element field **navigates away mid-edit**. |
| **Keyboard `Esc`** | close the Wrap panel + inline panels | **BROKEN** | :2940 `Esc` does `location.hash = plansHash(firstPlan)` — it **leaves the scene** instead of closing Wrap. Wrong verb. |
| `✦ Wrap ▸` toggle | slide-down Wrap panel | **WIRED** | :2881-2886 |
| Wrap proposal Accept / Reject / Apply | review-gated graph edits | **WIRED** | Wrap panel (existing review-batch pipeline) |

---

## 2. Prototype-implied interactions the build may lack (sweep)

| Expectation (README §Interactions) | Reality | Status |
|---|---|---|
| Undo toast on **every** reversible action | reparent, add-to-scene, remove-link, create-scene, remove-from-plan, remove/promote/demote element, delete plan, add-to-plan all toast. **`markRelated`** toasts. **Rename node** (world-view saveName :950) has **no undo** — but rename is arguably self-reversible. `saveDescription` no undo (self-reversible). | **WIRED** (rename/desc undo optional) |
| Click-to-edit, never focus-to-edit, no full re-render on keystroke | Honored on both surfaces (contenteditable + debounced blur saves; world desc uses `createFlushableDebounce` :457) | **WIRED** |
| Keyboard `[` `]` `Esc`, suppressed in editable | See 1E — `[`/`]` fire inside contenteditable; `Esc` navigates away instead of closing Wrap | **BROKEN** |
| Drop-target teal highlight during drag | tree rows and scene rows both highlight (:2807/:3001) | **WIRED** |
| Drag affordance cursor (`grab`) | chips (:2861) and loose rows (:2936) are `cursor:grab`; **tree rows are `cursor:pointer`** (:2803) though draggable — minor mismatch with prototype tree row | **PARTIAL** |
| Empty-state affordances | tree contents-empty (:483), inspector nowhere (:773), no-links hint (:797), scene-tray "No scenes yet" (:860) all present | **WIRED** |
| "Create a scene here → jump to planner" seam | wired + e2e-proven (:666) | **WIRED** |
| "Mark something related" | wired (:632) | **WIRED** |
| Type-filter chips + search auto-expand | wired (:246/:259, keep-set :289-294) | **WIRED** |
| Search must NOT filter the centre contents pane | contents come from `childIdsOf` unfiltered (:464) — correct | **WIRED** |
| "Open full page →" | no handler | **MISSING** (matches prototype) |

---

## 3. Prioritized wire-up list (for the implementer)

**Constraint: wiring + minimal feedback only. Do not touch layout, colours, type, or spacing.
Use existing `--sp-*` tokens and `showUndoToast`.**

1. **[P0] Scene-add feedback (the reported "doesn't stick").** world-view.js.
   - Add element count to the tray meta so it reads `place · N elements · ago` (prototype
     World Graph.dc.html:608). Source N from `GET /scenes/:id/elements` length (same call
     app-shell.js:680 uses). `.wv-scene-drop-meta` already styles this — no CSS change.
   - Make `addNodeToScene` (scene-membership.mjs:73) call `touchScene(world, sceneId)`
     (scenes.mjs:227 exists) so a drop bumps the scene to the top and flips `agoLabel` to
     "just now."
   - On successful `addToScene` (:910), flash the target `srow` with the existing
     `.wv-drop-target` teal for ~600ms so confirmation is on the row, not only the transient toast.
   - **What should happen:** dropping a node on a scene row ticks its count +1, moves it to the
     top as "just now," flashes teal, and toasts — the add is unmistakable.

2. **[P1] Disambiguate reparent vs. scene-add (Root cause A).** Do not silently reparent when the
   GM meant scene-add. Options (pick one, no visual change): (a) keep as-is now that P0 makes the
   correct gesture obviously effective; (b) add a one-line hint under the tree already exists
   (world-view.js:203) — extend the scene-tray head hint (:846) to read "Drag a node here to put it
   in this scene" so the two gestures are labelled. Prefer (a)+(b); no behavior change to reparent.

3. **[P1] Scene-page `Esc` verb (BROKEN).** session-planner-view.js:2940. `Esc` must **close the
   Wrap panel** (and any open inline panel), per README §Interactions — NOT navigate to the plan.
   Change the handler to: if Wrap panel open → close it (`wrapPanel.hidden = true`, reset
   `wrapBtn` label); else close any open inline add/encounter panel; else do nothing. Remove the
   `plansHash(firstPlan)` navigation.

4. **[P1] Scene-page `[`/`]` suppression (BROKEN).** session-planner-view.js:2937. Extend the guard
   to also ignore when editing rich text: `if (t && (t.tagName === "TEXTAREA" || t.tagName ===
   "INPUT" || t.isContentEditable)) return;`. One-line fix; stops bracket keys from navigating
   away while the GM types a name/objective/read-aloud/field.

5. **[P2] "Open full page →" (MISSING).** world-view.js:760. Either wire the click to the entity's
   full page route/hash, or (if there is no such page yet) remove the `cursor:pointer` from
   `.wv-inspector-openfull` (:2959) so it stops advertising interactivity. Decide with product.

6. **[P2] Rail add-to-plan notices (weak feedback).** app-shell.js:373/:393 create classless
   `div`s. Give them a class already styled under `.shell-rail-notices` (or add a token-based rule)
   so "Open a plan first" and "already in plan" are legibly visible; today they may render as
   near-invisible bare text.

7. **[P3] Tree-row drag cursor (PARTIAL).** style.css:2803 — add `cursor: grab` to `.wv-tree-row`
   to match the chips/loose rows and signal draggability (prototype tree row is grab-able). Purely
   an affordance cue; no layout impact.

---

## 4. Note to QE (Playwright)

**Native HTML5 drag-drop is the big gotcha.** Every drop in this app uses real
`dragstart`/`dragover`/`drop` events and a **module-level `dragId`** (world-view.js:367) — the drop
handlers read `dragId`, not `dataTransfer`. Playwright's `locator.dragTo()` and
`.hover()+mouse.down/up` frequently do **not** synthesize native `dragstart`/`drop` in Chromium, so
those helpers will silently no-op here. Note the existing e2e (`phase30-world-surface.e2e.mjs:170`)
tests reparent via **`fetch` to the route**, not via the UI drag — the drag-drop UI path is
currently **untested**. To exercise the real UI wiring:

- Dispatch the sequence manually with a **shared `DataTransfer`** via `page.evaluate`/`dispatchEvent`:
  create one `DataTransfer`, `dispatchEvent(new DragEvent('dragstart',{dataTransfer}))` on the source
  row, `dragover` + `drop` on the target row/scene row with the **same** `dataTransfer`. Because the
  handlers key off the module `dragId`, the `dragstart` **must** hit the real source element (so the
  app's own `startDrag` runs), then `drop` on the target.
- **Reparent test:** dragstart on `[data-testid="world-tree-row"][data-entity-id=A]`, drop on tree
  row B, then assert (via `GET /api/graph?filter=all`) a `containment` edge A→B exists AND the tree
  re-renders A nested under B.
- **Add-to-scene test:** select a node so the inspector renders, dragstart on a tree row, drop on a
  scene-tray row, then assert `GET /scenes/:id/members` contains the entity **and** (after P0 fix)
  the tray row's count/`agoLabel` updated. Note: scene-tray rows have class `.wv-scene-drop` but
  **no `data-testid`** — QE should target by class for now, or the P0 fix should add a testid
  (`world-scene-drop-row` + `data-scene-id`).
- **Negative/feedback test:** confirm a successful add produces a visible, persistent change (count
  tick / recency flip / row flash), not only the 6s toast — this is the regression that would have
  caught the reported bug.

**Plain click/keyboard (no DnD dance needed):**
- Surface toggle, world select, breadcrumb, rail plan/scene clicks, "+" new plan / add-to-plan,
  plan card, runsheet ↑↓✕, delete-plan confirm, all contenteditable blur-saves, Page/Cards,
  Prep/Run, promote/demote `⭑`, stat-block stepper, add-field chips, draft-read-aloud, Wrap toggle —
  standard `click()` / `fill()` / `keyboard.type()`.
- **Keyboard nav:** after the fixes, assert `[`/`]` navigate **only** when focus is outside an
  editable, and that pressing `[` **inside** a focused contenteditable does NOT change the hash
  (this pins fix #4). Assert `Esc` **closes the Wrap panel** and leaves the scene hash unchanged
  (pins fix #3).
- **Loose-thread filter chips, type-filter chips, search:** click + assert `world-tree-row` count /
  visibility; search should keep matches + ancestor chain.

---

### Surfaces covered
World surface, Shell (topbar/breadcrumb/rail), Plan shelf, Plan runsheet, Scene page.

### Files audited
`design/session-planner/{Session Planner.dc.html, World Graph.dc.html, README.md}`;
`review-ui/public/{world-view.js, app-shell.js, session-planner-view.js, plans-view.js, style.css}`;
`review-ui/server.mjs`; `wf-mcp-server/lib/manual-edit-ops.mjs`;
`session-planner/{scene-membership.mjs, scenes.mjs}`; `review-ui/test/e2e/phase30-world-surface.e2e.mjs`.
