# Context-free persona round — 2026-08-31

Four NEW one-off cold personas (deliberately NOT the standing warm roster —
Russell asked for context-free eyes) drove a keyless scratch sandbox (world
`brackenford`, isolated stores, offline LLM fallbacks, zero API spend):

- **A** — weeknight-prep DM, focused on the Run spread / new grouping
- **B** — first-time GM prepping a bare scene cold
- **C** — density/chaos power user, full app-surface sweep + robustness pokes
- **M** — "Claude co-GM" driving ONLY the wf_* MCP tool surface via a driver CLI

Per the phase-14 bar, every finding below marked CONFIRMED was verified by the
orchestrator against real code/data (file refs inline); PLAUSIBLE items need a
repro before becoming fix tasks. Screenshot evidence under the session
scratchpad (`persona-a/ b/ c/`).

**Known contamination (orchestrator error, discard):** personas B and M were
both pointed at the same scene, so B's "invisible co-editing / haunted app"
(B2) and M's "concurrent writer clobbered my write" (M4) are each other, not
the product. B's event-note "data loss" half is also reframed below (B1/C1).

## Convergences (strongest signal)

1. **KEEP: the Run spread + consolidation.** All three UI personas
   independently: "best at-the-table page I've seen a tool generate" (A2),
   "genuinely runnable" (B4), "genuinely good module-style spread" (C12).
   The new group card rendered exactly as intended (charm + outcomes read in
   play order). Do not regress the grouping, read-aloud typography, or the
   empty-placeholder hiding.
2. **KEEP: empty-scene guidance + seed skeleton** (B3, C11): worksheet-style
   prompts, idempotent seeding, honest ✦ tooltips, undo toasts.
3. **Add Event notes are write-only** (B1 + C1). CONFIRMED against the store:
   the note WAS saved — twice (two identical rows ~1s apart, a duplicate-save
   smell) — but NO surface ever reads notes back: the box collapses on
   reload, nothing lists/edits/deletes saved notes, and Wrap's
   "reads this scene's Add Event notes" showed none. From the chair this is
   indistinguishable from data loss of live-table notes. (Session-wrap is
   supposed to be the retro's marquee fix — this is its intake surface.)
4. **Vocabulary wall** (A6, B5, C density verdict): Dressing/Beat/Wrap/
   promote/graph/Batch Review/"pass time"/GIVES-MEANS-SECRET etc. land with
   zero in-place explanation; two personas explicitly "didn't dare click"
   graph-touching controls. The chip popover's "GROUP — one card with…"
   placeholder reads as an unfinished sentence (A6) though C decoded it.
5. **Prep vocabulary silently morphs in Run** (B7 + C5). CONFIRMED
   (renderer's card case relabels looks→EFFECT, means→ALTERNATE,
   secret→FAILURE; read case relabels means→GM). Same data, two vocabularies,
   no mapping shown anywhere in Prep.
6. **Things that aren't ready render in Run as if they were** (A3, A7):
   an empty stat block prints as a clean nameplate ("looks prepped, isn't");
   AI-drafted fields flow into Run indistinguishable from hand-written prep
   with no draft/unreviewed marking.

## Confirmed singles

7. **No UI variant switch** (A1). CONFIRMED — `scene.activeVariants` is
   writable only via route/MCP; nothing in the UI flips it. A's suggested
   shape: variant labels on the Run page as click-to-activate toggles.
   (NOTE for adjudication: for Kilmarn live play Russell chose
   "everything visible, no variant gating" — this is about the generic
   feature, not that choice.)
8. **⭑ promote reads as favorite, performs a data migration** (A4): no
   confirm, no undo toast, tooltip-only truth. Related: C11 confirms the
   underlying mechanics are robust (5 rapid toggles → exactly one node).
9. **`wf_promote_scene_element` gaps** (M2). CONFIRMED with nuance
   (session-planner/scene-elements.mjs:446): type inference person-vs-object
   keys ONLY off `element.stat`; `opts.type` exists in the lib but the MCP
   tool doesn't expose it; fields never carry over; edge always targets the
   scene's location. Cold agent produced "Old Journeyman Hale (object)" —
   which C then independently flagged from the UI side ("clearly a person").
10. **`wf_apply_mutations` blindly overwrites the queue file** (M3).
    CONFIRMED by the project's own comment (wf-mcp-server/lib/
    foundry-ops.mjs:14-20 calls it "a real gap") — violates the repo's
    stated concurrency convention; also no headless fallback despite
    wf_get_context advertising headless apply.
