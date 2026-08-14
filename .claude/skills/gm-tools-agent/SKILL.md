---
name: gm-tools-agent
description: Collaborator rules for any Claude agent attached to the World Fabric MCP server (wf-mcp-server) to co-plan a GM_Tools campaign or one-shot. Load before calling any wf_* tool. Covers pulling fabric context first, the explicit-world-every-call rule (multi-world safety), which tools go through a review gate vs. write directly, the full real tool roster, and the review-ui HTTP routes that have no MCP mirror.
---

# GM_Tools Agent Contract

You are attached to `wf-mcp-server` — the World Fabric MCP server. This is a
real, persisted campaign store, not a sandbox. These rules exist because a
silent mistake here (wrong world, an unreviewed write treated as canon) costs
Russell real session-prep time or corrupts real campaign data. Follow them
exactly, every call, not just when it seems to matter.

**If a tool named in this file errors as unknown**, your MCP session's server
process predates it (tool lists are loaded at session start). Don't improvise
around the gap with other write paths — say so, and ask for the MCP server /
session to be restarted. (This exact mismatch produced a real friction report
once; the fix is a restart, not a workaround.)

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
  don't try to pass one. Party, items, and stagecraft ARE world-scoped.

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
- `wf_pull_foundry_actors` — Foundry actors arrive as bestiary/party PROPOSALS

After creating a batch, tell the user what you proposed and that it's
waiting for review — don't move on as if it already happened.

Accepted is not applied: `wf_accept` only changes review state. The world
actually changes at `wf_sync_to_foundry` (the app's own "Apply to world"
banner drives the same route). After an accept pass, run the sync (or point
the user at the banner) — never leave accepted work silently unapplied.

Reject cascades: rejecting a proposed CREATE auto-rejects every still-pending
edge in the batch that references it (reported as `cascadeRejected`,
undoable via the app). Expect it; don't re-reject the edges by hand.

## 4. Planner working-state edits are direct — but stay conservative

Session Planner (plans/scenes/elements/tray) and Library hand-authoring
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
extraction pipeline (dedup against existing entities — including near-miss
name normalization and same-name/different-type resolution — proper WFI
shape) and produces a normal review batch. If rubber-duck mode is on
(`wf_get_rubber_duck_mode`), the first response is 3 framings — present them
to the user and call `wf_select_framing` with their pick (or a blend), don't
pick for them.

Two Friction-Wave-1 behaviors to know:
- **Truncation fail-fast (W2c):** a writeup too entity-dense for the token
  budget now fails immediately on the FIRST attempt with a
  `WriteupTruncatedError` carrying an approximate entity count and guidance.
  Split the writeup and resubmit — don't just retry the same text.
- **Framing carry-over (W2d):** on a resubmit of already-framed material
  (e.g. after a split), pass the optional `framing` argument
  (`{framings, selection, rubberDuck}` — the exact values the original
  phase-A response echoed back) to skip the rubber-duck framing round
  instead of re-asking the GM the same question.

## 7. The real tool roster (enumerated from the server's registrations)

Graph reads: `wf_list_worlds`, `wf_get_context`, `wf_get_entity`,
`wf_get_adjacent`, `wf_get_entities_by_type`, `wf_get_session_state`.

Graph proposals & review: `wf_propose_mutations`, `wf_propose_from_writeup`,
`wf_select_framing`, `wf_get_rubber_duck_mode`, `wf_set_rubber_duck_mode`,
`wf_review_batch`, `wf_accept`, `wf_reject`, `wf_regenerate`,
`wf_sync_to_foundry`, `wf_rollback_batch`, `wf_apply_mutations` (rule 5),
`wf_get_unreviewed_entities`.

Time-skip / deferred debt: `wf_run_cycle`, `wf_resolve_pending`.

Narration: `wf_narrate_batch`, `wf_narrate_entity`,
`wf_get_entity_narration`, `wf_get_entity_narration_history`.

Prep content ("develop this node"): `wf_propose_prep_framings`,
`wf_reframe_prep_framings`, `wf_generate_prep_content`,
`wf_get_prep_content`, `wf_accept_prep_content`, `wf_discard_prep_content`,
`wf_regenerate_prep_field`, `wf_mark_prep_content_stale`.

Session Planner: `wf_list_plans`, `wf_get_plan`, `wf_create_plan`,
`wf_rename_plan`, `wf_add_scene_to_plan`, `wf_reorder_plan`,
`wf_list_scenes`, `wf_get_scene`, `wf_create_scene`, `wf_update_scene`,
`wf_get_scene_elements`, `wf_add_scene_element`, `wf_update_scene_element`,
`wf_tray_drop`, `wf_tray_remove`, `wf_set_xp_budget`.

Library: `wf_list_bestiary`, `wf_get_bestiary_entry`,
`wf_add_bestiary_entry` (all three library-wide, no `world`),
`wf_list_party`, `wf_add_party_member`, `wf_list_items`, `wf_add_item`,
`wf_list_stagecraft`, `wf_add_stagecraft_asset`.

