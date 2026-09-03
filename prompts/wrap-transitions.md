# Wrap-transitions prompt (session-planner/session-wrap.mjs's `suggestWrapTransitions`)

Used by the Session Wrap flow's cheap suggester call (haiku tier — this is a
"did the table brush up against X" skim, not a creative-generation pass).
The GM has just finished a session; this call proposes which withheld
narrative-state entities should move reveal state given what actually came
up in the session notes. Every suggestion is a SUGGESTION ONLY — nothing
here writes anything. The GM's own decisions, applied via a separate
explicit call (`applyWrapTransitions`), are the real review gate for this
flow; there is no batch/accept-reject step in between the way graph
mutations get one (see session-wrap.mjs's own header for why that's the
correct write discipline here, not a shortcut).

GM-SIDE PROMPT — PLAYER-SAFETY DOES NOT APPLY HERE. Unlike every table-facing
prompt in this codebase (narrative-gate.mjs's allusion/withheld-guidance
machinery), this call is read only by you, the GM assist, never surfaced to
players — so the roster below deliberately includes the full GM-only truth
text for each withheld entity. That is the correct, intended behavior for
THIS prompt; it would be a serious bug in `prompts/truth-notes.md` (the
player-facing recap this flow generates AFTER you approve transitions).

## The withheld roster (every entity not yet fully revealed)

{{candidateRoster}}

## This session's notes

{{sessionNotes}}

## Your task

Read the session notes and decide, for each roster entity, whether what
actually happened in the session justifies moving its reveal state forward.
Only ever suggest a FORWARD move, using these transitions:

- `unrevealed` → `hinted`: the table brushed against this — a clue pointed
  at it, someone asked a suggestive question, a related event happened in
  front of them — but they did not learn the truth itself.
- `unrevealed` → `hinted` → `revealed`: the table GENUINELY learned the
  truth — it was stated outright, confirmed, or the party pieced it
  together and acted on it as known fact. Suggest `revealed` only when the
  notes support the table actually knowing it now, not merely suspecting it.
- `hidden` → `unrevealed`: the table learned this THING EXISTS (a name was
  mentioned, a rumor confirmed there's something to find) without learning
  anything about it yet — the entity moves out of total hiddenness, not into
  hinted/revealed.

Hard rules:

- Suggest an entity **only** if it is in the roster above, referenced by its
  **exact `entityId`** as printed there — never invent an id, never guess
  one from a name.
- If the session notes don't touch an entity at all, **do not suggest it**
  — omission is the correct answer for "nothing changed here," not a
  same-state suggestion.
- Never suggest a state that isn't a real forward move for that entity's
  reveal-state ladder above.

Respond with ONLY a single JSON object of this exact shape — no prose, no
markdown code fences:

```json
{
  "suggestions": [
    { "entityId": "...", "suggestedState": "hinted", "rationale": "..." }
  ]
}
```
