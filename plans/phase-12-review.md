# Phase 12 — Interactive Graph Editor Design

**Why this document exists:** direct hands-on feedback described a missing workflow — reading generated content that mentions an "arena champion" or "a quartermaster" with no way to turn those into real, linked graph entities without leaving the tool. Investigating that surfaced a related, confirmed gap: there is no delete capability anywhere in GM_Tools (discovered concretely when the project owner pointed at real stray entities — `alvor`/`riverwood`/`gerdur`/`sven` — sitting in their actual `wf-test` world data, which they could not remove). Together these mean the graph view (Phase 7) needs to become an actual editing surface, not just a read-mostly review view. This document records the resulting decisions, DM metadata review, and interaction-design review; `plans/phase-12-tasks.md` is the build plan.

---

## Decisions, direct from the project owner (not open for debate)

1. **Manually placing a node or drawing an edge writes immediately** — no accept/reject gate. The owner is directly authoring it, not reviewing an AI proposal.
2. **Node/edge deletion must exist** as a real capability — it does not today.
3. **Asking the LLM to extend the graph from a prompt still goes through the existing accept/reject review flow**, unchanged — the owner explicitly confirmed they like the graph serving as that review surface (established in Phase 7).
4. **"Scan for mentioned entities"**: given a block of text (most commonly Phase 11's generated prep content), scan it and return two distinct kinds of results — links to entities that already exist (new edges) and names that don't match anything (new entities) — reusing writeup-import's existing name+type dedup, not a blind create-everything pass. Both result types go through the existing accept/reject flow.
5. **Narration reset**: a way to clear a node's current narration back to empty, without violating the existing "narration history is never silently deleted" rule from Phase 10 — reset must mark, not delete.
6. **General flexibility requirement**: a second interaction-design pass explicitly checking for any add/remove/reset/edit control missing from the above.

## The Alvor/Riverwood finding (context, not a decided item)

Investigated directly against the real `wf-test` world: `alvor`/`riverwood`/`gerdur`/`sven` are genuinely present, with clean hand-typed ids unlike every other (Foundry-random-id) entity in that world. Plausibly pre-existing World Fabric demo/seed content (those four names are literally Skyrim's opening-village NPCs, and the world is named `wf-test`) rather than test pollution introduced during this engagement — not confirmed either way, and nothing was deleted without the owner's explicit say-so. The actionable takeaway regardless of root cause: **there was no way to remove them**, which is what this phase fixes.

---

## DM metadata review — what already exists

Read directly from World Fabric's real schema (`graph-service.mjs`'s `upsertEntity`, `constants.mjs`), not assumed:

- **Already exists, not missing**: `importance` (0-1), `tags` (string array), `lastSession`/`sessionSeen` (session-staleness tracking, with an existing `staleThreshold` setting), `namespace` (campaign vs. imported-rules content), `notes` on edges (freeform, already covers "why this edge matters"). None of these need building — they exist in the schema but currently render nowhere in GM_Tools' UI.
- **Genuinely missing from the schema**: no alive/dead or active/dormant status on any entity type, no player-vs-GM visibility flag, no PC-vs-NPC distinction (a `person` entity is a person, players and NPCs identical).
- **What GM_Tools already knows how to populate** (`writeup-import.mjs`'s `RawWfiEntity`/`RawWfiEdge`): name, type, description, summary, importance, tags, attributes; edge source/target, relationshipType, label, strength, valence, notes. Never sets `imageUrl`/`foundryRef`/`x`/`y`/`lastSession`/`sessionSeen`/`namespace` — those are Foundry-only today. The new manual-edit surface (task 12.3) can reasonably expose some of these for the first time.

## DM metadata nominations — confirmed by the project owner (5 of 6 approved)

**Approved, requires a World Fabric schema change** (cross-repo, in `/home/russell/foundry_worldFabric`):
1. **Status/lifecycle chip** — alive/dead (person), active/destroyed/lost (place/object), active/disbanded (faction).
2. **GM-only visibility flag** — whether the party has ever actually encountered/learned of this entity, distinct from the existing `namespace` field.
3. **Canon-lock / draft-vs-confirmed flag** — marks settled lore so a future LLM-assisted extend pass can't silently contradict it; distinct from the existing hand-authored-vs-LLM-generated `source` field.
4. **PC vs. NPC distinction** on `person` entities.

**Approved, GM_Tools-side only, no schema change:**
5. **Surface already-existing fields** (`importance`, session-staleness, `foundryRef` presence) in the new graph editor's node view/popover — pure UI wiring, no new data.

**Explicitly NOT approved — do not build:**
- A lightweight "quick plot-relevance note" per node, distinct from Phase 11's full prep-content. The owner did not select this option; it is out of scope for this phase.

## Interaction-design review — the concrete spec

Legend: **[DECIDED]** = one of the six decisions above, not open for debate. **[MY CALL]** = the reviewing persona's own addition/recommendation, kept separate per this project's established practice.

### Add node / add edge
- Toolbar "+ Add Node" enters placement mode (crosshair cursor, dimmed canvas). Click empty space → an inline form (name, type, optional description) anchored at the click point, reusing the existing popover-anchoring mechanism. "Create" writes immediately at the clicked position **[DECIDED]**. Esc/click-outside cancels with nothing written.
- **[MY CALL]** Manually-created nodes render in the tool's normal "reviewed" color, never the unreviewed-amber treatment — there's nothing to review on something the GM directly typed.
- Add edge: press-and-hold (~5px drag threshold, distinguishing from the existing short-click-for-popover) on a node body starts edge-draw; release on empty space cancels **[DECIDED]**; release on another node creates the edge immediately with a default relationship type and simultaneously opens an inline prompt for the real type/label/strength/notes **[DECIDED shape]** — dismissing the prompt leaves the edge in place with the default, since the edge already exists.
- **[MY CALL]** No self-loops (silent no-op + toast). Re-dragging onto a pair that already has an edge of the *same* relationship type opens that edge for editing instead of duplicating; different relationship types between the same pair remain legitimately parallel.

### Delete
- Trigger: a Delete (trash) icon in the node popover, and a **new edge popover** (click an edge's line — mirrors the node popover, shows relationship type/strength/notes) gets the same. Delete/Backspace as a secondary shortcut only when a popover's subject is the target — not a global key trap. **[MY CALL]**: no right-click context menu — three triggers for one destructive action is redundant surface, not more useful.
- Confirmation: an **inline confirm within the popover** (not a browser `confirm()`), showing the real cascade count — *"Delete this node and its 3 connected edges?"* — since `confirm()` can't show a live blast-radius count.
- **Undo is not optional here** — see below.

### Scan for mentioned entities
- Primary trigger: on the entity content-generation panel (Phase 11), next to the already-displayed generated text. Secondary: a "Scan this node's content" shortcut in a node's popover, same underlying action.
- Dedup: reuses writeup-import's name+type matching exactly **[DECIDED]** — no new matching algorithm.
- Result review: same accept/reject/regenerate screen as every other AI proposal **[DECIDED]**, but each row carries a mandatory badge + border accent distinguishing **Link-to-existing** (link icon, shows source→matched-existing with an editable relationship-type dropdown) from **Propose-new** (plus icon, editable type + description). Split "Accept All" into **"Accept all links"** / **"Accept all new entities"** so a bulk accept can't blur the distinction.

### Narration reset
- Location: entity detail view (primary) and graph popover (secondary quick-path). Confirmation: lighter-weight than delete's — *"Clear current narration? Previous versions remain in history."* Mechanism: appends a new **empty-content version** to the existing version history with a "reset" marker, moves the current pointer to it — nothing erased, the existing "never silently deleted" rule applied to a blank value, not a new exception to it.

### Completeness check — real gaps found
- **(a) Edit an existing node's own fields directly (name/description/importance) — MISSING, a must-have.** Without it, fixing a typo forces either the AI "develop this node" pipeline (wrong tool) or is impossible. The same popover gaining Delete also gains an Edit (pencil) affordance, turning static fields into the same inline-editable form used for creation. Writes immediately, no gate — same logic as manual creation, applied to editing.
- **(b) Edit an existing edge's fields after the fact — MISSING, also a must-have.** Nearly free given the edge popover already needs building for delete.
- **(c) Bulk-select for group actions — explicitly recommended OUT of v1**, against the owner's own prompt list, with clear reasoning: bulk delete multiplies the blast radius of an action that (per (d) below) only gets single-slot undo — a bulk delete of N nodes would leave N-1 silently unrecoverable, worse than not having the feature. GM_Tools' own graph view also has no existing multi-select interaction model to build on (unlike World Fabric's separate cockpit UI, which does). Ship single-target versions for v1; revisit bulk actions as a distinct follow-up once a real multi-step undo history exists.
- **(d) Undo for the last manual edit — MISSING, and the most important gap in the whole review.** Manual edits bypass the batch system entirely (per decision 1), so the existing "Undo Last Batch" gives zero coverage. A separate, independent **"Undo Last Manual Edit"** buffer: single slot, most-recent-action-only, no history list (deliberately mirroring the batch-rollback's own simplicity). Covers every immediate-write action in this phase: add/delete/edit node, add/delete/edit edge (delete-with-cascade as one atomic undo unit), narration reset. Surfaced via a transient toast after each write ("Node 'Kaeliss' created. [Undo]") plus a persistent toolbar item (grayed out when empty). Any new manual edit overwrites the slot.
- **Cross-cutting, not a separate task**: every new inline-edit surface (add-node form, edge-type prompt, node/edge edit form) treats Esc/click-outside as cancel, matching the existing popover dismiss convention.
- **Explicitly out of scope, named so it's a known limitation, not a silent gap**: renaming a node does not search/replace that name across other entities' narration/prep-content text.
