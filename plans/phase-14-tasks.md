# GM_Tools — Phase 14 Task Plan: QA Pass Remediation

**Status:** ready to execute. **Prerequisite reading:** `CLAUDE.md` → `PLAN.md` → this file → `.claude/skills/gm-tools-conventions/SKILL.md`.

**What this is:** nine real, independently-confirmed bugs and gaps found by two DM-persona QA passes actually driving the tool in a browser against real (scratch, isolated) worlds — not suspicions, each one was verified against actual data files, code, or measured behavior before being reported. No new design round precedes this; each finding below already states expected-vs-actual precisely enough to fix directly. Ordered by severity, not by task number convention — fix 14.1 and 14.2 first, they're the two that undercut the tool's basic trustworthiness.

---

## Task list

### 14.1 — CRITICAL: rollback can silently report false success
**Files:** `mutation-engine/rollback.mjs`

**Confirmed root cause, not just a symptom description**: `rollbackBatch()` iterates `batch.mutations` in their original (chronological) order, pushing one `upsert_entity`/`upsert_edge` restore mutation per accepted entry, each carrying that entry's own captured `preState`. These restores are then applied as a sequence. `graph-import/headless-apply.mjs`'s `mergedWfiRecord` does a **shallow merge onto whatever the current state is at apply time** (`{...current, ...data}`), not a full replace. So when two mutations in one batch touch the *same field* (which the Phase 13 manual-edit auto-batch produces by design — an edit, then its own later undo, both on the same field), applying restores in **original chronological order** means the LATER mutation's preState (which represents "the state right before that later edit," i.e. LESS historical) gets applied last and wins — overwriting the earlier mutation's preState (the actually-more-original state). Net effect: only the last mutation in the chain is genuinely reverted, while every mutation in the batch gets marked `'rolled-back'` regardless, falsely reporting full success.

**The fix**: process `batch.mutations` in **reverse** order when building `restoreMutations` — so the earliest mutation's preState (the truest "original" state) is applied last and wins, correctly reverting the whole chain regardless of how many mutations in the batch touch the same field. This is a small, surgical, well-understood change (reverse the iteration order), not a rearchitecture — do not over-build this into something bigger.

**Acceptance criteria**: a real regression test reproducing the exact reported scenario — a batch with two accepted mutations touching the same field on the same entity (e.g. simulate the manual-edit-then-undo case, or just construct it directly) — confirming that after rollback, the live graph state matches the state *before the first* mutation, not just before the last one. Also confirm the existing single-mutation-per-entity rollback tests still pass unchanged (this fix must not change behavior for the common case, only the previously-broken multi-mutation-same-field case).

---

### 14.2 — CRITICAL: a brand-new world is a dead end
**Files:** `review-ui/server.mjs`, `review-ui/public/index.html`/`app.js`, likely `graph-import/headless-apply.mjs` (already has `bootstrapSnapshot`, confirmed unused by any production path)

**Confirmed root cause**: `/api/worlds` only lists worlds that already have a `world-fabric-snapshot.json` on disk. There is no UI affordance anywhere to create/register a new world. `bootstrapSnapshot()` (already built, already tested) is never called from any production code path — only from test fixtures. A GM with a genuinely new campaign and no prior Foundry world hits a hard wall on New Import with no recovery path in the UI at all.

**The fix**: add a real "Create New World" affordance — most naturally in Settings (matching the existing world-select dropdown's location) or as an option directly in the world-select control itself (e.g. an "+ New world…" entry). Prompts for a world id/name, calls `bootstrapSnapshot()` for it, and makes the new world immediately selectable and usable for New Import. This is genuinely new, small UI surface — keep it minimal (a name field and a create button is enough, don't over-build).

**Acceptance criteria**: a route test proving a new world can be created via the API and immediately appears in `/api/worlds`; real visual verification (screenshot) of creating a new world through the UI and successfully completing a full New Import → review → accept → sync cycle against it, starting from genuinely nothing on disk.

---

### 14.3 — Deferred-debt neighbor entries can silently vanish
**Files:** `time-skip/resolve-pending.mjs`, `mutation-engine/pending-ledger.mjs`

