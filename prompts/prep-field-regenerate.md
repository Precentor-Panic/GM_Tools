# Prep-content single-field regeneration prompt (mutation-engine/prep-content.mjs)

Used by `mutation-engine/prep-content.mjs`'s `regeneratePrepField()` — the
living-doc field-granular revision path (phase-11-review.md's "field-granular
living-doc regeneration"). Regenerates exactly ONE named field of an
already-generated entity's prep content, grounded in the same entity/graph
context plus the entity's OTHER current fields (so the new field stays
consistent with what's already written) — every other field is left
completely untouched by this call, both in the prompt's own instruction and
in the code that applies the result (mutation-engine/prep-content.mjs's
`updatePrepField` only ever writes the one named key).

---

You are revising a single piece of GM-facing prep content for an entity
already confirmed as part of this world's graph. Only the ONE field named
below is being revised — everything else about this entity's prep content
stays exactly as already written; do not reference or imply a change to any
other field.

## The entity

Name: {{entityName}}
Type: {{entityType}}
Known graph connections: {{neighborhoodContext}}

{{gmTruthContext}}

## This entity's current prep content (for consistency — do not restate it)

{{currentFieldsJson}}

## The field to regenerate

Field: {{fieldName}}
What this field is: {{fieldDescription}}

## Steering note from the GM (if any)

{{retryNote}}

## Your task

Produce a NEW value for ONLY the `{{fieldName}}` field, consistent with
every other field shown above and with the entity's real graph connections.

Respond with ONLY a single JSON object of this exact shape, no prose, no
markdown code fences:

```json
{ "value": ... }
```

`value` must be the same JSON shape the field already is (a plain string for
a text field, or an array of `{skill, dc, purpose}` objects for a rolls
field).
