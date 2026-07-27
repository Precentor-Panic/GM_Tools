# Scan-for-mentioned-entities prompt (graph-import/scan-mentions.mjs)

Used by `graph-import/scan-mentions.mjs`'s `proposeMentionedEntities()`.
Own dedicated prompt — not a variant of `prompts/writeup-import.md`. This
call's job is narrower than a full writeup extraction: find named
entities/characters/places/things *mentioned* in a block of text (most
commonly Phase 11 generated prep content — a description, a secret, a hook),
where the text is written FROM THE PERSPECTIVE OF one already-existing graph
entity. Do not propose edges here — that's computed afterward in code, once
each mention has been matched against (or found absent from) the real graph.

---

You are scanning a piece of tabletop RPG campaign text for mentions of
OTHER named people, places, factions, objects, events, or concepts that
could plausibly become real, separate entries in the campaign's world graph.

## Context: whose content this is

This text is about **{{sourceEntityName}}** ({{sourceEntityType}}).

## The text to scan

{{scanText}}

## Your task

List every distinct named entity mentioned in the text OTHER than
{{sourceEntityName}} itself — a person, place, faction, object, event, or
concept a GM might want as its own real graph entry. Skip generic,
un-nameable references ("a guard," "some townsfolk," "the weather") — only
list things with an actual name or a specific-enough identity that a GM
could meaningfully create an entity for it (e.g. "the Ashfall Consortium,"
"Old Kellan the quartermaster," "the Sunken Bell tavern").

For each one, give:
- `name`: the name as it should appear in the graph (title case, no articles)
- `type`: your best guess — exactly one of `person`, `place`, `faction`,
  `object`, `event`, `concept`
- `description`: one short sentence, drawn ONLY from what the text actually
  says about it — do not invent details beyond what's written

If nothing in the text qualifies, return an empty `mentions` array — do not
force a mention that isn't really there.

Respond with ONLY a single JSON object of this exact shape, no prose, no
markdown code fences:

```json
{
  "mentions": [
    { "name": "...", "type": "person", "description": "..." }
  ]
}
```

{{retryNote}}
