# GM_Tools — Phase 18 Design Record (Placeholder): Encounter Guidance

**Status:** scoped placeholder — real architecture, deliberately NOT yet run through an expert/persona review round (unlike Phase 16/17), NOT yet task-planned, NOT yet built. Captured now so the shape isn't lost; a fuller review round (mirroring Phase 16/17's process) is the natural next step before task-planning, if/when this gets picked up.

**Why this exists, and what it deliberately is NOT:** the goal is guidance, not automated encounter design and not a rules engine. Two upstream product decisions already made, both worth restating so a future reviewer doesn't relitigate them from scratch:
- Official D&D monster-manual content is not redistributable — this tool indexes the SRD (open-licensed) and otherwise expects the DM to bring their own transcribed/pasted content from books they own. No scraping, no bulk import of copyrighted stat blocks.
- Balance math belongs in a deterministic, non-LLM layer (same split as `propagate.mjs`'s existing mechanisms) — an LLM is unreliable at arithmetic/optimization and a DM wants instant, tunable feedback, which only works if it's cheap and deterministic. The LLM's role here is narrow: extraction/derivation at ingestion time, and thematic filtering at suggestion time. It never picks the final combat math.

---

## 1. Two ingestion pipelines, same shape, two different subjects

Both follow `graph-import/writeup-import.mjs`'s established pattern (propose → typed validation errors → preview/dedup → commit), truncation-aware LLM calls via the existing `callModelDetailed` (`mutation-engine/llm-call.mjs`).

**Input mechanism:** no new npm dependency for PDF parsing. Claude's Messages API already accepts PDF documents natively as a content block — send the PDF straight to the API rather than adding a `pdf-parse`-style library and a text-extraction step of our own. This matters specifically for stat blocks, which are often laid out in irregular columns/boxes that a naive text extractor mangles; native document understanding handles that better than scraped text would anyway.

### 1a. Bestiary ingestion (`combat-planning/bestiary.mjs`, new top-level pipeline stage, sibling to `graph-import/`/`time-skip/`)

- Input: pasted text or a PDF page/excerpt containing one or more stat blocks.
- One LLM call does two things at once (they're tightly coupled — deriving action economy requires the attack list that was just extracted): (1) extract structured fields (name, type, CR/level if present, HP, AC, attacks, special/legendary/lair actions), (2) derive a **rough action-economy score and other power-relevant stats** that aren't literally printed on the page as a single number — e.g. "3 attacks/round averaging X damage, one recharge nova ability, no legendary actions" collapsed into a comparable figure.
- Typed validation error (matching `WriteupImportValidationError`) if the derived shape doesn't parse.
- **Storage is deliberately NOT the World Fabric graph.** A stat block is mechanical reference data, not narrative fact — same reasoning already applied to Phase 16 (scenes aren't graph entities either). Flat per-\<scope\> JSON store, same `DEFAULT_ROOT`/`GM_TOOLS_*_DIR` convention as `entity-narration.mjs`. Open question for the review round: is a bestiary entry scoped per-world or per-user/library-wide? A monster a DM owns isn't really tied to one campaign, but nothing in this project currently has a library store above the world level — worth a real decision, not an assumption.
- A lighter review step than the graph's mutation-review gate — more like `prep-content-ops.mjs`'s accept/discard pattern than the full pending-mutation batch machinery, since a bestiary entry isn't a graph mutation and routing it through that queue would be the wrong tool.
- Only touches the graph at the point a specific creature becomes a named narrative threat — and even then, by reference (an entity attribute pointing at a bestiary/actor id), never by copying the stat block into graph fields.

### 1b. Party roster ingestion (`combat-planning/party-roster.mjs`, same shape)

- Same input mechanism (pasted text or PDF), same one-call extract+derive pattern, applied to PC character sheets instead of monster stat blocks.
- Extracted/derived fields split into two groups with two different consumers:
  - **Combat-relevant**: class/level, AC, HP, attack bonus/damage-per-round estimate, save DCs, notable defensive/offensive abilities — feeds the heuristic balancer (§2).
  - **Broader build/character-relevant**: skills/expertise, notable traits, backstory hooks — feeds skill-check design and the context-exposure API (§3), not the combat heuristic.
- Stored per-world (unlike the bestiary's open per-user-vs-per-world question, PCs genuinely belong to one campaign) — flat store, same convention.

## 2. Heuristic encounter balancer (`combat-planning/encounter-heuristic.mjs`, pure/deterministic)

- Consumes bestiary entries' derived power stats + the real party roster's derived combat stats — not a generic "4 level-5 PCs" assumption, the actual party.
- Replaces CR/XP-budget math (known-weak specifically because it's additive and bolts action economy on as an afterthought multiplier) with a lightweight **expected-value round simulator**: party effective damage/round + control effects vs. total enemy HP, and enemy effective damage/round (counting actual separate actions, not just aggregate power) vs. party effective HP, simulated forward a few rounds to estimate rounds-to-resolve and expected party HP loss.
- Needs a "combat system profile" (attack-roll/AC/save math) to run a real simulation — for a monster or PC from a system without a defined profile, degrades to a cruder power-score comparison rather than refusing to function. Bring-your-own-system stays possible, just less precise without a profile.
- Given a target difficulty and a thematically-filtered candidate pool (the LLM's job, next), suggests specific monster combinations/quantities against that target — the "knobs" (add/remove combatants, minion-rules toggle, legendary-action toggle, scaling sliders) sit on top of this, all still deterministic, all still instant.

**LLM's actual job here, deliberately narrow:** given the current scene's context (location, active threat, faction present — pulled straight from the graph, the same grounding pattern `narrate.mjs`'s `buildAdjacencyContext` already uses), suggest which bestiary *tags/types* fit thematically. It narrows the candidate pool by fit; the heuristic picks the actual roster by math. The LLM never decides final difficulty or composition.

## 3. Context-exposure for other LLM tools (`getPartyContext(world)`, in `party-roster.mjs`)

- A compact, prose-ready summary of the party's build-relevant details (skills/expertise, notable traits, backstory hooks — the non-combat half of §1b's extraction), in the same spirit as `buildAdjacencyContext` grounding narration in real graph neighbors.
- Explicitly **opt-in per call site**, not force-injected into every generated response. This operationalizes the stated caution directly: referencing a specific PC's build/trait in generated content is a genuine "feel good" moment for players when it lands naturally and an eye-roll when it's forced into everything. Any prompt template pulling this in should carry explicit guidance to mention a PC detail only when it's naturally, specifically relevant — not as a reflexive callback every time.
- Consumers: the eventual "scene designer helper," skill-check-design generation, and any other future LLM-assisted prep tool that wants to ground itself in who's actually playing — same pattern, opt-in every time, never a default inclusion.

## 4. Explicitly not decided yet — flag for the review round

- Bestiary scope: per-world vs. per-user/library-wide (§1a).
- Exact shape of the "combat system profile" concept (§2) — how much system-specific math logic this needs, and whether a first version should just hardcode 5e math and treat everything else as the crude fallback.
- Whether encounter instances need any relationship to Phase 16/17's scene concept beyond "can reference a roster + difficulty target" — plausible fit, not designed in detail here.
- UI surface entirely undesigned — this record is engine/architecture only, matching how Phase 16 preceded Phase 17.
