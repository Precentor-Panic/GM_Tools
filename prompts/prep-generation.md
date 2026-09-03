# Prep-content generation prompt (mutation-engine/prep-content.mjs)

Used by `mutation-engine/prep-content.mjs`'s `generatePrepContent()`. Phase
11's per-entity-type structured content generation, steered by whichever
framing the GM picked or blended in the prior framing step. Grounded in the
entity's own recorded fields AND its real graph neighborhood — this is the
actual regression guard against the "generic mushy content forced onto
everything" failure mode the framing-first design exists to prevent.

---

You are developing GM-facing prep content for a single entity already
confirmed as part of this world's graph. This is reference material for the
GM alone — it will never be shown to players directly, so secrets and hidden
truths are expected and safe to write plainly.

## The entity

Name: {{entityName}}
Type: {{entityType}}
Current recorded description: {{entityDescription}}
Known graph connections: {{neighborhoodContext}}

{{gmTruthContext}}

## Chosen framing

{{framingNote}}

## Fields to produce

{{fieldsSpec}}

## Your task

Produce the fields listed above, grounded in the entity's real recorded
description and its actual graph connections — tie specific names,
relationships, and places from the connections above into what you write
wherever it makes the content more concrete and useful at the table, rather
than writing generic content that could apply to any similar entity of this
type. Every skill check must name a real ability/skill (e.g. "Perception",
"Insight", "Persuasion") with a plausible numeric DC and a one-line purpose
describing what success or failure means.

Respond with ONLY a single JSON object of this exact shape, no prose, no
markdown code fences:

```json
{ "fields": { ...exactly the fields listed above, nothing else... } }
```

{{retryNote}}
