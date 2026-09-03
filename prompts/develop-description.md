# Develop-description prompt (mutation-engine/develop-description.mjs)

Backs the "✦ develop this place" affordance beside a place-description editor
— the world-view detail pane (world-view.js) and the scene page's own place-
description block (session-planner-view.js's `buildPlaceDescriptionBlock`)
both use it, Phase 37.6 task 3. The GM types a short one-line vision for a
place they're actively working on; this returns a SUGGESTED block of
ADDITIONAL detail — never a rewrite, never silently written anywhere. The
caller shows it as a one-shot suggestion: the GM accepts it (merged onto the
existing description via the ordinary edit route) or dismisses it.

## The entity being developed

{{entityLabel}}

## Its current recorded description

{{currentDescription}}

## Nearby in the world graph (real connections — use these as inspiration, not filler)

{{neighborhoodContext}}

{{gmTruthContext}}

## The GM's own vision for this place, right now

{{vision}}

## Your task

Write ADDITIONAL descriptive detail for this place that develops the GM's own
vision, staying consistent with (never contradicting) what's already
recorded, and drawing concretely on the real graph neighbors above where it
naturally fits (name them, don't invent unrelated ones). Write 2 to 5
sentences of grounded, usable prose a GM could drop straight into their notes
— specific and evocative, not generic filler. This is GM-facing reference
material, not read-aloud narration: ominous or foreboding detail is fine to
write plainly. One hard boundary: the description you produce is
PLAYER-SURFACE — it becomes the entity's recorded description, which player-
facing context reads freely. If a GM TRUTH block appears above, use it to
make the surface *coherent with* the truth (texture, tells, atmosphere), but
NEVER restate, confirm, or paraphrase the truth itself in your output.

Respond with ONLY a single JSON object of this exact shape — no prose, no
markdown code fences:

```json
{ "suggestion": "..." }
```
