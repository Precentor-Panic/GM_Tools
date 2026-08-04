# Scene-element functional-prep prompt (session-planner/element-assist.mjs)

Used by `session-planner/element-assist.mjs`'s `assistScenePrep()` — Phase 28
task 28.4's `✦` inline assist on the one scene page. This is the DELIBERATE
shift the design record calls for: away from verbose read-aloud prose, toward
CONCISE, functional prep for the interactable "stuff" in a room, grounded in
good one-page-dungeon / adventure-module craft (loottheroom's "Form and
Structure", the roleplaygoblin one-room-dungeon, Arcane Library's "how to
write a D&D adventure").

A scene ≈ a room: one place plus the things in it the party can engage with.
Each element is authored the way a well-made one-page dungeon keys a numbered
object — tell the GM what it looks like, what it MEANS to the party, what
happens when they touch it, what it gives them, and which check (if any) it
calls for. NOT flowery narration. The GM adds their own fluff at the table;
your job is the useful bones.

---

You are helping a GM prep the interactable elements of a single scene (a
"room" in adventure-module terms). This is GM-facing reference material only —
never shown to players verbatim — so hidden truths and secrets are expected
and safe to write plainly.

## The room (this scene's one place)

Name: {{placeName}}
Recorded description: {{placeDescription}}
Nearby in the world graph: {{neighborhoodContext}}

## Elements already keyed in this room

{{existingElements}}

## Your task

{{instruction}}

Write like a one-page dungeon key, not like read-aloud prose. Be concrete and
SHORT — a phrase or one tight sentence per field, never a paragraph.
De-prioritize appearance and atmosphere: `looks` is optional and only worth a
short phrase when it genuinely helps the GM picture the thing. What matters at
the table is **what happens when the party engages it** (`trigger`) and **what
that gives them** (`gives`) — information, loot, a lead, a consequence. Ground
specifics in the room and its graph neighbors above (name real places, people,
and connections) rather than writing generic filler that could sit in any
room. Do NOT re-propose an element already keyed in this room.

Each element's fields, all OPTIONAL except where your task says otherwise —
include a field ONLY when it earns its place; never pad with empty or generic
values:
- `trigger` — "what happens when": the party's action and its immediate
  effect ("reads the will → learns the heir was disinherited"; "pries the
  grate → a trap floods the crypt").
- `gives` — the payload: the concrete info, loot, or lead the party walks
  away with.
- `looks` — a short appearance phrase, only if it aids visualization.
- `means` — why it matters to the party / how it ties into the larger story.
- `function` — what the thing is FOR, mechanically or in the fiction.
- `checks` — an array of `{ "skill": "...", "dc": <number>, "purpose": "..." }`;
  each names a real ability/skill (Perception, Investigation, Insight, etc.)
  with a plausible numeric DC and a one-line purpose stating what success or
  failure reveals. Include only when a check genuinely gates something.
- `wants` / `secret` — for an NPC element: its goal, and any hidden truth.

Respond with ONLY a single JSON object of this exact shape — no prose, no
markdown code fences:

```json
{ "elements": [ { "name": "...", "fields": { ...only the fields that earn their place... } } ] }
```

{{retryNote}}
