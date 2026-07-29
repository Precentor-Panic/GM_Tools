# GM_Tools — Phase 16 Design Record: Session Planner

**Status:** design complete, not yet task-planned or built. This record captures the full design round — the original ask, two initial expert reviews, a web-research pass on prior art, four DM-archetype persona reviews (run twice, once on the base design and once on a mid-round reframe), and a live schema check against `foundry_worldFabric`. Written up now so the shape survives past this conversation; a `phase-16-tasks.md` should be drafted from this before any code is written.

**Correction applied after first draft:** the original "goal-adjacency via a new `resolution` edge type" mechanism (§4 in the first pass) was built on a misreading of the motivating example. The goblins/wolves example was never about two entities semantically resolving the same abstract need — it was about two entities that both physically live in the same forest the party is walking through. That's a spatial fact, not a semantic one. §2.1 and §4 below reflect the corrected, simpler mechanism: **distance from the party's path of travel**, not a resolution-graph walk. No new relationship type is needed for the core mechanism. The `resolution` edge idea wasn't worthless — it's kept in §9 as a distinct, narrower, deliberately-deferred idea for a real but different use case (true alternate solutions to one explicitly stated objective), separate from what this phase actually needs.

---

## 1. Motivation

GM_Tools has no session-planning surface. The DM has to manually reconstruct "what's relevant for tonight" by browsing the graph. The original ask (Russell): given a planned route or a home-base area, use the graph to surface everything relevant — and, separately, give the DM a way to record what actually happens at the table without that turning into a second, drifting source of truth.

The very original "Tool 5" concept (`/plan-session` etc.) from the earliest version of `PLAN.md` never got built; this supersedes and subsumes that idea now that the graph, mutation engine, and review-ui actually exist to build it on.

---

## 2. Core mental model

### 2.1 Distance from a path, not radius from a point — one traversal, no new edge semantics

Early in this round, four DM-archetype reviews split on whether the "neighborhood" query should be organized by physical/containment distance or by narrative/goal relevance — Alexandrian-style node-based play wanted goal-relevance to dominate; West Marches, minimal-prep, and improv-heavy wanted physical distance primary with goal-relevance as an optional overlay. A mid-round idea proposed resolving this with a new `resolution` edge type and a goal-adjacency graph walk.

That framing was corrected: the actual motivating case (goblins and wolves both being "things the party could run into") was always a spatial fact, not a semantic one — both live in the same forest the party is walking through. The real requirement is **distance from the party's intended path of travel**, which is a straightforward generalization of the path-between query already scoped for this design: instead of collecting only the nodes exactly on the path between two locations, collect everything within some hop/containment tolerance of *any* point along that path — a corridor, not a line. When there's no multi-point route, just a single home-base location, the corridor degenerates to the plain radius-from-point case.

**This is one traversal, one metric, no new relationship type, no hook entities required as a mechanism.** If a route's endpoints happen to be informed by a stated objective, that's just how the DM chose the path — it doesn't change how the corridor traversal itself works. This is simpler than the original two-axis framing and resolves the same tension: physical distance is always the metric; a route (vs. a single point) just changes its shape from a point-radius to a path-corridor.

This also resolves the West Marches finding that most sessions don't start from a stated objective at all: with no multi-point route (just a home base), the query is plain radius-from-point, exactly as that persona wanted as their default.

### 2.2 Scenes, not a single fixed route

Session structure is modeled as a chain (and tree — see below) of **scenes**, not a single precomputed route:

- The starting scene = wherever the party is at session onset (a location entity; optionally tagged with a freeform note about what objective, if any, brought them there — informational context, not something a traversal engine consumes).
- From any scene, the party can move anywhere. Re-running the corridor/radius traversal from the party's actual current position is the *same* query described in §2.1, invoked fresh — not a fallback path bolted onto a pre-picked route.
- **A scene can fork.** If the party does something entirely off-plan (go explore that cave, harass that town official), the DM creates a new scene node cheaply, right there. The new scene is auto-stamped with metadata about where it came from: parent scene, the location/entity context active at fork time, and any freeform objective note that was active. This is the structural answer to the railroading risk the improv-heavy reviewer raised (see §6) — going off-script is a first-class, low-friction action, not something the tool has to talk the DM out of over-trusting a curated list.
- Scenes are **not** permanent World Fabric graph entities. They're lightweight, session-scoped state — the same tier as the existing route/radius selection, not new canonical schema. A scene only leaves a durable trace in the graph if something created during it (a note, a new node) gets run through intake and accepted.

---

## 3. The two content modes (why the brief isn't just a linked node list)

