# GM_Tools — Phase 8 Task Plan: Rubber-Duck Creative Mode

**Status:** ready to execute. **Prerequisite reading:** `CLAUDE.md` → `PLAN.md` → this file → `plans/phase-8-review.md` (the full design reasoning — read it before building anything, its specific choices are settled, not a starting point to redesign from) → `.claude/skills/gm-tools-conventions/SKILL.md`.

**What this is:** an opt-in personal setting that changes what happens right after a writeup is submitted to `wf_propose_from_writeup`. Instead of running the real extraction pass immediately, the GM first sees three cheap, one-sentence interpretive framings of their own messy writeup and picks one (or blends), *then* the real extraction runs with that steering folded in as a note. The point is to interrupt "sticky idea" anchoring — the GM's own first instinct isn't automatically what gets built — without adding friction to the moment of just getting an idea out.

**Everything this phase needs to route through already exists and is tested — confirmed by reading the actual code, not assumed.** This is a new *first step* wired in front of Phase 5's existing pipeline, not a new pipeline:
- `graph-import/writeup-import.mjs`'s `proposeWfiFromWriteup`/`previewWriteupImport`/`importWriteup`/`regenerateWriteupImport` — unchanged, called exactly as today once a framing is chosen or rubber-duck mode is off.
- `mutation-engine/llm-call.mjs`'s shared plumbing (`fillTemplate`, `parseJsonResponse`/`stripCodeFences`, `callModel`) — reuse for the new framing call, don't re-copy boilerplate.
- `mutation-engine/human-review.mjs` — the established convention for a small, flat-JSON, `withLock`-protected, env-overridable-directory store. `user-settings.mjs` follows this exactly.
- `wf-mcp-server/index.mjs`'s `wf_propose_from_writeup` tool and `review-ui/server.mjs`'s corresponding route — both get extended, not replaced.

---

## Task list

### 8.1 — Framing proposal call
**Files:** `graph-import/writeup-import.mjs` (extend), `prompts/writeup-framing.md` (new)

- New function `proposeFramingsFromWriteup(writeupText, opts) → {framings: [{id: "a"|"b"|"c", sentence: string}, ×3]}`. Own dedicated prompt file — not a variant of `prompts/writeup-import.md` — so the model produces short interpretive readings, not a half-extraction.
- Deliberately cheap by construction: small `maxTokens` (enough for 3 short sentences, nothing more), zod-validated to exactly 3 items with the exact `id` set `{"a","b","c"}`, retry-once-then-typed-error matching `texture.mjs`/`resolve-seed.mjs`'s established convention (new `FramingProposalError` or similar, your call on exact naming — match the existing typed-error naming pattern in this file).
- Use a faster/cheaper model tier for this call specifically (distinct from `DEFAULT_WRITEUP_IMPORT_MODEL`) — per the design doc, a visibly-fast first reaction is itself part of signaling "this is a glance, not the real answer." Pick a real, currently-valid model id (check the `claude-api` skill for current model ids/pricing rather than assuming one) and name it as its own exported constant (e.g. `DEFAULT_FRAMING_MODEL`), same pattern as `DEFAULT_WRITEUP_IMPORT_MODEL`.
- Same `MAX_WRITEUP_CHARS`/`WriteupTooLargeError` guard applies before this call too (the framing call still reads the full writeup) — reuse, don't duplicate.

