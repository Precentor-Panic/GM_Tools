# Agent 2 handoff — W2 writeup-import robustness (COMPLETE)

All five tasks (W2a–W2e) implemented, tested, and committed on
`friction-wave-1`, one commit per task plus one verification commit:

| Task | Commit | Summary |
|------|--------|---------|
| W2a | `93203ee` | Near-miss name normalization BEFORE the importGraph dry-run. `normalizeProposalNameNearMisses` + `normalizeProposalAgainstSnapshot` (writeup-import.mjs), built on Agent 1's shared `name-similarity.mjs` `nameNearMatchScore` — never a forked matcher. Auto-rewrite threshold `WRITEUP_NAME_REWRITE_THRESHOLD = 0.85` (consciously above W1a's 0.75 advisory bar); same-type only; unique-best only; skips when the canon name is already its own proposal row; edge name-refs re-pointed alongside. Wired into BOTH `importWriteup` and `regenerateWriteupImport`. Every rewrite recorded as `entityContext.writeupNormalization` → surfaced on batch-detail rows via `grain.mjs` (scanResultKind's convention) → rendered as a "matched to canon" note on the card. All four real Kilmarn dup families pass as fixtures (real canon ids + the real extracted strings from batch_mssa9fid/batch_mssaf1h2). |
| W2b | `9072e40` | Exact name + different extracted type never silently duplicates. `normalizeProposalTypeConflicts` resolves onto the existing entity, keeping ITS type ("Kilmarn Bridge" place→object, "The Interest" faction→person — both real cases as fixtures); runs FIRST in the combined wrapper. Marked `writeupNormalization {kind:'type-conflict-resolved', extractedType, keptType, entityId}`; card renders a "same name, different type" suggestion; `deriveTriageTag` (Agent 1's W1e, extended in place — no second triage path) floors such rows at `needs-review`, never `low-risk`. Conservative skips: same-type exact match, 2+ differently-typed same-name entities, canon key already a proposal row. |
| W2c | `7e7a510` | Truncation fail-fast. Default budget 8192→16384, env-overridable via `WF_WRITEUP_IMPORT_MAX_TOKENS` (`resolveWriteupImportMaxTokens`, read at call time; explicit `opts.maxTokens` still wins; documented in wf-mcp-server/README.md). A truncated response on ANY attempt throws typed `WriteupTruncatedError` immediately — exactly ONE api call for a first-attempt truncation (test asserts calls.length===1 with a would-succeed second response queued) — carrying `approxEntityCount` (a `"name":` count over the partial output) and guidance: split the writeup (pointing at W2d's carry-over) or raise the env var. review-ui maps it to 422. **Stretch (auto-split→one batch) deliberately NOT built** — fail-fast + W2d covers the resubmit flow without silent cost multiplication; noted as future work. |
| W2d | `4652f82` | Framing carry-over. `wf_propose_from_writeup` (and `POST /api/writeup-propose`) accept optional `framing: {framings, selection, rubberDuck}` — deliberately the EXACT data `wf_select_framing`'s writeupText path takes, echoed forward by the caller (stateless carry-forward preserved; the server holds nothing). `proposeFromWriteupOp` validates it (`parseFramingCarryOver`, zod, throws BEFORE any API spend) and dispatches to the EXISTING `selectFramingForNewBatch` — framingHistory audit entry recorded exactly as a phase-B pick, no second record-keeping path. The live rubber-duck setting is NOT re-read on this path: the carried snapshot from the original phase-A stays authoritative (tested with the live toggle flipped both ways). |
| W2e | `2f67d5d` | Stub naming. `headless-apply.mjs` pre-scans merged edges for dangling internal-id endpoint refs (`INTERNAL_ID_LIKE_RE`); mints the stub itself — name `Unresolved: <ref>` (`unresolvedStubName`), tag `unresolved-reference` (`UNRESOLVED_REFERENCE_TAG`) — with **id equal to the dangling ref**, so the edge wires with no rewrite AND a later sync of the original create heals the placeholder in place by id-merge (proven by test). Name-like refs keep importGraph's existing legible stub-by-name behavior. Reported as `unresolvedStubs` from `applyHeadless` → threaded through `syncOp`'s headless result → warned in chronicle-view's Apply status line. `previewWriteupImport` upholds the same rule defensively (id-like stub names renamed/tagged, `entityContext.unresolvedStub: true`). |
| e2e | `8ed55fc` | Real headless-Chromium verification of the W2a/W2b card notes (`review-ui/test/e2e/w2-normalization-notes.e2e.mjs`), driven through the REAL importWriteup pipeline (mocked LLM only). |

## Test status

- **root `npm test`**: 91/92 pass — the ONE failure is the pre-existing,
  documented `test/combat-planning/snowball-delta.test.mjs` (confirmed
  failing at my baseline before any W2 change; untouched, W6c should triage).
  New: `test/writeup-normalization.test.mjs` (20 cases — all four real
  Kilmarn W2a dup families + the two real W2b cases + conservatism
  negatives + end-to-end importWriteup update-not-duplicate proofs);
  `test/writeup-import.test.mjs` reworked truncation tests (fail-fast
  contract) + env-var tests + the W2e preview-path guard;
  `test/headless-apply.test.mjs` +4 W2e cases (incl. heal-by-id).
- **wf-mcp-server**: 40/40 files pass. New: `framing-carryover.test.mjs`
  (3 tests); `triage-tags.test.mjs` +1 (W2b floor); `sync-headless.test.mjs`
  +1 (real MCP-subprocess sync surfacing `unresolvedStubs`).
- **review-ui deterministic**: 285/285 pass (was 282 at Agent 1's handoff;
  +`w2b-normalization-routes.test.mjs`, +`w2d-framing-carryover-routes.test.mjs`).
- **e2e (real headless Chromium, run in isolation per the standing
  flake note)**: new `w2-normalization-notes.e2e.mjs` passes; re-ran
  `w1-review-cluster.e2e.mjs` (6/6 — proves the proposal-card additions
  don't disturb Agent 1's card pipeline). Did NOT run the full ~70-file
  e2e suite (parallel-load flakes; affected-surface files run in isolation
  instead, same as Agent 1).
- **Real-API smoke NOT run (no paid calls, per instructions).** All new
  behavior is deterministic and covered by injected-client seams. The owner
  may want to re-run `wf-mcp-server/test/writeup-import-roundtrip.smoke.mjs`
  — it exercises the real extraction → (now W2a/W2b-normalized) dry-run →
  batch round trip, the one path where a real model's output shapes now flow
  through the new normalization. `rubber-duck-writeup.smoke.mjs` is
  unaffected on its standard path (W2d only adds a bypass).

## Skipped / deferred

- **W2c stretch (auto-split by paragraph groups into one merged batch)** —
  deliberately not built; see the W2c commit message. Fail-fast + W2d's
  carry-over covers the real workflow (that's exactly how the Kilmarn
  session recovered, manually) at far lower complexity.
- **W2e live-Foundry path** — when a live client applies the bridge file,
  GraphService's own resolveEndpoint governs stub naming; the fix covers the
  headless path (where the real kilmarn occurrence happened). Same class of
  known live-path limitation Phase 4 documented for id write-back.
- The sync-stub warning renders in chronicle-view's Apply banner only (the
  review surface where writeup batches are applied); the standalone Graph
  view's manual-edit sync bar wasn't touched — manual edits validate
  endpoints exist, so they can't produce dangling refs.

## Warnings for Agent 3 (session-planner + Plutonium) and later agents

1. **`review-ui/server.mjs` (shared with everyone)**: my changes are small
   and grouped — one new `statusForError` branch (`WriteupTruncatedError` →
   422, next to the other typed-error branches ~line 392) and a `framing`
   passthrough on the existing `POST /api/writeup-propose` route. I did NOT
   touch `batchDetailPayload`; Agent 1's rule stands (extend it, never add a
   second batch-annotation path — my normalization data flows through
   `grain.mjs`'s rows, which batchDetailPayload already spreads).
2. **`grain.mjs` `summarizeBatch` rows** gained a nullable
   `writeupNormalization` field (same convention as `scanResultKind`).
   Anything that iterates region entities sees it; it's `null` for every
   non-writeup-import producer.
3. **`proposal-card.js`** gained a normalization row
   (`data-testid="proposal-card-normalization"`, kinds
   `near-miss-rename` / `type-conflict-resolved`) rendered between the merge
   editor and the near-match chips. Read defensively from
   `m.writeupNormalization ?? m.entityContext?.writeupNormalization`.
4. **`applyHeadless` result shape** gained `unresolvedStubs` (always an
   array, usually empty). `syncOp`'s headless result includes it only when
   non-empty. If you build a new caller that surfaces apply results to a
   human, surface this field.
5. **`proposeWfiFromWriteup` now throws `WriteupTruncatedError`** instead of
   retrying on truncation — any NEW caller of writeup-import should catch it
   (or let the 422 mapping handle it). `proposeFromWriteupOp` gained the
   optional `framing` arg; the MCP tool schema moved
   `framingItemSchema`/`framingSelectionSchema` ABOVE `wf_propose_from_writeup`
   in `index.mjs`.
6. **`deriveTriageTag` now reads `m.entityContext.writeupNormalization`**
   (type-conflict floor). If you produce mutations with an `entityContext`,
   don't reuse that key for anything else.
7. Standing items inherited from Agent 1 still apply: chronicle-view TDZ
   hazard (declare consts at the top of `renderChronicleSurface`),
   `rejectMutationIds` cascades on `(created)` diffs, e2e files flake under
   parallel load — re-run in isolation before calling a regression. The
   pre-existing root-suite failure `snowball-delta.test.mjs` is still there
   for whoever runs W6c.