Grounded in real prior art (see §8) and sharpened hard by the DM reviews: there are two genuinely different reading modes, and conflating them was the single biggest flaw in the first draft of this design.

- **Lookup mode**: an entity's full established description/history. Fine to require a click-through — this is a deliberate, occasional action, not something that needs to be ambient.
- **Ambient/improv mode**: a condensed, **always-visible** digest of what's in the current scene's neighborhood, with zero clicking required. Modeled on TiddlyWiki's field-level transclusion (pull just a compact fact-slice, live) combined with Roam's always-expanded-by-default linked references (not gated behind hover, per Obsidian's known complaint that backlink existence itself is invisible until interacted with).

**Concrete content format for the ambient digest**, locked in by the minimal-prep review and unchallenged by the others: `Name (one-word role tag) — the single relationship-to-here fact + the one hook that matters`, hard-capped around 12-15 words. Two lines of content means it belongs in lookup mode, not ambient. **The digest renders empty for genuinely undeveloped nodes — it never pads or fabricates to fill space.** That's the line between retrieval (fine) and speculative pre-writing (explicitly against the "prep what pays off" philosophy this design is trying to support, and a bad habit regardless of DM style).

---

## 4. Path-corridor traversal (no schema addition needed)

The mechanism is now just the generalized path-between query from §2.1: given a route (2+ locations) or a single home base, walk containment/presence edges to build the path (or use the single point), then collect everything within a configurable hop/containment tolerance of the nearest point on that path. Same engine as the originally-scoped `path-between`/`radius-from` primitives from earlier in this round — the only addition is corridor tolerance around a multi-point path instead of just the exact path nodes.

No new relationship type, no hook entities, no live-schema change required for this. The live schema check against `foundry_worldFabric/scripts/constants.mjs` that motivated the original (now-corrected) proposal is preserved as background research in §9, since the gap it found is real and may matter for a different, later feature.

**Constraints from the DM reviews that still apply to this simpler mechanism:**

- **Corridor width should be tunable** (a DM might want a tight corridor for a focused delve, a wide one for open sandbox travel) — this maps directly to what West Marches and minimal-prep were actually asking for when they wanted physical distance to stay primary and controllable.
- **Never double-counts into the edge-of-world flag** (§5) — a node picked up by the corridor traversal and a node flagged as content-thin are still separate signals, consistent with §5's content-vs-structure split.
- **Degrades gracefully with a single point** — a home-base-only session (no multi-point route) is just the radius-from-point case, matching West Marches's stated default.

---

## 5. Two flags, not one

- **Content-readiness ("edge of the world")**: no prior narration + open deferred-debt (`pending-resolution`) entries tied to the node. Reuses existing data, no new schema. Signals "you haven't written this yet."
- **Structural under-connection**: a node with too few connecting edges (clue-redundancy risk, or in the extreme, a genuine dead end). A fully-written node can still be structurally fragile; a fully-connected node can still be unwritten. These are different DM responses (write more vs. add another edge) and must stay two separate flags.
- **Both need severity scoped to current relevance**, not a flat list — loud only within the current scene's radius/goal-adjacency result, a quiet collapsed count for everything beyond it. Without this, either flag becomes wallpaper in any sandbox-shaped campaign (West Marches finding, but generally true).

---

## 6. Notes-as-deferred-intake

Notes are not a new durable "informal graph" layer sitting beside canon. They're raw material for the **existing** writeup-import / scan-mentions pipeline, batched and deferred rather than invented as new infrastructure:

- Captured with **zero ceremony**: auto-anchored to whatever entity/scene is already current, one text field, autosave on blur (not an explicit Save button — interruption is the normal case at a table, and losing a jotted note to a dismissed popover is a real, recurring failure mode per the interaction-design review).
- The entity/scene anchor becomes a high-confidence hint for the later intake pass's fuzzy-match prepass (the mechanism already built in Phase 13.4 specifically to stop the LLM from missing an existing node and inventing a duplicate) — this is a genuine, close-to-free win from routing notes through existing machinery instead of a bespoke store.
- Batched: several notes get run through intake together, producing proposed mutations that land on the **existing** review/accept gate. No new "promote to canon" UI concept — the batch-intake trigger itself is the explicit action; review/accept remains the actual safety valve. This also means notes never auto-feed narration silently, preserving the project's standing no-silent-write invariant without inventing a parallel mechanism for it.
- The "run intake" trigger can fire mid-session or between sessions — architecturally identical either way, just a matter of when the DM chooses to pull the trigger. Improv-heavy DMs will realistically only use this after the session; that's fine, and expected.
- **Multi-group collision gap** (West Marches, real for this project's actual campaign structure too if multiple play threads ever touch the same node in a short window): the review queue needs to group pending mutations by entity, not just chronologically, so a reviewer isn't approving two contradictory pending proposals on the same node blind.

---

## 7. Framing corrections to the Session Brief document

Two independent reviewers (improv-heavy and node-based/Alexandrian), coming from opposite ends of the prep spectrum, converged unprompted on the same critique: presenting this as a "Brief... read like a module... numbered by stop" primes exactly the linear, plan-following mental model both styles are built to avoid — regardless of what the underlying graph model actually supports. Adopting their fix, since it costs almost nothing to build and two unrelated personas both hit it independently:

- No chapter numbering. Each location/scene entry reads as an independent dossier, not a sequence.
- **Staleness detection is proactive**, not something the DM has to remember to trigger. The tool flags divergence between the picked route/scene and the party's actual current position itself, since the traversal is already instant and deterministic — there's no reason to wait for the DM to ask.
- Presented in tone as a live instrument (continuity insurance — "does this improvised thing still connect to what's established") rather than a plan to be followed. The mechanics underneath (deterministic traversal, flag-don't-generate, notes deferred to review) were already right per the improv-heavy review; only the surface language needs to change.

---

## 8. Prior art grounding (from the research pass)

- **Realm Works** has reveal-states and a relationship web, but confirmed (via research) to not condense the neighborhood into a glanceable digest — validates this as a real, still-open gap rather than a solved problem being reinvented.
- **World Anvil's Article Blocks** (inline cards with hover quick-info) and its Digital StoryTeller Screen (an explicit at-the-table surface distinct from the full wiki) are the closest existing structural precedent for the lookup/ambient split.
- **TiddlyWiki's transclusion model** (`{{{ }}}` filtered transclusion) is the closest architectural precedent for the ambient digest specifically — a live, addressable slice of another entity's data rendered in place, not a link and not a full copy.
- **Roam's always-visible linked references** (not opt-in, not hover-gated) is why the ambient digest is specified as persistent and always-expanded rather than a hover state.
- Progressive disclosure is the actual UX term of art here (not "peripheral vision," which doesn't have established literature under that name).

---

## 9. Explicitly deferred out of this phase

- **A true semantic "alternate solutions to one explicitly stated objective" mechanism** — the idea originally (mis)proposed as the core traversal in the first draft of this record. Distinct from the corrected §4 mechanism: this would be for the narrower case of an explicit, named objective (not just "the party is walking through a forest") where the DM wants the tool to know that two different approaches genuinely satisfy the same stated need, regardless of physical distance. Real schema gap confirmed live in `foundry_worldFabric/scripts/constants.mjs`: `RELATIONSHIP_TYPES`'s single flat `causal` type today covers only *upstream* semantics (`Object.origin_event`, `Event.instigator`, `Event.consequence_of`) — nothing represents *downstream* resolution ("this entity addresses that need"). If this is ever built, it needs a new relationship type (e.g. `resolution`/`addresses`), additive-only, the same pattern already used twice in this codebase (`location` split into `containment`/`presence`; `origin` split out of `containment`). Worth revisiting if a real campaign situation shows up where corridor-distance genuinely isn't enough — not built now.
- **Clue-redundancy path-counting** (counting independent paths into a single fact/reveal node, per the Three Clue Rule) — a real, valuable, but genuinely separate feature from both §4 and the item above. Needs its own traversal metric on top of whatever edge type ends up representing "reveals." Flag for a later phase, Phase-9-style, rather than folding into this one.
- **Thread/relationship-connection as a selectable digest axis** distinct from physical proximity (Alexandrian wanted this to be able to dominate for node-based campaigns) — corridor traversal (§4) covers the main case now that it's understood to be spatial; a fully general "reorder the digest by any axis" config is not core scope now.
- **Axis-priority configuration** (letting a node-based-style campaign flip to some other axis by default) — noted as a plausible fast-follow, not v1.

---

## 10. Open items for the task-planning pass

- Exact corridor-tolerance model: hop count vs. containment-depth vs. a mix, and whether it should be a single global default or DM-tunable per session.
- Exact shape of the ephemeral scene-state record (fields: parent scene, location, freeform objective note, fork timestamp) and where it lives (likely alongside the existing route/radius selection state, not a new top-level store).
- Whether the ambient digest's "empty for undeveloped nodes" behavior needs its own visual treatment (vs. just omitting the entity) so its absence itself is legible as a real signal, not a rendering gap.
