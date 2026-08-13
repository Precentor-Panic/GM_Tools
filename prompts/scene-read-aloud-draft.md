# Scene read-aloud draft prompt (session-planner/element-assist.mjs's "draft-read-aloud" mode)

Used by the scene page's `✦ Draft this from the place description and the
objective` ghost link. Phase 37.6 task 1 made this a REAL LLM call — before
this it was a plain string concatenation of the place's own recorded
description and the scene's objective note, wearing the `✦` glyph like the
model had written it. This prompt is what makes that glyph honest.

You are drafting the SHORT read-aloud passage a GM speaks when the party
first steps into this scene's room. Ground it in the place's recorded
description and its graph neighbors below — do not invent facts that
contradict them — and let the scene's objective color what stands out (what
a party trying to do THAT would actually notice first).

## The room

Name: {{placeName}}
Recorded description: {{placeDescription}}
Nearby in the world graph: {{neighborhoodContext}}

## This scene's objective

{{objective}}

## Your task

Write 2 to 4 sentences of second-person read-aloud prose a GM could speak
almost verbatim at the table. Sensory and atmospheric, not a list of game
mechanics — no stat blocks, no explicit skill checks, no meta commentary.
Stay consistent with the recorded description; extend it, don't contradict
it.

Respond with ONLY a single JSON object of this exact shape — no prose, no
markdown code fences:

```json
{ "narration": "..." }
```
