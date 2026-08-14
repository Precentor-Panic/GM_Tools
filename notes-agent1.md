# Agent 1 handoff — W1 review-card duplication & agency cluster (COMPLETE)

All eight tasks (W1a–W1h) implemented, tested, and committed on
`friction-wave-1`, one commit per task:

| Task | Commit | Summary |
|------|--------|---------|
| W1a | `1d0bc88` | Near-match chips on pending CREATE cards. NEW shared module `graph-import/name-similarity.mjs` (scan-mentions' Phase-13.4 matcher moved verbatim + possessive-'s tokenization + a token-containment tier `nameNearMatchScore` + `findNearMatches`, which also flags exact-name/different-type). `scan-mentions.mjs` re-exports everything it used to define — existing importers unchanged. Server: `nearMatchesForBatch` (mutation-ops) → `nearMatches` on batch-detail rows (pending creates only). |
| W1b | `f648494` | `convertCreateToUpdateOfExistingOp` (mutation-ops): converts a pending create IN PLACE (same mutationId) into an update of a chosen existing entity — drops `name`/`type` from data (never rename/retype canon), keeps the new text, re-points every still-PENDING edge referencing the would-be id, re-diffs the touched mutations. Route: `POST /api/batches/:id/mutations/:mid/convert-to-existing`. Card chips gain the convert button + a search fallback over `/api/graph`. |
| W1c | `c19e846` | "Yes, but" merge editor. `patchPendingMutationDataOp` = existing patch primitive + re-diff against the live snapshot; the `patch-data` route upgraded to it. Card: "✎ Edit staged text" (pending `upsert_entity` only, host-wired), "Insert old text" helper, accept applies the edited version. |
| W1d | `0ea3214` | Reject-cascade at the ONE shared choke point `rejectMutationIds` (MCP `wf_reject` inherits it — deliberate, flagged in the commit): rejecting a create auto-rejects still-pending edges referencing it, stamped `entityContext.cascadeRejectedWith`, returned as `cascadeRejected`. Undo via new `revertMutationsToPending` + `POST .../revert-to-pending` (rejected→pending only). UI: inline greyed-N notice + Undo; accepting a create offers one-click "Accept all N connections" (drives existing bulk-accept, `reviewedMutationIds: []`). |
| W1e | `99de276` | Deterministic triage tags (`deriveTriageTag`/`triageForBatch` in mutation-ops, computed at READ time, nothing persisted): `possible-duplicate` (create w/ W1a match), `fights-canon` (diff REPLACES nonempty text — append is not a fight), `low-risk` (pure adds), `needs-review` (rest). Effective `risk` = severity-merge of stamped attachDiffs risk with the tag's mapped risk (upgrade-only) — this is what makes the Triaged buckets meaningful for pre-Phase-37/risk-less batches (all the Kilmarn ones). |
| W1f | `6060967` | Triaged-toggle bug reproduced in headless Chromium FIRST (regression e2e run against pre-fix code, failed with the exact reported symptom), then fixed: proposal-card's `decide()` never wrote the decision back onto the shared mutation object, so any view-filter re-render restored stale statuses. Server state was always right; the view lied. |
| W1g | `cd81ead` | Edge legibility: `edgeDisplayForBatch` resolves endpoint names (batch creates → live snapshot → raw id); cards render "Source —label→ Target", never m-ids. List mode nests edges indented under EVERY node card they touch (an edge touching two nodes renders under both, twin instances share state via a card registry + the shared mutation object). Triage mode stays flat. |
| W1h | `555532f` | Persistent "N accepted mutations not yet applied — Apply to world" banner over the What-changed panel, wired to the EXISTING `/api/batches/:id/sync` route (repo-standard 1.5s slow-notice; reappears on accept-after-sync). Plus the cluster e2e (below). |

## Test status

- **review-ui deterministic**: 282/282 pass (`npm test`). New files:
  `w1a-near-match-routes`, `w1b-convert-routes` (includes a real
  convert→accept→sync end-to-end with on-disk snapshot assertions),
  `w1c-merge-editor-routes`, `w1d-cascade-routes`, `w1e-triage-routes`,
  `w1g-edge-display-routes`.
