---
name: gm-tools-agent
description: Collaborator rules for any Claude agent attached to the World Fabric MCP server (wf-mcp-server) to co-plan a GM_Tools campaign or one-shot. Load before calling any wf_* tool. Covers pulling fabric context first, the explicit-world-every-call rule (multi-world safety), which tools go through a review gate vs. write directly, and where prose intake goes.
---

# GM_Tools Agent Contract

You are attached to `wf-mcp-server` — the World Fabric MCP server. This is a
real, persisted campaign store, not a sandbox. These rules exist because a
silent mistake here (wrong world, an unreviewed write treated as canon) costs
Russell real session-prep time or corrupts real campaign data. Follow them
exactly, every call, not just when it seems to matter.

## 1. Always pull fabric context before suggesting anything

Before proposing a scene, an NPC, a consequence, or ANY content, ground
yourself in what's actually in the graph. Use `wf_get_context` (cheapest,
pre-budgeted) or `wf_get_adjacent`/`wf_get_entity` for a specific area. Do
not invent names, places, or facts that contradict or duplicate what the
graph already has. If you haven't called a read tool this turn for the thing
you're about to suggest, call one first.

## 2. `world` is explicit on every single call — never assume

Russell runs multiple worlds at once (e.g. an ongoing campaign + a separate
one-shot, each its own graph/planner/library state). There is no "current
world" — every `wf_*` tool call takes `world` explicitly, and this server
will not silently default one for you even if an env var happens to be set.

- Never carry a world forward from earlier in the conversation without
  re-confirming it's still the one meant for THIS call, especially after any
  gap or topic switch.
- If you're not certain which world the user means, call `wf_list_worlds`
  and ask — don't guess.
- Cross-world mistakes are the single most damaging class of error this
  contract exists to prevent: writing a one-shot's content into the
  campaign world (or vice versa) is not easily undone.
- The bestiary tools (`wf_list_bestiary`/`wf_get_bestiary_entry`/
  `wf_add_bestiary_entry`) are a deliberate exception — the bestiary is a
  library-wide shelf, not world-scoped. They take no `world` param at all;
  don't try to pass one.

## 3. World-changing content goes through a review gate — the human accepts

Anything that proposes new or changed WORLD CANON must go through a batch
and wait for an explicit human accept. Never tell the user something "is
now in the graph" until they've actually accepted it (in the app's own
review UI, or via `wf_accept` if they've asked you to accept on their
behalf explicitly — see rule 5).

Gated tools (create a batch, `status:'pending'` until accepted):
- `wf_propose_mutations`, `wf_regenerate` — event/time-skip consequences
- `wf_propose_from_writeup` + `wf_select_framing` — prose → graph proposal
- `wf_chronicle_run` — a Chronicle pass (advances the clock, proposes consequences)
- `wf_run_cycle`, `wf_resolve_pending` — time-skip / deferred-backlog resolution

After creating a batch, tell the user what you proposed and that it's
waiting for review — don't move on as if it already happened.

## 4. Planner working-state edits are direct — but stay conservative

Session Planner (scenes/plans/elements/tray) and Library hand-authoring
(`wf_add_bestiary_entry`/`wf_add_party_member`/`wf_add_item`/
`wf_add_stagecraft_asset`) write immediately, no gate — this is scratch-space
and deliberate hand-authorship, the same as a GM typing directly into the
app's own forms. Direct-write does NOT mean unconsidered:
- Don't create duplicate scenes/elements/plans for something that already
  exists — check with a read tool first (`wf_list_scenes`, `wf_get_scene`,
  `wf_list_plans`) before creating.
- Don't invent stat blocks or item text wholesale without it being clear to
  the user that's what you're doing — this still lands as real prep
  material immediately, with no review step to catch a fabrication later.
- `wf_tray_drop`/`wf_queue_intent`/`wf_set_fortune` are direct writes too,
  but they're additive/reversible (a tray roster row, a queued thread, a
  fortune-track stop) — safe to use readily as part of active co-planning.

## 5. Never edit accepted lore without an explicit human ask

Do not call `wf_apply_mutations` (or propose a mutation batch intended to
silently "fix" or "clean up" existing accepted graph content) unless the
user has explicitly asked you to change that specific thing. An entity
that's already in the graph and accepted is settled canon — treat it as a
constraint to build from, not something to casually rewrite because a new
suggestion would read better if it did. If you think something existing
should change, say so and ask, don't just do it.

Graph mutation write tools (`wf_apply_mutations`, and anything that reaches
`wf_sync_to_foundry`) only ever apply *accepted* mutations — this is not a
bypass path, and there is no other write path into accepted lore exposed to
you. Don't look for one.

## 6. Prose intake = `wf_propose_from_writeup`

If the user pastes or describes freeform text meant to become graph content
(a pitch, prep notes, a wiki export, a session recap) — use
`wf_propose_from_writeup`, not a hand-rolled sequence of
`wf_add_scene_element`/`wf_apply_mutations` calls. It runs the real
extraction pipeline (dedup against existing entities, proper WFI shape) and
produces a normal review batch. If rubber-duck mode is on
(`wf_get_rubber_duck_mode`), the first response is 3 framings — present them
to the user and call `wf_select_framing` with their pick (or a blend), don't
pick for them.

## Quick reference

| Situation | Tool |
|---|---|
| "What's in this world so far?" | `wf_get_context` / `wf_get_adjacent` / `wf_get_entity` |
| Prose → graph content | `wf_propose_from_writeup` → `wf_select_framing` |
| "Time passes, what happens?" | `wf_chronicle_run` (review-gated) |
| Draft a scene/plan/element for the next session | `wf_create_scene`/`wf_create_plan`/`wf_add_scene_element` (direct) |
| Add a monster/NPC/item/map by hand | `wf_add_bestiary_entry`/`wf_add_party_member`/`wf_add_item`/`wf_add_stagecraft_asset` (direct) |
| "Remember this for later" | `wf_queue_intent` (direct, manual sentinel) |
| Change something already-accepted | STOP — ask the user first |
