# GM_Tools — Phase 21 Design Record: Scene Planning Redesign (full vision)

**Status:** design draft, incorporating the project owner's direct adjudication of the four-DM-persona review round — several persona concerns were explicitly overridden with reasoning, not just averaged. This is the full vision; a PM phasing pass (§8) splits it into buildable phases. Supersedes and extends Phase 16/17's Session Planner, which stays live and correct as far as it goes — this redesign adds a persistence/construction layer on top of it, not a replacement of its underlying corridor-traversal engine.

---

## 1. Core shift: scenes are place-continuous, not party-continuous

The single most important correction from the review round (West Marches DM, adopted directly): a persisted scene plan must NOT be modeled as "this session, with this party" — it's "the built-out plan for this stretch of world," reusable regardless of who's attending on a given night. This mirrors a pattern already proven in Encounter Builder: roster attendance is a pure filter layered on top of a persisted pool, never baked into the pool itself. Scenes follow the same split — attendance/who-showed-up stays a session-instance overlay, never mixed into the persisted scene structure itself.

Scenes anchored to real locations stay in the order those locations actually sit in the world — this isn't a limitation to design around, it's correct: unless the party is being deliberately teleported (an edge case, not the expected mode), travel order **is** location order. Arbitrary mid-plan reordering is not a requirement.

## 2. Scenes as persistent, browsable containers

- A **scene** is a persistent planning unit anchored either to a real "place" entity, or to a **transit/path entity** — see §3, this is not a lightweight placeholder concept, it's a real committed entity.
- Scenes chain in the order their anchors sit in the world. A scene chain is a reusable, persisted plan — not tied to a specific real-world session date or specific party roster.
- A dedicated **Scenes tab**, separate from "the plan currently being built," lets the DM search/browse every previously-prepared scene across the whole campaign and quickly re-enter any of them — not just resume the single most-recently-touched one (which Phase 20 already fixed as a narrower, single-scene case). Scenes should be stored/queryable in a graph-like fashion specifically so that selecting one can surface other scenes linked to it (the path-based chain it belongs to) — this does not require scenes themselves to become World Fabric graph entities (Phase 16's original reasoning for keeping scenes out of the WF graph still holds — they're session-planning state, not narrative fact) but the scene *store* needs real relational/traversal capability it doesn't have today (`listScenesForWorld` is a flat per-world list with no linkage concept). Flagged as an open architecture question for the phasing pass, not resolved here: does scene-to-scene linkage live in the scene store itself (each scene records its chain neighbors), or is it derived on demand from the anchors' own WF graph adjacency? Both are defensible; pick one deliberately.

## 3. Path/transit scenes ARE committed graph entities — explicit correction

A tactical-DM-persona objection (treating a path/roadway node as a real graph entity is unnecessary "worldbuilding ceremony") was explicitly and directly overridden by the project owner, with reasoning worth preserving verbatim in intent: committing the placeholder is what makes "the area between those two locations" **findable again later**. You don't have to give it a rich name or description — it can stay exactly as generic as "Path" or "On the Road" indefinitely — but if it's never committed, it's a throwaway, and a DM who wants to revisit that stretch later has nothing to come back to. A DM who genuinely doesn't care about worldbuilding never has to see or touch it beyond adding it — the entity existing quietly in the background still lets other LLM-assisted generation (narration, texture, future features) draw on whatever context that intervening space accumulates over time, the same way any other graph entity already does.

**Concrete implication**: adding a transit scene between two anchors immediately creates a real, minimal World Fabric entity (name defaults to something generic like "Path" or "The Road to X," type reflects it's a transit/liminal space) — not a deferred/lazy placeholder that only becomes real once developed. "Develop this node" (§5) can flesh it out later exactly like any other entity; leaving it minimal forever is a fully legitimate end state, not a half-finished one.

## 4. Adding nodes to a scene

- Default surfaced set stays 1-hop from the scene's anchor (unchanged from Phase 16/17's corridor logic) — the review round's "escape hatch beyond 1-hop" request is explicitly NOT how this gets solved.
- Instead: an **"Add arbitrary node"** action lets the DM search/pick any graph entity, not just what's currently surfaced as 1-hop.
  - If the picked entity is not reachable from the scene's current visible set via any path, it's added directly, no further prompting.
  - If it IS reachable (a path exists through entities not currently shown), the DM is **offered** the option to also add the intervening entities, to keep the scene's connectivity legible — offered, never forced.
- This one mechanism (arbitrary add + optional intervening-node fill, plus trivially easy remove) is the complete answer to "I need to reach further than 1-hop" — no separate radius/expand control needed anywhere.

## 5. Scene development: explicit, button-triggered, never automatic

