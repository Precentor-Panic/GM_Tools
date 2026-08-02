---
name: gm-tools-persona-review
description: How to run a DM/UX persona design-review round for GM_Tools without re-deriving the persona roster or the dispatch pattern from scratch. Load when a design record or draft UI concept needs review before being finalized or task-planned — the established process this project uses instead of the engineer unilaterally deciding UX questions.
---

# GM_Tools Persona Review Rounds

This project's design records (`plans/phase-N-review.md`) get pressure-tested by a standing panel of DM personas — reused across phases via `SendMessage`, not re-created each time, so they retain their prior stances and can react to how earlier feedback was (or wasn't) adopted. **You (the orchestrator) do not adjudicate persona feedback yourself** — compile a synthesis and hand it to the project owner (Russell) for a direct decision. Persona feedback has repeatedly been explicitly overridden by him with real reasoning (e.g. "committing a transit entity as a real graph node is not unnecessary ceremony") — this is a feature of the process, not something to average away.

## The standing DM persona roster (reuse via `SendMessage`, don't recreate)

| Agent ID | Persona |
|---|---|
| `a2e0777261fa4ee95` | Tactical / precision-combat DM — cares about balance rigor, wants actionable (not just descriptive) combat info |
| `ac535685bf4032b18` | Narrative-light-combat DM — cares about improvisation support, pushes back on combat-first framing |
| `a882d77a92746ee82` | Minimal-prep / Sly-Flourish-style DM — vigilant against any feature that adds authoring/action overhead, wants things to stay lightweight in the moment |
| `a37b4b5faae19b0b0` | West-Marches / sandbox DM — unpredictable party movement across a wide world, stress-tests navigation/scoping assumptions |

Agent IDs persist across the whole engagement (not per-session) — always try `SendMessage` to the ID above before spawning a fresh one; a fresh agent has no memory of prior rounds and will re-litigate settled ground.

For anything outside DM-experience territory (visual/information-density design specifically), spawn a **new** one-off `general-purpose` agent with a tightly-scoped expert persona (e.g. "a UX designer with real cockpit/dashboard/NOC-monitor design experience") rather than trying to stretch a DM persona to cover it — this project's Phase 25 round did this and it surfaced findings the DM personas structurally couldn't (e.g. checking actual CSS token reuse for color-alarm bugs).

## Dispatch pattern

Send each persona a **self-contained** message (they don't share context with you or each other) covering:
1. A one-paragraph recap of what's shipped since they last weighed in (they may be resuming from several phases back).
2. The exact file path to the draft design record — tell them to read it directly, don't paste a summary in place of the real doc.
3. 2-4 persona-specific questions, not a generic "what do you think" — ground the questions in what THAT persona specifically cares about (the roster table above), so their answer adds signal a different persona wouldn't have given.
4. An explicit ask to keep it focused — a few concrete reactions, not a full re-review. Reviews that ramble cost tokens on both sides without adding decision-relevant signal.

Dispatch all of them in parallel (multiple `SendMessage`/`Agent` calls in one turn) — they're independent, there's no reason to serialize.

## After the round

1. Wait for all responses (background task notifications) before compiling — don't present a partial synthesis unless explicitly asked for a progress check.
2. Compile a synthesis organized by **convergence** (multiple personas independently landing on the same point — this is the strongest signal, flag it clearly), **tensions** (personas disagreeing — present both sides, don't pick a winner), and **factual corrections** (a persona catching something wrong in the draft itself, e.g. a claim about the codebase that doesn't hold up — these aren't opinions, fold them in regardless of adjudication).
3. Present the synthesis to the user and stop — wait for their adjudication before editing the design record. Optionally offer your own read/recommendation, but frame it as input to their decision, not the decision.