- **wf-mcp-server**: all suites pass (`npm test`, 36 files). New:
  `convert-create-to-update.test.mjs`, `reject-cascade.test.mjs`,
  `triage-tags.test.mjs`.
- **root**: all pass EXCEPT the **pre-existing** failure
  `test/combat-planning/snowball-delta.test.mjs` ("the two deltas are
  genuinely DIFFERENT numbers" fixture-coincidence assertion) — confirmed
  failing at my baseline run BEFORE any W1 change; not touched (combat-
  planning is outside my cluster). New: `test/name-similarity.test.mjs`
  (real Kilmarn dup cases + conservatism negatives; guards the
  scan-mentions extraction being behavior-identical).
- **e2e (real headless Chromium)**: new `w1-review-cluster.e2e.mjs`
  (6 tests — chips, convert w/ live re-pointing, cascade+undo, twin shared
  state, accept-connections, banner + a REAL apply with snapshot
  assertions) and `w1f-triage-toggle-selection.e2e.mjs` (regression,
  verified failing pre-fix). Also re-ran everything that touches
  proposal-card/chronicle: `phase37-review-green-guard`,
  `phase37-chronicle-surface`, `phase30-planner-scene`,
  `qa-w3-chronicle-rail`, `qa-w3-chronicle-receive` — all green.
  (Did NOT run the entire ~70-file e2e suite; per the standing feedback
  note, that suite flakes under parallel load — the affected-surface files
  above were run in isolation instead.)

## Skipped / deferred

Nothing from W1a–W1h. Deliberate scope choices worth knowing:
- Triage stays deterministic v1 (whole-batch LLM triage explicitly
  deferred by the wave plan).
- W1h can't know per-mutation sync state (the store only tracks batch
  status); accept-after-sync re-applies ALL accepted mutations (idempotent
  upserts) — documented in the banner code.
- The convert search fallback fetches `/api/graph?filter=all` once per
  card open (cached per card) — fine at current scale.

## Warnings for the next agents

1. **Agent 2 (graph-import)**: `graph-import/name-similarity.mjs` is your
   W2a import point — `findNearMatches` / `nameNearMatchScore` (containment
   tier, catches "Master Vane"⊂"Master Aldric Vane") vs the original
   conservative `nameSimilarity` (unchanged behavior; scan-mentions'
   auto-rewrite still uses only that). `scan-mentions.mjs` re-exports the
   old names, so import from either — but prefer the new module. If you
   auto-rewrite (not just advise) with the containment tier, pick your
   threshold consciously; W1a uses 0.75 for ADVISORY chips.
2. **Shared `review-ui/server.mjs`**: my route additions are grouped —
   `revert-to-pending` sits with the batch decision routes (~line 1170),
   `convert-to-existing` next to `redirect-to-existing` (~line 1725), and
   `batchDetailPayload` now takes `(dir, w, batchId)` and enriches rows
   with `nearMatches`/`triage`/`risk`(effective)/`edgeDisplay`. Don't add a
   second batch-annotation path — extend `batchDetailPayload`.
3. **`chronicle-view.js` TDZ hazard (bit me twice)**: the batch deep-link
   route block midway through `renderChronicleSurface` runs
   `paintProposals()` BEFORE later statements of the function body execute.
   Any `const`/`let` used by the proposals pipeline MUST be declared at the
   top of the function (see the `cardRegistry` comment). Function
   declarations are safe (hoisted).
4. **`rejectMutationIds` now cascades** (W1d) for any mutation whose diff
   carries the `(created)` marker — if you build a producer whose creates
   should NOT cascade on reject, flag it; currently there is no opt-out
   (deliberately — orphan edges were never a valid outcome).
5. **proposal-card opts contract** grew: `onDecided(decided, m, result)`
   (3rd arg new), `registerCard(mid, {el, setDecided})`,
   `onConvertToExisting(m, entityId)`, `onPatchData(m, data)` — all
   optional; read-only mounts (Wrap rail, lore intake) are unchanged.
6. Pre-existing root-suite failure `snowball-delta.test.mjs` predates this
   wave — whoever owns W6c's final sweep should triage it rather than
   assume a wave regression.