11. **MCP `fields` schema advertises open, store rejects strictly, error
    names only the bad key** (M1). CONFIRMED — though M's guessed closed set
    {gives,means,secret} is wrong; the real vocabulary is the ten
    SceneElementFields keys. Fix is description/schema enumeration.
12. **Offline writeup import is indistinguishable from "your text contained
    nothing"** (M5). CONFIRMED by construction (offline client returns an
    empty proposal, batch says "0 mutations", no offline marker) — and C8
    found the same no-op batches littering "READ SO FAR" from the UI side.
13. **Inference has no "Beat —" name rule** (C6, root cause corrected):
    kind:graph is the only path to beat; a local element named "Beat — X"
    infers dressing (C blamed non-ASCII; the rule simply doesn't exist).
14. **"est. 45 min" is hardcoded** (C9). CONFIRMED: `ids.length * 45`
    (app-shell.js:776,874,969).
15. **Dual-shell split personality** (C3): legacy GM Review shell at
    #graph/#plans with its own empty Plans page; unknown routes render
    blank; two Graph views; two import entry points.
16. **Scene creation buried inside plan creation** (C4); interrupted
    place-create leaves a floating place; new scene born titled as the place
    name shown twice.
17. **KEEP (M9): the review-gate description prefixes** ("READ." /
    "MUTATION -- direct write" / "THROUGH THE REVIEW GATE") — the cold agent
    never once misjudged gate-ness. Also keep wf_get_scene composition and
    seed-skeleton idempotence notes.

## Plausible (need repro before fix tasks)

- Plan-row ✕ click-swallowing / Delete plan button doing nothing visible
  (C7 — 200 automated clicks, zero deletions; confirm-copy itself is good).
- "+ New plan" double-click → two untitled plans (C8).
- Two-tab same-field last-writer-wins with no warning (C2 — real, but
  single-user tool by design; scope question for Russell).
- `wf_get_context` returning empty context for headless-imported worlds (M6).
- "Not connected" pill radiating undirected dread on first load (B10).
- One-line UI feedback gaps: whitespace-only element name silently dropped
  (C10), lane-send lands silently at bottom (A5 nitpick), Cards view weak
  sibling (A8), Loyalty tab reusing Spatial helper copy (C13), ✧/◌ glyphs
  undecodable (C), briefing "EYEBROW" jargon (C).

## Tensions for Russell to adjudicate (not decided by the orchestrator)

- **Headless graph-edge writes over MCP** (M7): the dead end is real for a
  keyless/no-Foundry session, but exposing manual writes over MCP was
  DELIBERATELY declined (no-silent-auto-write). Options: description-only
  guidance (route via propose/review), vs. exposing a reviewed path, vs.
  accepting the dead end.
- **Variant switch UI** (7): build it (A's toggle shape), or double down on
  the Kilmarn-style "everything visible" table philosophy?
- **Hover-reveal element toolbars** (C's density fix) vs. the standing
  anti-simplification guardrail (never make a capability harder to find).
- **Multi-user presence** (C2): out of scope for a single-user tool, or a
  cheap "someone else edited this scene" staleness hint?

## Sandbox

Left running for inspection: http://localhost:8791 (world `brackenford`,
scratch stores under /tmp/gm-tools-persona-env-oTWIFo, keyless). C's probe
artifacts (unicode scene, Wobbly Orrery node) intentionally left in place.