- **Two peer actions, both explicit buttons, neither a default/automatic behavior**: "Develop this node" (existing, single-entity) and a new **"Develop this scene"** (batch, every member of the scene in one pass).
- "Develop this scene" reuses the **existing Q&A/iterative-refinement pattern** already built for single-node development (`prep-content-ops.mjs`'s `proposePrepFramingsOp` → `reframePrepFramingsOp` round-trip → `generatePrepContentOp` → explicit accept/discard) — extended to run across every scene member in one guided pass, not a single silent fire-and-forget mutation. This is not a new review mechanism to design from scratch; it's the established one applied at a new granularity. The four-persona review round's unanimous concern (batch development needs a review step, not auto-apply) is resolved by this alone — it was never intended to bypass review, and shouldn't be built that way.
- A **scene-local rollback control**, visible directly in the scene development UI — not the Settings/gear menu, which is where it lives today and where it's too slow to reach mid-work. Needs to let the DM quickly unwind whatever development work just happened in this scene specifically. `manual-undo.mjs`'s existing single-slot mechanism may not be sufficient as-is (it's a single global slot, not scoped to "everything I just did in this scene") — flagged as a real open question for the phasing/task-planning pass: does this need a scene-scoped action history, or does surfacing the existing single-slot undo locally (with clear "this is global, not scene-scoped" messaging) cover the real need? Don't assume the easy answer without checking against what "quickly unwind any of the work" actually requires.

## 6. Encounters and events: equal visibility, always

Both "Add Event" and "Add Encounter" stay equally easy to find, regardless of how often a given DM style uses either. Explicit product principle, stated directly by the project owner and worth carrying forward as a standing rule for this whole feature area: **the fix for "I don't want to be nudged toward X" is not clicking the button for X — it is never making X harder to find for the DM who does want it.** Hiding or de-emphasizing a capability because one persona uses it less is treated as a bad UI choice here, not a personalization opportunity. Adding/building/removing scene elements should stay uniformly as easy as possible across the board.

## 7. Mid-session ad-hoc scene creation

The "+" to insert a new scene mid-session is intentionally meant to be operated **silently by the DM**, combining fast ad-hoc naming (DM-typed and/or LLM-assisted) with notes and quick generation to convincingly fill gaps in the world on the fly. The actual value being designed for: letting the DM create the impression of a much more thoroughly-prepared world than what was literally pre-built — a deliberate, benign "smoke and mirrors" effect ("he had this whole area planned out, we must be onto something") that produces a fuller table experience without railroading players toward pre-ordained content or the DM's prep being visibly exposed as reactive. Both DM-persona concerns from the review round point at the same underlying requirement, not different ones: this has to be genuinely fast (one field, one button, matching the review round's stated bar) and non-disruptive to the DM's own attention at the table — not two competing asks.

## 8. Table-read view: "information cockpit," not simplification

Reject "aggressively simplified" as the design target for the at-table reading view — that framing, taken at face value, is what produced Phase 17's actual shipped cards, which the project owner's own much earlier direct feedback already flagged as not surfacing enough to be useful ("the cards on that session plan tab really don't do a ton in terms of surfacing information"). The corrected target is an **information cockpit**: dense, complex information organized for fast at-a-glance access — on-page, on-hover, or one click away with an easy, fast path back — the way a pilot's cockpit surfaces a lot of real information at a glance rather than hiding it for the sake of looking clean. This is a real, nontrivial information-architecture problem, not a copy tweak, and likely deserves its own focused design pass (a UX round grounded in real dense-dashboard/cockpit-style UI prior art, similar to how earlier feature rounds pulled in real comparative research) rather than being folded as an afterthought into the scene-construction work.

## 9. Explicitly settled, not open questions

- Path/transit anchors are real committed entities from creation (§3) — not deferred, not lazy.
- 1-hop default stays; "add arbitrary node + optional intervening fill" is the complete mechanism for reaching further (§4).
- Encounters and events are equal-weight UI elements, permanently (§6).
- Scene order within one chain follows physical/location order; arbitrary reordering is not a requirement (§1).
- "Develop this scene" is explicit and button-triggered, reuses the existing Q&A review pattern, never silent or automatic (§5).

## 10. Genuinely open questions for the phasing/task-planning pass

- Scene-to-scene linkage storage model (§2) — in the scene store itself, or derived from WF graph adjacency on demand.
- Scene-local rollback's real scope (§5) — a genuinely scene-scoped action history, or the existing global single-slot mechanism surfaced locally with honest framing.
- The "information cockpit" table-read view (§8) is large enough it may warrant its own dedicated design/research round rather than being scoped inside the main construction-UI phase.
- Exact entity-type/default-naming convention for a freshly-created transit/path anchor (§3) — needs a concrete default, not left to whichever phase happens to build it first.

## 11. Explicitly out of scope for this whole redesign

- The "beyond this corridor" collapsed-count mechanism from Phase 17 — unaffected, this redesign adds construction/persistence on top, doesn't touch that.
- Any GM_MapGen/battle-map integration — still tabled, unrelated track.
- Foundry-native bestiary/roster scan and monster reskinning — still queued behind this redesign per the project owner's own stated sequencing.
