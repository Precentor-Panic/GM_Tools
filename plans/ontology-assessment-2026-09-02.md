# World Fabric ontology assessment — 2026-09-02

Requested by Russell before the Aureus ingest: "what actually is our
ontology? is the current setup sensible? do I remember that we have a few
layers?" — plus the Kilmarn pacing failure ("introduced the BBEG, hinted
at his plans, and the very next block was exactly his plans").

Sources: full read of foundry_worldFabric internals, full trace of every
GM_Tools read/write of the model, and an empirical survey of the two real
snapshots (kilmarn: 64 entities / 202 edges; wf-test/Aethelgard: 36 / 58).
Everything below is verified against code or data, not recalled.

---

## 1. The model as built

**Yes, there are layers — three named, two built.**

- **Layer 0 — archetypes, in code.** Six entity types (person, place,
  faction, object, event, concept) and twelve relationship types
  (unspecified, kinship, social, fealty, membership, location,
  containment, presence, origin, ownership, causal, knowledge), each with
  strength presets. Deliberate doctrine encoded in comments: no `temporal`
  edge type ("time is an attribute on event nodes, not a link");
  containment (structural, never decays) split from presence (temporal,
  decays); origin added for "where someone is from."
- **Layer 1 — world canon.** The per-world persisted graph (Foundry
  settings + the exported snapshot), plus the Type Manager's per-world
  customizations and the Foundry-event automation (session stamping).
  The "figma-like separation" you remembered is exactly this: Layer 0 is
  the master component library, Layer 1 the detached instance — and the
  system's most recurring bug class (three migrations) is the classic
  detached-instance failure: L0 edits never reach an already-instantiated
  world.
- **Layer 2 — the session layer: "doom clocks, thread status." NAMED,
  STUBBED, NEVER BUILT** (M13). The MCP tool `wf_get_session_state`'s own
  description says so; the cockpit carries a literal
  `// TODO ... once M13 exists`. PLAN.md even specified the pieces — a
  deterministic doom-clock counter ("simple integer, non-LLM") and a
  session-runner config with `doomClockThreshold` and an event pool —
  none of which exist.

**The entity record** is a CLOSED 23-field allowlist (anything else is
silently dropped on import — load-bearing fact, see §5). One field is an
open bag: `attributes`. **The edge record**: sourceId/targetId +
relationshipType (a soft enum — nothing validates writes) + free `label`
+ strength + valence + provenance. There are **two relationship layers**:
hand/imported edges, and a derivation pass that projects reference-kind
`attributes` into auto-edges (dashed, "· auto", regenerated wholesale on
every write).

## 2. The lived ontology vs the declared one

The declared formal machinery is mostly dead; the informal channels carry
everything. From the real data:

| Declared | Reality |
|---|---|
| 14 attributeDefs (all reference-kind, all with edge derivation) | **93% never used**; the derivation pass fired ONCE across both worlds |
| `attributes` as the typed field system | 6 of 64 kilmarn entities use it — all fate-threads, under TWO different key schemes (`inscription` vs `phrase`/`grade`/`host`); the schema offers no scalar kind, so the keys people actually wanted are all off-schema |
| `status` enums per type | written as migration defaults only (active/alive), zero `dead/destroyed/lost/disbanded` ever; the one editor is a FREE-TEXT input; **zero readers** |
| `playerKnown`, `canonLocked`, `role` | fully plumbed, migration-backfilled, displayed in exactly one popover, **zero consumers** (role has one accidental reader that prints "npc" where it means "person") |
| `valence` on edges | genuinely SET (~30% non-neutral) but read by nothing |
| relationship-type vocabulary | real, but 12–52% of edges are `unspecified`, the UI writes an out-of-vocabulary `"related"` type, and the module's own LLM prompt strings advertise a STALE vocabulary |
| — | **What actually carries meaning: the six types, `importance` (drives review prominence + context ranking + node size), free `tags` (100% adoption), `description`/`summary`, and above all edge LABELS — 151 distinct prose labels over 202 kilmarn edges ("burning empowers", "may be redirected onto"). The labels are the real relationship ontology.** |

Kilmarn's fate-threads — the most mechanically important objects in the
game — are generic `object`s with a `thread` tag, membership edges to a
"Fate-threads" concept node, and their defining phrase inconsistently
stored (missing entirely on one). The burn schedule's ORDERING exists
only as an HTML `<ol>` in a briefing card plus importance values — no
order/step/clock field anywhere in the graph. Threads got a *layout*
primitive in the planner (`run.group`) but never a *data* primitive.

## 3. Why "hint it, then spill it" happened — the mechanics

Three stacked causes, all verifiable:

1. **Every generation prompt sees canon flat.** The texture pass's region
   context is `name (type) importance: summary` + edges; the adjacency
   builder is name + type + relationship types; the snapshot context blob
   is the same. The BBEG's plans sit in `description`/`summary` with
   NOTHING marking them unfired. A narratively competent model holding
   "Vane's plan is X" and asked "what happens next" completes the arc —
   that is what it is FOR. The spill is the default physics of the setup,
   not a model quirk.