**Confirmed root cause**: `resolvePending`'s fan-out cap folds neighboring entities' pending backlog into the LLM call's context, but every mutation in the resulting batch — AND every `resolvedPendingEntries` record for every folded-in entity, including ones the LLM produced zero mutations for — shares one `regionId` (`"region-resolve-pending"`). `applyLedgerOutcome` marks a ledger record resolved whenever *any* mutation sharing its `regionId` gets accepted, regardless of whether that specific entity actually got a mutation. Confirmed: a neighbor's ledger backlog went from 1 entry to zero with no corresponding mutation ever shown in the batch for review or individual rejection.

**The fix**: don't let a folded-in neighbor's ledger entries get cleared unless a mutation actually targeting that specific entity was accepted. This likely means tracking which entity ids genuinely received a mutation in the resolve-pending batch (not just which were in context) and only calling `applyLedgerOutcome`/marking resolved for those — read `resolvePending`'s actual mutation-construction logic carefully before deciding the exact mechanism, since the fix needs to distinguish "this entity's backlog was actually addressed" from "this entity was merely mentioned as context."

**Acceptance criteria**: a test reproducing the exact scenario — a resolve-pending call where the fan-out includes a neighbor entity that ends up with zero mutations in the resulting batch — confirming that neighbor's pending-ledger entries survive accept, unchanged, while entities that genuinely got mutations have their entries correctly resolved.

---

### 14.4 — Developing/accepting a node's content doesn't clear its unreviewed flag
**Files:** `wf-mcp-server/lib/prep-content-ops.mjs`