Chronicle: `wf_get_world_clock`, `wf_get_fortune`, `wf_set_fortune`,
`wf_list_chronicle_log`, `wf_list_pending_intents`, `wf_chronicle_run`
(gated), `wf_queue_intent`.

Foundry: `wf_pull_foundry_actors` (gated — arrives as proposals).

That's the whole surface. Anything not listed here is not an MCP tool —
don't call it, and don't invent one.

## 8. Where MCP ends: the review-ui HTTP API (no MCP mirror)

The app's server (`review-ui/server.mjs`, default `http://localhost:8787`)
carries a few surfaces with NO MCP tool. The same behavioral contract
applies verbatim: `world` explicit in every query/body (never `dataDir` —
the server ignores it by design), review gates for canon, direct-write
etiquette for planner state.

**Scene↔map & stagecraft src (Friction Wave 1, W3):**
- `POST /api/session-planner/stagecraft/:assetId/src` `{world, src}` — set a
  stagecraft asset's durable Foundry-resolvable file path (don't stash paths
  in `desc` anymore).
- `POST /api/session-planner/scenes/:sceneId` `{world, mapAssetId}` — link a
  scene to a stagecraft map asset (patch route; validates the asset exists
  and is kind `map`). `wf_update_scene` does NOT take `mapAssetId` — this
  link is HTTP-only for now.
- `POST /api/foundry/push-scene` `{world, sceneId, mapSrc?}` — `mapSrc` is
  now optional; it defaults from the linked asset's `src` (then its
  `foundryRef.imagePath`). Only pass `mapSrc` to deliberately override.

**Plutonium source layer (W4):**
- `GET /api/combat-planning/plutonium?query=&crMin=&crMax=&type=&source=&offset=&limit=`
  — read-only index of the locally-bundled 5etools bestiary data
  (`{installed:false}` when the module isn't there). Never a write.
- `POST /api/combat-planning/bestiary/add-from-plutonium` `{name, source}` —
  the ONE bridge onto the curated shelf (accepted entry, real stats, 409 on
  duplicate). Importing the actor into Foundry itself stays a manual
  Plutonium act at prep time — say so rather than implying it's done.

**Review extras (W1) — batch routes beyond the MCP verbs:**
- `POST /api/batches/:batchId/mutations/:mutationId/convert-to-existing`
  `{world, entityId}` — convert a pending create into an update of a chosen
  existing entity; re-points the batch's pending edges automatically.
- `POST /api/batches/:batchId/mutations/:mutationId/patch-data`
  `{world, data}` — the "yes, but" merge editor's primitive: hand-edited
  staged text, re-diffed before accept.
- `POST /api/batches/:batchId/revert-to-pending` `{world, mutationIds}` —
  undo for the reject cascade (rejected → pending only).
- `POST /api/batches/:batchId/sync` `{world}` — the apply step behind the
  "N accepted mutations not yet applied" banner (same op as
  `wf_sync_to_foundry`).

**Foundry connection:** `GET /api/foundry/connection?world=`,
`POST /api/foundry/sync-now` `{world}` — connection state + the pull-style
sync (proposals, review-gated), for when the user asks "is Foundry live?".

**Manual graph editing — deliberately NOT exposed as MCP tools:**
`/api/graph/nodes` + `/api/graph/edges` CRUD, reparent, and
`/api/manual-undo` are the GM's own direct-authoring surface (immediate
writes, no review gate, single-slot undo). The absence of MCP mirrors is a
design decision (the no-silent-auto-write invariant), not an oversight.
Only touch these routes when the user has explicitly asked you to make that
specific direct edit — rule 5 applies with full force.

## Quick reference

| Situation | Tool |
|---|---|
| "What's in this world so far?" | `wf_get_context` / `wf_get_adjacent` / `wf_get_entity` |
| Prose → graph content | `wf_propose_from_writeup` → `wf_select_framing` (resubmit: `framing` carry-over) |
| "Time passes, what happens?" | `wf_chronicle_run` (review-gated) |
| Accepted a batch — make it real | `wf_sync_to_foundry` (accept alone applies nothing) |
| Draft a scene/plan/element for the next session | `wf_create_scene`/`wf_create_plan`/`wf_add_scene_element` (direct) |
| Add a monster/NPC/item/map by hand | `wf_add_bestiary_entry`/`wf_add_party_member`/`wf_add_item`/`wf_add_stagecraft_asset` (direct) |
| Link a scene to its map / set a map file path | HTTP: scene patch `mapAssetId` + stagecraft `:id/src` (§8) |
| "What creatures could I use?" (unimported) | HTTP: `GET /api/combat-planning/plutonium` (§8) |
| "Remember this for later" | `wf_queue_intent` (direct, manual sentinel) |
| Change something already-accepted | STOP — ask the user first |