2. **There is no data to gate on.** Even a disciplined prompt could not
   withhold the unrevealed, because "revealed vs unrevealed" is recorded
   nowhere: `playerKnown` has zero readers, Layer 2 (thread status) was
   never built, and no entity carries planted/hinted/fired state.
3. **Secrets never reach the graph at all.** The `secret` fields you used
   live in scene ELEMENTS (planner store) and prep-content (sidecar
   store) — GM-side stores with no linkage into generation context
   gating. The GM-facing prompts even instruct the model that "secrets
   and hidden truths are... safe to write plainly" — correct for prep,
   but there is no player-facing counterpart mode.

**The flip side — why the "gin-up" feels great and must be protected:**
the same ungated flatness is what makes propose-elements /
develop-this-place / narration fast and grounded. One-hop
name+type+relationship context is cheap, always available, and never
blocked on curation. Any knowledge-gating design has to be a MODE on the
context builders (player-facing vs GM-facing), not a tax on all of them.

## 4. Verdict: is the setup sensible?

**The spine is sound.** Layer 0's vocabulary is reasonable and battle-
tested; graph + review gate + file bridge + the intake pipeline (after
the 2026-08-31 upgrade) all demonstrably work; the derivation idea is
good even if unused. Nothing about the foundation needs replacing.

**The consistent failure is a pattern, not a list**: every feature that
would carry NARRATIVE STATE — Layer 2, the doom clock, playerKnown,
canonLocked, thread status, event time — was named, spec'd or stubbed,
and never given a consumer. The system has a memory for what is TRUE and
none for what has been REVEALED, PLANTED, or is PENDING. Your pacing
problem is that missing layer, precisely.

Secondary but real: the declared-vs-lived gap. New machinery should
either attach to the lived channels (types, tags, labels, importance) or
revive a dead field WITH its consumer in the same change — never another
writer-without-a-reader (the Phase-12 fields are the cautionary tale).

Hygiene debt worth folding into whatever comes next: the free-text status
editor vs its enum; the `"related"` out-of-vocabulary edge writer; two
divergent session counters (headless worlds can never go `[stale]`);
stale LLM-facing vocabulary strings in the module; no provenance link
from entity to source doc (which made the Kilmarn seed-drift silent —
two thread phrases in the graph never matched what you wrote, one thread
vanished, one appeared).

## 5. The Aureus collision — this BLOCKS the ingest as designed

The Aureus interview locked modeling defaults that the current model
cannot honor:

- **"truth in `secret`," "DM secrets in `secret` fields"** — there is NO
  `secret` field on entities. The closed allowlist silently DROPS the key
  on import. Ingesting the master list as written would silently discard
  the entire surface/truth split — the same silent-mutation failure class
  as the Kilmarn seed drift, at campaign scale.
- **"`playerKnown: false` for the Source / Sealed Depths"** — writable,
  and inert: the Source's full truth would still land verbatim in every
  generation context.
- **"threads as concept entities with clock"** — `concept` is one of the
  two types with NO status lifecycle, and no clock/threshold/cadence
  primitive exists anywhere ("Thread K is the campaign's clock" has no
  place to live).
- **"between-session mutations are this campaign's model"** means the
  tick engine must READ narrative state from the graph — which today
  cannot carry it.

So the pause was right: settle the ontology before seeding, or the seed
bakes in the gaps.

## 6. Directions (not a plan — for discussion)

1. **Build the missing layer as GM_Tools-side narrative state**, not a
   Foundry-module schema change: a per-entity sidecar store (the proven
   narration/prep-content pattern) carrying e.g. `revealState`
   (planted → hinted → revealed, GM-controlled), `truth` (the secret
   prose, out of `description`), and `clock` ({value, threshold,
   cadence}) for thread-like entities. Respects the closed entity schema,
   the module boundary, and the review-gate model; syncs nowhere.
2. **Knowledge-gate the player-facing context builders only**: a
   "table mode" where unrevealed entities contribute surface-only
   (name + public description) plus an explicit standing instruction —
   "these exist and are UNREVEALED: allude, foreshadow, never disclose."
   GM-facing prep keeps full access. This is the Chekhov's-gun control:
   the gun stays in context AS a gun on the mantel, not as the ending.
3. **Make revelation an explicit event**: session wrap (or a Run-side
   affordance) flips revealState and stamps when — giving the float-then-
   fire lifecycle, and finally giving `playerKnown`/session machinery a
   consumer (or retiring them in favor of the sidecar).
4. **Give threads a real shape** — either a convention on `concept`
   (declared scalar attributes + the sidecar clock) or a seventh Layer-0
   type; either way the tick engine and the Run UI read the same state.
5. **Fold in the hygiene debt** (status enum-or-free decision, `related`
   type, provenance-on-ingest, stale prompt vocabularies, dead-field
   cull-or-revive) as part of the same pass, so the declared and lived
   ontologies converge instead of drifting further.
6. **Then re-cut the Aureus master list** against whatever lands (the
   surface/truth split gets a real home before, not after, the seed).