**Acceptance criteria:** unit test with a mocked API call verifying a well-formed writeup produces exactly 3 framings with ids a/b/c; a test verifying malformed model output (wrong count, wrong ids, missing sentence) is retried once then surfaces a typed error. Manual/integration smoke test (`.smoke.mjs`, matching the project's pattern) with a real short writeup against the real API — confirm in your closing report that the framings are genuinely distinct readings, not three near-duplicates, and that the call is visibly fast relative to Phase 3's ~51-59s baseline.

---

### 8.2 — Feed-forward composition + reject-loop state machine
**Files:** `graph-import/writeup-import.mjs` (extend)

- `composeFramingNote(selection)` helper: turns a user's pick/blend into plain text fed through the **existing** `note`/`{{retryNote}}` slot — no new prompt slot. `selection` shape is your call, but must be able to express "primary framing X" and an optional freeform blend line (e.g. "also pull in elements of framing C: ..."). Output feeds straight into `proposeWfiFromWriteup(writeupText, { note: composedNote })` unchanged.
- The reject-loop state machine, per the design doc's decisive resolution:
  - A **plain reject** (no note) on a rubber-duck batch triggers a NEW round of `proposeFramingsFromWriteup`, informed by a quick-pick reason (reason categories are your call — the design doc suggests something like "wrong emphasis," "wrong scope," "missing something," "not feeling it yet" — thread the picked reason into the new framing call's context so the second round is actually informed, not a blind repeat).
  - **Bounded to one re-framing round**: track a round counter on the batch (`batch.scope.framingHistory.length` is a natural counter — reuse rather than inventing a second counter). A *second* plain rejection must require a freeform note instead of offering quick-picks again — surface this as a typed condition the caller (8.4's tool/route layer) can detect and message appropriately, not a silent no-op.
  - An **explicit-note reject** (the user typed something) always skips the framing loop entirely and goes straight to the existing `regenerateWriteupImport`, unchanged — this must be a clearly separate code path from the quick-pick path, not a variant of it, per the design doc's explicit callout that conflating these two would be a real bug.
- `batch.scope.framingHistory: [{framings, selection, note}]` — append an entry each time a framing round completes (initial round and any re-framing round), per the design doc's flagged audit-trail addition. Confirm `schema.mjs`'s `Batch.scope` shape accommodates this additively (matching the established additive-schema-change convention — bump documentation/version marker consistent with how Phase 5 added `SourceKind` if a version bump is actually warranted here; use your judgment on whether this needs a `SCHEMA_VERSION` bump or is purely additive-untyped `scope` metadata).

**Acceptance criteria:** unit tests covering: composing a note from a plain pick, composing a note from a pick+blend; a plain reject producing a new framing round with the rejection reason threaded in; a second plain reject on the same batch being refused (typed error/condition) rather than silently offering quick-picks again; an explicit-note reject going straight to `regenerateWriteupImport` and never touching the framing path; `framingHistory` accumulating one entry per round, confirmed by inspecting the actual stored batch.

---

### 8.3 — User settings module
**Files:** `mutation-engine/user-settings.mjs` (new)

- Follows `human-review.mjs`'s established convention exactly: flat JSON file, `GM_TOOLS_USER_SETTINGS_DIR` env-override (default path under the repo's existing data-directory convention — check how `human-review.mjs`/`pending-ledger.mjs` name their default roots and match it), `withLock`-protected writes (reuse `review-state.mjs`'s exported `withLock`, don't reimplement).
- Stored shape: `{"rubberDuckMode": {"enabled": false, "updatedAt": "..."}}`.
- `getUserSettings()` / `setRubberDuckMode(enabled)`. Keep the surface minimal — this is a single global toggle for this phase, not a general settings framework; don't speculatively build a key-value store abstraction beyond what's needed.
- **Read exactly once**, at writeup-submission time (in the 8.4 tool/route handler, not inside `writeup-import.mjs` itself — keep `writeup-import.mjs` free of any global-settings dependency, matching its existing pure-function style) — and immediately snapshotted onto `batch.scope.rubberDuck`. Every later action against that batch must read the batch's own snapshot, never call `getUserSettings()` again. Confirm this by checking that no code path added in 8.2/8.4 re-reads the live setting after batch creation.

**Acceptance criteria:** unit tests matching `human-review.mjs`'s own test style: default state when no file exists, set-then-get round-trip, concurrent-write safety via the shared lock (a real concurrent-write test, matching the pattern used elsewhere in this repo for `withLock`-protected stores), directory isolation via the env override (confirm tests don't pollute the repo's real default directory — this bit the project once already in Phase 4, don't repeat it).

---

### 8.4 — MCP tool + review-ui route wiring
**Files:** `wf-mcp-server/index.mjs` (extend), `wf-mcp-server/lib/mutation-ops.mjs` (extend if the shared-logic split from Phase 6 makes sense here — your call once in the code), `review-ui/server.mjs` (extend)

- `wf_propose_from_writeup` becomes two-phase when rubber-duck mode is on: phase A returns the 3 framings with no batch created yet (needs a way to carry the writeup text forward to phase B without persisting a batch prematurely — your call on mechanism, e.g. returning the writeup text/a short-lived token in the response for the caller to pass back, consistent with this being a stateless MCP tool call). Phase B (a new tool, e.g. `wf_select_framing`, or an extended parameter on the existing tool — your call) takes the user's selection and runs the real `importWriteup()` with the composed note, creating the batch as normal.
- When rubber-duck mode is off, phase A is skipped entirely and today's single-shot behavior is preserved exactly — verify this with a regression test reusing Phase 5's existing round-trip smoke test unchanged.
- Wire the reject-loop: `wf_reject` (and review-ui's corresponding route) on a rubber-duck batch needs to distinguish plain-reject-with-quick-pick from explicit-note-reject and route accordingly per 8.2's state machine, surfacing the "second plain reject needs a note" condition as a clear error/response the caller can act on (not a generic failure).
- review-ui: extend `server.mjs`'s routes to support the same two-phase flow and the settings toggle (a route to get/set rubber-duck mode, backing the new frontend control in 8.5).

**Acceptance criteria:** a real, API-backed MCP-protocol smoke test (matching Phase 5's `writeup-import-roundtrip.smoke.mjs` pattern) covering: rubber-duck OFF end-to-end (unchanged from Phase 5), rubber-duck ON full happy path (framings → select → real batch → accept → sync), rubber-duck ON plain-reject-loops-to-new-framings, rubber-duck ON second-plain-reject-requires-note, rubber-duck ON explicit-note-reject skips straight to regenerate. Route-level tests for review-ui's new endpoints matching `review-ui/test/routes.test.mjs`'s existing style.

---

### 8.5 — Review-UI framing-selection screen
**Files:** `review-ui/public/index.html`/`app.js`/`style.css` (extend)

Per the design doc's flagged new-scope callout — this is real new frontend surface, not a footnote:
- A new screen sitting between "paste writeup" and the existing Batch Review screen: three framing cards, radio-select, plus an optional freeform blend line below them, a submit action that triggers phase B.
- Quick-pick reject reasons need their own small UI (per 8.2/8.4) — likely a small inline prompt/button-group appearing on reject within a rubber-duck batch's review screen, distinct from the existing plain reject action in normal mode (which must stay exactly as-is, unchanged, silent).
- Settings-view toggle for rubber-duck mode (extends Phase 6's `#settings` section) — a simple on/off control backed by 8.4's settings route.
- Reuse existing visual conventions (card styling, button treatment) from Phase 6's build rather than inventing a new visual language — this is an extension of the existing UI, not a new one.

**Acceptance criteria:** manually verified in a real browser (same approach as Phase 6 — `run` skill + either `claude-in-chrome` or, if unavailable in this environment as it was for Phase 6, real headless Chromium via Playwright against a real running server, with actual screenshots inspected, not assumed). Confirm by looking: the framing-selection screen renders three distinct cards and a working blend line; selecting one and submitting proceeds to a real batch review; a plain reject inside a rubber-duck batch surfaces quick-picks and a normal-mode reject does not; the settings toggle actually flips stored state (confirm via the settings file/route, not just that the UI control visually changes).

---

## How to work

- **Actually look at what you build**, same standard as Phase 6 — this phase adds real visual surface, not just backend logic.
- Write backend tests in the project's existing style (`node --test`, no framework). Manual, screenshot-verified checks are the acceptance mechanism for the new frontend screen, per Phase 6's precedent.
- Commit after each completed task, clean incremental history.
- Budget a self-review remediation pass at the end, same as every phase since Phase 2 — for this phase, specifically re-check: (1) that a rubber-duck-off batch is byte-for-byte the same as Phase 5's existing behavior (no accidental new fields/paths leaking into the normal-mode flow), (2) that the one-round re-framing bound is actually enforced and not just documented, (3) that `batch.scope.rubberDuck` is read from the batch's own snapshot everywhere, never re-reading the live global setting after batch creation.

## Definition of done for Phase 8

- [ ] `proposeFramingsFromWriteup` + `prompts/writeup-framing.md` built and tested; deliberately cheap (small maxTokens, faster model tier) and confirmed genuinely fast in a real API smoke test.
- [ ] Reject-loop state machine correct: plain reject → new framing round (bounded to one); second plain reject → requires a note; explicit-note reject → straight to existing regenerate, never touching the framing path.
- [ ] `mutation-engine/user-settings.mjs` built following `human-review.mjs`'s exact convention; setting is read once at submission and snapshotted onto the batch, never re-read live afterward.
- [ ] Rubber-duck-off behavior is unchanged from Phase 5 — verified by regression test, not assumed.
- [ ] `wf_propose_from_writeup`'s two-phase flow and the reject-routing wired into both the MCP server and review-ui.
- [ ] New framing-selection screen built and visually verified (real screenshots looked at) in review-ui, plus a working Settings toggle.
- [ ] Full test suite (existing `npm test` suites) still passes; new code has its own tests.
- [ ] Self-review remediation pass run and reported, checking specifically the three items called out above.
