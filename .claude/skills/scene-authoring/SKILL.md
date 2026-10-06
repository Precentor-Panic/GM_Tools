---
name: scene-authoring
description: The scene/plan/prep authoring formula for GM_Tools worlds — refined during the Kilmarn one-shot live exercise. Load when building scenes, plans, party, bestiary, or art for ANY world (new campaign bootstrap included). Covers plan structure, the scene element stack, three-state backdrops, burn/consequence read-aloud pairs, baked combat, calibration, and the metadata-first art pipeline.
---

# Scene Authoring — the GM_Tools formula

Conventions proven at the table-prep level during the Kilmarn one-shot
(2026-08). World-agnostic: apply to any world. All writes below are
planner/library direct writes per the gm-tools-agent contract (world
explicit on every call; canon still goes through review).

## 1. Plans

- **One-shots: plan by LOCATION, not by session order.** One plan per
  major location holding its scenes in natural encounter order. Players
  who go off-script just open a different plan — no railroad to repair.
- Always add an **"Anywhere — Transits & Floaters"** plan for portable
  scenes, and a **"Combat Variants (pre-mutated)"** plan for ready-made
  escalations (see §5).

## 2. Scene basics

- **Name: a place-and-moment label, never an outcome.** The scene name
  is pushed to Foundry verbatim and sits in the players' navigation
  bar. "Fight Night", "The Kit Table", "Into the Tunnels". If there is
  a dash, the part after it is a VARIANT label only ("— COMBAT: the
  crowd scramble", "— session end (splash)", "(any night)"). Nothing
  after the dash may say what happens in the scene — "— Vashan dies
  and the body is taken" leaked a death before the scene was run
  (2026-09-08). Put what the scene is for in `objectiveNote`, which
  players never see.
- **Purpose (objectiveNote):** 1–3 plain human sentences — what the scene
  is FOR, what it must never force, and any trigger conditions. Not a
  content dump; the elements carry content.
- **Map:** link a stagecraft asset via `mapAssetId` (never a note in
  text). The asset's desc names the tone-state variants (see §7).
- **Location:** a real graph entity. For portable scenes, keep a small
  set of deliberately UNLINKED generic places ("A City Street", "A
  Narrow Back Alley"...) — tagged generic/floating, no containment edges
  so the spatial tree stays clean — and give the scene a "Point it
  anywhere" element explaining how to slot it.

## 3. The element stack (in this order)

Revised 2026-10-05 from a GM's own review of a built session: the old order
opened with two near-duplicate elements (an opener and a separate "What's
happening"), buried the exits at the bottom, and spent a whole side card
re-explaining a house mechanic the GM already knows. This order is what a GM
actually reads, top to bottom, while running.

1. **Read Aloud** (`run: {column:"main", role:"read"}`) — paint the room.
   `looks` = the prose the GM says out loud: what is here, and what is already
   in motion. 2-4 sentences, ending on a detail or an open question, never on
   an instruction. This ABSORBS the old separate "What's happening" element —
   what is in motion is part of the picture, not a second card. `means` =
   delivery notes, one or two lines.
2. **The room** (`role:"dressing"`) — what is around the edges, and
   `secret` = what the GM should be hinting at or alluding to here. The secret
   belongs in this slot precisely BECAUSE it is never read aloud: it is the
   cue, read before play, for what to seed. `looks` = texture the GM can
   sprinkle. Keep both short.
3. **Plot / Linger** (`role:"exits"`) — where this goes, before any of it is
   played. Two labelled lines: `PLOT:` the way the session continues, and
   `LINGER:` what is here if they stay. Name target scenes verbatim.
4. **Characters** (`role:"person"`, one per named NPC, MAIN column) — the GM
   has to play these people, so everything needed is in the one block:
   - `looks`: exactly four lines —
     `<race/ancestry>, <build/age>, <one visual tell>` /
     `Mannerism: <one physical habit>` /
     `Voice: <one line of how they talk>` /
     `Opens with: "<the first thing out of their mouth>"` — the opening line
     only when they approach or address the party; omit it for someone the
     party has to go and talk to.
   - `wants`: one sentence.
   - `means`: how they play, two or three sentences at most.
   - `gives`: what the party can walk away with.
   - `secret`: GM-only.
   - **Levers and landmines go HERE**, in this block, as two short lines
     inside `means` or `gives` — never a separate reference card, and never
     with the mechanic re-explained. The GM knows how levers work. Lead with
     the NPC's **chief care-about** for this week (see the levers-and-landmines
     house doc): the levers speak to it, the landmines expose it.
   - `checks`: the actual DCs, as skill + DC + what it buys.
   - `bestiaryEntryId`: the shelf row. Run renders its PHB-style block inline,
     including ability scores and skills — so never retype stats into prose.
     If a row has no ability scores, refresh it from Plutonium rather than
     writing numbers by hand.
5. **Things in play** (`role:"object"`) — ONLY when there is a real object
   decision (a thing to take, break, return or hand over). `trigger` = how it
   comes up, `checks`, `gives`, `secret`. If an object has no decision
   attached, it is a line of dressing instead.
6. **GM notes** (`role:"gm"`, SIDE column) — one block, plain prose. What the
   scene is doing, what it must not force, how long it should take, and any
   house rule or piece of world machinery this scene is introducing. This is
   the slot for explaining the mechanism, in plain words.

Combat scenes keep their baked **ENEMIES** block (§5). `beat` stays for a
downtime scene whose content genuinely IS a list of per-character beats.

### Writing rules (same revision)

- **Plain, not clever.** The purpose note and every GM-facing field are read
  once, fast, by a tired person. "The only threat in the scene is chalk" is an
  epigram that cost its GM a re-read and told them nothing. Write "Nobody is
  in danger here. The pressure is that the House marks their cart."
- **Say what a scene is FOR in one or two sentences**, then stop. If a scene
  is a negotiation that introduces a rule and sets up a rest, the purpose note
  says exactly that. Resist adding a thesis.
- **One number, or none.** Never build a ladder of figures (a price that moves
  60 → 55 → 40) for the GM to track; it reads as a movie prop and does not
  survive the table. Quote one figure, in a unit the players can picture.
- **Pay in things, not coin.** Reward that inflates the party's purse buys
  nothing and costs the economy. Prefer payment in what the setting makes
  scarce and useful — a permit, a supply, access, standing. Introduce such a
  currency ONCE, plainly, through an NPC who has a reason to explain it.
- **Every field one to three sentences.** If a field wants more, it is two
  fields, or it belongs in GM notes.
- **Never invent a mechanic mid-prep.** A rule the GM has not ruled on is a
  question to ask, not content to write.

## 4. Filler & hook scenes

- **Fillers are recolorable**: one "Recolor by direction" element with all
  three state textures pre-written (crowd scene, shop scene, argument,
  petty crime). Same skeleton, three moods — mutate, don't improvise
  from nothing.
- **Hooks reward attention, never require it**: a hook scene shows one
  small wrong thing (the villain touching a banner; the red herring
  doing something explicable). `secret` holds the truth + the check that
  reads it.

## 5. Combat

- **Enemies are BAKED INTO the scene** — an "ENEMIES (baked)" element:
  exact shelf statblock names, counts, per-creature XP, and the
  adjusted-XP verdict against the ACTUAL party (size × level). No
  encounter-attach mechanisms.
- **Escalations are separate pre-mutated scenes** ("Combat — <event>
  aftermath"), not edits waiting to happen: read-aloud, baked enemies,
  the non-combat out (there is ALWAYS an out, with its DC), a "What's happening" line, and
  nav references. Park them in the Combat Variants plan.
- Reskins: name entries "<Flavor Name> (<chassis>)" with the chassis
  source + "import via Plutonium" in the note, plus behavior rules
  (when they appear, what guides them off, what the tell is).

## 6. Party, NPCs, calibration

- Party roster rows carry class/level/AC/HP; the full sheets live in the
  campaign repo's notes. When party level changes, re-verify every
  class feature actually exists at that level.
- Every named NPC gets a shelf statblock — chassis + the 3–5 skill mods
  a GM will actually roll (Insight, Persuasion, tools). Noncombatants
  get their RULES in the note (what they grant, their save DCs).
- **No "calibrate to party" left standing at prep-complete**: every DC
  in every element and note is a number. Boss math is written against
  the real party size × level, including the "what makes this
  survivable" line.

## 7. Maps & splash — the metadata-first art pipeline

1. **Cull by metadata/filename** against scene needs (variant names
   encode tone: Day/Night/Fog/Abandoned map cleanly to town-states).
2. **Vision-verify the top candidates only** — actually look before
   assigning; filenames lie (a "cliff walk" may be a shrine gorge, an
   "inn" may be exactly the inn your gazetteer already named).
3. **Store every description you generate** — campaign repo
   `notes/art-descriptions.json`: file, verdict, description, tags.
   Next pass sorts on stored descriptions before spending vision again.
4. Asset conventions: desc = VERIFIED description + tone-state variant
   guidance (desc is immutable — write it right at creation); src always
   set; scenes linked via mapAssetId; splash assets (kind=splash) for
   the 2–3 money moments with "show at X beat" in the desc.

## 8. Consequence delivery (live play model)

- The mutation engine handles time-skips; LIVE consequence riffing is
  the agent interpreting a burn/act against the fabric and proposing
  mutations while the GM delivers the pre-written conditional
  read-aloud. Pre-set the three-state backdrops so most "mutation" at
  the table is switching state + one or two content edits — fast, and
  it keeps the table on rails the world owns rather than the GM.
