# Phase 8 — Rubber-Duck Mode Design

**Why this document exists:** before building rubber-duck mode, two independent perspectives were gathered — a working-GM persona on concrete, opinionated requirements, then an interaction-design/prompt-engineering persona translating those into a decisive technical spec. This is the design record; `plans/phase-8-tasks.md` is the resulting build plan.

---

## The GM's requirements (gathered directly, already validated)

1. **The "ask" moment happens after a first pass, not before submission.** No clarifying-question gate before the writeup is even pasted — that adds friction to the moment of just getting an idea out. Submit the full messy writeup, get a first reaction.
2. **That first reaction is three cheap, one-sentence interpretive framings, not a full proposal** — e.g. "(a) political intrigue where the merchant houses are the real conflict, (b) frontier/exploration where the ruins are the point, (c) personal-stakes centered on the narrator." Pick one or blend ("closer to A but pull in some of C"), *then* the real structured extraction runs. Explicitly not three competing full proposals — "just three ghostwriters instead of one."
3. **A plain reject (no note) in rubber-duck mode should prompt a reason via quick-picks** ("wrong emphasis," "wrong scope," "missing something," "not feeling it yet") rather than silently marking rejected — only in rubber-duck mode; normal mode's silent reject-and-wait is unchanged. No mandatory essay.
4. **Standing personal setting, not a per-import toggle.** Flipped maybe twice a year, tied to *why* the GM is working (new campaign from a loose pitch = on; importing into an already-committed world = off for weeks).

---

## The technical spec (interaction-design persona's response)

### The framing-proposal step
New function `proposeFramingsFromWriteup(writeupText, opts) → {framings: [{id, sentence}, ×3]}`, living beside `proposeWfiFromWriteup` in `graph-import/writeup-import.mjs`, with its **own prompt file** (`prompts/writeup-framing.md`) — not a variant of the extraction prompt, so the model isn't tempted to half-extract while framing. Deliberately cheap: small `maxTokens`, zod-validated to exactly 3 items, retry-once on failure (matching existing convention). **Recommended addition**: a faster/cheaper model tier for this call specifically — a visibly-fast first reaction versus the ~51-59s real extraction pass is itself part of signaling "this is a glance, not a finished answer."

**Feed-forward**: reuses the *existing* regenerate-with-note mechanism, invoked one step earlier — no new prompt slot. The user's pick/blend composes into plain text fed through the same `note`/`{{retryNote}}` path `proposeWfiFromWriteup` already has.

**Pipeline shape**: with rubber-duck on, `wf_propose_from_writeup` becomes two-phase — phase A returns 3 framings (no batch created, nothing to review yet); phase B, triggered by the user's selection, runs the existing `importWriteup()` unchanged except for the composed note. With rubber-duck off, phase A is skipped entirely; today's single-shot behavior is untouched.

### Reject → quick-pick: decisive resolution
**Loops back to a new round of framings — does not jump straight to a new full proposal.** A quick-pick reason fed straight into a regenerate would produce a second finished artifact to react to, the same failure mode one level down. An *explicit* typed note (the user already knows what's wrong) stays on the existing fast path to `regenerateWriteupImport`, unchanged. **Bounded**: capped at one re-framing round — a third plain rejection requires an actual note rather than more quick-picks, to avoid an unbounded loop becoming its own anti-pattern.

### Settings persistence
Global, not per-world. New `mutation-engine/user-settings.mjs`, following `human-review.mjs`'s established flat-JSON-file convention (`GM_Tools/user-settings/settings.json`, env-overridable root, `review-state.mjs`'s existing `withLock`). **Read once, at submission**, and stamped onto the batch itself (`batch.scope.rubberDuck`) — every later action reads the batch's own stamped value, never the live global setting again, so a mid-review toggle flip can't retroactively change an in-flight batch. Matches the precedent `regenerateWriteupImport` already sets by reading `batch.scope.text` rather than re-deriving anything.

### Flagged additions (interaction-design persona's own judgment, not GM-requested)
- **Framing history on the batch** (`batch.scope.framingHistory`) — so a later regenerate/audit can see what direction was actually steered toward, not just the final note text.
- **A genuinely new UI screen** between "paste writeup" and Batch Review — three framing cards (radio-select) plus an optional freeform blend line. Real new frontend scope, not a footnote to the existing Review view.
- **Explicit-note rejects always stay on the fast path** — called out specifically because it would be easy to accidentally route *every* rubber-duck reject through the framing loop, which would be wrong; only a *plain* reject (no note) triggers it.
