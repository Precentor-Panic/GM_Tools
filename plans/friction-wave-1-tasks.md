# Friction Wave 1 — Kilmarn live-exercise remediation

Triage of `/opt/dev/campaigns/one-shot/notes/friction.md` (the first real
end-to-end exercise of the MCP + app surface, 2026-08-13/14). Ordered by
leverage: the duplication/review cluster caused the most real review pain,
then the scene↔map and Plutonium gaps Russell explicitly asked for, then
import robustness, then World-tab structure, then misc.

**Ground rules for this wave (from Russell, 2026-08-14):**
- Work on the `friction-wave-1` branch in THIS worktree
  (`/opt/dev/GM_Tools-wave`). Never touch `/opt/dev/GM_Tools` (the main
  worktree serves Russell's running app).
- Rough new UI is allowed — mimic the existing UI's style; Russell may
  redo surfaces in Claude Designer later.
- review-ui runtime stays dependency-free (Playwright is dev/test-only).
- Every task: deterministic tests where possible, real verification
  (headless Chromium for UI claims, per repo culture in CLAUDE.md/PLAN.md),
  commit per task with a message naming the friction item it fixes.
- Tests need modern node: `PATH=/home/russell/.local/node/bin:$PATH`.
- Worktree has no node_modules — `npm install` (root + review-ui) first.

## W1 — Review-card duplication & agency cluster (review-ui + mutation-ops) — Agent 1
- **W1a Near-match chips.** Every proposed CREATE card shows near matches
  from the live graph (port scan-mentions.mjs's stopword-stripped
  `nameSimilarity` + substring/possessive/leading-article checks; also flag
  EXACT name matches with different type). Deterministic, no LLM.
- **W1b Convert create → update-to-existing.** On a writeup-import create
  card: pick a near match (or search), convert the pending create into an
  update targeting that existing entity, and re-point every pending edge in
  the batch that references the would-be-new id. Model on Phase 13.3's
  `redirectMentionScanRowToExistingOp`, generalized to writeup-import
  batches.
- **W1c "Yes, but" merge editor.** Update/create cards get an editable
  staged-text area (description/summary): reviewer hand-combines old+new,
  accept applies the edited version. Pairs with W1b for the
  "combine the two texts" flow.
- **W1d Edge cascade.** Rejecting a create auto-rejects (greys, with undo)
  every pending edge referencing it. Accepting a node offers/performs
  accept of its edges ("auto-accept connections" affordance).
- **W1e Triage tags.** Deterministic per-mutation tags on cards:
  `possible duplicate` (from W1a), `fights canon` (update that would
  REPLACE nonempty existing text — diff-shrink heuristic), `low risk`
  (pure adds/new leaf entities), `needs review` (everything else).
- **W1f 'Triaged' toggle bug.** Reproduce + fix: the toggle appears broken
  and clears accept/reject selections already made. A view filter must
  never mutate selection state.
- **W1g Edge legibility.** Edge cards render "Source —label→ Target" with
  entity NAMES (never raw m-ids); edges ALSO render indented under the
  node cards they touch (shared accept state when shown twice).
- **W1h Accept→apply CTA.** After accepting, a persistent banner:
  "N accepted mutations not yet applied — Apply to world" wired to the
  EXISTING sync route. Kills the "accept did nothing" dead end.

## W2 — Writeup-import robustness (graph-import) — Agent 2
- **W2a Near-miss normalization in writeup path.** Run the W1a similarity
  pass over extracted entity names vs the live graph BEFORE the importGraph
  dry-run; rewrite near-misses ("Master Vane", "The Lowway"/"Lowway",
  "Vane's Seal Ring", "Founding Charter of Kilmarn") to exact canon names
  so they dedup as updates. Conservative: same type required except the
  W2b case.
- **W2b Same-name/different-type.** Exact name match with a different type
  guess must never silently create a duplicate — surface as a suggestion
  on the card (merge candidate), defaulting to the existing entity's type.
- **W2c Truncation handling.** The max_tokens=16384 hard-fail cost two full
  API calls + the framing round. Raise/make configurable; detect truncation
  on the FIRST attempt and fail fast with actionable guidance (approx
  entity count detected, "split the writeup"); stretch: auto-split by
  paragraphs into sub-extractions merged into ONE batch.
- **W2d Framing carry-over.** `wf_propose_from_writeup` accepts an optional
  pre-selected framing/steering note that skips the rubber-duck phase-A
  round — so a resubmit/split of already-framed material doesn't re-ask.
- **W2e Stub naming.** Stubs created from unresolved edge endpoints must
  not be named by raw mutation id ("wf_mssa9fia_0") — name them
  "Unresolved: <original name>" + flag for review.

## W3 — Scene↔map association (session-planner) — Agent 3
- **W3a `stagecraftAsset.src`.** Real file-path field on stagecraft assets
  (hand-add + edit + UI display).
- **W3b `scene.mapAssetId`.** Scenes link a stagecraft map asset; scene
  page gets a picker; scene cards/page show a map chip so "does this scene
  have a map?" is visible at a glance.
- **W3c push-scene defaults.** `/api/foundry/push-scene` defaults `mapSrc`
  from the linked asset's src (explicit mapSrc still overrides).

## W4 — Plutonium source layer (Library) — Agent 3
- **W4a Indexer.** Server-side module reading
  `<dataDir>/modules/plutonium/data/bestiary/*.json` (bundled 5etools
  data; ~4,126 creatures/127 sources locally), building a cached compact
  index: name, source, page, CR, type+tags, size, AC, HP, environment,
  legendary. Graceful "Plutonium not installed" state.
- **W4b Library UI.** "Available via Plutonium" read-only shelf in the
  Library/Encounter Builder: search + filter by CR range/type/source.
  Distinct visual source pill; NEVER auto-added to the curated shelf.
- **W4c Add-to-shelf.** Per-creature action creates an accepted bestiary
  entry (real stats + "SOURCE pPAGE via Plutonium" note). Import into
  Foundry remains a human act at prep time (document in UI copy).

## W5 — World tab structure (world-view) — Agent 4
- **W5a Containment hygiene.** Import-time direction normalization for
  containment edges (child=source→parent=target convention; catch
  "X contains Y" phrasings), cycle detection in the tree builder — cycle
  members render at root with a warning badge instead of silently
  vanishing (the bug that ate Kilmarn + the Underbreach).
- **W5b Rail redesign (rough UI OK).** Mimic the Library context-rail
  style: move "search the world" + icon filters to a new bar; rail
  selector Spatial | Loyalty | Graph; Graph mode revives the full graph
  view (reuse the standalone graph-view code). Left menu in
  Spatial/Loyalty: "Where things are", "+ add", "collapse/expand all".
  Fixes the clipped "Spatial/Loya" toggle by superseding it.
- **W5c World-name guard.** Warn (don't block) when an entity name equals
  the world id/name.
- **W5d (stretch) Local graph panel.** Entity click → panel: title,
  description, develop hook, contents, action buttons, one-hop local graph
  with color-coded relationship types, loose threads.

## W6 — Misc glue — Agent 5
- **W6a World attach/create picker.** Settings world card lists actual
  `Data/worlds/*` dirs (with/without snapshot) to attach or bootstrap;
  unify with the topbar world-select's source of truth.
- **W6b SKILL.md truth.** `.claude/skills/gm-tools-agent/SKILL.md` names
  MCP tools that don't exist (wf_create_scene, wf_tray_drop, wf_add_*,
  etc.). Rewrite to the real surface: actual wf_* MCP tools + the
  review-ui HTTP API for planner/library work (with the world-explicit
  rule intact).
- **W6c Final sweep.** Full test suites green (root, wf-mcp-server,
  review-ui deterministic + e2e); update PLAN.md with a Friction Wave 1
  row; leave a MORNING-REVIEW.md at the worktree root summarizing what
  landed, what's stubbed, and what needs Russell's Designer pass.

## Deferred (logged, not this wave)
- Whole-batch LLM triage (tags stay deterministic v1).
- Native campaign-repo support; anything touching foundry_worldFabric
  module internals beyond what W3c needs.
