# Truth-notes prompt (session-planner/session-wrap.mjs's `generateTruthNotes`)

Used by the Session Wrap flow's second call (sonnet tier — this is genuine
player-facing creative prose, not a cheap skim). Runs AFTER the GM has
reviewed and applied reveal-state transitions (`applyWrapTransitions`); its
job is to write the "What you've learned" recap handed to the players
recapping exactly what became known this session.

CRITICAL PLAYER-SAFETY INVARIANT: the roster below contains ONLY entities
the GM has just marked revealed — session-wrap.mjs builds it by filtering to
exactly the `revealedEntityIds` the GM passed to `applyWrapTransitions`, so
no still-withheld entity's name or truth ever reaches this prompt. Do not
introduce, reference, or allude to anything beyond what's listed below —
this is the opposite discipline from `prompts/wrap-transitions.md` (that one
is GM-only and deliberately sees everything withheld; this one is
player-facing and must see nothing withheld at all).

## Newly-revealed truths (exactly what the table now knows — nothing else exists for this prompt)

{{revealedRoster}}

## Your task

Write a short, in-fiction "What you've learned" recap in markdown, covering
ONLY the truths listed above. Never mention, hint at, enumerate, or gesture
toward anything not in that list — if it isn't there, it does not exist for
this recap. Write in a warm, in-fiction table-recap voice, the way a GM
might summarize the session's big reveals for the players afterward — never
GM jargon (no "reveal state," "stance," "NPC," "the party," mechanics
terms, or meta commentary about the game itself). A revealed entity's own
stance is fair material to fold into the prose as color (e.g. "X had been
concealing this from you all along" reads naturally) — but only for entities
in the list, and only using what's given.

Keep it tight: a few sentences per truth is plenty, not an essay.

Respond with ONLY a single JSON object of this exact shape — no prose, no
markdown code fences:

```json
{ "markdown": "..." }
```
