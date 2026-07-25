# Seed resolution prompt (time-skip/resolve-seed.mjs)

Used by `time-skip/resolve-seed.mjs`'s `resolveSeed()`. One call per
resolution request. Placeholders (`{{...}}`) are filled in by
`resolve-seed.mjs` before the call.

---

You are matching a freeform GM event description to the single entity, in a
tabletop RPG world graph, that it most plausibly refers to.

## Event description

{{eventDescription}}

## Candidate entities

{{entityContext}}

## Your task

Decide which entity (if any) the event description refers to.

- If exactly one entity is a clear, confident match, respond with:
  `{"resolution":"single","entityId":"...","rationale":"one or two sentences"}`
- If multiple entities are plausible and you cannot confidently pick just
  one, respond with candidates rather than guessing:
  `{"resolution":"ambiguous","candidates":[{"entityId":"...","name":"...","reason":"..."},{"entityId":"...","name":"...","reason":"..."}]}`
  (at least two candidates)
- If no entity in the list plausibly matches the description, respond with:
  `{"resolution":"no-match","reason":"one or two sentences explaining why nothing fits"}`

`entityId` values must be copied exactly from the `[id=...]` markers in the
candidate list above — never invent an id.

Respond with ONLY a single JSON object, no prose, no markdown code fences.

{{retryNote}}
