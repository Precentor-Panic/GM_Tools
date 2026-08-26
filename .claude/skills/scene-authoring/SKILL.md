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

1. **Read Aloud** — `looks` = the prose (2–3 sentences, end on a sensory
   detail or open question, NEVER an instruction); `means` = delivery
   notes (pacing, what to fix in players' minds, what changes on a
   reprise).
2. **People** — one graph-linked element per named person present:
   - `looks`: ONE-LINE appearance (at-a-glance, always present),
   - `wants` / `means` / `gives` / `secret` per role,
   - `checks`: the actual DCs a GM rolls against them,
   - `statblockRef` or `bestiaryEntryId`: exact shelf entry name for
     stats. Every named person MUST have a shelf statblock (see §6).
3. **Interactive objects** (threads, levers, evidence) — `trigger` (how
   it's found), `checks` (skill+DC+purpose per approach), `secret` (what
   actually happens, including failure rules), `gives` (what the party
   walks away with).
4. **Backdrops ×3** — "Backdrop — Present / Bad-future bleed /
   Good-future bleed" (or this world's equivalent states): `trigger` =
   when that state applies, `looks` = the texture, **`gives` = a movement
   NUDGE pointing outward** (each state should quietly point somewhere
   else — the world moves the party, the GM never has to).
5. **Conditional read-aloud pairs** for irreversible events: e.g.
   "Read Aloud — X burns in place" / "Read Aloud — X redirected". The GM
   delivers one cold while the agent mutates the scene stack behind it.
6. **Residue** — one `gives` line: what changes no matter how the scene
   resolved (this is what feeds the chronicle/world state afterward).
   **Run placement (2026-08-26):** every element can carry an explicit
   `run: {column: main|side|off, role: read|dressing|beat|exits|block|
   card|gm|sketch, variant?}` — set it when you create the element
   (`wf_add_scene_element … run:`) rather than relying on name inference.
   Variants are free strings gated by `scene.activeVariants`
   (`wf_set_scene_active_variants`); tag backdrops and conditional
   read-alouds with one. `wf_seed_run_skeleton` pre-creates placeholders
   for a fresh scene; `wf_infer_run_layout` tags a legacy one.
7. **"→ Where this leads"** — nav references naming exact target scenes
   (and which backdrop/variant to use on arrival). Until scene
   hyperlinking exists, verbatim scene names are the contract. Encode
   each exit as `LABEL: text → 'Target scene'` (LABEL ∈ ONWARD (plot) /
   ONWARD (explore) / LINGER, or any uppercase word) — Run mode parses
   that into the Plot / Explore / Linger footer.

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
  the non-combat out (there is ALWAYS an out, with its DC), residue, and
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