**Confirmed root cause** (by grep): every other write path in this project (`mutation-ops.mjs`'s `acceptMutationIds`, `manual-edit-ops.mjs`'s six write functions) calls `markHumanReviewed`/`recordUnreviewedAccept` as appropriate. `prep-content-ops.mjs` never does, at all. Real, deliberate curation work (developing a node's content and accepting it) leaves that entity indistinguishable from one nobody has ever opened.

**The fix**: wire `markHumanReviewed` into the accept path for prep content (`acceptPrepContentOp` or equivalent — check the exact function name), matching the existing convention exactly. This is a genuine "the GM looked at and engaged with this entity" action, not a batch-accept-all — it should count as reviewed, the same distinction Phase 4 already established for scoped accepts vs. whole-batch accepts elsewhere.

**Acceptance criteria**: a test confirming an entity flagged as unreviewed has that flag cleared after its prep content is generated and accepted, matching the existing test pattern in `test/unreviewed-accumulation.test.mjs` or wherever the equivalent coverage lives for other write paths.

---

### 14.5 — Node-edit popover can render off-screen with no way to reach Save
**Files:** `review-ui/public/graph-view.js`

**Confirmed root cause**: for a node positioned in the lower part of the canvas, the edit popover's position calculation doesn't account for available viewport/document space below the click point — confirmed via bounding-box measurement showing the popover's bottom edge well below the document's own scrollable height, with the Save button unreachable.

**The fix**: clamp the popover's position so it stays within the visible/scrollable area — e.g. if there isn't enough room below the anchor point, position it above instead (flip), or clamp its top offset so its bottom edge never exceeds the container/viewport bounds. Reuse whatever positioning helper already exists (`positionPopoverAt`) rather than writing new placement math from scratch — extend it to be boundary-aware.

**Acceptance criteria**: real visual verification (screenshot + bounding-box check, matching how this bug was originally found) that editing a node near the bottom of a populated graph produces a popover that's fully visible and reachable, not just theoretically "in the DOM."

---

### 14.6 — Long-Unreviewed list shows raw ids instead of names
**Files:** `review-ui/server.mjs` (the `/api/unreviewed-entities` route), `review-ui/public/app.js`

**Confirmed by both QA personas independently** — a strong signal this is a real, significant gap, not a nitpick. The Deferred Debt tab already shows real entity names for the same kind of "needs attention" list; this one doesn't.

**The fix**: have `/api/unreviewed-entities` look up and include each flagged entity's real name (from the live snapshot) alongside its id, and update the frontend to display the name (with the id as a secondary/tooltip detail if useful, not the primary label).

**Acceptance criteria**: a route test confirming the response includes a `name` field per entity; visual confirmation the Queue's Long-Unreviewed list now shows real names.

---

### 14.7 — "Narrate This" isn't reachable from the standalone entity page
**Files:** `review-ui/public/app.js` (entity-detail view), possibly `mutation-engine/narrate.mjs`/`wf-mcp-server/lib/mutation-ops.mjs`

**Real design nuance, not just a UI wiring gap — read before building**: `narrateEntity(batch, mutationId, ctx, opts)` is fundamentally scoped to a specific accepted mutation within a specific batch (it narrates "what changed," using that mutation's diff/rationale) — it cannot be pointed at an entity in the abstract with no batch context. From the standalone entity page there may be no open/recent batch touching that entity at all. Two reasonable paths, your call which fits better once you're in the code: (a) look up the most recent batch that had an accepted mutation for this entity, if one exists, and narrate that — reuses existing infrastructure, but only works when such a batch exists, and should say so clearly (not silently do nothing) when none does; (b) treat this as a genuinely different, simpler kind of narration — "describe this entity's current state" rather than "narrate what just changed" — which would need its own prompt/call shape, not a reuse of `narrateEntity`. Prefer (a) if it's a clean fit; only build (b) if (a) turns out to feel wrong in practice (e.g. narrating a months-old accepted change reads strangely as "here's what just happened"). Whichever you pick, do not silently fail with no feedback when there's nothing narratable — that's worse than the current total absence of the button.

**Acceptance criteria**: a real test proving the chosen path works when a narratable batch/mutation exists for the entity; a real test proving a clear, non-silent message when it doesn't; visual verification of both cases.

---

### 14.8 — Scan-for-mentioned-entities: no cancellation, naive retry creates a duplicate batch
**Files:** `review-ui/public/app.js`, `review-ui/server.mjs`

**Confirmed, deliberately reproduced** (not a one-off automation artifact): navigating away while a scan is in flight doesn't cancel it server-side — it silently completes and creates a batch the user never sees appear. A natural retry (the user's reasonable reaction to "nothing seemed to happen") creates a second, fully redundant batch, wasting an LLM call.

**The fix, pick whichever is more robust once you're in the code — ideally both**: (a) client-side, abort the in-flight request (`AbortController`) if the user navigates away before it resolves; (b) server-side, a lightweight guard against firing a second genuinely-identical scan (same source entity, same text) while one is still in flight or was very recently completed — return the existing/in-progress result instead of starting a new one. Keep this proportionate to the actual risk (an occasional wasted LLM call, not data corruption) — don't over-engineer a general request-deduplication framework for what's specifically this one action.

**Acceptance criteria**: a test confirming a rapid double-trigger of the same scan doesn't produce two batches.

---

## How to work

- Actually look at what you build for 14.2/14.5/14.6/14.7 — all touch visible UI. Use the `run` skill and either `claude-in-chrome` or (if unavailable, as in every prior UI phase) real headless Chromium via Playwright, borrowed read-only from `foundry_worldFabric/node_modules`.
- Ground every fix in the actual current code — some line-number references above may have drifted slightly since the QA passes ran; re-locate before editing, don't blindly trust an exact line number.
- Commit after each completed task, clean incremental history. Stage files explicitly, never `git add -A`.
- Self-review remediation pass at the end: specifically re-verify 14.1's fix against the ORIGINAL single-mutation rollback tests (regression risk: an over-broad fix could break the common case while fixing the rare one) and 14.3's fix against a normal (no-fan-out, single-entity) resolve-pending call (regression risk: don't break the common case while fixing the neighbor-leak case).
- Check for and fix any new instance of the recurring `.gitignore` data-store gap if any task introduces a new store (unlikely for this phase, but check).

## Definition of done for Phase 14

- [ ] Rollback correctly reverts a batch to its true pre-accept state even when multiple mutations touch the same field, proven by a real regression test — not just reasoned about.
- [ ] A brand-new world can be created and used end-to-end through the UI, from genuinely nothing on disk.
- [ ] A resolve-pending call's fan-out neighbors never lose ledger entries without a corresponding accepted mutation.
- [ ] Developing and accepting a node's content clears its unreviewed flag.
- [ ] A node-edit popover near the bottom of the canvas is fully reachable, verified by real bounding-box measurement.
- [ ] The Long-Unreviewed list shows real entity names.
- [ ] "Narrate This" is reachable from the standalone entity page, with a clear (non-silent) message when nothing is narratable.
- [ ] A rapid double-trigger of the same scan doesn't produce a duplicate batch.
- [ ] Full test suite (root + wf-mcp-server + review-ui) still passes.
- [ ] Self-review remediation pass run and reported.
