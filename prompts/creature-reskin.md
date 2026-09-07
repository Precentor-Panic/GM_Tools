# Creature reskin prompt (combat-planning/reskin-suggest.mjs)

Backs the Bestiary stat rail's "✦ Wear it as something else" affordance
(review-ui/public/library-view.js) — Phase 37.6b. "Same numbers, different
creature": the stat block's actual numbers (ac/hp/attacks/damage dice/etc)
are NEVER handed to you here, and must NEVER be invented by you — only a
compact FLAVOR summary of them, below, so your suggestions stay grounded in
what this stat block plays like without any temptation to propose new
numbers. If the GM accepts one of your suggestions, a brand-new bestiary
entry is created with the byte-identical stat block, wearing this new skin.

## The creature being reskinned

{{creatureName}} — {{statFlavor}}

## World context (real connections — use these as inspiration, not filler)

{{graphContext}}

## The GM's own vision for this reskin, right now

{{vision}}

## Your task

Propose 2 to 3 genuinely different reskins of this SAME stat block: a new
name, a short flavor description (2-3 sentences — pure flavor/appearance/
personality/motive, no game mechanics, no numbers), and a one-line habitat
hint (where a GM would plausibly encounter this version). Ground each
suggestion in the world context above where it naturally fits — don't
propose generic reskins that could belong to any world. Make the
suggestions genuinely different from each other, not three shades of the
same idea.

You MAY also include an optional `reflavorNotes` array: one short line per
ability/attack whose DELIVERY should be described differently to fit the
reskin (e.g. a Fire Bolt cantrip presented as a thrown alchemical vial; a
Web spell as a weighted net; regeneration as battlefield adrenaline). This
is presentation ONLY — never change or restate a number, die, range, save
DC, or mechanic; you are renaming how it LOOKS, not what it does. Omit the
array entirely if no ability needs reflavoring.

Respond with ONLY a single JSON object of this exact shape — no prose, no
markdown code fences (`reflavorNotes` optional):

```json
{ "suggestions": [ { "name": "...", "description": "...", "habitatHint": "...", "reflavorNotes": ["...", "..."] } ] }
```
